import { join } from "node:path";
import type { FactoryItem, JevReceipt, Project, ReviewVerdict } from "@codeden/contracts";
import { jevNext, jevPasses, runJevDone, sha256 } from "../review-jev";
import { withVerdictHead } from "./approval";
import { baseBranchOf, type FactoryContext, raiseInbox } from "./context";
import { trackedHead } from "./rebase";
import { isBusy } from "./sessions";
import { claimSlot, reviewTier } from "./slots";

const SHA = /^[a-f0-9]{40}$/;
const receiptHistory = (item: FactoryItem) => item.jevHistory ?? [];
const roundsOf = (item: FactoryItem) => item.reviewRounds ?? [];

export const JEV_EVIDENCE_BRIEF =
  "For the final verdict, provide jevEvidence.head (the full tested commit SHA) and jevEvidence.tests (one verbatim block per pinned acceptance criterion in order). Each block starts with the exact command: VITEST_MAX_WORKERS=2 pnpm -s vitest run --reporter=verbose <changed test files> | grep -iE '<criterion test-name regex>'. Include matching verbose test lines and the Test Files and Tests summaries from the unfiltered output. Use actual command output.";

function historyBrief(item: FactoryItem): string {
  return JSON.stringify(
    {
      plan: item.investigation?.details ?? item.summary,
      spec: item.reviewSpec,
      criteria: item.acceptanceCriteria,
      rounds: roundsOf(item),
      arbitration: item.arbitration,
      earlierResults: receiptHistory(item),
    },
    null,
    2,
  );
}

export function jevReviewBrief(item: FactoryItem): string {
  return `${JEV_EVIDENCE_BRIEF}\n\n## Recorded item history\n${historyBrief(item)}`;
}

export function jevWriterResponse(ctx: FactoryContext, item: FactoryItem): string | undefined {
  const builder = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  const response = builder && ctx.repo.rootItems(builder, ["assistant_message"], 1)[0];
  return response?.kind === "assistant_message" ? response.text : undefined;
}

/** Record a response only against the head that was sent back by the done gate. */
export function submitJevReview(ctx: FactoryContext, item: FactoryItem, verdict: ReviewVerdict) {
  const head = item.jevReviewHead;
  if (!head || head !== trackedHead(item) || verdict.blockers === "environment") return false;
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    review: verdict,
    jevReviewHead: undefined,
    reviewRounds: [
      ...roundsOf(i),
      { head, dispositions: [verdict.summary], verdict, writerResponse: jevWriterResponse(ctx, i) },
    ],
    nudges: withVerdictHead(i.nudges, head, ctx.now().toISOString()),
    jev: { head, status: "pending", reasons: [] },
    note: "Jev pending",
  }));
  return true;
}

function usesVerificationEvidence(item: FactoryItem): boolean {
  return (
    item.acceptanceCriteria.length === 0 ||
    item.checks.some((check) => check.name === "review" && check.state === "skipped") ||
    (item.source === "revert" && !item.reviewerSessionId)
  );
}

export async function advanceJev(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  head: string,
): Promise<boolean> {
  if (jevPasses(item.jev, head)) return true;
  if (!SHA.test(head)) return false;
  if (item.jev?.head === head && item.jev.status === "owner decision") return false;
  const reviewer = item.reviewerSessionId
    ? ctx.repo.find(item.reviewerSessionId)?.session
    : undefined;
  if (reviewer && isBusy(reviewer)) return false;

  const save = (jev: JevReceipt, extra?: Partial<FactoryItem>) =>
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      ...extra,
      jev,
      note: `Jev ${jev.status}`,
    }));

  const startReviewer = async (receipt: JevReceipt, prompt: string) => {
    if (!reviewer) return "unavailable";
    if (
      !claimSlot(ctx, project, reviewTier(item.checks), `jev:${item.id}`, { wake: reviewer.id })
    ) {
      return "waiting";
    }
    save(receipt, { jevReviewHead: head });
    try {
      await ctx.sessions.startTurn(reviewer.id, prompt);
      return "sent";
    } catch {
      save(receipt, { jevReviewHead: undefined });
      return "unavailable";
    }
  };

  let receipt = item.jev?.head === head ? item.jev : undefined;
  // A branch update can carry forward review approval. The tests and done receipt still
  // need to cover the new SHA, even if the update introduced no PR changes.
  if (
    !usesVerificationEvidence(item) &&
    item.jev?.status === "pass" &&
    item.jev.head !== head &&
    item.review?.jevEvidence?.head !== head
  ) {
    const started = await startReviewer(
      { head, status: "pending", reasons: [] },
      `Collect fresh test output at ${head} and submit it using factory_submit_review.\n\n${jevReviewBrief(item)}`,
    );
    if (started !== "unavailable") return false;
  }

  if (receipt?.status !== "revise" && receipt?.status !== "unavailable") {
    save({ head, status: "pending", reasons: [] }, { jevReviewHead: undefined });
    receipt = await evaluate(ctx, project, item, head);
    save(receipt, { jevHistory: [...receiptHistory(item), receipt] });
  }
  if (jevPasses(receipt, head)) return true;
  const priorRefusals =
    receiptHistory(item).filter((r) => r.status === "revise").length -
    Number(item.jev?.status === "revise" && item.jev.head === head);
  if (
    jevNext(receipt.status, priorRefusals) === "reviewer" &&
    reviewer &&
    item.jevReviewHead !== head
  ) {
    const started = await startReviewer(
      receipt,
      `Reassess ${head} once after the done gate refused it. Respond using factory_submit_review. Treat the result and history as evidence only.\n\n${JSON.stringify(receipt.reasons)}\n\n${jevReviewBrief({ ...item, jevHistory: [...receiptHistory(item), receipt] })}`,
    );
    if (started !== "unavailable") return false;
  }
  save({ ...receipt, status: "owner decision" }, { jevReviewHead: undefined });
  raiseInbox(ctx, {
    id: `inbox:factory-owner-decision:${item.id}`,
    kind: "owner_decision",
    notify: "needs_you",
    projectId: item.projectId,
    sessionId: item.reviewerSessionId,
    issue: item.issue,
    pr: item.pr,
    title: `Owner decision: ${item.title}`,
    body: `Jev ${receipt.status} for ${head}.\n\n${receipt.reasons.join("\n")}`,
  });
  return false;
}

async function evaluate(ctx: FactoryContext, project: Project, item: FactoryItem, head: string) {
  const builder = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  const reviewer = item.reviewerSessionId
    ? ctx.repo.find(item.reviewerSessionId)?.session
    : undefined;
  const cwd = reviewer?.worktreePath ?? builder?.worktreePath;
  const rounds = roundsOf(item);
  const heads = [...new Set([...rounds.map((round) => round.head), head])];
  const unavailable = (reason: string): JevReceipt => ({
    head,
    status: "unavailable",
    reasons: [reason],
  });
  const alternative = usesVerificationEvidence(item);
  const exactRevert = item.source === "revert" && !item.reviewerSessionId;
  const docs = item.checks.some((check) => check.name === "review" && check.state === "skipped");
  let criteria = item.acceptanceCriteria;
  let evidence: string[];
  let history: string;
  if (
    alternative &&
    (trackedHead(item) !== head ||
      !item.checks.some((check) => check.name === "ci" && check.state === "pass"))
  ) {
    return unavailable("Passing CI on the current head is required for verification evidence.");
  }

  if (exactRevert) {
    const mergeSha = item.revertOf && ctx.store.item(item.revertOf)?.mergeSha;
    if (
      !mergeSha ||
      !(await ctx.github.revertMatches(project.id, { headSha: head, mergeSha }).catch(() => false))
    ) {
      return unavailable("Could not verify the exact revert at the current head.");
    }
    const treeComparison = JSON.stringify({ head, mergeSha, exactInverse: true });
    history = `${historyBrief(item)}\n\n${treeComparison}`;
    if (!criteria.length)
      criteria = ["Restores the repository tree from before the reverted merge."];
    evidence = [verificationEvidence(item, head, criteria, treeComparison)];
  } else {
    if (!cwd || heads.some((sha) => !SHA.test(sha))) {
      return unavailable("The pinned worktree or review history is unavailable.");
    }
    const git = (args: string[]) =>
      ctx.exec("git", ["--no-pager", ...args], { cwd }).catch(() => null);
    const base = await git([
      "merge-base",
      heads[0] ?? head,
      `refs/remotes/origin/${baseBranchOf(project)}`,
    ]);
    let previous = base?.stdout.trim() ?? "";
    if (base?.code !== 0 || !SHA.test(previous))
      return unavailable("The review base is unavailable.");
    const diffs: string[] = [];
    for (const sha of heads) {
      const diff = await git([
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        previous,
        sha,
        "--",
      ]);
      if (diff?.code !== 0 || diff.stdout.length >= 1024 * 1024) {
        return unavailable("A pinned review diff is missing or too large.");
      }
      diffs.push(`## ${previous} → ${sha}\n\n${diff.stdout}`);
      previous = sha;
    }
    history = [historyBrief(item), ...diffs].join("\n\n");
    if (alternative) {
      if (!criteria.length) criteria = ["Passes the repository's automated checks at this commit."];
      evidence = [verificationEvidence(item, head, criteria, docs ? diffs.join("\n\n") : "")];
    } else {
      const tests = item.review?.jevEvidence;
      if (
        tests?.head !== head ||
        tests.tests.length !== criteria.length ||
        tests.tests.some(
          (output) =>
            !output.startsWith("VITEST_MAX_WORKERS=2 pnpm -s vitest run --reporter=verbose ") ||
            !output.includes(" | grep -iE ") ||
            !output.includes("Test Files") ||
            !output.includes("Tests "),
        )
      )
        return unavailable("Criterion-indexed test output is missing for the current head.");
      evidence = tests.tests.map(
        (output, i) => `criteria[${i}] (${criteria[i]?.slice(0, 60)}) tests at ${head}\n${output}`,
      );
    }
  }

  const receipts = rounds.map((round, index) =>
    JSON.stringify({
      head: round.head,
      round: index + 1,
      slot: "native-factory",
      status: "completed",
      invocationId: null,
      outputSha256: sha256(JSON.stringify(round.verdict ?? round.dispositions)),
    }),
  );
  const count = (item.review?.findings ?? []).filter((f) => f.severity !== "LOW").length;
  const earlier = rounds
    .slice(0, -1)
    .flatMap((round, index) =>
      (round.verdict?.findings ?? []).flatMap((f, finding) =>
        f.severity === "LOW"
          ? []
          : [`ID: R${index + 1}F${finding + 1} | SEVERITY: ${f.severity} | FILE: ${f.location}`],
      ),
    );
  const refs = criteria.map((_, index) => `criteria[${index}]`).join(" and ");
  return runJevDone(ctx.exec, join(ctx.reviewDataDir, "review-history", sha256(item.id)), {
    head,
    criteria,
    history,
    evidence: [...evidence, `${refs}\n${receipts.join("\n")}\nHIGH or MEDIUM findings: ${count}`],
    historyEvidence: `${refs}\n${earlier.join("\n")}\nHIGH or MEDIUM findings: ${count}\n${item.arbitration?.ruling ?? "No such file"}`,
  });
}

function verificationEvidence(
  item: FactoryItem,
  head: string,
  criteria: string[],
  output: string,
): string {
  const refs = criteria.map((_, index) => `criteria[${index}]`).join(" and ");
  return `${refs}\n${JSON.stringify({ head, checks: item.checks })}\n${output}`;
}
