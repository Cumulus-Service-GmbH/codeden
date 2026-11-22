import { expect, it } from "vitest";
import { FactoryLimits, JevReceipt, ReviewFinding, ReviewPolicy, teamRoleOfTitle } from "../src";

it("recognizes the Arbiter and reads older settings with review defaults", () => {
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
});
