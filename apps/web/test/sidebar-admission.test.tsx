import { screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SessionRow } from "@/components/shell/sidebar/session-row";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

it("marks admission waiters without marking sessions queued behind matching work", async () => {
  const client = createMockClient();
  const { sessions } = await client.getSnapshot();
  const [first, second] = sessions.filter((session) => session.role === "agent");
  if (!first || !second) throw new Error("Expected two mock sessions");
  vi.spyOn(client.sessions, "admission").mockResolvedValue({
    limit: 4,
    active: 4,
    control: 0,
    waiting: [{ sessionId: first.id, kind: "start", since: first.updatedAt, place: 1 }],
  });
  renderWithClient(
    <>
      <SessionRow session={{ ...first, status: "queued", title: "Waiting for a slot" }} />
      <SessionRow session={{ ...second, status: "queued", title: "Waiting for matching work" }} />
    </>,
    client,
    { withRouter: true },
  );

  const waiter = await screen.findByRole("link", { name: /Waiting for a slot/ });
  const matching = screen.getByRole("link", { name: /Waiting for matching work/ });
  await waitFor(() => expect(waiter.textContent).toContain("Queued · #1"));
  expect(matching.textContent).not.toContain("Queued · #");
});
