import { z } from "zod";
import { Id, Timestamp } from "./common";

/** The current state of a project checklist item. */
export const ChecklistStatus = z.enum(["todo", "doing", "done", "blocked"]);
export type ChecklistStatus = z.infer<typeof ChecklistStatus>;

/** One task and the time its text or status last changed. */
export const ChecklistItem = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
  status: ChecklistStatus,
  updatedAt: Timestamp,
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

/** A status change, addition (null from), or removal (null to). */
export const ChecklistChange = z.object({
  itemId: ChecklistItem.shape.id,
  text: ChecklistItem.shape.text,
  from: ChecklistStatus.nullable(),
  to: ChecklistStatus.nullable(),
});
export type ChecklistChange = z.infer<typeof ChecklistChange>;

/** The current checklist and up to 20 changes from its previous version. */
export const ProjectChecklist = z.object({
  projectId: Id,
  items: z.array(ChecklistItem).max(200),
  changes: z.array(ChecklistChange).max(20),
  updatedAt: Timestamp,
});
export type ProjectChecklist = z.infer<typeof ProjectChecklist>;
