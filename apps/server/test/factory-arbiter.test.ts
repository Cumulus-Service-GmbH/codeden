import { describe, expect, it } from "vitest";
import { arbiterLane, reviewEscalation } from "../src/services/factory/arbiter";

describe("factory Arbiter", () => {
  it("requires enforced security and read-only execution or a tool-free lane", () => {
    expect(arbiterLane({ enforcesSecurityRules: true, readOnly: true })).toBe("read_only");
    expect(arbiterLane({ enforcesSecurityRules: true })).toBeNull();
    expect(arbiterLane({ readOnly: true })).toBeNull();
    expect(arbiterLane({ toolFreeRuns: true })).toBe("tool_free");
  });

  it("escalates unresolved reviews when the configured review cap is exhausted", () => {
    const item = {
      review: { verdict: "request_changes" },
      reviewRounds: [{ head: "a" }, { head: "b" }],
    };
    expect(reviewEscalation(item, {})).toBe(true);
    expect(reviewEscalation(item, { reviewerRounds: 3 })).toBe(false);
    expect(reviewEscalation({ ...item, review: { verdict: "approve" } }, {})).toBe(false);
  });
});

it("keeps arbitrated work out of the merge pipeline", async () => {
  const { pipelineStep } = await import("@codeden/contracts");
  const item = {
    stage: "verifying",
    type: "feature" as const,
    investigation: null,
    checks: [{ state: "pass" }],
    review: { verdict: "approve" },
    arbitration: { state: "jev_pending" },
  };
  expect(pipelineStep(item)).toBe("arbiter");
});

it("records a confirmation and leaves the pinned head pending for Jev", async () => {
  const { confirmArbiter } = await import("../src/services/factory/arbiter");
  const { ReviewVerdict } = await import("@codeden/contracts");
  const item = {
    id: "item-1",
    projectId: "project-1",
    workKey: "issue:1",
    title: "Disputed change",
    summary: "",
    source: "issue",
    area: null,
    acceptanceCriteria: [],
    score: null,
    stage: "verifying",
    issue: null,
    pr: null,
    builderSessionId: null,
    reviewerSessionId: "reviewer-1",
    arbitration: { head: "abc", state: "confirming", ruling: "Fix the regression." },
    review: null,
    nudges: {},
    createdAt: "2026-11-23T00:00:00.000Z",
    updatedAt: "2026-11-23T00:00:00.000Z",
    finishedAt: null,
  } as unknown as import("@codeden/contracts").FactoryItem;
  const verdict = ReviewVerdict.parse({
    verdict: "request_changes",
    summary: "I confirmed the regression.",
    vision: { aligned: true },
    tests: { adequate: true },
    security: { concerns: [] },
  });
  let saved = item;
  const inbox: unknown[] = [];
  const ctx = {
    store: {
      updateItem: (_id: string, change: (current: typeof item) => typeof item) => {
        saved = change(saved);
        return saved;
      },
    },
    inbox: { find: () => undefined, put: (entry: unknown) => inbox.push(entry) },
    now: () => new Date(item.updatedAt),
  } as never;
  expect(confirmArbiter(ctx, item, { ...verdict, blockers: "environment" })).toBe(false);
  expect(inbox).toEqual([]);
  expect(confirmArbiter(ctx, item, verdict)).toBe(true);
  expect(saved.stage).toBe("verifying");
  expect(saved.review).toEqual(verdict);
  expect(saved.jev).toBeUndefined();
  expect(saved.arbitration).toMatchObject({ head: "abc", state: "jev_pending" });
  expect(inbox).toEqual([]);
});
