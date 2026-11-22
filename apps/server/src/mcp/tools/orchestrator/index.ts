import type { AnyServerTool } from "../../define";
import { proposeChecklistPlan, updateChecklist } from "./checklist";
import { askPm, getOverview, listInbox, messagePm } from "./messaging";
import { createProject, listProjects, updateProject } from "./projects";

/** Orchestrator tools (§8.3). */
export const orchestratorTools: AnyServerTool[] = [
  getOverview,
  listProjects,
  createProject,
  updateProject,
  updateChecklist,
  proposeChecklistPlan,
  messagePm,
  askPm,
  listInbox,
];
