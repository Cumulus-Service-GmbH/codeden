import { randomUUID } from "node:crypto";
import {
  type Item,
  RunnerCommand,
  type Session,
  type SessionOptions,
  Settings,
  type StartSessionRequest,
} from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildQueryOptions } from "../../../packages/providers/src/claude/options";
import { agentSessionOptions } from "../../runner/src/session-env";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { startSession } from "../src/mcp/tools/pm/sessions";
import type { AppServices } from "../src/services/container";
import { forkTitle } from "../src/services/sessions/fork";
import { handoffTitle } from "../src/services/sessions/handoff";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { QuestionBroker } from "../src/services/sessions/questions";
import { SessionRepo } from "../src/services/sessions/repo";
import { startsWithLiteralTag, stripLeadingTags } from "../src/services/sessions/role-tag";
import { ProviderUtilityService } from "../src/services/utility";
import { sampleSession, sampleSessionEvent } from "./helpers";

const localRunner = { mcpProxyUrl: () => "http://127.0.0.1:1/mcp" };
const remoteRunner = { ...localRunner, remote: () => ({}) };
const browserOperator: Session = {
  ...sampleSession,
  projectId: null,
  provider: "claude",
  role: "agent",
  title: "[Browser Operator] Check the login page",
};

function launcher(remote = false, repo?: Pick<SessionRepo, "find">): SessionLauncher {
  return new SessionLauncher({
    repo: repo ?? { find: () => ({ startMeta: { chromeOptIn: true } }) },
    runner: localRunner,
    runners: remote ? { forSession: () => remoteRunner, home: () => localRunner } : undefined,
    home: "/tmp/codeden-home",
  } as unknown as LauncherDeps);
}

function queryOptions(session: SessionOptions) {
  return buildQueryOptions({
    session,
    executable: { kind: "native", path: "/bin/claude" },
    canUseTool: async () => ({ behavior: "deny", message: "Fixture denies tool execution" }),
    hooks: {},
    abortController: new AbortController(),
    mcpConfigFile: "/private/mcp.json",
  });
}

describe("Claude in Chrome for Browser Operator sessions", () => {
  it("forwards the Chrome flag through the runner alongside the MCP config", () => {
    const options = launcher().sessionOptions(browserOperator, "tok");
    const command = RunnerCommand.parse({
      name: "session.start",
      sessionId: browserOperator.id,
      providerId: "claude",
      options,
    });
    if (command.name !== "session.start") throw new Error("Expected a session.start command");
    const sdk = queryOptions(agentSessionOptions(command.options));
    expect(sdk.extraArgs).toEqual({ "mcp-config": "/private/mcp.json", chrome: null });
    expect(sdk.allowedTools?.some((name) => name.startsWith("mcp__claude-in-chrome"))).toBe(false);
  });

  it.each<{ label: string; patch: Partial<Session>; remote?: boolean }>([
    { label: "a Writer title", patch: { title: "[Writer] Fix login" } },
    { label: "no title", patch: { title: null } },
    { label: "the Codex provider", patch: { provider: "codex" } },
    { label: "the PM role", patch: { role: "pm" } },
    { label: "a remote session runner", patch: {}, remote: true },
  ])("does not opt in to Chrome for $label", ({ patch, remote }) => {
    const options = launcher(remote).sessionOptions({ ...browserOperator, ...patch }, "tok");
    expect("chrome" in options).toBe(false);
  });

  it("requires a recorded opt-in when opening a saved session", () => {
    const database = openDatabase(":memory:");
    try {
      const repo = new SessionRepo(database.db, new EventStore(database.db));
      const meta = {
        workspaceMode: "worktree" as const,
        workspaceFallback: null,
        forced: null,
        queuedBehind: [],
      };
      repo.create(browserOperator, meta);
      const legacy = { ...browserOperator, id: "legacy", title: null, resumeToken: randomUUID() };
      repo.create(legacy, meta);
      const titledLegacy = repo.update(legacy.id, (session) => ({
        ...session,
        title: browserOperator.title,
      }));
      const reopened = launcher(false, new SessionRepo(database.db, new EventStore(database.db)));

      expect(reopened.sessionOptions(repo.get(browserOperator.id)).chrome).toBe(true);
      expect(reopened.sessionOptions(titledLegacy).chrome).toBeUndefined();
    } finally {
      database.close();
    }
  });
});

describe("PM Chrome confirmation cards", () => {
  it.each([
    ["user", "Allow Chrome", "started"],
    ["user", "Cancel", "skipped"],
    ["pm", "Allow Chrome", "skipped"],
    ["timeout", "", "skipped"],
    ["abort", "", "skipped"],
    ["already aborted", "", "skipped"],
  ] as const)("handles %s answering %s", async (answerer, answer, status) => {
    const database = openDatabase(":memory:");
    const controller = new AbortController();
    try {
      const store = new EventStore(database.db);
      store.append(sampleSessionEvent());
      const sessionRepo = new SessionRepo(database.db, store);
      const sendMessage = vi.fn(async () => {});
      const questions = new QuestionBroker({
        db: database.db,
        store,
        sendMessage: () => sendMessage,
        waitMs: answerer === "timeout" ? 0 : undefined,
      });
      const services = {
        db: database.db,
        projects: { get: () => ({ kind: "local", archivedAt: null }) },
        factory: {
          isUnattended: () => false,
          // The project's Team sets the Browser Operator: a tagged PM start needs it.
          data: {
            loop: () => ({
              tuning: {
                team: [{ role: "browserOperator", provider: "claude", model: null, effort: null }],
              },
            }),
          },
        },
        settings: { get: () => Settings.parse({}) },
        sessionRepo,
        questions,
        sessions: {
          start: async (
            _req: StartSessionRequest,
            opts?: { confirmChrome?: () => Promise<boolean> },
          ) =>
            (await opts?.confirmChrome?.())
              ? { status: "started", sessionId: "operator" }
              : { status: "skipped" },
        },
      } as unknown as AppServices;
      if (answerer === "already aborted") controller.abort();
      const started = startSession.handler(
        startSession.input.parse({
          title: "[Browser Operator] Open the documentation",
          prompt: "Open the documentation.",
          purpose: "Open the documentation",
          provider: "claude",
        }),
        {
          services,
          projectId: "p1",
          sessionId: sampleSession.id,
          role: "pm",
          caller: "mcp",
          signal: controller.signal,
        },
      );
      if (answerer === "already aborted") {
        await expect(started).resolves.toMatchObject({ status });
        expect(store.listAfter(0).some((event) => event.type === "inbox.created")).toBe(false);
        return;
      }
      const card = await vi.waitFor(() => {
        const item = store
          .listAfter(0)
          .filter((event) => event.type === "agent.item.started")
          .map((event) => (event.payload as { item: Item }).item)
          .find((item) => item.kind === "user_question");
        if (!item) throw new Error("Expected the Chrome confirmation card");
        return item;
      });
      expect(card.questions[0]?.allowFreeText).toBe(false);
      const response = { kind: "answer" as const, answers: { q1: [answer || "Allow Chrome"] } };
      if (answerer === "user" || answerer === "pm") {
        await questions.respond(sampleSession.id, card.requestId, response, answerer);
      } else if (answerer === "abort") {
        controller.abort();
      }
      await expect(started).resolves.toMatchObject({ status });
      if (answerer === "timeout" || answerer === "abort") {
        expect(sessionRepo.item(sampleSession.id, card.id)?.item.status).toBe("cancelled");
        await expect(questions.respond(sampleSession.id, card.requestId, response)).rejects.toThrow(
          "already answered",
        );
        expect(sendMessage).not.toHaveBeenCalled();
      }
    } finally {
      controller.abort();
      database.close();
    }
  });
});

describe("role tags in derived titles", () => {
  it.each([
    ["[Browser Operator] Fix", "Fix"],
    ["  [A] [Browser Operator]x", "x"],
    ["Fix [Browser Operator]", "Fix [Browser Operator]"],
  ])("strips only leading tags from %s", (title, expected) => {
    expect(stripLeadingTags(title)).toBe(expected);
  });

  it.each([
    ["[Browser Operator] Fix", true],
    ["  [A] Fix", true],
    ["[{{project.name}}] Check docs", false],
    ["Fix [Browser Operator]", false],
    ["[Unclosed", false],
  ])("checks for a literal leading tag in %s", (title, expected) => {
    expect(startsWithLiteralTag(title)).toBe(expected);
  });

  it("strips role tags from default fork and handoff titles", () => {
    expect(forkTitle(browserOperator)).toBe("Check the login page (fork)");
    expect(handoffTitle(browserOperator, "Claude")).toBe("Check the login page (to Claude)");
  });
});

it.each([
  ["[Browser Operator] Open the site", "Open the site"],
  ["[Writer] [Browser Operator] Open the site", "Open the site"],
  ['"Fix the build."', "Fix the build"],
])("cleans the generated session title %s", async (reply, title) => {
  const utility = new ProviderUtilityService({
    settings: () => Settings.parse({}),
    oneShot: { available: () => ["claude"], oneShot: async () => reply },
  });
  expect(
    await utility.sessionTitle({
      session: browserOperator,
      firstMessage: "Check the login page",
      finalMessage: null,
    }),
  ).toBe(title);
});
