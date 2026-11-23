import { TeamRun } from "@codeden/contracts";
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

export function saveTeamRun(store: EventStore, run: TeamRun): void {
  store.append([
    { type: "team_run.updated", sessionId: null, payload: { run: TeamRun.parse(run) } },
  ]);
}
