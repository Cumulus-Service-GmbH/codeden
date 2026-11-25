import { createHash } from "node:crypto";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  agentEventToNewEvent,
  type ItemOf,
  McpTokenClaims,
  type Session,
} from "@codeden/contracts";
import { ApprovalBroker } from "@codeden/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleServerRequest } from "../../../packages/providers/src/codex/approvals";
import type { ToolCaller } from "../src/mcp/registry";
import { ensureHome } from "../src/paths";
import { inboxRoutes } from "../src/routes/inbox";
import { sessionRoutes } from "../src/routes/sessions";
import { createServices } from "../src/services/container";
import { classifyApproval } from "../src/services/orchestrator-approvals";
import type { RunnerPort } from "../src/services/runner-port";
import { SettingsStore } from "../src/settings-store";
import { createGithubEnv } from "./support/github-env";

const prefix = "[codeden-card v1 scope=db-read class=delegable]";
const secret = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
const pmStep = { action: "get_project_status", args: {} };
const caller = (role: ToolCaller["role"]): ToolCaller => ({
  role,
  sessionId: `session-${role}`,
  projectId: null,
  signal: new AbortController().signal,
  caller: "mcp",
});
const actor = caller("orchestrator");
const decision = { decision: "approve", reason: "Reviewed." } as const;
const ordinary = { kind: "tool_approval", action: "plan" } as const;
type Entry = Parameters<typeof classifyApproval>[0];

it.each([
  "cat package.json",
  "ls -la",
  'rg -n "requires the owner" apps/server/src/services/orchestrator-approvals.ts',
  "git show HEAD:package.json",
])("delegates a plain read-only command: %s", (command) => {
  expect(classifyApproval({ ...ordinary, action: "command", command, toolName: "Bash" })).toEqual({
    delegable: true,
  });
});

it.each([
  "cat package.json > out",
  "cat package.json | sh",
  "cat .env",
  "cat 'prod.env'",
  "cat 'a/env'",
  "cat 'vault.kdbx'",
  'cat "cert.pem"',
  "cat ../package.json",
  "rg --pre sh source",
  "rg -n fixture",
  "git show --output=out HEAD",
  "git show HEAD:env",
  "git show HEAD:env/prod",
  "git show HEAD:key",
  "git merge HEAD",
  "git status --short --branch",
  "pnpm --version",
  "node --version",
  "node -e 'process.exit()'",
])("keeps a command per-card: %s", (command) => {
  expect(
    classifyApproval({ ...ordinary, action: "command", command, toolName: "Bash" }).delegable,
  ).toBe(false);
});

it("audits the exact input digest when a plain shell approval is delegated", async () => {
  const { service, add, store, runnerCalls } = setup();
  const command = "ls -la";
  const toolInput = { command };
  const target = add(
    "plain-shell",
    { action: "command", toolName: "Bash", command, toolInput },
    { provider: "claude" },
  );
  const result = await service.decide(actor, { id: target.id, ...decision });
  expect(runnerCalls).toContainEqual(
    expect.objectContaining({
      name: "session.respond",
      sessionId: target.sessionId,
      response: expect.objectContaining({ decision: "allow_once", decidedBy: "orchestrator" }),
    }),
  );
  expect(store.listTypes(["approval.decided_by_orchestrator"])).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        sessionId: target.sessionId,
        orchestratorSessionId: actor.sessionId,
        at: result.decidedAt,
        toolName: "Bash",
        inputDigest: createHash("sha256").update(JSON.stringify(toolInput)).digest("hex"),
      }),
    }),
  );
});

it.each([
  ["claude", "Bash", "sed -n '1,20p' README.md"],
  ["codex", "shell", "nl -ba README.md"],
  ["codex", "shell", "rg --no-config -n match README.md"],
] as const)(
  "delegates %s read %s %s through decide_approval",
  async (provider, toolName, command) => {
    const { service, add, runnerCalls, worktree } = setup();
    writeFileSync(join(worktree, "README.md"), "fixture");
    const { id } = add(
      "verified-read",
      {
        action: "command",
        command,
        toolName,
        toolInput: { command },
      },
      { provider },
    );
    expect(service.list().approvals[0]).toMatchObject({ id, delegable: true });
    await expect(service.decide(actor, { ...decision, id })).resolves.toMatchObject({ id });
    expect(runnerCalls).toHaveLength(1);
  },
);

it.each([
  ["/bin/sh -c 'cat README.md'", true],
  ["/bin/sh -c 'cat README.md > out'", false],
] as const)("lists a Codex 0.172 approval for %s", async (command, delegable) => {
  const { services, add, worktree } = setup();
  writeFileSync(join(worktree, "README.md"), "fixture");
  const events: AgentEvent[] = [];
  const broker = new ApprovalBroker((event) => events.push(event));
  const pending = handleServerRequest(
    {
      method: "item/commandExecution/requestApproval",
      id: 1,
      params: {
        kind: "command",
        threadId: "thread",
        turnId: "turn",
        itemId: "exec",
        startedAtMs: 1,
        environmentId: "local",
        command,
        cwd: worktree,
        commandActions: [
          {
            type: "read",
            command: "cat README.md",
            name: "README.md",
            path: join(worktree, "README.md"),
          },
        ],
      },
    },
    {
      broker,
      risk: { cwd: worktree },
      ctx: () => ({ threadId: "thread", turnId: "turn" }),
      filePaths: () => [],
    },
  );
  try {
    const started = events[0];
    if (started?.type !== "item.started" || started.item.kind !== "approval_request") {
      throw new Error("Expected an approval request");
    }
    const { id } = add("codex-local", started.item, { provider: "codex" });
    const result = await services.tools.call("list_pending_approvals", {}, actor);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).approvals).toEqual([
      expect.objectContaining({
        id,
        delegable,
        ...(delegable ? {} : { ownerOnly: "unclassified" }),
      }),
    ]);
  } finally {
    broker.cancelAll();
    await pending;
  }
});

it.each(["legacy", "shared", "remote", "private-cwd", "hook"] as const)(
  "keeps %s shell reads owner-only",
  async (mode) => {
    const { service, add, runnerCalls, worktree } = setup(undefined, mode === "remote");
    const command = "ls -la";
    const privateDir = join(worktree, ".codeden");
    mkdirSync(privateDir);
    const { id } = add(
      "unverified-read",
      {
        action: "command",
        command,
        toolName: "shell",
        ...(mode === "legacy" ? {} : { toolInput: { command } }),
        ...(mode === "private-cwd" ? { cwd: privateDir } : {}),
        ...(mode === "hook" ? { hookAsk: true } : {}),
      },
      { provider: "codex", ...(mode === "shared" ? { worktreePath: null } : {}) },
    );
    expect(service.list().approvals[0]).toMatchObject({
      id,
      delegable: false,
      ownerOnly: "unclassified",
    });
    await expect(service.decide(actor, { ...decision, id })).rejects.toMatchObject({
      code: "owner_only_approval",
    });
    expect(runnerCalls).toEqual([]);
  },
);

it("requires the owner for a plain read through a symlink outside the worktree", async () => {
  const { service, add, runnerCalls } = setup();
  const command = "cat linked.txt";
  const target = add(
    "linked-shell",
    { action: "command", toolName: "Bash", command, toolInput: { command } },
    { provider: "claude" },
  );
  const cwd = target.item.cwd as string;
  const outside = join(cwd, "..", "outside.txt");
  writeFileSync(outside, "fixture");
  symlinkSync(outside, join(cwd, "linked.txt"));
  await expect(service.decide(actor, { id: target.id, ...decision })).rejects.toMatchObject({
    code: "owner_only_approval",
  });
  expect(runnerCalls).toEqual([]);
});

it("requires the owner for a recursive rg read that can reach a hardlink outside the worktree", async () => {
  const { service, add, runnerCalls } = setup();
  const command = "rg -n fixture .";
  const target = add(
    "linked-search",
    { action: "command", toolName: "Bash", command, toolInput: { command } },
    { provider: "claude" },
  );
  const cwd = target.item.cwd as string;
  const outside = join(cwd, "..", "outside.txt");
  writeFileSync(outside, "fixture");
  linkSync(outside, join(cwd, "linked.txt"));
  await expect(service.decide(actor, { id: target.id, ...decision })).rejects.toMatchObject({
    code: "owner_only_approval",
  });
  expect(runnerCalls).toEqual([]);
});

it.each([
  ["prd_write", "az containerapp update"],
  ["secrets", "PASSWORD"],
  ["prd_db", "DbOps migrate"],
  ["store_submission", "EAS submit"],
  ["new_azure_resource", "az group create"],
  ["spending", "STRIPE checkout"],
])("classifyApproval refuses %s command and tool input text", (ownerOnly, command) => {
  for (const context of [{ command }, { toolInput: { nested: [command] } }]) {
    expect(classifyApproval({ ...ordinary, ...context })).toEqual({ delegable: false, ownerOnly });
  }
});

it.each([
  ["db-read", "prd_db"],
  ["db-migration", "prd_db"],
  ["prd-db-migration", "prd_db"],
  ["dbops-lan", "prd_db"],
  ["dbops-migration-image", "prd_db"],
  ["az-ssh-arc", "prd_db"],
  ["az-connectedmachine-run-command-create", "prd_db"],
  ["az-connectedmachine-run-command-delete", "prd_db"],
  ["resource:group", "new_azure_resource"],
  ["prd-env-update", "prd_write"],
  ["webchat-deploy", "prd_write"],
  ["deploy", "prd_write"],
  ["container-app-update", "prd_write"],
  ["unknown", "unclassified"],
])("classifyApproval maps %s guard cards to %s regardless of token class", (scope, ownerOnly) => {
  for (const cls of ["owner-only", "delegable"]) {
    const hookReason = `[codeden-card v1 scope=${scope} class=${cls}]`;
    expect(classifyApproval({ ...ordinary, hookReason })).toEqual({ delegable: false, ownerOnly });
  }
});

const refused: Entry[] = [
  ...(["network", "tool", "other", "git_destructive"] as const).map((action) => ({
    ...ordinary,
    action,
  })),
  { ...ordinary, url: "https://example.invalid" },
  { ...ordinary, toolName: "mcp__claude-in-chrome__navigate" },
  { ...ordinary, reason: "Claude in Chrome uses your browser" },
  { ...ordinary, singleUse: true },
  { ...ordinary, hookAsk: true },
  { ...ordinary, action: "outside_worktree", command: "echo password" },
  { kind: "question" },
  { kind: "checklist_approval" },
  { kind: "spec_approval" },
  { kind: "github_card" },
  { kind: "plan_card", requestedBy: "orchestrator", steps: [pmStep] },
  { kind: "plan_card", requestedBy: "pm", steps: [{ action: "production", args: {} }] },
  { ...ordinary, command: prefix },
  { ...ordinary, reason: prefix },
  { ...ordinary, reason: "A hook asked for approval" },
  { ...ordinary, hookReason: `comment ${prefix}` },
  { ...ordinary, hookReason: `${prefix} ${prefix}` },
  { ...ordinary, hookReason: "" },
  {
    kind: "plan_card",
    requestedBy: "pm",
    steps: [pmStep],
    hookReason: "A hook asked for approval",
  },
];
it.each(refused)("classifyApproval refuses %j", (entry) => {
  expect(classifyApproval(entry)).toEqual({ delegable: false, ownerOnly: "unclassified" });
});
it("classifyApproval handles sensitive actions and delegable approvals", () => {
  expect(classifyApproval({ ...ordinary, action: "secrets" })).toEqual({
    delegable: false,
    ownerOnly: "secrets",
  });
  expect(classifyApproval(ordinary)).toEqual({ delegable: true });
  expect(classifyApproval({ kind: "plan_card", requestedBy: "pm", steps: [pmStep] })).toEqual({
    delegable: true,
  });
});

it.each([
  [{ command: "password" }, "secrets"],
  [{ hookReason: prefix }, "prd_db"],
] as const)("classifyApproval reports a file change with %j as %s", (context, ownerOnly) => {
  expect(classifyApproval({ ...ordinary, action: "file_change", ...context })).toEqual({
    delegable: false,
    ownerOnly,
  });
});

const planInputs: Record<string, string>[] = [{}, { plan: "Update the README" }];
it.each(planInputs)("delegates a plan with empty paths and plan input %j", (toolInput) => {
  expect(classifyApproval({ ...ordinary, paths: [], toolInput })).toEqual({ delegable: true });
});

it("scans a plan's listed paths for sensitive text", () => {
  expect(classifyApproval({ ...ordinary, paths: ["src/password.txt"] })).toEqual({
    delegable: false,
    ownerOnly: "secrets",
  });
});

let env: ReturnType<typeof createGithubEnv> | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

function setup(onRespond?: () => void, remote = false) {
  const fixture = createGithubEnv();
  env = fixture;
  const worktree = join(fixture.dir, ".worktree");
  mkdirSync(worktree);
  const paths = ensureHome(join(fixture.dir, "home"));
  const runner: RunnerPort = {
    isConnected: () => true,
    runnerId: () => "r1",
    ...(remote
      ? {
          remote: () => {
            throw new Error("Remote runner fixture");
          },
        }
      : {}),
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: Parameters<RunnerPort["request"]>[0]) => {
      fixture.runnerCalls.push(command);
      if (command.name === "session.respond") onRespond?.();
      return {};
    }) as RunnerPort["request"],
  };
  const services = createServices({
    db: fixture.db.db,
    store: fixture.store,
    paths,
    settings: new SettingsStore(paths.settings),
    runner,
    secrets: fixture.secrets,
    userHome: fixture.dir,
  });
  const add = (
    id: string,
    patch: Partial<ItemOf<"approval_request">> = {},
    session: Partial<Session> = {},
  ) => {
    const sessionId = `session-${id}`;
    const projectId = session.projectId ?? fixture.localProject.id;
    fixture.addSession({
      id: sessionId,
      projectId,
      scope: { projectId },
      worktreePath: worktree,
      ...session,
    });
    const emit = (event: AgentEvent) => agentEventToNewEvent(sessionId, event);
    const item: ItemOf<"approval_request"> = {
      kind: "approval_request",
      id: `item-${id}`,
      requestId: `request-${id}`,
      title: `Review ${id}`,
      action: "plan",
      cwd: worktree,
      status: "in_progress",
      options: ["allow_once", "deny"],
      ...patch,
    };
    fixture.store.append([
      emit({ type: "thread.started", thread: { id: "thread" } }),
      emit({ type: "turn.started", threadId: "thread", turnId: "turn" }),
      emit({ type: "item.started", threadId: "thread", turnId: "turn", item }),
    ]);
    return { id: `inbox:${sessionId}:${item.id}`, sessionId, item };
  };
  return { ...fixture, services, service: services.orchestratorApprovals, worktree, add };
}

describe.each<[string, Partial<ItemOf<"approval_request">>]>([
  ["a plan with a command", { command: "echo hello" }],
  ["a plan with an empty command", { command: "" }],
  ["a plan with paths", { paths: ["README.md"] }],
  ["a plan with file_path input", { toolInput: { file_path: "README.md" } }],
  ["a plan with content input", { toolInput: { content: "Hello" } }],
  ["a plan with patch input", { toolInput: { patch: "Update the README" } }],
  ["a plan with command input", { toolInput: { command: "echo hello" } }],
  ["a plan with allowedPrompts input", { toolInput: { allowedPrompts: [] } }],
  ["a plan with an unknown input key", { toolInput: { plan: "Update the README", extra: true } }],
  ["a plan with null input", { toolInput: null }],
  ["a plan with array input", { toolInput: [] }],
  ["a plan with string input", { toolInput: "Update the README" }],
  ["a clean command action", { action: "command", command: "echo hello" }],
])("%s", (_scenario, patch) => {
  it.each(["approve", "deny"] as const)(
    "decide_approval refuses %s without side effects",
    async (choice) => {
      const { add, service, services, store, runnerCalls } = setup();
      const { id } = add("owner-only", patch);
      const head = store.headSeq();
      expect(
        await services.tools.call("decide_approval", { ...decision, id, decision: choice }, actor),
      ).toEqual({ isError: true, text: "This approval requires the owner (unclassified)" });
      expect(service.list().approvals[0]).toMatchObject({
        id,
        delegable: false,
        ownerOnly: "unclassified",
      });
      expect(runnerCalls).toEqual([]);
      expect(store.headSeq()).toBe(head);
    },
  );
});

describe.each([
  "a clean in-worktree file",
  "a symlink",
  "a hardlink",
  "opencode.jsonc",
  "no cwd",
  "patch-text targets",
] as const)("file change with %s", (scenario) => {
  it.each(["approve", "deny"] as const)(
    "decide_approval refuses %s without side effects",
    async (choice) => {
      const { dir, worktree, services, service, add, runnerCalls, store } = setup();
      const outside = join(dir, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "file.ts"), "");
      writeFileSync(join(worktree, "app.ts"), "");
      symlinkSync(outside, join(worktree, "linked"), "junction");
      linkSync(join(outside, "file.ts"), join(worktree, "shared.ts"));
      const patch: Partial<ItemOf<"approval_request">> = {
        "a clean in-worktree file": {},
        "a symlink": { paths: ["linked/file.ts"] },
        "a hardlink": { paths: ["shared.ts"] },
        "opencode.jsonc": { paths: ["opencode.jsonc"] },
        "no cwd": { cwd: undefined },
        "patch-text targets": {
          toolInput: {
            patch: "*** Begin Patch\n*** Add File: notes.txt\n+Notes\n*** End Patch",
          },
        },
      }[scenario];
      const { id } = add("edit", { action: "file_change", paths: ["app.ts"], ...patch });
      const head = store.headSeq();
      expect(
        await services.tools.call("decide_approval", { ...decision, id, decision: choice }, actor),
      ).toEqual({ isError: true, text: "This approval requires the owner (unclassified)" });
      expect(service.list().approvals[0]).toMatchObject({
        id,
        delegable: false,
        ownerOnly: "unclassified",
      });
      expect(runnerCalls).toEqual([]);
      expect(store.headSeq()).toBe(head);
    },
  );
});

it("lists two projects with transcript context and redacts nested secrets", () => {
  const { service, add, localProject, githubProject } = setup();
  const local = add("local", {
    action: "file_change",
    command: `echo ${secret}`,
    reason: `Review ${secret}`,
    hookReason: `${prefix} Review ${secret}`,
    cwd: "/work",
    toolName: "Bash",
    toolInput: { command: `echo ${secret}`, nested: [secret] },
  });
  const remote = add("remote", {}, { projectId: githubProject.id });
  const output = service.list();
  expect(output.approvals).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: local.id,
        projectId: localProject.id,
        sessionId: local.sessionId,
        action: "file_change",
        cwd: "/work",
        toolName: "Bash",
        reason: expect.stringContaining("Review "),
        command: expect.stringContaining("echo "),
        toolInput: { command: expect.stringContaining("echo "), nested: [expect.any(String)] },
      }),
      expect.objectContaining({ id: remote.id, projectId: githubProject.id, delegable: true }),
    ]),
  );
  expect(JSON.stringify(output)).not.toContain(secret);
});

it.each([
  ["approve", "allow_once", "approved"],
  ["deny", "deny", "denied"],
] as const)(
  "%s delegates a plan without a cwd or worktree and records one audit batch",
  async (choice, responseDecision, past) => {
    const { service, add, services, store, runnerCalls } = setup();
    const target = add("safe", { cwd: undefined }, { worktreePath: null });
    const reason = `Reviewed ${secret}`;
    const batches: string[][] = [];
    store.subscribe((events) => batches.push(events.map(({ type }) => type)));
    const result = await service.decide(actor, { id: target.id, decision: choice, reason });
    expect(runnerCalls).toContainEqual({
      name: "session.respond",
      sessionId: target.sessionId,
      requestId: target.item.requestId,
      response: {
        kind: "approval",
        decision: responseDecision,
        message: expect.any(String),
        decidedBy: "orchestrator",
      },
    });
    const [audit] = store.listTypes(["approval.decided_by_orchestrator"]);
    const clean = expect.stringMatching(/^Reviewed /);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(audit).toMatchObject({
      payload: {
        id: target.id,
        sessionId: target.sessionId,
        kind: "tool_approval",
        orchestratorSessionId: actor.sessionId,
        decision: choice,
        reason: clean,
        at: result.decidedAt,
      },
    });
    expect(batches).toContainEqual([
      "approval.decided_by_orchestrator",
      "inbox.created",
      "inbox.updated",
    ]);
    expect(services.inbox.find(target.id)).toMatchObject({
      status: "resolved",
      resolution: { decision: responseDecision, decidedBy: "orchestrator", reason: clean },
    });
    expect(services.inbox.list({ status: "resolved" })).toContainEqual(
      expect.objectContaining({
        kind: "automation_result",
        title: `Orchestrator ${past}: Review safe`,
        body: clean,
        resolution: {
          by: "orchestrator",
          decision: choice,
          reason: clean,
          orchestratorSessionId: actor.sessionId,
        },
      }),
    );
  },
);

it.each(["orchestrator", "child", "grandchild"] as const)(
  "refuses an approval from the %s session",
  async (name) => {
    const { service, add, store, runnerCalls } = setup();
    const own = add("orchestrator");
    const child = add("child", {}, { parentSessionId: own.sessionId });
    const grandchild = add("grandchild", {}, { parentSessionId: child.sessionId });
    const { id } = { orchestrator: own, child, grandchild }[name];
    const head = store.headSeq();
    for (const choice of ["approve", "deny"] as const) {
      await expect(
        service.decide(actor, { ...decision, id, decision: choice }),
      ).rejects.toMatchObject({
        code: "owner_only_approval",
        message: "This approval requires the owner (unclassified)",
      });
    }
    expect(runnerCalls).toEqual([]);
    expect(store.headSeq()).toBe(head);
  },
);

it.each(["archived orchestrator", "archived orchestrator's child"] as const)(
  "refuses both decisions for the %s after Start fresh",
  async (name) => {
    const { service, add, store, runnerCalls } = setup();
    const archived = add(
      "archived",
      {},
      { role: "orchestrator", archivedAt: "2026-11-23T00:00:00Z" },
    );
    const child = add("child", {}, { parentSessionId: archived.sessionId });
    const { id } = name === "archived orchestrator" ? archived : child;
    const head = store.headSeq();
    for (const choice of ["approve", "deny"] as const) {
      await expect(
        service.decide(actor, { ...decision, id, decision: choice }),
      ).rejects.toMatchObject({
        code: "owner_only_approval",
      });
    }
    expect(runnerCalls).toEqual([]);
    expect(store.headSeq()).toBe(head);
  },
);

it.each(["missing-parent", "deep"])("refuses an approval with %s ancestry", async (name) => {
  const { service, add, addSession, runnerCalls } = setup();
  let parent = addSession({ parentSessionId: null });
  for (let depth = 0; depth < 20; depth++) {
    parent = addSession({ parentSessionId: parent.id });
  }
  const { id } = add(name, {}, { parentSessionId: name === "deep" ? parent.id : "unknown-parent" });
  await expect(service.decide(actor, { ...decision, id })).rejects.toMatchObject({
    code: "owner_only_approval",
    message: "This approval requires the owner (unclassified)",
  });
  expect(runnerCalls).toEqual([]);
});

it("closes the request and rethrows when the audit append fails after responding", async () => {
  const { service, add, services, store, runnerCalls } = setup();
  const target = add("audit-failure");
  const failure = new Error("Audit append failed");
  vi.spyOn(store, "appendFrom").mockImplementationOnce(() => {
    throw failure;
  });

  await expect(service.decide(actor, { ...decision, id: target.id })).rejects.toBe(failure);
  expect(runnerCalls).toHaveLength(1);
  expect(store.listTypes(["approval.decided_by_orchestrator"])).toEqual([]);
  expect(services.inbox.find(target.id)).toMatchObject({
    status: "resolved",
    resolution: { ...decision, decidedBy: "orchestrator", auditFailed: true },
  });
});

it("preserves the owner's resolution written during respond", async () => {
  const ownerResolution = { decision: "deny", decidedBy: "user" };
  const { service, services, add, store } = setup(() =>
    services.inbox.close(services.inbox.get(target.id), "resolved", ownerResolution),
  );
  const target = add("owner-resolved");

  await service.decide(actor, { ...decision, id: target.id });

  expect(services.inbox.get(target.id).resolution).toEqual(ownerResolution);
  expect(store.listTypes(["approval.decided_by_orchestrator"])).toHaveLength(1);
  expect(store.listTypes(["inbox.updated"])).toHaveLength(1);
});

const claimedOrchestrator = {
  kind: "approval",
  decision: "allow_once",
  decidedBy: "orchestrator",
} as const;

it("closes the inbox on respond unless explicitly deferred by the internal caller", async () => {
  const { add, services } = setup();
  const target = add("direct-response");
  await services.sessions.respond(target.sessionId, {
    requestId: target.item.requestId,
    response: claimedOrchestrator,
  });
  expect(services.inbox.get(target.id).status).toBe("resolved");
});

it("lets Codex's completion event close the inbox with the effective approval", async () => {
  const { add, services, runnerCalls, store } = setup();
  const target = add(
    "stale-session-approval",
    { action: "command", toolName: "shell", command: "git fetch" },
    { provider: "codex" },
  );
  const response = { kind: "approval", decision: "allow_session", decidedBy: "user" } as const;
  await services.sessions.respond(target.sessionId, { requestId: target.item.requestId, response });

  expect(runnerCalls).toContainEqual(
    expect.objectContaining({ name: "session.respond", response }),
  );
  expect(services.inbox.get(target.id).status).toBe("open");
  store.append([
    agentEventToNewEvent(target.sessionId, {
      type: "item.completed",
      threadId: "thread",
      turnId: "turn",
      item: { ...target.item, status: "completed", decision: "allow_once", decidedBy: "user" },
    }),
  ]);
  expect(services.inbox.get(target.id)).toMatchObject({
    status: "resolved",
    resolution: { status: "completed", decision: "allow_once", decidedBy: "user" },
  });
});

it.each(["session", "inbox"])(
  "the %s route stamps a claimed orchestrator response as the user's",
  async (route) => {
    const { add, services, runnerCalls } = setup();
    const target = add("route-response");
    const app = route === "session" ? sessionRoutes(services, "token") : inboxRoutes(services);
    const path = route === "session" ? `/${target.sessionId}/respond` : `/${target.id}/resolve`;
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: target.item.requestId, response: claimedOrchestrator }),
    });

    expect(response.status).toBe(200);
    const asUser = { decision: "allow_once", decidedBy: "user" };
    expect(runnerCalls).toContainEqual(
      expect.objectContaining({
        name: "session.respond",
        response: { kind: "approval", ...asUser },
      }),
    );
    expect(services.inbox.get(target.id)).toMatchObject({ status: "resolved", resolution: asUser });
  },
);

describe.each([
  ["staging DB migration", "db-migration", "staging DB migration needs the owner's approval card"],
  ["DB read", "db-read", "DB read needs the owner's approval card"],
  ["erpure LAN/host", "dbops-lan", "erpure LAN/host action needs the owner's approval card"],
])("%s guard card", (_name, scope, reason) => {
  it.each(["approve", "deny"] as const)(
    "decide_approval refuses %s without side effects",
    async (choice) => {
      const { add, services, store, runnerCalls } = setup();
      const { id } = add(scope, {
        action: "command",
        hookReason: `[codeden-card v1 scope=${scope} class=delegable] ${reason}`,
      });
      const head = store.headSeq();
      expect(
        await services.tools.call("decide_approval", { ...decision, id, decision: choice }, actor),
      ).toEqual({
        isError: true,
        text: "This approval requires the owner (prd_db)",
      });
      expect(runnerCalls).toEqual([]);
      expect(store.headSeq()).toBe(head);
    },
  );
});

it("refuses both decisions on every owner-only kind without appending or sending", async () => {
  const { service, add, services, store, runnerCalls, localProject } = setup();
  for (const command of [
    "deploy",
    "password",
    "dbops",
    "testflight",
    "az group create",
    "purchase",
  ]) {
    add(command, { command });
  }
  add("elicitation", { url: "https://example.invalid" });
  add("chrome", { toolName: "mcp__claude-in-chrome__navigate" });
  const template = services.inbox.get(add("template").id);
  services.inbox.close(template, "dismissed", null);
  for (const kind of ["question", "checklist_approval", "spec_approval"] as const) {
    services.inbox.put({
      ...template,
      id: kind,
      kind,
      sessionId: null,
      requestId: null,
      itemId: null,
    });
  }
  services.decisions.raise({ ...caller("pm"), projectId: localProject.id }, localProject.id, {
    kind: "github",
    target: {
      kind: "merge_verify",
      repository: "acme/app",
      pullNumber: 1,
      headSha: "a".repeat(40),
    },
  });
  services.decisions.raise(actor, localProject.id, {
    kind: "plan",
    steps: [{ action: "resume_automation", args: {} }],
  });
  const { approvals } = service.list();
  expect(approvals).toHaveLength(13);
  const head = store.headSeq();
  for (const entry of approvals) {
    expect(entry.delegable).toBe(false);
    for (const choice of ["approve", "deny"] as const) {
      await expect(
        service.decide(actor, { ...decision, id: entry.id, decision: choice }),
      ).rejects.toMatchObject({
        status: 403,
        code: "owner_only_approval",
        message: expect.stringContaining(entry.ownerOnly ?? "?"),
      });
    }
  }
  expect(store.headSeq()).toBe(head);
  expect(runnerCalls).toEqual([]);
});

it("refuses unknown ids, non-orchestrator actors and sessionless orchestrators", async () => {
  const { service, add, store, runnerCalls } = setup();
  const { id } = add("safe");
  const head = store.headSeq();
  await expect(service.decide(actor, { ...decision, id: "missing" })).rejects.toMatchObject({
    status: 404,
  });
  for (const other of [caller("pm"), { ...actor, sessionId: null }]) {
    await expect(service.decide(other, { ...decision, id })).rejects.toMatchObject({ status: 403 });
  }
  expect(store.headSeq()).toBe(head);
  expect(runnerCalls).toEqual([]);
});

it("lists and calls both MCP tools only as the orchestrator", async () => {
  const { services, add } = setup();
  const { id } = add("safe");
  expect(McpTokenClaims.safeParse({ ...actor, role: "factory", jti: "test" }).success).toBe(false);
  for (const [name, args] of [
    ["list_pending_approvals", {}],
    ["decide_approval", { ...decision, id }],
  ] as const) {
    expect(services.tools.list("orchestrator").map((tool) => tool.name)).toContain(name);
    const factory = "factory" as ToolCaller["role"];
    for (const role of ["pm", "agent", factory] as const) {
      expect(services.tools.list(role).map((tool) => tool.name)).not.toContain(name);
      expect(await services.tools.call(name, args, caller(role))).toEqual({
        isError: true,
        text: `Unknown tool: ${name}`,
      });
    }
    expect(await services.tools.call(name, args, actor)).toMatchObject({ isError: false });
  }
});

it.each(["approve", "deny"] as const)(
  "can %s a PM tier-0 card while its own card stays open",
  async (choice) => {
    const { service, services, store, localProject, addSession } = setup();
    addSession({ id: "session-pm" });
    const card = services.decisions.raise(
      { ...caller("pm"), projectId: localProject.id },
      localProject.id,
      {
        kind: "plan",
        steps: [pmStep],
      },
    );
    const own = services.decisions.raise(actor, localProject.id, {
      kind: "plan",
      steps: [{ action: "resume_automation", args: {} }],
    });
    await expect(
      service.decide(actor, { ...decision, id: `card:${own.id}`, decision: choice }),
    ).rejects.toMatchObject({ code: "owner_only_approval" });
    await service.decide(actor, { ...decision, id: `card:${card.id}`, decision: choice });
    expect(services.decisions.pending().map(({ id }) => id)).toEqual([own.id]);
    const [event] = store.listTypes([
      choice === "approve" ? "decision.confirmed" : "decision.denied",
    ]);
    expect(event?.payload).toEqual({
      id: card.id,
      by: { role: "orchestrator", sessionId: actor.sessionId },
    });
  },
);
