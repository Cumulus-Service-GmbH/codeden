import { z } from "zod";

/** Per-review limits and the optional daily review spend limit in USD. */
export const ReviewPolicy = z.object({
  reviewerRounds: z.int().positive().default(2),
  jevRounds: z.int().positive().default(1),
  arbiterRounds: z.int().positive().default(1),
  jevAttempts: z.int().positive().default(3),
  totalRounds: z.int().positive().default(8),
  dailyBudgetUsd: z.number().positive().optional(),
});
export type ReviewPolicy = z.infer<typeof ReviewPolicy>;

/** How the project handles in-scope LOW findings. */
export const LowFindingPolicy = z.enum(["fix", "defer"]);
export type LowFindingPolicy = z.infer<typeof LowFindingPolicy>;

/** A finding as submitted before evidence validation. */
export const ReviewFindingInput = z.object({
  location: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
  failure_scenario: z.string().trim().optional(),
  repro: z.string().trim().optional(),
});

/** A consequential finding requires both a concrete failure scenario and a repro. */
export const ReviewFinding = ReviewFindingInput.transform((finding) => ({
  ...finding,
  severity: finding.failure_scenario && finding.repro ? finding.severity : ("LOW" as const),
}));
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/** The approved plan and its repository-relative path scope, pinned for a review. */
export const ReviewAcceptanceSpec = z
  .object({
    planSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    scope: z.array(z.string().trim().min(1)).min(1),
    security: z.boolean().default(false),
    threatModel: z.string().trim().min(1).optional(),
  })
  .refine((spec) => !spec.security || spec.threatModel !== undefined, {
    path: ["threatModel"],
    message: "Security reviews require a threat model",
  });
export type ReviewAcceptanceSpec = z.input<typeof ReviewAcceptanceSpec>;

/** App-side state of the escalation for a pinned review head. */
export const ReviewArbitration = z.object({
  head: z.string(),
  state: z.enum(["running", "ruling", "confirming", "jev_pending", "blocked"]),
  sessionId: z.string().optional(),
  ruling: z.string().optional(),
  confirmation: z.string().optional(),
});
export type ReviewArbitration = z.infer<typeof ReviewArbitration>;
