import { createHash, randomUUID } from "node:crypto";
import {
  type DecideApprovalInput,
  type DecideApprovalOutput,
  type InboxItem,
  type ItemOf,
  type JsonValue,
  type ListPendingApprovalsOutput,
  type NewEvent,
  type OrchestratorApprovalDecision,
  type PendingApproval,
  redactSecrets,
} from "@codeden/contracts";
import { guardedReadCommand } from "@codeden/providers";
import type { ProjectionReader } from "../events/reducer/types";
import type { EventStore } from "../events/store";
import { classifyApproval } from "./classify-approval";
import type { DecisionApprovals } from "./decision-approvals";
import { conflict, forbidden, notFound } from "./errors";
import { closedItem, type InboxService } from "./inbox-service";
import type { SessionRepo } from "./sessions/repo";
import type { SessionService } from "./sessions/session-service";

export { classifyApproval } from "./classify-approval";

const inboxKinds = ["approval", "question", "spec_approval", "checklist_approval"] as const;
type Actor = Parameters<DecisionApprovals["confirm"]>[1];

interface Entry {
  approval: PendingApproval;
  request?: { sessionId: string; requestId: string };
  cardId?: string;
  inputDigest?: string;
}

function redactText(text: string | undefined): string | undefined {
  return text === undefined ? undefined : redactSecrets(text);
}

function redactJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const probe = `${key}=redaction-probe`;
      return [redactSecrets(key), redactSecrets(probe) === probe ? redactJson(item) : "[REDACTED]"];
    }),
  );
}

function redactArgs(args: Record<string, JsonValue>): Record<string, JsonValue> {
  return redactJson(args) as Record<string, JsonValue>;
}

export class OrchestratorApprovals {
  private readonly deciding = new Set<string>();

  constructor(
    private readonly inbox: Pick<InboxService, "list" | "closeForRequest">,
    private readonly repo: Pick<SessionRepo, "item" | "approvalRequest" | "find">,
    private readonly decisions: DecisionApprovals,
    private readonly sessions: Pick<SessionService, "respond">,
    private readonly store: Pick<EventStore, "appendFrom">,
    private readonly isRemote: (sessionId: string) => boolean,
  ) {}

  list(): ListPendingApprovalsOutput {
    return { approvals: this.entries().map(({ approval }) => approval) };
  }

  async decide(actor: Actor, input: DecideApprovalInput): Promise<DecideApprovalOutput> {
    const { sessionId: orchestratorSessionId } = actor;
    if (actor.role !== "orchestrator" || !orchestratorSessionId) {
      throw forbidden("An orchestrator session is required");
    }
    const { id, decision } = input;
    const entry = this.entries().find(({ approval }) => approval.id === id);
    if (!entry) throw notFound("No pending approval with that ID", "approval_not_found");
    const { approval, request, cardId } = entry;
    if (!this.hasIndependentSession(approval.sessionId, orchestratorSessionId)) {
      throw forbidden("This approval requires the owner (unclassified)", "owner_only_approval");
    }
    if (!approval.delegable || (!request && !cardId)) {
      throw forbidden(
        `This approval requires the owner (${approval.ownerOnly ?? "unclassified"})`,
        "owner_only_approval",
      );
    }
    if (this.deciding.has(id)) throw conflict("A decision is already in progress");

    const reason = redactSecrets(input.reason);
    const responseDecision = decision === "approve" ? "allow_once" : "deny";
    const record = (reader: ProjectionReader): NewEvent[] =>
      this.audit(
        reader,
        entry,
        {
          id,
          kind: approval.kind,
          projectId: approval.projectId,
          sessionId: approval.sessionId,
          orchestratorSessionId,
          decision,
          reason,
          title: approval.title,
          at: decidedAt,
          toolName: approval.toolName,
          inputDigest: entry.inputDigest,
        },
        responseDecision,
      );
    let decidedAt = new Date().toISOString();
    this.deciding.add(id);
    try {
      if (request) {
        await this.sessions.respond(
          request.sessionId,
          {
            requestId: request.requestId,
            response: {
              kind: "approval",
              decision: responseDecision,
              message: reason,
              decidedBy: "orchestrator",
            },
          },
          "user",
          { closeInbox: false },
        );
        decidedAt = new Date().toISOString();
        try {
          this.store.appendFrom(record);
        } catch (error) {
          this.inbox.closeForRequest(request.sessionId, request.requestId, {
            decision,
            decidedBy: "orchestrator",
            reason,
            auditFailed: true,
          });
          throw error;
        }
      } else if (cardId) {
        if (decision === "approve") await this.decisions.confirm(cardId, actor, record);
        else this.decisions.deny(cardId, actor, record);
      }
      return { id, decision, decidedAt };
    } finally {
      this.deciding.delete(id);
    }
  }

  private hasIndependentSession(sessionId: string | null, orchestratorSessionId: string): boolean {
    for (let steps = 0; steps < 20; steps++) {
      if (!sessionId || sessionId === orchestratorSessionId) return false;
      const found = this.repo.find(sessionId);
      if (!found || found.session.role === "orchestrator") return false;
      sessionId = found.session.parentSessionId;
      if (!sessionId) return true;
    }
    return false;
  }

  private entries(): Entry[] {
    const inbox = this.inbox.list({ status: "open", kinds: inboxKinds }, null);
    const approvals = inbox.flatMap<Entry>((item) => {
      switch (item.kind) {
        case "approval":
          return [this.fromTool(item)];
        case "question":
        case "spec_approval":
        case "checklist_approval":
          return [
            {
              approval: {
                ...this.context(item),
                kind: item.kind,
                reason: redactText(item.body ?? undefined),
                ...classifyApproval({ kind: item.kind }),
              },
            },
          ];
        default:
          return [];
      }
    });
    for (const card of this.decisions.pending()) {
      const kind = card.request.kind === "plan" ? "plan_card" : "github_card";
      const steps = card.request.kind === "plan" ? card.request.steps : undefined;
      approvals.push({
        cardId: card.id,
        approval: {
          id: `card:${card.id}`,
          kind,
          projectId: card.projectId,
          sessionId: card.sessionId,
          title: steps ? "Plan approval" : "GitHub approval",
          ...(steps
            ? { steps: steps.map((step) => ({ ...step, args: redactArgs(step.args) })) }
            : {}),
          ...(card.request.kind === "github" ? { target: card.request.target } : {}),
          ...classifyApproval({ kind, requestedBy: card.requestedBy, steps }),
        },
      });
    }
    return approvals;
  }

  private context({ id, projectId, sessionId, title, createdAt }: InboxItem) {
    return { id, projectId, sessionId, title: redactSecrets(title), createdAt };
  }

  private fromTool(inbox: InboxItem): Entry {
    const { sessionId, itemId, requestId } = inbox;
    const record =
      sessionId && requestId
        ? itemId
          ? this.repo.item(sessionId, itemId)
          : this.repo.approvalRequest(sessionId, requestId)
        : undefined;
    const item = record?.item;
    const kind = "tool_approval";
    if (
      item?.kind !== "approval_request" ||
      item.requestId !== requestId ||
      item.status !== "in_progress" ||
      !sessionId ||
      !requestId
    ) {
      return { approval: { ...this.context(inbox), kind, ...classifyApproval({ kind }) } };
    }
    const classification = classifyApproval({ ...item, kind });
    const session = this.repo.find(sessionId)?.session;
    const root = session?.worktreePath;
    const verified =
      !classification.delegable ||
      item.action !== "command" ||
      (((session?.provider === "claude" && item.toolName === "Bash") ||
        (session?.provider === "codex" && item.toolName === "shell")) &&
        !this.isRemote(sessionId) &&
        item.toolInput !== undefined &&
        root &&
        guardedReadCommand(item, item.cwd, root));
    return {
      request: { sessionId, requestId },
      inputDigest: createHash("sha256")
        .update(JSON.stringify(item.toolInput ?? item.command ?? null))
        .digest("hex"),
      approval: {
        ...this.context(inbox),
        kind,
        ...this.toolDetails(item),
        ...(verified ? classification : classifyApproval({ ...item, singleUse: true, kind })),
      },
    };
  }

  private toolDetails(item: ItemOf<"approval_request">) {
    return {
      command: redactText(item.command),
      cwd: redactText(item.cwd),
      reason: redactText(item.reason),
      hookReason: redactText(item.hookReason),
      toolName: redactText(item.toolName),
      toolInput: item.toolInput === undefined ? undefined : redactJson(item.toolInput),
      action: item.action,
    };
  }

  private audit(
    reader: ProjectionReader,
    entry: Entry,
    payload: OrchestratorApprovalDecision,
    responseDecision: "allow_once" | "deny",
  ): NewEvent[] {
    const { id, sessionId, projectId, decision, reason, title, orchestratorSessionId, at } =
      payload;
    const original = entry.request ? reader.getInbox(id) : undefined;
    const item: InboxItem = {
      id: `inbox:orchestrator-decision:${randomUUID()}`,
      kind: "automation_result",
      status: "resolved",
      priority: "low",
      notify: "factory",
      title: `Orchestrator ${decision === "approve" ? "approved" : "denied"}: ${title}`,
      body: reason,
      projectId,
      sessionId,
      threadId: original?.threadId ?? null,
      itemId: original?.itemId ?? null,
      requestId: null,
      issue: original?.issue ?? null,
      pr: original?.pr ?? null,
      automationRunId: original?.automationRunId ?? null,
      createdAt: at,
      updatedAt: at,
      resolvedAt: at,
      resolution: { by: "orchestrator", decision, reason, orchestratorSessionId },
    };
    const events: NewEvent[] = [
      { type: "approval.decided_by_orchestrator", sessionId: null, payload },
      { type: "inbox.created", sessionId, payload: { item } },
    ];
    if (original?.status === "open") {
      const resolved = closedItem(
        original,
        "resolved",
        {
          decision: responseDecision,
          decidedBy: "orchestrator",
          reason,
        },
        at,
      );
      events.push({ type: "inbox.updated", sessionId, payload: { item: resolved } });
    }
    return events;
  }
}
