import { expect, it } from "vitest";
import {
  FactoryTuning,
  FactoryTuningPatch,
  resolveTeam,
  Settings,
  sessionTeamMember,
  TEAM_FILE_ENV,
  Team,
  TeamFile,
  TeamRole,
  teamRoleOfTitle,
} from "../src";

it("fills Team defaults in old records while keeping tuning patches sparse", () => {
  expect(FactoryTuning.parse({})).toMatchObject({ team: [], resultSummaryBytes: null });
  expect(Settings.parse({}).teamSetup).toEqual({
    remembered: false,
    team: [],
    resultSummaryBytes: null,
  });
  expect(FactoryTuningPatch.parse({})).toEqual({});
  const patch = FactoryTuningPatch.parse({ team: [{ role: "writer", provider: "codex" }] });
  expect(FactoryTuningPatch.parse(JSON.parse(JSON.stringify(patch)))).toEqual({
    team: [{ role: "writer", provider: "codex", model: null, effort: null }],
  });
});

it("rejects duplicate roles and automatic providers", () => {
  const member = { role: "writer", provider: "codex" };
  expect(Team.safeParse([member, member]).success).toBe(false);
  expect(Team.safeParse([{ ...member, provider: "auto" }]).success).toBe(false);
});

it.each([
  ["Architect", "architect"],
  ["Writer", "writer"],
  ["UI Writer", "uiWriter"],
  ["AGENTS.md Writer", "agentsMdWriter"],
  ["Plan Reviewer", "planReviewer"],
  ["Code Reviewer", "reviewer"],
  ["Investigator", "investigator"],
  ["Browser Tester", "browserTester"],
  ["Browser Operator", "browserOperator"],
  ["Unknown", null],
])("reads only the first leading tag [%s]", (tag, role) => {
  expect(teamRoleOfTitle(`[${tag}] [Writer] Work`)).toBe(role);
  expect(teamRoleOfTitle(`Work [${tag}]`)).toBeNull();
});

it("requires exact case for Team role tags", () => {
  expect(teamRoleOfTitle("[writer] Work")).toBeNull();
  expect(teamRoleOfTitle("[Browser tester] Work")).toBeNull();
});

it("round-trips a Team file", () => {
  const file = TeamFile.parse({
    version: 1,
    sessionId: "s1",
    projectId: "p1",
    roots: ["/work/app", "/home/.codeden/wt/app"],
    team: [{ role: "reviewer", provider: "claude", model: "claude-opus-5-5", effort: "high" }],
    sources: { reviewer: "project" },
    updatedAt: "2026-11-22T19:00:00.000Z",
  });
  expect(TeamFile.parse(JSON.parse(JSON.stringify(file)))).toEqual(file);
  expect(TeamFile.safeParse({ ...file, version: 2 }).success).toBe(false);
  expect(TEAM_FILE_ENV).toBe("TEAM_FILE");
});

it("resolves a session's Team: session over project over defaults, nothing else", () => {
  const member = (role: string, provider: string, model: string | null) => ({
    role: role as never,
    provider: provider as never,
    model,
    effort: null,
  });
  const session = sessionTeamMember({
    title: "[Writer] Fix it",
    provider: "claude",
    model: "m-session",
  });
  expect(session).toEqual(member("writer", "claude", "m-session"));
  expect(sessionTeamMember({ title: "Fix it", provider: "claude" })).toBeNull();
  const { team, sources } = resolveTeam({
    defaults: [member("writer", "codex", "m-default"), member("reviewer", "codex", "m-default")],
    project: [member("reviewer", "claude", "m-project")],
    session,
  });
  expect(team).toEqual([
    member("writer", "claude", "m-session"),
    member("reviewer", "claude", "m-project"),
  ]);
  expect(sources).toEqual({ writer: "session", reviewer: "project" });
  expect(Team.safeParse(TeamRole.options.map((role) => member(role, "codex", null))).success).toBe(
    true,
  );
});

it("refuses a Plan Reviewer at minimal effort, wherever the Team is used", () => {
  const plan = { role: "planReviewer", provider: "codex", model: null, effort: "minimal" };
  expect(Team.safeParse([plan]).success).toBe(false);
  expect(Team.safeParse([{ ...plan, effort: "low" }]).success).toBe(true);
});

it("round-trips PM autonomy policy, tool inputs and the audit event", async () => {
  const { AutonomyPolicy, PmStartSessionInput, SetSessionAutonomyInput, SessionAutonomyChanged } =
    await import("../src");
  const roundTrip = (schema: { parse(input: unknown): unknown }, input: unknown) => {
    expect(schema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
  };
  roundTrip(AutonomyPolicy, { writer: { migration: "supervised" } });
  roundTrip(PmStartSessionInput, {
    prompt: "Go",
    purpose: "migration",
    autonomy: "supervised",
    tokenSaver: "off",
  });
  const change = { sessionId: "s1", autonomy: "supervised", reason: "Review each command" };
  roundTrip(SetSessionAutonomyInput, change);
  roundTrip(SessionAutonomyChanged, {
    previous: "auto",
    autonomy: change.autonomy,
    reason: change.reason,
    changedBy: "pm1",
  });
});
