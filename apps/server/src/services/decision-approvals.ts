import { randomUUID } from "node:crypto";
import {
  DecisionCard,
  DecisionConfirmation,
  type DecisionConfirmationInput,
  type DecisionRequest,
  decisionTiers,
  type GitHubApprovalTarget,
  type GitHubCommentOutcome,
  type GitHubCommentResult,
  type NewEvent,
  OwnerApprovalWords,
  type PlanApprovalStep,
  redactSecrets,
} from "@codeden/contracts";
import { z } from "zod";
import type { ProjectionReader } from "../events/reducer/types";
import type { EventStore } from "../events/store";
import { errorMessage, ServiceError } from "./errors";
import { checkPlanStep } from "./plan-approval";

interface Actor {
  role: "pm" | "orchestrator" | "agent" | "owner";
  projectId: string | null;
  sessionId: string | null;
}

// Read legacy owner words verbatim so the GitHub posting boundary can validate them.
const StoredDecisionConfirmation = DecisionConfirmation.extend({
  ownerWords: z.string().optional(),
});

interface GithubApprovalPort {
  check(target: GitHubApprovalTarget): Promise<void>;
  post(
    target: GitHubApprovalTarget,
    cardId: string,
    ownerWords?: string,
  ): Promise<GitHubCommentOutcome>;
}

function refuse(message: string): never {
  throw new ServiceError(403, "decision_refused", message);
}

export function tierFor(action: string): number | undefined {
  return Object.hasOwn(decisionTiers, action)
    ? decisionTiers[action as keyof typeof decisionTiers]
    : undefined;
}

/** The orchestrator can decide a plan proposed by a PM and limited to tiers 0 and 1. */
export function isDelegablePlan(
  requestedBy: DecisionCard["requestedBy"] | undefined,
  steps: readonly PlanApprovalStep[] | undefined,
): boolean {
  return (
    requestedBy === "pm" &&
    !!steps?.length &&
    steps.every(({ action }) => {
      const tier = tierFor(action);
      return tier === 0 || tier === 1;
    })
  );
}

function canOrchestratorDecide(card: DecisionCard, actor: Actor): boolean {
  return (
    actor.role === "orchestrator" &&
    !!actor.sessionId &&
    actor.sessionId !== card.sessionId &&
    card.request.kind === "plan" &&
    isDelegablePlan(card.requestedBy, card.request.steps)
  );
}

export class DecisionApprovals {
  constructor(
    private readonly store: Pick<EventStore, "append" | "appendFrom" | "listTypes">,
    private readonly github: GithubApprovalPort,
  ) {}

  private cards() {
    const cards = new Map<
      string,
      {
        card: DecisionCard;
        confirmed: boolean;
        claimed: boolean;
        step: number;
        ownerWords?: string;
      }
    >();
    for (const event of this.store.listTypes([
      "decision.raised",
      "decision.confirmed",
      "decision.denied",
      "decision.step_consumed",
      "decision.github_claimed",
      "decision.github_post_result",
      "decision.github_stale",
    ])) {
      if (event.type === "decision.raised") {
        const card = DecisionCard.parse(event.payload);
        cards.set(card.id, { card, confirmed: false, claimed: false, step: 0 });
      } else if (event.type === "decision.confirmed") {
        const { id, by, ownerWords } = StoredDecisionConfirmation.parse(event.payload);
        const state = cards.get(id);
        if (state) {
          state.confirmed = true;
          if (by.role === "owner") state.ownerWords = ownerWords;
        }
      } else if (event.type === "decision.github_stale" || event.type === "decision.denied") {
        cards.delete((event.payload as { id: string }).id);
      } else if (event.type === "decision.github_claimed") {
        const state = cards.get((event.payload as { id: string }).id);
        if (state) state.claimed = true;
      } else if (event.type === "decision.github_post_result") {
        const { id, outcome } = event.payload as { id: string; outcome: GitHubCommentOutcome };
        const state = cards.get(id);
        if (state && outcome === "failed") state.claimed = false;
      } else if (event.type === "decision.step_consumed") {
        const state = cards.get((event.payload as { id: string }).id);
        if (state) state.step++;
      }
    }
    return cards;
  }

  pending(): DecisionCard[] {
    return [...this.cards().values()].filter((state) => !state.confirmed).map(({ card }) => card);
  }

  forRole(actor: Actor) {
    return [...this.cards().values()]
      .filter(
        ({ card, claimed }) =>
          !claimed &&
          (actor.role === "pm"
            ? card.projectId === actor.projectId
            : card.requestedBy === actor.role && card.sessionId === actor.sessionId),
      )
      .map(({ card, confirmed, step }) => ({ card, confirmed, nextStep: step }));
  }

  raise(actor: Actor, projectId: string, request: DecisionRequest): DecisionCard {
    if (!actor.sessionId || (actor.role !== "pm" && actor.role !== "orchestrator")) {
      refuse("A role session is required");
    }
    if (actor.role === "pm" && actor.projectId !== projectId) refuse("Wrong project");
    if (request.kind === "github" && actor.role !== "pm") refuse("The owning PM raises this card");
    if (
      request.kind === "plan" &&
      request.steps.some(({ action }) => tierFor(action) !== (actor.role === "pm" ? 0 : 1))
    ) {
      refuse("The requester lacks decision rights for a plan step");
    }
    const card = DecisionCard.parse({
      id: randomUUID(),
      projectId,
      sessionId: actor.sessionId,
      requestedBy: actor.role,
      request,
    });
    this.store.append([{ type: "decision.raised", sessionId: null, payload: card }]);
    return card;
  }

  async confirm(
    id: string,
    actor: Actor,
    record?: (reader: ProjectionReader) => NewEvent[],
    input?: DecisionConfirmationInput,
  ): Promise<void> {
    const state = this.cards().get(id);
    if (!state || state.confirmed) refuse("Approval card is unavailable or already used");
    const { card } = state;
    const by = this.confirmingActor(card, actor);
    if (card.request.kind === "github") {
      await this.checkGithub(id, card.request.target);
    }
    const ownerWords =
      by.role === "owner" &&
      card.request.kind === "github" &&
      card.request.target.kind === "merge_verify"
        ? input?.ownerWords
        : undefined;
    this.store.appendFrom((reader) => {
      const current = this.cards().get(id);
      if (!current || current.confirmed) refuse("Approval card is unavailable or already used");
      return [
        {
          type: "decision.confirmed",
          sessionId: null,
          payload: { id, by, ...(ownerWords === undefined ? {} : { ownerWords }) },
        },
        ...(record?.(reader) ?? []),
      ];
    });
  }

  private confirmingActor(card: DecisionCard, actor: Actor) {
    if (actor.role === "owner") return { role: "owner" as const };
    if (actor.sessionId && canOrchestratorDecide(card, actor)) {
      return { role: "orchestrator" as const, sessionId: actor.sessionId };
    }
    if (
      card.requestedBy === "orchestrator" &&
      actor.role === "pm" &&
      actor.sessionId &&
      actor.sessionId !== card.sessionId &&
      actor.projectId === card.projectId
    ) {
      return { role: "pm" as const, sessionId: actor.sessionId };
    }
    return refuse("This card requires the owner or its eligible second key");
  }

  deny(id: string, actor: Actor, record: (reader: ProjectionReader) => NewEvent[]): void {
    const { sessionId } = actor;
    this.store.appendFrom((reader) => {
      const current = this.cards().get(id);
      if (
        !current ||
        current.confirmed ||
        !sessionId ||
        !canOrchestratorDecide(current.card, actor)
      ) {
        refuse("An open PM plan card is required");
      }
      return [
        {
          type: "decision.denied",
          sessionId: null,
          payload: { id, by: { role: "orchestrator", sessionId } },
        },
        ...record(reader),
      ];
    });
  }

  async postGithub(id: string, actor: Actor): Promise<GitHubCommentResult | undefined> {
    const state = this.cards().get(id);
    if (
      actor.role !== "pm" ||
      !actor.sessionId ||
      !state?.confirmed ||
      state.card.projectId !== actor.projectId ||
      state.card.request.kind !== "github"
    ) {
      refuse("An unused owner approval for this project's GitHub gate is required");
    }
    const { target } = state.card.request;
    const { sessionId } = actor;
    const comment = target.kind === "merge_verify";
    const refusePost = (message: string): never => {
      if (comment) {
        this.store.append([
          {
            type: "decision.github_refused",
            sessionId,
            payload: { id, mode: "comment", outcome: "failed" },
          },
        ]);
      }
      refuse(message);
    };
    const unusedRequired = "An unused owner approval for this project's GitHub gate is required";
    if (state.claimed) refusePost(unusedRequired);
    if (comment) {
      if (state.ownerWords === undefined) refuse("The card has no recorded owner words");
      const words = OwnerApprovalWords.safeParse(state.ownerWords);
      if (!words.success) {
        refusePost(
          words.error.issues[0]?.message ?? "Owner words must match the owner words allowlist",
        );
      }
    }
    await this.checkGithub(id, target);
    // The claim stays used if the process stops before recording the outcome.
    const claim = this.store.appendFrom(() => {
      const current = this.cards().get(id);
      if (!current) refuse("Approval card is unavailable");
      return current.claimed
        ? []
        : [{ type: "decision.github_claimed", sessionId, payload: { id } }];
    });
    if (!claim.length) refusePost(unusedRequired);
    const outcome = await this.github.post(target, id, state.ownerWords);
    if (!comment) {
      this.store.append([{ type: "decision.github_posted", sessionId, payload: { id } }]);
      return;
    }
    const result = { mode: "comment", outcome } as const;
    this.store.append([
      {
        type: outcome === "posted" ? "decision.github_posted" : "decision.github_post_result",
        sessionId,
        payload: { id, ...result },
      },
    ]);
    return result;
  }

  private async checkGithub(id: string, target: GitHubApprovalTarget): Promise<void> {
    try {
      await this.github.check(target);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "stale_approval") {
        this.store.append([{ type: "decision.github_stale", sessionId: null, payload: { id } }]);
      }
      throw error;
    }
  }

  recordStepResult(
    id: string,
    sessionId: string | null,
    step: PlanApprovalStep,
    result: { ok: true } | { ok: false; error: unknown },
  ): void {
    this.store.append([
      {
        type: "decision.step_result",
        sessionId,
        payload: {
          id,
          step,
          ok: result.ok,
          ...(result.ok ? {} : { error: redactSecrets(errorMessage(result.error)) }),
        },
      },
    ]);
  }

  authorize(actor: Actor, projectId: string, step: PlanApprovalStep, cardId?: string): void {
    const tier = tierFor(step.action);
    if (tier === 2 && actor.role === "owner" && !cardId) return;
    if (tier === 0 && actor.role === "pm" && actor.projectId === projectId && !cardId) return;
    const expectedTier = actor.role === "pm" && actor.projectId === projectId ? 0 : 1;
    if (
      tier !== expectedTier ||
      (actor.role !== "pm" && actor.role !== "orchestrator") ||
      (tier === 1 && actor.role !== "orchestrator")
    ) {
      refuse("This session lacks decision rights for the step");
    }
    this.store.appendFrom(() => {
      const state = cardId ? this.cards().get(cardId) : undefined;
      if (
        !state?.confirmed ||
        state.card.sessionId !== actor.sessionId ||
        state.card.projectId !== projectId ||
        state.card.request.kind !== "plan" ||
        !checkPlanStep(state.card.request.steps, state.step, step)
      ) {
        refuse("The step requires a confirmed card matching its exact action and arguments");
      }
      return [
        {
          type: "decision.step_consumed",
          sessionId: actor.sessionId,
          payload: { id: state.card.id, step },
        },
      ];
    });
  }
}
