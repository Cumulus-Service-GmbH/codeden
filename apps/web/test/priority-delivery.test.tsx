// @vitest-environment jsdom
import { SessionOptions } from "@codeden/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  PriorityDelivery,
  PriorityDeliveryStatus,
  priorityDeliveryKey,
} from "@/components/composer/priority-delivery";
import { applyAgentEvent, emptyTranscript } from "@/lib/transcript/reducer";
import { FakeProvider } from "../../../packages/providers/src/fake/adapter";

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

it("shows the delivery status while a priority message waits on a running shell call in a Fake session", async () => {
  const session = await new FakeProvider().openSession(
    SessionOptions.parse({
      sessionId: "fake-session",
      role: "agent",
      cwd: ".",
      autonomy: "full",
    }),
  );
  const queryClient = new QueryClient();
  const sending = Promise.withResolvers<void>();
  let sent: Promise<void> | undefined;
  try {
    let transcript = emptyTranscript("fake-session");
    await session.send({ text: "[hold-shell]", attachments: [] });
    for await (const event of session.events) {
      transcript = applyAgentEvent(transcript, event);
      if (event.type === "turn.completed") break;
      if (
        event.type === "item.started" &&
        event.item.kind === "tool_call" &&
        event.item.toolKind === "command" &&
        event.item.command === "sleep 600"
      )
        break;
    }
    vi.useFakeTimers();
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: priorityDeliveryKey("fake-session"),
      mutationFn: () => sending.promise,
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PriorityDeliveryStatus sessionId="fake-session" transcript={transcript} />
      </QueryClientProvider>,
    );
    await act(async () => {
      sent = mutation.execute({ sendMode: "steer" });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status").textContent).toBe("delivering, waiting for tool call (0m)");
  } finally {
    sending.resolve();
    await sent;
    queryClient.clear();
    vi.useRealTimers();
    await session.close();
  }
});
