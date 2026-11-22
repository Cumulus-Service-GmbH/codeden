import type { RunnerCommandOf } from "@codeden/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { deliverPriority } from "../src/services/sessions/priority-delivery";

afterEach(() => vi.useRealTimers());

it.each([true, false])(
  "waits for shell completion with cancellation capability %s",
  async (capable) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const shell = { itemId: "sleep", threadId: "thread", turnId: "turn", rootTurnId: "turn" };
    let wake = () => {};
    let active = true;
    const send = vi.fn(async (_request: Pick<RunnerCommandOf<"session.steer">, "interrupt">) =>
      active ? { waitingFor: shell } : {},
    );
    const unsubscribe = vi.fn();
    const delivered = deliverPriority(
      send,
      (listener) => {
        wake = listener;
        return unsubscribe;
      },
      capable ? 180_000 : undefined,
    );
    await vi.advanceTimersByTimeAsync(179_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(capable ? 2 : 1);
    if (capable)
      expect(send).toHaveBeenLastCalledWith({ interrupt: shell, expectedTurnId: "turn" });
    active = false;
    wake();
    await delivered;
    expect(send).toHaveBeenLastCalledWith({ expectedTurnId: "turn" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  },
);

it("stops waiting when the user stops the session", async () => {
  vi.useFakeTimers();
  const shell = { itemId: "sleep", threadId: "thread", turnId: "turn", rootTurnId: "turn" };
  const send = vi.fn(async () => ({ waitingFor: shell }));
  const controller = new AbortController();
  const unsubscribe = vi.fn();
  const delivered = deliverPriority(send, () => unsubscribe, 120_000, controller.signal);
  const cancelled = new Error("Stopped");
  const result = delivered.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort(cancelled);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(send).toHaveBeenCalledOnce();
  expect(await result).toBe(cancelled);
  expect(unsubscribe).toHaveBeenCalledOnce();
});
