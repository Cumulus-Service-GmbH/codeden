import { z } from "zod";
import { Id, Timestamp } from "./common";

/** Optional tracking issue, independently configurable for each project. */
export const TechDebtIssue = z
  .string()
  .trim()
  .regex(/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+#[1-9]\d{0,14}$/i);

/** A LOW review finding, with nullable metadata for older issue entries. */
export const TechDebtFindingInput = z.object({
  location: z.string().trim().min(1).max(500).regex(/:\d+$/),
  text: z.string().trim().min(1).max(4000),
  receipt: z.string().trim().min(1).max(1000).nullable(),
  date: Timestamp,
  pr: z.string().trim().min(1).max(500).nullable(),
});
/** A LOW review finding before it is stored in the ledger. */
export type TechDebtFindingInput = z.infer<typeof TechDebtFindingInput>;

/** Local state and the source identity used to synchronize an imported checklist entry. */
export const TechDebtFinding = TechDebtFindingInput.extend({
  id: Id,
  source: TechDebtIssue.nullable(),
  status: z.enum(["open", "in_progress", "fixed", "dismissed"]),
  reason: z.string().nullable(),
  /** Evidence for the resolution, separate from the original review receipt. */
  resolutionReceipt: z.string().nullable().optional(),
  sessionId: Id.nullable(),
});
export type TechDebtFinding = z.infer<typeof TechDebtFinding>;

/** The project settings and durable findings read by the panel and MCP. */
export const TechDebtView = z.object({
  projectId: Id,
  issue: TechDebtIssue.nullable(),
  imported: z.boolean(),
  findings: z.array(TechDebtFinding),
  importError: z.string().optional(),
  /** The issue whose failed read is reported by importError and retried on list. */
  importErrorIssue: TechDebtIssue.optional(),
});
export type TechDebtView = z.infer<typeof TechDebtView>;

/** Updates from the project panel or a local review hand-off. */
export const TechDebtAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), issue: TechDebtIssue.nullable() }),
  z.object({ action: z.literal("record"), finding: TechDebtFindingInput }),
  z.object({
    action: z.literal("fix"),
    ids: z
      .array(Id)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
  z.object({ action: z.literal("fixed"), id: Id }),
  z.object({ action: z.literal("dismiss"), id: Id, reason: z.string().trim().min(1).max(1000) }),
]);
export type TechDebtAction = z.infer<typeof TechDebtAction>;

/** A failed import leaves the local view available and can be retried. */
export const TechDebtList = TechDebtView;
export type TechDebtList = z.infer<typeof TechDebtList>;

/** The open LOW count and most recent import error for a project. */
export const TechDebtSummary = z.object({
  projectId: Id,
  open: z.int().nonnegative(),
  importError: z.string().optional(),
});
/** The open LOW count and most recent import error for a project. */
export type TechDebtSummary = z.infer<typeof TechDebtSummary>;

/** Counts for every active project. */
export const TechDebtSummaries = z.array(TechDebtSummary);

/** One LOW review finding and its evidence, optionally with its original date and PR. */
const RecordTechDebtRow = z.strictObject({
  location: TechDebtFindingInput.shape.location,
  text: TechDebtFindingInput.shape.text,
  receipt: TechDebtFindingInput.shape.receipt.unwrap(),
  severity: z.literal("LOW").default("LOW"),
  date: Timestamp.optional(),
  pr: TechDebtFindingInput.shape.pr.optional(),
});

/** MCP input for merging a GitHub tracking issue into a project ledger. */
export const ImportTechDebtInput = z.strictObject({
  projectId: Id.optional(),
  issue: TechDebtIssue,
});

/** MCP input for recording one finding or up to 500 findings in one project. */
export const RecordTechDebtInput = z.union([
  RecordTechDebtRow.extend({ projectId: Id.optional() }),
  z.strictObject({
    projectId: Id.optional(),
    findings: z.array(RecordTechDebtRow).min(1).max(500),
  }),
]);

const resolution = {
  status: z.enum(["fixed", "dismissed"]),
  reason: z.string().trim().min(1).max(1000),
  receipt: TechDebtFindingInput.shape.receipt.unwrap(),
};

/** A resolution with the target ID and evidence for that finding. */
export const TechDebtResolution = z.strictObject({ id: Id, ...resolution });
export type TechDebtResolution = z.infer<typeof TechDebtResolution>;

/** MCP input for applying a shared disposition or individual dispositions in one project. */
export const ResolveTechDebtInput = z.union([
  z.strictObject({ projectId: Id.optional(), ids: z.array(Id).min(1).max(500), ...resolution }),
  z.strictObject({
    projectId: Id.optional(),
    resolutions: z.array(TechDebtResolution).min(1).max(500),
  }),
]);

/** Audit payload for one closed finding, including legacy UI actions without a receipt. */
export const TechDebtResolutionAudit = TechDebtResolution.extend({
  projectId: Id,
  reason: resolution.reason.nullable(),
  receipt: resolution.receipt.nullable(),
});

const count = z.int().nonnegative();

/** Number of findings created and number skipped as duplicates by a record call. */
export const RecordTechDebtCounts = z.strictObject({ recorded: count, duplicates: count });
/** Number of issue entries imported and number skipped as duplicates by an import call. */
export const ImportTechDebtCounts = z.strictObject({ imported: count, duplicates: count });
/** Disposition counts for entries in a resolution call, with no finding data. */
export const ResolveTechDebtCounts = z.strictObject({
  resolved: count,
  unknown: count,
  alreadyResolved: count,
});
