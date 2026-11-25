import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sampleProject, sampleSession } from "../../../packages/contracts/test/fixtures";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { updateChecklistItem } from "../src/mcp/tools/checklist";
import { proposeChecklistPlan, updateChecklist } from "../src/mcp/tools/orchestrator/checklist";
import { ChecklistListener } from "../src/services/checklist/checklist-listener";
import { ChecklistService, WAITING_FOR_OWNER } from "../src/services/checklist/checklist-service";
import { SessionRepo } from "../src/services/sessions/repo";

const projectId = sampleProject.id;
const at = "2026-11-22T10:00:00.000Z";
const eta = "2026-11-22T12:00:00Z";
const session = { ...sampleSession, projectId, status: "idle" as const };
const needsOwner = { reason: "Decide", sessionId: session.id };
let db: Database;
let store: EventStore;
let checklist: ChecklistService;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  db = openDatabase(":memory:");
  store = new EventStore(db.db);
  checklist = new ChecklistService(db.db, store);
  store.append([
    { type: "project.created", sessionId: null, payload: { project: sampleProject } },
    { type: "session.created", sessionId: session.id, payload: { session } },
  ]);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

it("accepts and clears metadata through MCP input on draft and approved items", () => {
  const { items } = updateChecklist.input.parse({
    projectId,
    items: [{ id: "a", text: "A", eta, needsOwner, scopeAddition: { approvedAt: at } }],
  });
  const draft = checklist.update(projectId, { items: items ?? [] });
  expect(draft.items[0]).toMatchObject({ eta, needsOwner });
  expect(draft.items[0]).not.toHaveProperty("scopeAddition");
  expect(draft.changes).toContainEqual({
    itemId: "a",
    text: "A",
    from: "todo",
    to: "todo",
    at,
    needsOwner: true,
  });
  const approval = checklist.update(projectId, {}, { requestApproval: true }).pending;
  if (!approval) throw new Error("Expected approval");
  checklist.decide(approval.inboxItemId, "resolved");
  expect(checklist.get(projectId)?.items[0]).not.toHaveProperty("scopeAddition");

  const { patch } = updateChecklist.input.parse({
    projectId,
    patch: [{ id: "a", eta: null, needsOwner: null }],
  });
  const cleared = checklist.update(projectId, { patch });
  expect(cleared.pending).toBeUndefined();
  expect(cleared.items[0]?.eta).toBeUndefined();
  expect(cleared.items[0]?.needsOwner).toBeUndefined();

  checklist.link(projectId, "a", session);
  const { itemId, ...change } = updateChecklistItem.input.parse({ itemId: "a", eta, needsOwner });
  const updated = checklist.updateItem(projectId, itemId, change, session);
  expect(updated.pending).toBeUndefined();
  expect(updated.items[0]).toMatchObject({ eta, needsOwner });
});

it("applies addition metadata and stamps scope only at expansion approval", () => {
  checklist.update(projectId, { items: [{ id: "a", text: "A" }] });
  const approval = checklist.update(projectId, {}, { requestApproval: true }).pending;
  if (!approval) throw new Error("Expected approval");
  checklist.decide(approval.inboxItemId, "resolved");
  const expansion = checklist.update(projectId, {
    patch: [
      { id: "a", eta },
      { id: "b", text: "B", eta, needsOwner },
    ],
  });
  expect(expansion.items).toHaveLength(1);
  expect(expansion.items[0]?.eta).toBe(eta);
  if (!expansion.pending) throw new Error("Expected expansion");
  const approvedAt = "2026-11-22T10:05:00.000Z";
  vi.setSystemTime(new Date(approvedAt));
  checklist.decide(expansion.pending.inboxItemId, "resolved");
  const approved = checklist.get(projectId);
  expect(approved?.items[1]).toMatchObject({ eta, needsOwner, scopeAddition: { approvedAt } });
  expect(approved?.changes).toContainEqual({
    itemId: "b",
    text: "B",
    from: null,
    to: "todo",
    at: approvedAt,
  });
});

it("clears the automatic owner flag after a restart and preserves manual flags", async () => {
  const repo = new SessionRepo(db.db, store);
  checklist.update(projectId, {
    items: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ],
  });
  checklist.link(projectId, "a", session);
  checklist.link(projectId, "b", session);
  const automatic = { reason: "Waiting for your answer", sessionId: session.id, source: "work" };
  checklist.updateItem(projectId, "b", { needsOwner }, session);
  let listener = new ChecklistListener(store, repo, checklist);
  try {
    repo.update(session.id, (entry) => ({ ...entry, status: "waiting" }));
    await Promise.resolve();
    expect(checklist.get(projectId)?.items.map((item) => item.needsOwner)).toEqual([
      automatic,
      needsOwner,
    ]);
    expect(checklist.get(projectId)?.changes).toEqual([
      { itemId: "a", text: "A", from: "todo", to: "todo", at, needsOwner: true },
    ]);
    listener.stop();
    checklist = new ChecklistService(db.db, store);
    listener = new ChecklistListener(store, repo, checklist);
    repo.update(session.id, (entry) => ({ ...entry, status: "idle" }));
    await Promise.resolve();
    expect(checklist.get(projectId)?.items.map((item) => item.needsOwner)).toEqual([
      undefined,
      needsOwner,
    ]);
  } finally {
    listener.stop();
  }
});

it("preserves a manual owner request with the same text as an automatic request", () => {
  checklist.update(projectId, { items: [{ id: "a", text: "A" }] });
  checklist.link(projectId, "a", session);
  checklist.markWork(session, undefined, undefined, true);
  const manual = { reason: WAITING_FOR_OWNER, sessionId: session.id };
  const supplied = { ...manual, source: "work" };
  const { itemId, ...patch } = updateChecklistItem.input.parse({
    itemId: "a",
    needsOwner: supplied,
  });
  expect(patch.needsOwner).toEqual(manual);
  expect(
    updateChecklist.input.parse({ projectId, patch: [{ id: "a", needsOwner: supplied }] }).patch,
  ).toEqual([{ id: "a", needsOwner: manual }]);
  checklist.updateItem(projectId, itemId, patch, session);
  expect(checklist.get(projectId)?.items[0]?.needsOwner).toEqual(manual);
  checklist.markWork(session, undefined, undefined, false);
  expect(checklist.get(projectId)?.items[0]?.needsOwner).toEqual(manual);
});

it("strips supplied work provenance from full checklist replacements", () => {
  const item = { id: "a", text: "A", needsOwner: { ...needsOwner, source: "work" as const } };
  const { items } = updateChecklist.input.parse({ projectId, items: [item] });
  expect(items?.[0]?.needsOwner).toEqual(needsOwner);
  expect(checklist.update(projectId, { items: [item] }).items[0]?.needsOwner).toEqual(needsOwner);
});

const reviewed = (tasks: { id: string; text: string }[]) => ({
  tasks,
  sha: createHash("sha256").update(JSON.stringify(tasks)).digest("hex"),
  reviewRef: "review-1",
});

it("preserves a pending proposal unless its replacement is explicit", () => {
  const { pending } = checklist.update(
    projectId,
    { items: [{ id: "old", text: "Earlier work" }] },
    { requestApproval: true },
  );
  if (!pending) throw new Error("Expected proposal");
  const plan = reviewed([{ id: "a", text: "New work" }]);
  expect(() => checklist.proposePlan(projectId, plan)).toThrow(/replacePending/);
  expect(checklist.get(projectId)?.pending?.id).toBe(pending.id);
  expect(checklist.proposePlan(projectId, plan, true).pending?.plan).toEqual(plan);
});

it("documents and pins the exact Unicode task digest with proposer-supplied provenance", () => {
  expect(proposeChecklistPlan.description).toMatch(/JSON\.stringify.*non-ASCII/);
  expect(proposeChecklistPlan.description).toMatch(/proposer-supplied.*not independently verified/);
  const plan = reviewed([{ id: "a", text: 'Résumé 🚀 with "quotes"' }]);
  const escaped = JSON.stringify(plan.tasks).replace(/é/g, "\\u00e9");
  expect(() =>
    checklist.proposePlan(projectId, {
      ...plan,
      sha: createHash("sha256").update(escaped).digest("hex"),
    }),
  ).toThrow(/does not match/);
  const { pending } = checklist.proposePlan(projectId, plan);
  if (!pending) throw new Error("Expected proposal");
  expect(checklist.get(projectId)?.plan).toBeUndefined();
  checklist.decide(pending.inboxItemId, "resolved");
  expect(checklist.get(projectId)?.plan).toEqual(plan);
});

it("pins the reviewed plan only after owner approval and shows only revised scope in the diff", () => {
  const tasks = [{ id: "a", text: "A" }];
  expect(() =>
    checklist.proposePlan(projectId, { ...reviewed(tasks), sha: "0".repeat(64) }),
  ).toThrow();
  const first = checklist.proposePlan(projectId, reviewed(tasks)).pending;
  if (!first) throw new Error("Expected plan approval");
  expect(checklist.get(projectId)?.items).toEqual([]);
  checklist.decide(first.inboxItemId, "resolved");
  expect(checklist.get(projectId)).toMatchObject({
    plan: reviewed(tasks),
    enforce: true,
    items: [{ id: "a", startPurpose: "A" }],
  });
  expect(() => checklist.setEnforce(projectId, false)).toThrow();
  expect(() => checklist.update(projectId, { patch: [{ id: "b", text: "B" }] })).toThrow();
  expect(() => checklist.expansionForStart(projectId, sampleProject.name, "B")).toThrow();

  const revision = reviewed([...tasks, { id: "b", text: "B" }]);
  const second = checklist.proposePlan(projectId, revision).pending;
  if (!second) throw new Error("Expected revision approval");
  expect(second.diff.map(({ itemId }) => itemId)).toEqual(["b"]);
  expect(checklist.get(projectId)?.plan?.sha).toBe(reviewed(tasks).sha);
  checklist.decide(second.inboxItemId, "resolved");
  expect(checklist.get(projectId)).toMatchObject({
    plan: revision,
    items: [{ id: "a" }, { id: "b", scopeAddition: { approvedAt: at }, startPurpose: "B" }],
  });
});

it("preserves live state when approving a reworded plan task", () => {
  const first = checklist.proposePlan(projectId, reviewed([{ id: "a", text: "A" }])).pending;
  if (!first) throw new Error("Expected plan approval");
  checklist.decide(first.inboxItemId, "resolved");
  expect(checklist.link(projectId, "a", session)).toBe(true);
  const progress = { status: "done", note: "Checked", eta, needsOwner } as const;
  checklist.updateItem(projectId, "a", progress, session);

  const revision = checklist.proposePlan(projectId, reviewed([{ id: "a", text: "A2" }])).pending;
  if (!revision) throw new Error("Expected revision approval");
  checklist.decide(revision.inboxItemId, "resolved");
  expect(checklist.get(projectId)?.items).toMatchObject([
    { id: "a", text: "A2", startPurpose: "A2", sessionIds: [session.id], ...progress },
  ]);
});
