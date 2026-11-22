import { z } from "zod";
import { Id, JsonValue } from "./common";

const repository = z.string().regex(/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i);

/** The exact repository and gate that an owner can approve. */
export const GitHubApprovalTarget = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("merge_verify"),
    repository,
    pullNumber: z.int().positive(),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
  }),
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

/** The action and full arguments of a step shown on an owner approval card. */
export const PlanApprovalStep = z.strictObject({
  action: Id,
  args: z.record(z.string(), JsonValue),
});
export type PlanApprovalStep = z.infer<typeof PlanApprovalStep>;

/** The ordered steps covered by one approval. */
export const PlanApprovalSteps = z.array(PlanApprovalStep).min(1);
export type PlanApprovalSteps = z.infer<typeof PlanApprovalSteps>;
