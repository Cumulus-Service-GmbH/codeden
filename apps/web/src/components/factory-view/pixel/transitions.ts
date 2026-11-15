import type { SceneAgent } from "../scene/agents";
import type { Scene } from "../scene/scene-model";
import type { Tile } from "../scene/stations";
import { frontOf, tileId } from "./floor";

/**
 * Pixel mode's moments (#264): what its floor acts out between two scenes, on its tile grid.
 * Pure, so the mapping is unit-tested; `motion.ts` plays them.
 */

/** A moment the floor acts out once, between two scenes. */
export type Transition =
  /** An agent walks from its old seat to its new one; a reviewer stamps the crate first. */
  | {
      kind: "move";
      key: string;
      from: Tile;
      to: Tile;
      carry: "crate" | null;
      stamp: boolean;
      /** It celebrates on arrival (its pull request merged). */
      celebrate: boolean;
    }
  /** A build started from the pile: the builder walks in carrying its ticket. */
  | { kind: "arrive"; key: string; to: Tile }
  /** The builder carries its PR crate to the reviewer's desk, then walks back to its bench. */
  | { kind: "handoff"; agent: SceneAgent; from: Tile; to: Tile }
  /** A merge: the crate rides up the conveyor and out of the shipping door. */
  | { kind: "ship"; row: number }
  /** A departed agent's pull request merged: a small celebration where it stood. */
  | { kind: "celebrate"; agent: SceneAgent; at: Tile }
  /** It failed: a puff of smoke and a slump (and the agent leaves for the repair bay). */
  | { kind: "fail"; agent: SceneAgent; at: Tile; stays: boolean };

const itemOf = (a: SceneAgent) => a.card?.item.id ?? null;

/**
 * The moments between the previous scene and this one. Nothing on the first scene, so opening
 * the view doesn't replay the day, and nothing when the same data comes again.
 */
export function sceneEvents(prev: Scene | null, next: Scene): Transition[] {
  if (!prev) return [];
  const out: Transition[] = [];
  const before = (key: string) => prev.seating.seats.get(key);
  const after = (key: string) => next.seating.seats.get(key);
  const prevByItem = new Map<string, SceneAgent>();
  for (const a of prev.agents) {
    const id = itemOf(a);
    if (id) prevByItem.set(id, a);
  }
  const nextKeys = new Set(next.agents.map((a) => a.key));
  const nextItems = new Set(next.agents.map(itemOf).filter(Boolean));
  const was = new Map(prev.agents.map((a) => [a.key, a]));

  for (const a of next.agents) {
    const to = after(a.key);
    if (!to) continue;
    const item = itemOf(a);
    const same = was.get(a.key);
    const from = same ? before(a.key) : undefined;
    if (same && from) {
      if (tileId(from.tile) !== tileId(to.tile)) {
        const handsOver = from.station === "review" && to.station === "merge";
        out.push({
          kind: "move",
          key: a.key,
          from: from.tile,
          to: to.tile,
          carry: handsOver ? "crate" : null,
          stamp: handsOver,
          celebrate: to.station === "ship",
        });
        if (from.station === "merge" && to.station === "ship")
          out.push({ kind: "ship", row: from.tile.r });
      }
      if (!same.failed && a.failed) out.push({ kind: "fail", agent: a, at: to.tile, stays: true });
      continue;
    }
    if (same || !item) continue;
    // The item's builder hands its pull request over to the new reviewer.
    const builder = prevByItem.get(item);
    const bench = builder ? before(builder.key) : undefined;
    if (builder?.role === "builder" && a.role === "reviewer" && bench) {
      out.push({ kind: "handoff", agent: builder, from: bench.tile, to: frontOf(to.tile) });
      continue;
    }
    if (a.role === "builder" && prev.tickets.ids.includes(item))
      out.push({ kind: "arrive", key: a.key, to: to.tile });
  }

  const merged = new Set(next.merged);
  const inBay = new Set(next.bay.flatMap((c) => c.entries.map((e) => e.card.item.id)));
  for (const b of prev.agents) {
    const item = itemOf(b);
    const seat = before(b.key);
    if (nextKeys.has(b.key) || !item || !seat || nextItems.has(item)) continue;
    if (merged.has(item)) {
      out.push({ kind: "celebrate", agent: b, at: seat.tile });
      if (seat.station === "merge") out.push({ kind: "ship", row: seat.tile.r });
    } else if (inBay.has(item)) out.push({ kind: "fail", agent: b, at: seat.tile, stays: false });
  }
  return out;
}
