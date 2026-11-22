import { GitHubApprovalTarget, Id, PlanApprovalStep, PlanApprovalSteps } from "@codeden/contracts";
import { z } from "zod";
import { defineTool, ToolError } from "../define";
import { projectFor } from "./shared/helpers";

export const raiseGithubApproval = defineTool({
  name: "raise_github_approval",
  description: "Ask the owner to approve a GitHub gate for the exact PR head or workflow run.",
  roles: ["pm"],
  scope: "project",
  input: z.strictObject({ target: GitHubApprovalTarget }),
  handler: async ({ target }, { services, role, sessionId, projectId }) => {
    const repo = services.github.githubRepo(projectId);
    if (target.repository.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) {
      throw new ToolError("The approval must target this project's repository");
    }
    return services.decisions.raise({ role, projectId, sessionId }, projectId, {
      kind: "github",
      target,
    });
  },
});

export const raisePlanApproval = defineTool({
  name: "raise_plan_approval",
  description: "Request approval for an exact, ordered list of protected tool calls.",
  roles: ["pm", "orchestrator"],
  scope: "global",
  input: z.strictObject({ projectId: Id, steps: PlanApprovalSteps }),
  handler: async ({ projectId: target, steps }, { services, role, sessionId, projectId }) => {
    projectFor(services, target);
    return services.decisions.raise({ role, projectId, sessionId }, target, {
      kind: "plan",
      steps,
    });
  },
});

export const confirmPlanApproval = defineTool({
  name: "confirm_plan_approval",
  description: "Confirm an orchestrator's exact plan for this project as its second key.",
  roles: ["pm"],
  scope: "project",
  input: z.strictObject({ cardId: Id }),
  handler: async ({ cardId }, { services, role, sessionId, projectId }) => {
    await services.decisions.confirm(cardId, { role, projectId, sessionId });
    return { confirmed: true };
  },
});

export const executePlanStep = defineTool({
  name: "execute_plan_step",
  description: "Execute the next exact step of your confirmed plan card.",
  roles: ["pm", "orchestrator"],
  scope: "global",
  input: z.strictObject({ cardId: Id, projectId: Id, step: PlanApprovalStep }),
  handler: async ({ cardId, projectId, step }, ctx) => {
    const { sessionId } = ctx;
    if (!sessionId) throw new ToolError("A role session is required");
    const result = await ctx.services.tools.call(
      step.action,
      step.args,
      { ...ctx, sessionId },
      { cardId, projectId },
    );
    if (result.isError) throw new ToolError(result.text);
    return result.text;
  },
});

export const listDecisionCards = defineTool({
  name: "list_decision_cards",
  description:
    "List your decision cards, their confirmation status and the next plan step. PMs see the cards for their project.",
  roles: ["pm", "orchestrator"],
  scope: "global",
  input: z.strictObject({}),
  handler: async (_input, { services, role, sessionId, projectId }) =>
    services.decisions.forRole({ role, sessionId, projectId }),
});

export const postGithubApproval = defineTool({
  name: "post_github_approval",
  description:
    "Post the recorded owner approval to GitHub using an approved card from list_decision_cards.",
  roles: ["pm"],
  scope: "project",
  input: z.strictObject({ cardId: Id }),
  handler: async ({ cardId }, { services, role, sessionId, projectId }) => {
    await services.decisions.postGithub(cardId, { role, sessionId, projectId });
    return { posted: true };
  },
});
