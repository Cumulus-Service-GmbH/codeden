import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InboxItem,
  type ProviderInfo,
  type RunnerCommand,
  type Session,
  SessionDetail,
  StartSessionResponse,
} from "@codeden/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import type { RunnerPort } from "../src/services/runner-port";
import { startCompaction } from "../src/services/sessions/compact";
import { Outbox } from "../src/services/sessions/outbox";
import { readOnlyUnsupported } from "../src/services/sessions/permissions";
import { applyPendingConfig, updateSession } from "../src/services/sessions/reconfigure";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";
import { type Harness, startHarness, waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

/** A runner stand-in that records commands and fails with `failWith` when set. */
function stubRunner(
  handle: (command: RunnerCommand) => Promise<object> = async (command) =>
    command.name === "session.configure" ? { revision: command.revision } : {},
) {
  const commands: RunnerCommand[] = [];
  const state: { failWith?: string } = {};
  const port: RunnerPort = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: RunnerCommand) => {
      commands.push(command);
      if (state.failWith) throw Object.assign(new Error(state.failWith), { code: state.failWith });
      return handle(command);
    }) as RunnerPort["request"],
  };
  return { port, commands, state };
}

describe("updateSession with autonomy", () => {
  let dir: string;
  let database: Database;
  let store: EventStore;
  let repo: SessionRepo;
  const session: Session = { ...sampleSession, id: "s-auto", status: "running" };
  const pending = () =>
    (repo.find(session.id)?.startMeta as { pendingConfig?: Record<string, unknown> } | null)
      ?.pendingConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-autonomy-"));
    database = openDatabase(join(dir, "codeden.db"));
    store = new EventStore(database.db);
    repo = new SessionRepo(database.db, store);
    repo.create(session, {
      workspaceMode: "worktree",
      workspaceFallback: null,
      forced: null,
      queuedBehind: [],
    });
  });
  afterEach(async () => {
    database.close();
    await removeTree(dir);
  });

  it("saves the level with session.updated and asks the runner to apply it", async () => {
    const runner = stubRunner();
    const updated = await updateSession(repo, runner.port, session.id, { autonomy: "full" });
    expect(updated.autonomy).toBe("full");
    expect(repo.get(session.id).autonomy).toBe("full");
    expect(runner.commands).toEqual([
      { name: "session.configure", sessionId: session.id, autonomy: "full", revision: 1 },
    ]);
    expect(pending()).toBeUndefined();
    // Recorded in the event log, so projections rebuilt after a restart keep it.
    const last = store
      .listAfter(0)
      .filter((e) => e.type === "session.updated")
      .at(-1);
    const saved = last?.payload as { session: Session } | undefined;
    expect(saved?.session.autonomy).toBe("full");
  });

  it("keeps model/effort for the next turn while autonomy goes out at once", async () => {
    const runner = stubRunner();
    await updateSession(repo, runner.port, session.id, { autonomy: "supervised", effort: "high" });
    expect(runner.commands).toEqual([
      { name: "session.configure", sessionId: session.id, autonomy: "supervised", revision: 1 },
    ]);
    expect(pending()).toEqual({ effort: "high" });
    await applyPendingConfig(repo, runner.port, repo.get(session.id));
    expect(runner.commands.at(-1)).toEqual({
      name: "session.configure",
      sessionId: session.id,
      revision: 1,
      effort: "high",
    });
    expect(pending()).toBeUndefined();
  });

  it("retries before the next turn when the runner cannot take it now", async () => {
    const runner = stubRunner();
    runner.state.failWith = "runner_unavailable";
    const updated = await updateSession(repo, runner.port, session.id, { autonomy: "full" });
    expect(updated.autonomy).toBe("full");
    expect(pending()).toEqual({ autonomy: "full" });

    runner.state.failWith = undefined;
    await applyPendingConfig(repo, runner.port, repo.get(session.id));
    expect(runner.commands.at(-1)).toEqual({
      name: "session.configure",
      sessionId: session.id,
      revision: 1,
      autonomy: "full",
    });
    expect(pending()).toBeUndefined();
  });

  it("acknowledges a model-only revision for steering without applying the model mid-turn", async () => {
    const runner = stubRunner();
    await updateSession(repo, runner.port, session.id, { model: "next-model" });
    expect(runner.commands).toEqual([]);

    await expect(applyPendingConfig(repo, runner.port, repo.get(session.id), true)).resolves.toBe(
      1,
    );
    expect(runner.commands).toEqual([
      { name: "session.configure", sessionId: session.id, revision: 1 },
    ]);
    expect(pending()).toEqual({ model: "next-model" });
  });

  function service(runner: RunnerPort) {
    return new SessionService({
      repo,
      runner,
      outbox: new Outbox(database.db, store),
      artifacts: {
        externalizeAttachments: (input: unknown) => input,
        resolveAttachments: (input: unknown) => input,
      },
    } as unknown as SessionServiceDeps);
  }

  it("keeps Supervised enforced before input after an older Full configure fails", async () => {
    const older = Promise.withResolvers<void>();
    let applied: Session["autonomy"] = "auto";
    const runner = stubRunner(async (command) => {
      if (command.name === "session.configure") {
        if (command.autonomy === "full" && applied === "auto") await older.promise;
        applied = command.autonomy ?? applied;
        return { revision: "revision" in command ? command.revision : undefined };
      }
      if (command.name === "session.send") expect(applied).toBe("supervised");
      return {};
    });
    const full = updateSession(repo, runner.port, session.id, { autonomy: "full" });
    await updateSession(repo, runner.port, session.id, { autonomy: "supervised" });
    older.reject(new Error("late configure failure"));
    await full;
    repo.update(session.id, (s) => ({ ...s, status: "idle" }));

    await expect(
      service(runner.port).send(session.id, {
        input: { text: "next", attachments: [] },
        whenBusy: "reject",
      }),
    ).resolves.toEqual({ status: "sent" });
    expect(
      runner.commands.filter(
        (command) => command.name === "session.configure" && command.autonomy === "full",
      ),
    ).toHaveLength(1);
    expect(repo.get(session.id).autonomy).toBe("supervised");
  });

  it("holds input when the runner does not acknowledge the current autonomy revision", async () => {
    const runner = stubRunner(async () => ({}));
    await updateSession(repo, runner.port, session.id, { autonomy: "supervised" });
    repo.update(session.id, (s) => ({ ...s, status: "idle" }));

    await expect(
      service(runner.port).send(session.id, {
        input: { text: "hold", attachments: [] },
        whenBusy: "reject",
      }),
    ).rejects.toThrow(/autonomy/i);
    expect(runner.commands.some((command) => command.name === "session.send")).toBe(false);
    expect(repo.get(session.id).autonomy).toBe("supervised");
  });

  it("holds compaction when the current autonomy downgrade is refused", async () => {
    const runner = stubRunner();
    await updateSession(repo, runner.port, session.id, { autonomy: "full" });
    runner.state.failWith = "unsupported";
    await updateSession(repo, runner.port, session.id, { autonomy: "supervised" });
    const idle = repo.update(session.id, (s) => ({ ...s, status: "idle" }));

    await expect(
      startCompaction(
        {
          repo,
          resume: async () => {
            throw new Error("Must not resume after a refused configure");
          },
          runnerOf: () => runner.port,
        },
        idle,
      ),
    ).rejects.toMatchObject({
      code: "config_unconfirmed",
      message: expect.stringMatching(/stop and resume/i),
    });
    expect(runner.commands.some((command) => command.name === "session.compact")).toBe(false);
    expect(repo.get(session.id)).toMatchObject({ autonomy: "supervised", status: "idle" });
  });

  it("drops the retry once a later change reaches the runner", async () => {
    const runner = stubRunner();
    runner.state.failWith = "timeout";
    await updateSession(repo, runner.port, session.id, { autonomy: "full", model: "m" });
    expect(pending()).toEqual({ model: "m", autonomy: "full" });
    runner.state.failWith = undefined;
    await updateSession(repo, runner.port, session.id, { autonomy: "auto" });
    expect(pending()).toEqual({ model: "m" });
  });
});

describe("PATCH /api/sessions/:id with autonomy, through a real runner", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const openApprovals = async (id: string) =>
    ((await h.api("GET", `/inbox?sessionId=${id}`)).body as unknown[])
      .map((i) => InboxItem.parse(i))
      .filter((i) => i.kind === "approval" && i.status === "open");
  const statusOf = async (id: string) => (await h.detail(id)).session.status;

  it("applies the level to the live session from its next tool call", async () => {
    const id = await h.startFakeSession("first");
    expect((await h.detail(id)).session.autonomy).toBe("auto");

    const full = await h.api("PATCH", `/sessions/${id}`, { autonomy: "full" });
    expect(full.status).toBe(200);
    expect(full.body).toMatchObject({ autonomy: "full" });
    // The runner took it, so nothing is left to retry.
    const meta = () =>
      h.server.services.sessionRepo.find(id)?.startMeta as { pendingConfig?: unknown };
    expect(meta().pendingConfig).toBeUndefined();

    // The Fake's scripted command approval is skipped on full: the turn just finishes.
    await h.api("POST", `/sessions/${id}/messages`, { input: { text: "go [approval]" } });
    await waitUntil(async () => ((await statusOf(id)) === "idle" ? true : undefined));
    expect(await openApprovals(id)).toEqual([]);

    // Back to auto: the same request asks again.
    await h.api("PATCH", `/sessions/${id}`, { autonomy: "auto" });
    await h.api("POST", `/sessions/${id}/messages`, { input: { text: "again [approval]" } });
    await waitUntil(async () => ((await statusOf(id)) === "waiting" ? true : undefined));
    expect(await openApprovals(id)).toHaveLength(1);
    expect(SessionDetail.parse((await h.api("GET", `/sessions/${id}`)).body).session.autonomy).toBe(
      "auto",
    );
  });

  it("starts an agent session with read-only permissions and switches it live", async () => {
    const res = await h.api("POST", "/sessions", {
      projectId: h.projectId,
      provider: "fake",
      autonomy: "read_only",
      purpose: `Read-only ${Math.random()}`,
      input: { text: "look [approval]" },
    });
    const started = StartSessionResponse.parse(res.body);
    if (started.status !== "started") throw new Error(started.status);
    const id = started.sessionId;
    await waitUntil(async () => ((await statusOf(id)) === "idle" ? true : undefined));
    expect((await h.detail(id)).session.autonomy).toBe("read_only");
    // Read-only never runs the scripted command, so nothing asks.
    expect(await openApprovals(id)).toEqual([]);
    // CodeDen's own tools never commit or push for it either.
    await expect(
      h.server.services.github.createPullRequest(id, { title: "feat: nope" }),
    ).rejects.toMatchObject({ code: "read_only" });
    const patched = await h.api("PATCH", `/sessions/${id}`, { autonomy: "auto" });
    expect(patched.body).toMatchObject({ autonomy: "auto" });
    expect((await h.api("PATCH", `/sessions/${id}`, { autonomy: "read_only" })).status).toBe(200);
  });

  it("saves the level for a session that is not running and rejects bad values", async () => {
    const res = await h.api("POST", "/sessions", {
      projectId: h.projectId,
      provider: "fake",
      purpose: `Stopped ${Math.random()}`,
      input: { text: "hi" },
    });
    const started = StartSessionResponse.parse(res.body);
    if (started.status !== "started") throw new Error(started.status);
    await waitUntil(async () =>
      (await statusOf(started.sessionId)) === "idle" ? true : undefined,
    );
    await h.api("POST", `/sessions/${started.sessionId}/stop`);
    const patched = await h.api("PATCH", `/sessions/${started.sessionId}`, {
      autonomy: "supervised",
    });
    expect(patched.status).toBe(200);
    expect((await h.detail(started.sessionId)).session.autonomy).toBe("supervised");
    expect(
      (await h.api("PATCH", `/sessions/${started.sessionId}`, { autonomy: "max" })).status,
    ).toBe(400);
  });
});

describe("readOnlyUnsupported", () => {
  const caps = {
    resume: true,
    steer: true,
    interrupt: true,
    approvals: true,
    userQuestions: true,
    subagents: true,
    rollback: false,
    fork: false,
    images: true,
    planMode: true,
    reasoningEffort: true,
    mcp: true,
    skills: false,
    enforcesSecurityRules: true,
  };
  const provider = (readOnly?: boolean): ProviderInfo => ({
    id: "other",
    displayName: "Other",
    models: [],
    capabilities: { ...caps, ...(readOnly === undefined ? {} : { readOnly }) },
  });

  it("refuses read-only agent sessions on providers that cannot enforce it", () => {
    expect(readOnlyUnsupported("agent", "read_only", provider())).toMatch(/Other cannot/);
    expect(readOnlyUnsupported("agent", "read_only", provider(false))).toMatch(/read-only/);
    expect(readOnlyUnsupported("agent", "read_only", provider(true))).toBeNull();
    expect(readOnlyUnsupported("agent", "auto", provider())).toBeNull();
    // PMs and the orchestrator are read-only at every level: they need a provider that declares
    // it (absent counts as not enforced). Unknown providers pass; the runner checks at start.
    expect(readOnlyUnsupported("pm", "auto", provider())).toMatch(/can't run a PM/);
    expect(readOnlyUnsupported("orchestrator", "auto", provider(false))).toMatch(/orchestrator/);
    expect(readOnlyUnsupported("pm", "auto", provider(true))).toBeNull();
    expect(readOnlyUnsupported("agent", "read_only", undefined)).toBeNull();
  });
});
