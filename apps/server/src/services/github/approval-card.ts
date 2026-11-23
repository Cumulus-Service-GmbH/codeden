import type { GitHubApprovalTarget, GitHubCommentOutcome } from "@codeden/contracts";
import { ServiceError } from "../errors";
import { type GithubClient, isDefiniteGithubRejection } from "./client";

function repository(target: GitHubApprovalTarget) {
  const slash = target.repository.indexOf("/");
  return { owner: target.repository.slice(0, slash), repo: target.repository.slice(slash + 1) };
}

export function githubApprovalPort(client: GithubClient) {
  return {
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
        if (!ownerWords?.trim())
          throw new ServiceError(403, "decision_refused", "Missing owner words");
        try {
          await client.runOnce((octokit) =>
            octokit.rest.issues.createComment({
              ...repo,
              issue_number: target.pullNumber,
              body: `OWNER-APPROVED via CodeDen orchestrator: ${target.headSha} ${new Date().toISOString()} "${ownerWords}"`,
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
