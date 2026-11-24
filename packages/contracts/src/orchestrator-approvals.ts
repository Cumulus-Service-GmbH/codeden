import { z } from "zod";
import { Id, JsonValue, Timestamp } from "./common";
import { GitHubApprovalTarget, PlanApprovalSteps } from "./decision-rights";
import { ApprovalAction } from "./items";

export const CARD_TOKEN =
  /^\[codeden-card v1 scope=([a-z0-9][a-z0-9_.:-]{0,63}) class=(owner-only|delegable)\]( |$)/;

/** Read the single leading token from provider-supplied hook text. Guard cards are always owner-only. */
export function parseCardToken(
  hookReason: string | undefined,
): { scope: string; cls: "owner-only" | "delegable" } | null {
  if (!hookReason || hookReason.indexOf("[codeden-card", 1) !== -1) return null;
  const match = CARD_TOKEN.exec(hookReason);
  const scope = match?.[1];
  const cls = match?.[2];
  return scope && (cls === "owner-only" || cls === "delegable") ? { scope, cls } : null;
}

/**
 * Owner-only operations: (a) production writes and deploys, (b) secrets and credentials,
 * (c) production SAP and database writes, (d) store submissions and external testers,
 * (e) new Azure resources, (f) spending. Unclassified requests fail closed.
 * The `prd_db` category also covers database and host access that requires the owner's card.
 */
export const OwnerOnlyCategory = z.enum([
  "prd_write",
  "secrets",
  "prd_db",
  "store_submission",
  "new_azure_resource",
  "spending",
  "unclassified",
]);
export type OwnerOnlyCategory = z.infer<typeof OwnerOnlyCategory>;

const PendingApprovalKind = z.enum([
  "tool_approval",
  "question",
  "plan_card",
  "github_card",
  "checklist_approval",
  "spec_approval",
]);
const ApprovalId = Id.max(300);
const ApprovalChoice = z.enum(["approve", "deny"]);

/**
 * An open approval and the server's decision about whether the orchestrator can answer it.
 * Plain read-only shell approvals can also be delegated.
 * A delegable plan-mode tool approval has no command or listed paths. Its tool input is absent
 * or a plain object with only the optional `plan` key. Hook, URL, single-use, Chrome consent,
 * and sensitive-text restrictions also apply. PM plan cards are delegable only when every step
 * is tier 0 or 1.
 */
export const PendingApproval = z
  .strictObject({
    id: ApprovalId,
    kind: PendingApprovalKind,
    projectId: Id.nullable(),
    sessionId: Id.nullable(),
    title: z.string(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    reason: z.string().optional(),
    hookReason: z.string().optional(),
    toolName: z.string().optional(),
    toolInput: JsonValue.optional(),
    action: ApprovalAction.optional(),
    steps: PlanApprovalSteps.optional(),
    target: GitHubApprovalTarget.optional(),
    createdAt: Timestamp.optional(),
    delegable: z.boolean(),
    ownerOnly: OwnerOnlyCategory.optional(),
  })
  .refine(({ delegable, ownerOnly }) => delegable === (ownerOnly === undefined), {
    path: ["ownerOnly"],
    message: "An owner-only category is required exactly when the approval is not delegable",
  });
export type PendingApproval = z.infer<typeof PendingApproval>;

/** Open approvals across all projects. */
export const ListPendingApprovalsOutput = z.strictObject({ approvals: z.array(PendingApproval) });
export type ListPendingApprovalsOutput = z.infer<typeof ListPendingApprovalsOutput>;

/** An orchestrator decision and its required rationale. */
export const DecideApprovalInput = z.strictObject({
  id: ApprovalId,
  decision: ApprovalChoice,
  reason: z.string().trim().min(1).max(2000),
});
export type DecideApprovalInput = z.infer<typeof DecideApprovalInput>;

/** A decision accepted and recorded by the server. */
export const DecideApprovalOutput = z.strictObject({
  id: ApprovalId,
  decision: ApprovalChoice,
  decidedAt: Timestamp,
});
export type DecideApprovalOutput = z.infer<typeof DecideApprovalOutput>;

/** Audit of a successful delegation, with its reason redacted before persistence. */
export const OrchestratorApprovalDecision = z.strictObject({
  id: ApprovalId,
  kind: PendingApprovalKind,
  projectId: Id.nullable(),
  sessionId: Id.nullable(),
  orchestratorSessionId: Id,
  decision: ApprovalChoice,
  reason: z.string(),
  title: z.string(),
  at: Timestamp,
  /** The provider tool and SHA-256 of the input recorded on its approval request. */
  toolName: z.string().optional(),
  inputDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type OrchestratorApprovalDecision = z.infer<typeof OrchestratorApprovalDecision>;
