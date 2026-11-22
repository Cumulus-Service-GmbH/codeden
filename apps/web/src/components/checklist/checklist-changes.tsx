import type { ProjectChecklist } from "@codeden/contracts";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import {
  type ChangeGroupKind,
  changeDetail,
  changeTime,
  groupChanges,
  localTime,
} from "./checklist-progress";

const GROUP_CLASS: Record<ChangeGroupKind, string> = {
  ticked: "text-status-done",
  added: "text-primary",
  blocked: "text-status-waiting",
  other: "text-muted-foreground",
};

/** "Changed since last update": the latest changes grouped, each with its local time. */
export function ChangesSection({ checklist }: { checklist: ProjectChecklist }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const groups = groupChanges(checklist.changes);
  if (groups.length === 0) return null;

  return (
    <section className="mx-2 mt-2 rounded-md border border-sidebar-border/80 bg-sidebar-accent/25">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-2xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
        />
        Changed since last update
        <span className="ml-auto font-normal tabular-nums">{checklist.changes.length}</span>
      </button>
      {open && (
        <div id={bodyId} className="flex flex-col gap-1.5 px-2 pt-0.5 pb-1.5">
          {groups.map((group) => (
            <div key={group.kind}>
              <p
                className={cn(
                  "text-3xs font-semibold tracking-wide uppercase",
                  GROUP_CLASS[group.kind],
                )}
              >
                {group.label}
              </p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {group.changes.map((change, i) => {
                  const at = changeTime(change, checklist);
                  return (
                    <li
                      // An item can change twice in one update, and changes never reorder.
                      // biome-ignore lint/suspicious/noArrayIndexKey: see above
                      key={`${change.itemId}:${i}`}
                      className="flex min-w-0 items-baseline gap-1.5 text-2xs leading-snug"
                    >
                      <span className="min-w-0 truncate text-foreground/85" title={change.text}>
                        {change.text}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{changeDetail(change)}</span>
                      <time
                        dateTime={at}
                        title={new Date(at).toLocaleString()}
                        className="ml-auto shrink-0 text-muted-foreground tabular-nums"
                      >
                        {localTime(at)}
                      </time>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
