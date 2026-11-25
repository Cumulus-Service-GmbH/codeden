import { UpdateChecklistItemInput } from "@codeden/contracts";
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
    return formatChecklist(services.checklist.get(session.projectId, "plan"), session);
  },
});

export const updateChecklistItem = defineTool({
  name: "update_checklist_item",
  description:
    "Update a checklist item's status, progress note, ETA, or owner action. Use null to clear ETA or owner action. PMs can set task text or create an item with a new itemId and text in their project. Structural edits to approved checklists require owner approval. PMs can also replace sessionIds or workKeys (empty arrays unlink), or separately report a linked session healthy after install. Agents can update progress on items linked to their session or their parent session.",
  roles: ["pm", "agent"],
  scope: "session",
  isAvailable: (services, caller, role) =>
    role === "pm" ? !caller || Boolean(caller.projectId) : hasChecklist(services, caller),
  input: UpdateChecklistItemInput,
  handler: async (
    { itemId, text, installHealthySessionId, ...change },
    { services, sessionId, projectId, role },
  ) => {
    const session = services.sessionRepo.find(sessionId)?.session;
    if (!projectId || !session || session.projectId !== projectId || session.role !== role) {
      throw new ToolError("This tool needs a session in your project");
    }
    if (installHealthySessionId !== undefined) {
      if (role !== "pm") throw new ToolError("Only the project manager can report install health");
      if (text !== undefined || Object.values(change).some((value) => value !== undefined)) {
        throw new ToolError("Report install health as a separate update");
      }
      return formatChecklist(
        services.checklist.reportInstallHealthy(projectId, installHealthySessionId, itemId),
        session,
      );
    }
    if (text !== undefined) {
      if (role !== "pm") throw new ToolError("Only PMs can edit checklist text or add items");
      if (change.sessionIds !== undefined || change.workKeys !== undefined) {
        throw new ToolError("Edit checklist links as a separate update");
      }
      const previous = services.checklist.get(projectId);
      const pending = previous?.pending;
      if (
        pending &&
        !pending.plan &&
        previous.items.find(({ id }) => id === itemId)?.text !== text
      ) {
        throw new ToolError(
          `Checklist card ${pending.inboxItemId} is already open. Wait for the owner to decide.`,
        );
      }
      const checklist = services.checklist.update(projectId, {
        patch: [{ id: itemId, text, ...change }],
      });
      const result = formatChecklist(checklist, session);
      return checklist.pending && checklist.pending.id !== previous?.pending?.id
        ? `${result}\nAn owner card is waiting for a decision (${checklist.pending.inboxItemId}).`
        : result;
    }
    return formatChecklist(
      services.checklist.updateItem(projectId, itemId, change, session),
      session,
    );
  },
});
