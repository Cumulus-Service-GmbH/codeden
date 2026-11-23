import { expect, it } from "vitest";
import {
  DEFAULT_ARBITER,
  FactoryLimits,
  FactoryTuning,
  JevReceipt,
  ReviewFinding,
  ReviewPolicy,
  teamRoleOfTitle,
} from "../src";

it("recognizes the default Arbiter and reads older settings with review settings defaults", () => {
  expect(DEFAULT_ARBITER).toEqual({
    role: "arbiter",
    provider: "claude",
    model: "claude-fable-5-2",
    effort: "high",
  });
  expect(teamRoleOfTitle("[Arbiter] Review disputed findings")).toBe("arbiter");
  expect(FactoryLimits.parse({}).lowFindings).toBe("defer");
  const policy = ReviewPolicy.parse({});
  expect(ReviewPolicy.parse(JSON.parse(JSON.stringify(policy)))).toEqual({
    reviewerRounds: 2,
    jevRounds: 1,
    arbiterRounds: 1,
    jevAttempts: 3,
    totalRounds: 8,
  });
});

it("round-trips an optional daily review budget in USD", () => {
  expect(ReviewPolicy.parse({}).dailyBudgetUsd).toBeUndefined();
  const tuning = FactoryTuning.parse({ reviewPolicy: { dailyBudgetUsd: 12.5 } });
  expect(FactoryTuning.parse(JSON.parse(JSON.stringify(tuning))).reviewPolicy?.dailyBudgetUsd).toBe(
    12.5,
  );
});

it.each(["HIGH", "MEDIUM"] as const)("requires a scenario and repro to retain %s", (severity) => {
  const finding = { severity, location: "src/main.ts:1", summary: "Loses queued work." };
  expect(ReviewFinding.parse({ ...finding, failure_scenario: " " }).severity).toBe("LOW");
  expect(ReviewFinding.parse({ ...finding, repro: "Restart." }).severity).toBe("LOW");
  const documented = ReviewFinding.parse({
    ...finding,
    failure_scenario: "A restart drops a queued item.",
    repro: "Queue an item and restart before it begins.",
  });
  expect(ReviewFinding.parse(JSON.parse(JSON.stringify(documented))).severity).toBe(severity);
});

it("round-trips a done receipt with its pinned head and history digest", () => {
  const receipt = {
    head: "a".repeat(40),
    status: "pass",
    historyPath: "/review-history/item/history.md",
    historySha256: "b".repeat(64),
    inputSha256: "c".repeat(16),
    reasons: [],
  };
  expect(JevReceipt.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  expect(JevReceipt.safeParse({ ...receipt, head: "short" }).success).toBe(false);
  const skipped = { head: receipt.head, status: "not configured", reasons: [] };
  expect(JevReceipt.parse(JSON.parse(JSON.stringify(skipped)))).toEqual(skipped);
});
