import { expect, it } from "vitest";
import { ProjectTeams, StartTeamRun, TeamRunSettings, TeamWorker } from "../src";

it("round-trips named Teams and requires exactly one designated default", () => {
  const limits = { maxParallel: 2, maxAssignments: 5, maxRounds: 3 };
  const teams = ProjectTeams.parse({
    defaultTeamId: "build",
    teams: [
      { id: "build", name: "Build", team: [], limits },
      { id: "release", name: "Release", team: [], limits: { ...limits, maxParallel: 1 } },
    ],
  });
  expect(ProjectTeams.parse(JSON.parse(JSON.stringify(teams)))).toEqual(teams);
  expect(ProjectTeams.safeParse({ ...teams, defaultTeamId: "unknown" }).success).toBe(false);
  expect(
    ProjectTeams.safeParse({ ...teams, teams: [teams.teams[0], teams.teams[0]] }).success,
  ).toBe(false);
  expect(TeamRunSettings.safeParse({ ...limits, maxParallel: 65 }).success).toBe(false);
});

it("requires exactly one approved-plan reference at the boundary", () => {
  const request = { teamId: "build", planSha: "a".repeat(40) };
  expect(StartTeamRun.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
  expect(StartTeamRun.parse({ checklistId: "plan-1" })).toEqual({ checklistId: "plan-1" });
  expect(StartTeamRun.safeParse({ ...request, checklistId: "plan-1" }).success).toBe(false);
  expect(StartTeamRun.safeParse({ teamId: "build" }).success).toBe(false);
});

it("round-trips an assigned worker and its checkpoint", () => {
  const worker = {
    sessionId: "session-1",
    itemId: "item-2",
    provider: "fake",
    model: "writer",
    effort: "low",
    branch: "codeden/run-1/item-2",
    worktree: "/work/run-1/item-2",
    status: "waiting",
    dependsOn: ["item-1"],
    attempt: 1,
    checkpoint: {
      summary: "Implemented",
      nextSteps: "Resolve conflict",
      blocker: "Merge",
      updatedAt: 1,
    },
  };
  expect(TeamWorker.parse(JSON.parse(JSON.stringify(worker)))).toEqual(worker);
});
