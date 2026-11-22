import { EventEnvelope } from "@codeden/contracts";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { factoryLoops } from "../src/db/schema";
import { ToolError } from "../src/mcp/define";
import { type ToolCaller, ToolRegistry } from "../src/mcp/registry";
import { factoryTools } from "../src/mcp/tools/factory";
import { factoryResume, factoryStop } from "../src/mcp/tools/factory/control";
import { pauseLoop } from "../src/services/factory/context";
import { drainInboxId } from "../src/services/factory/drain";
import { regressionPausePrefix } from "../src/services/factory/revert-blocked";
import { renderProjectDigest } from "../src/services/orchestration/digest";
import { deriveNotices } from "../src/services/orchestration/notices";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

let env: FactoryEnv;
let tools: ToolRegistry;
const sessionId = "control-session";
const reason = "CI is red on main";
const input = () => ({ projectId: env.project.id, reason });
const loop = () => env.factory.data.loopOrNew(env.project.id);
const project = () => env.factory.ctx.projects.get(env.project.id);
const events = () => env.store.listAfter(0);
const caller = (role: ToolCaller["role"]): ToolCaller => ({
  role,
  projectId: role === "orchestrator" ? null : env.project.id,
  sessionId,
  caller: "mcp",
  signal: new AbortController().signal,
});
const call = (name: string, args: unknown, role: ToolCaller["role"] = "orchestrator") =>
  tools.call(name, args, caller(role));
async function result(name: string, args: unknown, role?: ToolCaller["role"]) {
  const response = await call(name, args, role);
  expect(response.isError, response.text).toBe(false);
  return JSON.parse(response.text);
}

const services = () =>
  ({
    factory: env.factory,
    projects: env.factory.ctx.projects,
    sessionRepo: env.repo,
    settings: env.settings,
  }) as never;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 22, 23, 50));
  env = createFactoryEnv();
  await env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: env.project.factoryLimits,
  });
  tools = new ToolRegistry(factoryTools, services());
});
afterEach(() => {
  env?.close();
  vi.useRealTimers();
});

async function startWork() {
  env.factory.data.createItem({
    projectId: env.project.id,
    workKey: "issue:10",
    title: "Add a counter",
    summary: "Users want to count things",
    source: "issue",
    stage: "backlog",
    type: "feature",
    investigation: {
      kind: "analysis",
      outcome: "implement",
      summary: "Missing",
      details: "A counter",
      testPath: null,
      at: new Date().toISOString(),
    },
    acceptanceCriteria: ["Counter increments"],
    issue: { number: 10, url: "https://github.com/acme/app/issues/10", title: "Add a counter" },
  });
  await env.factory.tick(env.project.id);
  expect(env.starts).toHaveLength(1);
}

it("lists loop tools for the orchestrator and excludes agents", async () => {
  const names = ["factory_pause", "factory_resume", "factory_stop", "factory_status"];
  const listed = (role: ToolCaller["role"]) => tools.list(role, caller(role)).map((t) => t.name);
  expect(listed("orchestrator")).toEqual(expect.arrayContaining(names));
  for (const name of names) {
    expect(listed("agent")).not.toContain(name);
    expect(await call(name, input(), "agent")).toEqual({
      isError: true,
      text: `Unknown tool: ${name}`,
    });
  }
});

it("requires a target from the orchestrator, confines the PM and validates reasons", async () => {
  const before = events();
  expect((await call("factory_stop", { reason })).text).toBe(
    "Pass projectId: the orchestrator controls any project's factory loop",
  );
  expect((await call("factory_pause", { projectId: "other", reason }, "pm")).text).toBe(
    "A PM controls only its own project's factory loop",
  );
  for (const value of [undefined, " "]) {
    expect((await call("factory_stop", { ...input(), reason: value })).text).toContain(
      "Invalid input for factory_stop, nothing was done",
    );
  }
  expect(events()).toEqual(before);
});

it("records a PM's drain in the event and projection", async () => {
  await startWork();
  const response = await result("factory_pause", { reason }, "pm");
  expect(response).toMatchObject({ changed: true, control: { state: "draining" } });
  const event = events().findLast((e) => e.type === "factory.loop.updated");
  expect(event?.payload).toMatchObject({
    loop: { lastControl: { action: "pause", by: "pm", sessionId, reason } },
  });
  expect(loop().lastControl).toEqual(response.control.lastControl);
  expect(event?.payload).toMatchObject({ loop: { lastControl: loop().lastControl } });
});

it("persists the stop and its attribution in the same batch before shutdown finishes", async () => {
  await startWork();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const stop = env.sessions.stop.bind(env.sessions);
  vi.spyOn(env.sessions, "stop").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return stop(...args);
  });
  let atomic = false;
  const unsubscribe = env.store.subscribe((batch) => {
    if (batch.some((e) => e.type === "project.updated")) {
      atomic = batch.some((e) => e.type === "factory.loop.updated");
    }
  });
  const stopping = result("factory_stop", input());
  try {
    await Promise.race([entered.promise, stopping]);
    expect(project().killSwitch).toBe(true);
    expect(atomic).toBe(true);
    expect(loop().lastControl).toMatchObject({ action: "stop", by: "orchestrator", reason });
  } finally {
    release.resolve();
    unsubscribe();
    await stopping;
  }
  expect(await stopping).toMatchObject({ changed: true, control: { state: "stopped" } });
});

it("records effective stops and resumes and preserves the record on no-ops and stale saves", async () => {
  const stale = loop();
  const before = events();
  expect(await result("factory_resume", input())).toMatchObject({ changed: false });
  expect(events()).toEqual(before);
  await result("factory_stop", input());
  const stopped = loop().lastControl;
  expect(await result("factory_pause", { ...input(), reason: "Try draining" })).toMatchObject({
    changed: false,
    control: { state: "stopped", lastControl: stopped },
  });
  env.factory.data.saveLoop({ ...stale, mergesToday: 1 });
  expect(loop().lastControl).toEqual(stopped);
  expect(await result("factory_resume", input())).toMatchObject({
    changed: true,
    control: { state: "running", lastControl: { action: "resume", by: "orchestrator", reason } },
  });
  expect(project().killSwitch).toBe(false);
});

it("defaults a stored legacy loop and attributes UI actions to the user", async () => {
  const { lastControl: _lastControl, ...legacy } = loop();
  env.db.db
    .update(factoryLoops)
    .set({ loop: legacy as typeof legacy & { lastControl: null } })
    .where(eq(factoryLoops.projectId, env.project.id))
    .run();
  expect(await result("factory_status", input())).toMatchObject({
    control: { state: "running", lastControl: null, line: null },
  });
  await env.factory.setKillSwitch(env.project.id, true);
  expect(loop().lastControl).toMatchObject({
    action: "stop",
    by: "user",
    sessionId: null,
    reason: null,
  });
});

it("digests a completed pause after midnight even while the switch is on", async () => {
  env.factory.data.saveLoop({
    ...loop(),
    state: "paused",
    pausedReason: "daily budget reached",
    mergesToday: 2,
  });
  const response = await result("factory_pause", input());
  const line = "Paused by orchestrator: CI is red on main";
  expect(response.control).toMatchObject({ state: "paused", line });
  const day = loop().day;
  vi.setSystemTime(new Date(2026, 10, 23, 0, 5));
  await env.factory.tick(env.project.id);
  expect(loop()).toMatchObject({ lastDigestDay: day, pausedReason: null, mergesToday: 0 });
  expect(events().findLast((e) => e.type === "factory.digest.created")?.payload).toMatchObject({
    digest: { text: expect.stringContaining(line) },
  });
  const pm = renderProjectDigest({
    project: { id: env.project.id, name: "Shop", kind: "github", mode: "software_factory" },
    running: [],
    queued: [],
    scheduled: [],
    inbox: { open: 0, items: [] },
    recent: [],
    factory: env.factory.loopSummary(env.project.id),
  });
  expect(pm).toContain(line);
});

it("attributes global controls to the user and refuses an MCP resume while globally stopped", async () => {
  await env.factory.setGlobalKillSwitch(true);
  expect(loop().lastControl).toMatchObject({ action: "stop", by: "user" });
  const before = events();
  expect(await call("factory_resume", input())).toEqual({
    isError: true,
    text: "The global kill switch is on. Only the user can release it.",
  });
  expect(events()).toEqual(before);
  await env.factory.setGlobalKillSwitch(false);
  expect(loop().lastControl).toMatchObject({ action: "resume", by: "user" });
});

it("reports a repeated concurrent stop as a no-op", async () => {
  const [first, second] = await Promise.all([
    result("factory_stop", input()),
    result("factory_stop", { ...input(), reason: "Repeated stop" }),
  ]);
  expect(first.changed).toBe(true);
  expect(second.changed).toBe(false);
  expect(second.control.lastControl.reason).toBe(reason);
});

it("lists only pause and status for the PM and refuses resume and stop without changes", async () => {
  const listed = tools.list("pm", caller("pm")).map((tool) => tool.name);
  expect(listed).toEqual(expect.arrayContaining(["factory_pause", "factory_status"]));
  const before = { events: events(), project: project(), loop: loop() };
  for (const name of ["factory_resume", "factory_stop"]) {
    expect(listed).not.toContain(name);
    expect(await call(name, input(), "pm")).toEqual({
      isError: true,
      text: `Unknown tool: ${name}`,
    });
  }
  expect({ events: events(), project: project(), loop: loop() }).toEqual(before);
});

it("refuses direct PM calls to resume and stop", async () => {
  const ctx = { ...caller("pm"), services: services() };
  const error = new ToolError(
    "Only the orchestrator (or the user, in the factory view) can resume, stop or kill the factory loop. A project manager can pause its own project with factory_pause.",
  );
  for (const tool of [factoryResume, factoryStop]) {
    const rejection = tool.handler(input(), ctx);
    await expect(rejection).rejects.toThrow(error);
    await expect(rejection).rejects.toBeInstanceOf(ToolError);
  }
});

it("attributes PM pauses and orchestrator stops and records one resolved history item per action", async () => {
  const batches: ReturnType<typeof events>[] = [];
  env.store.subscribe((batch) => {
    batches.push(batch);
  });
  for (const [action, by, title] of [
    ["pause", "pm", "Paused by PM"],
    ["resume", "orchestrator", "Resumed by orchestrator"],
    ["stop", "orchestrator", "Stopped by orchestrator"],
    ["resume", "orchestrator", "Resumed by orchestrator"],
  ] as const) {
    expect(await result(`factory_${action}`, input(), by)).toMatchObject({ changed: true });
    const at = loop().lastControl?.at;
    expect(at).toBeDefined();
    const id = `inbox:factory-control:${env.project.id}:${action}:${at}`;
    const entry = { action, by, reason };
    const matching = events().filter((e) => {
      if (e.type !== "inbox.created") return false;
      const parsed = EventEnvelope.parse(e);
      return parsed.type === "inbox.created" && parsed.payload.item.id === id;
    });
    expect(matching).toHaveLength(1);
    expect(env.inbox.find(id)).toMatchObject({ status: "resolved", resolution: entry });
    expect(env.inbox.list({ projectId: env.project.id, status: "resolved" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
    expect(
      deriveNotices(matching, {
        session: (id) => env.repo.find(id)?.session,
        finalMessage: () => null,
      }),
    ).toEqual([]);
    expect(matching[0]).toMatchObject({
      sessionId,
      payload: {
        item: {
          id,
          kind: "automation_result",
          notify: "factory",
          status: "resolved",
          projectId: env.project.id,
          sessionId,
          resolvedAt: at,
          resolution: entry,
          title: `${title}: ${reason}`,
          body: expect.stringContaining(project().name),
        },
      },
    });
    expect(batches.find((batch) => batch.some((event) => event.seq === matching[0]?.seq))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "factory.loop.updated",
          payload: expect.objectContaining({
            loop: expect.objectContaining({
              lastControl: { ...entry, at, sessionId },
            }),
          }),
        }),
      ]),
    );
    expect(await result("factory_status", input(), by)).toMatchObject({
      control: { halt: action === "resume" ? null : { source: by, reason } },
    });
  }
});

it("reports and refuses to resume a built-in daily budget halt while it holds", async () => {
  await env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: { ...project().factoryLimits, dailyBudget: { usd: 5 } },
  });
  env.spend = { usd: 5, tokens: 0 };
  await env.factory.tick(env.project.id);
  const budgetReason = "daily budget reached ($5.00 of $5.00)";
  expect(loop()).toMatchObject({ state: "paused", pausedReason: budgetReason });
  const before = { events: events(), project: project(), loop: loop() };
  expect(await call("factory_resume", input())).toEqual({
    isError: true,
    text: `Not resumed: ${budgetReason}. That halt clears when its cause does.`,
  });
  expect({ events: events(), project: project(), loop: loop() }).toEqual(before);
  expect(await result("factory_status", input())).toMatchObject({
    control: { halt: { source: "builtin", reason: budgetReason } },
  });
  env.spend = { usd: 0, tokens: 0 };
  expect(await result("factory_resume", input())).toMatchObject({
    changed: true,
    control: { halt: null },
  });
});

async function holdTick() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const store = env.factory.data;
  const readOnce = store.readOnce.bind(store);
  vi.spyOn(store, "readOnce").mockImplementationOnce(async (id, run) => {
    entered.resolve();
    await release.promise;
    return readOnce(id, run);
  });
  const held = env.factory.tick(env.project.id);
  await entered.promise;
  return { held, release: release.resolve };
}

it("stops and records history while the project queue is held", async () => {
  const { held, release } = await holdTick();
  const halt = vi.spyOn(env.factory.ctx.sessions, "stopAll");
  const stopping = env.factory.setKillSwitch(env.project.id, true);
  try {
    expect(project().killSwitch).toBe(true);
    expect(loop().lastControl?.action).toBe("stop");
    expect(env.inbox.list({ projectId: env.project.id, status: "resolved" })).toHaveLength(1);
    expect(halt).toHaveBeenCalledWith(env.project.id);
  } finally {
    release();
    await Promise.all([held, stopping]);
  }
});

it("records stop after a completed pause", async () => {
  await result("factory_pause", input(), "pm");
  expect(loop()).toMatchObject({ drain: null, lastControl: { action: "pause" } });
  expect(await result("factory_stop", input())).toMatchObject({
    changed: true,
    control: { state: "stopped", lastControl: { action: "stop", by: "orchestrator" } },
  });
});

it("switches non-factory projects without recording project or global controls", async () => {
  env.updateProject({ autonomyMode: "assisted" });
  const second = { ...project(), id: "p-second", slug: "second" };
  env.store.append([{ type: "project.updated", sessionId: null, payload: { project: second } }]);
  await env.factory.setKillSwitch(second.id, true);
  expect(env.factory.ctx.projects.get(second.id).killSwitch).toBe(true);
  expect(env.factory.data.loop(second.id)).toBeUndefined();
  expect(env.inbox.list({ projectId: second.id, status: "resolved" })).toEqual([]);
  expect(env.factory.data.loop(env.project.id)).toBeDefined();
  await env.factory.setGlobalKillSwitch(true);
  expect(loop().lastControl).toBeNull();
  expect(env.inbox.list({ projectId: env.project.id, status: "resolved" })).toEqual([]);
});

it("resets failures and resolves the paused inbox item on a running UI resume", async () => {
  const paused = pauseLoop(env.factory.ctx, loop(), "3 failed merge checks or reverts in a row");
  env.factory.data.saveLoop({ ...paused, state: "idle", consecutiveFailures: 3 });
  await env.factory.resume(env.project.id);
  expect(loop()).toMatchObject({ state: "idle", consecutiveFailures: 0, lastControl: null });
  expect(env.inbox.find(`inbox:factory-paused:${env.project.id}`)).toMatchObject({
    status: "resolved",
  });
});

it("resolves an open drain notice when cancelling a drain", async () => {
  await result("factory_pause", input());
  const notice = env.inbox.get(drainInboxId(env.project.id));
  await env.factory.setKillSwitch(env.project.id, false);
  await startWork();
  await result("factory_pause", input());
  env.inbox.put(notice);
  expect(loop().drain).not.toBeNull();
  await env.factory.resume(env.project.id);
  expect(loop().drain).toBeNull();
  expect(env.inbox.get(notice.id).status).toBe("resolved");
});

it("keeps a budget halt through stop and killed ticks and refuses to resume while it holds", async () => {
  await env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: { ...project().factoryLimits, dailyBudget: { usd: 5 } },
  });
  env.spend = { usd: 5, tokens: 0 };
  await env.factory.tick(env.project.id);
  const budgetReason = loop().pausedReason;
  await result("factory_stop", input());
  await env.factory.tick(env.project.id);
  expect(loop()).toMatchObject({ state: "paused", pausedReason: budgetReason });
  expect((await call("factory_resume", input())).text).toContain(
    "Not resumed: daily budget reached",
  );
  expect(project().killSwitch).toBe(true);
  await env.factory.setKillSwitch(env.project.id, false);
  expect(loop()).toMatchObject({ state: "paused", pausedReason: budgetReason });
});

it("refuses a red CI regression and resumes a green one after a kill in one control batch", async () => {
  const pausedReason = `${regressionPausePrefix("main")}42; waiting for green CI`;
  env.factory.data.saveLoop({ ...loop(), state: "paused", pausedReason });
  env.gh.main.checks = "failure";
  await result("factory_stop", input());
  expect(await call("factory_resume", input())).toEqual({
    isError: true,
    text: `Not resumed: ${pausedReason}. That halt clears when its cause does.`,
  });
  env.gh.main.checks = "success";
  const batches: ReturnType<typeof events>[] = [];
  const unsubscribe = env.store.subscribe((batch) => batches.push(batch));
  try {
    expect(await result("factory_resume", input())).toMatchObject({
      changed: true,
      control: { state: "running", halt: null },
    });
  } finally {
    unsubscribe();
  }
  const batch = batches.find((batch) => batch.some((e) => e.type === "project.updated"));
  expect(batch?.map((e) => e.type)).toEqual([
    "project.updated",
    "inbox.created",
    "factory.loop.updated",
  ]);
  expect(loop()).toMatchObject({ state: "idle", pausedReason: null });
});

it("attributes unrecorded project switches and switches after a resume to built-in halts", async () => {
  env.updateProject({ killSwitch: true });
  expect((await env.factory.status(env.project.id)).halt).toEqual({
    source: "builtin",
    reason: "kill switch",
  });
  await env.factory.setKillSwitch(env.project.id, false);
  env.updateProject({ killSwitch: true });
  expect((await env.factory.status(env.project.id)).halt).toEqual({
    source: "builtin",
    reason: "kill switch",
  });
});

it("treats a tool pause during a global stop as a no-op", async () => {
  await env.factory.setGlobalKillSwitch(true);
  const before = events();
  expect(await result("factory_pause", input(), "pm")).toMatchObject({
    changed: false,
    control: { state: "stopped" },
  });
  expect(events()).toEqual(before);
  await expect(env.factory.setKillSwitch(env.project.id, true, { mode: "drain" })).rejects.toThrow(
    "The global kill switch is on",
  );
});

it("re-reads the project switch after waiting to resume", async () => {
  const { held, release } = await holdTick();
  const resuming = result("factory_resume", input());
  const stopping = env.factory.setKillSwitch(env.project.id, true);
  release();
  await Promise.all([held, stopping]);
  expect(await resuming).toMatchObject({ changed: true });
  expect(project().killSwitch).toBe(false);
});

const pmDigest = () =>
  renderProjectDigest({
    project: { id: env.project.id, name: "Shop", kind: "github", mode: "software_factory" },
    running: [],
    queued: [],
    scheduled: [],
    inbox: { open: 0, items: [] },
    recent: [],
    factory: env.factory.loopSummary(env.project.id),
  });
it("uses neutral PM digest wording", async () => {
  await result("factory_pause", input(), "pm");
  expect(pmDigest()).toContain("Factory: stopped (a kill switch is on) — Paused by PM");
  await result("factory_resume", input());
  await startWork();
  await result("factory_pause", input(), "pm");
  expect(pmDigest()).toContain("finishing the work in flight, then stopping; nothing new starts");
});

it("omits stale pause attribution from both digests", async () => {
  await startWork();
  await result("factory_pause", input(), "pm");
  env.updateProject({ autonomyMode: "assisted" });
  await env.factory.tick(env.project.id);
  env.updateProject({ autonomyMode: "software_factory" });
  expect(loop().lastControl?.action).toBe("pause");
  expect(pmDigest()).not.toContain("Paused by");
  expect((await env.factory.digestNow(env.project.id)).text).not.toContain("Paused by");
});

it("records all global stops before starting concurrent shutdowns", async () => {
  const second = { ...project(), id: "p-second", slug: "second" };
  env.store.append([{ type: "project.updated", sessionId: null, payload: { project: second } }]);
  const { held, release } = await holdTick();
  const shutdown = Promise.withResolvers<void>();
  const halted = vi.spyOn(env.factory.ctx.sessions, "stopAll").mockImplementation(async () => {
    await shutdown.promise;
    return [];
  });
  const stopping = env.factory.setGlobalKillSwitch(true);
  try {
    expect(loop().lastControl?.action).toBe("stop");
    expect(env.factory.data.loop(second.id)?.lastControl?.action).toBe("stop");
    expect(halted.mock.calls.map(([id]) => id)).toEqual(
      expect.arrayContaining([env.project.id, second.id]),
    );
  } finally {
    release();
    shutdown.resolve();
    await Promise.all([held, stopping]);
  }
});

it("commits a completed drain's switch, pause and history together", async () => {
  const batches: ReturnType<typeof events>[] = [];
  const unsubscribe = env.store.subscribe((batch) => batches.push(batch));
  try {
    await result("factory_pause", input());
  } finally {
    unsubscribe();
  }
  const batch = batches.find((batch) => batch.some((e) => e.type === "project.updated"));
  expect(batch?.map((e) => e.type)).toEqual([
    "project.updated",
    "inbox.created",
    "factory.loop.updated",
  ]);
  expect(loop()).toMatchObject({ drain: null, lastControl: { action: "pause" } });
});
