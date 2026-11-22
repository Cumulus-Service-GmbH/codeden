import type { TeamRun } from "@codeden/contracts";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const teamRuns = sqliteTable("team_runs", {
  id: text("id").primaryKey(),
  run: text("run", { mode: "json" }).$type<TeamRun>().notNull(),
});
