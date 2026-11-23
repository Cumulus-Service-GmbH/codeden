import { isDeepStrictEqual } from "node:util";
import type { PlanApprovalStep } from "@codeden/contracts";

/** Match the next unconsumed step against the owner's approved plan. */
export function checkPlanStep(
  approvedSteps: readonly PlanApprovalStep[],
  nextIndex: number,
  attemptedStep: PlanApprovalStep,
): boolean {
  return isDeepStrictEqual(approvedSteps[nextIndex], attemptedStep);
}
