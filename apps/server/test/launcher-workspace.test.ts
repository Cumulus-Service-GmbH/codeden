import { join } from "node:path";
import type { RunnerCommandName, RunnerCommandOf } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpTokenStore } from "../src/mcp/tokens";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

let env: GithubEnv;
let calls: Array<RunnerCommandOf<RunnerCommandName>>;
let launcher: SessionLauncher;
/** When set, `workspace.prepare` fails with it (a worktree git can't make). */
let prepareError: Error | null;
let pushPreflight: "passed" | Error | undefined;
let logs: string[];

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  prepareError = null;
  pushPreflight = undefined;
  logs = [];
  const runner = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
      calls.push(command);
      if (command.name === "workspace.prepare") {
        if (prepareError) throw prepareError;
        return { cwd: command.path ?? env.dir, branch: command.branch ?? null, created: true };
      }
      if (command.name === "git.forkPushPreflight") {
        if (pushPreflight instanceof Error) throw pushPreflight;
        return { status: pushPreflight ?? "missing_fork" };
      }
      return { resumeToken: null };
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
  const projects = {
    get: (id: string) => (id === env.githubProject.id ? env.githubProject : env.localProject),
  } as unknown as ProjectService;
  launcher = new SessionLauncher({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    home: env.dir,
    worktreesDir: join(env.dir, "wt"),
    orchestratorDir: join(env.dir, "orchestrator"),
    tokens: { mint: () => "token" } as unknown as McpTokenStore,
    log: (message) => logs.push(message),
  });
});

afterEach(() => env.close());

const prepared = () => {
  const call = calls.find((c) => c.name === "workspace.prepare");
  if (call?.name !== "workspace.prepare") throw new Error("no workspace.prepare");
  return call;
};

describe("new worktrees of a GitHub project", () => {
  it("checks the session's fork before opening and reports the runner Git outcome", async () => {
    pushPreflight = "passed";
    const session = env.addSession({ status: "starting", worktreePath: null, branch: null });
    const input = { text: "Implement the change.", attachments: [] };
    await launcher.launch(session.id, { input, workspace: { mode: "worktree" } });

    const worktree = env.repo.get(session.id);
    const probe = calls.find((call) => call.name === "git.forkPushPreflight");
    expect(probe).toEqual({
      name: "git.forkPushPreflight",
      cwd: worktree.worktreePath,
      branch: worktree.branch,
    });
    const start = calls.find((call) => call.name === "session.start");
    if (!probe || !start) throw new Error("expected the fork probe and session start");
    expect(calls.indexOf(probe)).toBeLessThan(calls.indexOf(start));
    expect(start).toMatchObject({
      options: {
        systemPrompt: expect.stringContaining("Runner Git identity: fork push dry run passed"),
      },
    });
    expect(calls.find((call) => call.name === "session.send")).toMatchObject({ input });
  });

  it("reports an inconclusive push probe without opening a turn or surfacing runner errors", async () => {
    pushPreflight = new Error("private probe detail");
    const session = env.addSession({ status: "starting", worktreePath: null, branch: null });
    await launcher.launch(session.id, { workspace: { mode: "worktree" } });

    expect(env.repo.get(session.id).status).toBe("idle");
    expect(calls.some((call) => call.name === "session.send")).toBe(false);
    expect(logs.join("\n")).toContain("Runner Git identity: fork push dry run inconclusive");
    expect(logs.join("\n")).not.toContain("private probe detail");
  });

  it("fetch first, so they can start from the up-to-date default branch", async () => {
    const session = env.addSession({ status: "starting", worktreePath: null, branch: null });
    await launcher.launch(session.id, { workspace: { mode: "worktree" } });
    expect(prepared()).toMatchObject({ baseRef: "main", fetch: true });
    // The pull request still targets the default branch.
    expect(env.repo.get(session.id).baseBranch).toBe("main");
  });

  it("keep an explicit base ref and the caller's fetch choice", async () => {
    const session = env.addSession({ status: "starting", worktreePath: null, branch: null });
    await launcher.launch(session.id, { workspace: { mode: "worktree", baseRef: "release" } });
    expect(prepared()).toMatchObject({ baseRef: "release" });
    expect(prepared().fetch).toBeUndefined();
  });

  it("are made by the next start when the first couldn't make them, never skipped (#408)", async () => {
    const session = env.addSession({
      status: "starting",
      cwd: env.githubProject.path,
      worktreePath: null,
      branch: null,
    });
    const opened = () => calls.filter((c) => c.name === "session.start");
    const text = (t: string) => ({ text: t, attachments: [] });
    prepareError = Object.assign(new Error("fatal: invalid reference: release"), {
      code: "git_failed",
    });
    await launcher.launch(session.id, {
      input: text("first"),
      workspace: { mode: "worktree", baseRef: "release" },
    });
    expect(env.repo.get(session.id).status).toBe("failed");

    // Still can't be made: the next message is refused, not opened in the project folder.
    await expect(launcher.resume(env.repo.get(session.id), text("second"))).rejects.toThrow(
      "invalid reference",
    );
    expect(opened()).toHaveLength(0);

    // Now it can: the same worktree is made, then the session opens in it.
    prepareError = null;
    await launcher.resume(env.repo.get(session.id), text("third"));
    expect(calls.filter((c) => c.name === "workspace.prepare")).toHaveLength(3);
    expect(prepared()).toMatchObject({ strategy: "worktree", baseRef: "release" });
    const worktree = env.repo.get(session.id).worktreePath;
    expect(worktree).toBe(prepared().path);
    const [start] = opened();
    expect(start?.name === "session.start" && start.options.cwd).toBe(worktree);

    // Prepared once: later starts open it where it is.
    await launcher.resume(env.repo.get(session.id));
    expect(calls.filter((c) => c.name === "workspace.prepare")).toHaveLength(3);
    expect(opened()).toHaveLength(2);
  });

  it("are not fetched for local-only projects", async () => {
    const session = env.addSession({
      status: "starting",
      projectId: env.localProject.id,
      worktreePath: null,
      branch: null,
    });
    await launcher.launch(session.id, { workspace: { mode: "worktree" } });
    expect(prepared().fetch).toBeUndefined();
    expect(calls.some((call) => call.name === "git.forkPushPreflight")).toBe(false);
  });
});
