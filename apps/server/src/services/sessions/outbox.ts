import { randomUUID } from "node:crypto";
import type { QueuedMessage, QueueSender, UserInput } from "@codeden/contracts";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { events, queuedMessages } from "../../db/schema";
import type { EventStore } from "../../events/store";

/** Why a message left the queue (`message.dequeued`). */
export type DequeueReason = "sent" | "dropped" | "deleted";

type Row = typeof queuedMessages.$inferSelect;

const toMessage = (r: Row): QueuedMessage => ({
  id: r.id,
  sessionId: r.sessionId,
  input: r.input,
  from: r.sender ?? "user",
  createdAt: r.createdAt,
  ...(r.deliveryUncertain ? { delivery: "uncertain" as const } : {}),
});

/**
 * Messages sent while a turn runs, delivered one at a time when the session goes idle.
 * Stored through `message.queued` / `message.dequeued` / `message.edited` events, so the queue
 * survives server restarts and can be rebuilt from the log.
 *
 * Normal delivery takes a message out before awaiting anything. Priority delivery reserves
 * the row in memory while leaving it on disk for recovery.
 */
export class Outbox {
  /** Priority deliveries hold their rows on disk but own them exclusively until the steer ends. */
  readonly steering = new Set<string>();

  /** Last `createdAt` handed out (ms), so timestamps strictly increase. */
  private lastAt = 0;

  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
  ) {}

  /**
   * Queue a message. `at` puts it in a place taken earlier with `reserve` (a delivery that
   * fell back to the queue), ahead of everything queued since.
   */
  push(
    sessionId: string,
    input: UserInput,
    from: QueueSender = "user",
    at?: string,
    id: string = randomUUID(),
  ): QueuedMessage {
    const message: QueuedMessage = {
      id,
      sessionId,
      input,
      from,
      createdAt: at ?? this.reserve(),
    };
    this.store.append([{ type: "message.queued", sessionId, payload: { message } }]);
    return message;
  }

  /**
   * A place in the queue, for a message sent straight to the session: if that delivery falls
   * back to the queue, `push(…, at)` keeps the order the messages arrived in.
   */
  reserve(): string {
    // `createdAt` orders the queue, so two messages in the same millisecond still get distinct
    // times, and a message put back by `restore` returns to exactly its place.
    this.lastAt = Math.max(Date.now(), this.lastAt + 1);
    return new Date(this.lastAt).toISOString();
  }

  /** A session's queued messages, next to be delivered first. */
  list(sessionId: string): QueuedMessage[] {
    return this.db
      .select()
      .from(queuedMessages)
      .where(eq(queuedMessages.sessionId, sessionId))
      .orderBy(asc(queuedMessages.createdAt), asc(sql`rowid`))
      .all()
      .map(toMessage);
  }

  /** Oldest queued message of a session, if any. */
  peek(sessionId: string): QueuedMessage | undefined {
    return this.list(sessionId).find((m) => m.delivery !== "uncertain" || this.steering.has(m.id));
  }

  get(sessionId: string, messageId: string): QueuedMessage | undefined {
    const row = this.db
      .select()
      .from(queuedMessages)
      .where(and(eq(queuedMessages.sessionId, sessionId), eq(queuedMessages.id, messageId)))
      .get();
    return row ? toMessage(row) : undefined;
  }

  count(sessionId: string): number {
    return this.list(sessionId).filter((m) => m.delivery !== "uncertain" || this.steering.has(m.id))
      .length;
  }

  /** Session ids with at least one queued message. */
  sessionsWithMessages(): string[] {
    const rows = this.db
      .selectDistinct({ id: queuedMessages.sessionId })
      .from(queuedMessages)
      .all();
    return rows.map((r) => r.id);
  }

  /** Replace a queued message's text; its attachments stay. */
  edit(message: QueuedMessage, text: string): QueuedMessage {
    this.store.append([
      {
        type: "message.edited",
        sessionId: message.sessionId,
        payload: {
          sessionId: message.sessionId,
          messageId: message.id,
          text,
          at: new Date().toISOString(),
        },
      },
    ]);
    return { ...message, input: { ...message.input, text } };
  }

  remove(message: QueuedMessage, reason: DequeueReason): void {
    this.store.append([
      {
        type: "message.dequeued",
        sessionId: message.sessionId,
        payload: { sessionId: message.sessionId, messageId: message.id, reason },
      },
    ]);
  }

  /** Put a message taken out for delivery back in its place (the delivery failed). */
  restore(message: QueuedMessage): void {
    this.store.append([
      { type: "message.queued", sessionId: message.sessionId, payload: { message } },
    ]);
  }

  /** Leave an acceptance marker on disk until the runner confirms the outcome. */
  markDelivery(message: QueuedMessage, uncertain: boolean): void {
    this.store.append([
      {
        type: "message.delivery",
        sessionId: message.sessionId,
        payload: { sessionId: message.sessionId, messageId: message.id, uncertain },
      },
    ]);
  }

  releaseSteer(message: QueuedMessage): void {
    if (!this.steering.delete(message.id)) return;
    const retained = this.get(message.sessionId, message.id);
    if (retained) this.markDelivery(retained, retained.delivery === "uncertain");
  }

  /** Drop every queued message of a session (interrupt, stop). Returns what was dropped. */
  clear(sessionId: string): QueuedMessage[] {
    const dropped = this.list(sessionId).filter((m) => m.delivery !== "uncertain");
    if (dropped.length === 0) return [];
    this.store.append(
      dropped.map((m) => ({
        type: "message.dequeued" as const,
        sessionId,
        payload: { sessionId, messageId: m.id, reason: "dropped" as const },
      })),
    );
    return dropped;
  }

  /** Why a message is no longer queued, from the log; `undefined` if it never was. */
  dequeuedReason(sessionId: string, messageId: string): DequeueReason | undefined {
    const row = this.db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.sessionId, sessionId),
          eq(events.type, "message.dequeued"),
          sql`json_extract(${events.payload}, '$.messageId') = ${messageId}`,
        ),
      )
      .orderBy(desc(events.seq))
      .limit(1)
      .get();
    return (row?.payload as { reason?: DequeueReason } | undefined)?.reason;
  }
}
