import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateProjectResponse,
  type InboxItem,
  InboxItem as InboxItemSchema,
  type ItemRecord,
  SessionDetail,
  StartSessionResponse,
  type TranscriptMessage,
  type UiServerMessage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isProcessAlive, type RunningServer, readLiveRunnerLock, startServer } from "../src";
import { RUNNER_REQUEST_TIMEOUT_FLOOR_MS, waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";
import { TestWsClient } from "./support/ws-client";

const TOKEN = "f".repeat(64);
let home: string;
let repo: string;
let server: RunningServer;
let ws: TestWsClient;
let projectId: string;

const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as unknown };
};

const detail = async (id: string) =>
  SessionDetail.parse((await api("GET", `/sessions/${id}`)).body);
const statusIs = (id: string, ...statuses: string[]) =>
  waitUntil(async () => {
    const d = await detail(id);
    return statuses.includes(d.session.status) ? d : undefined;
  });
const openInbox = async (sessionId: string) =>
  ((await api("GET", `/inbox?sessionId=${sessionId}`)).body as unknown[]).map((i) =>
    InboxItemSchema.parse(i),
  );

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-flow-"));
  repo = join(home, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: TOKEN,
    enableFakeProvider: true,
    waitForRunner: true,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    realtimeFlushMs: 10,
    runnerRequestTimeoutFloorMs: RUNNER_REQUEST_TIMEOUT_FLOOR_MS,
  });
  ws = await TestWsClient.connect(server.url, TOKEN);
});

afterAll(async () => {
  ws?.close();
  const lock = server ? readLiveRunnerLock(server.paths.runnerLock) : undefined;
  await server?.close({ stopRunner: true });
  // The runner exits shortly after; Windows keeps its folders locked until then.
  const deadline = Date.now() + 10_000;
  while (lock && isProcessAlive(lock.pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await removeTree(home);
});

describe("project -> Fake session through a real runner", () => {
  it("adds a local git folder as a project", async () => {
    const res = await api("POST", "/projects", { source: { type: "local", path: repo } });
    expect(res.status).toBe(201);
    const created = CreateProjectResponse.parse(res.body);
    expect(created.project).toMatchObject({ kind: "local", defaultBranch: "main" });
    expect(created.detected).toMatchObject({ isGitRepo: true, packageManager: "pnpm" });
    projectId = created.project.id;
    const again = await api("POST", "/projects", { source: { type: "local", path: repo } });
    expect(again.status).toBe(409);
  });

  it("streams a session, routes its approval through the inbox, then goes idle", async () => {
    ws.send({ type: "subscribe", fromSeq: server.store.headSeq(), agentEvents: false });
    const res = await api("POST", "/sessions", {
      projectId,
      provider: "fake",
      purpose: "Say hello",
      input: { text: "hello [approval]" },
    });
    const started = StartSessionResponse.parse(res.body);
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const id = started.sessionId;
    ws.send({ type: "watch_session", sessionId: id, fromSeq: 0 });

    // The approval becomes an inbox item and the session waits on it.
    await statusIs(id, "waiting");
    const [approval] = await openInbox(id);
    expect(approval).toMatchObject({ kind: "approval", status: "open", projectId });
    await ws.waitFor(
      (m) => m.type === "events" && m.events.some((e) => e.type === "inbox.created"),
    );

    const resolved = await api("POST", `/inbox/${(approval as InboxItem).id}/resolve`, {
      response: { kind: "approval", decision: "allow_once" },
    });
    expect(resolved.status).toBe(200);
    expect(InboxItemSchema.parse(resolved.body).status).toBe("resolved");

    const done = await statusIs(id, "idle");
    expect(done.followups?.suggestions.length).toBeGreaterThan(0);
    expect(done.usage).toMatchObject({ outputTokens: 42 });
    expect(done.session.resumeToken).toBe(`fake-${id}`);
    // Until the runner creates worktrees, CodeDen falls back to the repo root and says so.
    if (done.session.worktreePath === null) {
      expect(done.startMeta?.workspaceFallback).toBeTruthy();
      expect(done.session.cwd).toBe(server.services.projects.get(projectId).path);
    }

    // Transcript items arrived over the websocket.
    const items = new Map<string, ItemRecord>();
    await ws.waitFor((m) => {
      if (m.type === "transcript" && m.sessionId === id) {
        for (const r of (m as TranscriptMessage).items) items.set(r.item.id, r);
      }
      return [...items.values()].some((r) => r.item.kind === "followups");
    });
    const kinds = [...items.values()].map((r) => r.item.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["user_message", "assistant_message", "tool_call"]),
    );
    const reply = [...items.values()].find((r) => r.item.kind === "assistant_message")?.item;
    expect(reply?.kind === "assistant_message" && reply.text).toBe("Echo: hello [approval]");

    // Domain-only subscription: session updates arrive, agent events do not.
    const seen = ws.messages.flatMap((m: UiServerMessage) => (m.type === "events" ? m.events : []));
    expect(seen.some((e) => e.type === "session.updated")).toBe(true);
    expect(seen.some((e) => e.type.startsWith("agent."))).toBe(false);

    // Paginated transcript and lazy tool output.
    const root = done.session.rootThreadId as string;
    const page = await api(
      "GET",
      `/sessions/${id}/threads/${encodeURIComponent(root)}/items?limit=2`,
    );
    const body = page.body as { items: ItemRecord[]; hasMoreBefore: boolean };
    expect(body.items).toHaveLength(2);
    expect(body.hasMoreBefore).toBe(true);
    const tool = [...items.values()].find((r) => r.item.kind === "tool_call");
    const output = await api("GET", `/sessions/${id}/items/${tool?.item.id}/output`);
    expect(output.body).toMatchObject({
      text: "hello\n",
      totalBytes: 6,
      truncated: false,
      outputBytes: 6,
    });

    // Follow-up message in the same session.
    const sent = await api("POST", `/sessions/${id}/messages`, { input: { text: "again" } });
    expect(sent.body).toEqual({ status: "sent" });
    await statusIs(id, "idle");
  });

  it("detects duplicate work and honours wait, skip and force", async () => {
    const first = StartSessionResponse.parse(
      (
        await api("POST", "/sessions", {
          projectId,
          provider: "fake",
          workKey: "issue:7",
          input: { text: "fix it [approval]" },
        })
      ).body,
    );
    if (first.status !== "started") throw new Error("expected started");
    await statusIs(first.sessionId, "waiting");

    const dup = { projectId, provider: "fake", workKey: "issue:7", input: { text: "fix it too" } };
    const conflict = await api("POST", "/sessions", dup);
    expect(conflict.status).toBe(409);
    const parsed = StartSessionResponse.parse(conflict.body);
    expect(parsed.status === "conflict" && parsed.existing[0]?.sessionId).toBe(first.sessionId);

    expect(
      (await api("POST", "/sessions", { ...dup, conflict: { resolution: "skip" } })).body,
    ).toEqual({
      status: "skipped",
      reason: "The conflicting session start was skipped.",
    });

    const forced = StartSessionResponse.parse(
      (
        await api("POST", "/sessions", {
          ...dup,
          conflict: { resolution: "force", reason: "urgent" },
        })
      ).body,
    );
    if (forced.status !== "started") throw new Error("expected started");
    expect((await detail(forced.sessionId)).startMeta?.forced).toMatchObject({
      reason: "urgent",
      conflictsWith: expect.arrayContaining([first.sessionId]),
    });

    const queued = StartSessionResponse.parse(
      (
        await api("POST", "/sessions", {
          ...dup,
          conflict: { resolution: "wait", behindId: first.sessionId },
        })
      ).body,
    );
    if (queued.status !== "queued") throw new Error("expected queued");
    expect((await detail(queued.sessionId)).session.status).toBe("queued");

    // Stopping the blockers lets the queued session start on its own.
    await api("POST", `/sessions/${forced.sessionId}/stop`);
    const stopped = SessionDetail.parse((await api("GET", `/sessions/${first.sessionId}`)).body);
    expect(stopped.session.status).toBe("waiting");
    await api("POST", `/sessions/${first.sessionId}/stop`);
    expect((await openInbox(first.sessionId)).length).toBe(0);
    const ran = await statusIs(queued.sessionId, "idle");
    expect(ran.session.status).toBe("idle");
  });
  const start = async (workKey: string, text: string, extra = {}) => {
    const started = StartSessionResponse.parse(
      (
        await api("POST", "/sessions", {
          projectId,
          provider: "fake",
          workKey,
          input: { text },
          ...extra,
        })
      ).body,
    );
    if (started.status !== "started" && started.status !== "queued") {
      throw new Error(`Unexpected start result: ${started.status}`);
    }
    return started;
  };

  const stop = (id: string) => api("POST", `/sessions/${id}/stop`);
  const resume = (id: string, text: string) =>
    server.services.sessions.send(
      id,
      { input: { text, attachments: [] }, whenBusy: "queue" },
      "pm",
    );
  const setCap = (maxActiveSessions: number) =>
    api("PATCH", "/settings", { limits: { maxActiveSessions } });

  it("admits six held starts in original order within the cap and keeps their briefs first", async () => {
    const baseline = server.services.settings.get().limits.maxActiveSessions;
    const requests = vi.spyOn(server.services.runner, "request");
    const ids: string[] = [];
    const commands = () => requests.mock.calls.map(([command]) => command);
    const opens = (id: string) =>
      commands().filter((command) => command.name === "session.start" && command.sessionId === id);
    try {
      expect((await setCap(1)).status).toBe(200);
      const blocker = await start("request:hold", "hold [approval]");
      ids.push(blocker.sessionId);
      await statusIs(blocker.sessionId, "waiting");
      const lanes: string[] = [];
      for (let index = 0; index < 6; index++) {
        const lane = await start(`request:lane-${index}`, `brief ${index} [approval]`, {
          scope: { paths: [`apps/lane-${index}`] },
          workspace: { mode: "worktree" },
        });
        expect(lane.status).toBe("queued");
        lanes.push(lane.sessionId);
        ids.push(lane.sessionId);
      }
      const [oldest, , , , fifth, last] = lanes;
      if (!oldest || !fifth || !last) throw new Error("Expected six lanes");
      for (const id of lanes) {
        await stop(id);
        expect((await detail(id)).session.status).toBe("stopped");
      }
      for (const id of [...lanes].reverse()) {
        expect(await resume(id, "follow-up")).toEqual({ status: "queued" });
        server.services.lifecycle.drainQueue();
        expect((await detail(id)).session.status).toBe("queued");
      }
      expect(await resume(oldest, "second follow-up")).toEqual({ status: "queued" });
      expect(lanes.flatMap(opens)).toHaveLength(0);

      // The blocker itself occupies one of five slots until it settles.
      expect((await setCap(5)).status).toBe(200);
      await Promise.all(lanes.slice(0, 4).map((id) => statusIs(id, "waiting")));
      expect((await detail(fifth)).session.status).toBe("queued");
      expect((await detail(last)).session.status).toBe("queued");
      expect(server.services.admission.status().active).toBe(5);
      await stop(blocker.sessionId);
      await statusIs(fifth, "waiting");
      expect((await detail(last)).session.status).toBe("queued");
      expect(opens(last)).toHaveLength(0);
      const claimed = () =>
        commands().flatMap((command) =>
          command.name === "workspace.prepare" &&
          command.sessionId &&
          lanes.includes(command.sessionId)
            ? [command.sessionId]
            : [],
        );
      expect(claimed()).toEqual(lanes.slice(0, 5));

      for (const [index, id] of lanes.slice(0, 5).entries()) {
        const { session } = await detail(id);
        expect(session.worktreePath).toBe(session.cwd);
        expect(session.cwd).not.toBe(repo);
        expect(opens(id)).toEqual([
          expect.objectContaining({ options: expect.objectContaining({ cwd: session.cwd }) }),
        ]);
        expect(
          commands().find((command) => command.name === "session.send" && command.sessionId === id),
        ).toMatchObject({ input: { text: `brief ${index} [approval]` } });
      }

      const [approval] = await openInbox(oldest);
      expect(
        (
          await api("POST", `/inbox/${approval?.id}/resolve`, {
            response: { kind: "approval", decision: "allow_once" },
          })
        ).status,
      ).toBe(200);
      await waitUntil(() =>
        commands().filter(
          (command) => command.name === "session.send" && command.sessionId === oldest,
        ).length === 3
          ? true
          : undefined,
      );
      await statusIs(oldest, "idle");
      await statusIs(last, "waiting");
      expect(claimed()).toEqual(lanes);
      expect(opens(oldest)).toHaveLength(1);
      expect(opens(last)).toHaveLength(1);
      const inputs = commands().flatMap((command) =>
        command.name === "session.send" && command.sessionId === oldest ? [command.input.text] : [],
      );
      expect(inputs).toEqual(["brief 0 [approval]", "follow-up", "second follow-up"]);
    } finally {
      requests.mockRestore();
      for (const id of ids) await stop(id);
      await setCap(baseline);
    }
  });

  it("keeps the brief and follow-up queued when isolated preparation fails", async () => {
    const baseline = server.services.settings.get().limits.maxActiveSessions;
    const requests = vi.spyOn(server.services.runner, "request");
    const ids: string[] = [];
    try {
      expect((await setCap(1)).status).toBe(200);
      const blocker = await start("request:retry-hold", "hold [approval]");
      ids.push(blocker.sessionId);
      await statusIs(blocker.sessionId, "waiting");
      const lane = await start("request:retry-worktree", "saved [approval]", {
        workspace: { mode: "worktree", baseRef: "test-retry-base" },
      });
      ids.push(lane.sessionId);
      expect(lane.status).toBe("queued");
      await stop(lane.sessionId);
      expect(await resume(lane.sessionId, "queued after saved")).toEqual({ status: "queued" });
      await stop(blocker.sessionId);
      await statusIs(lane.sessionId, "failed");
      await server.services.sessions.flushOutbox(lane.sessionId);
      const opens = () =>
        requests.mock.calls
          .map(([command]) => command)
          .filter(
            (command) => command.name === "session.start" && command.sessionId === lane.sessionId,
          );
      expect(opens()).toHaveLength(0);

      git("branch", "test-retry-base");
      expect(await resume(lane.sessionId, "retry")).toEqual({ status: "queued" });
      const { session } = await statusIs(lane.sessionId, "waiting");
      expect(session.cwd).toBe(session.worktreePath);
      expect(session.cwd).not.toBe(repo);
      expect(opens()).toHaveLength(1);
      const first = requests.mock.calls
        .map(([command]) => command)
        .find((command) => command.name === "session.send" && command.sessionId === lane.sessionId);
      expect(first).toMatchObject({ input: { text: "saved [approval]" } });
    } finally {
      requests.mockRestore();
      for (const id of ids) await stop(id);
      await setCap(baseline);
    }
  });

  it("admits a queued overlapping lane while a broad scope is active on another branch", async () => {
    const baseline = server.services.settings.get().limits.maxActiveSessions;
    const ids: string[] = [];
    try {
      expect((await setCap(1)).status).toBe(200);
      const broad = await start("request:broad", "broad [approval]", {
        scope: { paths: ["apps/", "packages/"] },
      });
      ids.push(broad.sessionId);
      await statusIs(broad.sessionId, "waiting");

      const lane = await start("request:separate", "separate [approval]", {
        scope: { paths: ["apps/server"] },
      });
      ids.push(lane.sessionId);
      expect(lane.status).toBe("queued");
      expect((await setCap(2)).status).toBe(200);
      const opened = await statusIs(lane.sessionId, "waiting");
      const active = await detail(broad.sessionId);
      expect(active.session.status).toBe("waiting");
      expect(opened.session.branch).not.toBe(active.session.branch);
      expect(opened.session.cwd).not.toBe(active.session.cwd);

      const same = await api("POST", "/sessions", {
        projectId,
        provider: "fake",
        workKey: "request:same-worktree",
        scope: { paths: ["apps/server"] },
        workspace: { mode: "existing", path: active.session.cwd },
      });
      expect(same.status).toBe(409);

      const branch = active.session.branch;
      if (!branch) throw new Error("Expected the broad session's worktree branch");
      const checkout = join(home, "same-branch-checkout");
      git("clone", "--quiet", "--single-branch", "--branch", branch, repo, checkout);
      const sameBranch = await api("POST", "/sessions", {
        projectId,
        provider: "fake",
        workKey: "request:same-branch",
        scope: { paths: ["packages/contracts"] },
        workspace: { mode: "existing", path: checkout },
      });
      expect(sameBranch.status).toBe(409);
    } finally {
      for (const id of ids) await stop(id);
      await setCap(baseline);
    }
  });
});
