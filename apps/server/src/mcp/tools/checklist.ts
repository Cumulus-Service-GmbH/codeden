import { ChecklistItem, Id } from "@codeden/contracts";
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
    "Update a checklist item's status, note, ETA, or owner action. Use null to clear ETA or owner action. PMs can update their project's items, replace sessionIds or workKeys (empty arrays unlink), or report a linked session LIVE after a healthy install. An install report updates all items linked to that session. Agents can update items linked to their session or their parent session.",
  roles: ["pm", "agent"],
  scope: "session",
  isAvailable: hasChecklist,
  input: z
    .strictObject({
      itemId: ChecklistItem.shape.id,
      status: ChecklistItem.shape.status.optional(),
      note: ChecklistItem.shape.note,
      sessionIds: ChecklistItem.shape.sessionIds,
      workKeys: ChecklistItem.shape.workKeys,
      installHealthySessionId: Id.optional(),
      eta: ChecklistItem.shape.eta.unwrap().nullable().optional(),
      needsOwner: ChecklistItem.shape.needsOwner
        .unwrap()
        .omit({ source: true })
        .nullable()
        .optional(),
    })
    .refine(
      ({ itemId: _itemId, ...changes }) =>
        Object.values(changes).some((value) => value !== undefined),
      "Provide progress, links, or an install-health report",
    ),
  handler: async (
    { itemId, installHealthySessionId, ...change },
    { services, sessionId, projectId, role },
  ) => {
    const session = services.sessionRepo.find(sessionId)?.session;
    if (!projectId || !session || session.projectId !== projectId || session.role !== role) {
      throw new ToolError("This tool needs a session in your project");
    }
    if (installHealthySessionId !== undefined) {
      if (role !== "pm") throw new ToolError("Only the project manager can report install health");
      if (Object.values(change).some((value) => value !== undefined)) {
        throw new ToolError("Report install health as a separate update");
      }
      return formatChecklist(
        services.checklist.reportInstallHealthy(projectId, installHealthySessionId, itemId),
      );
    }
    return formatChecklist(services.checklist.updateItem(projectId, itemId, change, session));
  },
});
