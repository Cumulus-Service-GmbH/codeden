import { readFile } from "node:fs/promises";
import { ReviewPolicy } from "@codeden/contracts";
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

async function finishReview(autoMerge: boolean, reviewPolicy?: ReviewPolicy) {
  await enable("software_factory", { autoMerge, tuning: { team: reviewTeam, reviewPolicy } });
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

it("retries a transient completion-check failure within the configured attempt cap", async () => {
  env = activeEnv = createFactoryEnv({ jevScript: fixtureJevScript });
  const invoke = vi
    .fn((result: ExecResult) => result)
    .mockImplementationOnce((result) => ({ ...result, timedOut: true }));
  installDoneFixture(env, invoke);
  const { id, pr } = await finishReview(true);
  expect(invoke).toHaveBeenCalledOnce();
  expect(item(id).jev).toMatchObject({ status: "unavailable" });
  await tick();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(item(id).jev).toMatchObject({ status: "pass", head: pr.headSha });
});

it("keeps the merge blocked once the configured attempt cap is reached", async () => {
  env = activeEnv = createFactoryEnv({ jevScript: fixtureJevScript });
  const invoke = vi.fn((result: ExecResult) => ({ ...result, timedOut: true }));
  installDoneFixture(env, invoke);
  const { id } = await finishReview(true, ReviewPolicy.parse({ jevAttempts: 2 }));
  await tick();
  await tick();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(item(id).jev?.status).toBe("owner decision");
  expect(env.gh.merges).toEqual([]);
});

it("gives Jev only host-verified CI evidence instead of reviewer-pasted test output", async () => {
  env = activeEnv = createFactoryEnv({ jevScript: fixtureJevScript });
  installDoneFixture(env);
  const { pr } = await finishReview(true);
  const done = env.execs.find(({ args }) => args[1] === "done");
  expect(done).toBeDefined();
  const raw = await readFile(done?.args[2] ?? "", "utf8");
  expect(raw).toContain("GitHub commit checks");
  expect(raw).toContain(pr.headSha);
  expect(raw).not.toContain("test/counter.test.ts | grep");
});

it("fails closed when reviewer text claims passing tests without verified CI", async () => {
  env = activeEnv = createFactoryEnv({ jevScript: fixtureJevScript });
  installDoneFixture(env);
  vi.spyOn(env.gh, "commitChecks").mockResolvedValue("failure");
  const { id } = await finishReview(true);
  expect(env.execs.some(({ args }) => args[1] === "done")).toBe(false);
  expect(item(id).jev?.status).toBe("owner decision");
  expect(env.gh.merges).toEqual([]);
});

it("waits for GitHub CI without consuming a Jev attempt", async () => {
  env = activeEnv = createFactoryEnv({ jevScript: fixtureJevScript });
  installDoneFixture(env);
  vi.spyOn(env.gh, "commitChecks")
    .mockResolvedValueOnce("pending")
    .mockRejectedValueOnce(new Error("GitHub temporarily unavailable"));
  const { id } = await finishReview(true, ReviewPolicy.parse({ jevAttempts: 1 }));
  expect(item(id).jev?.status).toBe("pending");
  expect(env.gh.merges).toEqual([]);
  await tick();
  expect(item(id).jev?.status).toBe("pending");
  expect(item(id).jevHistory ?? []).toHaveLength(0);
  await tick();
  expect(item(id).jev?.status).toBe("pass");
});

it("escalates persistent GitHub lookup failures to the owner", async () => {
  env = activeEnv = createFactoryEnv({ jevScript: fixtureJevScript });
  installDoneFixture(env);
  vi.spyOn(env.gh, "commitChecks").mockRejectedValue(new Error("GitHub unavailable"));
  const { id } = await finishReview(true, ReviewPolicy.parse({ jevAttempts: 1 }));
  expect(item(id).jev?.status).toBe("pending");
  await tick();
  expect(item(id).jev?.status).toBe("owner decision");
  expect(env.inbox.find(`inbox:factory-owner-decision:${id}`)?.kind).toBe("owner_decision");
  expect(env.execs.some(({ args }) => args[1] === "done")).toBe(false);
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

it("an unconfigured completion check is skipped and says so", async () => {
  env = activeEnv = createFactoryEnv({ jevScript: null });
  const { id, pr } = await finishReview(true);
  expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
  expect(item(id).jev).toMatchObject({
    status: "not configured",
    reasons: ["Jev not configured, completion check skipped"],
  });
  expect(env.execs.some(({ args }) => args[1] === "done")).toBe(false);
});

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
