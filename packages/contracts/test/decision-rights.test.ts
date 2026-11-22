import { describe, expect, it } from "vitest";
import { GitHubApprovalTarget, PlanApprovalSteps } from "../src";

describe("approval bindings", () => {
  it("round-trips a repository and exact pull request head", () => {
    const target = {
      kind: "merge_verify",
      repository: "owner/repo",
      pullNumber: 10,
      headSha: "a".repeat(40),
    };
    expect(GitHubApprovalTarget.parse(JSON.parse(JSON.stringify(target)))).toEqual(target);
    expect(GitHubApprovalTarget.safeParse({ ...target, headSha: "main" }).success).toBe(false);
  });

  it("binds a release decision to a run and specific environments", () => {
    const target = {
      kind: "environment_release",
      repository: "owner/repo",
      runId: 42,
      environmentIds: [7, 8],
    };
    expect(GitHubApprovalTarget.parse(JSON.parse(JSON.stringify(target)))).toEqual(target);
    expect(GitHubApprovalTarget.safeParse({ ...target, environmentIds: [] }).success).toBe(false);
    expect(GitHubApprovalTarget.safeParse({ ...target, environmentIds: [7, 7] }).success).toBe(
      false,
    );
  });

  it("round-trips the ordered steps with their arguments", () => {
    const steps = [
      { action: "publish", args: { runId: 42 } },
      { action: "verify", args: {} },
    ];
    expect(PlanApprovalSteps.parse(JSON.parse(JSON.stringify(steps)))).toEqual(steps);
    expect(PlanApprovalSteps.safeParse([]).success).toBe(false);
  });
});
