import { createHash } from "node:crypto";
import { Automation, StartSessionRequest, type UserInput } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sampleSession } from "../../../packages/contracts/test/fixtures";
import { startSession } from "../src/mcp/tools/pm/sessions";
import { checklistRoutes } from "../src/routes/checklists";
import { inboxRoutes } from "../src/routes/inbox";
import { sessionRoutes } from "../src/routes/sessions";
import { errorResponse } from "../src/routes/validate";
import { AutomationExecutor, type ExecutorDeps } from "../src/services/automations/executor";
import { RunStore } from "../src/services/automations/runs";
import { ChecklistService } from "../src/services/checklist/checklist-service";
import type { AppServices } from "../src/services/container";
import { FactorySessions, type FactorySessionsDeps } from "../src/services/factory/sessions";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { createFactoryEnv } from "./support/factory-env";

let env: ReturnType<typeof createFactoryEnv>;
let checklist: ChecklistService;
let services: AppServices;
let launched: string[];
let requestSequence: number;
const notify = vi.fn();

beforeEach(() => {
  env = createFactoryEnv();
  notify.mockClear();
  launched = [];
  requestSequence = 0;
  checklist = new ChecklistService(env.db.db, env.store, env.inbox, notify);
  services = {
    checklist,
    factory: env.factory,
    settings: env.settings,
    projects: { get: () => env.project },
    sessions: undefined,
    sessionRepo: env.repo,
    inbox: env.inbox,
  } as unknown as AppServices;
  services.sessions = sessionService();
});
afterEach(() => env.close());

function start(checklistItemId?: string, purpose = "Add a counter") {
  return startSession.handler(
    startSession.input.parse({
      purpose,
      prompt: "Implement it",
      checklistItemId,
      workKey: `checklist-test:${++requestSequence}`,
    }),
    {
      services,
      projectId: env.project.id,
      sessionId: null,
      role: "pm",
      caller: "mcp",
      signal: new AbortController().signal,
    },
  );
}

function decide(id: string, status: "resolved" | "dismissed") {
  return inboxRoutes(services).request(`/${id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

it("waits for an owner decision, then starts and links when the PM retries", async () => {
  const id = env.project.id;
  const draft = checklist.update(
    id,
    { items: [{ id: "a", text: "A" }] },
    { requestApproval: true },
  );
  expect(() => checklist.setEnforce(id, true)).toThrow(/approve/i);
  if (!draft.pending) throw new Error("Expected a draft approval card");
  expect((await decide(draft.pending.inboxItemId, "resolved")).status).toBe(200);
  const enforced = await checklistRoutes(services).request(`/${id}/enforce`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enforce: true }),
  });
  expect(await enforced.json()).toMatchObject({ enforce: true });
  await expect(start("missing")).rejects.toThrow(/unknown approved checklistItemId/i);
  expect(await start()).toMatchObject({ status: "approval_required" });
  expect(launched).toHaveLength(0);

  const pending = checklist.get(id)?.pending;
  const itemId = pending?.diff[0]?.itemId;
  if (!pending || !itemId) throw new Error("Expected a start expansion card");
  expect(await decide(pending.inboxItemId, "resolved")).toHaveProperty("status", 200);
  expect(await decide(pending.inboxItemId, "resolved")).toHaveProperty("status", 200);
  expect(notify).toHaveBeenCalledExactlyOnceWith(id, expect.stringContaining(itemId));
  expect(launched).toHaveLength(0);
  const result = await start(itemId);
  expect(result).toMatchObject({ status: "started" });
  expect(checklist.get(id)?.items.find((item) => item.id === itemId)).toMatchObject({
    status: "doing",
    sessionIds: [expect.any(String)],
  });
});

it("keeps the start result unchanged without enforcement and reports an ignored ID", async () => {
  expect(await start()).toEqual({ status: "started", sessionId: expect.any(String) });
  checklist.update(env.project.id, { items: [{ text: "Draft work" }] });
  expect(await start()).toEqual({ status: "started", sessionId: expect.any(String) });
  expect(await start("unknown")).toEqual({
    status: "started",
    sessionId: expect.any(String),
    note: "Unknown checklistItemId unknown was ignored.",
  });
  expect(launched).toHaveLength(3);
  expect(env.inbox.list()).toEqual([]);
});

function approveItem() {
  const projectId = env.project.id;
  const draft = checklist.update(
    projectId,
    { items: [{ id: "a", text: "A" }] },
    { requestApproval: true },
  );
  if (!draft.pending) throw new Error("Expected a draft approval card");
  checklist.decide(draft.pending.inboxItemId, "resolved");
  checklist.setEnforce(projectId, true);
}

it("reports a successful start whose checklist item was removed while starting", async () => {
  approveItem();
  const originalCreate = env.repo.create.bind(env.repo);
  vi.spyOn(env.repo, "create").mockImplementationOnce((...args) => {
    originalCreate(...args);
    const { pending } = checklist.update(env.project.id, { remove: ["a"] });
    if (!pending) throw new Error("Expected a removal proposal");
    checklist.decide(pending.inboxItemId, "resolved");
  });
  expect(await start("a")).toMatchObject({
    status: "started",
    sessionId: expect.any(String),
    note: "started, but item a is no longer in the approved plan: not linked",
  });
  expect(launched).toHaveLength(1);
});

function fillLinks(count: number) {
  const projectId = env.project.id;
  const sessions = Array.from({ length: count }, (_, i) => ({
    ...sampleSession,
    id: `linked-${i}`,
    projectId,
    status: "running" as const,
  }));
  env.store.append(
    sessions.map((session) => ({
      type: "session.created",
      sessionId: session.id,
      payload: { session },
    })),
  );
  for (const session of sessions) expect(checklist.link(projectId, "a", session)).toBe(true);
}

it("refuses a linked start at capacity until an inactive link can be dropped", async () => {
  approveItem();
  fillLinks(200);
  const projectId = env.project.id;
  await expect(start("a")).rejects.toThrow(/200 active/);
  expect(launched).toHaveLength(0);
  env.repo.update("linked-1", (session) => ({ ...session, archivedAt: session.updatedAt }));
  env.repo.update("linked-2", (session) => ({ ...session, status: "completed" }));
  const result = await start("a");
  expect(result).toMatchObject({ status: "started" });
  const links = checklist.get(projectId)?.items[0]?.sessionIds;
  expect(links).toHaveLength(200);
  expect(links?.slice(0, 2)).toEqual(["linked-0", "linked-2"]);
  expect(links?.at(-1)).toBe((result as { sessionId: string }).sessionId);
});

it("accepts a trailing newline in a legacy PM start", async () => {
  expect(await start(undefined, "Fix bug\n")).toMatchObject({ status: "started" });
  expect(launched).toHaveLength(1);
});

it("normalizes checklist expansion purposes before storage and comparison", async () => {
  approveItem();
  expect(await start(undefined, "Fix\r\n\nbug")).toMatchObject({ status: "approval_required" });
  const pending = checklist.get(env.project.id)?.pending;
  const itemId = pending?.diff[0]?.itemId;
  if (!pending || !itemId) throw new Error("Expected a start expansion card");
  expect(pending.startPurpose).toBe("Fix bug");
  expect(checklist.expansionForStart(env.project.id, env.project.name, "  FIX\nBUG  ")).toBe(
    itemId,
  );
  checklist.decide(pending.inboxItemId, "resolved");
  expect(await start(itemId, "Fix\nbug")).toMatchObject({ status: "started" });
});

it("reserves the last link before concurrent enforced starts", async () => {
  approveItem();
  fillLinks(199);
  const create = vi.spyOn(env.repo, "create");
  const results = await Promise.allSettled([start("a"), start("a")]);
  expect(results).toContainEqual({
    status: "fulfilled",
    value: { status: "started", sessionId: expect.any(String) },
  });
  expect(results).toContainEqual({ status: "rejected", reason: expect.any(Error) });
  expect(create).toHaveBeenCalledOnce();
  expect(checklist.get(env.project.id)?.items[0]?.sessionIds).toHaveLength(200);
});

it("releases a reserved link when the session fails to start", async () => {
  approveItem();
  fillLinks(199);
  vi.spyOn(env.repo, "create").mockImplementationOnce(() => {
    throw new Error("Start failed");
  });
  await expect(start("a")).rejects.toThrow("Start failed");
  expect(await start("a")).toMatchObject({ status: "started" });
  expect(checklist.get(env.project.id)?.items[0]?.sessionIds).toHaveLength(200);
});

it("refuses an enforced start for completed work", async () => {
  approveItem();
  checklist.update(env.project.id, { patch: [{ id: "a", status: "done" }] });
  await expect(start("a")).rejects.toThrow(
    /item a is done; ask the orchestrator for an expansion card/,
  );
  expect(launched).toHaveLength(0);
});

it.each(["started", "queued"] as const)(
  "preserves a %s result when linking throws",
  async (status) => {
    approveItem();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    services.sessions = sessionService(status === "queued");
    vi.spyOn(checklist, "link").mockImplementationOnce(() => {
      throw new Error("Write failed");
    });
    try {
      expect(await start("a")).toEqual({
        status,
        sessionId: expect.any(String),
        ...(status === "queued" ? { behind: [] } : {}),
        note:
          status === "queued"
            ? "Queued, but linking checklist item a failed: Write failed"
            : "Started, but linking checklist item a failed: Write failed",
      });
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  },
);

it("starts without reserving a link when enforcement is off and all links are active", async () => {
  approveItem();
  const projectId = env.project.id;
  checklist.setEnforce(projectId, false);
  fillLinks(200);
  const reserve = vi.spyOn(checklist, "reserveLink");
  expect(await start("a")).toMatchObject({
    status: "started",
    note: "started, but the session could not be linked to item a",
  });
  expect(checklist.get(projectId)?.items[0]?.sessionIds?.at(-1)).toBe("linked-199");
  env.repo.update("linked-0", (session) => ({ ...session, status: "completed" }));
  expect(await start("a")).toEqual({ status: "started", sessionId: expect.any(String) });
  expect(checklist.get(projectId)?.items[0]?.sessionIds?.[0]).toBe("linked-1");
  expect(reserve).not.toHaveBeenCalled();
});

it("refuses PM starts until the reviewed plan is approved and then requires its task", async () => {
  services.sessions = sessionService();
  expect(await start(undefined, "Unplanned work")).toMatchObject({ status: "started" });
  const pending = proposePlan();
  await expect(start("a")).rejects.toThrow(/awaiting owner approval/i);
  expect((await decide(pending.inboxItemId, "resolved")).status).toBe(200);
  await expect(start()).rejects.toThrow(/requires a reviewed revision/i);
  await expect(start("a", "Change other work")).rejects.toThrow(/purpose/i);
  expect(env.repo.list({ projectId: env.project.id })).toHaveLength(1);
  expect(await start("a")).toMatchObject({ status: "started" });
});

function proposePlan(text = "Add a counter") {
  const tasks = [{ id: "a", text }];
  const sha = createHash("sha256").update(JSON.stringify(tasks)).digest("hex");
  const { pending } = checklist.proposePlan(env.project.id, { tasks, sha, reviewRef: "review-1" });
  if (!pending) throw new Error("Expected plan approval");
  return pending;
}

function sessionService(queue = false) {
  return new SessionService({
    checklist,
    repo: env.repo,
    projects: services.projects,
    runner: { providers: () => [], isConnected: () => false },
    settings: env.settings,
    launcher: {
      launch: async (id: string) => {
        launched.push(id);
      },
    },
    ...(queue
      ? {
          admission: {
            tryReserve: () => false,
            enqueue: () => undefined,
            release: () => undefined,
          },
        }
      : {}),
    artifacts: {
      externalizeAttachments: (input: UserInput) => input,
      resolveAttachments: (input: UserInput) => input,
    },
  } as unknown as SessionServiceDeps);
}

function pinPlan(text?: string) {
  checklist.decide(proposePlan(text).inboxItemId, "resolved");
}

it("blocks a non-PM start while the first plan waits and links the approved task after", async () => {
  const sessions = sessionService();
  const req = StartSessionRequest.parse({ projectId: env.project.id, purpose: "Add a counter" });
  const pending = proposePlan();
  await expect(sessions.start(req)).rejects.toMatchObject({ code: "plan_approval_pending" });
  expect(env.repo.list({ projectId: env.project.id })).toEqual([]);
  checklist.decide(pending.inboxItemId, "resolved");
  const result = await sessions.start(req);
  expect(result.status).toBe("started");
  expect(checklist.get(env.project.id)?.items[0]).toMatchObject({
    status: "doing",
    sessionIds: [result.status === "started" && result.sessionId],
  });
});

it("enforces link capacity for a non-PM start matched by purpose", async () => {
  pinPlan();
  fillLinks(200);
  const sessions = sessionService();
  const req = StartSessionRequest.parse({ projectId: env.project.id, purpose: "Add a counter" });
  await expect(sessions.start(req)).rejects.toThrow(/200 active/);
  expect(launched).toHaveLength(0);
  env.repo.update("linked-0", (session) => ({ ...session, status: "completed" }));
  const result = await sessions.start(req);
  if (result.status !== "started") throw new Error("Expected a session");
  const links = checklist.get(env.project.id)?.items[0]?.sessionIds;
  expect(links).toHaveLength(200);
  expect(links?.at(-1)).toBe(result.sessionId);
});

it("resolves actual join and skip conflicts without admitting unplanned new work", async () => {
  const sessions = sessionService();
  const req = StartSessionRequest.parse({
    projectId: env.project.id,
    purpose: "Unplanned existing work",
    workKey: "task:same-work",
  });
  const first = await sessions.start(req);
  if (first.status !== "started") throw new Error("Expected a session");
  pinPlan();
  await expect(
    sessions.start({ ...req, conflict: { resolution: "join", sessionId: first.sessionId } }),
  ).resolves.toEqual({ status: "joined", sessionId: first.sessionId });
  await expect(sessions.start({ ...req, conflict: { resolution: "skip" } })).resolves.toMatchObject(
    {
      status: "skipped",
    },
  );
  await expect(
    sessions.start({ ...req, workKey: "task:unmatched", conflict: { resolution: "skip" } }),
  ).rejects.toMatchObject({ code: "outside_pinned_plan" });
  expect(env.repo.list({ projectId: env.project.id })).toHaveLength(1);
});

it("refuses a pinned-checklist join targeting unrelated work in the same project", async () => {
  const sessions = sessionService();
  const req = StartSessionRequest.parse({
    projectId: env.project.id,
    purpose: "Previously started work",
    workKey: "task:existing-work",
  });
  const match = await sessions.start(req);
  const other = await sessions.start({
    ...req,
    purpose: "Unrelated work",
    workKey: "task:unrelated",
  });
  if (match.status !== "started" || other.status !== "started") {
    throw new Error("Expected both sessions");
  }
  pinPlan();
  await expect(sessions.start(req)).resolves.toMatchObject({
    status: "conflict",
    existing: [{ sessionId: match.sessionId }],
  });
  await expect(
    sessions.start({ ...req, conflict: { resolution: "join", sessionId: other.sessionId } }),
  ).rejects.toMatchObject({ code: "join_mismatch" });
  expect(env.repo.list({ projectId: env.project.id })).toHaveLength(2);
});

it("refuses a factory start outside the pinned plan", async () => {
  const factory = new FactorySessions({
    sessions: sessionService(),
    isKilled: () => false,
    repo: env.repo,
  } as unknown as FactorySessionsDeps);
  const launch = () =>
    factory.startScout(env.project.id, "Find work", { provider: "auto", model: null });
  const first = await launch();
  if (first.status !== "started") throw new Error("Expected an unpinned start");
  env.repo.update(first.sessionId, (session) => ({ ...session, status: "completed" }));
  pinPlan();
  await expect(launch()).rejects.toThrow(/requires a reviewed revision/i);
  expect(factory.list(env.project.id)).toHaveLength(1);
});

it("refuses an automation start outside the pinned plan", async () => {
  const executor = new AutomationExecutor({
    sessions: sessionService(),
    repo: env.repo,
    runs: new RunStore(env.db.db, env.store),
    lastTurnStatus: () => null,
    now: () => new Date(),
  } as unknown as ExecutorDeps);
  const fire = (name: string) =>
    executor.fire({
      automation: Automation.parse({
        id: name,
        name,
        enabled: true,
        description: null,
        templateId: null,
        source: "database",
        trigger: { type: "manual" },
        action: { type: "start_session", prompt: "Do the work" },
        target: { type: "project", projectId: env.project.id },
        guards: {},
        createdAt: env.project.createdAt,
        updatedAt: env.project.updatedAt,
      }),
      project: env.project,
      triggeredBy: "manual",
      timezone: "UTC",
      vars: {},
      autonomy: undefined,
    });
  expect(await fire("Before pinning")).toMatchObject({ sessionId: expect.any(String) });
  pinPlan();
  expect(await fire("Outside the plan")).toMatchObject({
    sessionId: null,
    run: {
      status: "failed",
      error: { message: expect.stringMatching(/requires a reviewed revision/i) },
    },
  });
  expect(await fire("Add a counter")).toMatchObject({ sessionId: expect.any(String) });
});

it("refuses an HTTP start outside the pinned plan", async () => {
  const app = sessionRoutes(
    {
      ...services,
      sessions: sessionService(),
      orchestration: { conflicts: { closeReplaced: () => undefined } },
    } as unknown as AppServices,
    "test-token",
  ).onError(errorResponse);
  const post = (text: string) =>
    app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: env.project.id, input: { text } }),
    });
  expect((await post("Before pinning")).status).toBe(200);
  const task = "Add a counter with precise behavior and acceptance criteria. ".repeat(3).trim();
  pinPlan(task);
  const refused = await post("Outside the plan");
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({
    error: { message: expect.stringMatching(/requires a reviewed revision/i) },
  });
  expect((await post(`${task}\n\nImplementation details`)).status).toBe(200);
});
