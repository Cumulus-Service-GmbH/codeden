import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSnapshot } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";
import { useChecklistOverlay } from "./checklist-overlay";
import {
  needsOwnerCount,
  overallProgress,
  progressLabel,
  visibleChecklists,
} from "./checklist-progress";

/** Opens and closes the checklist sidebar; shows the overall percent once there are items. */
export function ChecklistToggle() {
  const { data } = useSnapshot();
  const open = useLayoutStore((s) => s.checklistOpen);
  const toggle = useLayoutStore((s) => s.toggleChecklist);
  const overlayOnly = useChecklistOverlay((s) => s.overlayOnly);
  const sheet = useChecklistOverlay((s) => s.sheet);
  const setSheet = useChecklistOverlay((s) => s.setSheet);
  const setNavOpen = useUiStore((s) => s.setNavOpen);
  // Pinned on a window too narrow for even the rail, the toggle opens and closes the overlay.
  const shown = overlayOnly ? open && sheet : open;
  const lists = data ? visibleChecklists(data.projects, data.checklists) : [];
  const overall = overallProgress(lists.map((l) => l.checklist));
  const needsYou = needsOwnerCount(lists.flatMap((l) => l.checklist.items));
  const label = [
    "Checklist",
    overall.total > 0 && `Overall checklist progress ${progressLabel(overall)}`,
    needsYou > 0 && `${needsYou} ${needsYou === 1 ? "needs" : "need"} you`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "relative text-muted-foreground",
            shown && "bg-sidebar-accent text-foreground",
          )}
          onClick={() => {
            // From the phone drawer, the checklist sheet replaces the menu.
            setNavOpen(false);
            if (overlayOnly) {
              setSheet(!shown);
              toggle(!shown);
            } else toggle();
          }}
          aria-label={label}
          aria-pressed={shown}
          data-testid="checklist-toggle"
        >
          <ListChecks />
          {overall.total > 0 && (
            <span className="pointer-events-none absolute -top-1 -right-1.5 rounded-full bg-sidebar px-0.5 text-[9px] leading-3 font-semibold text-muted-foreground tabular-nums ring-1 ring-sidebar-border">
              {overall.percent}%
            </span>
          )}
          {needsYou > 0 && (
            <span className="pointer-events-none absolute -right-1.5 -bottom-1 min-w-3 rounded-full bg-status-waiting px-0.5 text-center text-[9px] leading-3 font-semibold text-background tabular-nums">
              {needsYou}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
