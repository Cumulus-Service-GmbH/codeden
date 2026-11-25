import { createHash } from "node:crypto";

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventEnvelope,
  type ProjectTeams,
  type RunnerCommandName,
  type RunnerCommandOf,
  type TeamMember,
  TeamRun,
} from "@codeden/contracts";
import { FakeProvider, ImageEngineRegistry } from "@codeden/providers";
import { expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { applyProjection } from "../src/events/projector";
import { EventStore } from "../src/events/store";
import { ensureHome } from "../src/paths";
import { sessionRoutes } from "../src/routes/sessions";
import { createServices } from "../src/services/container";
import { conflict } from "../src/services/errors";
import type { RunnerPort } from "../src/services/runner-port";
import {
  listTeamRuns,
  listTeamRunsForSnapshot,
  saveTeamRun,
} from "../src/services/sessions/team-run-projection";
import { resolveApprovedTeamPlan } from "../src/services/sessions/team-run-scheduler";
import { type TeamRunPorts, TeamRuns } from "../src/services/sessions/team-runs";
import { SettingsStore } from "../src/settings-store";
import { createGithubEnv } from "./support/github-env";
import { removeTree } from "./support/remove-tree";

const teams: ProjectTeams = {
  defaultTeamId: "build",
  teams: ["build", "release"].map((id, index) => ({
    id,
    name: id,
    team: (["architect", "writer", "reviewer", "browserTester"] as const).map((role) => ({
      role,
      provider: "fake",
      model: `${id}-${role}`,
      effort: "low",
    })),
    limits: { maxParallel: index + 1, maxAssignments: 3, maxRounds: 2 },
  })),
};

function setup(
  save: (run: TeamRun) => void = () => {},
  initial: TeamRun[] = [],
  criteria?: string[],
  itemIds = ["a", "b"],
  history?: TeamRunPorts["history"],
  capture?: TeamRunPorts["capture"],
) {
  const merge = vi.fn(
    async (): Promise<{ conflict?: string; needsResolution?: boolean }> => ({
      conflict: "Conflicting files",
    }),
  );
  const launch = vi.fn(
    async (
      member: TeamMember,
      branch: string,
      base: string,
      _run: TeamRun,
      _item?: TeamRun["items"][number],
      _packet?: string,
    ) => ({
      sessionId: `${member.model}/${branch}`,
      branch,
      worktree: `${base}/${branch}`,
      baseHead: (base.startsWith("work/") ? "c" : "b").repeat(40),
    }),
  );
  const coordinate = vi.fn(async () => {});
  const verify = vi.fn(async () => {});
  const head = vi.fn(async () => "a".repeat(40));
  const review = vi.fn<TeamRunPorts["review"]>(async () => ({ head: "a".repeat(40) }));
  const gate = vi.fn(async () => ({
    status: "pass" as "pass" | "revise" | "unavailable",
    receipt: { head: "a".repeat(40), historyPath: "/history", historySha256: "b".repeat(64) },
  }));
  const ownerDecision = vi.fn();
  const arbiter = vi.fn<NonNullable<TeamRunPorts["arbiter"]>>(async () => ({
    verdict: "FIX REQUIRED",
    reason: "Add a regression test.",
  }));
  const defer = vi.fn(async () => {});
  const runs = new TeamRuns(
    {
      approvedPlan: async (_projectId, request) =>
        "checklistId" in request && request.checklistId === "approved"
          ? {
              revision: "approved-v1",
              items: itemIds.map((id) => ({ id, text: id, dependsOn: [], criteria })),
            }
          : undefined,
      configuration: () => ({ teams, defaults: [] }),
      vendor: (member) => (member.role === "reviewer" ? "review-vendor" : "writer-vendor"),
      freeAgentSlots: () => 8,
      launch,
      prepareAssembler: async () => "/assembler",
      hasWorkerSession: () => true,
      coordinate,
      head,
      review,
      history,
      capture,
      gate,
      ownerDecision,
      arbiter,
      defer,
      merge,
      verify,
      save,
    },
    initial,
  );
  return {
    runs,
    launch,
    merge,
    coordinate,
    verify,
    gate,
    review,
    head,
    ownerDecision,
    arbiter,
    defer,
  };
}

it("refuses a captured review without authenticated reviewer provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeden-team-receipt-"));
  try {
    const path = join(dir, "history.md");
    writeFileSync(path, "");
    const head = "a".repeat(40);
    const { runs, gate, merge } = setup(
      undefined,
      [],
      undefined,
      ["a"],
      async () => path,
      async () => ({ head, history: "Candidate" }),
    );
    const run = await runs.start("project", { checklistId: "approved" });
    const finished = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
    expect(finished.workers[0]?.checkpoint?.blocker).toContain("reviewer receipt");
    expect(gate).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  } finally {
    await removeTree(dir);
  }
});

it("raises an owner decision when the assignment exhausts its rounds", async () => {
  const { runs, ownerDecision } = setup(undefined, [], undefined, ["a"]);
  const first = await runs.start("project", { checklistId: "approved" });
  const second = await runs.finish(first.id, first.workers[0]?.sessionId ?? "", "Build failed");
  const last = await runs.finish(first.id, second.workers[0]?.sessionId ?? "", "Still failing");
  expect(last.status).toBe("waiting");
  expect(ownerDecision).toHaveBeenCalledOnce();
  expect(ownerDecision).toHaveBeenCalledWith(
    expect.objectContaining({ id: first.id }),
    expect.objectContaining({ itemId: "a", status: "failed" }),
  );
});

it("retries a refused launch that left no worker session", async () => {
  const save = vi.fn();
  const { runs, launch } = setup(save, [], undefined, ["a"]);
  const launchWorker = launch.getMockImplementation();
  if (!launchWorker) throw new Error("Missing launch fixture");
  launch
    .mockImplementationOnce(launchWorker)
    .mockRejectedValueOnce(conflict("No slot was available", "team_launch_refused"));
  const run = await runs.start("project", { checklistId: "approved" });
  expect(run.status).toBe("running");
  expect(run.workers[0]).toMatchObject({ status: "queued", attempt: 0, sessionId: null });
  const restarted = setup(save, [run], undefined, ["a"]);
  expect(restarted.launch).not.toHaveBeenCalled();
  await restarted.runs.finishWorker("unrelated-session-that-freed-a-slot", null);
  expect(restarted.launch).toHaveBeenCalledOnce();
  expect(TeamRun.parse(save.mock.lastCall?.[0]).workers[0]).toMatchObject({
    status: "running",
    attempt: 1,
    sessionId: expect.stringContaining("-1"),
  });
});

it("limits ready Team history in snapshots while keeping all runs for recovery", async () => {
  const env = createGithubEnv();
  try {
    const { runs } = setup();
    const sample = await runs.start(env.localProject.id, { checklistId: "approved" });
    saveTeamRun(env.store, sample);
    for (let i = 0; i < 24; i++) {
      saveTeamRun(env.store, { ...sample, id: `ready-${i}`, status: "ready" });
    }
    const snapshot = listTeamRunsForSnapshot(env.db.db);
    expect(snapshot).toHaveLength(21);
    expect(snapshot.map(({ id }) => id)).toContain(sample.id);
    expect(snapshot.map(({ id }) => id)).toContain("ready-23");
    expect(snapshot.map(({ id }) => id)).not.toContain("ready-0");
    expect(listTeamRuns(env.db.db)).toHaveLength(25);
  } finally {
    await env.close();
  }
});

it("keeps approved assignment criteria and valid UTF-8 in the bounded review history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeden-team-review-"));
  try {
    const path = join(dir, "history.md");
    const criterion = "Retain the approved criterion.";
    writeFileSync(path, `Approved plan approved-v1\n${criterion}\n界${"x".repeat(5_998)}`);
    const { runs, review } = setup(undefined, [], [criterion], ["a"], async () => path);
    const run = await runs.start("project", { checklistId: "approved" });
    await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
    const brief = review.mock.calls[0]?.[2].historyBrief;
    expect(brief).toContain(path);
    expect(brief).toContain("Approved plan approved-v1");
    expect(brief).toContain(criterion);
    expect(brief).not.toContain("\uFFFD");
    expect(brief).toContain("x".repeat(5_998));
  } finally {
    await removeTree(dir);
  }
});

it("uses the selected Team's models and dispatch cap", async () => {
  const { runs, launch } = setup();
  const build = await runs.start("project", { checklistId: "approved" });
  const release = await runs.start("project", { teamId: "release", checklistId: "approved" });
  expect(launch.mock.calls.map(([member]) => member.model)).toEqual([
    "build-architect",
    "build-writer",
    "release-architect",
    "release-writer",
    "release-writer",
  ]);
  expect(build.workers.map((worker) => worker.status)).toEqual(["running", "queued"]);
  expect(release.workers.map((worker) => worker.status)).toEqual(["running", "running"]);
  expect(release.workers[0]?.branch).not.toEqual(release.workers[1]?.branch);
});

it("creates one worker per plan item, each on its own branch and checkout off the assembler branch, with at most maxParallel running", async () => {
  const itemIds = ["a", "b", "c"];
  const save = vi.fn(
    (run: TeamRun) => run.workers.filter(({ status }) => status === "running").length,
  );
  const { runs, launch, merge } = setup(save, [], undefined, itemIds);
  merge.mockResolvedValue({});

  const run = await runs.start("project", { teamId: "release", checklistId: "approved" });
  expect(run.limits.maxParallel).toBe(2);
  expect(run.workers.map(({ itemId }) => itemId)).toEqual(itemIds);
  expect(run.workers.map(({ status }) => status)).toEqual(["running", "running", "queued"]);
  expect(launch.mock.calls.filter(([member]) => member.role === "writer")).toHaveLength(2);

  const next = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  expect(next.workers.map(({ status }) => status)).toEqual(["completed", "running", "running"]);
  expect(Math.max(...save.mock.results.map(({ value }) => value))).toBe(2);

  const assignments = launch.mock.calls.filter(([member]) => member.role === "writer");
  expect(assignments.map(([, , base, , item]) => [base, item?.id])).toEqual(
    itemIds.map((id) => [run.assembler, id]),
  );
  for (const worker of next.workers) {
    expect(worker).toMatchObject({
      branch: expect.any(String),
      worktree: expect.any(String),
      baseHead: "b".repeat(40),
    });
    expect(worker.branch).not.toBe(run.assembler);
    expect(worker.worktree).not.toBe(run.assemblerWorktree);
  }
  expect(new Set(next.workers.map(({ branch }) => branch)).size).toBe(3);
  expect(new Set(next.workers.map(({ worktree }) => worktree)).size).toBe(3);
});

it("keeps merge conflicts waiting and sends typed coordination", async () => {
  const { runs, merge, coordinate } = setup();
  const run = await runs.start("project", { checklistId: "approved" });
  const result = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  expect(merge).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.anything(),
    "a".repeat(40),
  );
  expect(result.workers[0]).toMatchObject({
    status: "waiting",
    checkpoint: { blocker: "Conflicting files" },
    step: "merge",
  });
  expect(coordinate).toHaveBeenCalledWith(run.coordinatorId, {
    type: "worker_finished",
    itemId: "a",
    attempt: 1,
  });
  expect(coordinate).toHaveBeenCalledWith(run.coordinatorId, {
    type: "continue",
    itemId: "a",
    progress: "a · waiting · round 1/2 · Conflicting files",
  });
});

it("refuses unapproved plans and unknown Teams before launching", async () => {
  const { runs, launch } = setup();
  await expect(runs.start("project", { checklistId: "draft" })).rejects.toThrow("approved");
  await expect(
    runs.start("project", { teamId: "unknown", checklistId: "approved" }),
  ).rejects.toThrow("Unknown Team");
  expect(launch).not.toHaveBeenCalled();
});

it("rebuilds worker state and conflict notices from the event log", async () => {
  const live = openDatabase(":memory:");
  const rebuilt = openDatabase(":memory:");
  try {
    const store = new EventStore(live.db);
    const { runs } = setup((run) => saveTeamRun(store, run));
    const run = await runs.start("project", { checklistId: "approved" });
    const result = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
    for (const raw of store.listAfter(0)) {
      rebuilt.db.transaction((tx) => applyProjection(tx, EventEnvelope.parse(raw)));
    }
    expect(listTeamRuns(live.db)).toEqual([result]);
    expect(listTeamRuns(rebuilt.db)).toEqual([result]);
  } finally {
    live.close();
    rebuilt.close();
  }
});

it("retries a failed worker, ignores the superseded session, and reports exhaustion", async () => {
  const { runs, launch } = setup();
  const run = await runs.start("project", { checklistId: "approved" });
  const first = run.workers[0]?.sessionId ?? "";
  const retried = await runs.finish(run.id, first, "Worker failed");
  const second = retried.workers[0]?.sessionId ?? "";
  expect(second).not.toBe(first);
  const retry = launch.mock.calls.find(
    ([member, branch]) => `${member.model}/${branch}` === second,
  );
  expect(retry?.[2]).toBe(run.workers[0]?.branch);
  expect(retry?.[5]).toMatch(/Completed work[\s\S]*Remaining work[\s\S]*Worker failed/);
  expect(retried.workers[0]).toMatchObject({ attempt: 2, status: "running" });
  await expect(runs.finish(run.id, first, null)).rejects.toThrow("No running assignment");
  const exhausted = await runs.finish(run.id, second, "Retry failed");
  expect(exhausted).toMatchObject({ status: "waiting", notice: "Retry failed" });
  expect(exhausted.workers[0]).toMatchObject({ attempt: 2, status: "failed" });
});

it("reviews the retry against the original base, including sealed work from the first attempt", async () => {
  const { runs, review } = setup();
  const run = await runs.start("project", { checklistId: "approved" });
  const retry = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", "Retry needed");
  await runs.finish(run.id, retry.workers[0]?.sessionId ?? "", null);
  expect(review.mock.calls[0]?.[1].baseHead).toBe("b".repeat(40));
});

it("reviews and merges all assignments before verifying the assembled result", async () => {
  const { runs, merge, verify } = setup();
  merge.mockResolvedValue({});
  const run = await runs.start("project", { checklistId: "approved" });
  const next = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  expect(next.workers[0]?.status).toBe("completed");
  expect(verify).not.toHaveBeenCalled();
  const ready = await runs.finish(run.id, next.workers[1]?.sessionId ?? "", null);
  expect(ready.status).toBe("ready");
  expect(merge).toHaveBeenCalledTimes(2);
  expect(verify).toHaveBeenCalledOnce();
});

it("commits worker changes before review and handles a runner completion conflict through MCP", async () => {
  const env = createGithubEnv();
  try {
    const project = { ...env.localProject, teams };
    mkdirSync(project.path);
    env.store.append([{ type: "project.updated", sessionId: null, payload: { project } }]);
    const paths = ensureHome(join(env.dir, "home"));
    const prepared: RunnerCommandOf<"workspace.prepare">[] = [];
    const opened: RunnerCommandOf<"session.start">[] = [];
    const merged: RunnerCommandOf<"git.mergeTeamWorker">[] = [];
    const commits: RunnerCommandOf<"git.commit">[] = [];
    const fake = new FakeProvider();
    const runner: RunnerPort = {
      isConnected: () => true,
      runnerId: () => "team-test",
      providers: () => [
        {
          id: "fake",
          displayName: "Fake",
          capabilities: { ...fake.capabilities(), modelVendor: "fake-vendor" },
          models: [],
        },
      ],
      mcpProxyUrl: () => "http://127.0.0.1:4318/mcp",
      waitForConnection: async () => true,
      request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
        if (command.name === "workspace.prepare") {
          prepared.push(command);
          return { cwd: command.path, branch: command.branch, created: true };
        }
        if (command.name === "session.start") {
          opened.push(command);
          return { resumeToken: null };
        }
        if (command.name === "git.status") {
          return {
            branch: prepared.find(({ path }) => path === command.cwd)?.branch,
            files: [{ path: "test.ts", status: "??" }],
          };
        }
        if (command.name === "git.commit") {
          commits.push(command);
          return { commit: "a".repeat(40) };
        }
        if (command.name === "git.branches") {
          return {
            branches: prepared.map(({ branch }) => ({
              name: branch,
              remote: false,
              commit: (branch?.startsWith("team/")
                ? "b"
                : branch?.endsWith("/1-1")
                  ? "c"
                  : "a"
              ).repeat(40),
            })),
          };
        }
        if (command.name === "git.diff") {
          expect(command).toMatchObject({ fromRef: "b".repeat(40), toRef: "a".repeat(40) });
          return { diff: "Frozen candidate patch" };
        }
        if (command.name === "git.mergeTeamWorker") {
          merged.push(command);
          const architect = opened.find(({ options }) => options.model === "build-architect");
          return {
            conflict:
              command.cwd === architect?.options.cwd
                ? "Architect left notes.md"
                : "Conflicting files",
          };
        }
        return {};
      }) as RunnerPort["request"],
    };
    const options: Parameters<typeof createServices>[0] = {
      db: env.db.db,
      store: env.store,
      paths,
      settings: new SettingsStore(paths.settings),
      runner,
      secrets: env.secrets,
      exec: async (_command, args) => ({
        code: 0,
        stdout: args[0] === "rev-parse" ? project.path : args[0] === "symbolic-ref" ? "main" : "",
        stderr: "",
        notFound: false,
        timedOut: false,
        path: null,
      }),
      imageEngines: new ImageEngineRegistry([]),
      userHome: env.dir,
    };
    options.settings.update({ limits: { maxActiveSessions: 8 } });
    const defaults = createServices(options);
    expect(defaults.tools.list("pm").map(({ name }) => name)).toContain("start_team_run");
    expect(
      await defaults.tools.call(
        "start_team_run",
        { checklistId: "draft" },
        {
          role: "pm",
          caller: "ui",
          sessionId: "pm-test",
          projectId: project.id,
          signal: new AbortController().signal,
        },
      ),
    ).toMatchObject({ isError: true, text: "Approved pinned-plan lookup is unavailable" });
    const sameVendor = createServices({
      ...options,
      teamRuns: {
        approvedPlan: async () => ({
          revision: "approved-v1",
          items: [{ id: "draft", text: "Draft", dependsOn: [] }],
        }),
      },
    });
    await expect(
      sameVendor.teamRuns?.start(project.id, { checklistId: "approved" }),
    ).rejects.toThrow("Writer and reviewer must use different vendors");
    expect(prepared).toHaveLength(0);
    const services = createServices({
      ...options,
      teamRuns: {
        approvedPlan: async () => ({
          revision: "approved-v1",
          items: [{ id: "draft", text: "Draft", dependsOn: [] }],
        }),
        vendor: (member) => (member.role === "reviewer" ? "review-vendor" : "writer-vendor"),
        gate: async () => ({
          status: "pass",
          receipt: { head: "a".repeat(40), historyPath: "/history", historySha256: "b".repeat(64) },
        }),
        review: async (_run, worker, context) => {
          expect(context.historySha256).toMatch(/^[a-f0-9]{64}$/);
          expect(context.historyPath).toEqual(expect.any(String));
          expect(readFileSync(context.historyPath ?? "", "utf8")).toContain(
            `Candidate ${"a".repeat(40)}`,
          );
          expect(readFileSync(context.historyPath ?? "", "utf8")).toContain(
            "Frozen candidate patch",
          );
          expect(context.historyBrief).not.toContain("Frozen candidate patch");
          expect(commits).toEqual([
            expect.objectContaining({
              cwd: prepared.find(({ branch }) => branch === worker.branch?.replace(/-2$/, "-1"))
                ?.path,
            }),
            expect.objectContaining({
              cwd: worker.worktree,
              message: "feat: complete Team assignment",
            }),
          ]);
          return {
            head: "a".repeat(40),
            record: {
              head: "a".repeat(40),
              provider: "fake",
              model: "build-reviewer",
              effort: "low",
              slot: "primary",
              receipt: "review-receipt",
            },
          };
        },
        verify: async () => {},
      },
    });
    const startSession = vi.spyOn(services.sessions, "start").mockResolvedValue({
      status: "started",
      sessionId: "role-session",
    });
    const response = await sessionRoutes(services, "token").request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, teamRole: "writer" }),
    });
    expect(response.status).toBe(200);
    expect(startSession.mock.calls[0]?.[0].model).toBe("build-writer");
    startSession.mockRestore();

    const start = (teamId?: string) =>
      services.tools.call(
        "start_team_run",
        { teamId, checklistId: "approved" },
        {
          role: "pm",
          caller: "ui",
          sessionId: "pm-test",
          projectId: project.id,
          signal: new AbortController().signal,
        },
      );
    expect(await start("unknown")).toMatchObject({ isError: true, text: "Unknown Team: unknown" });
    expect(prepared).toHaveLength(0);
    const first = await start();
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.text)).toMatchObject({
      teamId: "build",
      workers: [{ worktree: expect.any(String) }],
    });
    const second = await start("release");
    expect(second.isError).toBe(false);
    expect(JSON.parse(second.text)).toMatchObject({
      teamId: "release",
      workers: [{ worktree: expect.any(String) }],
    });
    await Promise.all(services.sessions.launching.values());
    expect(opened.map(({ options }) => options.model)).toEqual([
      "build-architect",
      "build-writer",
      "release-architect",
      "release-writer",
    ]);
    const run = TeamRun.parse(JSON.parse(first.text));
    const release = TeamRun.parse(JSON.parse(second.text));
    expect(prepared.find(({ branch }) => branch === run.workers[0]?.branch)?.baseRef).toBe(
      run.assembler,
    );
    expect(prepared.find(({ branch }) => branch === release.workers[0]?.branch)?.baseRef).toBe(
      release.assembler,
    );
    expect(new Set(prepared.map(({ path }) => path)).size).toBe(6);
    expect(run.assemblerWorktree).toBe(
      prepared.find(({ branch }) => branch === run.assembler)?.path,
    );
    const firstSessionId = run.workers[0]?.sessionId;
    if (!firstSessionId || !services.teamRuns) throw new Error("Worker was not launched");
    env.store.append([
      {
        type: "agent.thread.started",
        sessionId: firstSessionId,
        payload: { type: "thread.started", thread: { id: "root" } },
      },
      {
        type: "agent.turn.started",
        sessionId: firstSessionId,
        payload: { type: "turn.started", threadId: "root", turnId: "flaky" },
      },
      {
        type: "agent.turn.failed",
        sessionId: firstSessionId,
        payload: {
          type: "turn.failed",
          threadId: "root",
          turnId: "flaky",
          error: { kind: "transient", message: "Temporary provider failure" },
        },
      },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(listTeamRuns(env.db.db).find(({ id }) => id === run.id)?.workers[0]).toMatchObject({
      status: "running",
      attempt: 1,
      sessionId: firstSessionId,
    });
    const retried = await services.teamRuns.finish(run.id, firstSessionId, "Retry needed");
    const retry = retried.workers[0];
    expect(retry).toMatchObject({ status: "running", attempt: 2 });
    const sessionId = retry?.sessionId;
    if (!sessionId) throw new Error("Retry was not launched");
    await services.sessions.launching.get(sessionId);
    const settled = new Promise<TeamRun>((resolve) => {
      const unsubscribe = env.store.subscribe(() => {
        const updated = listTeamRuns(env.db.db).find((entry) => entry.id === run.id);
        if (updated?.status === "waiting") {
          unsubscribe();
          resolve(updated);
        }
      });
    });
    env.store.append([
      {
        type: "agent.thread.started",
        sessionId,
        payload: { type: "thread.started", thread: { id: "root" } },
      },
      {
        type: "agent.turn.started",
        sessionId,
        payload: { type: "turn.started", threadId: "root", turnId: "turn" },
      },
      {
        type: "agent.turn.completed",
        sessionId,
        payload: { type: "turn.completed", threadId: "root", turnId: "turn" },
      },
    ]);
    expect(await settled).toMatchObject({
      notice: "Conflicting files",
      workers: [{ status: "waiting" }],
    });
    expect(merged).toEqual([
      {
        name: "git.mergeTeamWorker",
        cwd: prepared.find(({ branch }) => branch === run.assembler)?.path,
        assembler: run.assembler,
        workerBranch: retry.branch,
        head: "a".repeat(40),
      },
    ]);
    services.sessionRepo.update(sessionId, (session) => ({
      ...session,
      branch: null,
      worktreePath: null,
      status: "queued",
    }));
    vi.useFakeTimers();
    try {
      const queued = vi.spyOn(services.sessions, "start").mockResolvedValueOnce({
        status: "queued",
        sessionId,
        behind: [],
      });
      const attempt = Promise.race([
        services.teamRuns.start(project.id, { checklistId: "approved" }),
        new Promise((resolve) => setTimeout(resolve, 1, "launch remained blocked")),
      ]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await attempt).toMatchObject({
        status: "waiting",
        notice: expect.stringContaining("queued"),
      });
      expect(services.sessionRepo.get(sessionId).status).toBe("stopped");
      services.sessionRepo.update(sessionId, (session) => ({ ...session, status: "starting" }));
      queued.mockResolvedValueOnce({ status: "started", sessionId });
      const incomplete = Promise.race([
        services.teamRuns.start(project.id, { checklistId: "approved" }),
        new Promise((resolve) => setTimeout(resolve, 11 * 60_000, "launch remained blocked")),
      ]);
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(await incomplete).toMatchObject({
        status: "waiting",
        notice: expect.stringContaining("worktree preparation timed out"),
      });
      queued.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  } finally {
    await env.close();
  }
});

it("refuses merge when the gate is unavailable", async () => {
  const { runs, gate, merge } = setup();
  gate.mockImplementation(async () => ({
    status: "unavailable",
    receipt: { head: "a".repeat(40), historyPath: "/history", historySha256: "b".repeat(64) },
  }));
  const run = await runs.start("project", { checklistId: "approved" });
  const result = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  expect(result.workers[0]).toMatchObject({ status: "waiting", jev: { status: "unavailable" } });
  expect(merge).not.toHaveBeenCalled();
});

it("invalidates a pass when the worker head moves during the gate", async () => {
  const { runs, head, merge } = setup();
  head.mockResolvedValueOnce("a".repeat(40)).mockResolvedValueOnce("c".repeat(40));
  const run = await runs.start("project", { checklistId: "approved" });
  const result = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  expect(result.workers[0]).toMatchObject({ status: "waiting", jev: { status: "pending" } });
  expect(merge).not.toHaveBeenCalled();
});

it("returns a product refusal to the reviewer once, then raises an owner decision", async () => {
  const { runs, gate, review, merge, ownerDecision } = setup();
  gate.mockImplementation(async () => ({
    status: "revise",
    receipt: { head: "a".repeat(40), historyPath: "/history", historySha256: "b".repeat(64) },
  }));
  const run = await runs.start("project", { checklistId: "approved" });
  const result = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  expect(review).toHaveBeenCalledTimes(2);
  const firstContext = review.mock.calls[0]?.[2];
  const secondContext = review.mock.calls[1]?.[2];
  expect(firstContext?.reviewRunId).toBeTruthy();
  expect(secondContext?.reviewRunId).toBeTruthy();
  expect(secondContext?.reviewRunId).not.toBe(firstContext?.reviewRunId);
  expect(ownerDecision).toHaveBeenCalledOnce();
  expect(result.workers[0]).toMatchObject({ status: "waiting", jev: { status: "owner decision" } });
  expect(merge).not.toHaveBeenCalled();
});

it.each(["idle", "interrupted"] as const)(
  "preserves a restored writing worker whose session is %s",
  async (status) => {
    const env = createGithubEnv();
    try {
      const { runs } = setup((run) => saveTeamRun(env.store, run));
      const run = await runs.start(env.localProject.id, { checklistId: "approved" });
      const worker = run.workers[0];
      expect(worker).toMatchObject({ step: "writing", status: "running" });
      if (!worker?.sessionId) throw new Error("Missing writing session");
      env.addSession({ id: worker.sessionId, projectId: run.projectId, status });
      const paths = ensureHome(join(env.dir, "home"));
      createServices({
        db: env.db.db,
        store: env.store,
        paths,
        settings: new SettingsStore(paths.settings),
        runner: {
          isConnected: () => false,
          runnerId: () => null,
          providers: () => [],
          mcpProxyUrl: () => null,
          waitForConnection: async () => false,
          request: async () => {
            throw new Error("Runner is unavailable");
          },
        },
        secrets: env.secrets,
        imageEngines: new ImageEngineRegistry([]),
        userHome: env.dir,
      });

      const [restored] = listTeamRuns(env.db.db);
      expect(restored).toMatchObject({ status: "running", notice: null });
      expect(restored?.workers[0]).toMatchObject({
        status: "running",
        sessionId: worker.sessionId,
        reconciling: true,
      });
    } finally {
      await env.close();
    }
  },
);

it("reviews a worker whose original session completes after the server restarts", async () => {
  const { runs } = setup();
  const run = await runs.start("project", { checklistId: "approved" });
  const save = vi.fn();
  const restored = setup(save, [run]);
  restored.merge.mockResolvedValue({});
  expect(TeamRun.parse(save.mock.calls[0]?.[0]).workers[0]?.reconciling).toBe(true);
  await restored.runs.finishWorker(run.workers[0]?.sessionId ?? "", null);
  expect(restored.review).toHaveBeenCalledOnce();
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: "running",
      workers: [
        expect.objectContaining({ status: "completed" }),
        expect.objectContaining({ status: "running" }),
      ],
    }),
  );
  expect(restored.launch).toHaveBeenCalledOnce();
});

it("preserves the reviewer escalation limit across worker attempts", async () => {
  const { runs, gate, review, ownerDecision } = setup();
  gate.mockResolvedValue({
    status: "revise",
    receipt: { head: "a".repeat(40), historyPath: "/history", historySha256: "b".repeat(64) },
  });
  review
    .mockResolvedValueOnce({ head: "a".repeat(40) })
    .mockResolvedValueOnce({ changes: "Revise the item", history: "A revision was requested." });
  const run = await runs.start("project", { checklistId: "approved" });
  const retried = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  expect(retried.workers[0]).toMatchObject({ status: "running", attempt: 2 });
  const result = await runs.finish(run.id, retried.workers[0]?.sessionId ?? "", null);
  expect(review).toHaveBeenCalledTimes(3);
  expect(ownerDecision).toHaveBeenCalledOnce();
  expect(result.workers[0]).toMatchObject({ jev: { status: "owner decision" } });
});

it("requests a coverage delta with the verbatim acceptance criterion before running Jev", async () => {
  const criterion = "A finished assignment appears in the checklist.";
  const { runs, launch, gate, review } = setup(undefined, [], [criterion]);
  review.mockResolvedValue({
    head: "a".repeat(40),
    evidence: {
      criteria: [criterion],
      evidence: ["criteria[0] tests\n ✓ shows finished assignment"],
      history: "",
    },
  });
  const run = await runs.start("project", { checklistId: "approved" });
  const result = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  expect(result.items[0]?.criteria).toEqual([criterion]);
  expect(launch.mock.calls[2]?.[5]).toContain(criterion);
  expect(launch.mock.calls[2]?.[5]).toContain("one named test per criterion");
  expect(gate).not.toHaveBeenCalled();
});

it("sends a persistent blocking finding to the Arbiter before a third review", async () => {
  const { runs, review, arbiter, merge, launch } = setup();
  review
    .mockResolvedValueOnce({
      changes: "Fix regression",
      history: "First finding",
      head: "a".repeat(40),
    })
    .mockResolvedValueOnce({
      changes: "Still broken",
      history: "Delta finding",
      head: "b".repeat(40),
    });
  const run = await runs.start("project", { checklistId: "approved" });
  const delta = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  const result = await runs.finish(run.id, delta.workers[0]?.sessionId ?? "", null);
  expect(review.mock.calls[1]?.[2].deltaBase).toBe("a".repeat(40));
  expect(arbiter).toHaveBeenCalledOnce();
  expect(result.workers[0]).toMatchObject({
    status: "running",
    attempt: 3,
    arbiter: { verdict: "FIX REQUIRED" },
  });
  expect(launch.mock.calls[3]?.[5]).toContain("Add a regression test.");
  expect(merge).not.toHaveBeenCalled();
  await runs.finish(run.id, result.workers[0]?.sessionId ?? "", null);
  expect(review).toHaveBeenCalledTimes(3);
  expect(review.mock.calls[2]?.[2].deltaBase).toBe("b".repeat(40));
  expect(merge).toHaveBeenCalledOnce();
});

it("dispatches a Writer on the assembler for a genuine merge conflict and reviews its delta", async () => {
  const { runs, launch, merge, review } = setup();
  merge.mockResolvedValueOnce({ conflict: "Conflicting files", needsResolution: true });
  const run = await runs.start("project", { checklistId: "approved" });
  const resolving = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  const worker = resolving.workers[0];
  expect(worker).toMatchObject({ status: "running", attempt: 2, resolutionHead: "a".repeat(40) });
  expect(launch.mock.calls[2]?.[2]).toBe(run.assembler);
  expect(launch.mock.calls[2]?.[5]).toContain("Preserve both sides and every test");
  merge.mockResolvedValueOnce({});
  const result = await runs.finish(run.id, worker?.sessionId ?? "", null);
  expect(review.mock.calls[1]?.[2].deltaBase).toBe("a".repeat(40));
  expect(result.workers[0]?.status).toBe("completed");
});

it("returns a pinned item to the Writer for an evidence delta before renewing Jev", async () => {
  const criterion = "A finished assignment appears in the checklist.";
  const { runs, launch, review, gate, ownerDecision } = setup(undefined, [], [criterion]);
  review.mockResolvedValue({
    head: "a".repeat(40),
    evidence: {
      criteria: [criterion],
      evidence: [
        `criteria[0] (Finished assignment) tests at ${"a".repeat(40)}\nVITEST_MAX_WORKERS=2 pnpm -s vitest run --reporter=verbose checklist.test.ts | grep -iE 'finished assignment'\n ✓ checklist.test.ts > shows finished assignment\n Test Files  1 passed (1)\n Tests  1 passed (1)`,
      ],
      history: "",
    },
  });
  gate.mockResolvedValue({
    status: "revise",
    receipt: { head: "a".repeat(40), historyPath: "/history", historySha256: "b".repeat(64) },
  });
  const run = await runs.start("project", { checklistId: "approved" });
  const delta = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  expect(gate).toHaveBeenCalledOnce();
  expect(launch.mock.calls[2]?.[5]).toContain("Jev refused");
  const result = await runs.finish(run.id, delta.workers[0]?.sessionId ?? "", null);
  expect(gate).toHaveBeenCalledTimes(2);
  expect(review.mock.calls[1]?.[2].deltaBase).toBe("a".repeat(40));
  expect(ownerDecision).toHaveBeenCalledOnce();
  expect(result.workers[0]?.jev?.status).toBe("owner decision");
});

it("records Arbiter-downgraded findings as debt before asking Jev about the same head", async () => {
  const { runs, review, arbiter, defer, gate, head, merge } = setup();
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  const debt = [{ location: "file.ts:9", summary: "Retain this verbatim.", receipt: "review-2" }];
  review
    .mockResolvedValueOnce({ changes: "Fix regression", history: "First", head: oldHead })
    .mockResolvedValueOnce({ changes: "Still broken", history: "Delta", head: newHead });
  arbiter.mockResolvedValueOnce({
    verdict: "DOWNGRADE TO LOW",
    reason: "No concrete failure scenario.",
    approval: { head: newHead, debt },
  });
  head.mockResolvedValue(newHead);
  gate.mockResolvedValue({
    status: "pass",
    receipt: { head: newHead, historyPath: "/history", historySha256: "b".repeat(64) },
  });
  merge.mockResolvedValue({});
  const run = await runs.start("project", { checklistId: "approved" });
  const delta = await runs.finish(run.id, run.workers[0]?.sessionId ?? "", null);
  const result = await runs.finish(run.id, delta.workers[0]?.sessionId ?? "", null);
  expect(defer).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(), debt);
  expect(gate).toHaveBeenCalledOnce();
  expect(result.workers[0]).toMatchObject({
    status: "completed",
    arbiter: { verdict: "DOWNGRADE TO LOW" },
  });
});

it("opens an owner-approved checklist by its project key or exact pinned digest", () => {
  const tasks = [{ id: "a", text: "Keep the owner's words." }];
  const sha = createHash("sha256").update(JSON.stringify(tasks)).digest("hex");
  const checklist = {
    projectId: "project",
    state: "approved",
    approvedAt: "2026-11-23T09:00:00.000Z",
    plan: { sha, reviewRef: "review-1", tasks },
  };
  const pinned = {
    revision: sha,
    items: [{ ...tasks[0], dependsOn: [], criteria: [tasks[0]?.text] }],
  };
  expect(resolveApprovedTeamPlan(checklist, "project", { checklistId: "project" })).toEqual(pinned);
  expect(resolveApprovedTeamPlan(checklist, "project", { planSha: sha })).toEqual(pinned);
  expect(
    resolveApprovedTeamPlan(checklist, "project", { planSha: "0".repeat(64) }),
  ).toBeUndefined();
  expect(
    resolveApprovedTeamPlan({ ...checklist, state: "draft" }, "project", { planSha: sha }),
  ).toBeUndefined();
  expect(resolveApprovedTeamPlan(checklist, "outside", { planSha: sha })).toBeUndefined();
});
