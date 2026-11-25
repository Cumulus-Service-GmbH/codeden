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
    return formatChecklist(services.checklist.get(session.projectId), session);
  },
});

export const updateChecklistItem = defineTool({
  name: "update_checklist_item",
  description:
    "Update a checklist item's status, note, ETA, or owner action. Use null to clear ETA or owner action. PMs can set text or create an item with a new itemId and text in their project. A nonblank PM note also updates existing text when text is omitted. Structural edits to approved checklists require owner approval. Agents can update progress on items linked to their session or their parent session.",
  roles: ["pm", "agent"],
  scope: "session",
  isAvailable: (services, caller, role) =>
    role === "pm" ? !caller || Boolean(caller.projectId) : hasChecklist(services, caller),
  input: UpdateChecklistItemInput,
  handler: async ({ itemId, text, ...change }, { services, sessionId, projectId, role }) => {
    const session = services.sessionRepo.find(sessionId)?.session;
    if (!projectId || !session || session.projectId !== projectId || session.role !== role) {
      throw new ToolError("This tool needs a session in your project");
    }
    if (role === "pm") {
      const previous = services.checklist.get(projectId);
      const noteText = change.note?.replace(/[\r\n]+/g, " ").trim();
      const replacement =
        text ?? (previous?.items.some(({ id }) => id === itemId) ? noteText : undefined);
      if (replacement) {
        const checklist = services.checklist.update(projectId, {
          patch: [{ id: itemId, text: replacement, ...change }],
        });
        const result = formatChecklist(checklist);
        return checklist.pending && checklist.pending.id !== previous?.pending?.id
          ? `${result}\nAn owner card is waiting for a decision (${checklist.pending.inboxItemId}).`
          : result;
      }
    } else if (text !== undefined) {
      throw new ToolError("Only PMs can edit checklist text or add items");
    }
    return formatChecklist(services.checklist.updateItem(projectId, itemId, change, session));
  },
});
