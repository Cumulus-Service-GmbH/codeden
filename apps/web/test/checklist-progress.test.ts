import type { ChecklistItem, Project, ProjectChecklist } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  changeLine,
  overallProgress,
  progressLabel,
  progressOf,
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
    expect(progressLabel(p)).toBe("1/3 · 33%");
  });

  it("is zero for an empty list and sums across projects", () => {
    expect(progressOf([]).percent).toBe(0);
    const all = overallProgress([
      checklist("p1", [item("a", "done")]),
      checklist("p2", [item("b", "done"), item("c", "blocked")]),
    ]);
    expect(all).toMatchObject({ done: 2, blocked: 1, total: 3, percent: 66 });
  });

  it("summarises the changes in one line", () => {
    expect(changeLine([])).toBe("");
    expect(
      changeLine([
        { itemId: "a", text: "Tests", from: "doing", to: "done" },
        { itemId: "b", text: "Docs", from: null, to: "todo" },
        { itemId: "c", text: "Old", from: "todo", to: null },
        { itemId: "d", text: "More", from: null, to: "todo" },
      ]),
    ).toBe("Tests → done · +2 added · 1 removed");
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
    expect(added.checklists.map((c) => c.projectId)).toEqual(["p1", "p2"]);
  });
});
