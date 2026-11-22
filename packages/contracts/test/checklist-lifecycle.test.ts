import { expect, it } from "vitest";
import { inboxWaitsOnYou, ProjectChecklist, SetChecklistEnforceRequest } from "../src";

it("round-trips v1 checklists and optional lifecycle fields", () => {
  const updatedAt = "2026-11-22T10:00:00Z";
  const item = { id: "item", text: "Task", status: "todo", updatedAt };
  const v1 = { projectId: "project", items: [item], changes: [], updatedAt };
  expect(ProjectChecklist.parse(v1)).toEqual(v1);
  const v2 = {
    ...v1,
    state: "approved",
    enforce: true,
    approvedAt: updatedAt,
    items: [{ ...item, note: "Working", sessionIds: ["session"] }],
    pending: {
      id: "proposal",
      kind: "expand",
      diff: [{ itemId: "item", textBefore: "Task", text: "New task", from: "todo", to: "todo" }],
      inboxItemId: "card",
      requestedAt: updatedAt,
      order: ["item"],
    },
  };
  expect(ProjectChecklist.parse(JSON.parse(JSON.stringify(v2)))).toEqual(v2);
  expect(SetChecklistEnforceRequest.parse({ enforce: false })).toEqual({ enforce: false });
  expect(
    inboxWaitsOnYou({ kind: "checklist_approval", priority: "normal", notify: "needs_you" }),
  ).toBe(true);
});

it.each(["\r", "\n"])(
  "rejects line breaks (%j) in checklist text and proposal metadata",
  (line) => {
    const updatedAt = "2026-11-22T10:00:00Z";
    const item = { id: "item", text: "Task", status: "todo", updatedAt };
    const checklist = { projectId: "project", items: [item], changes: [], updatedAt };
    expect(
      ProjectChecklist.safeParse({
        ...checklist,
        items: [{ ...item, text: `Task${line}` }],
      }).success,
    ).toBe(false);
    for (const field of ["reason", "startPurpose"]) {
      expect(
        ProjectChecklist.safeParse({
          ...checklist,
          pending: {
            id: "proposal",
            kind: "expand",
            diff: [],
            inboxItemId: "card",
            requestedAt: updatedAt,
            [field]: `Task${line}`,
          },
        }).success,
      ).toBe(false);
    }
  },
);

it("round-trips a pinned plan and the revision awaiting approval", () => {
  const updatedAt = "2026-11-22T10:00:00Z";
  const plan = { sha: "a".repeat(64), reviewRef: "review-1", tasks: [{ id: "a", text: "A" }] };
  const revision = { ...plan, sha: "b".repeat(64), reviewRef: "review-2" };
  const checklist = {
    projectId: "project",
    plan,
    items: [{ ...plan.tasks[0], status: "todo", updatedAt }],
    changes: [],
    updatedAt,
    pending: {
      id: "proposal",
      kind: "expand",
      diff: [],
      inboxItemId: "card",
      requestedAt: updatedAt,
      plan: revision,
    },
  };
  expect(ProjectChecklist.parse(checklist)).toEqual(checklist);
  expect(
    ProjectChecklist.safeParse({ ...checklist, plan: { ...plan, reviewRef: "" } }).success,
  ).toBe(false);
});
