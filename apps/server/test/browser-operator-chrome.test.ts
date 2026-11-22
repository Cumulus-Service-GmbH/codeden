import { randomUUID } from "node:crypto";
import { RunnerCommand, type Session, type SessionOptions, Settings } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { buildQueryOptions } from "../../../packages/providers/src/claude/options";
import { agentSessionOptions } from "../../runner/src/session-env";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { forkTitle } from "../src/services/sessions/fork";
import { handoffTitle } from "../src/services/sessions/handoff";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { SessionRepo } from "../src/services/sessions/repo";
import { startsWithLiteralTag, stripLeadingTags } from "../src/services/sessions/role-tag";
import { ProviderUtilityService } from "../src/services/utility";
import { sampleSession } from "./helpers";

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
