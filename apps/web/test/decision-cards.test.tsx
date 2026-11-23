import type { DecisionCard } from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChecklistSidebar } from "@/components/checklist/checklist-sidebar";
import { createMockClient } from "@/lib/api/mock";
import { InboxPage } from "@/routes/inbox";
import { useLayoutStore } from "@/stores/layout";
import { renderWithClient } from "./utils";

const headSha = "a".repeat(40);
const card: DecisionCard = {
  id: "approval-card",
  projectId: "p-storefront",
  sessionId: "pm",
  requestedBy: "pm",
  request: {
    kind: "github",
    target: { kind: "merge_verify", repository: "acme/widgets", pullNumber: 10, headSha },
  },
};

afterEach(() => useLayoutStore.setState(useLayoutStore.getInitialState()));

function clientWithCard() {
  const client = createMockClient();
  vi.spyOn(client.github, "decisionCards").mockResolvedValue([card]);
  return client;
}

it("shows a GitHub approval card in the inbox", async () => {
  const client = clientWithCard();
  const approve = vi.spyOn(client.github, "approveDecisionCard").mockResolvedValue();
  renderWithClient(<InboxPage />, client, { withRouter: true });

  fireEvent.click(await screen.findByRole("button", { name: /^Needs an answer/ }));
  const cards = within(await screen.findByRole("region", { name: "Approval cards" }));
  expect(cards.getByRole("heading", { name: "Approve pull request review" })).toBeTruthy();
  expect(cards.getByText("acme/widgets")).toBeTruthy();
  expect(cards.getByText("Pull request #10")).toBeTruthy();
  expect(cards.getByText(headSha)).toBeTruthy();
  expect(approve).not.toHaveBeenCalled();

  fireEvent.click(cards.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(approve).toHaveBeenCalledExactlyOnceWith(card.id));
});

it("shows a GitHub approval card in the checklist sidebar", async () => {
  useLayoutStore.setState({
    checklistOpen: true,
    checklistPinned: true,
    checklistCollapsed: false,
  });
  renderWithClient(<ChecklistSidebar />, clientWithCard(), { withRouter: true });

  const sidebar = within(await screen.findByTestId("checklist-sidebar"));
  const cards = within(await sidebar.findByRole("region", { name: "Approval cards" }));
  expect(cards.getByRole("heading", { name: "Approve pull request review" })).toBeTruthy();
  expect(cards.getByText("acme/widgets")).toBeTruthy();
  expect(cards.getByText("Pull request #10")).toBeTruthy();
  expect(cards.getByText(headSha)).toBeTruthy();
  expect(cards.getByRole("button", { name: "Approve" })).toBeTruthy();
});
