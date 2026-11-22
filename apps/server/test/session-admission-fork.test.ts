import { join } from "node:path";
import {
  type ProviderInfo,
  type RunnerCommandName,
  type RunnerCommandOf,
  type Session,
  StartSessionRequest,
  type UserInput,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpTokenStore } from "../src/mcp/tokens";
import { FACTORY_STARTER } from "../src/services/factory/starter";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { SessionAdmission } from "../src/services/sessions/admission";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { SessionLifecycle } from "../src/services/sessions/lifecycle";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { SettingsStore } from "../src/settings-store";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

const capabilities = (fork: boolean): ProviderInfo["capabilities"] => ({
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: true,
  rollback: false,
  fork,
  images: true,
  planMode: false,
  reasoningEffort: true,
  mcp: true,
  skills: true,
});

const PROVIDERS: ProviderInfo[] = [
  { id: "claude", displayName: "Claude Code", capabilities: capabilities(true), models: [] },
  { id: "plain", displayName: "Plain", capabilities: capabilities(false), models: [] },
];

type Command = RunnerCommandOf<RunnerCommandName>;

const SOURCE_RESUME = ["claude", "source"].join("-");
const FORK_RESUME = [SOURCE_RESUME, "fork"].join(":");
const MCP_FIXTURE = ["mcp", "fixture"].join("-");

let env: GithubEnv;
let calls: Command[];
let checkpoints: Record<string, number[]>;

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  checkpoints = {};
});

afterEach(() => env.close());

const runner = {
  isConnected: () => true,
  runnerId: () => "r1",
  providers: () => PROVIDERS,
  mcpProxyUrl: () => null,
  waitForConnection: async () => true,
  request: (async (command: Command) => {
    calls.push(command);
    switch (command.name) {
      case "checkpoint.list":
        return {
          checkpoints: (checkpoints[command.sessionId] ?? []).map((index) => ({
            index,
            ref: `refs/codeden/checkpoints/${command.sessionId}/${index}`,
            commit: `c${index}`,
            createdAt: "2026-11-12T10:00:00.000Z",
          })),
        };
      case "provider.fork":
        return { resumeToken: [command.resumeToken, "fork"].join(":") };
      case "workspace.prepare":
        return { cwd: command.path ?? env.dir, branch: command.branch ?? null, created: true };
      case "session.start":
        return { resumeToken: command.options.resumeToken ?? null };
      default:
        return {};
    }
  }) as RunnerPort["request"],
} as unknown as RunnerPort;

function createSessions(admission: SessionAdmission, settings: SettingsStore) {
  const projects = {
    get: (id: string) => (id === env.githubProject.id ? env.githubProject : env.localProject),
  } as unknown as ProjectService;
  const launcher = new SessionLauncher({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    home: env.dir,
    worktreesDir: join(env.dir, "wt"),
    orchestratorDir: join(env.dir, "orchestrator"),
    tokens: { mint: () => MCP_FIXTURE } as unknown as McpTokenStore,
  });
  return new SessionService({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    launcher,
    outbox: new Outbox(env.db.db, env.store),
    admission,
    settings,
    artifacts: {
      externalizeAttachments: (i: UserInput) => i,
      resolveAttachments: (i: UserInput) => i,
    },
  } as unknown as SessionServiceDeps);
}

/** An idle Claude session with a conversation, on its own branch. */
function source(): Session {
  return env.addSession({
    provider: "claude",
    model: "opus",
    effort: "high",
    autonomy: "supervised",
    title: "Add login",
    purpose: "Add login",
    workKey: "issue:7",
    issue: { number: 7, title: "Add login", url: "https://github.com/acme/widgets/issues/7" },
    resumeToken: SOURCE_RESUME,
    branch: "codeden/add-login-s1ab",
    baseBranch: "main",
  });
}

const call = <N extends RunnerCommandName>(name: N): RunnerCommandOf<N> => {
  const found = calls.find((command): command is RunnerCommandOf<N> => command.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};

async function settle(sessions: SessionService): Promise<void> {
  await Promise.all(sessions.launching.values());
}

describe("global session admission", () => {
  it("starts and sends in FIFO order, preserving fork plans and factory starts", async ({
    onTestFinished,
  }) => {
    const settings = new SettingsStore(join(env.dir, "settings.json"));
    const defaultLimits = settings.get().limits;
    settings.update({ limits: { maxActiveSessions: 1 } });
    const admission = new SessionAdmission(
      env.repo,
      () => settings.get().limits.maxActiveSessions,
      () => 2,
      () => lifecycle.scheduleDrain(),
    );
    const sessions = createSessions(admission, settings);
    const lifecycle = new SessionLifecycle({
      db: env.db.db,
      repo: env.repo,
      store: env.store,
      sessions,
      admission,
      settings,
      tokens: {} as McpTokenStore,
      utility: {} as never,
    });
    onTestFinished(() => lifecycle.stop());
    lifecycle.start();
    const target = source();
    checkpoints[target.id] = [1];
    const start = (workKey: string, factory = false) =>
      sessions.start(
        StartSessionRequest.parse({
          projectId: env.githubProject.id,
          role: "agent",
          provider: "claude",
          startedBy: factory ? FACTORY_STARTER : { kind: "user" },
          workKey: `task:${workKey}`,
          input: { text: workKey, attachments: [] },
          workspace: { mode: "repo_root" },
        }),
      );
    const first = await start("first");
    expect(first.status).toBe("started");
    await settle(sessions);

    const second = await start("second");
    expect(second).toMatchObject({ status: "queued", behind: [] });
    const input = { text: "queued turn", attachments: [] };
    await expect(sessions.send(target.id, { input, whenBusy: "reject" })).rejects.toMatchObject({
      code: "turn_running",
    });
    expect(sessions.hasOutbox(target.id)).toBe(false);
    expect(await sessions.send(target.id, { input, whenBusy: "queue" })).toEqual({
      status: "queued",
    });
    const fork = await sessions.fork(target.id, {});
    expect(env.repo.get(fork.sessionId).status).toBe("queued");
    const factory = await start("factory", true);
    expect(factory.status).toBe("started");
    await settle(sessions);

    const idOf = (result: Awaited<ReturnType<typeof start>>) => {
      if (!("sessionId" in result)) throw new Error("missing session");
      return result.sessionId;
    };
    const idle = (id: string) => env.repo.update(id, (s) => ({ ...s, status: "idle" }));
    const drain = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await settle(sessions);
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    idle(idOf(factory));
    idle(idOf(first));
    await drain();
    expect(env.repo.get(idOf(second)).status).toBe("running");
    expect(sessions.hasOutbox(target.id)).toBe(true);
    idle(idOf(second));
    await drain();
    expect(sessions.hasOutbox(target.id)).toBe(false);
    expect(call("session.send")).toMatchObject({ sessionId: target.id, input });
    expect(env.repo.get(fork.sessionId).status).toBe("queued");
    idle(target.id);
    await drain();
    expect(env.repo.get(fork.sessionId)).toMatchObject({
      status: "idle",
      resumeToken: FORK_RESUME,
    });

    settings.update({ limits: defaultLimits });
    for (const key of ["a", "b", "c"]) expect((await start(key)).status).toBe("started");
    await settle(sessions);
  });
});
