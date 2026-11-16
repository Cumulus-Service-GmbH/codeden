import { seatAt, type WorkshopLayout } from "../scene/layout";
import type { Scene } from "../scene/scene-model";
import { figureStatus } from "./figure-look";
import { type FigureFrame, standing } from "./frames";

/** Every agent on the floor standing at its seat: the still scene, before anyone walks. */
export function seatFrames(scene: Scene, layout: WorkshopLayout): FigureFrame[] {
  const out: FigureFrame[] = [];
  for (const agent of scene.agents) {
    const at = scene.seating.seats.get(agent.key);
    const seat = at ? seatAt(layout, at.station, at.tile) : undefined;
    if (!seat || seat.offFloor) continue;
    out.push(
      standing(
        agent,
        figureStatus(agent),
        { x: seat.stand.x, y: seat.floorY, z: seat.stand.z },
        seat.desk !== null,
      ),
    );
  }
  return out;
}
