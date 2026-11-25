import { afterEach, expect, it, vi } from "vitest";
import type { ExecResult } from "../src/services/exec";
import { readyInboxId } from "../src/services/factory/merge";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import {
  fixtureJevScript,
  installDoneFixture,
  jevEvidence,
  reviewTeam,
} from "./support/factory-jev-fixture";
import { APPROVE, factorySteps } from "./support/factory-steps";

let env: FactoryEnv;
let activeEnv: FactoryEnv | undefined;
afterEach(async () => {
  await activeEnv?.close();
  activeEnv = undefined;
});
const { enable, item, review, tick, verifying } = factorySteps(() => env);

async function finishReview(autoMerge: boolean) {
  await enable("software_factory", { autoMerge, tuning: { team: reviewTeam } });
  const { id, pr } = await verifying("success");
  await review(id, {
    ...APPROVE,
    ...(env.factory.ctx.jevScript && pr.headSha ? { jevEvidence: jevEvidence(pr.headSha) } : {}),
  });
  const reviewer = item(id).reviewerSessionId;
  if (reviewer) await env.setStatus(reviewer, "idle");
  await tick();
  return { id, pr };
}

it("a configured completion check that passes lets the item proceed", async () => {
  env = activeEnv = createFactoryEnv({ jevScript: fixtureJevScript });
  installDoneFixture(env);
  const { id, pr } = await finishReview(true);
  expect(item(id).jev).toMatchObject({ status: "pass", head: pr.headSha });
  expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
});

async function expectBlocked(done: (result: ExecResult) => ExecResult) {
  for (const autoMerge of [true, false]) {
    env = activeEnv = createFactoryEnv({ jevScript: fixtureJevScript });
    try {
      const invoke = vi.fn(done);
      installDoneFixture(env, invoke);
      const { id, pr } = await finishReview(autoMerge);
      expect(invoke).toHaveBeenCalledOnce();
      expect(item(id)).toMatchObject({ stage: "verifying" });
      expect(item(id).jevHistory?.at(-1)).toMatchObject({
        status: "unavailable",
        head: pr.headSha,
      });
      expect(env.gh.merges).toEqual([]);
      expect(env.inbox.find(readyInboxId(id))).toBeUndefined();
    } finally {
      activeEnv = undefined;
      await env.close();
    }
  }
}

it("a configured completion check that is unreachable blocks the merge", async () => {
  await expectBlocked((result) => ({ ...result, code: null, notFound: true }));
});

it("a configured completion check that errors blocks the merge", async () => {
  await expectBlocked(() => {
    throw new Error("Could not run Jev");
  });
});

it("a configured completion check that times out blocks the merge", async () => {
  await expectBlocked((result) => ({ ...result, timedOut: true }));
});

it("a configured completion check that returns non-JSON blocks the merge", async () => {
  await expectBlocked((result) => ({ ...result, stdout: "invalid receipt" }));
});

it.each([true, false])(
  "missing Jev blocks an automatic or manual merge (%s)",
  async (autoMerge) => {
    env = activeEnv = createFactoryEnv({ jevScript: null });
    const { id } = await finishReview(autoMerge);
    expect(env.gh.merges).toEqual([]);
    expect(env.inbox.find(readyInboxId(id))).toBeUndefined();
    expect(item(id).jev?.status).toBe("not configured");
    expect(env.execs.some(({ args }) => args[1] === "done")).toBe(false);
  },
);

it("pausing prevents merges independently of an active suspension", async () => {
  env = activeEnv = createFactoryEnv({ jevScript: null });
  await enable();
  const { id, pr } = await verifying("success");
  const loop = env.factory.data.loopOrNew(env.project.id);
  env.factory.data.saveLoop({ ...loop, state: "paused", pausedReason: "Owner paused" });
  // Record the suspension after pausing, without changing the loop state.
  const project = env.factory.ctx.projects.get(env.project.id);
  env.store.append([
    {
      type: "project.updated",
      sessionId: null,
      payload: {
        project: {
          ...project,
          factoryLimits: {
            ...project.factoryLimits,
            jevSuspension: {
              scope: { itemId: id },
              expiresAt: new Date(env.now().getTime() + 60_000).toISOString(),
              reason: "Maintenance",
            },
          },
        },
      },
    },
  ]);
  await review(id, APPROVE);
  await tick();
  expect(item(id).jev?.status).toBe("suspended");
  expect(env.gh.merges).toEqual([]);
  await env.factory.resume(env.project.id);
  await tick();
  expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
});

it.each(["active", "expired", "different item"])(
  "honors only a live suspension for this item (%s)",
  async (state) => {
    env = activeEnv = createFactoryEnv({ jevScript: null });
    await enable();
    const { id, pr } = await verifying("success");
    const project = env.factory.ctx.projects.get(env.project.id);
    await env.factory.setMode(project.id, {
      mode: "software_factory",
      limits: {
        ...project.factoryLimits,
        jevSuspension: {
          scope: { itemId: state === "different item" ? "other" : id },
          expiresAt: new Date(
            env.now().getTime() + (state === "expired" ? 0 : 60_000),
          ).toISOString(),
          reason: "Maintenance",
        },
      },
    });
    await review(id, APPROVE);
    await tick();
    expect(item(id).jev?.status).toBe(state === "active" ? "suspended" : "not configured");
    expect(env.gh.merges.map((m) => m.number)).toEqual(state === "active" ? [pr.ref.number] : []);
  },
);

it("an unset Jev completion-check reviewer fails closed and says Set the Jev completion-check reviewer in Settings → Team", async () => {
  env = activeEnv = createFactoryEnv({ jevScript: fixtureJevScript });
  installDoneFixture(env, (result) => ({ ...result, notFound: true }));
  const { advanceJev } = await import("../src/services/factory/jev");
  const { sha } = await import("./support/factory-jev-fixture");
  const { backlogItem } = factorySteps(() => env);
  const work = backlogItem();
  const startTurn = vi.spyOn(env.factory.ctx.sessions, "startTurn");
  const head = sha("reviewed");
  expect(
    await advanceJev(
      env.factory.ctx,
      env.project,
      {
        ...work,
        jev: { head, status: "revise", reasons: ["Fix the receipt"] },
        jevHistory: [{ head, status: "revise", reasons: ["Fix the receipt"] }],
      },
      head,
      { team: [] },
    ),
  ).toBe(false);
  expect(startTurn).not.toHaveBeenCalled();
  expect(item(work.id).note).toBe("Set the Jev completion-check reviewer in Settings → Team");
});
