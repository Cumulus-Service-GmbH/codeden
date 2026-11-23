import { join } from "node:path";
import {
  agentEventToNewEvent,
  defaultSettings,
  type ProviderInfo,
  type RunnerCommandName,
  type RunnerCommandOf,
  type StartSessionRequest,
  type UserInput,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpTokenStore } from "../src/mcp/tokens";
import { updateProject } from "../src/mcp/tools/orchestrator/projects";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

const capabilities = (
  patch: Partial<ProviderInfo["capabilities"]> = {},
): ProviderInfo["capabilities"] => ({
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: false,
  rollback: false,
  fork: true,
  images: true,
  planMode: true,
  reasoningEffort: true,
  mcp: true,
  skills: true,
  ...patch,
});

/** A provider the machine's security rules don't cover, and that can't enforce Supervised. */
const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    capabilities: capabilities({ enforcesSecurityRules: true }),
    models: [],
  },
  {
    id: "loose",
    displayName: "Loose CLI",
    capabilities: capabilities({
      readOnly: false,
      supervised: false,
      enforcesSecurityRules: false,
    }),
    models: [],
  },
  // Covered only in a CodeDen worktree (as the guard covers Claude Code).
  {
    id: "guarded",
    displayName: "Guarded CLI",
    capabilities: capabilities({
      readOnly: true,
      enforcesSecurityRules: true,
      securityRulesWorktreesOnly: true,
    }),
    models: [],
  },
  // Declares nothing about the security rules: absent counts as not enforced.
  {
    id: "silent",
    displayName: "Silent CLI",
    capabilities: capabilities({ readOnly: true }),
    models: [],
  },
];
const starts: Command[] = [];

type Command = RunnerCommandOf<RunnerCommandName>;
let env: GithubEnv;
let allowed: boolean;

beforeEach(() => {
  env = createGithubEnv();
  allowed = false;
  starts.length = 0;
});
afterEach(() => env.close());

const runner = {
  isConnected: () => true,
  runnerId: () => "r1",
  providers: () => PROVIDERS,
  mcpProxyUrl: () => null,
  waitForConnection: async () => true,
  request: (async (command: Command) => {
    if (command.name === "workspace.prepare") {
      return { cwd: command.path ?? env.dir, branch: command.branch ?? null, created: true };
    }
    if (command.name === "session.start") {
      starts.push(command);
      return { resumeToken: `${command.providerId}-new` };
    }
    if (command.name === "checkpoint.list") return { checkpoints: [] };
    return {};
  }) as RunnerPort["request"],
} as unknown as RunnerPort;

function services() {
  const project = () => ({ ...env.localProject, allowUnenforcedProviders: allowed });
  const projects = { get: () => project() } as unknown as ProjectService;
  const launcher = new SessionLauncher({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    home: env.dir,
    worktreesDir: join(env.dir, "wt"),
    orchestratorDir: join(env.dir, "orchestrator"),
    tokens: { mint: () => "token" } as unknown as McpTokenStore,
  });
  return new SessionService({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    launcher,
    settings: { get: () => defaultSettings() },
    tokens: { revokeSession: () => {} },
    outbox: new Outbox(env.db.db, env.store),
    artifacts: {
      externalizeAttachments: (i: UserInput) => i,
      resolveAttachments: (i: UserInput) => i,
    },
  } as unknown as SessionServiceDeps);
}

const request = (patch: Partial<StartSessionRequest> = {}): StartSessionRequest => ({
  projectId: env.localProject.id,
  role: "agent",
  provider: "loose",
  autonomy: "auto",
  startedBy: { kind: "user" },
  workspace: { mode: "repo_root" },
  ...patch,
});

async function code(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return null;
}

describe("a provider the machine's security rules don't cover", () => {
  it("is refused at start in a project that hasn't allowed it, for every role", async () => {
    const sessions = services();
    expect(await code(() => sessions.start(request()))).toBe("security_rules_unenforced");
    expect(await code(() => sessions.start(request({ provider: "silent", role: "pm" })))).toBe(
      "security_rules_unenforced",
    );
  });

  it("counts a provider that declares nothing about the rules as not covered (fail closed)", async () => {
    expect(await code(() => services().start(request({ provider: "silent" })))).toBe(
      "security_rules_unenforced",
    );
  });

  it("starts only once the project allows such providers, and the runner is told so", async () => {
    allowed = true;
    const sessions = services();
    const started = await sessions.start(request());
    expect(started.status).toBe("started");
    await Promise.all(sessions.launching.values());
    const start = starts.find((c) => c.name === "session.start") as
      | RunnerCommandOf<"session.start">
      | undefined;
    expect(start?.options.allowUnenforcedProviders).toBe(true);
  });

  it("never lets the orchestrator take a project's exception", async () => {
    allowed = true;
    expect(
      await code(() =>
        services().start(
          request({ provider: "silent", role: "orchestrator", workspace: { mode: "repo_root" } }),
        ),
      ),
    ).toBe("security_rules_unenforced");
  });

  it("can't run a PM when it can't enforce read-only, even where it is allowed", async () => {
    allowed = true;
    expect(await code(() => services().start(request({ role: "pm" })))).toBe(
      "read_only_unsupported",
    );
  });

  it("is refused as a handoff target in a project that hasn't allowed it", async () => {
    const added = env.addSession({
      provider: "claude",
      autonomy: "auto",
      branch: "codeden/x",
      baseBranch: "main",
      rootThreadId: "t-root",
    });
    // One finished turn, so there is something to hand off.
    env.store.append([
      agentEventToNewEvent(added.id, { type: "thread.started", thread: { id: "t-root" } }),
      agentEventToNewEvent(added.id, { type: "turn.started", threadId: "t-root", turnId: "u1" }),
      agentEventToNewEvent(added.id, {
        type: "item.completed",
        threadId: "t-root",
        turnId: "u1",
        item: { id: "r1", status: "completed", kind: "assistant_message", text: "Done." },
      }),
      agentEventToNewEvent(added.id, { type: "turn.completed", threadId: "t-root", turnId: "u1" }),
    ]);
    const src = env.repo.update(added.id, (s) => ({ ...s, status: "idle" }));
    const sessions = services();
    expect(await code(() => sessions.handoff(src.id, { provider: "loose" }))).toBe(
      "security_rules_unenforced",
    );
  });
});

describe("a provider that can't enforce Supervised", () => {
  it("can't start a session in Supervised, or switch one into it", async () => {
    allowed = true;
    const sessions = services();
    expect(await code(() => sessions.start(request({ autonomy: "supervised" })))).toBe(
      "supervised_unsupported",
    );
    const started = await sessions.start(request());
    if (started.status !== "started") throw new Error(started.status);
    expect(await code(() => sessions.update(started.sessionId, { autonomy: "supervised" }))).toBe(
      "supervised_unsupported",
    );
  });
});

describe("who can allow providers without enforced security rules", () => {
  it("only the user's own project settings: the orchestrator's update_project can't set it", () => {
    const parsed = updateProject.input.parse({
      projectId: "11111111-1111-4111-8111-111111111111",
      allowUnenforcedProviders: true,
    });
    expect(parsed).not.toHaveProperty("allowUnenforcedProviders");
  });
});

describe("a provider whose security rules cover worktrees only", () => {
  it("is enforced for an agent session in a worktree", async () => {
    const started = await services().start(
      request({ provider: "guarded", workspace: { mode: "worktree" } }),
    );
    expect(started.status).toBe("started");
  });

  it("refuses an agent session in the project folder without the project's opt-in", async () => {
    expect(await code(() => services().start(request({ provider: "guarded" })))).toBe(
      "security_rules_unenforced",
    );
    allowed = true;
    expect((await services().start(request({ provider: "guarded" }))).status).toBe("started");
  });

  it("allows a read-only PM in the project folder, held by CodeDen's read-only policy", async () => {
    const started = await services().start(request({ provider: "guarded", role: "pm" }));
    expect(started.status).toBe("started");
  });
});
