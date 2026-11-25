import type { ChecklistProposal, ProjectChecklist } from "@codeden/contracts";
import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { ProposalChanges } from "@/components/checklist/checklist-approval";
import { ChecklistInboxCard } from "@/components/inbox/checklist-inbox-card";
import { createMockClient } from "@/lib/api/mock";
import { inboxItem } from "./attention-fixtures";
import { renderWithClient } from "./utils";

it("lists the first reviewed plan once in the inbox when the checklist is empty", async () => {
  const item = inboxItem("first-plan", "checklist_approval");
  const task = { id: "task", text: "Add the first task" };
  const checklist: ProjectChecklist = {
    projectId: "p1",
    state: "approved",
    items: [],
    changes: [],
    updatedAt: item.createdAt,
    pending: {
      id: "proposal",
      kind: "approve",
      inboxItemId: item.id,
      requestedAt: item.createdAt,
      diff: [{ itemId: task.id, text: task.text, from: null, to: "todo" }],
      plan: { sha: "a".repeat(64), reviewRef: "review-1", tasks: [task] },
    },
  };
  const client = createMockClient();
  const snapshot = await client.getSnapshot();
  client.getSnapshot = async () => ({ ...snapshot, checklists: [checklist] });

  renderWithClient(<ChecklistInboxCard item={item} />, client);

  expect(await screen.findByText("Reviewed plan")).toBeTruthy();
  expect(screen.getAllByText(task.text)).toHaveLength(1);
  expect(screen.queryByText("Changes to current checklist")).toBeNull();
});

it("shows removals from the current checklist before approving its first reviewed plan", () => {
  const at = "2026-11-22T10:00:00.000Z";
  const checklist: ProjectChecklist = {
    projectId: "p1",
    state: "approved",
    items: [
      { id: "x", text: "Keep this task", status: "todo", updatedAt: at },
      { id: "y", text: "Remove this task", status: "done", sessionIds: ["s1"], updatedAt: at },
    ],
    changes: [],
    updatedAt: at,
  };
  const pending: ChecklistProposal = {
    id: "pr1",
    kind: "approve",
    inboxItemId: "i1",
    requestedAt: at,
    diff: [{ itemId: "y", text: "Remove this task", from: "done", to: null }],
    plan: {
      sha: "a".repeat(64),
      reviewRef: "review-1",
      tasks: [{ id: "x", text: "Keep this task" }],
    },
  };

  render(<ProposalChanges checklist={checklist} pending={pending} />);

  expect(screen.getByText("Reviewed plan")).toBeTruthy();
  expect(screen.getByText("Changes to current checklist")).toBeTruthy();
  const removal = screen.getByText("Remove this task").closest("li");
  if (!removal) throw new Error("Expected a removal row");
  expect(within(removal).getByText("Remove:")).toBeTruthy();
});
