import type { ChecklistItem, Project, ProjectChecklist } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  changeDetail,
  changeTime,
  groupChanges,
  localTime,
  needsOwnerCount,
  overallProgress,
  pinnedChecklistFits,
  pinnedChecklistMode,
  progressLabel,
  progressOf,
  STATUS_MARKER,
  statusLine,
  visibleChecklists,
} from "@/components/checklist/checklist-progress";
import { applyDomainEvent } from "@/lib/snapshot-reducer";
import { snapshot } from "./attention-fixtures";

const ts = "2026-11-08T10:00:00.000Z";

function item(id: string, status: ChecklistItem["status"]): ChecklistItem {
  return { id, text: `Item ${id}`, status, updatedAt: ts };
}

function checklist(projectId: string, items: ChecklistItem[]): ProjectChecklist {
  return { projectId, items, changes: [], updatedAt: ts };
}

describe("checklist progress", () => {
  it("counts statuses and rounds the percent down", () => {
    const p = progressOf([item("a", "done"), item("b", "doing"), item("c", "todo")]);
    expect(p).toEqual({ done: 1, doing: 1, blocked: 0, total: 3, percent: 33 });
    expect(
      progressOf([...Array(199)].map((_, i) => item(`${i}`, "done")).concat(item("x", "todo")))
        .percent,
    ).toBe(99);
    expect(progressLabel(p)).toBe("1/3 (33%)");
    expect(progressLabel(progressOf([item("a", "done"), item("b", "done")]))).toBe("2/2 (100%)");
  });

  it("is zero for an empty list and sums across projects", () => {
    expect(progressOf([]).percent).toBe(0);
    const all = overallProgress([
      checklist("p1", [item("a", "done")]),
      checklist("p2", [item("b", "done"), item("c", "blocked")]),
    ]);
    expect(all).toMatchObject({ done: 2, blocked: 1, total: 3, percent: 66 });
  });

  it("marks each status and counts the items that need the owner", () => {
    expect(Object.values(STATUS_MARKER).map((m) => m.text)).toEqual(["[x]", "[~]", "[ ]", "[!]"]);
    expect(STATUS_MARKER.doing.label).toBe("in progress");
    expect(
      needsOwnerCount([
        { ...item("a", "doing"), needsOwner: { reason: "Card", sessionId: "s1" } },
        { ...item("b", "blocked"), needsOwner: { reason: "Decide" } },
        item("c", "blocked"),
      ]),
    ).toBe(2);
  });

  it("groups the changes as ticked, added, newly blocked and other", () => {
    expect(groupChanges([])).toEqual([]);
    const groups = groupChanges([
      { itemId: "c", text: "Old", from: "todo", to: null },
      { itemId: "a", text: "Tests", from: "doing", to: "done" },
      { itemId: "b", text: "Docs", from: null, to: "todo" },
      { itemId: "d", text: "Deploy", from: "doing", to: "blocked" },
      { itemId: "e", text: "Card", from: "doing", to: "doing", needsOwner: true },
      { itemId: "f", text: "Born done", from: null, to: "done" },
      { itemId: "g", text: "Born blocked", from: null, to: "blocked" },
    ]);
    expect(groups.map((g) => [g.label, g.changes.map((c) => c.itemId)])).toEqual([
      ["Ticked", ["a", "f"]],
      ["Added", ["b", "g"]],
      ["Newly blocked", ["d", "e"]],
      ["Other changes", ["c"]],
    ]);
  });

  it("files a rewording of a done or blocked item under other changes", () => {
    const groups = groupChanges([
      { itemId: "a", text: "New", textBefore: "Old", from: "done", to: "done" },
      { itemId: "b", text: "New", textBefore: "Old", from: "blocked", to: "blocked" },
      { itemId: "c", text: "Ask", from: "blocked", to: "blocked", needsOwner: true },
    ]);
    expect(groups.map((g) => [g.label, g.changes.map((c) => c.itemId)])).toEqual([
      ["Newly blocked", ["c"]],
      ["Other changes", ["a", "b"]],
    ]);
    expect(changeDetail(groups[1]?.changes[0] as never)).toBe("reworded");
  });

  it("gives every item a status line: its note, else the status in words", () => {
    expect(statusLine({ status: "todo" })).toBe("Not started");
    expect(statusLine({ status: "doing" })).toBe("In progress");
    expect(statusLine({ status: "done", note: "  " })).toBe("Done");
    expect(statusLine({ status: "blocked", note: "Waiting on QA" })).toBe("Waiting on QA");
  });

  it("turns a pinned checklist into an overlay when the main column would drop under 480 px", () => {
    // 1280 px with the sidebar (268 + 1) and the session panel (460 + 1) open leaves 250 px.
    expect(pinnedChecklistFits(1280, { left: 269, right: 461 }, 300)).toBe(false);
    expect(pinnedChecklistFits(1280, { left: 269, right: 0 }, 300)).toBe(true);
    expect(pinnedChecklistFits(1280, { left: 269, right: 461 }, 44)).toBe(true);
    expect(pinnedChecklistFits(1049, { left: 269, right: 0 }, 300)).toBe(true);
    expect(pinnedChecklistFits(1048, { left: 269, right: 0 }, 300)).toBe(false);
  });

  it("keeps a pinned checklist inline as its rail when the full column doesn't fit", () => {
    const W = { full: 300, rail: 44 };
    // 1280 px with the sidebar and the session panel open: the rail leaves 506 px of main.
    expect(pinnedChecklistMode(1280, { left: 269, right: 461 }, W)).toBe("rail");
    expect(1280 - 269 - 461 - 44).toBeGreaterThanOrEqual(480);
    expect(pinnedChecklistMode(1280, { left: 269, right: 0 }, W)).toBe("full");
    expect(pinnedChecklistMode(1049, { left: 269, right: 0 }, W)).toBe("full");
    expect(pinnedChecklistMode(1048, { left: 269, right: 0 }, W)).toBe("rail");
  });

  it("renders no inline checklist when even the rail would leave main under 480 px", () => {
    const W = { full: 300, rail: 44 };
    // 269 + 461 + 44 + 480 = 1254: the rail still fits at 1254 px, not at 1253.
    expect(pinnedChecklistMode(1254, { left: 269, right: 461 }, W)).toBe("rail");
    expect(pinnedChecklistMode(1253, { left: 269, right: 461 }, W)).toBe("none");
    // Without the session panel: 269 + 44 + 480 = 793.
    expect(pinnedChecklistMode(793, { left: 269, right: 0 }, W)).toBe("rail");
    expect(pinnedChecklistMode(792, { left: 269, right: 0 }, W)).toBe("none");
    expect(pinnedChecklistMode(524, { left: 0, right: 0 }, W)).toBe("rail");
    expect(pinnedChecklistMode(523, { left: 0, right: 0 }, W)).toBe("none");
  });

  it("describes a change and falls back to the update's time", () => {
    const list = checklist("p1", []);
    const ticked = { itemId: "a", text: "T", from: "doing", to: "done" } as const;
    expect(changeDetail(ticked)).toBe("doing → done");
    expect(changeDetail({ ...ticked, from: null })).toBe("added");
    expect(changeDetail({ ...ticked, to: null })).toBe("removed");
    expect(changeDetail({ ...ticked, from: "doing", to: "doing", needsOwner: true })).toBe(
      "needs you",
    );
    expect(changeTime(ticked, list)).toBe(ts);
    expect(changeTime({ ...ticked, at: "2026-11-08T09:00:00.000Z" }, list)).toBe(
      "2026-11-08T09:00:00.000Z",
    );
  });

  it("shows today's times alone and other days with a short date, in the given zone", () => {
    const now = new Date("2026-11-08T22:30:00.000Z");
    const opts = { now, locale: "en-US", timeZone: "UTC" };
    expect(localTime("2026-11-08T14:05:00.000Z", opts)).toBe("02:05 PM");
    expect(localTime("2026-11-09T09:00:00.000Z", opts)).toBe("Nov 9, 09:00 AM");
    // 22:30 UTC is already the next day in Tokyo, so 14:05 UTC the same day is yesterday there.
    expect(localTime("2026-11-08T14:05:00.000Z", { ...opts, timeZone: "Asia/Tokyo" })).toBe(
      "Nov 8, 11:05 PM",
    );
    expect(localTime("2026-11-08T23:00:00.000Z", { ...opts, timeZone: "Asia/Tokyo" })).toBe(
      "08:00 AM",
    );
    expect(localTime("not a date", opts)).toBe("");
  });

  it("shows active projects with items, in project order", () => {
    const projects = [
      { id: "p2", archivedAt: null },
      { id: "p1", archivedAt: null },
    ] as Project[];
    const lists = [
      checklist("p1", [item("a", "todo")]),
      checklist("p2", [item("b", "todo")]),
      checklist("p3", [item("c", "todo")]),
    ];
    expect(visibleChecklists(projects, lists).map((v) => v.project.id)).toEqual(["p2", "p1"]);
    expect(visibleChecklists(projects, [checklist("p1", [])])).toEqual([]);
    expect(visibleChecklists(projects, undefined)).toEqual([]);
  });

  it("keeps an empty checklist visible once approved or with a pending proposal", () => {
    const projects = [
      { id: "p1", archivedAt: null },
      { id: "p2", archivedAt: null },
    ] as Project[];
    const pending = {
      id: "pr1",
      kind: "approve" as const,
      diff: [],
      inboxItemId: "i1",
      requestedAt: ts,
    };
    const lists = [
      { ...checklist("p1", []), state: "approved" as const },
      { ...checklist("p2", []), pending },
    ];
    expect(visibleChecklists(projects, lists).map((v) => v.project.id)).toEqual(["p1", "p2"]);
  });

  it("keeps a draft visible after its last item was removed, so the removal shows", () => {
    const projects = [{ id: "p1", archivedAt: null }] as Project[];
    const removed = {
      ...checklist("p1", []),
      changes: [{ itemId: "a", text: "Item a", from: "todo" as const, to: null }],
    };
    expect(visibleChecklists(projects, [removed]).map((v) => v.project.id)).toEqual(["p1"]);
    expect(visibleChecklists(projects, [checklist("p1", [])])).toEqual([]);
  });

  it("upserts a project's checklist from the live event", () => {
    const base = { ...snapshot(1, []), checklists: [checklist("p1", [item("a", "todo")])] };
    const next = checklist("p1", [item("a", "done")]);
    const applied = applyDomainEvent(base, {
      seq: 2,
      sessionId: null,
      ts,
      type: "checklist.updated",
      payload: { checklist: next },
    });
    expect(applied.checklists).toEqual([next]);
    const added = applyDomainEvent(applied, {
      seq: 3,
      sessionId: null,
      ts,
      type: "checklist.updated",
      payload: { checklist: checklist("p2", []) },
    });
    expect((added.checklists ?? []).map((c) => c.projectId)).toEqual(["p1", "p2"]);
  });
});
