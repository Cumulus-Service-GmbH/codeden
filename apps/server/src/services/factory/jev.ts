import { join } from "node:path";
import {
  type FactoryItem,
  type FactoryTuning,
  type JevReceipt,
  type Project,
  ReviewPolicy,
  type ReviewVerdict,
  teamMember,
} from "@codeden/contracts";
import { jevNext, jevPasses, runJevDone, sha256 } from "../review-jev";
import { modelMatches } from "./agent-choice";
import { verdictHead, withVerdictHead } from "./approval";
import { baseBranchOf, type FactoryContext, raiseInbox } from "./context";
import { trackedHead } from "./rebase";
import { isBusy } from "./sessions";
import { claimSlot, reviewTier } from "./slots";
import { teamTuning } from "./team-role";

const SHA = /^[a-f0-9]{40}$/;
const receiptHistory = (item: FactoryItem) => item.jevHistory ?? [];
const roundsOf = (item: FactoryItem) => item.reviewRounds ?? [];

export const JEV_EVIDENCE_BRIEF =
  "For the final verdict, identify the tested commit in jevEvidence.head and describe the relevant checks for each acceptance criterion in jevEvidence.tests. CodeDen verifies CI at that head separately.";

function historyBrief(item: FactoryItem): string {
  return JSON.stringify(
    {
      plan: item.investigation?.details ?? item.summary,
      spec: item.reviewSpec,
      criteria: item.acceptanceCriteria,
      rounds: roundsOf(item).map((round) => {
        if (!round.verdict) return round;
        const { jevEvidence: _reviewerEvidence, ...verdict } = round.verdict;
        return { ...round, verdict };
      }),
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
  return response?.kind === "assistant_message" ? response.text.slice(0, 8_000) : undefined;
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
  tuning: Pick<FactoryTuning, "team" | "reviewPolicy">,
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
    const member = teamMember(teamTuning(ctx, tuning).team, "reviewer");
    const reason =
      !member?.model?.trim() || member.model.trim().toLowerCase() === "default"
        ? "Set the Jev completion-check reviewer in Settings → Team"
        : reviewer &&
            (reviewer.provider !== member.provider ||
              !modelMatches(ctx.sessions.models(member.provider), member.model, reviewer.model) ||
              (member.effort !== null && reviewer.effort !== member.effort))
          ? "The current reviewer does not match the Jev completion-check reviewer in Settings → Team."
          : null;
    if (reason) {
      ctx.store.updateItem(item.id, (i) => ({ ...i, note: reason }), { touch: false });
      raiseInbox(ctx, {
        id: `inbox:factory-owner-decision:${item.id}`,
        kind: "owner_decision",
        notify: "needs_you",
        projectId: item.projectId,
        sessionId: item.reviewerSessionId,
        issue: item.issue,
        pr: item.pr,
        title: `Owner decision: ${item.title}`,
        body: reason,
      });
      return "waiting";
    }
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
    !receipt &&
    !usesVerificationEvidence(item) &&
    item.review?.verdict === "approve" &&
    verdictHead(item) === head &&
    (item.review.jevEvidence || item.jev?.status === "pass") &&
    item.review?.jevEvidence?.head !== head
  ) {
    const started = await startReviewer(
      { head, status: "pending", reasons: [] },
      `Collect fresh test output at ${head} and submit it using factory_submit_review.\n\n${jevReviewBrief(item)}`,
    );
    if (started !== "unavailable") return false;
  }

  const policy = ReviewPolicy.parse(tuning.reviewPolicy ?? {});
  let attempts = receiptHistory(item).length;
  let activeReviewHead = item.jevReviewHead;
  const shouldEvaluate =
    receipt?.status !== "revise" && (receipt?.status !== "unavailable" || receipt.retryable);
  if (shouldEvaluate && attempts < policy.jevAttempts) {
    save({ head, status: "pending", reasons: [] }, { jevReviewHead: undefined });
    activeReviewHead = undefined;
    receipt = await evaluate(ctx, project, item, head);
    save(receipt, { jevHistory: [...receiptHistory(item), receipt] });
    attempts++;
  }
  receipt ??= { head, status: "unavailable", reasons: ["The Jev attempt cap was reached."] };
  if (receipt.status === "unavailable" && receipt.retryable && attempts < policy.jevAttempts)
    return false;
  if (jevPasses(receipt, head)) return true;
  const priorRefusals =
    receiptHistory(item).filter((r) => r.status === "revise").length -
    Number(item.jev?.status === "revise" && item.jev.head === head);
  if (
    jevNext(receipt.status, priorRefusals, policy.jevRounds) === "reviewer" &&
    attempts < policy.jevAttempts &&
    activeReviewHead !== head
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
  const unavailable = (reason: string, retryable?: true): JevReceipt => ({
    head,
    status: "unavailable",
    reasons: [reason],
    retryable,
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
      if (tests?.head !== head || tests.tests.length !== criteria.length) {
        return unavailable(
          "The reviewer did not identify checks for each criterion at the current head.",
        );
      }
      const verified = await ctx.github.commitChecks(project.id, head).catch(() => null);
      if (verified !== "success") {
        return unavailable(
          "Passing GitHub commit checks are unavailable at the current head.",
          verified === null || verified === "pending" ? true : undefined,
        );
      }
      evidence = [
        `${criteria.map((_, i) => `criteria[${i}]`).join(" and ")}\n${JSON.stringify({
          source: "GitHub commit checks",
          head,
          state: verified,
        })}\nThe pinned diff and review conclusions are in the recorded history.`,
      ];
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
  if (!ctx.jevScript) return unavailable("The done gate script was not supplied.");
  return runJevDone(
    ctx.exec,
    ctx.jevScript,
    join(ctx.reviewDataDir, "review-history", sha256(item.id)),
    {
      head,
      criteria,
      history,
      evidence: [...evidence, `${refs}\n${receipts.join("\n")}\nHIGH or MEDIUM findings: ${count}`],
      historyEvidence: `${refs}\n${earlier.join("\n")}\nHIGH or MEDIUM findings: ${count}\n${item.arbitration?.ruling ?? "No arbitration ruling recorded"}`,
    },
  );
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
