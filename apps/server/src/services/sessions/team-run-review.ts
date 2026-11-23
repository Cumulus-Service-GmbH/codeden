import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TeamReviewRecord, type TeamRun, type TeamWorker } from "@codeden/contracts";
import { historyDigest, recordTeamHistory } from "./team-run-history";
import type { TeamReviewEvidence } from "./team-run-jev";
import type { TeamRunPorts } from "./team-runs";

function testsAtHead(output: string, index: number, head: string) {
  const [label, command, ...lines] = output.split(/\r?\n/);
  return (
    label?.startsWith(`criteria[${index}] `) &&
    label.endsWith(`tests at ${head}`) &&
    /^VITEST_MAX_WORKERS=2 pnpm -s vitest run --reporter=verbose .+ \| grep -iE '.+'$/.test(
      command ?? "",
    ) &&
    lines.some((line) => /^\s*✓\s+.+ > \S/.test(line)) &&
    lines.some((line) => /^\s*Test Files\s+\d+ passed/.test(line)) &&
    lines.some((line) => /^\s*Tests\s+\d+ passed/.test(line)) &&
    !lines.some((line) => /^\s*(?:×|FAIL)|\b\d+ failed\b/.test(line))
  );
}

function hasCoverage(criteria: string[], head: string, evidence?: TeamReviewEvidence): boolean {
  return (
    evidence?.criteria.length === criteria.length &&
    criteria.every(
      (criterion, index) =>
        evidence.criteria[index] === criterion &&
        evidence.evidence.some((output) => testsAtHead(output, index, head)),
    )
  );
}

export async function reviewAndMerge(
  ports: TeamRunPorts,
  run: TeamRun,
  worker: TeamWorker,
  coordinatorId: string,
  save: (run: TeamRun) => void,
) {
  const identity = { itemId: worker.itemId, attempt: worker.attempt };
  const historyPath = await ports.history?.(run, worker);

  for (let round = 0; round < 2; round++) {
    worker.jev = { status: "pending" };
    worker.step = "review";
    worker.reviewRunId = randomUUID();
    const earlierHistory = historyPath ? await readFile(historyPath) : undefined;
    const candidate = historyPath ? await ports.capture?.(run, worker) : undefined;
    const history =
      historyPath && candidate
        ? await recordTeamHistory(historyPath, candidate.history)
        : earlierHistory;
    const historySha256 = history && historyDigest(history);
    worker.historySha256 = historySha256;
    save(run);
    let review = await ports.review(run, worker, {
      reviewRunId: worker.reviewRunId,
      candidateHead: candidate?.head,
      historyBrief:
        earlierHistory === undefined
          ? undefined
          : `Full history: ${historyPath}\n${earlierHistory.subarray(-6_000).toString("utf8")}`,
      deltaBase: worker.deltaBase,
      historyPath,
      historySha256,
      refusal: worker.jevRefusal,
    });
    if (candidate && review.head !== candidate.head) {
      throw new Error("Team review does not cover the captured candidate head");
    }
    if (review.record) {
      const record = TeamReviewRecord.parse(review.record);
      if (record.head !== review.head)
        throw new Error("Team review receipt covers a different head");
      const vendor = ports
        .vendor({ ...record, role: "reviewer" })
        ?.trim()
        .toLowerCase();
      const writerVendor = ports
        .vendor({
          role: "writer",
          provider: worker.provider,
          model: worker.model,
          effort: worker.effort,
        })
        ?.trim()
        .toLowerCase();
      if (
        !vendor ||
        !writerVendor ||
        [vendor, writerVendor].includes("unknown") ||
        vendor === writerVendor
      ) {
        throw new Error("Team review receipt must identify a different vendor");
      }
      const prior = worker.reviews?.at(-1);
      if (
        prior &&
        ports
          .vendor({ ...prior, role: "reviewer" })
          ?.trim()
          .toLowerCase() !== vendor
      ) {
        throw new Error("Team delta review must keep the original reviewer vendor");
      }
      worker.reviews = [...(worker.reviews ?? []), { ...record, historySha256 }];
    }
    await ports.coordinate(coordinatorId, { type: "review_done", ...identity });
    if ("changes" in review) {
      if (historyPath) await recordTeamHistory(historyPath, `${review.history}\n`);
      let changes = review.changes;
      if (worker.blockingReview) {
        if (worker.arbiter) throw new Error("Blocking finding remains after Arbiter ruling");
        if (!ports.arbiter) throw new Error("Team Arbiter is unavailable");
        worker.step = "Arbiter";
        save(run);
        const arbiterHistorySha256 = historyPath
          ? historyDigest(await readFile(historyPath))
          : undefined;
        const { approval, ...ruling } = await ports.arbiter(run, worker, {
          historyPath,
          historySha256: arbiterHistorySha256,
        });
        worker.arbiter = { ...ruling, historySha256: arbiterHistorySha256 };
        if (historyPath)
          await recordTeamHistory(historyPath, `${JSON.stringify(worker.arbiter)}\n`);
        if (worker.arbiter.verdict === "DOWNGRADE TO LOW") {
          if (!approval?.debt?.length || approval.head !== review.head) {
            throw new Error("Shared Team finding disposition is unavailable");
          }
          review = approval;
        } else {
          changes = ruling.reason;
          if (worker.attempt >= run.limits.maxRounds) {
            throw new Error(`Arbiter fix exceeds the Team round limit. ${changes}`);
          }
        }
      }
      if ("changes" in review) {
        worker.blockingReview = true;
        worker.deltaBase = review.head ?? (await ports.head(run, worker));
        checkpoint(worker, "failed", "Review requested changes");
        if (worker.checkpoint) {
          worker.checkpoint.summary =
            ports.writerResponse?.(worker) ?? "See the preserved worker branch for completed work.";
          worker.checkpoint.nextSteps = changes;
        }
        return;
      }
    }
    if (review.head !== (await ports.head(run, worker))) {
      throw new Error("Worker head moved after review");
    }
    if (review.debt?.length) {
      if (!ports.defer) throw new Error("Shared Team tech-debt store is unavailable");
      await ports.defer(run, worker, review.debt);
    }
    worker.blockingReview = false;
    const criteria = run.items.find(({ id }) => id === worker.itemId)?.criteria;
    if (criteria && !hasCoverage(criteria, review.head, review.evidence)) {
      worker.deltaBase = review.head;
      checkpoint(worker, "failed", "Acceptance coverage is incomplete");
      if (worker.checkpoint) {
        worker.checkpoint.nextSteps = [
          "Add one named test per criterion and return a criterion-to-test table.",
          ...criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
        ].join("\n");
      }
      return;
    }
    worker.step = "Jev";
    save(run);
    worker.jev = await ports.gate(run, worker, review, historyPath);
    if (worker.jev.status === "pass") {
      if (
        worker.jev.receipt?.head !== review.head ||
        review.head !== (await ports.head(run, worker))
      ) {
        worker.jev = { status: "pending" };
        throw new Error("Jev receipt does not cover the current worker head");
      }
      worker.step = "merge";
      save(run);
      const { conflict, headMoved, needsResolution } = await ports.merge(run, worker, review.head);
      if (headMoved) {
        worker.jev = { status: "pending" };
        throw new Error("Jev receipt does not cover the current worker head");
      }
      if (
        conflict &&
        needsResolution &&
        !worker.resolutionHead &&
        worker.attempt < run.limits.maxRounds
      ) {
        worker.resolutionHead = review.head;
        worker.deltaBase = review.head;
        checkpoint(worker, "failed", conflict);
        if (worker.checkpoint) {
          worker.checkpoint.nextSteps = `Merge ${review.head} into this checkout using --no-ff and resolve the conflict. Preserve both sides and every test. Leave the merge staged if you cannot commit it.`;
        }
      } else {
        checkpoint(worker, conflict ? "waiting" : "completed", conflict ?? null);
      }
      return;
    }
    if (worker.jev.status !== "revise" || !worker.jev.receipt) {
      throw new Error("Jev done gate is unavailable");
    }
    if (worker.jevRefusal) {
      worker.jev = { status: "owner decision", receipt: worker.jev.receipt };
      checkpoint(worker, "waiting", "Jev requires an owner decision");
      save(run);
      ports.ownerDecision(run, worker);
      return;
    }
    worker.jevRefusal = worker.jev.receipt;
    if (criteria) {
      if (worker.attempt >= run.limits.maxRounds) {
        throw new Error("Jev refused and the Team round limit prevents an evidence delta");
      }
      worker.deltaBase = review.head;
      checkpoint(worker, "failed", "Jev refused the candidate");
      if (worker.checkpoint) {
        worker.checkpoint.nextSteps = [
          "Jev refused the candidate. Make a test or evidence delta covering the pinned criteria.",
          ...(worker.jevRefusal.reasons ?? []),
        ].join("\n");
      }
      return;
    }
    save(run);
  }
}

export function checkpoint(
  worker: TeamWorker,
  status: TeamWorker["status"],
  blocker: string | null,
) {
  worker.status = status;
  worker.checkpoint = {
    summary: status === "completed" ? "Reviewed and merged" : "Assignment paused",
    nextSteps: blocker ?? "",
    blocker,
    updatedAt: Date.now(),
  };
}
