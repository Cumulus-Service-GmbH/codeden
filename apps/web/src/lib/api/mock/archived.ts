import {
  ARCHIVED_SESSIONS_DEFAULT_LIMIT,
  type ArchivedSessionsPage,
  type ArchivedSessionsQueryInit,
  type Session,
} from "@codeden/contracts";

/** Archived sessions per project, as the server's snapshot counts them. */
export function mockArchivedCounts(sessions: readonly Session[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sessions) {
    if (s.archivedAt && s.projectId) counts[s.projectId] = (counts[s.projectId] ?? 0) + 1;
  }
  return counts;
}

/**
 * A page of archived sessions, most recently archived first. The mock keeps every session
 * in its snapshot, so it pages through those using an offset.
 */
export function mockArchivedPage(
  sessions: readonly Session[],
  projectId: string | null,
  { cursor, limit = ARCHIVED_SESSIONS_DEFAULT_LIMIT }: ArchivedSessionsQueryInit = {},
): ArchivedSessionsPage {
  const all = sessions
    .filter(
      (s) =>
        s.archivedAt &&
        s.projectId === projectId &&
        (projectId !== null || s.role === "orchestrator"),
    )
    .sort(
      (a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "") || b.id.localeCompare(a.id),
    );
  const start = cursor ? Number(cursor) : 0;
  const end = start + Number(limit);
  return { sessions: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
}
