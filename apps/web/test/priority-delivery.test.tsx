// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  PriorityDelivery,
  PriorityDeliveryStatus,
  priorityDeliveryKey,
} from "@/components/composer/priority-delivery";
import { emptyTranscript } from "@/lib/transcript/reducer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("updates the waiting minutes live", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
  render(<PriorityDelivery submittedAt={Date.now()} />);
  expect(screen.getByRole("status").textContent).toBe("delivering, waiting for tool call (0m)");
  act(() => vi.advanceTimersByTime(120_000));
  expect(screen.getByRole("status").textContent).toBe("delivering, waiting for tool call (2m)");
});

it("shows live delivery minutes while a priority message waits on a running shell call", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
  const queryClient = new QueryClient();
  const transcript = emptyTranscript("s1");
  transcript.turns.turn = {
    id: "turn",
    threadId: "thread",
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };
  transcript.items.sleep = {
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
  };
  const sending = Promise.withResolvers<void>();
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: priorityDeliveryKey("s1"),
    mutationFn: () => sending.promise,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <PriorityDeliveryStatus sessionId="s1" transcript={transcript} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("status")).toBeNull();
  let sent: Promise<void> | undefined;
  try {
    await act(async () => {
      sent = mutation.execute({ sendMode: "steer" });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status").textContent).toBe("delivering, waiting for tool call (0m)");
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("status").textContent).toBe("delivering, waiting for tool call (1m)");
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("status").textContent).toBe("delivering, waiting for tool call (2m)");
  } finally {
    await act(async () => {
      sending.resolve();
      await sent;
      await vi.advanceTimersByTimeAsync(0);
    });
    queryClient.clear();
  }
  expect(screen.queryByRole("status")).toBeNull();
});
