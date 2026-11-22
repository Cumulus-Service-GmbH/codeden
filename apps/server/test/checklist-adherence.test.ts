import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sampleSession } from "../../../packages/contracts/test/fixtures";
import { startSession } from "../src/mcp/tools/pm/sessions";
import { checklistRoutes } from "../src/routes/checklists";
import { inboxRoutes } from "../src/routes/inbox";
import { ChecklistService } from "../src/services/checklist/checklist-service";
import type { AppServices } from "../src/services/container";
import { createFactoryEnv } from "./support/factory-env";

let env: ReturnType<typeof createFactoryEnv>;
let checklist: ChecklistService;
let services: AppServices;
const notify = vi.fn();

beforeEach(() => {
  env = createFactoryEnv();
  notify.mockClear();
  checklist = new ChecklistService(env.db.db, env.store, env.inbox, notify);
  services = {
    checklist,
    factory: env.factory,
    settings: env.settings,
    projects: { get: () => env.project },
    sessions: env.sessions,
    sessionRepo: env.repo,
    inbox: env.inbox,
  } as unknown as AppServices;
});
afterEach(() => env.close());

function start(checklistItemId?: string, purpose = "Add a counter") {
  return startSession.handler(
    startSession.input.parse({ purpose, prompt: "Implement it", checklistItemId }),
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
  expect(env.starts).toHaveLength(0);

  const pending = checklist.get(id)?.pending;
  const itemId = pending?.diff[0]?.itemId;
  if (!pending || !itemId) throw new Error("Expected a start expansion card");
  expect(await decide(pending.inboxItemId, "resolved")).toHaveProperty("status", 200);
  expect(await decide(pending.inboxItemId, "resolved")).toHaveProperty("status", 200);
  expect(notify).toHaveBeenCalledExactlyOnceWith(id, expect.stringContaining(itemId));
  expect(env.starts).toHaveLength(0);
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
  expect(env.starts).toHaveLength(3);
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
  const originalStart = env.sessions.start.bind(env.sessions);
  vi.spyOn(env.sessions, "start").mockImplementationOnce(async (...args) => {
    const result = await originalStart(...args);
    const { pending } = checklist.update(env.project.id, { remove: ["a"] });
    if (!pending) throw new Error("Expected a removal proposal");
    checklist.decide(pending.inboxItemId, "resolved");
    return result;
  });
  expect(await start("a")).toMatchObject({
    status: "started",
    sessionId: expect.any(String),
    note: "started, but item a is no longer in the approved plan: not linked",
  });
  expect(env.starts).toHaveLength(1);
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
  expect(env.starts).toHaveLength(0);
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
  expect(env.starts).toHaveLength(1);
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
  const originalStart = env.sessions.start.bind(env.sessions);
  const gate = Promise.withResolvers<void>();
  const launch = vi.spyOn(env.sessions, "start").mockImplementationOnce(async (...args) => {
    await gate.promise;
    return originalStart(...args);
  });
  const first = start("a");
  const second = start("a");
  gate.resolve();
  const results = await Promise.allSettled([first, second]);
  expect(results[0]).toMatchObject({ status: "fulfilled", value: { status: "started" } });
  expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
  expect(launch).toHaveBeenCalledOnce();
  expect(checklist.get(env.project.id)?.items[0]?.sessionIds).toHaveLength(200);
});

it("releases a reserved link when the session fails to start", async () => {
  approveItem();
  fillLinks(199);
  vi.spyOn(env.sessions, "start").mockRejectedValueOnce(new Error("Start failed"));
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
  expect(env.starts).toHaveLength(0);
});

it.each(["started", "queued"] as const)(
  "preserves a %s result when linking throws",
  async (status) => {
    approveItem();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalStart = env.sessions.start.bind(env.sessions);
    vi.spyOn(env.sessions, "start").mockImplementationOnce(async (...args) => {
      const result = await originalStart(...args);
      if (result.status !== "started") throw new Error("Expected a started session");
      return status === "queued"
        ? { status, sessionId: result.sessionId, behind: ["other"] }
        : result;
    });
    vi.spyOn(checklist, "link").mockImplementationOnce(() => {
      throw new Error("Write failed");
    });
    try {
      expect(await start("a")).toEqual({
        status,
        sessionId: expect.any(String),
        ...(status === "queued" ? { behind: ["other"] } : {}),
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
  const tasks = [{ id: "a", text: "Add a counter" }];
  const sha = createHash("sha256").update(JSON.stringify(tasks)).digest("hex");
  const { pending } = checklist.proposePlan(env.project.id, { tasks, sha, reviewRef: "review-1" });
  if (!pending) throw new Error("Expected plan approval");
  await expect(start("a")).rejects.toThrow(/awaiting owner approval/i);
  expect((await decide(pending.inboxItemId, "resolved")).status).toBe(200);
  await expect(start()).rejects.toThrow(/requires a reviewed revision/i);
  await expect(start("a", "Change other work")).rejects.toThrow(/purpose/i);
  expect(env.starts).toHaveLength(0);
  expect(await start("a")).toMatchObject({ status: "started" });
});
