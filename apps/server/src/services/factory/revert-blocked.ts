import type { FactoryItem, FactoryLoop, Project } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { baseBranchOf, type FactoryContext, pauseLoop, raiseInbox } from "./context";
import { failItem } from "./outcomes";

/**
 * A revert that can't merge (§10.1, Merge): the default branch stays red, so the user hears it
 * once, clearly. Kept apart from `revert.ts` so the conflict and failure paths can use it without
 * import cycles.
 */

/**
 * Inbox id of a regression on the default branch, by the item whose merge broke it: raised when
 * the revert opens, updated when the revert can't merge, resolved once it merged and CI is green.
 */
export const regressionInboxId = (itemId: string) => `inbox:factory-regression:${itemId}`;

/** How the loop's pause reason starts while a regression holds it (then the merge's PR number). */
export const regressionPausePrefix = (branch: string) => `CI on ${branch} failed after merging #`;

/**
 * The revert can't merge (CI red on it too, conflicts no agent resolved, its checks failed, or
 * the agent writing it gave up): the revert item fails as stuck, the regression's inbox item
 * becomes "<branch> is red and the revert can't merge: <reason>", the revert PR says so, and the
 * loop stays paused for a person. Never a revise round, and never counted towards the pause.
 */
export async function revertBlocked(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  reason: string,
): Promise<FactoryLoop> {
  const branch = baseBranchOf(project);
  const title = `${branch} is red and the revert can't merge: ${reason}`;
  const next = failItem(ctx, loop, item, title, { kind: "stuck", countsAsFailure: false });
  const original = item.revertOf ? ctx.store.item(item.revertOf) : undefined;
  const merged = original?.pr ? `#${original.pr.number}` : "the merge";
  const revert = item.pr ? ` #${item.pr.number}` : "";
  raiseInbox(ctx, {
    id: regressionInboxId(original?.id ?? item.id),
    kind: "run_failed",
    notify: "failure",
    priority: "high",
    projectId: project.id,
    issue: item.issue,
    pr: item.pr,
    title,
    body: `CI on ${branch} failed after ${merged} merged, and the automatic revert${revert} can't merge: ${reason}. The factory loop stays paused: get ${branch} green (fix or merge the revert yourself, or revert ${merged} by hand), then resume the loop.`,
  });
  if (item.pr) {
    await ctx.github
      .comment(
        project.id,
        item.pr.number,
        `\`${branch}\` is red and the CodeDen factory can't merge this revert: ${reason}. Its loop stays paused until a person gets \`${branch}\` green and resumes it.`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  return pauseLoop(ctx, next, title, { inbox: false });
}
