import type { ProjectChecklist } from "@codeden/contracts";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects } from "./schema-core";

export const projectChecklists = sqliteTable("project_checklists", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id),
  checklist: text("checklist", { mode: "json" }).$type<ProjectChecklist>().notNull(),
  updatedAt: text("updated_at").notNull(),
});
