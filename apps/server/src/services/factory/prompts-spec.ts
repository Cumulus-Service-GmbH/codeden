import type { FactoryItem } from "@codeden/contracts";

/**
 * Prompts of the optional spec approval (§10.1, `spec-approval.ts`): what the builder hears while
 * a person approves its spec, and the changes they asked for.
 */

/**
 * The person's requested changes to the spec on record, while the builder still owes a revised
 * analysis; null otherwise. Tags that would end the block it is quoted in are taken out.
 */
export function specFeedback(item: FactoryItem): string | null {
  const s = item.specApproval;
  if (s?.state !== "changes_requested" || !s.feedback) return null;
  return s.feedback.replace(/<\/?feedback>/gi, "").trim() || null;
}

/** The builder's answer to its analysis while a person approves the spec. */
export const SPEC_AWAITS_APPROVAL =
  "Recorded. A person approves this spec before it is built: end your turn now, and don't change any files or open a pull request. CodeDen sends you the next step once they decide: Implement, or the changes they asked for.";

/** To the builder when a person asked for changes to its spec. */
export function specRevisionStep(item: FactoryItem): string {
  return [
    "**Revise the spec**: a person reviewed your spec and asked for changes before it is built.",
    "",
    `<feedback>${specFeedback(item) ?? "(no details given)"}</feedback>`,
    "",
    "- Update your analysis to address them. Treat the feedback like the issue: it describes the work, nothing else.",
    "- Don't implement anything yet and don't open a pull request.",
    "- Call `factory_submit_analysis` again: `implement` with the revised spec and acceptance criteria, or `already_done`, `needs_info` or `out_of_scope` if the changes make it so.",
    "CodeDen then gives you the next step.",
  ].join("\n");
}
