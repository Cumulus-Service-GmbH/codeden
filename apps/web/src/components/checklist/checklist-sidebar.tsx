import {
  ListChecks,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  RefreshCw,
  X,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { DecisionCards, useDecisionCards } from "@/components/inbox/decision-cards";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TeamRunProgress } from "@/components/workbench/team-workers";
import { useSnapshot } from "@/lib/queries";
import { useViewport } from "@/lib/viewport";
import { useLayoutStore } from "@/stores/layout";
import { useChecklistOverlay } from "./checklist-overlay";
import { overallProgress, progressLabel, visibleChecklists } from "./checklist-progress";
import { ChecklistSection } from "./checklist-section";

export const CHECKLIST = { width: 300, rail: 44 } as const;

function useChecklists() {
  const { data } = useSnapshot();
  return data ? visibleChecklists(data.projects, data.checklists) : [];
}

function HeaderButton({
  label,
  tooltip = label,
  onClick,
  children,
}: {
  label: string;
  tooltip?: string;
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
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** `pinsNarrow`: pinning now lands in a narrow mode (rail or none), where the sheet stays open. */
function ChecklistBody({
  inline,
  onClose,
  pinsNarrow = false,
}: {
  inline: boolean;
  onClose: () => void;
  pinsNarrow?: boolean;
}) {
  const { data, refetch, isFetching } = useSnapshot();
  const lists = data ? visibleChecklists(data.projects, data.checklists) : [];
  const { data: cards } = useDecisionCards();
  const pinned = useLayoutStore((s) => s.checklistPinned);
  const setPinned = useLayoutStore((s) => s.setChecklistPinned);
  const setCollapsed = useLayoutStore((s) => s.setChecklistCollapsed);
  const overlayOnly = useChecklistOverlay((s) => s.overlayOnly);
  const setOverlaySheet = useChecklistOverlay((s) => s.setSheet);
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
        <Button variant="ghost" size="xs" disabled={isFetching} onClick={() => void refetch()}>
          <RefreshCw aria-hidden />
          Refresh
        </Button>
        {!phone && (
          <HeaderButton
            label={pinned ? "Unpin" : "Pin to the side"}
            tooltip={
              pinned && !inline
                ? overlayOnly
                  ? "Pinned (opens as overlay at this width)"
                  : "Pinned (rail at this width)"
                : undefined
            }
            onClick={() => {
              // Pinning the open sheet on a narrow window keeps it open as the pinned overlay.
              if (!pinned && pinsNarrow) setOverlaySheet(true);
              setPinned(!pinned);
            }}
          >
            {pinned ? <PinOff /> : <Pin />}
          </HeaderButton>
        )}
        {inline && (
          <HeaderButton label="Collapse" onClick={() => setCollapsed(true)}>
            <PanelRightClose />
          </HeaderButton>
        )}
        <HeaderButton label="Close checklist" onClick={onClose}>
          <X />
        </HeaderButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-1.5">
        <DecisionCards cards={cards ?? []} />
        {data?.teamRuns?.map((run) => (
          <TeamRunProgress key={run.id} run={run} />
        ))}
        {lists.length === 0 && !data?.teamRuns?.length ? (
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

/**
 * The collapsed pinned checklist, or a pinned one on a window too narrow for the full column:
 * a slim rail with a vertical taskline and the percent. `onExpand` opens the full list.
 */
function ChecklistRail({ onExpand }: { onExpand: () => void }) {
  const lists = useChecklists();
  const close = useLayoutStore((s) => s.toggleChecklist);
  const overall = overallProgress(lists.map((l) => l.checklist));

  return (
    <aside
      style={{ width: CHECKLIST.rail }}
      className="flex h-full shrink-0 flex-col items-center gap-3 border-l border-sidebar-border bg-sidebar pb-2"
      data-testid="checklist-rail"
    >
      <div className="flex h-12 shrink-0 items-center">
        <HeaderButton label="Expand checklist" onClick={onExpand}>
          <PanelRightOpen />
        </HeaderButton>
      </div>
      {overall.total > 0 && (
        <button
          type="button"
          onClick={onExpand}
          className="flex flex-col items-center gap-2 rounded-md px-1 py-1.5 outline-none hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          aria-label={`Expand checklist. Overall checklist progress ${progressLabel(overall)} done`}
          title={`${progressLabel(overall)} done`}
        >
          <span
            role="progressbar"
            aria-label="Overall checklist progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={overall.percent}
            aria-valuetext={`${progressLabel(overall)} done`}
            className="relative flex h-32 w-1.5 items-end overflow-hidden rounded-full bg-muted"
          >
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

/** The checklist as an overlay sheet at the right edge. */
function ChecklistSheet({
  open,
  onOpenChange,
  pinsNarrow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pinsNarrow?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 bg-sidebar p-0 data-[side=right]:w-[min(22rem,92vw)]"
        data-testid="checklist-sheet"
        // Following a session link leaves the overlay, so the session isn't hidden behind it.
        onClickCapture={(e) => {
          if (e.target instanceof Element && e.target.closest("a[href]")) onOpenChange(false);
        }}
      >
        <SheetTitle className="sr-only">Checklist</SheetTitle>
        <SheetDescription className="sr-only">
          Progress on each project, kept by the orchestrator
        </SheetDescription>
        <ChecklistBody inline={false} onClose={() => onOpenChange(false)} pinsNarrow={pinsNarrow} />
      </SheetContent>
    </Sheet>
  );
}

/**
 * The orchestrator's per-project checklists at the right edge of the shell. Pinned it is an
 * inline column (or a slim rail when collapsed); unpinned, and always on phones, an overlay
 * sheet. Closed, it takes no room at all. `mode` "rail" keeps a pinned checklist as its inline
 * rail when the full column would squeeze the main column too far; the rail's expand then
 * opens the overlay, and closing that overlay leaves the rail. `mode` "none", when even the
 * rail would, renders nothing inline: the footer toggle opens the overlay instead.
 */
export function ChecklistSidebar({ mode = "full" }: { mode?: "full" | "rail" | "none" }) {
  const open = useLayoutStore((s) => s.checklistOpen);
  const pinned = useLayoutStore((s) => s.checklistPinned);
  const collapsed = useLayoutStore((s) => s.checklistCollapsed);
  const setCollapsed = useLayoutStore((s) => s.setChecklistCollapsed);
  const toggle = useLayoutStore((s) => s.toggleChecklist);
  const overlaySheet = useChecklistOverlay((s) => s.sheet);
  const setOverlaySheet = useChecklistOverlay((s) => s.setSheet);
  const setNarrow = useChecklistOverlay((s) => s.setNarrow);
  const { phone } = useViewport();
  const inline = pinned && !phone;
  const railed = inline && open && mode === "rail";
  const overlayOnly = inline && mode === "none";
  const narrow = inline && open && mode !== "full";

  // Tells the toggle to open the overlay. Rail and no-rail share the overlay's open state, so
  // crossing between them keeps it open; it goes away once the full column fits again.
  useEffect(() => {
    setNarrow(narrow, overlayOnly);
  }, [narrow, overlayOnly, setNarrow]);

  if (narrow) {
    // One sheet in the same place for both narrow modes, so a resize never remounts it.
    return (
      <>
        {railed && <ChecklistRail onExpand={() => setOverlaySheet(true)} />}
        <ChecklistSheet
          open={overlaySheet}
          onOpenChange={(next) => {
            setOverlaySheet(next);
            // Without the rail, closing the overlay closes the checklist; the rail stays.
            if (overlayOnly) toggle(next);
          }}
        />
      </>
    );
  }
  if (inline) {
    if (!open) return null;
    if (collapsed) return <ChecklistRail onExpand={() => setCollapsed(false)} />;
    return (
      <aside
        style={{ width: CHECKLIST.width }}
        className="flex h-full shrink-0 flex-col border-l border-sidebar-border bg-sidebar"
        data-testid="checklist-sidebar"
      >
        <ChecklistBody inline onClose={() => toggle(false)} />
      </aside>
    );
  }
  return (
    <ChecklistSheet
      open={open}
      onOpenChange={(next) => toggle(next)}
      pinsNarrow={mode !== "full"}
    />
  );
}
