import { ReviewPolicy } from "@codeden/contracts";
import { act, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PipelineDiagram } from "@/components/factory/pipeline-diagram";
import { ChildRuns } from "@/components/workbench/child-runs";
import { createMockClient } from "@/lib/api/mock";
import { factoryKeys } from "@/lib/factory";
import { renderWithClient } from "./utils";

async function arbiterFixture() {
  const client = createMockClient();
  const projectId = "p-storefront";
  const status = await client.factory.status(projectId);
  const [work] = status.inProgress;
  const [session] = (await client.getSnapshot()).sessions;
  if (!work?.issue || !session) throw new Error("Expected factory work and a session in the demo");
  const item = {
    ...work,
    issue: work.issue,
    type: "bug" as const,
    step: "arbiter" as const,
    sessionId: session.id,
    reviewRound: 2,
    arbitration: { head: "a".repeat(40), state: "running" as const },
  };
  return {
    client,
    session: { ...session, projectId, startedBy: { kind: "pm" as const, id: "factory" } },
    item,
    status: {
      ...status,
      inProgress: [item],
      tuning: { ...status.tuning, reviewPolicy: ReviewPolicy.parse({}) },
    },
  };
}

it("shows the review round, live Arbiter status, and ruling in the workers pane", async () => {
  const { client, session, item, status } = await arbiterFixture();
  vi.spyOn(client.factory, "status").mockResolvedValue(status);
  const { queryClient } = renderWithClient(<ChildRuns session={session} />, client);
  const workers = within(await screen.findByRole("region", { name: "Workers" }));
  expect(workers.getByText("Review round 2/2")).toBeTruthy();
  expect(
    workers.getByText((_, node) => node?.textContent === "Arbiter · Running", { selector: "p" }),
  ).toBeTruthy();

  const ruling = "The retry must preserve queued work.";
  act(() => {
    queryClient.setQueryData(factoryKeys.status(status.projectId), {
      ...status,
      inProgress: [{ ...item, arbitration: { ...item.arbitration, state: "ruling", ruling } }],
    });
  });
  expect(
    await workers.findByText(
      (_, node) => node?.textContent === "Arbiter · Waiting for reviewer confirmation",
      { selector: "p" },
    ),
  ).toBeTruthy();
  expect(workers.getByText(ruling)).toBeTruthy();
});

it("flags work past 2 rounds in the workers pane", async () => {
  const { client, session, item, status } = await arbiterFixture();
  vi.spyOn(client.factory, "status").mockResolvedValue(status);
  const { queryClient } = renderWithClient(<ChildRuns session={session} />, client);
  const workers = within(await screen.findByRole("region", { name: "Workers" }));
  expect(workers.queryByText("Past two review rounds")).toBeNull();

  act(() => {
    queryClient.setQueryData(factoryKeys.status(status.projectId), {
      ...status,
      inProgress: [{ ...item, reviewRound: 3 }],
      tuning: {
        ...status.tuning,
        reviewPolicy: ReviewPolicy.parse({ reviewerRounds: 4, totalRounds: 3 }),
      },
    });
  });
  expect(await workers.findByText("Review round 3/3")).toBeTruthy();
  expect(workers.getByText("Past two review rounds")).toBeTruthy();
});

it("places disputed work on the Arbiter step in the pipeline diagram", async () => {
  const { client, status, item } = await arbiterFixture();
  renderWithClient(<PipelineDiagram f={status} />, client, { withRouter: true });
  const diagram = within(await screen.findByTestId("pipeline-diagram"));
  const steps = diagram.getAllByTestId("pipeline-node");
  const arbiterSteps = steps.filter((step) => step.dataset.node === "Arbiter");
  expect(arbiterSteps).toHaveLength(3);
  const chip = diagram.getByRole("button", { name: `#${item.issue.number}` });
  expect(chip.closest('[data-node="Arbiter"]')).toBe(arbiterSteps[0]);
});
