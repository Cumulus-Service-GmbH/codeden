import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { admissionKey, useAdmission } from "@/lib/queries";
import { onLiveEvent } from "@/lib/realtime";
import { cn } from "@/lib/utils";

export function SlotMeter() {
  const { data } = useAdmission();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      onLiveEvent((event) => {
        if (
          event.type === "session.created" ||
          event.type === "session.updated" ||
          event.type === "settings.updated"
        ) {
          void queryClient.invalidateQueries({ queryKey: admissionKey }, { cancelRefetch: false });
        }
      }),
    [queryClient],
  );
  if (!data) return null;

  const { active, limit, waiting, control } = data;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 py-1 text-left text-3xs text-muted-foreground"
        >
          {limit <= 16 && (
            <span aria-hidden className="flex gap-0.5">
              {Array.from({ length: limit }, (_, slot) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: Slots never reorder.
                  key={slot}
                  className={cn(
                    "h-1.5 w-1 rounded-sm",
                    slot < active ? "bg-status-running" : "bg-muted",
                  )}
                />
              ))}
            </span>
          )}
          <span>
            {active} of {limit} agents
          </span>
          {waiting.length > 0 && <span>· {waiting.length} queued</span>}
          {control > 0 && <span>+{control} PM</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        Agent sessions running at once, across all projects. Change the limit in Settings → General.
      </TooltipContent>
    </Tooltip>
  );
}
