import { describe, expect, it } from "vitest";
import { defaultSettings, EventEnvelope, ProjectChecklist, Snapshot } from "../src";
import { sampleProject, ts } from "./fixtures";

const checklist = {
  projectId: sampleProject.id,
  items: [{ id: "tests", text: "Run tests", status: "doing", updatedAt: ts }],
  changes: [{ itemId: "tests", text: "Run tests", from: null, to: "doing" }],
  updatedAt: ts,
};

describe("project checklists", () => {
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

  it("round-trips a snapshot and defaults legacy snapshots to an empty checklist array", () => {
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
    expect(Snapshot.parse(snapshot).checklists).toEqual([]);
    const parsed = Snapshot.parse({ ...snapshot, checklists: [checklist] });
    expect(parsed.checklists).toEqual([checklist]);
    expect(Snapshot.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});
