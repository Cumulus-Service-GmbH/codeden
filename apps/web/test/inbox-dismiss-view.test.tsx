import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNDO_MS } from "@/components/inbox/bulk-dismiss";
import { createMockClient } from "@/lib/api/mock";
import { startRealtime } from "@/lib/realtime";
import { InboxPage } from "@/routes/inbox";
import { renderWithClient } from "./utils";

/**
 * #407: "Dismiss N" in the inbox header dismisses the notices in the current view in one
 * request, after a confirmation that names what stays, with Undo in the toast. In the mock
 * world the open items are 6 notices (a PR ready, a spot-check, 2 failed runs, an audit result,
 * a message) and 5 that wait on the user (an approval, a question, a spec, setup commands, a
 * triage decision), plus one start conflict.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

afterEach(() => vi.clearAllMocks());

const NOTICES = [
  "ib-pr",
  "inbox:factory-spot-checks:p-storefront",
  "ib-failed-a11y",
  "ib-failed",
  "ib-audit",
  "inbox:automation-changed:project:p-storefront:nightly-notes",
];

const tab = async (name: RegExp) => fireEvent.click(await screen.findByRole("button", { name }));
const dismissButton = () => screen.queryByRole("button", { name: /^Dismiss \d+$/ });

describe("dismiss the inbox view (#407)", () => {
  it("counts what the active tab lists, and nothing that waits on the user", async () => {
    renderWithClient(<InboxPage />, createMockClient(), { withRouter: true });
    expect(await screen.findByRole("button", { name: "Dismiss 6" })).toBeTruthy();
    await tab(/^Problems/);
    expect(await screen.findByRole("button", { name: "Dismiss 2" })).toBeTruthy();
    await tab(/^Reviews/);
    expect(await screen.findByRole("button", { name: "Dismiss 4" })).toBeTruthy();
    // Everything under "Needs an answer" waits on the user: nothing to dismiss in bulk.
    await tab(/^Needs an answer/);
    await screen.findByText(/^Approvals/);
    expect(dismissButton()).toBeNull();
  });

  it("confirms what stays, dismisses in one request and undoes exactly that", async () => {
    const client = createMockClient();
    const dismiss = vi.spyOn(client, "dismissInbox");
    const restore = vi.spyOn(client, "restoreInbox");
    const { queryClient } = renderWithClient(<InboxPage />, client, { withRouter: true });
    const stop = startRealtime(client, queryClient);
    try {
      await screen.findByText("Conflicts · 1");
      fireEvent.click(await screen.findByRole("button", { name: "Dismiss 6" }));

      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText("Dismiss 6 notices?")).toBeTruthy();
      expect(dialog.textContent).toContain(
        "6 notices will be dismissed; 6 items that wait on you stay.",
      );
      const staying = within(dialog).getByTestId("dismiss-staying");
      for (const title of [
        "Already running: Run a security audit on Storefront",
        "Force push to codeden/fix-checkout-flake",
        "How should failed webhooks be retried?",
        "Approve the spec: Gift cards at checkout",
        "Setup commands changed in #57: run them?",
      ]) {
        expect(within(staying).getByText(title)).toBeTruthy();
      }
      expect(within(staying).getByText("and 1 more")).toBeTruthy();
      expect(dismiss).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss 6" }));
      await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
      expect([...(dismiss.mock.calls[0]?.[0] ?? [])].sort()).toEqual([...NOTICES].sort());

      // The notices' groups are gone (they show under "Recently resolved"); what waits on the
      // user is still listed.
      await waitFor(() => expect(screen.queryByText(/^Pull requests ready/)).toBeNull());
      for (const group of [/^Failed runs/, /^Spot-checks/, /^Automation results/, /^Messages/]) {
        expect(screen.queryByText(group)).toBeNull();
      }
      expect(screen.getByText("Approvals · 1")).toBeTruthy();
      expect(screen.getByText("Triage decisions · 1")).toBeTruthy();
      expect(screen.getByText("Conflicts · 1")).toBeTruthy();
      expect(dismissButton()).toBeNull();

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      const [message, opts] = toast.success.mock.calls[0] as [
        string,
        { action: { label: string; onClick: () => void }; duration: number },
      ];
      expect(message).toBe("Dismissed 6 notices");
      expect(opts.duration).toBe(UNDO_MS);
      expect(opts.action.label).toBe("Undo");

      opts.action.onClick();
      await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
      expect([...(restore.mock.calls[0]?.[0] ?? [])].sort()).toEqual([...NOTICES].sort());
      expect(await screen.findByText("Pull requests ready · 1")).toBeTruthy();
      expect(await screen.findByText("Failed runs · 2")).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Dismiss 6" })).toBeTruthy();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Restored 6 notices"));
      const snapshot = await client.getSnapshot();
      expect(
        snapshot.inbox.filter((i) => NOTICES.includes(i.id)).every((i) => i.status === "open"),
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it("dismisses nothing when the confirmation is cancelled", async () => {
    const client = createMockClient();
    const dismiss = vi.spyOn(client, "dismissInbox");
    renderWithClient(<InboxPage />, client, { withRouter: true });
    await tab(/^Problems/);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss 2" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("2 notices will be dismissed.");
    expect(within(dialog).queryByTestId("dismiss-staying")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(dismiss).not.toHaveBeenCalled();
  });
});
