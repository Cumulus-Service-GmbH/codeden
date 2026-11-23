import { join } from "node:path";
import {
  type AgentEvent,
  agentEventToNewEvent,
  type ItemOf,
  McpTokenClaims,
} from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCaller } from "../src/mcp/registry";
import { ensureHome } from "../src/paths";
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
const ordinary = { kind: "tool_approval", action: "file_change" } as const;
type Entry = Parameters<typeof classifyApproval>[0];

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
  { kind: "question" },
  { kind: "checklist_approval" },
  { kind: "spec_approval" },
  { kind: "github_card" },
  { kind: "plan_card", requestedBy: "orchestrator", steps: [pmStep] },
  { kind: "plan_card", requestedBy: "pm", steps: [{ action: "production", args: {} }] },
  { kind: "tool_approval", action: "command", command: prefix },
  { kind: "tool_approval", action: "command", reason: prefix },
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
  const delegated: Entry[] = [
    ordinary,
    { ...ordinary, action: "outside_worktree" },
    { ...ordinary, action: "plan" },
    { kind: "plan_card", requestedBy: "pm", steps: [pmStep] },
  ];
  for (const entry of delegated) expect(classifyApproval(entry)).toEqual({ delegable: true });
});

let env: ReturnType<typeof createGithubEnv> | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

function setup() {
  const fixture = createGithubEnv();
  env = fixture;
  const paths = ensureHome(join(fixture.dir, "home"));
  const runner: RunnerPort = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: Parameters<RunnerPort["request"]>[0]) => {
      fixture.runnerCalls.push(command);
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
    projectId = fixture.localProject.id,
  ) => {
    const sessionId = `session-${id}`;
    fixture.addSession({ id: sessionId, projectId, scope: { projectId } });
    const emit = (event: AgentEvent) => agentEventToNewEvent(sessionId, event);
    const item: ItemOf<"approval_request"> = {
      kind: "approval_request",
      id: `item-${id}`,
      requestId: `request-${id}`,
      title: `Review ${id}`,
      action: "file_change",
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
  return { ...fixture, services, service: services.orchestratorApprovals, add };
}

it("lists two projects with transcript context and redacts nested secrets", () => {
  const { service, add, localProject, githubProject } = setup();
  const local = add("local", {
    command: `echo ${secret}`,
    reason: `Review ${secret}`,
    hookReason: `${prefix} Review ${secret}`,
    cwd: "/work",
    toolName: "Bash",
    toolInput: { command: `echo ${secret}`, nested: [secret] },
  });
  const remote = add("remote", {}, githubProject.id);
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
  "%s delegates to the runner and records one audit batch",
  async (choice, responseDecision, past) => {
    const { service, add, services, store, runnerCalls } = setup();
    const target = add("safe");
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
    const { service, services, store, localProject } = setup();
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
