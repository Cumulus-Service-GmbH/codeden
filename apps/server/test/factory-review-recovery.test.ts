import { ReviewVerdict } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { raiseInbox } from "../src/services/factory/context";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

let env: FactoryEnv;
const { enable, item, tick, verifying } = factorySteps(() => env);
const ownerDecision = (id: string) => env.inbox.find(`inbox:factory-owner-decision:${id}`);

beforeEach(() => {
  env = createFactoryEnv();
});
afterEach(() => env.close());

it.each(["Jev", "Arbiter"])("lets only the owner retry a blocked %s review", async (gate) => {
  await enable();
  const { id, pr } = await verifying("pending");
  if (!pr.headSha) throw new Error("Expected a verified head");
  const head = pr.headSha;
  const first = item(id).reviewerSessionId;
  env.factory.data.updateItem(id, (current) => ({
    ...current,
    review: ReviewVerdict.parse(APPROVE),
    ...(gate === "Jev"
      ? { jev: { head, status: "owner decision", reasons: ["Evidence unavailable"] } }
      : { arbitration: { head, state: "blocked" } }),
  }));
  raiseInbox(env.factory.ctx, {
    id: `inbox:factory-owner-decision:${id}`,
    kind: "owner_decision",
    notify: "needs_you",
    projectId: env.project.id,
    title: "Review blocked",
    body: null,
  });

  expect(() => env.factory.retry(env.project.id, id, undefined, "pm")).toThrow();
  await expect(env.factory.retryFromUser(env.project.id, id, "rebuild")).rejects.toThrow();
  const resumed = await env.factory.retryFromUser(env.project.id, id);
  expect(resumed).toMatchObject({ stage: "verifying", review: null, reviewerSessionId: null });
  expect(resumed.pr?.number).toBe(pr.ref.number);
  expect(resumed.earlierSessionIds).toContain(first);
  expect(resumed.jev).toBeUndefined();
  expect(resumed.arbitration).toBeUndefined();
  expect(ownerDecision(id)?.status).toBe("resolved");
  expect(env.gh.merges).toEqual([]);
});

it("moves on from a blocked Arbiter when the head changes, preserving spent rounds", async () => {
  await enable();
  const { id, pr } = await verifying("pending");
  if (!pr.headSha) throw new Error("Expected a verified head");
  const head = pr.headSha;
  const newHead = "c".repeat(40);
  const review = ReviewVerdict.parse({ ...APPROVE, verdict: "request_changes" });
  const round = { head, verdict: review, dispositions: [review.summary] };
  const first = item(id).reviewerSessionId;
  env.factory.data.updateItem(id, (current) => ({
    ...current,
    arbitration: { head, state: "jev_pending", round: 1 },
    arbiterRoundsUsed: 1,
    review,
    reviewRounds: [round],
  }));
  await tick();
  expect(item(id).arbitration?.state).toBe("blocked");
  expect(ownerDecision(id)?.status).toBe("open");

  env.gh.push(pr, newHead, ["src/changed.ts"]);
  await tick();

  const refreshed = item(id);
  expect(refreshed.arbitration).toBeUndefined();
  expect(refreshed.review).toBeNull();
  expect(refreshed.reviewerSessionId).not.toBe(first);
  expect(refreshed.reviewRounds).toEqual([round]);
  expect(refreshed.arbiterRoundsUsed).toBe(1);
  expect(ownerDecision(id)?.status).toBe("resolved");
  expect(env.gh.merges).toEqual([]);
});
