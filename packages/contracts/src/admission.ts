import { z } from "zod";
import { Id, Timestamp } from "./common";

/** Operation waiting for an agent slot. */
export const AdmissionWaitKind = z.enum(["start", "turn", "checks"]);
export type AdmissionWaitKind = z.infer<typeof AdmissionWaitKind>;

/** A queued operation and its one-based position in the global line. */
export const AdmissionWaiter = z.object({
  sessionId: Id,
  kind: AdmissionWaitKind,
  since: Timestamp,
  place: z.int().positive(),
});
export type AdmissionWaiter = z.infer<typeof AdmissionWaiter>;

/** Global slot counts and waiting operations returned by GET /api/sessions/admission. */
export const AdmissionStatus = z.object({
  limit: z.int().positive(),
  active: z.int().nonnegative(),
  control: z.int().nonnegative(),
  waiting: z.array(AdmissionWaiter),
});
export type AdmissionStatus = z.infer<typeof AdmissionStatus>;

/** Error code for an operation that requires an agent slot immediately. */
export const AT_CAPACITY_CODE = "at_capacity";
