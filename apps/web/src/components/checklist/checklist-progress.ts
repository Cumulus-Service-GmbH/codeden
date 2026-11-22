import type { ChecklistChange, ChecklistItem, Project, ProjectChecklist } from "@codeden/contracts";

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

/** "X/Y · NN%" for headers and badges. */
export function progressLabel(p: ChecklistProgress): string {
  return `${p.done}/${p.total} · ${p.percent}%`;
}

/**
 * The checklists to show: one per active project that has items, in the snapshot's project
 * order (archived projects are not in the snapshot's list).
 */
export function visibleChecklists(
  projects: readonly Project[],
  checklists: readonly ProjectChecklist[] | undefined,
): { project: Project; checklist: ProjectChecklist }[] {
  const byProject = new Map((checklists ?? []).map((c) => [c.projectId, c]));
  return projects.flatMap((project) => {
    const checklist = byProject.get(project.id);
    return checklist && checklist.items.length > 0 && project.archivedAt === null
      ? [{ project, checklist }]
      : [];
  });
}

/**
 * The one-line summary of what changed since the previous version, for example
 * "Tests → done · +1 added · 1 removed". Empty when nothing changed.
 */
export function changeLine(changes: readonly ChecklistChange[]): string {
  const parts: string[] = [];
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (change.from === null) added++;
    else if (change.to === null) removed++;
    else parts.push(`${change.text} → ${change.to}`);
  }
  if (added) parts.push(`+${added} added`);
  if (removed) parts.push(`${removed} removed`);
  return parts.join(" · ");
}
