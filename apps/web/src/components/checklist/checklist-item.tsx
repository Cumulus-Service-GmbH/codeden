import type { ChecklistItem, ChecklistStatus } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Hand } from "lucide-react";
import { ago } from "@/lib/format";
import { useSnapshot } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { sessionLabel } from "./checklist-lifecycle";
import { localTime, STATUS_MARKER, statusLine } from "./checklist-progress";

const MARKER_CLASS: Record<ChecklistStatus, string> = {
  done: "bg-status-done/12 text-status-done",
  doing: "bg-primary/12 text-primary",
  blocked: "bg-destructive/12 text-destructive",
  todo: "bg-muted text-muted-foreground",
};

const LINK_CLASS =
  "rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring";

/** "[x]", "[~]", "[ ]" or "[!]" in a monospace chip coloured by status. */
function StatusMarker({ status }: { status: ChecklistStatus }) {
  const marker = STATUS_MARKER[status];
  return (
    <span
      role="img"
      aria-label={marker.label}
      className={cn(
        "mt-px h-4 shrink-0 rounded px-0.5 font-mono text-[10.5px] leading-4 font-semibold whitespace-pre",
        MARKER_CLASS[status],
      )}
    >
      {marker.text}
    </span>
  );
}

function NeedsOwner({ needsOwner }: { needsOwner: NonNullable<ChecklistItem["needsOwner"]> }) {
  const { sessionId } = needsOwner;
  return (
    <span className="mt-1 flex flex-col gap-0.5 rounded-md border border-status-waiting/40 bg-status-waiting/8 px-1.5 py-1 text-2xs">
      <span className="flex min-w-0 items-center gap-1">
        <Hand aria-hidden className="size-3 shrink-0 text-status-waiting" />
        <span className="shrink-0 font-semibold text-status-waiting">Needs you</span>
        <span className="truncate text-foreground/80" title={needsOwner.reason}>
          {needsOwner.reason}
        </span>
      </span>
      {sessionId && (
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId }}
          className={cn(
            LINK_CLASS,
            "inline-flex w-fit items-center gap-0.5 font-medium text-status-waiting decoration-status-waiting/50 hover:decoration-status-waiting",
          )}
        >
          Act in session
          <span className="font-mono font-normal">{sessionId.slice(0, 8)}</span>
          <ArrowRight aria-hidden className="size-3" />
        </Link>
      )}
    </span>
  );
}

/** An item's status line, scope badge, ETA, sessions and owner block, under its text. */
function ItemDetails({ item }: { item: ChecklistItem }) {
  const { data } = useSnapshot();
  const sessionIds = item.sessionIds ?? [];
  const workKeys = item.workKeys ?? [];
  const meta =
    item.scopeAddition || item.eta || item.autoUpdatedAt || sessionIds.length || workKeys.length;
  return (
    <>
      <span className="mt-0.5 truncate text-2xs text-muted-foreground" title={statusLine(item)}>
        {statusLine(item)}
      </span>
      {Boolean(meta) && (
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
          {item.scopeAddition && (
            <span
              title={`Added to the approved scope, approved ${localTime(item.scopeAddition.approvedAt)}`}
              className="rounded-full border border-primary/35 px-1.5 text-3xs font-medium text-primary"
            >
              Scope addition
            </span>
          )}
          {item.eta && (
            <span className="tabular-nums" title={`ETA ${new Date(item.eta).toLocaleString()}`}>
              ETA {localTime(item.eta)}
            </span>
          )}
          {item.autoUpdatedAt && (
            <time
              dateTime={item.autoUpdatedAt}
              title={new Date(item.autoUpdatedAt).toLocaleString()}
            >
              Auto-updated {localTime(item.autoUpdatedAt)}
            </time>
          )}
          {workKeys.map((key) => (
            <span key={key} className="max-w-44 truncate font-mono" title={key}>
              {key}
            </span>
          ))}
          {sessionIds.map((sessionId) => {
            const label = sessionLabel(sessionId, data?.sessions);
            const short = sessionId.slice(0, 8);
            return (
              <Link
                key={sessionId}
                to="/sessions/$sessionId"
                params={{ sessionId }}
                title={sessionId}
                className={cn(
                  LINK_CLASS,
                  "max-w-44 truncate decoration-muted-foreground/40 hover:text-foreground",
                )}
              >
                {label}
                {label !== short && <span className="ml-1 font-mono opacity-70">{short}</span>}
              </Link>
            );
          })}
        </span>
      )}
      {item.needsOwner && <NeedsOwner needsOwner={item.needsOwner} />}
    </>
  );
}

/**
 * One checklist item: its marker, text and details; lights up once when it just changed.
 * `shortId` follows the text when a pending diff line reads the same as this item.
 */
export function ItemRow({
  item,
  fresh,
  shortId,
}: {
  item: ChecklistItem;
  fresh: boolean;
  shortId?: string;
}) {
  return (
    <li
      title={`${STATUS_MARKER[item.status].label} · updated ${ago(item.updatedAt)}`}
      className={cn(
        "flex gap-2 rounded-md px-2 py-1 text-[13px] leading-snug",
        fresh && "animate-checklist-flash",
      )}
    >
      <StatusMarker status={item.status} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "wrap-break-word",
            item.status === "done"
              ? "text-muted-foreground line-through decoration-muted-foreground/50"
              : "text-sidebar-foreground/90",
          )}
        >
          {item.text}
          {shortId && (
            <span
              className="ml-1.5 font-mono text-3xs text-muted-foreground no-underline"
              title={`Item ${item.id}`}
            >
              {shortId}
            </span>
          )}
        </span>
        <ItemDetails item={item} />
      </span>
    </li>
  );
}
