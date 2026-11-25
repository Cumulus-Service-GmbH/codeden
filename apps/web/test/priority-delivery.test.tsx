// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionComposer } from "@/components/composer/composer";
import { PriorityDelivery, PriorityDeliveryStatus } from "@/components/composer/priority-delivery";
import { createMockClient } from "@/lib/api/mock";
import { emptyTranscript } from "@/lib/transcript/reducer";
import { renderWithClient } from "./utils";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("updates the waiting minutes live", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
  render(<PriorityDelivery submittedAt={Date.now()} />);
  expect(screen.getByRole("status").textContent).toBe("delivering, waiting for tool call (0m)");
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("status").textContent).toBe("delivering, waiting for tool call (1m)");
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("status").textContent).toBe("delivering, waiting for tool call (2m)");
});

it("shows a pending composer steer only while a shell call is running", async () => {
  const client = createMockClient();
  const fixture = (await client.getSnapshot()).sessions.find(
    (session) => session.role === "agent" && session.provider === "claude",
  );
  if (!fixture) throw new Error("Expected a steer-capable session");
  const session = { ...fixture, id: "priority-test" };
  const sending = Promise.withResolvers<void>();
  const sendMessage = vi.spyOn(client, "sendMessage").mockReturnValue(sending.promise);
  const unblocked = emptyTranscript(session.id);
  unblocked.turns.turn = {
    id: "turn",
    threadId: "thread",
    status: "running",
    startedAt: "2026-11-23T10:00:00Z",
    completedAt: null,
    error: null,
  };
  const blocked = {
    ...unblocked,
    items: {
      sleep: {
        turnId: "turn",
        threadId: "thread",
        item: {
          id: "sleep",
          kind: "tool_call",
          toolKind: "command",
          toolName: "shell",
          command: "sleep 600",
          status: "in_progress",
        },
      },
    },
  } satisfies typeof unblocked;
  renderWithClient(
    <>
      <SessionComposer session={session} running />
      <section aria-label="With a running shell call">
        <PriorityDeliveryStatus sessionId={session.id} transcript={blocked} />
      </section>
      <section aria-label="Without a running shell call">
        <PriorityDeliveryStatus sessionId={session.id} transcript={unblocked} />
      </section>
    </>,
    client,
    { withRouter: true },
  );
  const shell = within(await screen.findByRole("region", { name: "With a running shell call" }));
  const noShell = within(screen.getByRole("region", { name: "Without a running shell call" }));
  expect(shell.queryByRole("status")).toBeNull();
  expect(noShell.queryByRole("status")).toBeNull();

  try {
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Priority follow-up" } });
    fireEvent.click(await screen.findByRole("button", { name: /^steer$/i }));
    fireEvent.click(screen.getByRole("button", { name: "steer message" }));
    expect((await shell.findByRole("status")).textContent).toBe(
      "delivering, waiting for tool call (0m)",
    );
    expect(sendMessage).toHaveBeenCalledWith(
      session.id,
      { text: "Priority follow-up", attachments: [] },
      "steer",
      expect.any(String),
    );
    expect(noShell.queryByRole("status")).toBeNull();
  } finally {
    await act(async () => {
      sending.resolve();
      await sending.promise;
    });
  }
  await waitFor(() => expect(shell.queryByRole("status")).toBeNull());
});
