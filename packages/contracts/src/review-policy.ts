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
