import { ChecklistItem, Id } from "@codeden/contracts";
import { z } from "zod";
import { formatChecklist } from "../../../services/checklist/checklist-service";
import { defineTool } from "../../define";

const { id, text, status } = ChecklistItem.shape;

export const updateChecklist = defineTool({
  name: "update_checklist",
  description:
    "Update a project's checklist. Use items to replace it, or patch and/or remove to edit by item ID. New items default to todo and need text. Omit an ID in items to generate one.",
  roles: ["orchestrator"],
  scope: "global",
  input: z
    .object({
      projectId: Id,
      items: z
        .array(z.object({ id: id.optional(), text, status: status.optional() }))
        .max(200)
        .optional(),
      patch: z
        .array(z.object({ id, text: text.optional(), status: status.optional() }))
        .max(200)
        .optional(),
      remove: z.array(id).max(200).optional(),
    })
    .refine(
      ({ items, patch, remove }) =>
        (items !== undefined) !== (patch !== undefined || remove !== undefined),
      "Provide either items or patch and/or remove",
    ),
  handler: async ({ projectId, items, patch, remove }, { services }) =>
    formatChecklist(services.checklist.update(projectId, items ? { items } : { patch, remove })),
});
