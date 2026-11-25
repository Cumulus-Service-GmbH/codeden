import { createHash } from "node:crypto";
import { type ChecklistProposal, ProjectChecklist } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sampleProject, sampleSession } from "../../../packages/contracts/test/fixtures";
import { type Database, openDatabase } from "../src/db/client";
import { projectChecklists } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { ToolRegistry } from "../src/mcp/registry";
import { allTools } from "../src/mcp/tools";
import { updateChecklistItem } from "../src/mcp/tools/checklist";
import { updateChecklist } from "../src/mcp/tools/orchestrator/checklist";
import {
  ChecklistService,
  formatChecklist,
  WAITING_FOR_OWNER,
} from "../src/services/checklist/checklist-service";
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
  expect(edit?.isAvailable?.({ checklist: service } as never, agentCaller, "agent")).toBe(false);
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
    await tools.call(
      "update_checklist_item",
      { itemId: "a", text: "B", status: "done" },
      agentCaller,
    ),
  ).toMatchObject({ isError: true });
  const beforeProgress = store.headSeq();
  expect(
    await tools.call("update_checklist_item", { itemId: "a", status: "done" }, pmCaller),
  ).toMatchObject({ isError: false });
  expect(store.listAfter(beforeProgress).map(({ type }) => type)).toEqual(["checklist.updated"]);
  store.append([{ type: "session.created", sessionId: agent.id, payload: { session: agent } }]);
  expect(
    await tools.call("update_checklist_item", { itemId: "a", workKeys: [agent.workKey] }, pmCaller),
  ).toMatchObject({ isError: false });
  expect(
    await tools.call(
      "update_checklist_item",
      { itemId: "a", note: "Work-key progress" },
      agentCaller,
    ),
  ).toMatchObject({ isError: false });
  service.link(projectId, "a", agent);
  expect(
    await tools.call("update_checklist_item", { itemId: "a", text: "B" }, agentCaller),
  ).toMatchObject({ isError: true });
  expect(
    await tools.call("update_checklist_item", { itemId: "a", sessionIds: [] }, agentCaller),
  ).toMatchObject({ isError: true, text: expect.stringContaining("Only the project manager") });
  expect(
    await tools.call("update_checklist_item", { itemId: "a", workKeys: ["issue:42"] }, pmCaller),
  ).toMatchObject({ isError: false });
  expect(service.get(projectId)?.items[0]?.workKeys).toEqual(["issue:42"]);

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

function pmChecklistTools() {
  const session = { ...sampleSession, projectId, role: "pm" as const };
  const tools = new ToolRegistry([updateChecklistItem], {
    checklist: service,
    sessionRepo: { find: () => ({ session }) },
  } as never);
  const caller = {
    caller: "mcp" as const,
    projectId,
    sessionId: session.id,
    role: session.role,
    signal: new AbortController().signal,
  };
  return { tools, caller };
}

it("shows the saved PM progress note and updates task text only when explicit", async () => {
  const { tools, caller } = pmChecklistTools();
  service.update(projectId, { items: [{ id: "a", text: "A" }] });
  const note = "Reviewing\nresults";
  expect(
    await tools.call("update_checklist_item", { itemId: "a", note, status: "doing" }, caller),
  ).toMatchObject({ isError: false, text: expect.stringContaining(JSON.stringify(note)) });
  expect(service.get(projectId)?.items[0]).toMatchObject({
    text: "A",
    note,
    status: "doing",
  });
  expect(
    await tools.call("update_checklist_item", { itemId: "a", text: "B", note: "Checked" }, caller),
  ).toMatchObject({ isError: false });
  expect(service.get(projectId)?.items[0]).toMatchObject({ text: "B", note: "Checked" });
});

it.each(["pending", "pinned"])("accepts PM progress on a %s reviewed plan", async (state) => {
  const { tools, caller } = pmChecklistTools();
  const tasks = [{ id: "a", text: "A" }];
  service.update(projectId, { items: tasks });
  const reviewed = service.proposePlan(projectId, {
    tasks,
    sha: createHash("sha256").update(JSON.stringify(tasks)).digest("hex"),
    reviewRef: "review-1",
  });
  if (state === "pinned") service.decide(proposal(reviewed).inboxItemId, "resolved");
  const before = ProjectChecklist.parse(service.get(projectId));
  expect(
    await tools.call(
      "update_checklist_item",
      { itemId: "a", note: "Reviewed results", status: "done" },
      caller,
    ),
  ).toMatchObject({ isError: false });
  const after = ProjectChecklist.parse(service.get(projectId));
  expect(after.items[0]).toMatchObject({ text: "A", note: "Reviewed results", status: "done" });
  expect(after.plan).toEqual(before.plan);
  expect(after.pending).toEqual(before.pending);
  expect(
    await tools.call("update_checklist_item", { itemId: "a", text: "New scope" }, caller),
  ).toMatchObject({ isError: true, text: expect.stringContaining("reviewed plan revision") });
  expect(service.get(projectId)).toEqual(after);
});

it.each([
  { itemId: "a", text: "Renamed" },
  { itemId: "b", text: "Added" },
])("rejects a PM structural edit of $itemId while draft approval is open", async (edit) => {
  const { tools, caller } = pmChecklistTools();
  const before = service.update(
    projectId,
    { items: [{ id: "a", text: "A" }] },
    { requestApproval: true },
  );
  const { inboxItemId } = proposal(before);
  const inbox = new InboxService(database.db, store, () => async () => {});

  expect(await tools.call("update_checklist_item", edit, caller)).toEqual({
    isError: true,
    text: `Checklist card ${inboxItemId} is already open. Wait for the owner to decide.`,
  });
  expect(service.get(projectId)).toEqual(before);
  expect(inbox.get(inboxItemId).status).toBe("open");

  expect(
    await tools.call("update_checklist_item", { itemId: "a", text: "A", status: "doing" }, caller),
  ).toMatchObject({ isError: false });
  expect(service.get(projectId)?.items[0]?.status).toBe("doing");
  expect(service.get(projectId)?.pending).toEqual(before.pending);
  expect(inbox.get(inboxItemId).status).toBe("open");
});

it("creates the first checklist item and uses owner approval for additions to approved lists", async () => {
  const { tools, caller } = pmChecklistTools();
  expect(
    await tools.call("update_checklist_item", { itemId: "a", text: "A" }, caller),
  ).toMatchObject({
    isError: false,
  });
  expect(service.get(projectId)?.items[0]).toMatchObject({ id: "a", text: "A", status: "todo" });
  const approval = proposal(service.update(projectId, {}, { requestApproval: true }));
  service.decide(approval.inboxItemId, "resolved");
  expect(
    await tools.call("update_checklist_item", { itemId: "b", text: "B", note: "Ready" }, caller),
  ).toMatchObject({ isError: false, text: expect.stringContaining("owner card") });
  const checklist = ProjectChecklist.parse(service.get(projectId));
  expect(checklist.items).toHaveLength(1);
  service.decide(proposal(checklist).inboxItemId, "resolved");
  expect(service.get(projectId)?.items[1]).toMatchObject({ id: "b", text: "B", note: "Ready" });
});

it("refuses PM checklist writes outside the session project", async () => {
  const { tools, caller } = pmChecklistTools();
  const other = { ...sampleProject, id: "other-project", slug: "other-project", path: "/other" };
  store.append([{ type: "project.created", sessionId: null, payload: { project: other } }]);
  const original = service.update(other.id, { items: [{ id: "a", text: "Private" }] });
  expect(
    await tools.call(
      "update_checklist_item",
      { itemId: "a", note: "Changed" },
      {
        ...caller,
        projectId: other.id,
      },
    ),
  ).toMatchObject({ isError: true, text: "This tool needs a session in your project" });
  expect(
    await tools.call(
      "update_checklist_item",
      { itemId: "b", text: "New", projectId: other.id },
      caller,
    ),
  ).toMatchObject({ isError: true });
  expect(service.get(other.id)).toEqual(original);
  expect(service.get(projectId)).toBeUndefined();
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
it("lists running checklist items first and preserves the order within each group", () => {
  const first = { ...sampleSession, projectId, status: "running" as const };
  const second = { ...first, id: "second-running", workKey: "issue:2" };
  for (const session of [first, second]) {
    store.append([{ type: "session.created", sessionId: session.id, payload: { session } }]);
  }
  service.update(projectId, {
    items: ["todo-a", "running-a", "todo-b", "running-b"].map((id) => ({ id, text: id })),
  });
  expect(service.link(projectId, "running-a", first)).toBe(true);
  expect(service.link(projectId, "running-b", second)).toBe(true);

  const expected = ["running-a", "running-b", "todo-a", "todo-b"];
  expect(service.list()[0]?.items.map(({ id }) => id)).toEqual(expected);
  expect(service.get(projectId)?.items.map(({ id }) => id)).toEqual(expected);
  const planOutput = formatChecklist(service.get(projectId, "plan"));
  expect(planOutput.indexOf("(todo-a)")).toBeLessThan(planOutput.indexOf("(running-a)"));
  expect(
    database.db
      .select()
      .from(projectChecklists)
      .get()
      ?.checklist.items.map(({ id }) => id),
  ).toEqual(["todo-a", "running-a", "todo-b", "running-b"]);
});

it.each(["resolved", "dismissed"] as const)(
  "clears needsOwner when the linked card is %s",
  async (status) => {
    const inbox = new InboxService(database.db, store, () => async () => {});
    const pending = proposal(
      service.update(
        projectId,
        {
          items: [
            { id: "a", text: "A" },
            { id: "b", text: "B" },
          ],
        },
        { requestApproval: true },
      ),
    );
    const card = inbox.put({ ...inbox.get(pending.inboxItemId), id: "decision" });
    const needsOwner = { reason: "Choose a direction", inboxItemId: card.id };
    const otherNeed = { ...needsOwner, inboxItemId: pending.inboxItemId };
    service.update(projectId, {
      items: [
        { id: "a", text: "A", needsOwner },
        { id: "b", text: "B", needsOwner: otherNeed },
      ],
    });
    expect
      .soft(service.get(projectId)?.items.map((item) => item.needsOwner))
      .toEqual([needsOwner, otherNeed]);

    const before = store.headSeq();
    await inbox.resolve(card.id, { status });
    expect(service.get(projectId)?.items.map((item) => item.needsOwner)).toEqual([
      undefined,
      otherNeed,
    ]);
    expect(store.listAfter(before).map((event) => event.type)).toEqual([
      "inbox.updated",
      "checklist.updated",
    ]);
  },
);

it("lets the orchestrator link, report install health, and unlink through the checklist tool", async () => {
  const session = { ...sampleSession, projectId, status: "running" as const };
  store.append([{ type: "session.created", sessionId: session.id, payload: { session } }]);
  service.update(projectId, { items: [{ id: "lane", text: "Build" }] });
  const tools = new ToolRegistry([updateChecklist], { checklist: service } as never);
  const caller = {
    role: "orchestrator" as const,
    caller: "mcp" as const,
    projectId: null,
    sessionId: "orchestrator",
    signal: new AbortController().signal,
  };
  const edit = (payload: Record<string, unknown>) =>
    tools.call("update_checklist", { projectId, ...payload }, caller);
  const before = store.headSeq();
  expect(await edit({ patch: [{ id: "lane", sessionIds: [session.id] }] })).toMatchObject({
    isError: false,
  });
  expect(service.get(projectId)?.items[0]?.status).toBe("doing");
  expect(store.listAfter(before).map(({ type }) => type)).toEqual(["checklist.updated"]);
  expect(await edit({ installHealthySessionId: session.id })).toMatchObject({ isError: false });
  expect(service.get(projectId)?.items[0]?.status).toBe("done");
  expect(await edit({ patch: [{ id: "lane", sessionIds: [] }] })).toMatchObject({ isError: false });
  expect(service.get(projectId)?.items[0]?.sessionIds).toBeUndefined();
});

it("lets a retry supersede an earlier automatic attempt while keeping explicit links", () => {
  const first = {
    ...sampleSession,
    projectId,
    status: "idle" as const,
    result: {
      outcome: "failed" as const,
      summary: "First attempt failed",
      at: sampleSession.updatedAt,
    },
  };
  const retry = { ...first, id: "retry", status: "completed" as const, result: null };
  store.append(
    [first, retry].map((session) => ({
      type: "session.created",
      sessionId: session.id,
      payload: { session },
    })),
  );
  service.update(projectId, { items: [{ id: "lane", text: "Build" }] });
  service.link(projectId, "lane", first);
  expect(service.get(projectId)?.items[0]?.status).toBe("blocked");
  service.link(projectId, "lane", retry);
  expect(service.get(projectId)?.items[0]?.status).toBe("done");
  service.update(projectId, { patch: [{ id: "lane", sessionIds: [first.id, retry.id] }] });
  expect(service.get(projectId)?.items[0]?.status).toBe("blocked");
});
