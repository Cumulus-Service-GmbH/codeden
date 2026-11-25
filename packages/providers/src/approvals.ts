import {
  type AgentEvent,
  type AutonomyLevel,
  type ItemOf,
  type RuntimeResponse,
  sessionApprovalBlockReason,
} from "@codeden/contracts";
import { ProviderSessionError } from "./adapter";

/** Where an approval or question item lives. */
export interface ItemCtx {
  threadId: string;
  turnId: string;
}

type Request = ItemOf<"approval_request"> | ItemOf<"user_question">;

interface Pending {
  ctx: ItemCtx;
  item: Request;
  review: AnswerReview | undefined;
  resolve: (response: RuntimeResponse, decisionReason?: string) => void;
}

/** How the asker takes a response, when it has rules of its own (an MCP server's form). */
export interface AnswerReview {
  /** The provider independently verified a scoped read and can enforce its session grant. */
  allowSession?: true;
  /** Whether this request qualifies for automatic approval at the new level. */
  canAutoApprove?: (level: AutonomyLevel) => boolean;
  /** Canonicalize a response before validation and recording. */
  normalize?: (response: RuntimeResponse) => RuntimeResponse;
  /**
   * What doesn't fit in the response, if anything: `respond` rejects it with this message
   * (`invalid_answer`) and the request stays open, so nothing is sent until it fits.
   */
  problem?: (response: RuntimeResponse) => string | undefined;
  /** True when an answer turns the request down (a form's Decline): recorded as declined. */
  declines?: (response: RuntimeResponse) => boolean;
}

/**
 * Tracks `approval_request` / `user_question` items waiting on `ProviderSession.respond`.
 * Emits `item.started` when a request opens and `item.completed` with the decision when it is
 * answered, cancelled or aborted. Shared by all adapters.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  get size(): number {
    return this.pending.size;
  }

  /** Open a request and wait for its response. Resolves `{ kind: "cancel" }` if aborted. */
  request(
    ctx: ItemCtx,
    item: Request,
    signal?: AbortSignal,
    review?: AnswerReview,
  ): Promise<RuntimeResponse> {
    if (
      item.kind === "approval_request" &&
      item.options.includes("allow_session") &&
      (!review?.allowSession || sessionApprovalBlockReason(item))
    ) {
      item = { ...item, options: item.options.filter((option) => option !== "allow_session") };
    }
    return new Promise((resolve) => {
      const finish = (response: RuntimeResponse, decisionReason?: string) => {
        if (!this.pending.delete(item.requestId)) return;
        signal?.removeEventListener("abort", onAbort);
        const declined = response.kind === "answer" && review?.declines?.(response) === true;
        this.emit({
          type: "item.completed",
          ...ctx,
          item: completed(item, response, declined, decisionReason),
        });
        resolve(response);
      };
      const onAbort = () => finish({ kind: "cancel" });
      this.pending.set(item.requestId, { ctx, item, review, resolve: finish });
      this.emit({ type: "item.started", ...ctx, item });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Record a request CodeDen decided itself (`decidedBy: "policy"`): it shows in the transcript
   * as decided, and nothing waits on it.
   */
  record(ctx: ItemCtx, item: Request): void {
    this.emit({ type: "item.completed", ...ctx, item });
  }

  /**
   * Answer a pending request. Throws `unknown_request` for unknown ids, and `invalid_answer`
   * (leaving the request open) for a response its {@link AnswerReview} finds a problem with.
   */
  respond(requestId: string, answer: RuntimeResponse): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new ProviderSessionError("unknown_request", `Unknown request ${requestId}`);
    const response = pending.review?.normalize?.(answer) ?? answer;
    const problem =
      pending.review?.problem?.(response) ??
      (pending.item.kind === "approval_request" &&
      response.kind === "approval" &&
      response.decision === "allow_session"
        ? sessionApprovalBlockReason(pending.item)
        : undefined);
    if (problem) throw new ProviderSessionError("invalid_answer", problem);
    pending.resolve(response);
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Resolve pending approvals the provider policy allows at the raised level. */
  approvePendingForAutonomy(level: AutonomyLevel): void {
    for (const pending of this.pending.values()) {
      if (pending.item.kind !== "approval_request" || !pending.review?.canAutoApprove?.(level))
        continue;
      pending.resolve(
        { kind: "approval", decision: "allow_once", decidedBy: "policy" },
        "Auto-resolved by autonomy change.",
      );
    }
  }

  /** Cancel every pending request (interrupt, close). */
  cancelAll(): void {
    for (const pending of [...this.pending.values()]) pending.resolve({ kind: "cancel" });
  }
}

function completed(
  item: Request,
  response: RuntimeResponse,
  declined: boolean,
  decisionReason?: string,
): Request {
  if (item.kind === "approval_request") {
    if (response.kind === "approval") {
      return {
        ...item,
        status: response.decision === "deny" ? "declined" : "completed",
        decision: response.decision,
        decidedBy: response.decidedBy ?? "user",
        ...(decisionReason ? { decisionReason } : {}),
      };
    }
    return { ...item, status: "cancelled" };
  }
  if (response.kind === "answer") {
    return { ...item, status: declined ? "declined" : "completed", answers: response.answers };
  }
  return { ...item, status: "cancelled" };
}
