import { type Session, type SessionOptions, Settings } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { buildQueryOptions } from "../../../packages/providers/src/claude/options";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { startsWithTag, stripLeadingTags } from "../src/services/sessions/role-tag";
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

function launcher(remote = false): SessionLauncher {
  return new SessionLauncher({
    runner: localRunner,
    runners: remote ? { forSession: () => remoteRunner, home: () => localRunner } : undefined,
    home: "/tmp/codeden-home",
  } as unknown as LauncherDeps);
}

function queryArgs(session: SessionOptions) {
  return buildQueryOptions({
    session,
    executable: { kind: "native", path: "/bin/claude" },
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    hooks: {},
    abortController: new AbortController(),
    mcpConfigFile: "/private/mcp.json",
  }).extraArgs;
}

describe("Claude in Chrome for Browser Operator sessions", () => {
  it("adds the Chrome flag alongside the MCP config on the home runner", () => {
    const options = launcher().sessionOptions(browserOperator, "tok");
    expect(options.chrome).toBe(true);
    expect(queryArgs(options)).toEqual({ "mcp-config": "/private/mcp.json", chrome: null });
  });

  it.each<{ label: string; patch: Partial<Session>; remote?: boolean }>([
    { label: "a Writer title", patch: { title: "[Writer] Fix login" } },
    { label: "no title", patch: { title: null } },
    { label: "the Codex provider", patch: { provider: "codex" } },
    { label: "the PM role", patch: { role: "pm" } },
    { label: "a remote session runner", patch: {}, remote: true },
  ])("omits the Chrome flag for $label", ({ patch, remote }) => {
    const options = launcher(remote).sessionOptions({ ...browserOperator, ...patch }, "tok");
    expect("chrome" in options).toBe(false);
    expect(queryArgs(options)).not.toHaveProperty("chrome");
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
    ["Fix [Browser Operator]", false],
    ["[Unclosed", false],
  ])("checks for a leading tag in %s", (title, expected) => {
    expect(startsWithTag(title)).toBe(expected);
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
