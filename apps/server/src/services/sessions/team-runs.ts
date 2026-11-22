import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import {
  type ProjectTeams,
  type StartTeamRun,
  type TeamCoordinationMessage,
  type TeamMember,
  type TeamRole,
  type TeamRun,
  type TeamWorker,
  type TeamWorkerJev,
  teamMember,
} from "@codeden/contracts";
import type { TeamReviewEvidence } from "./team-run-jev";
import { eligibleAssignments, resolveRunTeam } from "./team-run-scheduler";

type TeamReviewResult =
  | { head: string; evidence?: TeamReviewEvidence }
  | { changes: string; history: string };

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
  head(run: TeamRun, worker: TeamWorker): Promise<string>;
  review(
    run: TeamRun,
    worker: TeamWorker,
    context: { historyPath?: string; refusal?: TeamWorkerJev["receipt"] },
  ): Promise<TeamReviewResult>;
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
  ): Promise<{ conflict?: string; headMoved?: boolean }>;
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
      const interrupted = run.workers.filter((worker) => worker.status === "running");
      if (!interrupted.length && run.status !== "running") continue;
      const reason = "Team run interrupted by server restart";
      for (const worker of interrupted) this.checkpoint(worker, "waiting", reason);
      run.status = "waiting";
      run.notice = reason;
      this.save(run);
    }
  }

  async finishWorker(sessionId: string, failure: string | null): Promise<void> {
    await this.pending;
    const runId = this.runForWorker(sessionId);
    if (runId) await this.finish(runId, sessionId, failure);
    else
      await this.serialize(async () => {
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
          await this.reviewAndMerge(run, worker, coordinatorId, identity);
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

  private async reviewAndMerge(
    run: TeamRun,
    worker: TeamWorker,
    coordinatorId: string,
    identity: { itemId: string; attempt: number },
  ) {
    const historyPath = await this.ports.history?.(run, worker);

    for (let round = 0; round < 2; round++) {
      worker.jev = { status: "pending" };
      this.save(run);
      const review = await this.ports.review(run, worker, {
        historyPath,
        refusal: worker.jevRefusal,
      });
      await this.ports.coordinate(coordinatorId, { type: "review_done", ...identity });
      if ("changes" in review) {
        if (historyPath) await appendFile(historyPath, `${review.history}\n`);
        this.checkpoint(worker, "failed", "Review requested changes");
        if (worker.checkpoint) worker.checkpoint.nextSteps = review.changes;
        return;
      }
      if (review.head !== (await this.ports.head(run, worker))) {
        throw new Error("Worker head moved after review");
      }
      worker.jev = await this.ports.gate(run, worker, review, historyPath);
      if (worker.jev.status === "pass") {
        if (
          worker.jev.receipt?.head !== review.head ||
          review.head !== (await this.ports.head(run, worker))
        ) {
          worker.jev = { status: "pending" };
          throw new Error("Jev receipt does not cover the current worker head");
        }
        this.save(run);
        const { conflict, headMoved } = await this.ports.merge(run, worker, review.head);
        if (headMoved) {
          worker.jev = { status: "pending" };
          throw new Error("Jev receipt does not cover the current worker head");
        }
        this.checkpoint(worker, conflict ? "waiting" : "completed", conflict ?? null);
        return;
      }
      if (worker.jev.status !== "revise" || !worker.jev.receipt) {
        throw new Error("Jev done gate is unavailable");
      }
      if (worker.jevRefusal) {
        worker.jev = { status: "owner decision", receipt: worker.jev.receipt };
        this.checkpoint(worker, "waiting", "Jev requires an owner decision");
        this.save(run);
        this.ports.ownerDecision(run, worker);
        return;
      }
      worker.jevRefusal = worker.jev.receipt;
      this.save(run);
    }
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
