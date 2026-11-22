import type { RunnerCommandOf, RunnerCommandResult } from "@codeden/contracts";

type Attempt = Pick<RunnerCommandOf<"session.steer">, "expectedTurnId" | "interrupt">;
type Result = RunnerCommandResult<"session.steer">;

/** Wait for runner events while keeping each RPC short and targeting the same turn. */
export async function deliverPriority(
  send: (attempt: Attempt) => Promise<Result>,
  subscribe: (wake: () => void) => () => void,
  delayMs?: number,
  signal?: AbortSignal,
): Promise<void> {
  let changed = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    changed = true;
    wake?.();
  };
  const unsubscribe = subscribe(notify);
  signal?.addEventListener("abort", notify, { once: true });
  let call: Result["waitingFor"];
  let deadline = Infinity;
  let expectedTurnId: string | undefined;
  try {
    for (;;) {
      signal?.throwIfAborted();
      changed = false;
      const interrupt = Date.now() >= deadline ? call : undefined;
      if (interrupt) deadline = Infinity;
      const { waitingFor } =
        (await send({
          ...(expectedTurnId ? { expectedTurnId } : {}),
          ...(interrupt ? { interrupt } : {}),
        }).catch((error) => {
          signal?.throwIfAborted();
          throw error;
        })) ?? {};
      if (!waitingFor) return;
      signal?.throwIfAborted();
      expectedTurnId = waitingFor.rootTurnId;
      if (JSON.stringify(call) !== JSON.stringify(waitingFor)) {
        call = waitingFor;
        deadline = delayMs === undefined ? Infinity : Date.now() + delayMs;
      }
      if (changed) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (Number.isFinite(deadline))
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      });
      clearTimeout(timer);
      wake = undefined;
    }
  } finally {
    signal?.removeEventListener("abort", notify);
    unsubscribe();
  }
}
