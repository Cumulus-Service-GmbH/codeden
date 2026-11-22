import { expect, it } from "vitest";
import {
  FactoryTuning,
  FactoryTuningPatch,
  Settings,
  TEAM_FILE_ENV,
  Team,
  TeamFile,
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

it("round-trips a Team file", () => {
  const file = TeamFile.parse({
    version: 1,
    projectId: "p1",
    team: [{ role: "reviewer", provider: "claude", model: "claude-opus-5-5", effort: "high" }],
    updatedAt: "2026-11-22T19:00:00.000Z",
  });
  expect(TeamFile.parse(JSON.parse(JSON.stringify(file)))).toEqual(file);
  expect(TeamFile.safeParse({ ...file, version: 2 }).success).toBe(false);
  expect(TEAM_FILE_ENV).toBe("TEAM_FILE");
});
