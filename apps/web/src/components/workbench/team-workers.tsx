import type { Session, TeamRun, TeamWorker } from "@codeden/contracts";
import { Fragment } from "react";
import { useSnapshot } from "@/lib/queries";
import { ChildRuns } from "./child-runs";

function estimatedMinutes(run: TeamRun, startedAt: number | undefined): number | undefined {
  if (startedAt === undefined) return undefined;
  const samples = run.workers.flatMap((worker) =>
    worker.status === "completed" && worker.startedAt !== undefined && worker.checkpoint
      ? [worker.checkpoint.updatedAt - worker.startedAt]
      : [],
  );
  if (!samples.length) return undefined;
  const average = samples.reduce((sum, elapsed) => sum + elapsed, 0) / samples.length;
  return Math.max(1, Math.ceil((average - (Date.now() - startedAt)) / 60_000));
}

function JevStatus({ jev }: { jev: NonNullable<TeamWorker["jev"]> }) {
  if (!jev.receipt) return <span> · Jev {jev.status}</span>;
  return (
    <details>
      <summary>Jev {jev.status}</summary>
      <dl className="break-all">
        <dt>Candidate</dt>
        <dd>{jev.receipt.head}</dd>
        <dt>History</dt>
        <dd>{jev.receipt.historyPath}</dd>
        <dt>History SHA-256</dt>
        <dd>{jev.receipt.historySha256}</dd>
        {jev.receipt.inputSha256 && (
          <>
            <dt>Input digest</dt>
            <dd>{jev.receipt.inputSha256}</dd>
          </>
        )}
        {Object.entries(jev.receipt.scores ?? {}).map(([label, score]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{score}</dd>
          </Fragment>
        ))}
        {jev.receipt.reasons?.map((reason) => (
          <dd key={reason}>{reason}</dd>
        ))}
      </dl>
    </details>
  );
}

export function TeamWorkers({ sessionId, session }: { sessionId: string; session?: Session }) {
  const { data } = useSnapshot();
  const runs = data?.teamRuns?.filter(
    (run) =>
      run.coordinatorId === sessionId ||
      run.workers.some((worker) => worker.sessionId === sessionId),
  );
  return (
    <>
      {session && <ChildRuns session={session} showEmpty={!runs?.length} />}
      {runs?.map((run) => (
        <section key={run.id} className="space-y-1 text-xs" aria-label={`${run.teamName} workers`}>
          <h3 className="font-medium">{run.teamName}</h3>
          <ul className="space-y-1">
            {run.workers.map((worker) => {
              const minutes =
                worker.status === "running" ? estimatedMinutes(run, worker.startedAt) : undefined;
              return (
                <li key={worker.itemId}>
                  {run.items.find((item) => item.id === worker.itemId)?.text} · {worker.status}
                  {worker.step === "Arbiter" ? (
                    <>
                      {" "}
                      · <span>Arbiter · round 1 of 1</span>
                    </>
                  ) : (
                    worker.step && ` · ${worker.step}`
                  )}
                  {worker.arbiter && ` · ${worker.arbiter.verdict}`}
                  {worker.attempt > 0 && ` · Round ${worker.attempt}/${run.limits.maxRounds}`}
                  {minutes !== undefined && ` · ETA ~${minutes} min`}
                  {worker.jev && <JevStatus jev={worker.jev} />}
                </li>
              );
            })}
          </ul>
          {run.notice && <p role="status">{run.notice}</p>}
        </section>
      ))}
    </>
  );
}

export function TeamRunProgress({ run }: { run: TeamRun }) {
  const current =
    run.workers.find((worker) => worker.status === "running") ??
    run.workers.find((worker) => worker.status !== "completed");
  const done = run.workers.filter((worker) => worker.status === "completed").length;
  return (
    <section className="px-3 py-2 text-xs" aria-label={`${run.teamName} progress`}>
      <h3 className="font-medium">
        {run.teamName} · {done}/{run.workers.length}
      </h3>
      {current && <p>{run.items.find((item) => item.id === current.itemId)?.text}</p>}
      <ul>
        {run.workers.map((worker) => {
          const minutes =
            worker.status === "running" ? estimatedMinutes(run, worker.startedAt) : undefined;
          return (
            <li key={worker.itemId}>
              {worker.status === "completed" ? "[x]" : worker.status === "queued" ? "[ ]" : "[~]"}{" "}
              {run.items.find((item) => item.id === worker.itemId)?.text}
              {" · "}
              {worker.status}
              {worker.step && ` · ${worker.step}`}
              {worker.attempt > 0 && ` · Round ${worker.attempt}/${run.limits.maxRounds}`}
              {worker.arbiter && ` · ${worker.arbiter.verdict}`}
              {minutes !== undefined &&
                ` · ETA ${new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
              {worker.sessionId && <p>{worker.sessionId}</p>}
              {worker.progress && <p>{worker.progress}</p>}
              {worker.jev && <JevStatus jev={worker.jev} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
