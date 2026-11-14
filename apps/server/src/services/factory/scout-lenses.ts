import type {
  DiscoveryArea,
  Project,
  ScoutLensRequest,
  ScoutState,
  Session,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import { claimSlot, SCOUT_SLOT } from "./slots";

/**
 * Starting the area reviewers the scout planned (§10.1). `factory_plan_round` only records the
 * plan; the loop starts the reviewers here, on its passes, as agent slots free up.
 */

/**
 * How long a round waits for its area reviewers: those that haven't started this long after the
 * scout planned never do (a round none started closes), and a round whose scout ended its turn
 * without planning closes once it has sat unplanned this long (the loop couldn't act on it).
 */
export const LENS_START_TIMEOUT_MS = 15 * 60_000;

/** The brief for one area reviewer (`firstRun`: a new session, not one woken again). */
export type LensBrief = (lens: ScoutLensRequest, firstRun: boolean) => string;

/**
 * Start or wake the planned area reviewers that get a free agent (the scout's come after all
 * other work waiting for one, `slots.ts`). A new reviewer's session starts in the background; an
 * idle one is woken without waiting, since that may resume it on the runner (recreating its
 * worktree first), which can take minutes under load. The round reviews once one has started.
 * Those not started `LENS_START_TIMEOUT_MS` after the plan are dropped. `closed` says why the
 * round closes when none started and none will, so the next round is scheduled instead of this
 * one sitting until its timeout.
 */
export async function startPlannedLenses(
  ctx: FactoryContext,
  project: Project,
  scout: ScoutState,
  now: Date,
  brief: LensBrief,
): Promise<{ scout: ScoutState; closed: string | null }> {
  const round = scout.round;
  const plan = round?.plan;
  if (!round || !plan) return { scout, closed: null };
  const at = now.toISOString();
  const lensSessions = { ...scout.lensSessions };
  const lenses = [...round.lenses];
  const waiting: DiscoveryArea[] = [];
  const failed: DiscoveryArea[] = [];
  for (const lens of plan.lenses.filter((l) => plan.pending.includes(l.area))) {
    const reuse = ctx.sessions.reusable(lensSessions[lens.area]);
    if (!claimSlot(ctx, project, "scout", SCOUT_SLOT, { wake: reuse?.id })) {
      waiting.push(lens.area);
      continue;
    }
    const sessionId = await startLens(ctx, project.id, lens.area, brief(lens, !reuse), reuse);
    if (!sessionId) {
      failed.push(lens.area);
      continue;
    }
    lensSessions[lens.area] = sessionId;
    lenses.push({ ...lens, sessionId, sentAt: at, reported: false, nudgedAt: null });
  }
  const late = now.getTime() - Date.parse(plan.at) > LENS_START_TIMEOUT_MS;
  const dropped = late ? waiting : [];
  if (dropped.length > 0) {
    ctx.log?.(`factory: area reviewers ${dropped.join(", ")}: no free agent within 15 minutes`);
  }
  const next = { ...scout, lensSessions };
  if (lenses.length === 0 && (late || waiting.length === 0)) {
    const areas = [...failed, ...dropped].join(", ");
    const why = late ? "no free agent within 15 minutes" : "their sessions failed to start";
    return { scout: next, closed: `Closed: couldn't start area reviewers (${areas}): ${why}.` };
  }
  const phase = lenses.length > 0 ? "reviewing" : round.phase;
  const pending = late ? [] : waiting;
  return {
    scout: { ...next, round: { ...round, phase, lenses, plan: { ...plan, pending } } },
    closed: null,
  };
}

/** Start a new area reviewer, or wake the idle one (not awaited); its session id, or null. */
async function startLens(
  ctx: FactoryContext,
  projectId: string,
  area: DiscoveryArea,
  text: string,
  reuse: Session | undefined,
): Promise<string | null> {
  try {
    if (reuse) {
      void ctx.sessions
        .message(reuse.id, text)
        .catch((error: unknown) =>
          ctx.log?.(`factory: waking area reviewer ${area}: ${errorMessage(error)}`),
        );
      return reuse.id;
    }
    const res = await ctx.sessions.startLens(projectId, area, text);
    return res.status === "started" || res.status === "queued" ? res.sessionId : null;
  } catch (error) {
    ctx.log?.(`factory: area reviewer ${area}: ${errorMessage(error)}`);
    return null;
  }
}
