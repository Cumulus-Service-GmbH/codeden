import { type ErrorInfo, PROVIDER_SWITCH_CODE, type Session } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchInboxId } from "../src/services/orchestration/role-limit-switch";
import type { SessionRepo } from "../src/services/sessions/repo";
import { type RoleEnv, withRoles } from "./support/role-env";
import { TEST_START } from "./support/test-clock";

const HOUR = 60 * 60_000;
/** When the limit in these tests resets: two hours after the pinned start. */
const RESET_AT = new Date(TEST_START.getTime() + 2 * HOUR).toISOString();

const text = (value: string) => ({
  input: { text: value, attachments: [] },
  whenBusy: "queue" as const,
});

const limit = (retryAt?: string): ErrorInfo => ({
  message: "You've hit your usage limit.",
  kind: "usage_limit",
  ...(retryAt && { retryAt }),
});

/** The `provider_switch` notices in a session's chat: reason and message. */
function switchNotices(repo: SessionRepo, session: Session) {
  return repo.rootItems(repo.get(session.id), ["notice"]).flatMap((item) => {
    if (item.kind !== "notice" || item.code !== PROVIDER_SWITCH_CODE) return [];
    return [{ reason: (item.data as { reason: string }).reason, message: item.message }];
  });
}

/** A PM on claude that was sent "Ship the fix" and then hit its usage limit. */
async function pmAtLimit(env: RoleEnv, retryAt?: string): Promise<Session> {
  const pm = await env.roles.ensure("pm", "p1");
  env.settle(pm.id);
  await env.sessions.send(pm.id, text("Ship the fix"), "user");
  env.failTurn(pm.id, "t1", limit(retryAt));
  await env.limits.idle();
  return pm;
}

const BOTH = [
  { id: "claude", readOnly: true },
  { id: "codex", readOnly: true },
];

beforeEach(() => {
  // The clock is pinned; only `Date` is faked, so the queue and the runner's promises run.
  vi.useFakeTimers({ toFake: ["Date"], now: TEST_START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("role sessions: switching provider at a usage limit (§8.1)", () => {
  it(
    "switches to the effective Architect's provider and pinned model and records the move",
    withRoles(async (env) => {
      const old = await env.roles.ensure("pm", "p1");
      env.settle(old.id);
      env.setProjectTeam([{ role: "architect", provider: "codex", model: "gpt-5", effort: null }]);
      await env.sessions.send(old.id, text("Ship the fix"), "user");
      env.failTurn(old.id, "t1", limit(RESET_AT));
      await env.limits.idle();

      const [pm] = env.livePms();
      expect(pm).toMatchObject({ provider: "codex", model: "gpt-5", autonomy: old.autonomy });
      expect(env.repo.get(old.id).archivedAt).toBeTruthy();
      expect(env.queue(pm?.id as string)).toEqual([{ from: "user", text: "Ship the fix" }]);
      expect(switchNotices(env.repo, old)[0]?.reason).toBe("usage_limit");
      expect(env.inbox.find(switchInboxId("pm", "p1"))).toMatchObject({ sessionId: pm?.id });
    }),
  );

  it.each(["unlisted", "unverified login", "no model", "no read-only"])(
    "keeps the failed session if the alternative has %s",
    (reason) =>
      withRoles(async (env) => {
        const old = await env.roles.ensure("pm", "p1");
        env.settle(old.id);
        if (reason !== "unlisted") {
          env.setProjectTeam([
            {
              role: "architect",
              provider: "codex",
              model: reason === "no model" ? null : "gpt-5",
              effort: null,
            },
          ]);
        }
        if (reason === "unverified login") env.ready(["claude"]);
        if (reason === "no read-only") env.providers([{ id: "codex", readOnly: false }]);
        env.failTurn(old.id, "t1", limit());
        await env.limits.idle();
        expect(env.livePms().map((pm) => pm.id)).toEqual([old.id]);
        expect(switchNotices(env.repo, old)[0]?.reason).toBe("no_fallback");
        expect(env.stopped).toEqual([]);
      })(),
  );

  it(
    "does nothing when the setting is off, or for a failure that isn't a usage limit",
    withRoles(async (env) => {
      env.providers(BOTH);
      env.setQuietly({ providers: { autoSwitchOnLimit: false } });
      const old = await pmAtLimit(env, RESET_AT);
      expect(env.livePms().map((s) => [s.id, s.status])).toEqual([[old.id, "failed"]]);
      expect(switchNotices(env.repo, old)).toEqual([]);

      env.setQuietly({});
      env.settle(old.id);
      env.failTurn(old.id, "t2", { message: "Overloaded", kind: "transient" });
      await env.limits.idle();
      expect(env.livePms().map((s) => s.id)).toEqual([old.id]);
      expect(env.stopped).toEqual([]);
    }),
  );
});
