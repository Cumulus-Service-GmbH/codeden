import { randomUUID } from "node:crypto";
import {
  type ProjectTeams,
  type StartTeamRun,
  type TeamCoordinationMessage,
  type TeamMember,
  type TeamReviewRecord,
  type TeamRole,
  type TeamRun,
  type TeamWorker,
  type TeamWorkerJev,
  teamMember,
} from "@codeden/contracts";
import { ServiceError } from "../errors";
import type { TeamReviewEvidence } from "./team-run-jev";
import { checkpoint, reviewAndMerge } from "./team-run-review";
import { assignmentRoundLimit, eligibleAssignments, resolveRunTeam } from "./team-run-scheduler";

type DeferredFinding = { location: string; summary: string; receipt: string };
type ReviewApproval = { head: string; evidence?: TeamReviewEvidence; debt?: DeferredFinding[] };
type TeamReviewResult = (ReviewApproval | { changes: string; history: string; head?: string }) & {
  record?: TeamReviewRecord;
};

export interface TeamRunPorts {
  configuration(projectId: string): { teams: ProjectTeams; defaults: readonly TeamMember[] };
  approvedPlan(
    projectId: string,
    request: StartTeamRun,
  ): Promise<{ revision: string; items: TeamRun["items"] } | undefined>;
  vendor(member: TeamMember): string | undefined;
  freeAgentSlots(): number;
  launch(
    member: TeamMember,
    branch: string,
    base: string,
    run: TeamRun,
    item?: TeamRun["items"][number],
    packet?: string,
    onStarted?: (sessionId: string) => void,
  ): Promise<{ sessionId: string; branch: string; worktree: string; baseHead?: string }>;
  prepareAssembler(run: TeamRun, coordinatorId: string): Promise<string>;
  hasWorkerSession(sessionId: string): boolean;
  coordinate(sessionId: string, message: TeamCoordinationMessage): Promise<void>;
  seal?(run: TeamRun, worker: TeamWorker): Promise<void>;
  writerResponse?(worker: TeamWorker): string | undefined;
  head(run: TeamRun, worker: TeamWorker): Promise<string>;
  review(
    run: TeamRun,
    worker: TeamWorker,
    context: {
      reviewRunId: string;
      candidateHead?: string;
      deltaBase?: string;
      historyPath?: string;
      historyBrief?: string;
      historySha256?: string;
      refusal?: TeamWorkerJev["receipt"];
    },
  ): Promise<TeamReviewResult>;
  arbiter?(
    run: TeamRun,
    worker: TeamWorker,
    context: { historyPath?: string; historySha256?: string },
  ): Promise<NonNullable<TeamWorker["arbiter"]> & { approval?: ReviewApproval }>;
  defer?(run: TeamRun, worker: TeamWorker, findings: DeferredFinding[]): Promise<void>;
  capture?(run: TeamRun, worker: TeamWorker): Promise<{ head: string; history: string }>;
  history?(run: TeamRun, worker: TeamWorker): Promise<string>;
  gate(
    run: TeamRun,
    worker: TeamWorker,
    review: Extract<TeamReviewResult, { head: string }>,
    historyPath?: string,
  ): Promise<TeamWorkerJev>;
  ownerDecision(run: TeamRun, worker: TeamWorker): void;
  /** Merge the immutable candidate, conditional on the worker ref still naming that commit. */
  merge(
    run: TeamRun,
    worker: TeamWorker,
    reviewedHead: string,
  ): Promise<{ conflict?: string; headMoved?: boolean; needsResolution?: boolean }>;
  verify(run: TeamRun): Promise<void>;
  save(run: TeamRun): void;
}

function member(team: readonly TeamMember[], role: TeamRole): TeamMember {
  const resolved = teamMember(team, role);
  if (!resolved) throw new Error(`Missing Team role: ${role}`);
  return resolved;
}

function validatePlan(items: TeamRun["items"], max: number) {
  if (!items.length || items.length > max) throw new Error("Plan exceeds assignment limits");
  const pending = new Map(items.map((item) => [item.id, item.dependsOn]));
  if (pending.size !== items.length) throw new Error("Duplicate plan item");
  const completed = new Set<string>();
  while (pending.size) {
    const ready = [...pending].filter(([, dependencies]) =>
      dependencies.every((dependency) => completed.has(dependency)),
    );
    if (!ready.length) throw new Error("Invalid plan dependencies");
    for (const [id] of ready) {
      pending.delete(id);
      completed.add(id);
    }
  }
}

/** Drives approved assignments through the session, review, and assembler boundaries. */
export class TeamRuns {
  private readonly runs = new Map<string, TeamRun>();
  private pending = Promise.resolve();

  constructor(
    private readonly ports: TeamRunPorts,
    initial: TeamRun[] = [],
  ) {
    for (const stored of initial) {
      const run = structuredClone(stored);
      this.runs.set(run.id, run);
      for (const worker of run.workers) {
        if (worker.jev?.status === "owner decision") this.ports.ownerDecision(run, worker);
      }
      const running = run.workers.filter((worker) => worker.status === "running");
      if (!running.length) {
        if (run.status !== "running") {
          const blocked =
            run.status === "waiting" &&
            run.notice &&
            run.workers.find(
              (worker) =>
                worker.jev?.status !== "owner decision" &&
                (worker.status === "waiting" || worker.status === "failed"),
            );
          if (blocked) this.ports.ownerDecision(run, blocked);
          continue;
        }
        if (run.coordinatorId && eligibleAssignments(run.workers, run.limits, 1).length) continue;
      }
      const reason = "Team run interrupted by server restart";
      for (const worker of running) {
        if (
          worker.sessionId &&
          (worker.step === "writing" || worker.step === "delta") &&
          this.ports.hasWorkerSession(worker.sessionId)
        ) {
          worker.reconciling = true;
        } else {
          delete worker.reconciling;
          checkpoint(worker, "waiting", reason);
        }
      }
      if (!run.coordinatorId || !running.some((worker) => worker.reconciling)) {
        run.status = "waiting";
        run.notice = reason;
      }
      this.save(run);
      if (run.status === "waiting") {
        const blocked = running.find((worker) => worker.status === "waiting");
        if (blocked) this.ports.ownerDecision(run, blocked);
      }
    }
  }

  async finishWorker(sessionId: string, failure: string | null): Promise<void> {
    await this.pending;
    const runId = this.runForWorker(sessionId);
    if (runId) await this.finish(runId, sessionId, failure);
    else await this.dispatchAvailable();
  }

  dispatchAvailable(): Promise<void> {
    return this.serialize(async () => {
      for (const run of this.runs.values()) {
        if (run.coordinatorId && run.status === "running") await this.dispatch(run);
      }
    });
  }

  private runForWorker(sessionId: string): string | undefined {
    for (const run of this.runs.values()) {
      if (
        run.workers.some((worker) => worker.sessionId === sessionId && worker.status === "running")
      ) {
        return run.id;
      }
    }
    return undefined;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private save(run: TeamRun) {
    this.ports.save(structuredClone(run));
    this.runs.set(run.id, run);
  }

  start(projectId: string, request: StartTeamRun): Promise<TeamRun> {
    return this.serialize(async () => {
      const { teams, defaults } = this.ports.configuration(projectId);
      const {
        id: teamId,
        name: teamName,
        team,
        limits,
      } = resolveRunTeam(teams, request.teamId, defaults);
      const plan = await this.ports.approvedPlan(projectId, request);
      if (!plan) throw new Error("An approved plan is required");
      validatePlan(plan.items, limits.maxAssignments);
      const architect = member(team, "architect");
      const writer = member(team, "writer");
      const reviewer = member(team, "reviewer");
      const tester = member(team, "browserTester");
      const vendors = [architect, writer, reviewer, tester].map((role) =>
        this.ports.vendor(role)?.trim().toLowerCase(),
      );
      if (vendors.some((vendor) => !vendor || vendor === "unknown")) {
        throw new Error("Unknown Team vendor");
      }
      if (vendors[1] === vendors[2]) {
        throw new Error("Writer and reviewer must use different vendors");
      }
      if (this.ports.freeAgentSlots() < 1) throw new Error("No free agent slots");

      const id = randomUUID();
      const run: TeamRun = {
        id,
        projectId,
        teamId,
        teamName,
        team,
        limits,
        ...plan,
        assembler: `team/${id}`,
        coordinatorId: null,
        status: "running",
        notice: null,
        workers: plan.items.map(({ id: itemId, dependsOn }) => ({
          itemId,
          dependsOn,
          provider: writer.provider,
          model: writer.model,
          effort: writer.effort,
          sessionId: null,
          branch: null,
          worktree: null,
          status: "queued",
          attempt: 0,
          checkpoint: null,
        })),
      };
      this.save(run);
      try {
        const coordinator = await this.ports.launch(architect, `team-architect/${id}`, "", run);
        run.coordinatorId = coordinator.sessionId;
        run.assemblerWorktree = await this.ports.prepareAssembler(run, coordinator.sessionId);
        this.save(run);
        await this.dispatch(run);
      } catch (error) {
        run.status = "waiting";
        run.notice = String(error);
        this.save(run);
        const worker = run.workers[0];
        if (worker) this.ports.ownerDecision(run, worker);
      }
      return structuredClone(run);
    });
  }

  finish(id: string, sessionId: string, failure: string | null): Promise<TeamRun> {
    return this.serialize(async () => {
      const run = this.runs.get(id);
      const worker = run?.workers.find((entry) => entry.sessionId === sessionId);
      if (!run || !worker || worker.status !== "running") {
        throw new Error("No running assignment for this session");
      }
      const coordinatorId = run.coordinatorId;
      if (!coordinatorId) throw new Error("Missing Team coordinator");
      delete worker.reconciling;
      const roundLimit = assignmentRoundLimit(worker, run.limits.maxRounds);
      const identity = { itemId: worker.itemId, attempt: worker.attempt };
      try {
        await this.ports.coordinate(coordinatorId, {
          type: failure === null ? "worker_finished" : "worker_failed",
          ...identity,
        });
        if (failure === null || worker.attempt < roundLimit) {
          await this.ports.seal?.(run, worker);
        }
        if (failure !== null) {
          checkpoint(worker, "failed", failure);
          if (worker.checkpoint) {
            worker.checkpoint.summary =
              this.ports.writerResponse?.(worker) ??
              "See the preserved worker branch for completed work.";
            worker.checkpoint.nextSteps = `Resolve the blocker: ${failure}\nThen finish the remaining acceptance criteria in plan order.`;
          }
        } else {
          await reviewAndMerge(this.ports, run, worker, coordinatorId, (value) => this.save(value));
        }
      } catch (error) {
        checkpoint(worker, "waiting", String(error));
      }
      const progress = [
        worker.itemId,
        worker.status,
        `round ${worker.attempt}/${roundLimit}`,
        worker.checkpoint?.blocker?.split(/\r?\n/, 1)[0],
      ]
        .filter(Boolean)
        .join(" · ");
      worker.progress = progress;
      this.save(run);
      await this.dispatch(run);
      if (run.workers.every((entry) => entry.status === "completed")) {
        try {
          await this.ports.verify(run);
          run.status = "ready";
        } catch (error) {
          run.status = "waiting";
          run.notice = String(error);
        }
      } else {
        const blocked = run.workers.find(
          (entry) =>
            entry.status === "waiting" ||
            (entry.status === "failed" &&
              entry.attempt >= assignmentRoundLimit(entry, run.limits.maxRounds)),
        );
        if (blocked) {
          run.status = "waiting";
          run.notice = blocked.checkpoint?.blocker ?? null;
        }
      }
      this.save(run);
      const blocker =
        run.status === "waiting" &&
        run.workers.find(
          (entry) =>
            entry.status === "waiting" ||
            (entry.status === "failed" &&
              entry.attempt >= assignmentRoundLimit(entry, run.limits.maxRounds)),
        );
      if (blocker && blocker.jev?.status !== "owner decision")
        this.ports.ownerDecision(run, blocker);
      else if (run.status === "waiting" && !blocker && run.notice)
        this.ports.ownerDecision(run, worker);
      await this.ports.coordinate(coordinatorId, {
        type: "continue",
        itemId: worker.itemId,
        progress,
      });
      return structuredClone(run);
    });
  }

  private async dispatch(run: TeamRun) {
    while (true) {
      const [itemId] = eligibleAssignments(run.workers, run.limits, this.ports.freeAgentSlots());
      if (!itemId) return;
      const worker = run.workers.find((entry) => entry.itemId === itemId);
      const item = run.items.find((entry) => entry.id === itemId);
      if (!worker || !item) throw new Error("Assignment is outside the approved plan");
      const previous = structuredClone(worker);
      const index = run.workers.indexOf(worker);
      const resolving = worker.step === "merge" && worker.resolutionHead && !worker.resolutionBase;
      const base = resolving ? run.assembler : (worker.branch ?? run.assembler);
      worker.status = "running";
      worker.step = worker.checkpoint ? "delta" : "writing";
      worker.jev = { status: "pending" };
      worker.attempt += 1;
      worker.startedAt = Date.now();
      worker.sessionId = null;
      worker.branch = null;
      worker.worktree = null;
      this.save(run);
      try {
        const resources = await this.ports.launch(
          member(run.team, "writer"),
          `work/${run.id}/${index + 1}-${worker.attempt}`,
          base,
          run,
          item,
          worker.checkpoint
            ? `Completed work\n${worker.checkpoint.summary}\n\nRemaining work, in order\n${worker.checkpoint.nextSteps}`
            : undefined,
          (sessionId) => {
            worker.sessionId = sessionId;
            this.save(run);
          },
        );
        Object.assign(worker, { ...resources, baseHead: worker.baseHead ?? resources.baseHead });
        if (resolving) worker.resolutionBase = resources.baseHead;
      } catch (error) {
        if (
          error instanceof ServiceError &&
          error.code === "team_launch_refused" &&
          !worker.sessionId
        ) {
          run.workers[index] = { ...previous, progress: error.message };
          this.save(run);
          return;
        }
        checkpoint(worker, "waiting", String(error));
        run.status = "waiting";
        run.notice = worker.checkpoint?.blocker ?? null;
        this.save(run);
        this.ports.ownerDecision(run, worker);
        return;
      }
      this.save(run);
    }
  }
}
