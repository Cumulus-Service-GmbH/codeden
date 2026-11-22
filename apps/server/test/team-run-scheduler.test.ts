import type { ProjectTeams, TeamWorker } from "@codeden/contracts";
import { expect, it } from "vitest";
import { eligibleAssignments, resolveRunTeam } from "../src/services/sessions/team-run-scheduler";

function worker(itemId: string, overrides: Partial<TeamWorker> = {}): TeamWorker {
  return {
    itemId,
    provider: "fake",
    model: null,
    effort: null,
    sessionId: null,
    branch: null,
    worktree: null,
    status: "queued",
    attempt: 0,
    dependsOn: [],
    checkpoint: null,
    ...overrides,
  };
}

it("bounds dispatch by both caps and waits for completed dependencies", () => {
  const workers = [
    worker("active", { status: "running" }),
    worker("blocked", { dependsOn: ["active"] }),
    worker("ready"),
    worker("ready-too"),
  ];
  expect(eligibleAssignments(workers, { maxParallel: 3, maxRounds: 2 }, 1)).toEqual(["ready"]);
  expect(eligibleAssignments(workers, { maxParallel: 1, maxRounds: 2 }, 3)).toEqual([]);
  const completed = worker("active", { status: "completed" });
  expect(
    eligibleAssignments([completed, ...workers.slice(1)], { maxParallel: 1, maxRounds: 2 }, 3),
  ).toEqual(["blocked"]);
});

it("retries failed assignments only while attempts remain", () => {
  const workers = [
    worker("retry", { status: "failed", attempt: 1 }),
    worker("exhausted", { status: "failed", attempt: 2 }),
    worker("conflict", { status: "waiting", attempt: 1 }),
    worker("stopped", { status: "stopped", attempt: 1 }),
  ];
  expect(eligibleAssignments(workers, { maxParallel: 4, maxRounds: 2 }, 4)).toEqual(["retry"]);
});

it("resolves each named Team with its own Architect, Writer and caps", () => {
  const teams: ProjectTeams = {
    defaultTeamId: "build",
    teams: ["build", "release"].map((id, index) => ({
      id,
      name: id,
      team: (["architect", "writer"] as const).map((role) => ({
        role,
        provider: "fake",
        model: `${id}-${role}`,
        effort: "low",
      })),
      limits: { maxParallel: index + 1, maxRounds: 2, maxAssignments: 3 },
    })),
  };
  const defaults = [{ role: "writer", provider: "fake", model: "global", effort: null }] as const;
  expect(resolveRunTeam(teams, undefined, defaults)).toMatchObject({
    id: "build",
    limits: { maxParallel: 1 },
    team: [{ model: "build-architect" }, { model: "build-writer" }],
  });
  expect(resolveRunTeam(teams, "release", defaults)).toMatchObject({
    id: "release",
    limits: { maxParallel: 2 },
    team: [{ model: "release-architect" }, { model: "release-writer" }],
  });
  expect(() => resolveRunTeam(teams, "unknown", defaults)).toThrow("Unknown Team");
});
