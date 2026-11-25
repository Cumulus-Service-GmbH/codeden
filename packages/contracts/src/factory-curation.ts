import { z } from "zod";

export const CURATION_PATHS = [".codeden/VISION.md", "AGENTS.md"] as const;
export const CurationPath = z.enum(CURATION_PATHS);
export type CurationPath = z.infer<typeof CurationPath>;

/** An edit to an existing Markdown section, tied to a commit and a verified lesson ID. */
const section = {
  path: CurationPath,
  section: z
    .string()
    .regex(/^#{1,6} [^\r\n]+$/)
    .max(300),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  evidence: z.string().min(1).max(120),
};

const Operation = z.discriminatedUnion("op", [
  z.strictObject({
    ...section,
    op: z.literal("replace"),
    replacement: z.string().trim().min(1).max(6000),
  }),
  z.strictObject({ ...section, op: z.literal("prune") }),
]);

/** Only replace and prune are admitted. An empty review produces no card. */
export const CurationProposal = z.strictObject({ operations: z.array(Operation).max(8) });
export type CurationProposal = z.infer<typeof CurationProposal>;

export const CURATION_CARD_PREFIX = "factory-curation:";

/** The PM reviews the immutable proposal identified by the card ID. */
export const ReviewCurationInput = z.strictObject({
  id: z.string().startsWith(CURATION_CARD_PREFIX).max(120),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(1).max(2000),
});
export type ReviewCurationInput = z.infer<typeof ReviewCurationInput>;
