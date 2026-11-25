import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProviderInfo,
  Settings,
  type SettingsInput,
  StartSessionRequest,
  type StartSessionRequestInit,
} from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { removeTree } from "./support/remove-tree";

const caps: ProviderInfo["capabilities"] = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: false,
  rollback: false,
  fork: false,
  images: false,
  planMode: true,
  reasoningEffort: true,
  mcp: true,
  skills: false,
  enforcesSecurityRules: true,
  readOnly: true,
};

const info = (id: string, reasoningEffort = true): ProviderInfo => ({
  id,
  displayName: id,
  models: [],
  capabilities: { ...caps, reasoningEffort, chrome: id === "claude" },
});

type Start = (over: Partial<StartSessionRequestInit>) => Promise<string>;

/** A SessionService over a real database, with a scripted runner and the given settings. */
function withService(
  settings: SettingsInput,
  run: (start: Start, repo: SessionRepo, service: SessionService) => Promise<void>,
  connected = true,
) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-role-defaults-"));
    const database = openDatabase(join(dir, "codeden.db"));
    try {
      const repo = new SessionRepo(database.db, new EventStore(database.db));
      const parsed = Settings.parse(settings);
      const sessions = new SessionService({
        repo,
        projects: {
          get: () => ({
            id: "p1",
            path: dir,
            defaultProvider: null,
            archivedAt: null,
            autonomy: null,
          }),
        },
        runner: {
          // `plain` has no reasoning effort.
          providers: () => (connected ? [info("claude"), info("codex"), info("plain", false)] : []),
          isConnected: () => connected,
        },
        settings: { get: () => parsed },
        launcher: { launch: vi.fn(async () => {}) },
      } as unknown as SessionServiceDeps);
      const start: Start = async (over) => {
        const res = await sessions.start(
          StartSessionRequest.parse({ projectId: "p1", purpose: `Work ${Math.random()}`, ...over }),
        );
        if (res.status !== "started") throw new Error(res.status);
        return res.sessionId;
      };
      await run(start, repo, sessions);
    } finally {
      database.close();
      await removeTree(dir);
    }
  };
}

describe("PM Browser Operator launch consent", () => {
  const teamSettings = (provider: string): SettingsInput => ({
    teamSetup: { remembered: true, team: [{ role: "browserOperator", provider }] },
  });
  const request = StartSessionRequest.parse({
    projectId: "p1",
    title: "[Browser Operator] Open the documentation",
    purpose: "Open the documentation",
    startedBy: { kind: "pm" },
  });

  it.each([true, false])("only dispatches the Claude launch after consent returns %s", (approved) =>
    withService(teamSettings("claude"), async (_start, repo, service) => {
      const confirmChrome = vi.fn(async () => approved);
      const result = await service.start(request, { confirmChrome });
      expect(confirmChrome).toHaveBeenCalledOnce();
      if (!approved) {
        expect(result.status).toBe("skipped");
        expect(repo.list({ projectId: "p1" })).toHaveLength(0);
      } else {
        if (result.status !== "started") throw new Error(result.status);
        expect(repo.find(result.sessionId)?.startMeta?.chromeOptIn).toBe(true);
      }
    })(),
  );

  it.each([true, false])("requires consent when the runner connection is %s", (connected) =>
    withService(
      teamSettings("claude"),
      async (_start, repo, service) => {
        expect(await service.start(request)).toEqual({
          status: "skipped",
          reason: "Chrome requires owner approval.",
        });
        expect(repo.list({ projectId: "p1" })).toHaveLength(0);
      },
      connected,
    )(),
  );

  it(
    "does not prompt when the resolved provider is not Claude",
    withService(teamSettings("codex"), async (_start, repo, service) => {
      const confirmChrome = vi.fn(async () => true);
      const result = await service.start(request, { confirmChrome });
      expect(confirmChrome).not.toHaveBeenCalled();
      if (result.status !== "started") throw new Error(result.status);
      expect(repo.find(result.sessionId)?.startMeta?.chromeOptIn).toBeUndefined();
    }),
  );
});

describe("SessionService.start: the role's default model and effort", () => {
  const claudeAgent: SettingsInput = {
    providers: { agent: { provider: "claude", model: "opus", effort: "high" } },
  };

  it(
    "gives a session on another provider that provider's default, not the role's model",
    withService(claudeAgent, async (start, repo) => {
      // A cross-provider reviewer or a fallback builder: the factory picks model null, which it
      // sends as no model at all (`...(model ? { model } : {})`).
      const id = await start({ provider: "codex" });
      expect(repo.get(id)).toMatchObject({ provider: "codex", model: null, effort: null });
    }),
  );

  it(
    "fills the role's model and effort for a session on the role's provider",
    withService(claudeAgent, async (start, repo) => {
      const named = await start({ provider: "claude" });
      expect(repo.get(named)).toMatchObject({ provider: "claude", model: "opus", effort: "high" });
      // Provider resolved from the role's default.
      const resolved = await start({});
      expect(repo.get(resolved)).toMatchObject({
        provider: "claude",
        model: "opus",
        effort: "high",
      });
      // Only the model given: the role's effort still applies on its own provider.
      const sonnet = await start({ provider: "claude", model: "sonnet" });
      expect(repo.get(sonnet)).toMatchObject({ model: "sonnet", effort: "high" });
    }),
  );

  it(
    "keeps an explicit model and effort on another provider",
    withService(claudeAgent, async (start, repo) => {
      const both = await start({ provider: "codex", model: "gpt-5.5", effort: "low" });
      expect(repo.get(both)).toMatchObject({ provider: "codex", model: "gpt-5.5", effort: "low" });
      // A model alone takes no effort from another provider's role default.
      const model = await start({ provider: "codex", model: "gpt-5.5" });
      expect(repo.get(model)).toMatchObject({ model: "gpt-5.5", effort: null });
    }),
  );

  it(
    "leaves the role's effort out on a provider without reasoning effort",
    withService(
      { providers: { agent: { provider: "plain", model: "plain-1", effort: "high" } } },
      async (start, repo) => {
        const id = await start({});
        expect(repo.get(id)).toMatchObject({ provider: "plain", model: "plain-1", effort: null });
      },
    ),
  );

  it(
    "applies the defaults of the session's role, not the agent's",
    withService(
      {
        providers: {
          agent: { provider: "claude", model: "opus", effort: "high" },
          pm: { provider: "codex", model: "gpt-5.5", effort: "medium" },
        },
      },
      async (start, repo) => {
        const pm = await start({ role: "pm" });
        expect(repo.get(pm)).toMatchObject({
          provider: "codex",
          model: "gpt-5.5",
          effort: "medium",
        });
        await expect(start({ role: "pm", provider: "claude" })).rejects.toMatchObject({
          code: "role_model_provider_mismatch",
        });
      },
    ),
  );
});
