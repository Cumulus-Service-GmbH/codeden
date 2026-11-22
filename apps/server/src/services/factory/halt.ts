import { baseBranchOf, budgetSpend, type FactoryContext } from "./context";
import { budgetExceeded, isBudgetPause } from "./policy";
import { regressionPausePrefix, revertBlockedPausePrefix } from "./revert-blocked";
import { revertFailedPausePrefix } from "./revert-watch";

/** A built-in halt an agent cannot clear while its cause still holds. */
export async function resumeBlocker(
  ctx: FactoryContext,
  projectId: string,
): Promise<string | null> {
  const project = ctx.projects.get(projectId);
  const loop = ctx.store.loopOrNew(projectId, ctx.now());
  const reason = loop.pausedReason;
  if (loop.state !== "paused" || !reason) return null;

  let blocked: string | null = null;
  if (isBudgetPause(reason)) {
    blocked = budgetExceeded(
      budgetSpend(ctx, projectId, loop.day, project.factoryLimits),
      project.factoryLimits,
    );
  } else {
    const branch = baseBranchOf(project);
    if (
      reason.startsWith(regressionPausePrefix(branch)) ||
      reason.startsWith(revertFailedPausePrefix(branch)) ||
      reason.startsWith(revertBlockedPausePrefix(branch))
    ) {
      const head = await ctx.github.mainHead(projectId).catch(() => null);
      if (head?.checks !== "success") blocked = reason;
    }
  }
  return blocked ? `Not resumed: ${blocked}. That halt clears when its cause does.` : null;
}
