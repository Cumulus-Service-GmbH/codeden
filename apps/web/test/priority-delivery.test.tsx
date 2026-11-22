// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PriorityDelivery } from "@/components/composer/priority-delivery";

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
