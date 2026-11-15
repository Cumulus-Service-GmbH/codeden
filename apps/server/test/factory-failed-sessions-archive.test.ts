import { join } from "node:path";
import type { FactoryItem, Session } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { sampleSession } from "./helpers";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Issue #411: factory sessions that failed for provider reasons (a CLI too old, a sign-in that
 * expired, a usage limit) were replaced by a fresh session that did the work, but the failed
 * ones were never archived: they stayed in the sidebar as red "Failed" rows long after their
 * items merged. A failed session is archived once its replacement has started, and with its
 * item when the item finishes; a one-time sweep archives the ones left from before. A failed
 * session that is still the item's current one stays, since it needs attention.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, enable, backlogItem, openPr, review } = factorySteps(() => env);

const TOO_OLD = "Gemini CLI 0.36.0 is older than 0.68.0, the oldest CodeDen supports.";

/** One loop step, then the archives it queued. */
const tick = async () => {
  await env.factory.tick(env.project.id);
  await env.factory.archiver.idle();
};
/** Let the background provider detection the first tick started finish. */
const settle = () => new Promise((r) => setImmediate(r));
const session = (id: string) => env.repo.get(id);
const reviewerOf = (id: string) => item(id).reviewerSessionId as string;

/** The runner refused to open the session (its CLI is too old): it failed before it started. */
function refusedOpen(sessionId: string) {
  env.repo.update(sessionId, (s) => ({
    ...s,
    status: "failed",
    startError: { code: "open_failed", message: TOO_OLD, kind: "setup" },
  }));
}

/**
 * A feature PR in verification whose first reviewer, on Gemini, failed to open; the factory
 * started a fresh reviewer on another provider. `cleanWorktree`: the builder's worktree was
 * cleaned up while the item waited, so the reviewers work in worktrees of their own.
 */
async function replacedReviewer(opts: { cleanWorktree?: boolean } = {}) {
  env = createFactoryEnv({ providers: ["claude", "codex", "gemini"] });
  enable("dark_factory", {
    tuning: { builderProvider: "claude", reviewerProvider: "gemini", reviewerFallback: "any" },
  });
  await tick();
  await settle();
  const created = backlogItem("Add a counter", 3);
  await tick();
  const { builder } = await openPr(created.id);
  if (opts.cleanWorktree) {
    env.repo.update(builder, (s) => ({ ...s, worktreeRemovedAt: new Date().toISOString() }));
  }
  await tick();
  const failed = reviewerOf(created.id);
  expect(session(failed).provider).toBe("gemini");
  refusedOpen(failed);
  await tick(); // The failed reviewer is let go...
  await tick(); // ...and a fresh one starts elsewhere.
  const replacement = reviewerOf(created.id);
  expect(replacement).toBeTruthy();
  expect(replacement).not.toBe(failed);
  expect(session(replacement).provider).not.toBe("gemini");
  return { id: created.id, builder, failed, replacement };
}

/** Review, merge and wait out main CI until the item is merged and cleaned up. */
async function mergeAndClean(id: string, replacement: string) {
  review(id);
  await tick();
  await env.setStatus(replacement, "idle");
  for (let n = 0; n < 4 && !item(id).sessionsArchivedAt; n++) await tick();
  expect(item(id).stage).toBe("merged");
  expect(item(id).sessionsArchivedAt).not.toBeNull();
}

describe("failed factory sessions are archived (#411)", () => {
  it("archives a failed reviewer once its replacement has started", async () => {
    const { id, failed, replacement } = await replacedReviewer();
    expect(session(failed).archivedAt).not.toBeNull();
    expect(env.archived).toEqual([failed]);
    // The replacement keeps working, and the item still knows the failed session.
    expect(session(replacement).archivedAt).toBeNull();
    expect(item(id).sessionIds).toEqual(expect.arrayContaining([failed, replacement]));
  });

  it("archives an item's failed sessions when it merges, wherever they worked", async () => {
    const { id, builder, failed, replacement } = await replacedReviewer({ cleanWorktree: true });
    // The reviewers worked in worktrees of their own, not in the builder's.
    expect(session(failed).worktreePath).not.toBeNull();
    expect(session(failed).cwd).not.toBe(session(builder).worktreePath);
    await mergeAndClean(id, replacement);
    expect(session(replacement).archivedAt).not.toBeNull();
    expect(session(builder).archivedAt).not.toBeNull();
    expect(session(failed).archivedAt).not.toBeNull();
    expect(session(failed).worktreeRemovedAt).not.toBeNull();
  });
});

describe("the one-time sweep of failed sessions left from before (#411)", () => {
  const old = "2026-11-14T16:00:00.000Z";
  const meta = { workspaceMode: "worktree", workspaceFallback: null, forced: null } as const;

  /** A factory session as an earlier version left it. */
  function factorySession(id: string, patch: Partial<Session>): string {
    const worktree = join(env.dir, "wt", id);
    env.repo.create(
      {
        ...sampleSession,
        id,
        projectId: env.project.id,
        role: "agent",
        startedBy: FACTORY_STARTER,
        status: "completed",
        cwd: worktree,
        worktreePath: worktree,
        createdAt: old,
        updatedAt: old,
        ...patch,
      },
      { ...meta, queuedBehind: [] },
    );
    return id;
  }

  /** An item as an earlier version left it, its cleanup already done. */
  function oldItem(patch: Partial<FactoryItem>): FactoryItem {
    const created = env.factory.data.createItem({
      projectId: env.project.id,
      workKey: `issue:${patch.issue?.number ?? 1}`,
      title: patch.title ?? "Old work",
      summary: "From before",
      source: "issue",
      stage: "merged",
    });
    return env.factory.data.updateItem(created.id, (i) => ({ ...i, ...patch }), { touch: false });
  }

  it("archives superseded failed sessions and leaves an item's current failed one", async () => {
    env = createFactoryEnv();
    enable();
    const pr = (number: number) => ({
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      state: "merged" as const,
    });
    // A merged item: its builder and the reviewer that approved were archived with it, but
    // the reviewer that failed on its provider before was missed.
    const merged = {
      builder: factorySession("m-builder", { workKey: "issue:243", archivedAt: old }),
      reviewer: factorySession("m-reviewer", { workKey: "factory:review:244", archivedAt: old }),
      failed: factorySession("m-failed", { workKey: "factory:review:244", status: "failed" }),
    };
    oldItem({
      workKey: "issue:243",
      stage: "merged",
      pr: pr(244),
      builderSessionId: merged.builder,
      reviewerSessionId: merged.reviewer,
      sessionIds: Object.values(merged),
      sessionsArchivedAt: old,
      finishedAt: old,
    });
    // A failed item: its builder failed and is still its current session, so it needs
    // attention; an earlier reviewer of it failed and was replaced.
    const stuck = {
      builder: factorySession("f-builder", { workKey: "issue:250", status: "failed" }),
      reviewer: factorySession("f-reviewer", { workKey: "factory:review:251", archivedAt: old }),
      failed: factorySession("f-failed", { workKey: "factory:review:251", status: "failed" }),
    };
    oldItem({
      workKey: "issue:250",
      stage: "failed",
      failureKind: "checks",
      reason: "review: request_changes: still has gaps",
      pr: { ...pr(251), state: "closed" },
      builderSessionId: stuck.builder,
      reviewerSessionId: stuck.reviewer,
      sessionIds: Object.values(stuck),
      sessionsArchivedAt: old,
      finishedAt: old,
    });

    // The first start after the upgrade.
    env.restart();
    await tick();
    expect([...env.archived].sort()).toEqual([merged.failed, stuck.failed].sort());
    expect(session(merged.failed).archivedAt).not.toBeNull();
    expect(session(stuck.failed).archivedAt).not.toBeNull();
    expect(session(stuck.builder).archivedAt).toBeNull();
  });
});
