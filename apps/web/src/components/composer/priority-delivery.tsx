import { isShellCall } from "@codeden/contracts";
import { useMutationState } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { TranscriptState } from "@/lib/transcript/reducer";

export const priorityDeliveryKey = (sessionId: string) => ["priority-delivery", sessionId];

export function PriorityDelivery({ submittedAt }: { submittedAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const now = Date.now();
      setNow(now);
      const elapsed = Math.max(0, now - submittedAt);
      const next = submittedAt + (Math.floor(elapsed / 60_000) + 1) * 60_000;
      timer = setTimeout(update, Math.max(0, next - now));
    };
    update();
    return () => clearTimeout(timer);
  }, [submittedAt]);
  return (
    <div
      role="status"
      className="mx-auto w-full max-w-[46rem] px-6 pb-2 text-xs text-muted-foreground"
    >
      delivering, waiting for tool call ({Math.max(0, Math.floor((now - submittedAt) / 60_000))}m)
    </div>
  );
}

export function PriorityDeliveryStatus({
  sessionId,
  transcript,
}: {
  sessionId: string;
  transcript?: TranscriptState | null;
}) {
  const pending = useMutationState({
    filters: {
      mutationKey: priorityDeliveryKey(sessionId),
      status: "pending",
      exact: true,
      predicate: ({ state }) =>
        state.variables === undefined ||
        (state.variables as { sendMode?: string }).sendMode === "steer",
    },
    select: (mutation) => mutation.state.submittedAt,
  });
  const submittedAt = pending[0];
  if (submittedAt === undefined || !transcript) return null;
  const shellRunning = Object.values(transcript.items).some(
    ({ item, turnId }) =>
      isShellCall(item) &&
      item.status === "in_progress" &&
      transcript.turns[turnId]?.status === "running",
  );
  return shellRunning ? <PriorityDelivery key={submittedAt} submittedAt={submittedAt} /> : null;
}
