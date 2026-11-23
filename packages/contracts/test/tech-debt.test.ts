import { describe, expect, it } from "vitest";
import {
  EventEnvelope,
  ImportTechDebtInput,
  RecordTechDebtInput,
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
    expect(view.seeds).toEqual([]);
    expect(TechDebtIssue.safeParse("repo#246").success).toBe(false);
    expect(TechDebtIssue.safeParse("owner/repo#0").success).toBe(false);
  });

  it("round-trips summaries and backfilled findings with seed state", () => {
    const summaries = [{ projectId: "p", open: 1, importError: "Unavailable" }];
    expect(TechDebtSummaries.parse(JSON.parse(JSON.stringify(summaries)))).toEqual(summaries);
    const view = {
      projectId: "p",
      issue: null,
      imported: false,
      seeds: ["backfill:/tmp/review.json"],
      importError: "Unavailable",
      findings: [
        {
          id: "f",
          location: "src/file.ts:2",
          text: "Reuse the helper.",
          date: "2026-11-23T00:00:00.000Z",
          receipt: null,
          pr: null,
          source: "backfill",
          status: "open",
          reason: null,
          sessionId: null,
        },
      ],
    };
    expect(TechDebtView.parse(JSON.parse(JSON.stringify(view)))).toEqual(view);
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

  it("requires a reason for dismissal and distinct selections for a fix", () => {
    expect(TechDebtAction.safeParse({ action: "dismiss", id: "f", reason: " " }).success).toBe(
      false,
    );
    expect(TechDebtAction.safeParse({ action: "fix", ids: ["f", "f"] }).success).toBe(false);
  });
});
