import {
  type AgentEventOf,
  agentEventToNewEvent,
  type RawEventEnvelope,
  type Session,
} from "@codeden/contracts";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToItemRecord } from "../../db/rows";
import { items } from "../../db/schema";
import type { EventStore } from "../../events/store";
import type { McpTokenStore } from "../../mcp/tokens";
import type { SettingsStore } from "../../settings-store";
import { errorMessage } from "../errors";
import { isFactorySession } from "../factory/starter";
import type { UtilityService } from "../utility";
import type { SessionAdmission } from "./admission";
import type { SessionRepo } from "./repo";
import type { SessionService } from "./session-service";

export interface LifecycleDeps {
  db: Db;
  store: EventStore;
  repo: SessionRepo;
  admission?: SessionAdmission;
  sessions: SessionService;
  settings: SettingsStore;
  utility: UtilityService;
  tokens: McpTokenStore;
  log?: (message: string) => void;
}

/**
 * Session statuses after which its MCP tokens are revoked (§8.3). Not `failed`: a failed turn
 * leaves the provider process running with its token, and the next message reaches that same
 * process; a session whose process is gone is resumed with a freshly minted token, and the
 * old one is revoked once the runner has started it (`SessionLauncher`).
 */
const ENDED = new Set(["stopped", "completed"]);

/**
 * Reacts to committed events: starts queued sessions whose blockers finished (§8.4 `wait`),
 * sends queued messages when a session goes idle, and runs utility-model hooks after a root
 * turn completes. Work is deferred so it never appends inside a store notification.
 */
export class SessionLifecycle {
  private drainScheduled = false;
  /** Sessions whose title is being generated. */
  private readonly titling = new Set<string>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: LifecycleDeps) {}

  start(): void {
    this.unsubscribe = this.deps.store.subscribe((events) => this.onEvents(events));
    this.scheduleDrain();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Start every queued session that no longer conflicts with earlier work. */
  drainQueue(): void {
    const { admission, repo, sessions } = this.deps;
    const blocked = new Set<string>();
    const queued = repo.queued();
    queued.forEach((session, index) => {
      const meta = repo.find(session.id)?.startMeta;
      // Admission-only starts already passed their own conflict policy (including force and fork).
      if (meta?.admission && meta.queuedBehind.length === 0) return;
      const younger = queued.slice(index + 1);
      const later = new Set(younger.map((s) => s.id));
      const others = this.deps.repo
        .activeWork(session.projectId)
        .filter((w) => w.id !== session.id && !later.has(w.id));
      const blockers = repo.sessionConflicts(session, repo.workLocation(session.id), others);
      if (blockers.length > 0) {
        blocked.add(session.id);
        return;
      }
      if (meta?.admission) return;
      if (
        !admission ||
        isFactorySession(session) ||
        admission.tryReserve(session.id, session.role)
      ) {
        sessions.startQueued(session);
      } else {
        const before = admission.waiters().find((entry) => later.has(entry.id) && !entry.runNext);
        admission.enqueue(session.id, before?.id);
      }
    });
    if (!admission) return;
    for (const { id } of admission.waiters()) {
      const session = repo.find(id)?.session;
      if (!session || (session.status !== "queued" && !sessions.hasOutbox(id))) {
        admission.dequeue(id);
        continue;
      }
      if (blocked.has(id) || sessions.isDelivering(id)) continue;
      if (session.status !== "queued") {
        if (!sessions.canWaitForOutbox(session)) {
          admission.dequeue(id);
          continue;
        }
        if (!sessions.canFlushOutbox(session)) continue;
      }
      if (!admission.tryReserve(id, session.role, true)) break;
      if (session.status === "queued") sessions.startQueued(session);
      else
        void sessions
          .flushOutbox(id, true)
          .catch((error) => this.deps.log?.(`queue: ${errorMessage(error)}`));
    }
    // Archived rows cannot hold a place in the admission queue. Normal outbox delivery
    // can still reopen a flushable archived session when a slot becomes available.
    if (admission.free() > 0) {
      for (const id of sessions.sessionsWithQueuedMessages()) {
        if (repo.find(id)?.session.archivedAt) {
          void sessions
            .flushOutbox(id)
            .catch((error) => this.deps.log?.(`queue: ${errorMessage(error)}`));
        }
      }
    }
  }

  private onEvents(events: RawEventEnvelope[]): void {
    let sessionsChanged = false;
    for (const e of events) {
      if (e.type === "session.created" || e.type === "session.updated") {
        sessionsChanged = true;
        const { session } = e.payload as { session: Session };
        if (ENDED.has(session.status)) this.deps.tokens.revokeSession(session.id);
        if (session.archivedAt && this.deps.repo.find(session.id)?.session.archivedAt) {
          this.deps.admission?.dequeue(session.id);
        }
        const settled = session.status === "idle" || session.status === "failed";
        if (settled && this.deps.sessions.hasOutbox(session.id)) {
          setImmediate(() => void this.deps.sessions.flushOutbox(session.id));
        }
      } else if (
        e.type === "message.dequeued" ||
        e.type === "settings.updated" ||
        e.type === "project.created" ||
        e.type === "project.updated"
      ) {
        sessionsChanged = true;
      } else if (
        (e.type === "agent.item.started" || e.type === "agent.item.completed") &&
        e.sessionId
      ) {
        const { item } = e.payload as AgentEventOf<"item.started">;
        if (item.kind === "user_message" && item.input.text.trim()) {
          const sessionId = e.sessionId;
          const text = item.input.text;
          setImmediate(() => void this.titleFromFirstMessage(sessionId, text));
        }
      } else if (e.type === "agent.turn.completed" && e.sessionId) {
        const sessionId = e.sessionId;
        const event = e.payload as AgentEventOf<"turn.completed">;
        setImmediate(() => void this.afterTurn(sessionId, event));
      }
    }
    if (sessionsChanged) this.scheduleDrain();
  }

  /** Name an untitled session after its first user message (§7.4). Never throws. */
  private async titleFromFirstMessage(sessionId: string, text: string): Promise<void> {
    if (this.titling.has(sessionId)) return;
    const session = this.deps.repo.find(sessionId)?.session;
    if (!session || session.title) return;
    this.titling.add(sessionId);
    try {
      const title = await this.deps.utility.sessionTitle({
        session,
        finalMessage: null,
        firstMessage: text,
      });
      if (title) this.deps.repo.update(sessionId, (s) => (s.title ? s : { ...s, title }));
    } catch (error) {
      this.deps.log?.(`utility title: ${errorMessage(error)}`);
    } finally {
      this.titling.delete(sessionId);
    }
  }

  scheduleDrain(): void {
    if (!this.unsubscribe || this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      if (!this.unsubscribe) return;
      try {
        this.drainQueue();
      } catch (error) {
        this.deps.log?.(`queue: ${errorMessage(error)}`);
      }
    });
  }

  /**
   * Utility-model hooks (§7.4, §7.5); no-ops with the default `UtilityService`. Not after a
   * compaction: it gives no answer to suggest follow-ups or a title from.
   */
  private async afterTurn(sessionId: string, event: AgentEventOf<"turn.completed">): Promise<void> {
    try {
      const session = this.deps.repo.find(sessionId)?.session;
      if (!session || session.rootThreadId !== event.threadId) return;
      if (this.deps.repo.turn(sessionId, event.turnId)?.kind === "compact") return;
      const settings = this.deps.settings.get();
      const turnItems = this.deps.db
        .select()
        .from(items)
        .where(and(eq(items.sessionId, sessionId), eq(items.turnId, event.turnId)))
        .orderBy(desc(items.position))
        .all()
        .map(rowToItemRecord);
      const final = turnItems.find((r) => r.item.kind === "assistant_message")?.item;
      const changedFiles = turnItems.flatMap((r) =>
        r.item.kind === "tool_call" && r.item.toolKind === "file_edit"
          ? r.item.changes.map((c) => c.path)
          : [],
      );
      const first = this.deps.db
        .select()
        .from(items)
        .where(and(eq(items.sessionId, sessionId), eq(items.kind, "user_message")))
        .orderBy(asc(items.createdAt))
        .limit(1)
        .get();
      const ctx = {
        session,
        finalMessage: final?.kind === "assistant_message" ? final.text : null,
        firstMessage: first?.data.kind === "user_message" ? first.data.input.text : null,
        changedFiles: [...new Set(changedFiles)],
      };

      if (
        !session.title &&
        !this.titling.has(sessionId) &&
        settings.utilityModel.jobs.sessionTitles
      ) {
        const title = await this.deps.utility.sessionTitle(ctx);
        if (title) this.deps.repo.update(sessionId, (s) => (s.title ? s : { ...s, title }));
      }
      const hasFollowups = turnItems.some((r) => r.item.kind === "followups");
      if (!hasFollowups && settings.followups.enabled && settings.utilityModel.jobs.followups) {
        const suggestions = await this.deps.utility.suggestFollowups(ctx);
        if (suggestions && suggestions.length > 0) {
          this.deps.store.append([
            agentEventToNewEvent(sessionId, {
              type: "item.completed",
              threadId: event.threadId,
              turnId: event.turnId,
              item: {
                id: `followups-${event.turnId}`,
                kind: "followups",
                status: "completed",
                source: "utility",
                suggestions: suggestions.slice(0, 4),
              },
            }),
          ]);
        }
      }
    } catch (error) {
      this.deps.log?.(`utility hooks: ${errorMessage(error)}`);
    }
  }
}
