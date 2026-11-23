import { describe, expect, it } from "vitest";
import { checkPlanStep } from "../src/services/plan-approval";

const first = { action: "verify", args: { repository: "owner/repo", pullNumber: 10 } };
const second = { action: "merge", args: { repository: "owner/repo", pullNumber: 10 } };
const steps = [first, second];

describe("plan approval step matching", () => {
  it("allows the exact next step, independent of object property order", () => {
    expect(
      checkPlanStep(steps, 0, {
        action: "verify",
        args: { pullNumber: 10, repository: "owner/repo" },
      }),
    ).toBe(true);
    expect(checkPlanStep(steps, 1, second)).toBe(true);
  });

  it("refuses changed arguments, extra arguments and steps attempted out of order", () => {
    expect(checkPlanStep(steps, 0, { ...first, args: { ...first.args, pullNumber: 11 } })).toBe(
      false,
    );
    expect(checkPlanStep(steps, 0, { ...first, args: { ...first.args, force: true } })).toBe(false);
    expect(checkPlanStep(steps, 0, second)).toBe(false);
  });

  it("refuses a previously consumed step and an exhausted plan", () => {
    expect(checkPlanStep(steps, 1, first)).toBe(false);
    expect(checkPlanStep(steps, 2, second)).toBe(false);
  });
});
