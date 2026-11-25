import {
  type Project,
  type ProjectChecklist,
  runningChecklistItemsFirst,
} from "@codeden/contracts";
import { ChevronRight } from "lucide-react";
import { useRef } from "react";
import { useFactoryStatus } from "@/lib/factory";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { ProjectTile } from "../shell/sidebar/project-group";
import { JevStatus } from "../workbench/jev-status";
import { EnforceSwitch, PendingProposal, StateChip } from "./checklist-approval";
import { ChangesSection } from "./checklist-changes";
import { ItemRow } from "./checklist-item";
import { isApproved, sharedLabelIds } from "./checklist-lifecycle";
import {
  type ChecklistProgress,
  needsOwnerCount,
  progressLabel,
  progressOf,
} from "./checklist-progress";

/**
 * The taskline: a thin bar split into done, in-progress and blocked, so the share still to
 * start is the empty track.
 */
export function ProgressBar({
  progress,
  label,
  className,
}: {
  progress: ChecklistProgress;
  label: string;
  className?: string;
}) {
  const share = (n: number) => `${progress.total ? (n / progress.total) * 100 : 0}%`;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress.percent}
      aria-valuetext={`${progressLabel(progress)} done`}
      className={cn("flex h-1 overflow-hidden rounded-full bg-muted", className)}
    >
      <span
        className="bg-status-done transition-[width] duration-500"
        style={{ width: share(progress.done) }}
      />
      <span
        className="bg-primary/45 transition-[width] duration-500"
        style={{ width: share(progress.doing) }}
      />
      <span
        className="bg-destructive/70 transition-[width] duration-500"
        style={{ width: share(progress.blocked) }}
      />
    </div>
  );
}

/** One project's checklist: a foldable header with its taskline, then the items. */
export function ChecklistSection({
  project,
  checklist,
}: {
  project: Project;
  checklist: ProjectChecklist;
}) {
  const closed = useLayoutStore((s) => s.checklistClosedProjects[project.id] === true);
  const toggle = useLayoutStore((s) => s.toggleChecklistProject);
  // Items changed by an update that arrived while this was on screen light up once.
  const firstSeen = useRef(checklist.updatedAt);
  const live = checklist.updatedAt !== firstSeen.current;
  const changed = new Set(live ? checklist.changes.map((c) => c.itemId) : []);
  const progress = progressOf(checklist.items);
  const needsYou = needsOwnerCount(checklist.items);
  // Items that read the same as a line of the pending diff show their short id, as the line does.
  const shortIds =
    checklist.pending?.kind === "expand"
      ? sharedLabelIds(checklist.pending.diff, checklist.items)
      : new Map<string, string>();
  const factory = useFactoryStatus(project.id, !closed).data;
  const factoryItems = [...(factory?.inProgress ?? []), ...(factory?.recent ?? [])].filter(
    (item) => item.jev,
  );
  const bodyId = `checklist-${project.id}`;

  return (
    <section className="border-b border-sidebar-border/70 py-2 last:border-b-0">
      <button
        type="button"
        onClick={() => toggle(project.id)}
        aria-expanded={!closed}
        aria-controls={bodyId}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] outline-none hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
            !closed && "rotate-90",
          )}
        />
        <ProjectTile project={project} />
        <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
        {needsYou > 0 && (
          <span
            title={`${needsYou} ${needsYou === 1 ? "item needs" : "items need"} you`}
            className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 text-3xs leading-4 font-semibold text-status-waiting tabular-nums"
          >
            {needsYou}
            <span className="sr-only"> need you</span>
          </span>
        )}
        <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
          {progressLabel(progress)}
        </span>
      </button>
      <ProgressBar progress={progress} label={`${project.name} progress`} className="mx-2 mt-1.5" />
      <div className="mx-2 mt-1.5 flex min-h-5 items-center gap-2">
        <StateChip checklist={checklist} />
        {isApproved(checklist) && !checklist.plan && <EnforceSwitch checklist={checklist} />}
      </div>
      {/* One region for everything the header folds: the proposal, the changes and the items. */}
      <div id={bodyId} hidden={closed}>
        <PendingProposal checklist={checklist} />
        <ChangesSection checklist={checklist} />
        {checklist.items.length === 0 ? (
          <p className="mx-2 mt-1.5 text-2xs text-muted-foreground">No items yet</p>
        ) : (
          <ul className="mt-1.5 flex flex-col">
            {runningChecklistItemsFirst(checklist.items).map((item) => (
              <ItemRow
                key={changed.has(item.id) ? `${item.id}:${checklist.updatedAt}` : item.id}
                item={item}
                fresh={changed.has(item.id)}
                shortId={shortIds.get(item.id)}
              />
            ))}
          </ul>
        )}
        {!closed && factoryItems.length > 0 && (
          <ul className="mt-1.5 flex flex-col">
            {factoryItems.map(
              (item) =>
                item.jev && (
                  <li className="px-2 py-1 text-[13px]" key={item.id}>
                    <p>{item.title}</p>
                    <JevStatus receipt={item.jev} />
                  </li>
                ),
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
