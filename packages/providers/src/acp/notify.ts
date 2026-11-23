/**
 * Call an adapter's observer (a handshake or setup report) now, so reports keep their arrival
 * order, and keep its failure, thrown or a later rejection, out of the session or probe.
 */
export function notify(observer: () => unknown): void {
  try {
    Promise.resolve(observer()).catch(() => undefined);
  } catch {
    // The adapter's bookkeeping failed; what the agent answered is unchanged.
  }
}
