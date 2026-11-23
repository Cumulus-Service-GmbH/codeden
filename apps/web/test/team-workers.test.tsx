import { TeamRun } from "@codeden/contracts";
import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChecklistSidebar } from "@/components/checklist/checklist-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TeamRunProgress, TeamWorkers } from "@/components/workbench/team-workers";

import { useLayoutStore } from "@/stores/layout";

const snapshot = vi.hoisted(() => ({ projects: [], teamRuns: [] as TeamRun[] }));
vi.mock("@/lib/queries", () => ({ useSnapshot: () => ({ data: snapshot }) }));

afterEach(() => {
  snapshot.teamRuns = [];
  useLayoutStore.setState(useLayoutStore.getInitialState());
});

function buildRun() {
  return TeamRun.parse({
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
}

function releaseRun(): TeamRun {
  const run = buildRun();
  return {
    ...run,
    id: "release-run",
    teamId: "release",
    teamName: "Release",
    coordinatorId: "release-architect",
    items: [{ id: "publish", text: "Prepare release", dependsOn: [] }],
    workers: run.workers.map((worker) => ({
      ...worker,
      itemId: "publish",
      sessionId: "release-writer",
      status: "completed",
      step: "merge",
      attempt: 1,
      arbiter: { verdict: "DOWNGRADE TO LOW", reason: "No blocking findings" },
      jev: { status: "pass" },
    })),
  };
}

it("shows the same projected round, step, Arbiter and Jev result in both Team views", () => {
  const run = buildRun();
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

it("groups workers under their Team in the workers pane with step, round, Arbiter ruling and check result", () => {
  snapshot.teamRuns = [buildRun(), releaseRun()];
  const { rerender } = render(<TeamWorkers sessionId="architect" />);
  const build = within(screen.getByRole("region", { name: "Build workers" }));
  const buildWorker = within(build.getByRole("listitem"));
  expect(
    buildWorker.getByText("Implement checklist · waiting · Jev · FIX REQUIRED · Round 2/3"),
  ).toBeTruthy();
  expect(buildWorker.getByText("Jev owner decision")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Release workers" })).toBeNull();

  rerender(<TeamWorkers sessionId="release-architect" />);
  const release = within(screen.getByRole("region", { name: "Release workers" }));
  const releaseWorker = within(release.getByRole("listitem"));
  expect(
    releaseWorker.getByText("Prepare release · completed · merge · DOWNGRADE TO LOW · Round 1/3"),
  ).toBeTruthy();
  expect(releaseWorker.getByText("· Jev pass")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Build workers" })).toBeNull();
});

it("shows each Team's progress in the checklist sidebar", () => {
  snapshot.teamRuns = [buildRun(), releaseRun()];
  useLayoutStore.getState().toggleChecklist(true);
  render(
    <TooltipProvider>
      <ChecklistSidebar />
    </TooltipProvider>,
  );

  const sidebar = within(screen.getByTestId("checklist-sidebar"));
  const build = within(sidebar.getByRole("region", { name: "Build progress" }));
  expect(build.getByRole("heading", { name: "Build · 0/1" })).toBeTruthy();
  expect(build.getByText("Implement checklist", { selector: "p" })).toBeTruthy();
  expect(build.getByRole("listitem").textContent).toContain("[~] Implement checklist");

  const release = within(sidebar.getByRole("region", { name: "Release progress" }));
  expect(release.getByRole("heading", { name: "Release · 1/1" })).toBeTruthy();
  expect(release.getByRole("listitem").textContent).toContain("[x] Prepare release");
});
