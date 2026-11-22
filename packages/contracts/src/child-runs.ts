import { z } from "zod";
import { ReasoningEffort } from "./common";

/**
 * Environment variable that names a session's child-run log. The tools a session runs that start
 * other agents (the review and role scripts) append one `ChildRunReport` line to it when a worker
 * starts and another when it ends. It has no `CODEDEN_` prefix because those are not passed to agents.
 */
export const CHILD_RUNS_FILE_ENV = "CHILD_RUNS_FILE";

/** Where a worker run stands. */
export const ChildRunStatus = z.enum(["running", "succeeded", "failed"]);
export type ChildRunStatus = z.infer<typeof ChildRunStatus>;

/** One line of the child-run log, as a script writes it: a worker's start or its end. */
export const ChildRunReport = z.object({
  /** Stable for one worker run: its start and end lines share it. */
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
  /** The Team role it runs as (e.g. `planReviewer`, `reviewer`) or the script's own name for it. */
  role: z.string().min(1).max(60),
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(120).nullable(),
  effort: ReasoningEffort.nullable(),
  status: ChildRunStatus,
  at: z.iso.datetime({ offset: true }),
  /** A short outcome or reason, e.g. the verdict or an exit code. */
  detail: z.string().max(500).nullable().default(null),
});
export type ChildRunReport = z.infer<typeof ChildRunReport>;

/** A worker run a session started, as CodeDen lists it: its start line, updated by its end line. */
export const ChildRun = z.object({
  id: z.string(),
  role: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  effort: ReasoningEffort.nullable(),
  status: ChildRunStatus,
  /** Null when the run's start line is not in the log (it fell outside the part that was read). */
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  detail: z.string().nullable(),
});
export type ChildRun = z.infer<typeof ChildRun>;

/** `GET /api/sessions/:id/child-runs`: newest first; `skipped` counts log lines that were not valid reports. */
export const ChildRunList = z.object({ runs: z.array(ChildRun), skipped: z.number().int().min(0) });
export type ChildRunList = z.infer<typeof ChildRunList>;

/**
 * Fold a child-run log into runs: the first line of an id starts the run, a later line with an
 * end status ends it. Lines that are not valid reports are skipped and counted.
 */
export function foldChildRuns(lines: readonly string[]): ChildRunList {
  const runs = new Map<string, ChildRun>();
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: ReturnType<typeof ChildRunReport.safeParse>;
    try {
      parsed = ChildRunReport.safeParse(JSON.parse(line));
    } catch {
      skipped++;
      continue;
    }
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const r = parsed.data;
    const known = runs.get(r.id);
    if (!known) {
      runs.set(r.id, {
        id: r.id,
        role: r.role,
        provider: r.provider,
        model: r.model,
        effort: r.effort,
        status: r.status,
        startedAt: r.status === "running" ? r.at : null,
        endedAt: r.status === "running" ? null : r.at,
        detail: r.detail,
      });
    } else if (known.status === "running" && r.status !== "running") {
      runs.set(r.id, {
        ...known,
        status: r.status,
        endedAt: r.at,
        detail: r.detail ?? known.detail,
      });
    } else {
      skipped++;
    }
  }
  return { runs: [...runs.values()].reverse(), skipped };
}
