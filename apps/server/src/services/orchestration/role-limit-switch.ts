import {
  type AgentEventOf,
  agentEventToNewEvent,
  type InboxItem,
  PROVIDER_SWITCH_CODE,
  type ProviderSwitchData,
  type QueuedMessage,
  type RawEventEnvelope,
  type Session,
  type UserInput,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import type { SettingsStore } from "../../settings-store";
import { errorMessage } from "../errors";
import type { InboxService } from "../inbox-service";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import { roleName, switchText } from "./role-fallback";
import type { RoleSessions } from "./role-sessions";

export interface RoleLimitSwitchDeps {
  store: Pick<EventStore, "append">;
  repo: Pick<SessionRepo, "find">;
  roles: Pick<RoleSessions, "fallBack">;
  inbox: Pick<InboxService, "put">;
  projects: Pick<ProjectService, "get">;
  settings: Pick<SettingsStore, "get">;
  /** The home runner: only a provider it loaded can take a role over. */
  runner: Pick<RunnerPort, "providers">;
  /** Providers with a verified subscription login. An unavailable check allows no switch. */
  ready?: () => Promise<string[]>;
  /** The user's IANA timezone, for the reset time in the notice. */
  timezone: () => string;
  now?: () => number;
  log?: (message: string) => void;
}

type Sent = Pick<QueuedMessage, "input" | "from">;
type TurnRef = { threadId: string; turnId: string };

/** The inbox item about a role's provider switch: one per role, replaced by its next switch. */
export function switchInboxId(role: Session["role"], projectId: string | null): string {
  return role === "pm"
    ? `inbox:provider-switch:pm:${projectId}`
    : "inbox:provider-switch:orchestrator";
}

/** Retry a role's rate-limited message on its current Team selection, when eligible. */
export class RoleLimitSwitch {
  /** The last message sent to each role session, to send again if its turn hits a limit. */
  private readonly lastSent = new Map<string, Sent>();
  /** Notices for a new role session, shown in its first turn. */
  private readonly pending = new Map<string, { data: ProviderSwitchData; message: string }>();
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RoleLimitSwitchDeps) {}

  /** A message is on its way to a role session (before the digest is added to it). */
  sending(session: Session, input: UserInput, from: QueuedMessage["from"]): void {
    if (session.role !== "agent") this.lastSent.set(session.id, { input, from });
  }

  onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (!e.sessionId) continue;
      if (e.type === "agent.turn.started") {
        const event = e.payload as AgentEventOf<"turn.started">;
        const waiting = this.pending.get(e.sessionId);
        if (!waiting) continue;
        this.pending.delete(e.sessionId);
        this.notice(e.sessionId, event, waiting.data, waiting.message);
      } else if (e.type === "agent.turn.failed") {
        const event = e.payload as AgentEventOf<"turn.failed">;
        const session = this.deps.repo.find(e.sessionId)?.session;
        if (!session || session.role === "agent" || session.archivedAt) continue;
        if (session.rootThreadId && session.rootThreadId !== event.threadId) continue;
        if (event.error.kind !== "usage_limit") continue;
        if (!this.deps.settings.get().providers.autoSwitchOnLimit) continue;
        this.work = this.work
          .then(() => this.switch(session, event))
          .catch((error) => this.deps.log?.(`provider switch: ${errorMessage(error)}`));
      }
    }
  }

  /** Resolves once the switches started so far are done (tests). */
  idle(): Promise<void> {
    return this.work;
  }

  private async switch(session: Session, event: AgentEventOf<"turn.failed">): Promise<void> {
    const retryAt = event.error.retryAt ?? null;
    const at = { threadId: event.threadId, turnId: event.turnId };
    const ready = new Set(await this.deps.ready?.());
    const created = await this.deps.roles.fallBack(
      session,
      ready,
      this.lastSent.get(session.id),
      (replacement) => {
        const data = {
          reason: "usage_limit",
          from: session.provider,
          to: replacement.provider,
          retryAt,
        } as const;
        const message = this.text(data);
        this.notice(session.id, at, data, message);
        this.pending.set(replacement.id, { data, message });
        this.deps.inbox.put(this.inboxItem(replacement, message));
      },
    );
    if (!created) {
      const data = { reason: "no_fallback", from: session.provider, to: null, retryAt } as const;
      this.notice(session.id, at, data, this.text(data));
      return;
    }
    this.lastSent.delete(session.id);
  }

  private name(provider: string): string {
    return this.deps.runner.providers().find((p) => p.id === provider)?.displayName ?? provider;
  }

  private text(data: ProviderSwitchData): string {
    const names = {
      from: this.name(data.from),
      to: data.to ? this.name(data.to) : "",
    };
    return switchText(data, names, this.deps.timezone());
  }

  private inboxItem(to: Session, message: string): InboxItem {
    const now = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    const project = to.projectId ? this.deps.projects.get(to.projectId) : null;
    const who = project ? `${roleName("pm")} of ${project.name}` : roleName("orchestrator");
    return {
      id: switchInboxId(to.role, to.projectId),
      kind: "message",
      status: "open",
      priority: "normal",
      notify: "failure",
      title: `${who} now runs on ${this.name(to.provider)}`,
      body: message,
      projectId: to.projectId,
      sessionId: to.id,
      threadId: null,
      itemId: null,
      requestId: null,
      issue: null,
      pr: null,
      automationRunId: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
    };
  }

  private notice(sessionId: string, at: TurnRef, data: ProviderSwitchData, message: string): void {
    this.deps.store.append([
      agentEventToNewEvent(sessionId, {
        type: "item.completed",
        threadId: at.threadId,
        turnId: at.turnId,
        item: {
          id: `provider-switch-${at.turnId}`,
          kind: "notice",
          status: "completed",
          level: data.reason === "no_fallback" ? "warning" : "info",
          code: PROVIDER_SWITCH_CODE,
          message,
          data,
        },
      }),
    ]);
  }
}
