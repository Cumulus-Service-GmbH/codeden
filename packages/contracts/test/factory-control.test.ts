import { expect, it } from "vitest";
import {
  controlTitle,
  FactoryControlRequest,
  FactoryHalt,
  FactoryLoop,
  FactoryLoopControl,
  haltLine,
  loopControlLine,
} from "../src";

const at = "2026-11-22T10:00:00.000Z";
const control = {
  action: "pause",
  by: "orchestrator",
  sessionId: "s1",
  reason: "CI is red on main",
  at,
} as const;

it("round-trips loop control and defaults a legacy loop to null", () => {
  const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));
  expect(FactoryLoopControl.parse(roundTrip(FactoryLoopControl.parse(control)))).toEqual(control);
  const request = FactoryControlRequest.parse({ projectId: "p1", reason: " CI is red on main " });
  expect(FactoryControlRequest.parse(roundTrip(request))).toEqual({
    projectId: "p1",
    reason: control.reason,
  });
  const base = {
    projectId: "p1",
    state: "idle",
    pausedReason: null,
    consecutiveFailures: 0,
    day: "2026-11-22",
    mergesToday: 0,
    lastDigestDay: null,
    enabledAt: null,
    lastTickAt: null,
    updatedAt: at,
  };
  expect(FactoryLoop.parse(base).lastControl).toBeNull();
  const loop = FactoryLoop.parse({ ...base, lastControl: control });
  expect(FactoryLoop.parse(roundTrip(loop))).toEqual(loop);
  expect(loop.lastControl).toEqual(control);
});

it("requires a nonblank reason of at most 500 characters from tools", () => {
  for (const reason of [undefined, "", "  ", "x".repeat(501)]) {
    expect(FactoryControlRequest.safeParse({ reason }).success).toBe(false);
  }
  expect(FactoryLoopControl.safeParse({ ...control, reason: " " }).success).toBe(false);
});

it("formats pause and stop attribution", () => {
  expect(loopControlLine(control)).toBe("Paused by orchestrator: CI is red on main");
  expect(loopControlLine({ ...control, by: "pm", action: "stop" })).toBe(
    "Stopped by PM: CI is red on main",
  );
  expect(loopControlLine({ ...control, by: "user", reason: null })).toBe("Paused by you");
  expect(loopControlLine({ ...control, action: "resume" })).toBeNull();
  expect(loopControlLine(null)).toBeNull();
});

it("round-trips halts and formats halt and resume attribution", () => {
  const builtin = { source: "builtin", reason: "daily budget reached ($5.00 of $5.00)" };
  expect(FactoryHalt.parse(JSON.parse(JSON.stringify(FactoryHalt.parse(builtin))))).toEqual(
    builtin,
  );
  expect(haltLine(FactoryHalt.parse(builtin))).toBe(
    "Halted (built-in): daily budget reached ($5.00 of $5.00)",
  );
  expect(haltLine({ source: "pm", reason: control.reason }, { ...control, by: "pm" })).toBe(
    "Paused by PM: CI is red on main",
  );
  expect(haltLine({ source: "orchestrator", reason: control.reason })).toBe(
    "Stopped by orchestrator: CI is red on main",
  );
  expect(haltLine({ source: "user", reason: null })).toBe("Stopped by you");
  expect(controlTitle(control)).toBe("Paused by orchestrator: CI is red on main");
  expect(controlTitle({ ...control, action: "stop" })).toBe(
    "Stopped by orchestrator: CI is red on main",
  );
  expect(controlTitle({ ...control, action: "resume" })).toBe(
    "Resumed by orchestrator: CI is red on main",
  );
});
