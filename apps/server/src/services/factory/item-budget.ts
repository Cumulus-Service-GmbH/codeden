import {
  type FactoryItem,
  type FactoryItemStage,
  type FactoryLimits,
  type FactoryLoop,
  hasItemBudget,
  itemBudgetReached,
  type Project,
} from "@codeden/contracts";
import type { FactoryContext } from "./context";
import { capSpendOf, itemTurns } from "./item-cost";
import { markStuck } from "./outcomes";
import { recoverable } from "./recover";
import { isBusy } from "./sessions";
import { BUILDER_FAILED_REASON } from "./turn-race";

/**
 * The per-item spend cap (`FactoryLimits.itemBudget`, §10.1). The daily budget only stops new
 * work, and work in flight moves on even while the loop is paused, so this is what keeps one
 * item from spending the day's budget by itself. Spend counts every session of the item since
 * it was last retried (`FactoryItem.itemBudgetSince`), from the usage ledger. It is checked as
 * the loop ticks, so an item can go over by what its sessions spend between two ticks.
 */

/** Stages whose items an agent may still work on or pick up: checked against the cap. */
const BUDGETED_STAGES: FactoryItemStage[] = ["backlog", "building", "verifying"];

/** "$5.00", "1,000,000 tokens" or both: what a retry gives an item. */
function allowance(limits: Pick<FactoryLimits, "itemBudget">): string {
  const { usd, tokens } = limits.itemBudget;
  return [
    usd !== undefined ? `$${usd.toFixed(2)}` : null,
    tokens !== undefined ? `${tokens.toLocaleString("en-US")} tokens` : null,
  ]
    .filter(Boolean)
    .join(" and ");
}

/** The reason an item over its cap fails with. */
export function itemBudgetReason(over: string): string {
  return `Spend cap reached: ${over} for this item`;
}

/**
 * Items in the queue, building or verifying (or failed, when the loop would put them back by
 * itself) that reached the per-item cap: their running sessions are stopped and they fail as
 * `stuck`, which reaches the inbox (a recorded decision in
 * a dark factory) and never counts toward the failure streak. Runs while paused or draining too:
 * work in flight moves on then. Nothing happens without a cap.
 */
export async function enforceItemBudgets(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const limits = project.factoryLimits;
  if (!hasItemBudget(limits) || !ctx.usage.turnsOf) return loop;
  const items = [
    ...ctx.store.items(project.id, BUDGETED_STAGES),
    // Failures the loop puts back by itself would start another turn: they stop here too.
    ...ctx.store.items(project.id, ["failed"]).filter(putBackByItself),
  ];
  if (items.length === 0) return loop;
  const turns = itemTurns(ctx, project.id, items);
  for (const item of items) {
    const spent = capSpendOf(turns.get(item.id) ?? [], item.itemBudgetSince);
    const over = itemBudgetReached(spent, limits);
    if (over) loop = await stopOverBudget(ctx, loop, item, over, limits);
  }
  return loop;
}

/**
 * A failed item the loop puts back by itself: a failure outside its code (`recover.ts`), or a
 * builder failed by a message racing its turn (`turn-race.ts`).
 */
function putBackByItself(item: FactoryItem): boolean {
  return (
    recoverable(item) || (item.reason === BUILDER_FAILED_REASON && item.builderSessionId !== null)
  );
}

async function stopOverBudget(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  over: string,
  limits: Pick<FactoryLimits, "itemBudget">,
): Promise<FactoryLoop> {
  for (const id of new Set([item.builderSessionId, item.reviewerSessionId])) {
    const session = id ? ctx.repo.find(id)?.session : undefined;
    if (session && isBusy(session)) await ctx.sessions.stop(session.id);
  }
  ctx.log?.(`factory: ${item.id}: stopped at its spend cap (${over})`);
  return markStuck(
    ctx,
    loop,
    item,
    itemBudgetReason(over),
    `Raise the per-item cap in the factory settings, or retry the item to give it a fresh ${allowance(limits)}.`,
  );
}

/**
 * Why a failed or escalated item is over its cap, or null: such an item starts no agent turn
 * (no rebase, integrator or re-review) until it is retried.
 */
export function overItemBudget(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): string | null {
  const limits = project.factoryLimits;
  if (!hasItemBudget(limits) || !ctx.usage.turnsOf) return null;
  const turns = itemTurns(ctx, project.id, [item]).get(item.id) ?? [];
  return itemBudgetReached(capSpendOf(turns, item.itemBudgetSince), limits);
}

/** The note on an item over its cap that the loop starts no agent turn for. */
export function overBudgetNote(over: string): string {
  return `${itemBudgetReason(over)}: the factory starts no agent work on it until it is retried`;
}
