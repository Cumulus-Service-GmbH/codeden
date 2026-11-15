import type { FactoryLimits } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  fastMergeVerdict,
  isMergeSensitive,
  strictProtectionInboxId,
} from "../src/services/factory/fast-merge";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";
import type { FakePr } from "./support/fake-factory-github";

/**
 * The merge queue's fast policy (#301): a queued PR that is behind main merges on its own green
 * CI when the commits it is missing touch none of its files, and is re-tested against main
 * (update-branch, CI on the new head) when they overlap, when dependency-sensitive files moved,
 * when GitHub's merge state isn't clean, when branch protection wants it up to date, or while
 * CI on main is red. Merges stacked on an unverified main are judged in order.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, backlogItem, review } = factorySteps(() => env);

function start(limits: Partial<FactoryLimits> = {}) {
  env = createFactoryEnv({ limits: { maxConcurrentSessions: 6, ...limits } });
  return enable();
}

/** A feature built until its PR, changing `files` and a test of its own, is in verification. */
async function build(title: string, issue: number, files: string[]) {
  const created = backlogItem(title, issue);
  await tick();
  const builder = item(created.id).builderSessionId as string;
  const pr = env.gh.openPr({
    sessionId: builder,
    title,
    files: [...files, `test/issue-${issue}.test.ts`],
  });
  await env.setStatus(builder, "idle");
  await tick();
  expect(item(created.id).stage).toBe("verifying");
  return { id: created.id, pr };
}

/** Approve each item, oldest first, while the loop holds merges; then let the queue go. */
async function approveInOrder(...ids: string[]) {
  const loop = env.factory.data.loopOrNew(env.project.id);
  env.factory.data.saveLoop({ ...loop, state: "paused", pausedReason: "held by the test" });
  for (const id of ids) {
    review(id);
    await tick();
    later(1_000);
  }
  env.factory.resume(env.project.id);
}

const updated = () => env.gh.updates.map((u) => u.number);
const merged = () => env.gh.merges.map((m) => m.number);
const refusals = (id: string) =>
  Object.keys(item(id).nudges).filter((k) => k.startsWith("refused_"));
const loop = () => env.factory.data.loopOrNew(env.project.id);

describe("which files always re-test", () => {
  it("counts dependency, CI, build, migration and barrel files, and nothing else", () => {
    for (const path of [
      "pnpm-lock.yaml",
      "apps/web/package-lock.json",
      "package.json",
      "pnpm-workspace.yaml",
      ".github/workflows/ci.yml",
      "tsconfig.json",
      "apps/server/tsconfig.build.json",
      "apps/web/vite.config.ts",
      "vitest.config.mts",
      "apps/server/drizzle/0042_fast.sql",
      "db/migrations/001_init.sql",
      "src/db/add-user-migration.ts",
      "prisma/schema.prisma",
      "packages/contracts/src/index.ts",
      "services/api/go.mod",
      "requirements-dev.txt",
      "apps/web/package.json",
      "vendor/custom.lock",
      "go.sum",
    ])
      expect(isMergeSensitive(path), path).toBe(true);
    for (const path of [
      "apps/server/src/services/factory/queue.ts",
      "packages/contracts/src/factory.ts",
      "docs/software-factory.md",
      "src/index.ts",
      "test/config.test.ts",
    ])
      expect(isMergeSensitive(path), path).toBe(false);
  });

  it("merges fast only without a hold, with a clean merge state and nothing overlapping", () => {
    const pr = { files: ["src/a.ts"], mergeState: "clean" as const };
    const main = { behind: 2, files: ["src/b.ts"], complete: true };
    const verdict = (patch: Partial<Parameters<typeof fastMergeVerdict>[0]>) =>
      fastMergeVerdict({ branch: "main", hold: null, pr, main, ...patch });
    expect(verdict({})).toEqual({ fast: true });
    expect(verdict({ pr: { ...pr, mergeState: "has_hooks" } })).toEqual({ fast: true });
    expect(verdict({ hold: "CI on main is red" })).toMatchObject({ fast: false });
    expect(verdict({ pr: { ...pr, mergeState: "behind" } })).toMatchObject({
      fast: false,
      protection: true,
    });
    for (const mergeState of ["blocked", "unstable", "unknown"] as const)
      expect(verdict({ pr: { ...pr, mergeState } })).toMatchObject({ fast: false });
    expect(verdict({ main: { ...main, complete: false } })).toMatchObject({
      reason: "too many changed files to compare",
    });
    expect(verdict({ pr: { ...pr, changedFiles: 3001 } })).toMatchObject({ fast: false });
    // A rename counts its old path: main changed the file the PR moved.
    expect(
      verdict({ pr: { ...pr, files: ["src/c.ts"], renamedFrom: ["src/b.ts"] } }),
    ).toMatchObject({ reason: "overlaps in src/b.ts" });
    expect(verdict({ main: { ...main, files: ["src/a.ts", "src/b.ts"] } })).toMatchObject({
      reason: "overlaps in src/a.ts",
    });
  });
});

describe("the fast merge policy", () => {
  it("merges a PR behind main on its own CI when the new commits touch none of its files", async () => {
    await start();
    const a = await build("Add a counter", 3, ["src/counter.ts", "test/counter.test.ts"]);
    const b = await build("Add a timer", 4, ["src/timer.ts", "test/timer.test.ts"]);
    await approveInOrder(a.id, b.id);
    await tick();
    expect(merged()).toEqual([a.pr.ref.number]);
    expect(item(a.id).mergePath).toBe("current");

    // Main moved (A merged), but nothing B changes: no update-branch and no second CI run.
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number]);
    expect(updated()).toEqual([]);
    expect(item(b.id)).toMatchObject({
      stage: "watching",
      mergePath: "fast",
      note: "Merged on its own CI (no overlap with the 1 new commit on main); watching CI on main",
    });
    expect((await env.factory.status(env.project.id)).stats).toMatchObject({
      fastMerges7d: 1,
      retestedMerges7d: 0,
    });
  });

  it("re-tests a PR that overlaps the new commits on main, then merges it", async () => {
    await start();
    const a = await build("Add a counter", 3, ["src/counter.ts", "test/counter.test.ts"]);
    const b = await build("Count twice", 4, ["src/counter.ts", "test/twice.test.ts"]);
    await approveInOrder(a.id, b.id);
    await tick();
    await tick();
    expect(updated()).toEqual([b.pr.ref.number]);
    expect(merged()).toEqual([a.pr.ref.number]);
    expect(item(b.id).note).toBe(
      "Next to merge: re-testing against main (overlaps in src/counter.ts): updating it (1 commit behind), then CI runs on the new head",
    );
    // CI runs on the new head; it merges once that passes.
    await tick();
    expect(merged()).toHaveLength(1);
    b.pr.checks = "success";
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number]);
    expect(item(b.id).mergePath).toBe("retested");
  });

  it.each<{
    case: string;
    files: string[];
    onMain: string[];
    pr?: Partial<FakePr>;
    why: RegExp;
  }>([
    {
      case: "a lockfile change in the PR",
      files: ["src/timer.ts", "pnpm-lock.yaml"],
      onMain: ["docs/notes.md"],
      why: /it changes pnpm-lock\.yaml, and dependency, build and migration files always re-test/,
    },
    {
      case: "a migration on main",
      files: ["src/timer.ts"],
      onMain: ["apps/server/drizzle/0042_fast.sql"],
      why: /apps\/server\/drizzle\/0042_fast\.sql changed on main/,
    },
    {
      case: "someone else's commit to the same file",
      files: ["src/timer.ts"],
      onMain: ["src/timer.ts"],
      why: /overlaps in src\/timer\.ts/,
    },
    {
      case: "a merge state that isn't clean",
      files: ["src/timer.ts"],
      onMain: ["docs/notes.md"],
      pr: { mergeState: "unstable" },
      why: /GitHub reports its merge state as unstable/,
    },
    {
      case: "more files than GitHub lists",
      files: ["src/timer.ts"],
      onMain: ["docs/notes.md"],
      pr: { changedFiles: 3001 },
      why: /too many changed files to compare/,
    },
  ])("re-tests on $case", async ({ files, onMain, pr, why }) => {
    await start();
    const b = await build("Add a timer", 4, files);
    Object.assign(b.pr, pr ?? {});
    env.gh.pushMain(onMain);
    review(b.id);
    await tick();
    expect(merged()).toEqual([]);
    expect(updated()).toEqual([b.pr.ref.number]);
    expect(item(b.id).note).toMatch(/^Next to merge: re-testing against main \(/);
    expect(item(b.id).note).toMatch(why);
  });

  it("goes strict without counting a refusal when branch protection wants PRs up to date, and says so once", async () => {
    await start();
    env.gh.requireUpToDate = true;
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    env.gh.pushMain(["docs/notes.md"]);
    review(b.id);
    await tick();
    // GitHub reports the merge state `behind`: the strict path, and the user hears why.
    expect(merged()).toEqual([]);
    expect(updated()).toEqual([b.pr.ref.number]);
    expect(item(b.id).note).toMatch(/branch protection requires it to be up to date with main/);
    expect(refusals(b.id)).toEqual([]);
    const notice = env.inbox.find(strictProtectionInboxId(env.project.id));
    expect(notice).toMatchObject({ status: "open", notify: "factory", priority: "low" });
    env.inbox.close(notice as NonNullable<typeof notice>, "dismissed", { note: "seen" });
    b.pr.checks = "success";
    await tick();
    await tick();
    expect(merged()).toEqual([b.pr.ref.number]);
    expect(item(b.id).mergePath).toBe("retested");

    // GitHub's merge state lags and says clean, but it refuses the merge: no refusal counted,
    // the same head goes strict at once, and the notice isn't raised again.
    const c = await build("Add a clock", 5, ["src/clock.ts"]);
    c.pr.mergeState = "clean";
    env.gh.pushMain(["docs/more-notes.md"]);
    review(c.id);
    await tick();
    expect(merged()).toEqual([b.pr.ref.number]);
    expect(updated()).toEqual([b.pr.ref.number, c.pr.ref.number]);
    expect(refusals(c.id)).toEqual([]);
    expect(item(c.id).note).toMatch(
      /GitHub didn't merge it on its own CI: Head branch is out of date/,
    );
    expect(env.inbox.find(strictProtectionInboxId(env.project.id))?.status).toBe("dismissed");
  });

  it("reverts a fast merge that breaks main, then re-tests every PR until main is green", async () => {
    await start();
    const a = await build("Add a counter", 3, ["src/counter.ts"]);
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    const c = await build("Add a clock", 5, ["src/clock.ts"]);
    const d = await build("Add a calendar", 6, ["src/calendar.ts"]);
    await approveInOrder(a.id, b.id, c.id, d.id);
    await tick();
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number]);
    expect(item(b.id).mergePath).toBe("fast");

    // CI on main fails after B: the watch reverts it, pauses the loop and holds fast merges.
    env.gh.commitState.set(item(b.id).mergeSha as string, "failure");
    env.gh.main.checks = "failure";
    await tick();
    expect(item(b.id).stage).toBe("reverted");
    expect(env.gh.reverts.map((r) => r.prNumber)).toEqual([b.pr.ref.number]);
    expect(loop()).toMatchObject({
      state: "paused",
      fastMergeHold: `CI on main failed after #${b.pr.ref.number} merged`,
    });

    // Resumed while main is still red: C doesn't overlap, but it is re-tested anyway.
    env.factory.resume(env.project.id);
    await tick();
    expect(updated()).toEqual([c.pr.ref.number]);
    expect(item(c.id).note).toMatch(/fast merges resume once it is green/);
    c.pr.checks = "success";
    await tick();
    expect(merged()).toContain(c.pr.ref.number);
    expect(item(c.id).mergePath).toBe("retested");

    // Main is green again: D merges on its own CI.
    env.gh.main.checks = "success";
    await tick();
    expect(merged()).toContain(d.pr.ref.number);
    expect(updated()).toEqual([c.pr.ref.number]);
    expect(item(d.id).mergePath).toBe("fast");
    expect(loop().fastMergeHold).toBeNull();
    expect((await env.factory.status(env.project.id)).stats).toMatchObject({
      fastMerges7d: 2,
      retestedMerges7d: 1,
      fastReverts7d: 1,
    });
  });

  it("judges merges stacked on an unverified main in order, and reverts only the one that broke it", async () => {
    await start();
    const a = await build("Add a counter", 3, ["src/counter.ts"]);
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    await approveInOrder(a.id, b.id);
    env.gh.commitState.set(`merge${a.pr.ref.number}`, "pending");
    await tick();
    // CI on main still runs after A: B merges fast on top of it.
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number]);
    expect(item(a.id).stage).toBe("watching");
    expect(item(b.id).nudges[`merged_after_${a.id}`]).toBeDefined();

    // B's CI fails first: it waits for the verdict on A, merged before it.
    env.gh.commitState.set(`merge${b.pr.ref.number}`, "failure");
    await tick();
    expect(item(b.id)).toMatchObject({
      stage: "watching",
      note: `CI on main failed; waiting for the verdict on #${a.pr.ref.number}, merged before it`,
    });
    expect(env.gh.reverts).toEqual([]);

    // A broke main: A is reverted, and B isn't blamed for it.
    env.gh.commitState.set(`merge${a.pr.ref.number}`, "failure");
    await tick();
    await tick();
    expect(env.gh.reverts.map((r) => r.prNumber)).toEqual([a.pr.ref.number]);
    // A's revert merged and main is green: A went back to its builder, still on record as reverted.
    expect(item(a.id).nudges.reverted_at).toBeDefined();
    expect(item(a.id).stage).toBe("building");
    expect(item(b.id).stage).toBe("merged");
    expect(item(b.id).note).toMatch(
      new RegExp(`#${a.pr.ref.number} merged before it, broke it and is being reverted`),
    );
  });
});

describe("the strict merge policy", () => {
  it("always brings a PR behind main up to date first, as before", async () => {
    await start({ mergePolicy: "strict" });
    const a = await build("Add a counter", 3, ["src/counter.ts"]);
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    await approveInOrder(a.id, b.id);
    await tick();
    await tick();
    expect(updated()).toEqual([b.pr.ref.number]);
    expect(item(b.id).note).toBe(
      "Next to merge: updating it with main (1 commit behind), then CI runs on the new head",
    );
    b.pr.checks = "success";
    await tick();
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number]);
    expect(item(b.id).mergePath).toBe("retested");
    expect(loop().fastMergeHold).toBeNull();
  });
});
