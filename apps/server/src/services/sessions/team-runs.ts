import { randomUUID } from "node:crypto";
import {
  type ProjectTeams,
  type StartTeamRun,
  type TeamCoordinationMessage,
  type TeamMember,
  type TeamRole,
  type TeamRun,
  type TeamWorker,
  teamMember,
} from "@codeden/contracts";
import { eligibleAssignments, resolveRunTeam } from "./team-run-scheduler";

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
  ): Promise<{ sessionId: string; branch: string; worktree: string }>;
  coordinate(sessionId: string, message: TeamCoordinationMessage): Promise<void>;
  review(run: TeamRun, worker: TeamWorker): Promise<{ head: string } | { changes: string }>;
  merge(run: TeamRun, worker: TeamWorker, reviewedHead: string): Promise<{ conflict?: string }>;
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
    for (const run of initial) this.runs.set(run.id, run);
  }

  async finishWorker(sessionId: string, failure: string | null): Promise<void> {
    await this.pending;
    const runId = this.runForWorker(sessionId);
    if (runId) await this.finish(runId, sessionId, failure);
    else
      await this.serialize(async () => {
        for (const run of this.runs.values()) {
          if (run.coordinatorId && run.status !== "ready") await this.dispatch(run);
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
      if ([architect, writer, reviewer, tester].some((role) => !this.ports.vendor(role))) {
        throw new Error("Unknown Team vendor");
      }
      if (this.ports.vendor(writer) === this.ports.vendor(reviewer)) {
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
        const coordinator = await this.ports.launch(architect, run.assembler, "", run);
        run.coordinatorId = coordinator.sessionId;
        run.assembler = coordinator.branch;
        this.save(run);
        await this.dispatch(run);
      } catch (error) {
        run.status = "waiting";
        run.notice = String(error);
        this.save(run);
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
      const identity = { itemId: worker.itemId, attempt: worker.attempt };
      try {
        await this.ports.coordinate(coordinatorId, {
          type: failure === null ? "worker_finished" : "worker_failed",
          ...identity,
        });
        if (failure !== null) {
          this.checkpoint(worker, "failed", failure);
        } else {
          const review = await this.ports.review(run, worker);
          await this.ports.coordinate(coordinatorId, { type: "review_done", ...identity });
          if ("changes" in review) {
            this.checkpoint(worker, "failed", "Review requested changes");
            if (worker.checkpoint) worker.checkpoint.nextSteps = review.changes;
          } else {
            const { conflict } = await this.ports.merge(run, worker, review.head);
            this.checkpoint(worker, conflict ? "waiting" : "completed", conflict ?? null);
          }
        }
      } catch (error) {
        this.checkpoint(worker, "waiting", String(error));
      }
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
            (entry.status === "failed" && entry.attempt >= run.limits.maxRounds),
        );
        if (blocked) {
          run.status = "waiting";
          run.notice = blocked.checkpoint?.blocker ?? null;
        }
      }
      this.save(run);
      return structuredClone(run);
    });
  }

  private checkpoint(worker: TeamWorker, status: TeamWorker["status"], blocker: string | null) {
    worker.status = status;
    worker.checkpoint = {
      summary: status === "completed" ? "Reviewed and merged" : "Assignment paused",
      nextSteps: blocker ?? "",
      blocker,
      updatedAt: Date.now(),
    };
  }

  private async dispatch(run: TeamRun) {
    for (const itemId of eligibleAssignments(
      run.workers,
      run.limits,
      this.ports.freeAgentSlots(),
    )) {
      const worker = run.workers.find((entry) => entry.itemId === itemId);
      const item = run.items.find((entry) => entry.id === itemId);
      if (!worker || !item) throw new Error("Assignment is outside the approved plan");
      const base =
        worker.checkpoint?.blocker === "Review requested changes"
          ? (worker.branch ?? run.assembler)
          : run.assembler;
      worker.status = "running";
      worker.attempt += 1;
      worker.startedAt = Date.now();
      worker.sessionId = null;
      worker.branch = null;
      worker.worktree = null;
      this.save(run);
      try {
        const resources = await this.ports.launch(
          member(run.team, "writer"),
          `work/${run.id}/${run.workers.indexOf(worker) + 1}-${worker.attempt}`,
          base,
          run,
          item,
        );
        Object.assign(worker, resources);
      } catch (error) {
        this.checkpoint(worker, "waiting", String(error));
        run.status = "waiting";
        run.notice = worker.checkpoint?.blocker ?? null;
      }
      this.save(run);
    }
  }
}
