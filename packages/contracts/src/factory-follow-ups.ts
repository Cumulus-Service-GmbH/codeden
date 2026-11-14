import { z } from "zod";
import { GitHubIssueRef } from "./common";

/**
 * Review follow-ups (§10.1, Review and revise): what the reviewer found that doesn't block the
 * pull request and can wait for its own issue. `security.concerns` blocks the merge; a
 * follow-up never does: it fails no merge check and never goes back to the author as a revise
 * round. Once the pull request merges, the dark factory files each one as an issue; the
 * software factory lists them on the item, to file with "File issue".
 */

/** Most follow-ups one verdict may list. */
export const REVIEW_FOLLOW_UPS_MAX = 5;

/** How much a follow-up matters, as the reviewer judged it. */
export const FollowUpSeverity = z.enum(["low", "medium", "high"]);
export type FollowUpSeverity = z.infer<typeof FollowUpSeverity>;

/** One non-blocking finding of a review, as the reviewer submits it. */
export const ReviewFollowUp = z.object({
  /** What to do, specific enough to be an issue title. */
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "What to do later, specific enough to be an issue title, e.g. `Archiving a container session deletes its unpushed commits`",
    ),
  severity: FollowUpSeverity.optional(),
  /** The part of the code it concerns (`runner`, `web`, `auth`). */
  area: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("The part of the code it concerns, e.g. `runner` or `web`"),
});
export type ReviewFollowUp = z.infer<typeof ReviewFollowUp>;

/** The follow-ups of a verdict: a short list, never a reason to hold up the merge. */
export const ReviewFollowUps = z
  .array(ReviewFollowUp)
  .max(REVIEW_FOLLOW_UPS_MAX)
  .describe(
    `Non-blocking: things worth doing that can wait for their own issue (at most ${REVIEW_FOLLOW_UPS_MAX}). They never hold up the merge or go back to the author; once the pull request merges they are tracked as issues.`,
  );

/** A follow-up of a merged item, and the issue that tracks it. */
export const FactoryFollowUp = ReviewFollowUp.extend({
  /**
   * The issue it was filed as, or the open issue with the same title it was matched to; null
   * until it is filed.
   */
  issue: GitHubIssueRef.nullable().default(null),
});
export type FactoryFollowUp = z.infer<typeof FactoryFollowUp>;

/** The body of `POST /api/projects/:id/factory/items/:itemId/follow-ups/file` ("File issue"). */
export const FactoryFileFollowUpRequest = z.object({
  /** Position of the follow-up in the item's `followUps`. */
  index: z.int().nonnegative(),
});
export type FactoryFileFollowUpRequest = z.infer<typeof FactoryFileFollowUpRequest>;

/** Label on the issues filed for review follow-ups (beside the factory's own label). */
export const FOLLOW_UP_LABEL = "codeden-follow-up";

/** Titles that name the same follow-up: case and runs of whitespace don't count. */
export function sameFollowUpTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}
