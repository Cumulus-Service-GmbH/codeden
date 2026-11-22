import { ChecklistItem } from "@codeden/contracts";
import { z } from "zod";
import { formatChecklist } from "../../services/checklist/checklist-service";
import type { AppServices } from "../../services/container";
import { defineTool, type ToolAvailabilityContext, ToolError } from "../define";

export function hasChecklist(services: AppServices, caller?: ToolAvailabilityContext): boolean {
  return !caller?.projectId || services.checklist.get(caller.projectId) !== undefined;
}

export const readChecklist = defineTool({
  name: "read_checklist",
  description: "Read your project's checklist, completion, and items linked to your session.",
  roles: ["pm", "agent"],
  scope: "session",
  input: z.strictObject({}),
  isAvailable: (services, caller) => {
    if (!caller) return true;
    const projectId =
      caller.sessionId && services.sessionRepo.find(caller.sessionId)?.session.projectId;
    return Boolean(projectId && services.checklist.get(projectId));
  },
  handler: async (_input, { services, sessionId, role }) => {
    const session = services.sessionRepo.find(sessionId)?.session;
    if (!session?.projectId || session.role !== role) {
      throw new ToolError("This tool needs a session in your project");
    }
    return formatChecklist(services.checklist.get(session.projectId), session);
  },
});

export const updateChecklistItem = defineTool({
  name: "update_checklist_item",
  description:
    "Update a checklist item's status, note, ETA, or owner action. Use null to clear ETA or owner action. PMs can update their project's items. Agents can update items linked to their session or their parent session.",
  roles: ["pm", "agent"],
  scope: "session",
  isAvailable: hasChecklist,
  input: z
    .strictObject({
      itemId: ChecklistItem.shape.id,
      status: ChecklistItem.shape.status.optional(),
      note: ChecklistItem.shape.note,
      eta: ChecklistItem.shape.eta.unwrap().nullable().optional(),
      needsOwner: ChecklistItem.shape.needsOwner
        .unwrap()
        .omit({ source: true })
        .nullable()
        .optional(),
    })
    .refine(
      ({ status, note, eta, needsOwner }) =>
        status !== undefined || note !== undefined || eta !== undefined || needsOwner !== undefined,
      "Provide a status, note, ETA, or owner action",
    ),
  handler: async ({ itemId, ...change }, { services, sessionId, projectId, role }) => {
    const session = services.sessionRepo.find(sessionId)?.session;
    if (!projectId || !session || session.projectId !== projectId || session.role !== role) {
      throw new ToolError("This tool needs a session in your project");
    }
    return formatChecklist(services.checklist.updateItem(projectId, itemId, change, session));
  },
});
