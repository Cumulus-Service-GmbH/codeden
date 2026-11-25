import { describe, expect, it } from "vitest";
import {
  ChecklistItem,
  ChecklistProposal,
  defaultSettings,
  EventEnvelope,
  ProjectChecklist,
  Snapshot,
  UpdateChecklistItemInput,
} from "../src";
import { sampleProject, ts } from "./fixtures";

const checklist = {
  projectId: sampleProject.id,
  items: [{ id: "tests", text: "Run tests", status: "doing", updatedAt: ts }],
  changes: [{ itemId: "tests", text: "Run tests", from: null, to: "doing" }],
  updatedAt: ts,
};

describe("project checklists", () => {
  it("round-trips PM checklist text and progress without accepting a project override", () => {
    const input = { itemId: "tests", text: "Run tests", note: "Ready", eta: null };
    expect(UpdateChecklistItemInput.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(
      UpdateChecklistItemInput.safeParse({ ...input, projectId: sampleProject.id }).success,
    ).toBe(false);
    expect(UpdateChecklistItemInput.safeParse({ itemId: "tests" }).success).toBe(false);
  });

  it("round-trips the checklist and its event", () => {
    expect(ProjectChecklist.parse(JSON.parse(JSON.stringify(checklist)))).toEqual(checklist);
    const event = {
      seq: 1,
      sessionId: null,
      type: "checklist.updated",
      payload: { checklist },
      ts,
    };
    expect(EventEnvelope.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it("round-trips a snapshot and keeps checklists optional in legacy snapshots", () => {
    const snapshot = {
      seq: 1,
      serverVersion: "0.0.0",
      generatedAt: ts,
      settings: defaultSettings(),
      projects: [sampleProject],
      sessions: [],
      inbox: [],
      automations: [],
      runner: { state: "disabled", runnerId: null, version: null, providers: [], lastError: null },
    };
    expect(Snapshot.parse(snapshot)).not.toHaveProperty("checklists");
    const parsed = Snapshot.parse({ ...snapshot, checklists: [checklist] });
    expect(parsed.checklists).toEqual([checklist]);
    expect(Snapshot.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});

it.each(["\r", "\n", "\r\n"])("rejects a checklist ID containing %j", (line) => {
  expect(ChecklistItem.safeParse({ ...checklist.items[0], id: `task${line}next` }).success).toBe(
    false,
  );
});

it("requires every proposal order entry to be a checklist item ID", () => {
  const order = ChecklistProposal.shape.order;
  expect(order.parse(["a".repeat(64)])).toEqual(["a".repeat(64)]);
  for (const invalid of ["", "a\nb", "a".repeat(65)]) {
    expect(order.safeParse([invalid]).success).toBe(false);
  }
});

it("strips automatic ownership from proposal addition metadata", () => {
  const needsOwner = { reason: "Review the addition", sessionId: "agent" };
  expect(
    ChecklistProposal.shape.additionMetadata.parse([
      { id: "new", needsOwner: { ...needsOwner, source: "work" } },
    ]),
  ).toEqual([{ id: "new", needsOwner }]);
});
