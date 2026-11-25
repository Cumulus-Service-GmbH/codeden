import {
  type GitHubApprovalTarget,
  type GitHubCommentOutcome,
  OwnerApprovalWords,
} from "@codeden/contracts";
import { ServiceError } from "../errors";
import { type GithubClient, isDefiniteGithubRejection } from "./client";
import { ownerApprovalCheck } from "./owner-approval-check";

function repository(target: GitHubApprovalTarget) {
  const slash = target.repository.indexOf("/");
  return { owner: target.repository.slice(0, slash), repo: target.repository.slice(slash + 1) };
}

export function githubApprovalPort(
  client: GithubClient,
  readKey = async (): Promise<string | null> => null,
) {
  const publishCheck = ownerApprovalCheck(readKey);
  return {
    mergeVerifyMode: publishCheck ? ("check_run" as const) : ("comment" as const),
    async check(target: GitHubApprovalTarget) {
      const repo = repository(target);
      if (target.kind === "merge_verify") {
        const { data } = await client.run((octokit) =>
          octokit.rest.pulls.get({ ...repo, pull_number: target.pullNumber }),
        );
        if (data.state !== "open" || data.head.sha !== target.headSha) {
          throw new ServiceError(409, "stale_approval", "The PR is closed or its head moved");
        }
        return;
      }
      const { data } = await client.run((octokit) =>
        octokit.rest.actions.getPendingDeploymentsForRun({ ...repo, run_id: target.runId }),
      );
      const pending = new Set(data.map(({ environment }) => environment.id));
      if (target.environmentIds.some((id) => !pending.has(id))) {
        throw new ServiceError(
          409,
          "stale_approval",
          "The approved environments are no longer pending",
        );
      }
    },
    async post(
      target: GitHubApprovalTarget,
      cardId: string,
      ownerWords?: string,
    ): Promise<GitHubCommentOutcome> {
      const repo = repository(target);
      if (target.kind === "merge_verify") {
        if (publishCheck) return publishCheck(target, cardId);
        if (ownerWords === undefined)
          throw new ServiceError(403, "decision_refused", "Missing owner words");
        const words = OwnerApprovalWords.safeParse(ownerWords);
        if (!words.success) {
          throw new ServiceError(
            403,
            "decision_refused",
            words.error.issues[0]?.message ?? "Owner words must match the owner words allowlist",
          );
        }
        try {
          await client.runOnce((octokit) =>
            octokit.rest.issues.createComment({
              ...repo,
              issue_number: target.pullNumber,
              body: `OWNER-APPROVED via CodeDen orchestrator: ${target.headSha} ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")} "${ownerWords}"`,
              request: { redirect: "error", signal: AbortSignal.timeout(30_000) },
            }),
          );
        } catch (error) {
          return isDefiniteGithubRejection(error) ? "failed" : "unknown";
        }
      } else {
        await client.run((octokit) =>
          octokit.rest.actions.reviewPendingDeploymentsForRun({
            ...repo,
            run_id: target.runId,
            environment_ids: target.environmentIds,
            state: "approved",
            comment: `Approved by the owner in CodeDen. Decision ${cardId}.`,
          }),
        );
      }
      return "posted";
    },
  };
}
