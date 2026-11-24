import { randomUUID } from "node:crypto";
import {
  type Item,
  type RespondRequest,
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
import { answerProviderQuestion } from "../src/services/factory/unattended";
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

  it("opens an explicitly opted-in session without a role tag", () => {
    const database = openDatabase(":memory:");
    try {
      const repo = new SessionRepo(database.db, new EventStore(database.db));
      const session = { ...browserOperator, title: "Check the login page" };
      repo.create(session, {
        workspaceMode: "worktree",
        workspaceFallback: null,
        forced: null,
        queuedBehind: [],
        chromeRequested: true,
      });
      expect(launcher(false, repo).sessionOptions(session).chrome).toBe(true);
    } finally {
      database.close();
    }
  });

  it("honors an unchecked Chrome option even with a Browser Operator tag", () => {
    const database = openDatabase(":memory:");
    try {
      const repo = new SessionRepo(database.db, new EventStore(database.db));
      repo.create(browserOperator, {
        workspaceMode: "worktree",
        workspaceFallback: null,
        forced: null,
        queuedBehind: [],
        chromeRequested: false,
      });
      expect(launcher(false, repo).sessionOptions(browserOperator).chrome).toBeUndefined();
    } finally {
      database.close();
    }
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
    [
      "the user's answer completes the Chrome launch confirmation",
      "user",
      "Allow Chrome",
      "started",
    ],
    ["handles Chrome consent for user answering Cancel", "user", "Cancel", "skipped"],
    ["a PM's answer leaves the Chrome launch confirmation open", "pm", "Allow Chrome", "started"],
    [
      "a policy answer leaves the Chrome launch confirmation open",
      "policy",
      "Allow Chrome",
      "started",
    ],
    ["handles Chrome consent timeout", "timeout", "", "skipped"],
    ["handles Chrome consent abort", "abort", "", "skipped"],
    ["handles Chrome consent when already aborted", "already aborted", "", "skipped"],
    [
      "unattended PM Chrome start waits for explicit owner consent",
      "unattended",
      "Allow Chrome",
      "started",
    ],
  ] as const)("%s", async (_name, answerer, answer, status) => {
    const database = openDatabase(":memory:");
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const store = new EventStore(database.db);
      store.append(sampleSessionEvent());
      const sessionRepo = new SessionRepo(database.db, store);
      const sendMessage = vi.fn(async () => {});
      const questions = new QuestionBroker({
        db: database.db,
        store,
        sendMessage: () => sendMessage,
      });
      const services = {
        db: database.db,
        projects: { get: () => ({ kind: "local", archivedAt: null }) },
        projectTeam: () => [
          { role: "browserOperator", provider: "claude", model: null, effort: null },
        ],
        factory: {
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
            opts?: { confirmChrome?: () => Promise<boolean | string> },
          ) => {
            const confirmation = await opts?.confirmChrome?.();
            return confirmation === true
              ? { status: "started", sessionId: "operator" }
              : { status: "skipped", reason: confirmation };
          },
        },
      } as unknown as AppServices;
      if (answerer === "already aborted") controller.abort();
      const inboxCreated = Promise.withResolvers<void>();
      const unsubscribe = store.subscribe((events) => {
        if (events.some((event) => event.type === "inbox.created")) inboxCreated.resolve();
      });
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
        await expect(started).resolves.toMatchObject({
          status,
          message: "The owner did not approve the Chrome launch.",
        });
        expect(store.listAfter(0).some((event) => event.type === "inbox.created")).toBe(false);
        return;
      }
      await Promise.race([
        inboxCreated.promise,
        started.then(() => {
          throw new Error("Expected the Chrome confirmation card before the start result");
        }),
      ]).finally(unsubscribe);
      const event = store.listAfter(0).find((event) => {
        return (
          event.type === "agent.item.started" &&
          (event.payload as { item: Item }).item.kind === "user_question"
        );
      });
      const card = (event?.payload as { item: Item } | undefined)?.item;
      if (!event || card?.kind !== "user_question")
        throw new Error("Expected the Chrome confirmation card");
      expect(card.questions[0]?.allowFreeText).toBe(false);
      if (answerer === "unattended") {
        const pm = { ...sampleSession, role: "pm" as const, projectId: "p1" };
        const respond = vi.fn(async (id: string, req: RespondRequest) => {
          await questions.respond(id, req.requestId, req.response);
        });
        const autoAnswered = await answerProviderQuestion(
          {
            repo: { find: () => ({ session: pm }) },
            projects: { get: () => ({ autonomyMode: "dark_factory" }) },
          } as unknown as Parameters<typeof answerProviderQuestion>[0],
          respond,
          event,
        );
        expect(autoAnswered).toBe(false);
        expect(respond).not.toHaveBeenCalled();
        expect(store.listAfter(0)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "inbox.created",
              payload: expect.objectContaining({
                item: expect.objectContaining({
                  kind: "question",
                  status: "open",
                  requestId: card.requestId,
                }),
              }),
            }),
          ]),
        );
        expect(sessionRepo.item(sampleSession.id, card.id)?.item.status).toBe("in_progress");
      }
      const response = { kind: "answer" as const, answers: { q1: [answer || "Allow Chrome"] } };
      if (answerer === "pm" || answerer === "policy" || answerer === "unattended") {
        await expect(
          questions.respond(
            sampleSession.id,
            card.requestId,
            { kind: "answer", answers: { q1: ["Allow Chrome"] } },
            answerer === "policy" ? "policy" : "pm",
          ),
        ).rejects.toMatchObject({ code: "user_confirmation_required" });
        expect(sessionRepo.item(sampleSession.id, card.id)?.item.status).toBe("in_progress");
      }
      if (
        answerer === "pm" ||
        answerer === "policy" ||
        answerer === "user" ||
        answerer === "unattended"
      ) {
        await expect(
          questions.respond(sampleSession.id, card.requestId, response, "user"),
        ).resolves.toBe(true);
        expect(sessionRepo.item(sampleSession.id, card.id)?.item).toMatchObject({
          status: "completed",
          answers: response.answers,
          decidedBy: "user",
        });
      } else if (answerer === "abort") {
        controller.abort();
      } else if (answerer === "timeout") {
        await vi.advanceTimersByTimeAsync(4 * 60_000);
      }
      await expect(started).resolves.toMatchObject({
        status,
        ...((answerer === "timeout" || answerer === "abort") && {
          message: "The owner did not approve the Chrome launch.",
        }),
      });
      if (answerer === "timeout" || answerer === "abort") {
        expect(sessionRepo.item(sampleSession.id, card.id)?.item.status).toBe("cancelled");
        await expect(questions.respond(sampleSession.id, card.requestId, response)).rejects.toThrow(
          "already answered",
        );
        expect(sendMessage).not.toHaveBeenCalled();
      }
    } finally {
      controller.abort();
      vi.useRealTimers();
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
