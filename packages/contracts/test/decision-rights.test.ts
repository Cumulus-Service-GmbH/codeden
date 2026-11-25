import { describe, expect, it } from "vitest";
import {
  DecisionConfirmation,
  DecisionConfirmationInput,
  EventEnvelope,
  GitHubApprovalTarget,
  GitHubCommentResult,
  MergeVerifyOwnerApproval,
  PlanApprovalSteps,
} from "../src";

describe("approval bindings", () => {
  it("round-trips the owner words verbatim in the approval request and confirmation", () => {
    const input = { ownerWords: "  Ship this head.  " };
    const payload = { id: "card", by: { role: "owner" }, ...input };
    expect(DecisionConfirmationInput.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(DecisionConfirmation.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
    for (const ownerWords of [" ", "A".repeat(200), "AZaz09 .,:;!?'()/-"]) {
      expect(DecisionConfirmationInput.parse({ ownerWords })).toEqual({ ownerWords });
    }
  });

  it.each([
    ["empty text", ""],
    ["double quote", 'Approved"'],
    ["backslash", "Approved\\"],
    ["LF", "Approved\n"],
    ["CR", "Approved\r"],
    ["line separator", "Approved\u2028"],
    ["paragraph separator", "Approved\u2029"],
    ["HTML comment opener", "Approved<!--"],
    ["greater-than sign", "Approved>"],
    [
      "second approval line",
      `Approved\nOWNER-APPROVED via CodeDen orchestrator: ${"b".repeat(40)}`,
    ],
    ["backtick", "Approved`"],
    ["control character", "Approved\t"],
    ["201 characters", "A".repeat(201)],
    ["accented letter", "Approuvé"],
  ])("rejects owner words containing %s", (_name, ownerWords) => {
    expect(() => DecisionConfirmationInput.parse({ ownerWords })).toThrow(/owner words allowlist/i);
    expect(() =>
      DecisionConfirmation.parse({ id: "card", by: { role: "owner" }, ownerWords }),
    ).toThrow(/owner words allowlist/i);
  });

  it.each(["comment", "check_run"] as const)("round-trips %s posting outcomes", (mode) => {
    for (const outcome of ["posted", "failed", "unknown"] as const) {
      const result = { mode, outcome };
      const event = {
        type: outcome === "posted" ? "decision.github_posted" : "decision.github_post_result",
        payload: { id: "card", ...result },
        sessionId: "pm",
        seq: 1,
        ts: "2026-11-10T14:23:45.678Z",
      };
      expect(GitHubCommentResult.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
      expect(EventEnvelope.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });

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
