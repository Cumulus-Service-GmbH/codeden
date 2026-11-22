import type { TechDebtView } from "@codeden/contracts";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects } from "./schema-core";

export const projectTechDebt = sqliteTable("project_tech_debt", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id),
  view: text("view", { mode: "json" }).$type<TechDebtView>().notNull(),
});
