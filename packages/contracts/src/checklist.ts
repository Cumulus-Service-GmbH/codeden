import { z } from "zod";
import { Id, Timestamp } from "./common";

/** The current state of a project checklist item. */
export const ChecklistStatus = z.enum(["todo", "doing", "done", "blocked"]);
export type ChecklistStatus = z.infer<typeof ChecklistStatus>;

const singleLine = z.string().regex(/^[^\r\n]*$/, "Must be a single line");

/** One task and the time its text or status last changed. */
export const ChecklistItem = z.object({
  id: singleLine.min(1).max(64),
  text: singleLine.min(1).max(500),
  status: ChecklistStatus,
  note: z.string().max(280).optional(),
  sessionIds: z.array(Id).max(200).optional(),
  startPurpose: singleLine.max(300).optional(),
  /** Estimated completion time. */
  eta: Timestamp.optional(),
  /** An owner action needed to continue. */
  needsOwner: z
    .object({
      reason: singleLine.min(1).max(200),
      sessionId: Id.regex(/^[^\r\n]*$/).optional(),
      /** Distinguishes automatic work tracking from a manual request with the same reason. */
      source: z.literal("work").optional(),
    })
    .optional(),
  /** Approval time for an item added to an existing approved checklist. */
  scopeAddition: z.object({ approvedAt: Timestamp }).optional(),
  updatedAt: Timestamp,
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

/** Session-scoped MCP input for checklist progress and PM structural edits. */
export const UpdateChecklistItemInput = z
  .strictObject({
    itemId: ChecklistItem.shape.id,
    /** PM-only task text. Required when adding a new item. */
    text: ChecklistItem.shape.text.optional(),
    status: ChecklistStatus.optional(),
    /** A progress note. For PMs, a nonblank note also supplies replacement text if text is omitted. */
    note: ChecklistItem.shape.note,
    eta: ChecklistItem.shape.eta.unwrap().nullable().optional(),
    needsOwner: ChecklistItem.shape.needsOwner
      .unwrap()
      .omit({ source: true })
      .nullable()
      .optional(),
  })
  .refine(
    ({ text, status, note, eta, needsOwner }) =>
      [text, status, note, eta, needsOwner].some((value) => value !== undefined),
    "Provide text, status, a note, an ETA, or an owner action",
  );

/** A status change, addition (null from), or removal (null to). */
export const ChecklistChange = z.object({
  itemId: ChecklistItem.shape.id,
  text: ChecklistItem.shape.text,
  textBefore: z.string().optional(),
  from: ChecklistStatus.nullable(),
  to: ChecklistStatus.nullable(),
  /** The time of this change. */
  at: Timestamp.optional(),
  /** Whether the item newly needs the owner. */
  needsOwner: z.boolean().optional(),
});
export type ChecklistChange = z.infer<typeof ChecklistChange>;

/** Whether the owner has approved the checklist. */
export const ChecklistState = z.enum(["draft", "approved"]);
export type ChecklistState = z.infer<typeof ChecklistState>;

/** A plan reviewed at the SHA-256 of the UTF-8 JSON task array, with keys ordered id then text. */
export const ReviewedChecklistPlan = z.object({
  sha: z.string().regex(/^[a-f0-9]{64}$/),
  reviewRef: singleLine.min(1).max(500),
  tasks: z
    .array(
      ChecklistItem.pick({ id: true, text: true }).extend({
        text: singleLine
          .min(1)
          .max(300)
          .refine((text) => text.trim().length > 0),
      }),
    )
    .min(1)
    .max(200),
});
export type ReviewedChecklistPlan = z.infer<typeof ReviewedChecklistPlan>;

/** An owner decision waiting in the inbox. */
export const ChecklistProposal = z.object({
  id: Id,
  plan: ReviewedChecklistPlan.optional(),
  kind: z.enum(["approve", "expand"]),
  diff: z.array(ChecklistChange).max(400),
  inboxItemId: Id,
  requestedAt: Timestamp,
  reason: singleLine.max(500).optional(),
  startPurpose: singleLine.max(300).optional(),
  order: z.array(ChecklistItem.shape.id).max(400).optional(),
  /** Metadata to apply only if the proposed additions are approved. */
  additionMetadata: z
    .array(
      ChecklistItem.pick({ id: true, eta: true, note: true }).extend({
        needsOwner: ChecklistItem.shape.needsOwner.unwrap().omit({ source: true }).optional(),
      }),
    )
    .max(200)
    .optional(),
});
export type ChecklistProposal = z.infer<typeof ChecklistProposal>;

/** The current checklist and up to 20 changes from its previous version. */
export const ProjectChecklist = z.object({
  projectId: Id,
  plan: ReviewedChecklistPlan.optional(),
  state: ChecklistState.optional(),
  approvedAt: Timestamp.optional(),
  enforce: z.boolean().optional(),
  pending: ChecklistProposal.optional(),
  items: z.array(ChecklistItem).max(200),
  changes: z.array(ChecklistChange).max(20),
  updatedAt: Timestamp,
});
export type ProjectChecklist = z.infer<typeof ProjectChecklist>;

export const SetChecklistEnforceRequest = z.object({ enforce: z.boolean() });
export const SetChecklistEnforceResponse = ProjectChecklist;
