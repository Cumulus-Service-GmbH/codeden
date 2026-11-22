import type { TeamRun } from "@codeden/contracts";
import { useSnapshot } from "@/lib/queries";

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

export function TeamWorkers({ sessionId }: { sessionId: string }) {
  const { data } = useSnapshot();
  const runs = data?.teamRuns?.filter(
    (run) =>
      run.coordinatorId === sessionId ||
      run.workers.some((worker) => worker.sessionId === sessionId),
  );
  return runs?.map((run) => (
    <section key={run.id} className="space-y-1 text-xs" aria-label={`${run.teamName} workers`}>
      <h3 className="font-medium">{run.teamName}</h3>
      <ul className="space-y-1">
        {run.workers.map((worker) => {
          const minutes =
            worker.status === "running" ? estimatedMinutes(run, worker.startedAt) : undefined;
          return (
            <li key={worker.itemId}>
              {run.items.find((item) => item.id === worker.itemId)?.text} · {worker.status}
              {worker.attempt > 0 && ` · Round ${worker.attempt}/${run.limits.maxRounds}`}
              {minutes !== undefined && ` · ETA ~${minutes} min`}
            </li>
          );
        })}
      </ul>
      {run.notice && <p role="status">{run.notice}</p>}
    </section>
  ));
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
    </section>
  );
}
