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

/** Proposed tasks bound to the SHA-256 of the UTF-8 JSON.stringify task array with keys id then text. */
export const ReviewedChecklistPlan = z.object({
  sha: z.string().regex(/^[a-f0-9]{64}$/),
  /** Proposer-supplied reference. The owner approves the digest and tasks. */
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
      ChecklistItem.pick({ id: true, eta: true }).extend({
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
