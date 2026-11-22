import { z } from "zod";
import { Id, Timestamp } from "./common";

/** An explicit change to the factory loop. */
export const FactoryControlAction = z.enum(["pause", "resume", "stop"]);
/** An explicit change to the factory loop. */
export type FactoryControlAction = z.infer<typeof FactoryControlAction>;

/** Who requested a factory loop change. */
export const FactoryControlActor = z.enum(["user", "orchestrator", "pm"]);
/** Who requested a factory loop change. */
export type FactoryControlActor = z.infer<typeof FactoryControlActor>;

const Reason = z.string().trim().min(1).max(500);

/** The last explicit control and its attribution. */
export const FactoryLoopControl = z.object({
  action: FactoryControlAction,
  by: FactoryControlActor,
  sessionId: Id.nullable(),
  reason: Reason.nullable(),
  at: Timestamp,
});
/** The last explicit control and its attribution. */
export type FactoryLoopControl = z.infer<typeof FactoryLoopControl>;

/** The effective loop state reported to factory control callers. */
export const FactoryRunState = z.enum(["running", "paused", "draining", "stopped"]);
/** The effective loop state reported to factory control callers. */
export type FactoryRunState = z.infer<typeof FactoryRunState>;

/** A control request from an orchestrator or PM session. */
export const FactoryControlRequest = z.object({ projectId: Id.optional(), reason: Reason });
/** A control request from an orchestrator or PM session. */
export type FactoryControlRequest = z.infer<typeof FactoryControlRequest>;

/** The target of a factory status request. */
export const FactoryStatusRequest = z.object({ projectId: Id.optional() });
/** The target of a factory status request. */
export type FactoryStatusRequest = z.infer<typeof FactoryStatusRequest>;

/** User-facing attribution for a pause or stop. */
export function loopControlLine(control: FactoryLoopControl | null): string | null {
  if (!control || control.action === "resume") return null;
  const verb = control.action === "pause" ? "Paused" : "Stopped";
  const who = { user: "you", orchestrator: "orchestrator", pm: "PM" }[control.by];
  return `${verb} by ${who}${control.reason ? `: ${control.reason}` : ""}`;
}
