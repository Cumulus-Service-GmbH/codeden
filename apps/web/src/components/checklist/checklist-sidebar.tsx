import { ListChecks, PanelRightClose, PanelRightOpen, Pin, PinOff, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSnapshot } from "@/lib/queries";
import { useViewport } from "@/lib/viewport";
import { useLayoutStore } from "@/stores/layout";
import { overallProgress, progressLabel, visibleChecklists } from "./checklist-progress";
import { ChecklistSection } from "./checklist-section";

export const CHECKLIST = { width: 300, rail: 44 } as const;

function useChecklists() {
  const { data } = useSnapshot();
  return data ? visibleChecklists(data.projects, data.checklists) : [];
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ChecklistBody({ inline }: { inline: boolean }) {
  const lists = useChecklists();
  const pinned = useLayoutStore((s) => s.checklistPinned);
  const setPinned = useLayoutStore((s) => s.setChecklistPinned);
  const setCollapsed = useLayoutStore((s) => s.setChecklistCollapsed);
  const close = useLayoutStore((s) => s.toggleChecklist);
  const { phone } = useViewport();
  const overall = overallProgress(lists.map((l) => l.checklist));

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-sidebar-border pr-2 pl-3">
        <ListChecks aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-medium">Checklist</h2>
        {overall.total > 0 && (
          <span className="ml-1 truncate text-2xs text-muted-foreground tabular-nums">
            {progressLabel(overall)}
          </span>
        )}
        <span className="flex-1" />
        {!phone && (
          <HeaderButton
            label={pinned ? "Unpin" : "Pin to the side"}
            onClick={() => setPinned(!pinned)}
          >
            {pinned ? <PinOff /> : <Pin />}
          </HeaderButton>
        )}
        {inline && (
          <HeaderButton label="Collapse" onClick={() => setCollapsed(true)}>
            <PanelRightClose />
          </HeaderButton>
        )}
        <HeaderButton label="Close checklist" onClick={() => close(false)}>
          <X />
        </HeaderButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-1.5">
        {lists.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-muted-foreground">
            No checklist yet. The orchestrator keeps it here.
          </p>
        ) : (
          lists.map(({ project, checklist }) => (
            <ChecklistSection key={project.id} project={project} checklist={checklist} />
          ))
        )}
      </div>
    </>
  );
}

/** The collapsed pinned checklist: a slim rail with a vertical taskline and the percent. */
function ChecklistRail() {
  const lists = useChecklists();
  const setCollapsed = useLayoutStore((s) => s.setChecklistCollapsed);
  const close = useLayoutStore((s) => s.toggleChecklist);
  const overall = overallProgress(lists.map((l) => l.checklist));

  return (
    <aside
      style={{ width: CHECKLIST.rail }}
      className="flex h-full shrink-0 flex-col items-center gap-3 border-l border-sidebar-border bg-sidebar pb-2"
      data-testid="checklist-rail"
    >
      <div className="flex h-12 shrink-0 items-center">
        <HeaderButton label="Expand checklist" onClick={() => setCollapsed(false)}>
          <PanelRightOpen />
        </HeaderButton>
      </div>
      {overall.total > 0 && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex flex-col items-center gap-2 rounded-md px-1 py-1.5 outline-none hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          aria-label={`Checklist ${progressLabel(overall)} done. Expand`}
          title={`${progressLabel(overall)} done`}
        >
          <span className="relative flex h-32 w-1.5 items-end overflow-hidden rounded-full bg-muted">
            <span
              className="w-full rounded-full bg-status-done transition-[height] duration-500"
              style={{ height: `${overall.percent}%` }}
            />
          </span>
          <span className="text-3xs text-muted-foreground tabular-nums">{overall.percent}%</span>
        </button>
      )}
      <span className="flex-1" />
      <HeaderButton label="Close checklist" onClick={() => close(false)}>
        <X />
      </HeaderButton>
    </aside>
  );
}

/**
 * The orchestrator's per-project checklists at the right edge of the shell. Pinned it is an
 * inline column (or a slim rail when collapsed); unpinned, and always on phones, an overlay
 * sheet. Closed, it takes no room at all.
 */
export function ChecklistSidebar() {
  const open = useLayoutStore((s) => s.checklistOpen);
  const pinned = useLayoutStore((s) => s.checklistPinned);
  const collapsed = useLayoutStore((s) => s.checklistCollapsed);
  const toggle = useLayoutStore((s) => s.toggleChecklist);
  const { phone } = useViewport();
  const inline = pinned && !phone;

  if (inline) {
    if (!open) return null;
    if (collapsed) return <ChecklistRail />;
    return (
      <aside
        style={{ width: CHECKLIST.width }}
        className="flex h-full shrink-0 flex-col border-l border-sidebar-border bg-sidebar"
        data-testid="checklist-sidebar"
      >
        <ChecklistBody inline />
      </aside>
    );
  }
  return (
    <Sheet open={open} onOpenChange={(next) => toggle(next)}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 bg-sidebar p-0 data-[side=right]:w-[min(22rem,92vw)]"
        data-testid="checklist-sheet"
      >
        <SheetTitle className="sr-only">Checklist</SheetTitle>
        <SheetDescription className="sr-only">
          Progress on each project, kept by the orchestrator
        </SheetDescription>
        <ChecklistBody inline={false} />
      </SheetContent>
    </Sheet>
  );
}
