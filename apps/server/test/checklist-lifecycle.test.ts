import { type ChecklistProposal, ProjectChecklist } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sampleProject, sampleSession } from "../../../packages/contracts/test/fixtures";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { ToolRegistry } from "../src/mcp/registry";
import { allTools } from "../src/mcp/tools";
import { updateChecklist } from "../src/mcp/tools/orchestrator/checklist";
import { ChecklistService, WAITING_FOR_OWNER } from "../src/services/checklist/checklist-service";
import { InboxService } from "../src/services/inbox-service";
import { SessionRepo } from "../src/services/sessions/repo";

const projectId = sampleProject.id;
let database: Database;
let store: EventStore;
let service: ChecklistService;

beforeEach(() => {
  database = openDatabase(":memory:");
  store = new EventStore(database.db);
  service = new ChecklistService(database.db, store);
  store.append([{ type: "project.created", sessionId: null, payload: { project: sampleProject } }]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  database.close();
});

function proposal(checklist: ProjectChecklist): ChecklistProposal {
  if (!checklist.pending) throw new Error("Expected a pending checklist proposal");
  return checklist.pending;
}

it("requests owner approval and preserves intervening item updates on expansion", () => {
  service.update(projectId, { items: [{ id: "a", text: "A" }] });
  const approval = service.update(projectId, {}, { requestApproval: true });
  expect(approval.pending?.kind).toBe("approve");
  service.decide(proposal(approval).inboxItemId, "resolved");
  const expansion = service.update(projectId, { patch: [{ id: "a", text: "B" }] });
  expect(expansion.items[0]?.text).toBe("A");
  expect(expansion.pending?.diff).toEqual([
    {
      itemId: "a",
      text: "B",
      textBefore: "A",
      from: "todo",
      to: "todo",
      at: expansion.pending?.requestedAt,
    },
  ]);
  const session = { ...sampleSession, projectId, status: "idle" as const };
  service.link(projectId, "a", session);
  service.updateItem(projectId, "a", { status: "done", note: "Verified" }, session);
  service.decide(proposal(expansion).inboxItemId, "resolved");
  const approved = ProjectChecklist.parse(service.get(projectId));
  expect(approved.items[0]).toMatchObject({
    text: "B",
    status: "done",
    note: "Verified",
    sessionIds: [session.id],
  });
  expect(approved.changes).toEqual([
    { itemId: "a", text: "B", textBefore: "A", from: "done", to: "done", at: approved.updatedAt },
  ]);
});

it("supersedes a draft approval after a structural edit", () => {
  service.update(projectId, { items: [{ id: "a", text: "A" }] });
  const approval = proposal(service.update(projectId, {}, { requestApproval: true }));
  service.update(projectId, { patch: [{ id: "a", text: "B" }] });
  expect(service.decide(approval.inboxItemId, "resolved").status).toBe("dismissed");
  expect(service.get(projectId)?.state).toBe("draft");
});

it("stores the full diff, and rejection preserves the approved list", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: `old-${i}`, text: "Old" }));
  service.update(projectId, { items });
  const approval = proposal(service.update(projectId, {}, { requestApproval: true }));
  service.decide(approval.inboxItemId, "resolved");
  const pending = proposal(
    service.update(projectId, {
      items: items.map(({ id }) => ({ id: `new-${id}`, text: "New" })),
    }),
  );
  expect(pending.diff).toHaveLength(400);
  service.decide(pending.inboxItemId, "dismissed");
  const checklist = service.get(projectId);
  expect(checklist?.items[0]?.id).toBe("old-0");
  expect(checklist?.pending).toBeUndefined();
  expect(checklist?.changes.length).toBeLessThanOrEqual(20);
});

it("scopes item edits in MCP and exposes no owner decision tool", async () => {
  const agent = { ...sampleSession, projectId, status: "idle" as const };
  const pm = { ...agent, id: "pm", role: "pm" as const };
  const sessions = new Map([
    [agent.id, agent],
    [pm.id, pm],
  ]);
  const tools = new ToolRegistry(
    allTools.filter((tool) =>
      tool.roles.includes("pm") || tool.roles.includes("agent")
        ? !tool.isAvailable ||
          tool.name === "update_checklist_item" ||
          tool.name === "read_checklist"
        : true,
    ),
    {
      checklist: service,
      sessionRepo: { find: (id: string) => ({ session: sessions.get(id) }) },
    } as never,
  );
  const caller = { caller: "mcp" as const, projectId, signal: new AbortController().signal };
  const agentCaller = { ...caller, sessionId: agent.id, role: agent.role };
  const pmCaller = { ...caller, sessionId: pm.id, role: pm.role };
  const edit = allTools.find((tool) => tool.name === "update_checklist_item");
  expect(edit?.isAvailable?.({ checklist: service } as never, pmCaller)).toBe(false);
  const draft = service.update(
    projectId,
    { items: [{ id: "a", text: "A" }] },
    { requestApproval: true },
  );
  const card = proposal(draft).inboxItemId;
  expect(
    await tools.call("update_checklist_item", { itemId: "a", status: "doing" }, agentCaller),
  ).toMatchObject({ isError: true, text: expect.stringContaining("not linked") });
  expect(
    await tools.call("update_checklist_item", { itemId: "a", text: "B", status: "done" }, pmCaller),
  ).toMatchObject({ isError: true });
  expect(
    await tools.call("update_checklist_item", { itemId: "a", note: "Reviewing" }, pmCaller),
  ).toMatchObject({ isError: false });
  service.link(projectId, "a", agent);
  expect(
    await tools.call("update_checklist_item", { itemId: "a", status: "doing" }, agentCaller),
  ).toMatchObject({ isError: false });
  for (const name of ["resolve_inbox", "set_checklist_enforce"]) {
    expect(await tools.call(name, { id: card, status: "resolved" }, pmCaller)).toMatchObject({
      isError: true,
      text: `Unknown tool: ${name}`,
    });
  }
  expect(service.get(projectId)?.pending?.inboxItemId).toBe(card);
});

it("keeps a start expansion open until the orchestrator explicitly replaces it", async () => {
  const notify = vi.fn();
  service = new ChecklistService(database.db, store, undefined, notify);
  const approval = proposal(
    service.update(projectId, { items: [{ id: "a", text: "A" }] }, { requestApproval: true }),
  );
  service.decide(approval.inboxItemId, "resolved");
  const itemId = service.expansionForStart(projectId, sampleProject.name, "Extra");
  const pending = service.get(projectId)?.pending;
  if (!pending) throw new Error("Expected a start expansion card");
  const open = pending.inboxItemId;
  expect(service.expansionForStart(projectId, sampleProject.name, "Extra")).toBe(itemId);
  expect(() => service.expansionForStart(projectId, sampleProject.name, "Different")).toThrow(
    new RegExp(`card ${open}.*wait for the owner`, "i"),
  );
  const tools = new ToolRegistry(
    allTools.filter(({ name }) => name === "update_checklist"),
    {
      checklist: service,
    } as never,
  );
  const caller = {
    role: "orchestrator" as const,
    caller: "mcp" as const,
    projectId: null,
    sessionId: "orchestrator",
    signal: new AbortController().signal,
  };
  const edit = { projectId, patch: [{ id: "a", text: "Revised" }] };
  expect(await tools.call("update_checklist", edit, caller)).toMatchObject({
    isError: true,
    text: expect.stringContaining(open),
  });
  expect(service.get(projectId)?.pending?.inboxItemId).toBe(open);
  expect(notify).not.toHaveBeenCalled();
  expect(
    await tools.call("update_checklist", { ...edit, replacePending: true }, caller),
  ).toMatchObject({
    isError: false,
  });
  expect(service.get(projectId)?.pending?.inboxItemId).not.toBe(open);
  expect(service.decide(open, "resolved").status).toBe("dismissed");
  expect(notify).toHaveBeenCalledExactlyOnceWith(projectId, expect.stringContaining("superseded"));
  expect(() => service.expansionForStart(projectId, sampleProject.name, "Extra")).toThrow(
    /wait for the owner/i,
  );
});

it("preserves an intervening reorder while inserting approved additions", () => {
  const a = { id: "a", text: "A" };
  const b = { id: "b", text: "B" };
  const c = { id: "c", text: "C" };
  const ids = () => service.get(projectId)?.items.map(({ id }) => id);
  const approval = proposal(
    service.update(projectId, { items: [a, b] }, { requestApproval: true }),
  );
  service.decide(approval.inboxItemId, "resolved");
  expect(service.update(projectId, { items: [b, a] }).pending).toBeUndefined();
  expect(ids()).toEqual(["b", "a"]);
  const expansion = proposal(service.update(projectId, { items: [b, c, a] }));
  expect(expansion.order).toEqual(["b", "c", "a"]);
  expect(ids()).toEqual(["b", "a"]);
  service.update(projectId, { items: [a, b] });
  service.updateItem(projectId, "b", { status: "done" }, { ...sampleSession, role: "pm" });
  service.decide(expansion.inboxItemId, "resolved");
  expect(ids()).toEqual(["a", "b", "c"]);
  expect(service.get(projectId)?.items[1]?.status).toBe("done");
});

it("hands an automatic owner marker to another waiting linked session", () => {
  const first = { ...sampleSession, projectId, status: "waiting" as const };
  const second = { ...first, id: "second" };
  store.append(
    [first, second].map((session) => ({
      type: "session.created",
      sessionId: session.id,
      payload: { session },
    })),
  );
  service.update(projectId, { items: [{ id: "a", text: "A" }] });
  service.link(projectId, "a", first);
  service.link(projectId, "a", second);
  const repo = new SessionRepo(database.db, store);
  service.markWork(first, undefined, undefined, true);
  repo.update(first.id, (entry) => ({ ...entry, status: "running" }));
  service.markWork({ ...first, status: "running" }, undefined, undefined, false);
  expect(service.get(projectId)?.items[0]?.needsOwner).toEqual({
    reason: WAITING_FOR_OWNER,
    sessionId: second.id,
    source: "work",
  });
  repo.update(second.id, (entry) => ({ ...entry, status: "running" }));
  service.markWork({ ...second, status: "running" }, undefined, undefined, false);
  expect(service.get(projectId)?.items[0]?.needsOwner).toBeUndefined();
});

it("marks an item when a waiting session is linked", () => {
  const session = { ...sampleSession, projectId, status: "waiting" as const };
  service.update(projectId, { items: [{ id: "a", text: "A" }] });
  service.link(projectId, "a", session);
  expect(service.get(projectId)?.items[0]?.needsOwner).toEqual({
    reason: WAITING_FOR_OWNER,
    sessionId: session.id,
    source: "work",
  });
});

it("clears a pending proposal when its card was already closed", () => {
  const pending = proposal(
    service.update(projectId, { items: [{ id: "a", text: "A" }] }, { requestApproval: true }),
  );
  const inbox = new InboxService(database.db, store, () => async () => {});
  const card = inbox.put({ ...inbox.get(pending.inboxItemId), status: "dismissed" });
  expect(service.decide(card.id, "resolved")).toEqual(card);
  expect(service.get(projectId)?.pending).toBeUndefined();
  expect(service.get(projectId)?.state).toBe("draft");
});

it.each(["\r", "\n"])("rejects multiline checklist edit inputs (%j)", (line) => {
  expect(
    updateChecklist.input.safeParse({ projectId, items: [{ text: `Task${line}` }] }).success,
  ).toBe(false);
  expect(
    updateChecklist.input.safeParse({ projectId, requestApproval: true, reason: `Reason${line}` })
      .success,
  ).toBe(false);
});
