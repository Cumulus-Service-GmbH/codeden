import { screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TechDebtBadge } from "@/components/project/tech-debt-badge";
import { TechDebtPanel } from "@/components/project/tech-debt-panel";
import { Sidebar } from "@/components/shell/sidebar/sidebar";
import { createMockClient } from "@/lib/api/mock";
import { router } from "@/router";
import { TechDebtPage } from "@/routes/tech-debt";
import { renderWithClient } from "./utils";

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

it("shows status, reason and resolution receipt in the project ledger", async () => {
  const client = createMockClient();
  vi.spyOn(client.techDebt, "list").mockResolvedValue({
    projectId: "project-1",
    issue: null,
    imported: false,
    findings: [
      {
        id: "f",
        location: "src/file.ts:2",
        text: "Reuse the helper.",
        source: null,
        date: "2026-11-23T00:00:00.000Z",
        pr: null,
        sessionId: null,
        status: "dismissed",
        reason: "Covered elsewhere.",
        receipt: "review-1",
        resolutionReceipt: "resolution-1",
      },
    ],
  });
  renderWithClient(<TechDebtPanel projectId="project-1" />, client);
  expect(await screen.findByText("Dismissed")).toBeTruthy();
  expect(screen.getByText("Covered elsewhere.")).toBeTruthy();
  expect(screen.getByText("Resolution receipt resolution-1")).toBeTruthy();
  expect(screen.getByText("Receipt review-1")).toBeTruthy();
});
