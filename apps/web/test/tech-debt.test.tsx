import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TechDebtBadge } from "@/components/project/tech-debt-badge";
import { TechDebtPanel } from "@/components/project/tech-debt-panel";
import { Sidebar } from "@/components/shell/sidebar/sidebar";
import { createMockClient } from "@/lib/api/mock";
import { snapshotKey } from "@/lib/queries";
import { router } from "@/router";
import { TechDebtPage } from "@/routes/tech-debt";
import { renderWithClient } from "./utils";

it("offers a fix retry only after the prior fix session stops", async () => {
  const client = createMockClient();
  const snapshot = await client.getSnapshot();
  const fixture = snapshot.sessions.find((session) => session.projectId !== null);
  if (!fixture?.projectId) throw new Error("Expected a project session");
  const session = { ...fixture, projectId: fixture.projectId, status: "running" as const };
  client.getSnapshot = async () => ({ ...snapshot, sessions: [session] });
  const view = {
    projectId: session.projectId,
    issue: null,
    imported: false,
    findings: [
      {
        id: "finding",
        location: "src/file.ts:1",
        text: "Reuse the helper",
        sessionId: session.id,
        status: "in_progress" as const,
        date: snapshot.generatedAt,
        receipt: null,
        pr: null,
        reason: null,
        source: null,
      },
    ],
  };
  vi.spyOn(client.techDebt, "list").mockResolvedValue(view);
  const fix = vi.spyOn(client.techDebt, "act").mockResolvedValue(view);
  const { queryClient } = renderWithClient(
    <TechDebtPanel projectId={session.projectId} />,
    client,
    { withRouter: true },
  );
  await screen.findByText("Reuse the helper");
  expect(screen.queryByRole("button", { name: "Retry fix" })).toBeNull();

  act(() => {
    queryClient.setQueryData(snapshotKey, {
      ...snapshot,
      sessions: [{ ...session, status: "stopped" }],
    });
  });
  fireEvent.click(await screen.findByRole("button", { name: "Retry fix" }));
  await waitFor(() =>
    expect(fix).toHaveBeenCalledWith(session.projectId, { action: "fix", ids: ["finding"] }),
  );
});

it("hides zero and labels the open tech debt count", () => {
  const { container, rerender } = renderWithClient(<TechDebtBadge count={0} />);
  expect(container.childElementCount).toBe(0);
  rerender(<TechDebtBadge count={3} />);
  expect(screen.getByLabelText("3 open tech debt").textContent).toBe("3");
});

it("shows project counts, a persisted error and links to each ledger", async () => {
  const client = createMockClient();
  const { projects } = await client.getSnapshot();
  const [first, second] = projects.filter((project) => !project.archivedAt);
  if (!first || !second) throw new Error("Expected two mock projects");
  vi.spyOn(client.techDebt, "summaries").mockResolvedValue([
    { projectId: first.id, open: 3 },
    { projectId: second.id, open: 0, importError: "Issue unavailable" },
  ]);
  renderWithClient(<TechDebtPage />, client, { withRouter: true });
  expect((await screen.findByLabelText("3 open tech debt")).textContent).toBe("3");
  const secondRow = within(screen.getByRole("link", { name: new RegExp(second.name) }));
  expect(secondRow.getByLabelText("0 open tech debt").textContent).toBe("0");
  expect(secondRow.getByText("Issue unavailable")).toBeTruthy();
  expect(screen.getByRole("link", { name: new RegExp(first.name) }).getAttribute("href")).toBe(
    `/projects/${first.id}?tab=tech_debt`,
  );
});

it("links to Tech debt from the sidebar", async () => {
  renderWithClient(<Sidebar width={240} />, createMockClient(), { withRouter: true });
  expect((await screen.findByRole("link", { name: "Tech debt" })).getAttribute("href")).toBe(
    "/tech-debt",
  );
});

it.each(["tech_debt", "tech-debt"])("opens the project ledger for tab=%s", (tab) => {
  const match = router
    .matchRoutes("/projects/project-1", { tab })
    .find((route) => route.routeId === "/shell/projects/$projectId");
  expect(match?.search).toMatchObject({ tab: "tech-debt" });
});
