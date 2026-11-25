import { TeamRun } from "@codeden/contracts";
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { teamRuns } from "../../db/schema";
import type { EventStore } from "../../events/store";

export function listTeamRuns(db: Db): TeamRun[] {
  return db
    .select({ run: teamRuns.run })
    .from(teamRuns)
    .all()
    .map(({ run }) => run);
}

export function listTeamRunsForSnapshot(db: Db): TeamRun[] {
  const status = sql`json_extract(${teamRuns.run}, '$.status')`;
  const active = db
    .select({ run: teamRuns.run })
    .from(teamRuns)
    .where(sql`${status} <> 'ready'`)
    .all();
  const ready = db
    .select({ run: teamRuns.run })
    .from(teamRuns)
    .where(sql`${status} = 'ready'`)
    .orderBy(sql`json_extract(${teamRuns.run}, '$.updatedAt') desc`, sql`rowid desc`)
    .limit(20)
    .all();
  return [...active, ...ready].map(({ run }) => run);
}

export function saveTeamRun(store: EventStore, run: TeamRun): void {
  store.append([
    { type: "team_run.updated", sessionId: null, payload: { run: TeamRun.parse(run) } },
  ]);
}
