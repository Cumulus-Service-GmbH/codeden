import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { installDoneFixture, jevEvidence, sha } from "./support/factory-jev-fixture";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * The merge queue (§10.1, Merge): with auto-merge on, approved PRs merge oldest approved first.
 * Under the strict policy each one is brought up to date with main through GitHub's
 * update-branch (no agent) and merges once CI passes on the new head, one at a time. A conflict
 * an agent resolves after the approval is re-checked by the reviewer, the resolution only.
 * (`factory-fast-merge.test.ts` covers the default policy, where ready PRs merge together.)
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, lastMessageTo, enable, verifying, review } = factorySteps(() => env);

const prEntry = async (itemId: string) =>
  (await env.factory.status(env.project.id)).pullRequests.find((p) => p.itemId === itemId);

async function reviewWithEvidence(id: string, head: string | null, summary = APPROVE.summary) {
  if (!head) throw new Error("The test PR has no head.");
  const result = await review(id, {
    ...APPROVE,
    summary,
    jevEvidence: jevEvidence(head),
  });
  const reviewer = item(id).reviewerSessionId;
  if (reviewer) await env.setStatus(reviewer, "idle");
  return result;
}

/** Hold merges (the loop is paused) while work in flight keeps moving. */
function pause() {
  const loop = env.factory.data.loopOrNew(env.project.id);
  env.factory.data.saveLoop({ ...loop, state: "paused", pausedReason: "held by the test" });
}

describe("the merge queue", () => {
  it("re-tests approved PRs one at a time under the strict policy, oldest approved first", async () => {
    env = createFactoryEnv({ limits: { mergePolicy: "strict" } });
    installDoneFixture(env);
    await enable();
    const a = await verifying("success", "Add a counter", 3);
    const b = await verifying("success", "Add a timer", 4);
    pause();
    await reviewWithEvidence(a.id, a.pr.headSha);
    await tick();
    later(1_000);
    await reviewWithEvidence(b.id, b.pr.headSha);
    await tick();
    expect(env.gh.merges).toEqual([]);
    const queued = (await env.factory.status(env.project.id)).pullRequests;
    expect(queued.map((p) => [p.itemId, p.state, p.queuePosition])).toEqual([
      [a.id, "queued", 1],
      [b.id, "queued", 2],
    ]);

    // The oldest approval merges. Main moved, so B is behind: GitHub merges main into it (no
    // agent), its head pinned.
    const before = b.pr.headSha as string;
    env.factory.resume(env.project.id);
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([a.pr.ref.number]);
    expect(item(b.id).stage).toBe("verifying");
    expect(env.gh.updates).toEqual([{ number: b.pr.ref.number, expectedHeadSha: before }]);
    expect(await prEntry(b.id)).toMatchObject({ state: "updating", queuePosition: 1 });

    // CI runs on the new head: it waits in the queue until CI passes.
    await tick();
    expect(await prEntry(b.id)).toMatchObject({ state: "waiting_ci", queuePosition: 1 });
    expect(env.gh.merges).toHaveLength(1);
    b.pr.checks = "success";
    await tick();
    expect(env.gh.merges).toHaveLength(1);
    await reviewWithEvidence(b.id, b.pr.headSha);
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([a.pr.ref.number, b.pr.ref.number]);
    expect(item(b.id).stage).toBe("watching");
    expect(await prEntry(b.id)).toMatchObject({ state: "merged", queuePosition: null });
    // Merging main in needs no new review.
    expect(env.messages.some((m) => /range-diff/.test(m.text))).toBe(false);
    expect(env.gh.updates).toHaveLength(1);
  });

  it("has the reviewer re-check only the resolution after an agent rebased an approved PR", async () => {
    env = createFactoryEnv();
    installDoneFixture(env);
    await enable();
    const { id, pr, builder } = await verifying("pending");
    await reviewWithEvidence(id, pr.headSha);
    await tick();
    expect(item(id).stage).toBe("verifying");
    const oldHead = pr.headSha as string;

    pr.mergeable = "conflicting";
    await tick();
    expect(lastMessageTo(builder)).toMatch(/\*\*Rebase\*\*/);
    expect(item(id).attempts).toBe(0);
    expect(await prEntry(id)).toMatchObject({ state: "rebasing", queuePosition: null });

    // The builder rebases; CI passes on the new head, but the approval waits for the re-check.
    const rebased = sha("rebased1");
    env.gh.rebase(pr, rebased, "success");
    await env.setStatus(builder, "idle");
    await tick();
    const reviewer = item(id).reviewerSessionId as string;
    expect(item(id).checks.find((c) => c.name === "review")).toMatchObject({
      state: "pending",
      detail: expect.stringMatching(/re-checks the resolution/),
    });
    expect(lastMessageTo(reviewer)).toContain(`git range-diff ${oldHead}...${rebased}`);
    expect(env.gh.merges).toEqual([]);

    const res = await reviewWithEvidence(id, rebased, "The resolution keeps both sides");
    expect(res).toMatchObject({
      recorded: true,
      message: expect.stringMatching(/earlier verdict/),
    });
    expect(item(id).review?.summary).toBe(APPROVE.summary);
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
  });
});
