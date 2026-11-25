import type { CardDecision, DecisionCard, EventOf, InboxItem, Session } from "@codeden/contracts";
import type { ProjectionReader } from "../../events/reducer/types";

export function cardDecided(
  data: CardDecision,
  recipient: Pick<Session, "projectId"> & {
    role: Session["role"];
    id: string | null;
  },
  options: { wake?: boolean; version?: string } = {},
): Omit<EventOf<"notice.created">, "seq" | "ts"> {
  return {
    type: "notice.created",
    sessionId: null,
    payload: {
      notice: {
        id: `card.decided:${data.cardId}${options.version ? `:${options.version}` : ""}`,
        type: "card.decided",
        target: recipient.role === "agent" ? "session" : recipient.role,
        projectId: recipient.projectId,
        sessionId: recipient.id,
        title: data.decision === "approve" ? "Approval granted" : "Approval denied",
        createdAt: data.decidedAt,
        deliveredAt: null,
        wake: options.wake ?? true,
        data,
      },
    },
  };
}

export function decisionCardNotice(card: DecisionCard, decision: CardDecision["decision"]) {
  const request = card.request;
  const target =
    request.kind === "github"
      ? request.target.kind === "merge_verify"
        ? { kind: request.target.kind, target: request.target }
        : { kind: request.target.kind, target: request.target }
      : { kind: request.kind, target: { actions: request.steps.map(({ action }) => action) } };
  return cardDecided(
    { ...target, cardId: card.id, decision, decidedAt: new Date().toISOString() },
    { id: card.sessionId, role: card.requestedBy, projectId: card.projectId },
  );
}

export function runtimeCardNotice(card: InboxItem, reader: ProjectionReader) {
  const { resolution, sessionId, itemId, requestId, resolvedAt } = card;
  if (
    card.kind !== "approval" ||
    card.status !== "resolved" ||
    !sessionId ||
    !itemId ||
    !requestId ||
    !resolvedAt ||
    !resolution ||
    typeof resolution !== "object" ||
    Array.isArray(resolution) ||
    resolution.decidedBy !== "user"
  )
    return undefined;
  const decision = resolution.decision;
  if (decision !== "deny" && decision !== "allow_once" && decision !== "allow_session") {
    return undefined;
  }
  const session = reader.getSession(sessionId)?.session;
  const item = reader.getItem(sessionId, itemId)?.item;
  if (!session || item?.kind !== "approval_request") return undefined;
  return cardDecided(
    {
      cardId: card.id,
      kind:
        item.hookAsk || item.hookReason || item.reason?.includes("[codeden-card")
          ? "guard"
          : "approval",
      decision: decision === "deny" ? "deny" : "approve",
      decidedAt: resolvedAt,
      target: { action: item.action, requestId },
    },
    session,
  );
}
