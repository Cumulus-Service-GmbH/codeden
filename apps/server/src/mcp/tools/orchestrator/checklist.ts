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
    "Update a project's checklist. Use items to replace it, or patch and/or remove to edit by item ID. New items default to todo and need text. Use null to clear ETA or owner action. Omit an ID in items to generate one. Use requestApproval to ask the owner to approve a draft. Structural edits to an approved checklist wait for an owner decision. Set replacePending to replace an open proposal.",
  roles: ["orchestrator"],
  scope: "global",
  input: z
    .object({
      projectId: Id,
      items: z
        .array(z.object({ id: id.optional(), text, ...progress }))
        .max(200)
        .optional(),
      patch: z
        .array(z.object({ id, text: text.optional(), ...progress }))
        .max(200)
        .optional(),
      remove: z.array(id).max(200).optional(),
      requestApproval: z.boolean().optional(),
      reason: ChecklistProposal.shape.reason,
      replacePending: z.boolean().optional(),
    })
    .refine(({ items, patch, remove, requestApproval }) => {
      const edit = patch !== undefined || remove !== undefined;
      return items !== undefined ? !edit : edit || requestApproval === true;
    }, "Provide items, patch and/or remove, or requestApproval"),
  handler: async (
    { projectId, items, patch, remove, requestApproval, reason, replacePending },
    { services },
  ) => {
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
    "Request owner approval for the exact proposed tasks. The review reference is proposer-supplied and not independently verified. Hash the UTF-8 bytes of ECMAScript JSON.stringify(tasks.map(({ id, text }) => ({ id, text }))) with SHA-256, without escaping non-ASCII characters. An approved revision replaces the pin. Set replacePending only to supersede the current pending proposal.",
  roles: ["orchestrator"],
  scope: "global",
  input: z.object({
    projectId: Id,
    plan: ReviewedChecklistPlan,
    replacePending: z.boolean().optional(),
  }),
  handler: async ({ projectId, plan, replacePending }, { services }) => {
    const { pending } = services.checklist.proposePlan(projectId, plan, replacePending);
    return pending?.plan?.sha === plan.sha
      ? `Plan ${plan.sha} awaits owner approval (${pending.inboxItemId}).`
      : `Plan ${plan.sha} is already approved.`;
  },
});
