import { baseBranchOf, budgetSpend, type FactoryContext } from "./context";
import { failureStreakPauseSuffix } from "./outcomes";
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
  if ((loop.state !== "paused" && loop.state !== "stopped") || !reason) return null;

  const branch = baseBranchOf(project);
  const startsWith = (prefix: string) => (text: string) => text.startsWith(prefix);
  const checkCi = async () => {
    const head = await ctx.github.mainHead(projectId).catch(() => null);
    return head?.checks === "success" ? null : reason;
  };
  const checks = [
    {
      matches: isBudgetPause,
      blocked: () =>
        budgetExceeded(
          budgetSpend(ctx, projectId, loop.day, project.factoryLimits),
          project.factoryLimits,
        ),
    },
    { matches: startsWith(regressionPausePrefix(branch)), blocked: checkCi },
    { matches: startsWith(revertBlockedPausePrefix(branch)), blocked: checkCi },
    { matches: startsWith(revertFailedPausePrefix(branch)), blocked: checkCi },
    { matches: (text: string) => text.endsWith(failureStreakPauseSuffix), blocked: () => null },
  ];
  const blocked = await checks.find(({ matches }) => matches(reason))?.blocked();
  return blocked ? `Not resumed: ${blocked}. That halt clears when its cause does.` : null;
}
