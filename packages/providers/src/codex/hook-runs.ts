import {
  HOOK_RUN_STATUS,
  type HookRunOutcome,
  type ItemOf,
  trimHookOutput,
} from "@codeden/contracts";
import type { HookHandlerType, HookRunStatus, HookRunSummary } from "./protocol/v2";

type HookRun = ItemOf<"hook_run">;

/** Most runs tracked or held at once; one that never reports back is dropped after this many. */
const MAX_RUNS = 100;

/** `stopped`: the hook halted the agent, which the transcript shows like a block. */
const OUTCOME: Record<HookRunStatus, HookRunOutcome> = {
  running: "running",
  completed: "succeeded",
  failed: "failed",
  blocked: "blocked",
  stopped: "blocked",
};

const HANDLER: Record<HookHandlerType, string> = {
  command: "command",
  mcpTool: "MCP tool",
  prompt: "prompt",
  agent: "agent",
};

/** Codex's camelCase event name in the providers' common PascalCase: `preToolUse` → `PreToolUse`. */
export function codexHookEvent(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * A Codex hook run (`hook/started`, `hook/completed`) as a `hook_run` item (§12.4). Codex names
 * no command, so the label is the handler type and the source its hooks file; the output is the
 * status message and the entries the hook reported (`warning`, `stop`, `feedback`, `context`,
 * `error`), one per line. `done`: from `hook/completed`, which never leaves a run running.
 */
export function codexHookRun(run: HookRunSummary, done: boolean): HookRun {
  let outcome = OUTCOME[run.status] ?? "failed";
  if (done && outcome === "running") outcome = "succeeded";
  const lines = [
    run.statusMessage ?? "",
    ...(run.entries ?? []).map((entry) => `${entry.kind}: ${entry.text}`),
  ].filter((line) => line.trim());
  const kept = lines.length > 0 ? trimHookOutput(lines.join("\n")) : undefined;
  const durationMs = Number(run.durationMs);
  return {
    id: `hook-${run.id}`,
    kind: "hook_run",
    status: HOOK_RUN_STATUS[outcome],
    event: codexHookEvent(run.eventName),
    label: HANDLER[run.handlerType] ?? String(run.handlerType ?? ""),
    ...(run.sourcePath ? { source: run.sourcePath } : {}),
    outcome,
    ...(run.durationMs !== null && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs: Math.round(durationMs) }
      : {}),
    ...(kept?.output ? kept : {}),
  };
}

export interface CodexHookRunsOptions {
  /** The thread's running turn, if any. */
  current: () => string | undefined;
  /** Begin a turn a run is reported for, as an item would. */
  beginTurn: (turnId: string) => void;
  emit: (turnId: string, phase: "item.started" | "item.completed", item: HookRun) => void;
}

/**
 * One Codex thread's hook runs, shown in the turn they ran in. A run keeps the turn it started
 * in, so its completion lands there even after that turn ended. Thread-scoped runs (no turn id,
 * such as SessionStart) go to the running turn, or wait for the next one.
 */
export class CodexHookRuns {
  /** Runs still going, by item id, with the turn they show in. */
  private readonly running = new Map<string, { turnId: string; item: HookRun }>();
  /** The latest state of runs reported while no turn ran, by item id. */
  private readonly held = new Map<string, HookRun>();

  constructor(private readonly o: CodexHookRunsOptions) {}

  /** A `hook/started` (`done` false) or `hook/completed` notification of this thread. */
  handle(turnId: string | null, run: HookRunSummary, done: boolean): void {
    const item = codexHookRun(run, done);
    const known = this.running.get(item.id)?.turnId;
    const target = known ?? turnId ?? this.o.current();
    if (!target) {
      this.held.delete(item.id);
      if (this.held.size >= MAX_RUNS) this.held.delete(this.held.keys().next().value as string);
      this.held.set(item.id, item);
      return;
    }
    if (!known && target !== this.o.current()) this.o.beginTurn(target);
    this.show(target, item);
  }

  /** A turn began: the runs that waited for one show in it. */
  turnStarted(turnId: string): void {
    const held = [...this.held.values()];
    this.held.clear();
    for (const item of held) this.show(turnId, item);
  }

  /**
   * A turn ended. Runs still going in a turn that didn't complete end as cancelled; in a
   * completed turn they stay open for Codex to report.
   */
  turnEnded(turnId: string, completed: boolean): void {
    if (completed) return;
    for (const [id, run] of this.running) {
      if (run.turnId !== turnId) continue;
      this.running.delete(id);
      const outcome = "cancelled";
      this.o.emit(turnId, "item.completed", {
        ...run.item,
        status: HOOK_RUN_STATUS[outcome],
        outcome,
      });
    }
  }

  private show(turnId: string, item: HookRun): void {
    if (item.outcome !== "running") {
      this.running.delete(item.id);
      this.o.emit(turnId, "item.completed", item);
      return;
    }
    if (this.running.size >= MAX_RUNS) {
      this.running.delete(this.running.keys().next().value as string);
    }
    this.running.set(item.id, { turnId, item });
    this.o.emit(turnId, "item.started", item);
  }
}
