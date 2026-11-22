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

/** What halted the factory loop. */
export const FactoryHaltSource = z.enum(["builtin", "pm", "orchestrator", "user"]);
/** What halted the factory loop. */
export type FactoryHaltSource = z.infer<typeof FactoryHaltSource>;

/** The source and reason of the current halt. */
export const FactoryHalt = z.object({ source: FactoryHaltSource, reason: z.string().nullable() });
/** The source and reason of the current halt. */
export type FactoryHalt = z.infer<typeof FactoryHalt>;

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

/** Title for an explicit control action in the inbox history. */
export function controlTitle({
  action,
  by,
  reason,
}: Pick<FactoryLoopControl, "action" | "by" | "reason">): string {
  const verb = { pause: "Paused", stop: "Stopped", resume: "Resumed" }[action];
  const who = { user: "you", orchestrator: "orchestrator", pm: "PM" }[by];
  return `${verb} by ${who}${reason ? `: ${reason}` : ""}`;
}

/** User-facing attribution for a pause or stop. */
export function loopControlLine(control: FactoryLoopControl | null): string | null {
  return control && control.action !== "resume" ? controlTitle(control) : null;
}

/** Format a current halt, using the explicit control to distinguish pause from stop. */
export function haltLine(
  halt: FactoryHalt | null,
  control?: FactoryLoopControl | null,
): string | null {
  if (!halt) return null;
  const { source, reason } = halt;
  if (source === "builtin") return `Halted (built-in)${reason ? `: ${reason}` : ""}`;
  const matching = control?.by === source && control.reason === reason;
  const action = matching ? control.action : source === "pm" ? "pause" : "stop";
  return controlTitle({ action: action === "resume" ? "stop" : action, by: source, reason });
}
