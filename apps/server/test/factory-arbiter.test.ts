import { ReviewPolicy } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { arbiterLane, reviewEscalation } from "../src/services/factory/arbiter";

import { createFactoryEnv } from "./support/factory-env";
import { reviewTeam } from "./support/factory-jev-fixture";
import { APPROVE, factorySteps } from "./support/factory-steps";

const arbiter = {
  role: "arbiter",
  provider: "claude",
  model: "fixture-arbiter",
  effort: null,
} as const;

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

it.each(["approve", "request_changes", "reject"] as const)(
  "routes an Arbiter confirmation of %s",
  async (decision) => {
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
      verdict: decision,
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
    expect(saved.arbitration).toMatchObject({
      head: "abc",
      state: decision === "approve" ? "jev_pending" : "blocked",
    });
    expect(inbox).toEqual(
      decision === "approve"
        ? []
        : [
            expect.objectContaining({
              kind: "owner_decision",
              body: expect.stringContaining(decision),
            }),
          ],
    );
  },
);

it("the Arbiter rounds setting round-trips", async () => {
  const env = createFactoryEnv();
  const { enable } = factorySteps(() => env);
  try {
    await enable("software_factory", {
      tuning: { reviewPolicy: ReviewPolicy.parse({ arbiterRounds: 3 }) },
    });
    expect((await env.factory.status(env.project.id)).tuning.reviewPolicy?.arbiterRounds).toBe(3);
  } finally {
    await env.close();
  }
});

it("the review flow stops after N Arbiter rounds", async () => {
  const env = createFactoryEnv();
  const { enable, item, review, tick, verifying } = factorySteps(() => env);
  const sessions = env.factory.ctx.sessions;
  const providerInfo = sessions.providerInfo("claude");
  if (!providerInfo) throw new Error("Expected the Claude provider fixture");
  vi.spyOn(sessions, "providerInfo").mockImplementation((id) =>
    id === "claude"
      ? { ...providerInfo, capabilities: { ...providerInfo.capabilities, toolFreeRuns: true } }
      : undefined,
  );
  const arbitrate = vi
    .spyOn(sessions, "runToolFreeArbiter")
    .mockResolvedValue("The finding stands.");
  const disputed = { ...APPROVE, verdict: "request_changes" as const };
  try {
    await enable("software_factory", {
      tuning: {
        team: [...reviewTeam, arbiter],
        reviewPolicy: ReviewPolicy.parse({ reviewerRounds: 1, arbiterRounds: 2 }),
      },
    });
    const { id } = await verifying();
    const reviewer = item(id).reviewerSessionId;
    if (!reviewer) throw new Error("Expected a reviewer session");
    await review(id, disputed);
    await env.setStatus(reviewer, "idle");
    const decisionId = `inbox:factory-owner-decision:${id}`;
    for (const round of [1, 2]) {
      await tick();
      expect(arbitrate).toHaveBeenCalledTimes(round);
      expect(item(id).arbitration?.round).toBe(round);
      await tick();
      expect(item(id).arbitration?.state).toBe("confirming");
      await review(id, disputed);
      await env.setStatus(reviewer, "idle");
      if (round === 1) expect(env.inbox.find(decisionId)).toBeUndefined();
    }
    await tick();
    expect(arbitrate).toHaveBeenCalledTimes(2);
    expect(item(id).arbitration?.state).toBe("blocked");
    expect(env.inbox.find(decisionId)).toMatchObject({ kind: "owner_decision" });
  } finally {
    await env.close();
  }
});

it.each([
  {
    name: "an unset Arbiter blocks the Arbiter step and says Set the Arbiter in Settings → Team",
    team: [],
    runs: false,
  },
  {
    name: "an Arbiter without a model fails closed and says Set the Arbiter in Settings → Team",
    team: [{ ...arbiter, model: null }],
    runs: false,
  },
  { name: "a set Arbiter runs the Arbiter step", team: [arbiter], runs: true },
  {
    name: "an Arbiter set in the Default Team runs the Arbiter step",
    team: [],
    runs: true,
    defaults: [arbiter],
  },
])("$name", async ({ team, runs, defaults }) => {
  const env = createFactoryEnv();
  const { enable, item, review, tick, verifying } = factorySteps(() => env);
  const sessions = env.factory.ctx.sessions;
  const startArbiter = vi.spyOn(sessions, "startArbiter");
  const provider = sessions.providerInfo(arbiter.provider);
  if (!provider) throw new Error("Expected a provider fixture");
  vi.spyOn(sessions, "providerInfo").mockReturnValue({
    ...provider,
    capabilities: { ...provider.capabilities, toolFreeRuns: true },
  });
  const arbitrate = vi
    .spyOn(sessions, "runToolFreeArbiter")
    .mockResolvedValue("The finding stands.");
  try {
    if (defaults) env.settings.update({ teamSetup: { remembered: true, team: defaults } });
    await enable("software_factory", {
      tuning: {
        team: [...reviewTeam, ...team],
        reviewPolicy: ReviewPolicy.parse({ reviewerRounds: 1 }),
      },
    });
    const { id } = await verifying();
    await review(id, { ...APPROVE, verdict: "request_changes" });
    await env.setStatus(item(id).reviewerSessionId as string, "idle");
    await tick();
    if (runs) {
      expect(arbitrate).toHaveBeenCalledWith(arbiter, expect.any(String));
      expect(item(id).arbitration?.ruling).toBe("The finding stands.");
    } else {
      const reason = "Set the Arbiter in Settings → Team";
      expect(arbitrate).not.toHaveBeenCalled();
      expect(startArbiter).not.toHaveBeenCalled();
      expect(item(id)).toMatchObject({ note: reason, arbitration: { state: "blocked" } });
      expect(item(id).arbitration?.ruling).toBeUndefined();
      expect(item(id).arbitration?.sessionId).toBeUndefined();
      expect(env.inbox.find(`inbox:factory-owner-decision:${id}`)).toMatchObject({ body: reason });
    }
  } finally {
    await env.close();
  }
});
