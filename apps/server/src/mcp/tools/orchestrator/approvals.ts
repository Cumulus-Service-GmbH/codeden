import { DecideApprovalInput } from "@codeden/contracts";
import { z } from "zod";
import { defineTool } from "../../define";

export const listPendingApprovals = defineTool({
  name: "list_pending_approvals",
  description:
    "List pending approvals across projects and show which are delegable. Owner-only categories are refused for both approval and denial.",
  roles: ["orchestrator"],
  scope: "global",
  input: z.strictObject({}),
  handler: async (_input, { services }) => services.orchestratorApprovals.list(),
});

export const decideApproval = defineTool({
  name: "decide_approval",
  description:
    "Approve once or deny a delegable pending approval on the owner's behalf. Include a reason for the audit history. Both decisions are refused for owner-only categories.",
  roles: ["orchestrator"],
  scope: "session",
  input: DecideApprovalInput,
  handler: async (input, { role, projectId, sessionId, services }) =>
    services.orchestratorApprovals.decide({ role, projectId, sessionId }, input),
});
