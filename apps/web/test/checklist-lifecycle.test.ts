import {
  type ChecklistChange,
  type ChecklistProposal,
  type InboxItem,
  ProjectChecklist,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  approvalSummary,
  checklistForCard,
  decisionOutcome,
  decisionToast,
  diffLines,
  isApproved,
  proposalDetail,
  proposalLabel,
  sessionLabel,
  sharedLabelIds,
  stateLabel,
} from "@/components/checklist/checklist-lifecycle";
import { changeDetail } from "@/components/checklist/checklist-progress";
import { createMockClient } from "@/lib/api/mock";
import { decideChecklist, placeAdditions } from "@/lib/api/mock/fixtures/checklists";
import { groupInbox } from "@/lib/inbox";

const ts = "2026-11-08T10:00:00.000Z";

function checklist(patch: Partial<ProjectChecklist> = {}): ProjectChecklist {
  return { projectId: "p1", items: [], changes: [], updatedAt: ts, ...patch };
}

function proposal(patch: Partial<ChecklistProposal> = {}): ChecklistProposal {
  return { id: "pr1", kind: "expand", diff: [], inboxItemId: "i1", requestedAt: ts, ...patch };
}

describe("checklist state", () => {
  it("treats an absent state as a draft", () => {
    expect(isApproved(checklist())).toBe(false);
    expect(stateLabel(checklist())).toBe("Draft");
    expect(stateLabel(checklist({ state: "draft" }))).toBe("Draft");
  });

  it("labels an approved list as locked", () => {
    expect(isApproved(checklist({ state: "approved" }))).toBe(true);
    expect(stateLabel(checklist({ state: "approved" }))).toBe("Approved · locked");
  });
});

describe("proposals", () => {
  it("names what the card asks for", () => {
    expect(proposalLabel("approve")).toBe("Approval requested");
    expect(proposalLabel("expand")).toBe("Expansion requested");
  });

  it("prefers the reason, then the start's purpose", () => {
    expect(proposalDetail(proposal({ reason: "Scope grew", startPurpose: "Fix" }))).toBe(
      "Scope grew",
    );
    expect(proposalDetail(proposal({ startPurpose: "Fix the login form" }))).toBe(
      "Fix the login form",
    );
    expect(proposalDetail(proposal({ reason: "  " }))).toBeNull();
  });
});

describe("diffLines", () => {
  it("signs additions, removals, text edits and status changes", () => {
    expect(
      diffLines([
        { itemId: "a", text: "New task", from: null, to: "todo" },
        { itemId: "b", text: "Old task", from: "todo", to: null },
        { itemId: "c", text: "After", textBefore: "Before", from: "doing", to: "doing" },
        { itemId: "d", text: "Tests", from: "todo", to: "done" },
      ]),
    ).toEqual([
      { sign: "+", text: "New task", addition: { status: "todo" } },
      { sign: "−", text: "Old task" },
      { sign: "~", text: "Before → After" },
      { sign: "~", text: "Tests: todo → done" },
    ]);
  });

  it("shows what approving an addition applies from the addition metadata", () => {
    const eta = "2026-11-08T12:00:00.000Z";
    expect(
      diffLines(
        [
          { itemId: "a", text: "Badge", from: null, to: "doing" },
          { itemId: "b", text: "Plain", from: null, to: "todo" },
        ],
        [{ id: "a", eta, needsOwner: { reason: "Pick a style" } }],
      ),
    ).toEqual([
      { sign: "+", text: "Badge", addition: { status: "doing", eta, needsOwner: "Pick a style" } },
      { sign: "+", text: "Plain", addition: { status: "todo" } },
    ]);
  });
});

describe("checklistForCard", () => {
  it("finds the checklist whose pending proposal is the card", () => {
    const lists = [
      checklist({ projectId: "p1", pending: proposal({ inboxItemId: "i1" }) }),
      checklist({ projectId: "p2", pending: proposal({ id: "pr2", inboxItemId: "i2" }) }),
    ];
    expect(checklistForCard(lists, "i2")?.pending.id).toBe("pr2");
    expect(checklistForCard(lists, "gone")).toBeUndefined();
    expect(checklistForCard(undefined, "i1")).toBeUndefined();
  });
});

describe("decisionOutcome", () => {
  const now = Date.parse(ts);
  const card = (patch: Partial<InboxItem>) =>
    ({ status: "resolved", resolution: null, resolvedAt: ts, ...patch }) as InboxItem;

  it("reports the decision the call took", () => {
    expect(decisionOutcome(true, card({}), now)).toBe("approved");
    expect(decisionOutcome(false, card({ status: "dismissed" }), now)).toBe("rejected");
  });

  it("reports a superseded card, whichever button was pressed", () => {
    const superseded = card({ status: "dismissed", resolution: { note: "Superseded" } });
    expect(decisionOutcome(true, superseded, now)).toBe("superseded");
    expect(decisionOutcome(false, superseded, now)).toBe("superseded");
    expect(decisionToast("superseded").tone).toBe("info");
  });

  it("reports a card decided earlier", () => {
    expect(decisionOutcome(false, card({}), now)).toBe("already_approved");
    expect(decisionOutcome(true, card({ status: "dismissed" }), now)).toBe("already_rejected");
    expect(decisionOutcome(true, card({}), now + 60_000)).toBe("already_approved");
    expect(decisionToast("already_approved").title).toBe("Already approved");
  });
});

describe("sessionLabel", () => {
  it("uses the session's title, else a short id", () => {
    const sessions = [
      { id: "s-1234567890", title: "Fix login" },
      { id: "s-untitled-99", title: null },
    ];
    expect(sessionLabel("s-1234567890", sessions)).toBe("Fix login");
    expect(sessionLabel("s-untitled-99", sessions)).toBe("s-untitl");
    expect(sessionLabel("s-unknown-session", undefined)).toBe("s-unknow");
  });
});

describe("changeDetail", () => {
  it("calls a text edit a rewording, not a status change", () => {
    expect(
      changeDetail({ itemId: "c", text: "After", textBefore: "Before", from: "todo", to: "todo" }),
    ).toBe("reworded");
  });
});

describe("inbox", () => {
  it("groups checklist cards with the asks", () => {
    const card = {
      id: "i1",
      kind: "checklist_approval",
      status: "open",
      priority: "normal",
      createdAt: ts,
    } as InboxItem;
    expect(groupInbox([card], "asks")).toEqual([
      { id: "checklist_approval", title: "Checklist changes", items: [card] },
    ]);
  });
});

describe("diff lines for items that share a text", () => {
  it("shows the item's short id only when another item has the same text", () => {
    const items = [
      { id: "item-aaaaaaaa-1", text: "Write tests" },
      { id: "item-bbbbbbbb-2", text: "Write tests" },
      { id: "item-cccccccc-3", text: "Ship" },
    ];
    expect(
      diffLines(
        [
          { itemId: "item-bbbbbbbb-2", text: "Write tests", from: "todo", to: null },
          {
            itemId: "item-cccccccc-3",
            text: "Ship it",
            textBefore: "Ship",
            from: "todo",
            to: "todo",
          },
        ],
        [],
        items,
      ),
    ).toEqual([
      { sign: "−", text: "Write tests", id: "item-bbb" },
      { sign: "~", text: "Ship → Ship it" },
    ]);
    // Two additions with the same text tell themselves apart too.
    const added = diffLines([
      { itemId: "n1", text: "Docs", from: null, to: "todo" },
      { itemId: "n2", text: "Docs", from: null, to: "todo" },
    ]);
    expect(added.map((l) => l.id)).toEqual(["n1", "n2"]);
  });

  it("never leaves two lines reading the same, even when ids share their first 8 characters", () => {
    const two = diffLines([
      { itemId: "item-new-0001", text: "Docs", from: null, to: "todo" },
      { itemId: "item-new-0002", text: "Docs", from: null, to: "todo" },
    ]);
    expect(two.map((l) => l.id)).toEqual(["item-new-0001", "item-new-0002"]);
    const labels = two.map((l) => `${l.text} ${l.id}`);
    expect(new Set(labels).size).toBe(2);
  });

  it("marks an addition and the existing item with the same text, on both lines", () => {
    const diff = [{ itemId: "item-new-1", text: "Write tests", from: null, to: "todo" } as const];
    const items = [
      { id: "item-old-1", text: "Write tests" },
      { id: "ship", text: "Ship" },
    ];
    expect(diffLines(diff, [], items)[0]?.id).toBe("item-new");
    const ids = sharedLabelIds(diff, items);
    expect(ids.get("item-old-1")).toBe("item-old");
    expect(ids.has("ship")).toBe(false);
    expect(ids.get("item-new-1")).not.toBe(ids.get("item-old-1"));
  });

  it("tells apart lines whose rendered labels match, not only their texts", () => {
    // A reword renders "A → B"; an addition whose text is literally "A → B" would read the same.
    const lines = diffLines([
      { itemId: "r1", text: "B", textBefore: "A", from: "todo", to: "todo" },
      { itemId: "n1", text: "A → B", from: null, to: "todo" },
    ]);
    expect(lines.map((l) => l.id)).toEqual(["r1", "n1"]);
  });

  it("tells apart labels that only differ in whitespace the page collapses", () => {
    const diff = [{ itemId: "item-new-1", text: "Fix  cart", from: null, to: "todo" } as const];
    const ids = sharedLabelIds(diff, [{ id: "item-old-1", text: "Fix cart" }]);
    expect(ids.get("item-new-1")).toBe("item-new");
    expect(ids.get("item-old-1")).toBe("item-old");
    // A reword renders "A → B"; an addition with extra spaces around the arrow reads the same.
    const lines = diffLines([
      { itemId: "r1", text: "B", textBefore: "A", from: "todo", to: "todo" },
      { itemId: "n1", text: " A  →\tB ", from: null, to: "todo" },
    ]);
    expect(lines.map((l) => l.id)).toEqual(["r1", "n1"]);
  });
});

describe("approvalSummary", () => {
  it("says approving locks the current items", () => {
    expect(approvalSummary(0, false)).toBe("Approving locks the empty list as it is now.");
    expect(approvalSummary(1, true)).toBe("Approving locks the item below as it is now.");
    expect(approvalSummary(3, false)).toBe("Approving locks these 3 items as they are now.");
    expect(approvalSummary(3, true)).toBe("Approving locks the 3 items below as they are now.");
  });
});

describe("mock checklist cards", () => {
  async function storefront(client: ReturnType<typeof createMockClient>) {
    const snap = await client.getSnapshot();
    return { snap, list: snap.checklists?.find((c) => c.projectId === "p-storefront") };
  }

  it("applies the sample expansion on Approve without adding an inbox card", async () => {
    const client = createMockClient();
    const { snap, list } = await storefront(client);
    const cardId = list?.pending?.inboxItemId ?? "";
    expect(cardId.startsWith("checklist-approval:")).toBe(true);
    const startedAt = Date.now();
    const card = await client.resolveInbox(cardId, { status: "resolved" });
    expect(decisionOutcome(true, card, startedAt)).toBe("approved");
    const after = await storefront(client);
    expect(after.list?.pending).toBeUndefined();
    const badge = after.list?.items.find((i) => i.id === "badge");
    expect(badge?.status).toBe("doing");
    expect(badge?.scopeAddition).toBeDefined();
    expect(badge?.needsOwner).toEqual({ reason: "Pick the badge style", sessionId: "s-checkout" });
    expect(ProjectChecklist.parse(after.list)).toEqual(after.list);
    expect(after.snap.inbox.length).toBe(snap.inbox.length);
    // Placed next to its proposed neighbour, like the server, not appended at the end.
    expect(after.list?.items.map((i) => i.id)).toEqual([
      "checkout",
      "search",
      "a11y",
      "badge",
      "tests",
      "copy",
      "deploy",
    ]);
  });

  it("approves like the server: proposed owner asks without a source, a valid checklist", () => {
    const now = "2026-11-08T11:00:00.000Z";
    const existing = { id: "e1", text: "Existing", status: "doing" as const, updatedAt: ts };
    // 21 diff entries plus the owner-ask change: more than the 20 changes a checklist keeps.
    const diff: ChecklistChange[] = [
      { itemId: "e1", text: "Reworded", textBefore: "Existing", from: "todo", to: "todo" },
      ...Array.from({ length: 20 }, (_, i) => ({
        itemId: `n${i}`,
        text: `New ${i}`,
        from: null,
        to: "todo" as const,
      })),
    ];
    const list = checklist({
      state: "approved",
      items: [existing],
      pending: proposal({
        startPurpose: "Fix the badge",
        diff,
        additionMetadata: [{ id: "n0", needsOwner: { reason: "Pick a style", sessionId: "s1" } }],
      }),
    });
    const after = decideChecklist(list, "resolved", now);
    expect(ProjectChecklist.parse(after)).toEqual(after);
    expect(after.changes).toHaveLength(20);
    const reworded = after.items.find((i) => i.id === "e1");
    expect(reworded).toMatchObject({ text: "Reworded", status: "doing" });
    expect(after.changes[0]).toMatchObject({ itemId: "e1", from: "doing", to: "doing" });
    const added = after.items.find((i) => i.id === "n0");
    expect(added?.needsOwner).toEqual({ reason: "Pick a style", sessionId: "s1" });
    expect(added).toMatchObject({
      startPurpose: "Fix the badge",
      scopeAddition: { approvedAt: now },
    });
    expect(after.changes[2]).toMatchObject({ itemId: "n0", needsOwner: true });
    expect(after.items.some((i) => i.needsOwner && "source" in i.needsOwner)).toBe(false);
  });

  it("applies a proposed status transition on approval, and keeps the live status otherwise", () => {
    const now = "2026-11-08T11:00:00.000Z";
    const items = [
      { id: "a", text: "A", status: "doing" as const, updatedAt: ts },
      { id: "b", text: "B", status: "doing" as const, updatedAt: ts },
    ];
    const diff: ChecklistChange[] = [
      { itemId: "a", text: "A2", textBefore: "A", from: "todo", to: "todo" },
      { itemId: "b", text: "B2", textBefore: "B", from: "doing", to: "done" },
    ];
    const after = decideChecklist(
      checklist({ items, pending: proposal({ diff }) }),
      "resolved",
      now,
    );
    expect(after.items.find((i) => i.id === "a")).toMatchObject({ text: "A2", status: "doing" });
    expect(after.items.find((i) => i.id === "b")).toMatchObject({ text: "B2", status: "done" });
    expect(after.changes[0]).toMatchObject({ itemId: "a", from: "doing", to: "doing" });
    expect(after.changes[1]).toMatchObject({ itemId: "b", from: "doing", to: "done" });
  });

  it("keeps the current order of existing items and places additions by the proposal's order", () => {
    const item = (id: string) => ({ id, text: id, status: "todo" as const, updatedAt: ts });
    const items = ["a", "b", "c", "x", "y", "z"].map(item);
    // Existing items keep a, b, c even though the proposal lists c first; x goes after b,
    // y (no earlier existing neighbour) before c, z (no neighbour in the order) at the end.
    expect(
      placeAdditions(items, new Set(["x", "y", "z"]), ["y", "c", "a", "b", "x"]).map((i) => i.id),
    ).toEqual(["a", "b", "x", "y", "c", "z"]);
  });

  it("drops the proposal on Reject and reports a second decision as superseded", async () => {
    const client = createMockClient();
    const { list } = await storefront(client);
    const cardId = list?.pending?.inboxItemId ?? "";
    const startedAt = Date.now();
    const card = await client.resolveInbox(cardId, { status: "dismissed" });
    expect(decisionOutcome(false, card, startedAt)).toBe("rejected");
    const after = await storefront(client);
    expect(after.list?.pending).toBeUndefined();
    expect(after.list?.items.some((i) => i.id === "badge")).toBe(false);
    const again = await client.resolveInbox(cardId, { status: "resolved" });
    expect(decisionOutcome(true, again, Date.now())).toBe("superseded");
  });

  it("locks a draft on Approve", async () => {
    const client = createMockClient();
    const snap = await client.getSnapshot();
    const billing = snap.checklists?.find((c) => c.projectId === "p-billing");
    expect(billing?.pending?.kind).toBe("approve");
    await client.resolveInbox(billing?.pending?.inboxItemId ?? "", { status: "resolved" });
    const after = (await client.getSnapshot()).checklists?.find((c) => c.projectId === "p-billing");
    expect(after?.state).toBe("approved");
    expect(after?.items).toEqual(billing?.items);
  });
});
