import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSnapshot } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";
import { overallProgress, progressLabel, visibleChecklists } from "./checklist-progress";

/** Opens and closes the checklist sidebar; shows the overall percent once there are items. */
export function ChecklistToggle() {
  const { data } = useSnapshot();
  const open = useLayoutStore((s) => s.checklistOpen);
  const toggle = useLayoutStore((s) => s.toggleChecklist);
  const setNavOpen = useUiStore((s) => s.setNavOpen);
  const lists = data ? visibleChecklists(data.projects, data.checklists) : [];
  const overall = overallProgress(lists.map((l) => l.checklist));
  const label = overall.total > 0 ? `Checklist · ${progressLabel(overall)}` : "Checklist";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "relative text-muted-foreground",
            open && "bg-sidebar-accent text-foreground",
          )}
          onClick={() => {
            // From the phone drawer, the checklist sheet replaces the menu.
            setNavOpen(false);
            toggle();
          }}
          aria-label="Checklist"
          aria-pressed={open}
          data-testid="checklist-toggle"
        >
          <ListChecks />
          {overall.total > 0 && (
            <span className="pointer-events-none absolute -top-1 -right-1.5 rounded-full bg-sidebar px-0.5 text-[9px] leading-3 font-semibold text-muted-foreground tabular-nums ring-1 ring-sidebar-border">
              {overall.percent}%
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
