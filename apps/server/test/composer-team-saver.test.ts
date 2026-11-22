import { StartSessionRequest, TokenSaverSettings } from "@codeden/contracts";
import { expect, it } from "vitest";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { withTeamRole } from "../src/services/sessions/team-start";
import { tokenSaverNote } from "../src/services/sessions/token-saver";
import { sampleSession } from "./helpers";

// The composer's Team and Saver choices for a new session.
const writer = {
  role: "writer" as const,
  provider: "claude" as const,
  model: "m-project",
  effort: "high" as const,
};

it("round-trips a start with a Team role and a token saver level", () => {
  const req = StartSessionRequest.parse({
    projectId: "p1",
    teamRole: "browserTester",
    tokenSaver: "ultra",
  });
  expect(StartSessionRequest.parse(JSON.parse(JSON.stringify(req)))).toMatchObject({
    teamRole: "browserTester",
    tokenSaver: "ultra",
  });
  expect(StartSessionRequest.safeParse({ projectId: "p1", teamRole: "boss" }).success).toBe(false);
});

it("a Team role tags the title and fills unset pins from the project Team over the default Team", () => {
  const req = StartSessionRequest.parse({
    projectId: "p1",
    teamRole: "writer",
    purpose: "Fix the parser",
  });
  const out = withTeamRole(req, {
    defaults: [{ ...writer, model: "m-default" }],
    project: [writer],
  });
  expect(out).toMatchObject({
    title: "[Writer] Fix the parser",
    provider: "claude",
    model: "m-project",
    effort: "high",
  });
  // Only the default Team sets it: the default member applies.
  expect(
    withTeamRole(req, { defaults: [{ ...writer, model: "m-default" }], project: [] }),
  ).toMatchObject({
    model: "m-default",
  });
  // What the user chose explicitly is the session's own choice and stays.
  const own = withTeamRole(
    StartSessionRequest.parse({
      projectId: "p1",
      teamRole: "writer",
      title: "[Writer] Mine",
      provider: "codex",
      model: "m-own",
    }),
    { defaults: [], project: [writer] },
  );
  expect(own).toMatchObject({ title: "[Writer] Mine", provider: "codex", model: "m-own" });
  expect(own.effort).toBeUndefined();
  // No role: unchanged.
  const plain = StartSessionRequest.parse({ projectId: "p1", purpose: "x" });
  expect(withTeamRole(plain, { defaults: [], project: [writer] })).toBe(plain);
});

it("the session's own saver level wins over the project and role defaults", () => {
  const settings = TokenSaverSettings.parse({
    default: "lite",
    projects: { p1: { level: "full" } },
  });
  const launcher = (tokenSaver: string | undefined) =>
    new SessionLauncher({
      runner: { mcpProxyUrl: () => null, providers: () => [] },
      projects: { get: () => null },
      home: "/tmp/codeden-home",
      tokenSaver: () => settings,
      repo: { find: () => ({ startMeta: tokenSaver ? { tokenSaver } : {} }) },
    } as unknown as LauncherDeps);
  const session = { ...sampleSession, projectId: "p1" };
  expect(launcher("ultra").sessionOptions(session).systemPrompt).toContain(
    tokenSaverNote("ultra") ?? "x",
  );
  expect(launcher("off").sessionOptions(session).systemPrompt).not.toContain("Token saver");
  expect(launcher(undefined).sessionOptions(session).systemPrompt).toContain(
    tokenSaverNote("full") ?? "x",
  );
});
