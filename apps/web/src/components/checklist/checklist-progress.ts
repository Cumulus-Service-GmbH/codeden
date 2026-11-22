import type {
  ChecklistChange,
  ChecklistItem,
  ChecklistStatus,
  Project,
  ProjectChecklist,
} from "@codeden/contracts";
import { isApproved } from "./checklist-lifecycle";

export interface ChecklistProgress {
  done: number;
  doing: number;
  blocked: number;
  total: number;
  /** Whole percent done, rounded down so it reads 100 only when every item is done. */
  percent: number;
}

/** Counts and percent done for a list of items. */
export function progressOf(items: readonly ChecklistItem[]): ChecklistProgress {
  let done = 0;
  let doing = 0;
  let blocked = 0;
  for (const item of items) {
    if (item.status === "done") done++;
    else if (item.status === "doing") doing++;
    else if (item.status === "blocked") blocked++;
  }
  const total = items.length;
  return { done, doing, blocked, total, percent: total ? Math.floor((done / total) * 100) : 0 };
}

/** Progress over every item of every given checklist. */
export function overallProgress(checklists: readonly ProjectChecklist[]): ChecklistProgress {
  return progressOf(checklists.flatMap((c) => c.items));
}

/** "X/Y (NN%)" for headers and badges. */
export function progressLabel(p: ChecklistProgress): string {
  return `${p.done}/${p.total} (${p.percent}%)`;
}

/** How many items wait on the owner. */
export function needsOwnerCount(items: readonly ChecklistItem[]): number {
  return items.filter((item) => item.needsOwner !== undefined).length;
}

/** The text marker of a status and what a screen reader says for it. */
export const STATUS_MARKER: Record<ChecklistStatus, { text: string; label: string }> = {
  done: { text: "[x]", label: "done" },
  doing: { text: "[~]", label: "in progress" },
  todo: { text: "[ ]", label: "not started" },
  blocked: { text: "[!]", label: "blocked" },
};

const STATUS_WORDS: Record<ChecklistStatus, string> = {
  todo: "Not started",
  doing: "In progress",
  done: "Done",
  blocked: "Blocked",
};

/** An item's one-line status: its note, else its status in words. */
export function statusLine(item: Pick<ChecklistItem, "status" | "note">): string {
  return item.note?.trim() || STATUS_WORDS[item.status];
}

/**
 * The checklists to show: one per active project whose checklist has items, is approved,
 * waits on a proposal or changed in its latest update (so removing the last item still shows
 * the removal), in the snapshot's project order (archived projects are not in the list).
 */
export function visibleChecklists(
  projects: readonly Project[],
  checklists: readonly ProjectChecklist[] | undefined,
): { project: Project; checklist: ProjectChecklist }[] {
  const byProject = new Map((checklists ?? []).map((c) => [c.projectId, c]));
  return projects.flatMap((project) => {
    const checklist = byProject.get(project.id);
    const shown =
      checklist &&
      (checklist.items.length > 0 ||
        isApproved(checklist) ||
        checklist.pending !== undefined ||
        checklist.changes.length > 0);
    return shown && project.archivedAt === null ? [{ project, checklist }] : [];
  });
}

/** The narrowest the main column may get beside a pinned checklist (full column or rail). */
export const MIN_MAIN_WIDTH = 480;

/**
 * Whether a pinned checklist of `checklistWidth` fits inline: the window less the left
 * sidebar, the open session panel and the checklist must leave the main column 480 px.
 */
export function pinnedChecklistFits(
  windowWidth: number,
  occupied: { left: number; right: number },
  checklistWidth: number,
): boolean {
  return windowWidth - occupied.left - occupied.right - checklistWidth >= MIN_MAIN_WIDTH;
}

/**
 * How a pinned checklist renders inline: the full column when it fits beside the main column,
 * else its slim rail (which opens the overlay when expanded), else, when even the rail would
 * leave the main column too narrow, nothing inline: the toggle then opens the overlay.
 */
export function pinnedChecklistMode(
  windowWidth: number,
  occupied: { left: number; right: number },
  widths: { full: number; rail: number },
): "full" | "rail" | "none" {
  if (pinnedChecklistFits(windowWidth, occupied, widths.full)) return "full";
  return pinnedChecklistFits(windowWidth, occupied, widths.rail) ? "rail" : "none";
}

export type ChangeGroupKind = "ticked" | "added" | "blocked" | "other";

const GROUPS: { kind: ChangeGroupKind; label: string }[] = [
  { kind: "ticked", label: "Ticked" },
  { kind: "added", label: "Added" },
  { kind: "blocked", label: "Newly blocked" },
  { kind: "other", label: "Other changes" },
];

/**
 * The group of "Changed since last update" a change belongs to; the first match wins. Only a
 * move into done is ticked and only a move into blocked (or a new owner ask) is newly blocked,
 * so a rewording of a done or blocked item lands in Other changes.
 */
export function changeGroup(change: ChecklistChange): ChangeGroupKind {
  if (change.to === "done" && change.from !== "done") return "ticked";
  if (change.from === null) return "added";
  if ((change.to === "blocked" && change.from !== "blocked") || change.needsOwner === true)
    return "blocked";
  return "other";
}

/** The changes as Ticked, Added, Newly blocked and Other changes, leaving out empty groups. */
export function groupChanges(
  changes: readonly ChecklistChange[],
): { kind: ChangeGroupKind; label: string; changes: ChecklistChange[] }[] {
  return GROUPS.flatMap(({ kind, label }) => {
    const inGroup = changes.filter((c) => changeGroup(c) === kind);
    return inGroup.length ? [{ kind, label, changes: inGroup }] : [];
  });
}

/** What happened to the item: "doing → done", "added", "removed", "reworded" or "needs you". */
export function changeDetail(change: ChecklistChange): string {
  if (change.from === null) return "added";
  if (change.to === null) return "removed";
  if (change.textBefore !== undefined && change.textBefore !== change.text) return "reworded";
  if (change.needsOwner === true && change.from === change.to) return "needs you";
  return `${change.from} → ${change.to}`;
}

/** When a change happened: its own time, else the time of the update that recorded it. */
export function changeTime(change: ChecklistChange, checklist: ProjectChecklist): string {
  return change.at ?? checklist.updatedAt;
}

export interface LocalTimeOptions {
  now?: Date;
  timeZone?: string;
  locale?: string;
}

/** A timestamp in local time: the time alone when it is today, else a short date and the time. */
export function localTime(iso: string, options: LocalTimeOptions = {}): string {
  const { now = new Date(), timeZone, locale } = options;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  const time: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", timeZone };
  if (day(date) === day(now)) return date.toLocaleTimeString(locale, time);
  return date.toLocaleString(locale, { ...time, month: "short", day: "numeric" });
}
