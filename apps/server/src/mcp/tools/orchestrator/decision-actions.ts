import { githubPrId, Id, isFactoryMode, messageFrom } from "@codeden/contracts";
import { z } from "zod";
import { defineTool, ToolError } from "../../define";
import { agentSessionOf, githubProject } from "../shared/helpers";

export const resumeSession = defineTool({
  name: "resume_session",
  description: "Resume a stopped agent session via execute_plan_step.",
  roles: ["orchestrator"],
  scope: "project",
  input: z.strictObject({ sessionId: Id, text: z.string().trim().min(1).max(50_000) }),
  handler: async ({ sessionId, text }, { services, projectId }) => {
    const session = agentSessionOf(services, sessionId, projectId);
    if (session.id !== sessionId || session.status !== "stopped") {
      throw new ToolError("A full ID for a stopped agent session is required");
    }
    return services.sessions.send(
      sessionId,
      { input: messageFrom("orchestrator", text), whenBusy: "reject" },
      "orchestrator",
    );
  },
});

export const mergePullRequest = defineTool({
  name: "merge_pull_request",
  description:
    "Merge a reviewed PR on its exact head via execute_plan_step after merge verification passes. Factory projects use their merge queue.",
  roles: ["orchestrator"],
  scope: "project",
  input: z.strictObject({
    pullNumber: z.int().positive(),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
  }),
  handler: async ({ pullNumber, headSha }, { services, projectId }) => {
    const project = githubProject(services, projectId);
    if (isFactoryMode(project.autonomyMode)) {
      throw new ToolError("Factory projects must use the factory merge queue");
    }
    const pr = await services.github.getPrStatus(projectId, pullNumber);
    const verified = pr.checks.checks.some(
      (check) => check.name === "merge-verify" && check.conclusion === "success",
    );
    if (
      pr.state !== "open" ||
      pr.headSha !== headSha ||
      pr.checks.state !== "success" ||
      pr.reviewDecision !== "approved" ||
      !verified
    ) {
      throw new ToolError("The exact PR head must be open, approved, and pass merge verification");
    }
    return services.github.mergePr(githubPrId(projectId, pullNumber), {
      sha: headSha,
      method: "merge",
    });
  },
});
