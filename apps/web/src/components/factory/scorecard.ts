import type { FactoryScorecardRow, ScorecardAgent } from "@codeden/contracts";
import { shortDuration } from "@/components/factory-view/view-stats";
import { money, percent } from "@/components/usage/format";

/**
 * The factory scorecard's figures as the panel shows them (§10.1): who built or reviewed, and the
 * rates, averages and cost per merge of each row, with the same honest cost labels as the usage
 * reports.
 */

/** Which list the table shows: by builder, by reviewer, or by the two together. */
export type ScorecardView = "builders" | "reviewers" | "pairs";

/** A provider's display name (from the runner's list), by id. */
export type ProviderNames = (provider: string) => string;

/** "Claude · claude-opus-4-5", "Codex · default model", or "No review". */
export function agentLabel(agent: ScorecardAgent | null, names: ProviderNames): string {
  if (!agent) return "No review";
  return `${names(agent.provider)} · ${agent.model ?? "default model"}`;
}

/** The row's name in a view: its builder, its reviewer, or "builder → reviewer". */
export function rowLabel(row: FactoryScorecardRow, view: ScorecardView, names: ProviderNames) {
  if (view === "builders") return agentLabel(row.builder, names);
  if (view === "reviewers") return agentLabel(row.reviewer, names);
  return `${agentLabel(row.builder, names)} → ${agentLabel(row.reviewer, names)}`;
}

/** Share of the finished work that merged ("75%"); "—" with none. */
export function mergeRate(row: FactoryScorecardRow): string {
  return percent(row.finished > 0 ? row.merged / row.finished : null);
}

/** Share of the merges that needed no revise round ("67%"); "—" without a merge. */
export function firstPassRate(row: FactoryScorecardRow): string {
  return percent(row.merged > 0 ? row.firstPass / row.merged : null);
}

/** Revise rounds per finished item ("0.8"); "—" with none. */
export function reviseAverage(row: FactoryScorecardRow): string {
  return row.finished > 0 ? (row.reviseRounds / row.finished).toFixed(1) : "—";
}

/** Median time from intake to merge ("3h 10m"); "—" without a merge. */
export function medianMerge(row: FactoryScorecardRow): string {
  return row.medianMergeMs === null ? "—" : shortDuration(row.medianMergeMs);
}

/** "≈ $4.10" estimated, "$4.10" reported, "Not priced" when nothing could be, "—" without a merge. */
export function costPerMerge(row: FactoryScorecardRow): string {
  if (row.costPerMergeUsd === null) return "—";
  if (row.costUsd === 0 && row.unpricedTurns > 0) return "Not priced";
  return money(row.costPerMergeUsd, row.estimatedUsd > 0);
}

/**
 * What the cost per merge is: "API-equivalent cost per merge, failures included (estimated from
 * list prices): ≈ $61.60 over 15 items · 2 turns not priced".
 */
export function costPerMergeTitle(row: FactoryScorecardRow): string {
  const kind = row.apiEquivalent ? "API-equivalent cost per merge" : "Cost per merge";
  const estimated = row.estimatedUsd > 0 ? " (estimated from list prices)" : "";
  return [
    `${kind}, failures included${estimated}: ${money(row.costUsd, row.estimatedUsd > 0)} over ${row.finished} item${row.finished === 1 ? "" : "s"}`,
    row.unpricedTurns > 0 ? `${row.unpricedTurns} turns not priced` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
