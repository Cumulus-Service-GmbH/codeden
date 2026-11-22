import { mkdirSync } from "node:fs";
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
import { createServices } from "../src/services/container";
import type { RunnerPort } from "../src/services/runner-port";
import { listTeamRuns, saveTeamRun } from "../src/services/sessions/team-run-projection";
import { TeamRuns } from "../src/services/sessions/team-runs";
import { SettingsStore } from "../src/settings-store";
import { createGithubEnv } from "./support/github-env";

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
    limits: { maxParallel: index + 1, maxAssignments: 2, maxRounds: 2 },
  })),
};

function setup(save: (run: TeamRun) => void = () => {}, initial: TeamRun[] = []) {
  const merge = vi.fn(
    async (): Promise<{ conflict?: string }> => ({ conflict: "Conflicting files" }),
  );
  const launch = vi.fn(async (member: TeamMember, branch: string, base: string) => ({
    sessionId: `${member.model}/${branch}`,
    branch,
    worktree: `${base}/${branch}`,
  }));
  const coordinate = vi.fn(async () => {});
  const verify = vi.fn(async () => {});
  const head = vi.fn(async () => "a".repeat(40));
  const review = vi.fn(
    async (): Promise<{ head: string } | { changes: string; history: string }> => ({
      head: "a".repeat(40),
    }),
  );
  const gate = vi.fn(async () => ({
    status: "pass" as "pass" | "revise" | "unavailable",
    receipt: { head: "a".repeat(40), historyPath: "/history", historySha256: "b".repeat(64) },
  }));
  const ownerDecision = vi.fn();
  const runs = new TeamRuns(
    {
      approvedPlan: async (_projectId, request) =>
        "checklistId" in request && request.checklistId === "approved"
          ? {
              revision: "approved-v1",
              items: ["a", "b"].map((id) => ({ id, text: id, dependsOn: [] })),
            }
          : undefined,
      configuration: () => ({ teams, defaults: [] }),
      vendor: (member) => (member.role === "reviewer" ? "review-vendor" : "writer-vendor"),
      freeAgentSlots: () => 8,
      launch,
      coordinate,
      head,
      review,
      gate,
      ownerDecision,
      merge,
      verify,
      save,
    },
    initial,
  );
  return { runs, launch, merge, coordinate, verify, gate, review, head, ownerDecision };
}

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
  });
  expect(coordinate).toHaveBeenCalledWith(run.coordinatorId, {
    type: "worker_finished",
    itemId: "a",
    attempt: 1,
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
  const { runs } = setup();
  const run = await runs.start("project", { checklistId: "approved" });
  const first = run.workers[0]?.sessionId ?? "";
  const retried = await runs.finish(run.id, first, "Worker failed");
  const second = retried.workers[0]?.sessionId ?? "";
  expect(second).not.toBe(first);
  expect(retried.workers[0]).toMatchObject({ attempt: 2, status: "running" });
  await expect(runs.finish(run.id, first, null)).rejects.toThrow("No running assignment");
  const exhausted = await runs.finish(run.id, second, "Retry failed");
  expect(exhausted).toMatchObject({ status: "waiting", notice: "Retry failed" });
  expect(exhausted.workers[0]).toMatchObject({ attempt: 2, status: "failed" });
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

it("starts both named Teams through MCP and handles a runner completion conflict", async () => {
  const env = createGithubEnv();
  try {
    const project = { ...env.localProject, teams };
    mkdirSync(project.path);
    env.store.append([{ type: "project.updated", sessionId: null, payload: { project } }]);
    const paths = ensureHome(join(env.dir, "home"));
    const prepared: RunnerCommandOf<"workspace.prepare">[] = [];
    const opened: RunnerCommandOf<"session.start">[] = [];
    const merged: RunnerCommandOf<"git.mergeTeamWorker">[] = [];
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
        if (command.name === "git.branches") {
          return {
            branches: prepared.map(({ branch }) => ({
              name: branch,
              remote: false,
              commit: "a".repeat(40),
            })),
          };
        }
        if (command.name === "git.mergeTeamWorker") {
          merged.push(command);
          return { conflict: "Conflicting files" };
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
        review: async () => ({ head: "a".repeat(40) }),
        verify: async () => {},
      },
    });
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
    expect(prepared[1]?.baseRef).toBe(prepared[0]?.branch);
    expect(prepared[3]?.baseRef).toBe(prepared[2]?.branch);
    expect(new Set(prepared.map(({ path }) => path)).size).toBe(4);

    const run = TeamRun.parse(JSON.parse(first.text));
    const sessionId = run.workers[0]?.sessionId;
    if (!sessionId) throw new Error("Worker was not launched");
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
        cwd: prepared[0]?.path,
        assembler: run.assembler,
        workerBranch: run.workers[0]?.branch,
        head: "a".repeat(40),
      },
    ]);
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
  expect(ownerDecision).toHaveBeenCalledOnce();
  expect(result.workers[0]).toMatchObject({ status: "waiting", jev: { status: "owner decision" } });
  expect(merge).not.toHaveBeenCalled();
});

it("records interrupted assignments as waiting on restart", async () => {
  const { runs } = setup();
  const run = await runs.start("project", { checklistId: "approved" });
  const save = vi.fn();
  const restored = setup(save, [run]);
  await restored.runs.finishWorker(run.workers[0]?.sessionId ?? "", null);
  expect(save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      status: "waiting",
      workers: [
        expect.objectContaining({ status: "waiting" }),
        expect.objectContaining({ status: "queued" }),
      ],
    }),
  );
  expect(restored.launch).not.toHaveBeenCalled();
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
