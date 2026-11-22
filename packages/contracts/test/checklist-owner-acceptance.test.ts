import { expect, it } from "vitest";
import { ProjectChecklist } from "../src";

const at = "2026-11-22T10:00:00Z";
const item = { id: "item", text: "Task", status: "todo", updatedAt: at };
const legacy = { projectId: "project", items: [item], changes: [], updatedAt: at };

it("round-trips checklist owner metadata and leaves legacy versions unchanged", () => {
  for (const checklist of [legacy, { ...legacy, state: "approved", approvedAt: at }]) {
    expect(ProjectChecklist.parse(JSON.parse(JSON.stringify(checklist)))).toEqual(checklist);
  }
  const checklist = {
    ...legacy,
    items: [
      {
        ...item,
        eta: at,
        needsOwner: { reason: "Approve the card", sessionId: "session" },
        scopeAddition: { approvedAt: at },
      },
    ],
    changes: [{ itemId: item.id, text: item.text, from: "todo", to: "todo", at, needsOwner: true }],
  };
  expect(ProjectChecklist.parse(JSON.parse(JSON.stringify(checklist)))).toEqual(checklist);
});

it.each([
  { eta: `${at}\n` },
  { needsOwner: { reason: "Two\rlines" } },
  { needsOwner: { reason: "Approve", sessionId: "session\n" } },
  { needsOwner: { reason: "" } },
  { needsOwner: { reason: "x".repeat(201) } },
])("rejects invalid checklist item metadata %j", (metadata) => {
  expect(ProjectChecklist.safeParse({ ...legacy, items: [{ ...item, ...metadata }] }).success).toBe(
    false,
  );
});
