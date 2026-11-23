import { z } from "zod";
import { Id, JsonValue } from "./common";

const repository = z.string().regex(/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i);
const mergeVerifyTarget = z.strictObject({
  kind: z.literal("merge_verify"),
  repository,
  pullNumber: z.int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
});

/** The exact repository and gate that an owner can approve. */
export const GitHubApprovalTarget = z.discriminatedUnion("kind", [
  mergeVerifyTarget,
  z.strictObject({
    kind: z.literal("environment_release"),
    repository,
    runId: z.int().positive(),
    environmentIds: z
      .array(z.int().positive())
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, "Environment IDs must be unique"),
  }),
]);
export type GitHubApprovalTarget = z.infer<typeof GitHubApprovalTarget>;

/** JSON payload in a codeden-owner-approval:v1 PR comment, tied to one owner decision. */
export const MergeVerifyOwnerApproval = mergeVerifyTarget.extend({ decisionId: z.uuid() });

/** The action and full arguments of a step shown on an owner approval card. */
export const PlanApprovalStep = z.strictObject({
  action: Id,
  args: z.record(z.string(), JsonValue),
});
export type PlanApprovalStep = z.infer<typeof PlanApprovalStep>;

/** The ordered steps covered by one approval. */
export const PlanApprovalSteps = z.array(PlanApprovalStep).min(1);
export type PlanApprovalSteps = z.infer<typeof PlanApprovalSteps>;

/** Decision tiers for protected operations at the agent tool boundary. */
export const decisionTiers = {
  get_project_status: 0,
  pause_automation: 0,
  start_session: 0,
  raise_github_approval: 0,
  resume_automation: 1,
  resume_session: 1,
  stop_session: 1,
  merge_pull_request: 1,
  update_project: 1,
  production: 2,
  migrate: 2,
  provision: 2,
  install: 2,
  github_approval: 2,
  secrets: 2,
} as const;

export const DecisionRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("github"), target: GitHubApprovalTarget }),
  z.strictObject({ kind: z.literal("plan"), steps: PlanApprovalSteps }),
]);
export type DecisionRequest = z.infer<typeof DecisionRequest>;

export const DecisionCard = z.strictObject({
  id: Id,
  projectId: Id,
  sessionId: Id,
  requestedBy: z.enum(["pm", "orchestrator"]),
  request: DecisionRequest,
});
export type DecisionCard = z.infer<typeof DecisionCard>;

export const DecisionConfirmation = z.strictObject({
  id: Id,
  by: z.discriminatedUnion("role", [
    z.strictObject({ role: z.literal("owner") }),
    z.strictObject({ role: z.literal("pm"), sessionId: Id }),
    z.strictObject({ role: z.literal("orchestrator"), sessionId: Id }),
  ]),
});

/** A PM plan card declined by the orchestrator. */
export const OrchestratorDecisionDenial = z.strictObject({
  id: Id,
  by: z.strictObject({ role: z.literal("orchestrator"), sessionId: Id }),
});
