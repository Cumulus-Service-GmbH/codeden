import type { ChecklistItem, ChecklistStatus, Project, ProjectChecklist } from "@codeden/contracts";
import { ChevronRight, Circle, CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { useRef } from "react";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { ProjectTile } from "../shell/sidebar/project-group";
import {
  type ChecklistProgress,
  changeLine,
  progressLabel,
  progressOf,
} from "./checklist-progress";

const STATUS_LABEL: Record<ChecklistStatus, string> = {
  todo: "To do",
  doing: "In progress",
  done: "Done",
  blocked: "Blocked",
};

function StatusIcon({ status }: { status: ChecklistStatus }) {
  const base = "mt-px size-3.5 shrink-0";
  switch (status) {
    case "done":
      return <CircleCheck aria-hidden className={cn(base, "text-status-done")} />;
    case "doing":
      return (
        <LoaderCircle
          aria-hidden
          className={cn(base, "text-primary motion-safe:animate-spin [animation-duration:2.4s]")}
        />
      );
    case "blocked":
      return <CircleAlert aria-hidden className={cn(base, "text-destructive")} />;
    default:
      return <Circle aria-hidden className={cn(base, "text-muted-foreground/60")} />;
  }
}

/**
 * The taskline: a thin bar split into done, in-progress and blocked, so the share still to
 * start is the empty track.
 */
export function ProgressBar({
  progress,
  className,
}: {
  progress: ChecklistProgress;
  className?: string;
}) {
  const share = (n: number) => `${progress.total ? (n / progress.total) * 100 : 0}%`;
  return (
    <div
      role="progressbar"
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

function ItemRow({ item, fresh }: { item: ChecklistItem; fresh: boolean }) {
  return (
    <li
      title={`${STATUS_LABEL[item.status]} · updated ${ago(item.updatedAt)}`}
      className={cn(
        "flex gap-2 rounded-md px-2 py-1 text-[13px] leading-snug",
        fresh && "animate-checklist-flash",
      )}
    >
      <StatusIcon status={item.status} />
      <span className="sr-only">{STATUS_LABEL[item.status]}: </span>
      <span
        className={cn(
          "min-w-0 wrap-break-word",
          item.status === "done"
            ? "text-muted-foreground line-through decoration-muted-foreground/50"
            : "text-sidebar-foreground/90",
        )}
      >
        {item.text}
      </span>
    </li>
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
  const changes = changeLine(checklist.changes);
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
        <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
          {progressLabel(progress)}
        </span>
      </button>
      <ProgressBar progress={progress} className="mx-2 mt-1.5" />
      {changes && (
        <p
          className="mx-2 mt-1.5 truncate text-2xs text-muted-foreground"
          title={`Changed ${ago(checklist.updatedAt)}: ${changes}`}
        >
          Changed: {changes}
        </p>
      )}
      {!closed && (
        <ul id={bodyId} className="mt-1.5 flex flex-col">
          {checklist.items.map((item) => (
            <ItemRow
              key={changed.has(item.id) ? `${item.id}:${checklist.updatedAt}` : item.id}
              item={item}
              fresh={changed.has(item.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
