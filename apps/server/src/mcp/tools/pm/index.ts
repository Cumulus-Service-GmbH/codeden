import { z } from "zod";
import { formatChecklist } from "../../../services/checklist/checklist-service";
import { type AnyServerTool, defineTool } from "../../define";
import { createAutomation, updateAutomation } from "./automation-edit";
import { listAutomations, reportTriage, runAutomation } from "./automations";
import { createIssue, getIssue, listIssues, triageIssue } from "./github";
import { messageOrchestrator, readProjectNotes, updateProjectNotes } from "./notes";
import { answerQuestion } from "./questions";
import { getSession } from "./session-detail";
import { listSessions, messageSession, startSession, stopSession } from "./sessions";
import {
  cancelQueuedRun,
  getProjectStatus,
  listScheduledRuns,
  pauseAutomation,
  resumeAutomation,
  skipNextRun,
} from "./status";

const readChecklist = defineTool({
  name: "read_checklist",
  description: "Read your project's checklist and completion.",
  roles: ["pm"],
  scope: "project",
  input: z.strictObject({}),
  handler: async (_input, { services, projectId }) =>
    formatChecklist(services.checklist.get(projectId)),
});

/**
 * Project manager tools (§8.3, §8.4). `ask_user` is shared with agents (`../ask-user`) and
 * `get_pr_status` with agents (`../github`).
 */
export const pmTools: AnyServerTool[] = [
  getProjectStatus,
  listSessions,
  getSession,
  startSession,
  messageSession,
  stopSession,
  answerQuestion,
  listScheduledRuns,
  skipNextRun,
  pauseAutomation,
  resumeAutomation,
  cancelQueuedRun,
  messageOrchestrator,
  readProjectNotes,
  readChecklist,
  updateProjectNotes,
  listIssues,
  getIssue,
  triageIssue,
  createIssue,
  listAutomations,
  runAutomation,
  createAutomation,
  updateAutomation,
  reportTriage,
];
