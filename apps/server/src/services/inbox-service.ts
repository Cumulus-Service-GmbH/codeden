import {
  type DismissInboxResponse,
  INBOX_BULK_MAX,
  type InboxCounts,
  type InboxDismissFilter,
  type InboxItem,
  type InboxItemKind,
  type InboxSettlement,
  inboxAttempts,
  inboxWaitsOnYou,
  type JsonValue,
  type ListInboxQuery,
  type ResolveInboxRequest,
  type RestoreInboxResponse,
  type RuntimeResponse,
  type Session,
} from "@codeden/contracts";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { rowToInbox } from "../db/rows";
import { inboxItems } from "../db/schema";
import { openRunFailed, runFailedAgain, runFailedInbox } from "../events/reducer/items";
import type { EventStore } from "../events/store";
import { badRequest, notFound } from "./errors";

/** Sends an approval/answer to the agent; provided by the session service. */
export type Responder = (
  sessionId: string,
  requestId: string,
  response: RuntimeResponse,
) => Promise<void>;

/** The inbox (§11.1): everything waiting on the user. */
export class InboxService {
  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
    private readonly responder: () => Responder,
  ) {}

  list(query: ListInboxQuery = {}): InboxItem[] {
    return this.newest(query, 1000);
  }

  /**
   * The newest `limit` items matching `query`, optionally narrowed to some `kinds`. The kinds
   * filter runs in SQL, before the limit, so older matching items aren't crowded out by newer
   * items of other kinds.
   */
  private newest(
    query: ListInboxQuery & { kinds?: readonly InboxItemKind[] },
    limit: number,
  ): InboxItem[] {
    const conditions: SQL[] = [eq(inboxItems.status, query.status ?? "open")];
    if (query.projectId) conditions.push(eq(inboxItems.projectId, query.projectId));
    if (query.sessionId) conditions.push(eq(inboxItems.sessionId, query.sessionId));
    if (query.kinds) conditions.push(inArray(inboxItems.kind, [...query.kinds]));
    return this.db
      .select()
      .from(inboxItems)
      .where(and(...conditions))
      .orderBy(desc(inboxItems.createdAt))
      .limit(limit)
      .all()
      .map(rowToInbox);
  }

  counts(): InboxCounts {
    const open = this.list();
    const byProject: Record<string, number> = {};
    const byKind: InboxCounts["byKind"] = {};
    for (const item of open) {
      if (item.projectId) byProject[item.projectId] = (byProject[item.projectId] ?? 0) + 1;
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    }
    return { open: open.length, byProject, byKind };
  }

  get(id: string): InboxItem {
    const item = this.find(id);
    if (!item) throw notFound(`No inbox item ${id}`, "inbox_not_found");
    return item;
  }

  find(id: string): InboxItem | undefined {
    const row = this.db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
    return row ? rowToInbox(row) : undefined;
  }

  /** Create an item, or replace the one with the same id. */
  put(item: InboxItem): InboxItem {
    const type = this.find(item.id) ? "inbox.updated" : "inbox.created";
    this.store.append([{ type, sessionId: item.sessionId, payload: { item } }]);
    return item;
  }

  /**
   * Answer an item in place. Approvals and questions forward `response` to the agent (the
   * transcript update then resolves the item too); other items are just closed.
   */
  async resolve(id: string, req: ResolveInboxRequest): Promise<InboxItem> {
    const item = this.get(id);
    if (item.status !== "open") return item;
    const answerable = (item.kind === "approval" || item.kind === "question") && item.requestId;
    if (answerable && req.status === "resolved") {
      if (!req.response) throw badRequest("This item needs a response", "response_required");
      if (!item.sessionId || !item.requestId) throw badRequest("Item has no session");
      await this.responder()(item.sessionId, item.requestId, req.response);
      return this.get(id);
    }
    return this.close(item, req.status, req.note ? { note: req.note } : null);
  }

  /** Close an open item now (eagerly, before the agent's confirmation arrives). */
  close(item: InboxItem, status: "resolved" | "dismissed", resolution: JsonValue): InboxItem {
    if (item.status !== "open") return item;
    const next = closedItem(item, status, resolution);
    this.store.append([
      { type: "inbox.updated", sessionId: item.sessionId, payload: { item: next } },
    ]);
    return next;
  }

  /** Close the open item mirroring a session's request, if there is one. */
  closeForRequest(sessionId: string, requestId: string, resolution: JsonValue): void {
    const row = this.db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.sessionId, sessionId),
          eq(inboxItems.requestId, requestId),
          eq(inboxItems.status, "open"),
        ),
      )
      .get();
    if (row) this.close(rowToInbox(row), "resolved", resolution);
  }

  /** Dismiss a session's open approvals and questions (session stopped). */
  dismissRequestsForSession(sessionId: string, reason: string): void {
    for (const item of this.list({ sessionId })) {
      if (item.kind === "approval" || item.kind === "question") {
        this.close(item, "dismissed", { reason });
      }
    }
  }

  /**
   * Raise a `run_failed` item for a session that could not start or crashed. One item per run:
   * a session whose earlier failure is still open updates that item in place (attempts, latest
   * error) instead of getting a second one. An item of the same key that was closed opens again
   * and counts on, so the new failure still gets its own notice (`deriveNotices`).
   */
  raiseRunFailed(session: Session, key: string, message: string): InboxItem {
    const now = new Date().toISOString();
    const open = openRunFailed(this.list({ sessionId: session.id }));
    if (open) return this.put(runFailedAgain(open, message, now));
    const id = `inbox:${session.id}:${key}`;
    const fresh = runFailedInbox(session, id, message, session.rootThreadId, now);
    const closed = this.find(id);
    return this.put(closed ? { ...fresh, attempts: inboxAttempts(closed) + 1 } : fresh);
  }

  /**
   * Dismiss open items at once (the inbox's bulk clean-up), given by id or by the list's
   * filters, in one transaction. Items that wait on the user (`inboxWaitsOnYou`) are left and
   * counted as `kept`; the rest are closed like a hand dismissal (`inbox.updated`), with
   * `{ bulk: true }` so `restoreMany` can undo it.
   */
  dismissMany(
    scope: { ids: readonly string[] } | { filter: InboxDismissFilter },
    note?: string,
  ): DismissInboxResponse {
    const now = new Date().toISOString();
    const resolution: JsonValue = note ? { bulk: true, note } : { bulk: true };
    const closed: InboxItem[] = [];
    let kept = 0;
    for (const item of this.inScope(scope)) {
      if (inboxWaitsOnYou(item)) kept++;
      else closed.push(closedItem(item, "dismissed", resolution, now));
    }
    this.appendUpdates(closed);
    return { dismissed: closed.length, ids: closed.map((i) => i.id), kept };
  }

  /**
   * Undo a bulk dismiss: reopen the given items a bulk dismiss closed, in one transaction. One
   * since re-raised, settled or dismissed by hand is left as it is, so exactly the dismissed set
   * comes back.
   */
  restoreMany(ids: readonly string[]): RestoreInboxResponse {
    const now = new Date().toISOString();
    const reopened: InboxItem[] = [];
    for (const id of new Set(ids)) {
      const item = this.find(id);
      if (item?.status !== "dismissed" || !bulkDismissed(item) || inboxWaitsOnYou(item)) continue;
      reopened.push({
        ...item,
        status: "open",
        resolution: null,
        resolvedAt: null,
        updatedAt: now,
      });
    }
    this.appendUpdates(reopened);
    return { restored: reopened.length, ids: reopened.map((i) => i.id) };
  }

  /** Append `inbox.updated` for each item, all in one batch. */
  private appendUpdates(items: InboxItem[]): void {
    if (items.length === 0) return;
    this.store.append(
      items.map((item) => ({
        type: "inbox.updated" as const,
        sessionId: item.sessionId,
        payload: { item },
      })),
    );
  }

  /** The open items a bulk dismiss covers: the ids given, or the newest a filter matches. */
  private inScope(scope: { ids: readonly string[] } | { filter: InboxDismissFilter }) {
    if ("ids" in scope) {
      return [...new Set(scope.ids)]
        .slice(0, INBOX_BULK_MAX)
        .map((id) => this.find(id))
        .filter((item): item is InboxItem => item?.status === "open");
    }
    const { projectId, sessionId, kinds } = scope.filter;
    return this.newest({ projectId, sessionId, kinds }, INBOX_BULK_MAX);
  }

  /** Close an open item CodeDen settled by itself, with a short note on why (`InboxSettlement`). */
  settle(item: InboxItem, settlement: InboxSettlement): InboxItem {
    return this.close(item, "resolved", settlement);
  }
}

/** The item was closed by a bulk dismiss (`dismissMany`), not one at a time. */
function bulkDismissed(item: InboxItem): boolean {
  const r = item.resolution;
  return typeof r === "object" && r !== null && !Array.isArray(r) && r.bulk === true;
}

/** `item` closed now with `status` and `resolution` (append it as `inbox.updated`). */
export function closedItem(
  item: InboxItem,
  status: "resolved" | "dismissed",
  resolution: JsonValue,
  now = new Date().toISOString(),
): InboxItem {
  return { ...item, status, resolution, resolvedAt: now, updatedAt: now };
}
