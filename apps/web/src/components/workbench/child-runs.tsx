import type { ChildRun, Session } from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { ProviderMark } from "@/components/common/bits";
import { useClient } from "@/lib/api";
import { useChildRuns } from "@/lib/child-runs";
import { useFactoryStatus } from "@/lib/factory";
import { ago, duration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { JevStatus } from "./jev-status";

const statusText: Record<ChildRun["status"], string> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
};

const statusDot: Record<ChildRun["status"], string> = {
  running: "bg-sky-500 animate-pulse",
  succeeded: "bg-emerald-500",
  failed: "bg-rose-500",
};

/** The worker runs this session's tools started (review and role scripts), newest first. */
export function ChildRuns({ session, showEmpty }: { session: Session; showEmpty?: boolean }) {
  const client = useClient();
  const factory = useFactoryStatus(
    session.projectId ?? "",
    Boolean(
      session.projectId && session.startedBy.kind === "pm" && session.startedBy.id === "factory",
    ),
  );
  const independent = useQuery({
    queryKey: ["review-meta", session.id],
    queryFn: () => client.getSessionDetail(session.id),
    enabled: session.forkedFrom?.kind === "review",
    staleTime: Infinity,
  }).data?.startMeta?.review;
  const status = factory.data;
  const review = [...(status?.inProgress ?? []), ...(status?.recent ?? [])].find((item) =>
    [item.sessionId, item.reviewerSessionId, item.arbitration?.sessionId].includes(session.id),
  );
  const policy = status?.tuning.reviewPolicy;
  const round = independent?.round ?? review?.reviewRound;
  const limit =
    independent?.limit ?? Math.min(policy?.reviewerRounds ?? 2, policy?.totalRounds ?? 8);
  const arbitration = review?.arbitration;
  const runs = useChildRuns(session);
  const list = runs.data?.runs ?? [];
  const skipped = runs.data?.skipped ?? 0;
  if (runs.isError) {
    return (
      <p className="text-3xs text-destructive">Workers could not be listed: {String(runs.error)}</p>
    );
  }
  if (!round && !arbitration && !review?.jev && !list.length && skipped === 0) {
    if (!showEmpty) return null;
    return (
      <p className="text-xs text-muted-foreground">
        {runs.isPending ? "Loading workers…" : "No worker runs recorded for this session yet."}
      </p>
    );
  }
  return (
    <section aria-labelledby="child-runs-heading" className="space-y-2">
      <h3
        id="child-runs-heading"
        className="text-2xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Workers
      </h3>
      {round && (
        <p className="text-2xs">
          Review round {round}/{limit}
          {round > 2 && <span className="ml-2 text-status-waiting">Past two review rounds</span>}
        </p>
      )}
      {review?.jev && <JevStatus receipt={review.jev} />}
      {arbitration && (
        <div className="space-y-1 text-[13px]">
          {arbitration.round && (
            <p>
              Arbiter · round {arbitration.round} of {policy?.arbiterRounds ?? 1}
            </p>
          )}
          <p>
            {!arbitration.round && (
              <>
                <span className="font-medium">Arbiter</span>
                {" · "}
              </>
            )}
            {
              {
                queued: "Waiting for another round",
                running: "Running",
                ruling: "Waiting for reviewer confirmation",
                confirming: "Reviewer confirming",
                jev_pending: "Reviewer confirmed",
                blocked: "Owner decision",
              }[arbitration.state]
            }
          </p>
          {arbitration.ruling && <p className="whitespace-pre-wrap">{arbitration.ruling}</p>}
        </div>
      )}
      <ul className="divide-y divide-border/60 text-[13px]">
        {list.map((run) => (
          <li key={run.id} className="flex items-start gap-2 py-1.5">
            <span
              className={cn("mt-1.5 size-2 shrink-0 rounded-full", statusDot[run.status])}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="font-medium">{run.role}</span>
                <span className="text-2xs text-muted-foreground">{statusText[run.status]}</span>
              </span>
              <span className="flex items-center gap-1 text-2xs text-muted-foreground">
                <ProviderMark provider={run.provider} /> {run.provider}
                {run.model ? ` · ${run.model}` : ""}
                {run.effort ? ` · ${run.effort}` : ""}
              </span>
              <span className="block text-3xs text-muted-foreground/80">
                {run.startedAt && (
                  <>
                    Started <time dateTime={run.startedAt}>{ago(run.startedAt)}</time>
                  </>
                )}
                {run.endedAt && (
                  <>
                    {run.startedAt && " · "}Ended{" "}
                    <time dateTime={run.endedAt}>{ago(run.endedAt)}</time>
                  </>
                )}
                {run.startedAt && run.endedAt
                  ? ` · took ${duration(Date.parse(run.endedAt) - Date.parse(run.startedAt))}`
                  : ""}
                {run.detail ? ` · ${run.detail}` : ""}
              </span>
              {run.receipt && (
                <span className="block break-all text-3xs text-muted-foreground">
                  Receipt {run.receipt}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {skipped > 0 && (
        <p className="text-3xs text-muted-foreground/70">
          {skipped} log line{skipped === 1 ? "" : "s"} could not be read
        </p>
      )}
    </section>
  );
}
