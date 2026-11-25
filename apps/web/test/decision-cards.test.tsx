import type { DecisionCard } from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChecklistSidebar } from "@/components/checklist/checklist-sidebar";
import { Sidebar } from "@/components/shell/sidebar/sidebar";
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

it("counts a waiting decision on the sidebar Inbox badge", async () => {
  const client = clientWithCard();
  const snap = await client.getSnapshot();
  vi.spyOn(client, "getSnapshot").mockResolvedValue({ ...snap, inbox: [] });
  renderWithClient(<Sidebar width={240} />, client, { withRouter: true });
  const nav = await screen.findByRole("link", { name: /^Inbox/ });
  expect(await within(nav).findByText("1")).toBeTruthy();
});

it("shows a GitHub approval card in the inbox", async () => {
  const client = clientWithCard();
  const approve = vi.spyOn(client.github, "approveDecisionCard").mockResolvedValue();
  renderWithClient(<InboxPage />, client, { withRouter: true });

  const defaultCards = within(await screen.findByRole("region", { name: "Approval cards" }));
  expect(defaultCards.getByRole("heading", { name: "Approve pull request" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: /^Needs an answer/ }));
  const cards = within(await screen.findByRole("region", { name: "Approval cards" }));
  expect(cards.getByRole("heading", { name: "Approve pull request" })).toBeTruthy();
  expect(cards.getByText("acme/widgets")).toBeTruthy();
  expect(cards.getByText("Pull request #10")).toBeTruthy();
  expect(cards.getByText(headSha)).toBeTruthy();
  expect(approve).not.toHaveBeenCalled();

  const button = cards.getByRole<HTMLButtonElement>("button", { name: "Approve" });
  expect(button.disabled).toBe(true);
  const message = cards.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Approval message for the pull request",
  });
  fireEvent.change(message, { target: { value: 'Ship "this" head.' } });
  expect(button.disabled).toBe(true);
  expect(message.required).toBe(true);
  const help = cards.getByText(
    "Use 1–200 characters. ASCII letters, digits, spaces and .,:;!?'()/- are allowed.",
  );
  expect(message.getAttribute("aria-describedby")).toBe(help.id);

  const ownerWords = "  Ship this head, please!  ";
  fireEvent.change(message, { target: { value: ownerWords } });
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(approve).toHaveBeenCalledExactlyOnceWith(card.id, { ownerWords }));
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
  expect(cards.getByRole("heading", { name: "Approve pull request" })).toBeTruthy();
  expect(cards.getByText("acme/widgets")).toBeTruthy();
  expect(cards.getByText("Pull request #10")).toBeTruthy();
  expect(cards.getByText(headSha)).toBeTruthy();
  expect(cards.getByRole("button", { name: "Approve" })).toBeTruthy();
});
