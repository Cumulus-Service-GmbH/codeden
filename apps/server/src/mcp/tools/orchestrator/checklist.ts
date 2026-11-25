import { ChecklistItem, ChecklistProposal, Id, ReviewedChecklistPlan } from "@codeden/contracts";
import { z } from "zod";
import { formatChecklist } from "../../../services/checklist/checklist-service";
import { defineTool } from "../../define";

const { id, text, status, eta, needsOwner } = ChecklistItem.shape;
const progress = {
  status: status.optional(),
  eta: eta.unwrap().nullable().optional(),
  needsOwner: needsOwner.unwrap().omit({ source: true }).nullable().optional(),
};

export const updateChecklist = defineTool({
  name: "update_checklist",
  description:
    "Update a project's checklist. Use items to replace it in plan order, or patch and/or remove to edit by item ID. New items default to todo and need text. Use null to clear ETA or owner action. Omit an ID in items to generate one. Use requestApproval to ask the owner to approve a draft. Structural edits to an approved checklist wait for an owner decision. Set replacePending to replace an open proposal. In patch, replace sessionIds or workKeys (empty arrays unlink). To mark a linked session LIVE after a healthy install, send installHealthySessionId by itself with projectId.",
  roles: ["orchestrator"],
  scope: "global",
  input: z
    .object({
      projectId: Id,
      installHealthySessionId: Id.optional(),
      items: z
        .array(z.object({ id: id.optional(), text, ...progress }))
        .max(200)
        .optional(),
      patch: z
        .array(
          z.object({
            id,
            text: text.optional(),
            ...progress,
            sessionIds: ChecklistItem.shape.sessionIds,
            workKeys: ChecklistItem.shape.workKeys,
          }),
        )
        .max(200)
        .optional(),
      remove: z.array(id).max(200).optional(),
      requestApproval: z.boolean().optional(),
      reason: ChecklistProposal.shape.reason,
      replacePending: z.boolean().optional(),
    })
    .refine(
      ({
        items,
        patch,
        remove,
        requestApproval,
        installHealthySessionId,
        reason,
        replacePending,
      }) => {
        if (installHealthySessionId !== undefined)
          return [items, patch, remove, requestApproval, reason, replacePending].every(
            (value) => value === undefined,
          );
        const edit = patch !== undefined || remove !== undefined;
        return items !== undefined ? !edit : edit || requestApproval === true;
      },
      "Provide checklist edits, requestApproval, or an install-health report",
    ),
  handler: async (
    {
      projectId,
      items,
      patch,
      remove,
      requestApproval,
      reason,
      replacePending,
      installHealthySessionId,
    },
    { services },
  ) => {
    if (installHealthySessionId !== undefined) {
      return formatChecklist(
        services.checklist.reportInstallHealthy(projectId, installHealthySessionId),
      );
    }
    const previous = services.checklist.get(projectId)?.pending?.id;
    const checklist = services.checklist.update(projectId, items ? { items } : { patch, remove }, {
      requestApproval,
      reason,
      replacePending,
    });
    const result = formatChecklist(checklist);
    return checklist.pending && checklist.pending.id !== previous
      ? `${result}\nAn owner card is waiting for a decision (${checklist.pending.inboxItemId}).`
      : result;
  },
});

export const proposeChecklistPlan = defineTool({
  name: "propose_checklist_plan",
  description:
    "After plan review, request owner approval for the exact reviewed tasks. Supply the review receipt reference and SHA-256 of the UTF-8 JSON array of task objects with keys id then text and no extra whitespace. An approved revision replaces the pin; only its scope diff needs approval.",
  roles: ["orchestrator"],
  scope: "global",
  input: z.object({ projectId: Id, plan: ReviewedChecklistPlan }),
  handler: async ({ projectId, plan }, { services }) => {
    const { pending } = services.checklist.proposePlan(projectId, plan);
    return pending?.plan?.sha === plan.sha
      ? `Plan ${plan.sha} awaits owner approval (${pending.inboxItemId}).`
      : `Plan ${plan.sha} is already approved.`;
  },
});
