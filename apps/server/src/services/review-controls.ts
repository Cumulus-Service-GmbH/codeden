import { createHash } from "node:crypto";
import {
  type ProviderInfo,
  ReviewAcceptanceSpec,
  ReviewFinding,
  ReviewPolicy,
  type ReviewVerdict,
} from "@codeden/contracts";

export const MAX_REVIEW_LINES = 3_000;

type ReviewProvider = Pick<ProviderInfo, "id"> & {
  capabilities: Pick<ProviderInfo["capabilities"], "modelVendor">;
};

export function reviewVendorsMatch(author: ReviewProvider, reviewer: ReviewProvider): boolean {
  const vendor = author.capabilities?.modelVendor;
  return vendor !== undefined && vendor === reviewer.capabilities?.modelVendor;
}

export function reviewRound(
  input: Partial<ReviewPolicy>,
  prior: readonly { head: string | null; dispositions: readonly string[] }[],
  diff: { head: string | null; lines: number },
) {
  const policy = ReviewPolicy.parse(input);
  const number = prior.length + 1;
  const limit = Math.min(policy.reviewerRounds, policy.totalRounds);
  const previous = prior.at(-1);
  const blocked =
    number > limit
      ? "round_limit"
      : diff.head !== null && previous?.head === diff.head
        ? "unchanged_head"
        : !Number.isSafeInteger(diff.lines) || diff.lines < 0 || diff.lines > MAX_REVIEW_LINES
          ? "diff_size"
          : null;
  return {
    number,
    limit,
    flagged: number > 2,
    base: previous?.head ?? null,
    dispositions: prior.flatMap((round) => round.dispositions),
    blocked,
  };
}

export function sortReviewFindings(
  input: ReviewAcceptanceSpec | undefined,
  findings: readonly ReviewFinding[],
  lowPolicy: "fix" | "defer",
  changedFiles: readonly string[] = [],
): { fix: ReviewFinding[]; debt: ReviewFinding[] } {
  const spec = input && ReviewAcceptanceSpec.parse(input);
  const fix: ReviewFinding[] = [];
  const debt: ReviewFinding[] = [];
  for (const input of findings) {
    const finding = ReviewFinding.parse(input);
    const path = finding.location
      .replace(/^(?:\.\/)+/, "")
      .replace(/(?::\d+(?::\d+|-\d+)?|#L\d+(?:-L?\d+)?)$/, "");
    const inScope =
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").some((part) => part === ".." || part === ".") &&
      (!spec ||
        changedFiles.includes(path) ||
        spec.scope.some((entry) =>
          entry.endsWith("/") ? path.startsWith(entry) : path === entry,
        ));
    (inScope && (finding.severity !== "LOW" || lowPolicy === "fix") ? fix : debt).push(finding);
  }
  return { fix, debt };
}

export function pinReviewSpec(
  plan: string,
  criteria: readonly string[],
  scope: readonly string[],
): ReturnType<typeof ReviewAcceptanceSpec.parse> {
  return ReviewAcceptanceSpec.parse({
    planSha: createHash("sha256")
      .update(JSON.stringify([plan, criteria]))
      .digest("hex"),
    scope,
  });
}

export function applyReviewFindingPolicy(
  verdict: ReviewVerdict,
  spec: ReviewAcceptanceSpec | undefined,
  lowPolicy: "fix" | "defer",
  changedFiles: readonly string[] = [],
): ReviewVerdict {
  if (!verdict.findings?.length) return verdict;
  const { fix, debt } = sortReviewFindings(spec, verdict.findings, lowPolicy, changedFiles);
  const independentBlocker =
    verdict.blockers === "environment" ||
    verdict.criteria.some((criterion) => !criterion.met) ||
    !verdict.vision.aligned ||
    !verdict.tests.adequate ||
    verdict.security.concerns.length > 0;
  return {
    ...verdict,
    verdict:
      verdict.verdict === "reject" || independentBlocker
        ? verdict.verdict
        : fix.length
          ? "request_changes"
          : "approve",
    findings: fix,
    techDebt: debt,
  };
}
