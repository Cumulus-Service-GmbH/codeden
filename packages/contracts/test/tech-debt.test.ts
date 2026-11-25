import { describe, expect, it } from "vitest";
import {
  EventEnvelope,
  ImportTechDebtCounts,
  ImportTechDebtInput,
  RecordTechDebtCounts,
  RecordTechDebtInput,
  ResolveTechDebtCounts,
  ResolveTechDebtInput,
  TechDebtAction,
  TechDebtIssue,
  TechDebtSummaries,
  TechDebtView,
} from "../src";

describe("project tech debt contracts", () => {
  it("round-trips the append-only view and accepts only qualified issue references", () => {
    const view = TechDebtView.parse({
      projectId: "p",
      issue: "owner/repo#246",
      imported: false,
      findings: [],
    });
    expect(
      EventEnvelope.parse({
        seq: 1,
        ts: "2026-11-23T00:00:00.000Z",
        sessionId: null,
        type: "tech_debt.updated",
        payload: { view },
      }).payload,
    ).toEqual({ view });
    expect(TechDebtIssue.safeParse("repo#246").success).toBe(false);
    expect(TechDebtIssue.safeParse("owner/repo#0").success).toBe(false);
  });

  it("round-trips summaries and reads legacy views without retaining seed state", () => {
    const summaries = [{ projectId: "p", open: 1, importError: "Unavailable" }];
    expect(TechDebtSummaries.parse(JSON.parse(JSON.stringify(summaries)))).toEqual(summaries);
    const legacy = {
      projectId: "p",
      issue: null,
      imported: false,
      seeds: ["review-file"],
      importError: "Unavailable",
      importErrorIssue: "owner/repo#246",
      findings: [
        {
          id: "f",
          location: "src/file.ts:2",
          text: "Reuse the helper.",
          date: "2026-11-23T00:00:00.000Z",
          receipt: null,
          pr: null,
          source: null,
          status: "open",
          reason: null,
          sessionId: null,
        },
      ],
    };
    const { seeds: _seeds, ...view } = legacy;
    const parsed = TechDebtView.parse(JSON.parse(JSON.stringify(legacy)));
    expect(parsed).toEqual(view);
    const event = {
      seq: 1,
      ts: "2026-11-23T00:00:00.000Z",
      sessionId: null,
      type: "tech_debt.updated",
      payload: { view: legacy },
    };
    expect(EventEnvelope.parse(event).payload).toEqual({ view });
    expect(TechDebtView.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(view);
  });

  it("accepts only LOW records with a file and line, and qualified import issues", () => {
    const record = { location: "src/file.ts:2", text: "Reuse the helper.", receipt: "r1" };
    expect(RecordTechDebtInput.parse(record)).toEqual({ ...record, severity: "LOW" });
    expect(RecordTechDebtInput.safeParse({ ...record, severity: "MEDIUM" }).success).toBe(false);
    expect(RecordTechDebtInput.safeParse({ ...record, location: "src/file.ts" }).success).toBe(
      false,
    );
    const input = { projectId: "p", issue: "owner/repo#246" };
    expect(ImportTechDebtInput.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(ImportTechDebtInput.safeParse({ issue: "repo#246" }).success).toBe(false);
  });

  it("round-trips a resolution audit event with caller and evidence", () => {
    const event = {
      seq: 1,
      ts: "2026-11-23T00:00:00.000Z",
      sessionId: "pm",
      type: "tech_debt.resolved",
      payload: { projectId: "p", id: "f", status: "fixed", reason: "Verified.", receipt: "proof" },
    };
    expect(EventEnvelope.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it("requires a reason for dismissal and distinct selections for a fix", () => {
    expect(TechDebtAction.safeParse({ action: "dismiss", id: "f", reason: " " }).success).toBe(
      false,
    );
    expect(TechDebtAction.safeParse({ action: "fix", ids: ["f", "f"] }).success).toBe(false);
  });
  it("round-trips bulk record, both resolution inputs and counts-only results", () => {
    const row = {
      location: "src/file.ts:2",
      text: "Reuse the helper.",
      receipt: "review",
      severity: "LOW",
    };
    const resolution = { status: "dismissed", reason: "Already covered.", receipt: "proof" };
    const cases = [
      [RecordTechDebtInput, { projectId: "p", findings: [row] }],
      [ResolveTechDebtInput, { projectId: "p", ids: ["a", "b"], ...resolution }],
      [ResolveTechDebtInput, { resolutions: [{ id: "a", ...resolution }] }],
      [RecordTechDebtCounts, { recorded: 1, duplicates: 0 }],
      [ImportTechDebtCounts, { imported: 1, duplicates: 0 }],
      [ResolveTechDebtCounts, { resolved: 1, unknown: 1, alreadyResolved: 0 }],
    ] as const;
    for (const [schema, value] of cases) {
      expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }
    expect(ResolveTechDebtInput.safeParse({ ids: ["a"], ...resolution, receipt: "" }).success).toBe(
      false,
    );
    expect(
      ResolveTechDebtInput.safeParse({ ids: ["a"], ...resolution, status: "open" }).success,
    ).toBe(false);
    expect(
      ResolveTechDebtCounts.safeParse({ resolved: 1, unknown: 0, alreadyResolved: 0, findings: [] })
        .success,
    ).toBe(false);
  });
});
