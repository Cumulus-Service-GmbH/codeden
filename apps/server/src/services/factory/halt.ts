import { baseBranchOf, budgetSpend, type FactoryContext } from "./context";
import { budgetExceeded } from "./policy";
import { regressionPausePrefix } from "./revert-blocked";

/** A built-in halt an agent cannot clear while its cause still holds. */
export async function resumeBlocker(
  ctx: FactoryContext,
  projectId: string,
): Promise<string | null> {
  const project = ctx.projects.get(projectId);
  const loop = ctx.store.loopOrNew(projectId, ctx.now());
  const reason = loop.pausedReason;
  if (!reason) return null;

  let blocked: string | null = null;
  if (
    reason.startsWith("daily budget reached") ||
    reason.startsWith("daily token budget reached")
  ) {
    blocked = budgetExceeded(
      budgetSpend(ctx, projectId, loop.day, project.factoryLimits),
      project.factoryLimits,
    );
  } else {
    const branch = baseBranchOf(project);
    if (
      reason.startsWith(regressionPausePrefix(branch)) ||
      reason.startsWith(`CI on ${branch} still fails after the automatic `) ||
      reason.startsWith(`${branch} is red and the revert`)
    ) {
      const head = await ctx.github.mainHead(projectId).catch(() => null);
      if (head?.checks !== "success") blocked = reason;
    }
  }
  return blocked ? `Not resumed: ${blocked}. That halt clears when its cause does.` : null;
}
