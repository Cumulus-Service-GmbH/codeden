import { TeamRun } from "@codeden/contracts";
import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TeamRunProgress, TeamWorkers } from "@/components/workbench/team-workers";

const snapshot = vi.hoisted(() => ({ teamRuns: [] as TeamRun[] }));
vi.mock("@/lib/queries", () => ({ useSnapshot: () => ({ data: snapshot }) }));

it("shows the same projected round, step, Arbiter and Jev result in both Team views", () => {
  const run = TeamRun.parse({
    id: "run",
    projectId: "project",
    teamId: "build",
    teamName: "Build",
    team: [],
    limits: { maxParallel: 1, maxAssignments: 1, maxRounds: 3 },
    revision: "approved",
    assembler: "team/assembler",
    coordinatorId: "architect",
    status: "waiting",
    notice: null,
    items: [{ id: "one", text: "Implement checklist", dependsOn: [] }],
    workers: [
      {
        itemId: "one",
        sessionId: "writer",
        provider: "fake",
        model: "writer",
        effort: "low",
        branch: "team/assignment",
        worktree: "/work/assignment",
        status: "waiting",
        dependsOn: [],
        attempt: 2,
        checkpoint: null,
        step: "Jev",
        arbiter: { verdict: "FIX REQUIRED", reason: "Cover the failure" },
        jev: {
          status: "owner decision",
          receipt: {
            head: "a".repeat(40),
            historyPath: "/history",
            historySha256: "b".repeat(64),
            scores: { met_0: 0.2 },
          },
        },
      },
    ],
  });
  snapshot.teamRuns = [run];
  render(
    <>
      <TeamWorkers sessionId="architect" />
      <TeamRunProgress run={run} />
    </>,
  );
  for (const label of ["Build workers", "Build progress"]) {
    const view = within(screen.getByRole("region", { name: label }));
    expect(view.getByText(/Round 2\/3/).textContent).toContain("FIX REQUIRED");
    expect(view.getByText("Jev owner decision")).toBeTruthy();
    expect(view.getByText("b".repeat(64))).toBeTruthy();
    expect(view.getByText("0.2")).toBeTruthy();
  }
  expect(screen.getByText("writer")).toBeTruthy();
});
