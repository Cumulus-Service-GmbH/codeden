import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { factoryLoops } from "../src/db/schema";
import { type ToolCaller, ToolRegistry } from "../src/mcp/registry";
import { factoryTools } from "../src/mcp/tools/factory";
import { renderProjectDigest } from "../src/services/orchestration/digest";
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

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 22, 23, 50));
  env = createFactoryEnv();
  await env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: env.project.factoryLimits,
  });
  tools = new ToolRegistry(factoryTools, {
    factory: env.factory,
    projects: env.factory.ctx.projects,
    sessionRepo: env.repo,
    settings: env.settings,
  } as never);
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
