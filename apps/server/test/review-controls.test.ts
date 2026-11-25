import { describe, expect, it } from "vitest";
import { PrFiles } from "../src/services/factory/overlap";
import {
  applyReviewFindingPolicy,
  MAX_REVIEW_LINES,
  reviewRound,
  reviewVendorsMatch,
  sortReviewFindings,
} from "../src/services/review-controls";

describe("shared review controls", () => {
  it("refuses matching model vendors across providers", () => {
    expect(
      reviewVendorsMatch(
        { id: "direct", capabilities: { modelVendor: "vendor" } },
        { id: "bridge", capabilities: { modelVendor: "vendor" } },
      ),
    ).toBe(true);
  });

  it("limits each review and requires a new head on delta rounds", () => {
    const first = { head: "first", lines: 12 };
    const previous = [{ head: "first", dispositions: ["Fixed the failing path."] }];
    expect(reviewRound({}, [], first)).toMatchObject({ number: 1, limit: 2, flagged: false });
    expect(reviewRound({}, previous, first)).toMatchObject({ blocked: "unchanged_head" });
    expect(reviewRound({}, [], { ...first, lines: MAX_REVIEW_LINES + 1 })).toMatchObject({
      blocked: "diff_size",
    });
    expect(reviewRound({}, previous, { head: "second", lines: 1 })).toMatchObject({
      base: "first",
      dispositions: previous[0]?.dispositions,
    });
    expect(reviewRound({}, [...previous, ...previous], { head: "third", lines: 1 })).toMatchObject({
      blocked: "round_limit",
      flagged: true,
    });
  });

  it("defers out-of-scope and evidence-free findings according to the project's LOW policy", () => {
    const findings = [
      { location: "src-old/a.ts:1", severity: "HIGH" as const, summary: "Outside the spec" },
      { location: "src/a.ts:2", severity: "MEDIUM" as const, summary: "Missing evidence" },
      {
        location: "src/a.ts:3",
        severity: "HIGH" as const,
        summary: "Fails",
        failure_scenario: "Empty inputs crash.",
        repro: "Pass an empty input.",
      },
    ];
    const spec = { planSha: "a".repeat(64), scope: ["src/"] };
    const deferred = sortReviewFindings(spec, findings, "defer", ["src/a.ts"]);
    expect(deferred.fix.map((f) => f.summary)).toEqual(["Fails"]);
    expect(deferred.debt.map((f) => f.summary)).toEqual(["Outside the spec", "Missing evidence"]);
    expect(
      sortReviewFindings(spec, findings, "fix", ["src/a.ts"]).fix.map((f) => f.summary),
    ).toEqual(["Missing evidence", "Fails"]);
  });
});

describe("scope of consequential review findings", () => {
  const spec = { planSha: "a".repeat(64), scope: ["src/changed.ts"] };
  const finding = {
    location: "src/caller.ts:8",
    severity: "HIGH" as const,
    summary: "The caller crashes.",
    failure_scenario: "An empty input aborts the request.",
    repro: "Open the page with an empty input.",
  };

  it("keeps a HIGH finding when the diff is unavailable", () => {
    expect(sortReviewFindings(spec, [finding], "defer")).toEqual({ fix: [finding], debt: [] });
  });

  it.each(["src/caller.ts?line=8", "src//caller.ts:8", "src/caller.ts;L8"])(
    "keeps a HIGH finding when its location cannot be parsed: %s",
    (location) => {
      const unreadable = { ...finding, location };
      expect(sortReviewFindings(spec, [unreadable], "defer", ["src/changed.ts"])).toEqual({
        fix: [unreadable],
        debt: [],
      });
    },
  );

  it("keeps a HIGH finding on an unchanged caller when the repro names a changed file", () => {
    const caller = { ...finding, repro: "Pass an empty input through `src/changed.ts`." };
    expect(sortReviewFindings(spec, [caller], "defer", ["src/changed.ts"])).toEqual({
      fix: [caller],
      debt: [],
    });
  });

  it("uses only a complete diff at the reviewed head to defer a finding", () => {
    const files = new PrFiles();
    files.set("project", 1, ["src/changed.ts"], "head-a");
    expect(files.forReview("project", 1, "head-b")).toBeUndefined();
    expect(files.forReview("project", 1, "head-a")).toEqual(["src/changed.ts"]);
    files.set("project", 1, ["src/changed.ts"]);
    expect(files.forReview("project", 1, "head-a")).toBeUndefined();
    expect(files.get("project", 1)).toEqual(["src/changed.ts"]);
  });
});

it("blocks a known same-vendor review but preserves legacy adapters without vendor metadata", () => {
  expect(
    reviewVendorsMatch({ id: "fake", capabilities: {} }, { id: "fake", capabilities: {} }),
  ).toBe(false);
});

it("pins the same plan and scope regardless of changed review findings", async () => {
  const { pinReviewSpec } = await import("../src/services/review-controls");
  const spec = pinReviewSpec("Validate input", ["Empty input is rejected"], ["src/"]);
  expect(spec.planSha).toMatch(/^[a-f0-9]{64}$/);
  expect(spec.scope).toEqual(["src/"]);
  expect(pinReviewSpec("Validate input", ["Empty input is allowed"], ["src/"]).planSha).not.toBe(
    spec.planSha,
  );
  expect(() => sortReviewFindings({ ...spec, security: true }, [], "defer")).toThrow(
    "Security reviews require a threat model",
  );
});

it.each(["src/a.ts:L12", "src/a.ts:12:3-14:1", "src/a.ts (line 12)", "/repo/src/a.ts:12"])(
  "keeps an evidenced HIGH finding with location %s blocking",
  (location) => {
    const finding = {
      location,
      severity: "HIGH" as const,
      summary: "Empty input fails",
      failure_scenario: "An empty input crashes validation.",
      repro: "Pass an empty input.",
    };
    const draft = {
      verdict: "request_changes" as const,
      summary: "Review findings",
      lessons: [],
      criteria: [{ criterion: "Input is validated", met: true }],
      vision: { aligned: true },
      tests: { adequate: true },
      security: { concerns: [] },
      findings: [finding],
    };
    const scope = ["src/a.ts"];
    expect(
      applyReviewFindingPolicy(draft, { planSha: "a".repeat(64), scope }, "defer", scope),
    ).toMatchObject({ verdict: "request_changes", findings: [finding], techDebt: [] });
  },
);

it("keeps an independent failing criterion even when every finding is deferred", () => {
  const draft = {
    verdict: "request_changes" as const,
    summary: "Review findings",
    lessons: [],
    criteria: [{ criterion: "Input is validated", met: false }],
    vision: { aligned: true },
    tests: { adequate: true },
    security: { concerns: [] },
    findings: [{ location: "src/a.ts:1", summary: "Rename a variable", severity: "LOW" as const }],
  };
  expect(applyReviewFindingPolicy(draft, undefined, "defer")).toMatchObject({
    verdict: "request_changes",
    findings: [],
    techDebt: draft.findings,
  });
  expect(applyReviewFindingPolicy({ ...draft, criteria: [] }, undefined, "defer").verdict).toBe(
    "approve",
  );
  expect(
    applyReviewFindingPolicy({ ...draft, criteria: [], verdict: "approve" }, undefined, "fix")
      .verdict,
  ).toBe("request_changes");
});

it("keeps review setting changes at project PM scope", async () => {
  const { factorySetLowFindings, factoryPinReviewSpec } = await import("../src/mcp/tools/factory");
  expect(factorySetLowFindings).toMatchObject({ roles: ["pm"], scope: "project" });
  expect(factoryPinReviewSpec).toMatchObject({ roles: ["pm"], scope: "project" });
});
