import { describe, expect, it } from "vitest";
import { GitHubApprovalTarget, MergeVerifyOwnerApproval, PlanApprovalSteps } from "../src";

describe("approval bindings", () => {
  it("round-trips an owner decision bound to an exact PR head", () => {
    const record = {
      kind: "merge_verify",
      repository: "owner/repo",
      pullNumber: 10,
      headSha: "a".repeat(40),
      decisionId: "d13a65ee-becf-4976-b1fa-06dd11052ac5",
    };
    expect(MergeVerifyOwnerApproval.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(MergeVerifyOwnerApproval.safeParse({ ...record, headSha: "main" }).success).toBe(false);
    expect(MergeVerifyOwnerApproval.safeParse({ ...record, decisionId: "" }).success).toBe(false);
  });

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
