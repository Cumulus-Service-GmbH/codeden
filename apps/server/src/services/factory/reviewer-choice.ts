import {
  type FactoryItem,
  type FactoryTuning,
  type ReasoningEffort,
  teamMember,
} from "@codeden/contracts";
import { earliestUntil, type Unavailable, unavailableText, untilText } from "./availability";
import type { FactoryContext } from "./context";

export interface ReviewerChoice {
  wait: false;
  provider: string;
  model: string | null;
  effort?: ReasoningEffort;
  crossProvider: boolean;
  note: string | null;
}

export interface ReviewerWait {
  wait: true;
  note: string;
}

export interface ReviewerInput {
  author: { provider: string | null };
  tuning: Pick<FactoryTuning, "reviewerProvider" | "reviewerModel" | "reviewerFallback"> &
    Partial<Pick<FactoryTuning, "team">>;
  available: readonly string[];
  unavailable: ReadonlyArray<{ provider: string } & Unavailable>;
  vendor: (provider: string) => string | undefined;
  name?: (id: string) => string;
}

export function reviewAuthorProvider(ctx: FactoryContext, item: FactoryItem): string | null {
  const builder = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  return builder?.provider ?? item.builderProvider;
}

export function canReviewItem(ctx: FactoryContext, item: FactoryItem, reviewer: string): boolean {
  const author = reviewAuthorProvider(ctx, item);
  const vendor = author ? ctx.sessions.modelVendor(author) : undefined;
  const reviewerVendor = ctx.sessions.modelVendor(reviewer);
  return !!vendor && !!reviewerVendor && reviewerVendor !== vendor;
}

/** A review requires two known, distinct model vendors. */
export function pickReviewer(input: ReviewerInput): ReviewerChoice | ReviewerWait {
  const { author, tuning, available, unavailable, vendor } = input;
  const name = input.name ?? ((id: string) => id);
  const authorVendor = author.provider ? vendor(author.provider) : undefined;
  if (!authorVendor) return { wait: true, note: "Waiting: the author's model vendor is unknown." };
  if (!available.length) {
    return {
      wait: true,
      note: `Waiting: no review provider available${untilText(earliestUntil(unavailable))}`,
    };
  }
  const eligible = (id: string) => {
    const candidate = vendor(id);
    return candidate !== undefined && candidate !== authorVendor;
  };
  const other = available.filter(eligible);
  const preferred = (providers: readonly string[]) =>
    providers.find((id) => vendor(id) === "openai") ??
    providers.find((id) => vendor(id) === "anthropic") ??
    providers[0];
  const choose = (
    provider: string,
    model: string | null,
    note: string | null,
    effort?: ReasoningEffort | null,
  ): ReviewerChoice => ({
    wait: false,
    provider,
    model,
    ...(effort ? { effort } : {}),
    crossProvider: true,
    note,
  });

  const primary = teamMember(tuning.team, "reviewer");
  const wanted = primary?.provider ?? tuning.reviewerProvider;
  if (wanted === "auto" || !eligible(wanted)) {
    const provider = preferred(other);
    const note =
      wanted === "auto" ? null : `${name(wanted)} has no verified distinct model vendor.`;
    if (provider) return choose(provider, null, note);
  } else if (other.includes(wanted)) {
    return choose(wanted, primary ? primary.model : tuning.reviewerModel, null, primary?.effort);
  }

  const blocked =
    wanted === "auto"
      ? preferred(unavailable.map((item) => item.provider).filter(eligible))
      : eligible(wanted)
        ? wanted
        : undefined;
  const reason = blocked
    ? unavailableText(
        name(blocked),
        unavailable.find((item) => item.provider === blocked) ?? {
          reason: "not available",
          until: null,
        },
      )
    : "no reviewer with a verified distinct model vendor is available.";
  if (tuning.reviewerFallback === "any") {
    const fallback = teamMember(tuning.team, "reviewerFallback");
    if (fallback && other.includes(fallback.provider)) {
      return choose(fallback.provider, fallback.model, reason, fallback.effort);
    }
    const provider = preferred(other);
    if (provider) return choose(provider, null, reason);
  }
  return { wait: true, note: `Waiting: ${reason}` };
}
