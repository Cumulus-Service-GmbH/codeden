import { StartTeamRun } from "@codeden/contracts";
import { type AnyServerTool, defineTool, ToolError } from "../../define";
import { projectFor } from "../shared/helpers";
import { createAutomation, updateAutomation } from "./automation-edit";
import { listAutomations, reportTriage, runAutomation } from "./automations";
import { createIssue, getIssue, listIssues, triageIssue } from "./github";
import { messageOrchestrator, readProjectNotes, updateProjectNotes } from "./notes";
import { answerQuestion } from "./questions";
import { getSession } from "./session-detail";
import {
  listSessions,
  messageSession,
  setSessionAutonomy,
  startSession,
  stopSession,
} from "./sessions";
import {
  cancelQueuedRun,
  getProjectStatus,
  listScheduledRuns,
  pauseAutomation,
  resumeAutomation,
  skipNextRun,
} from "./status";

const startTeamRun = defineTool({
  name: "start_team_run",
  description: "Start one Team run from an approved plan SHA or checklist ID.",
  roles: ["pm"],
  scope: "project",
  input: StartTeamRun,
  isAvailable: (services) => services.teamRuns !== undefined,
  handler: async (input, { services, projectId }) => {
    projectFor(services, projectId);
    if (!services.teamRuns) throw new ToolError("Team run integrations are unavailable");
    try {
      return await services.teamRuns.start(projectId, input);
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }
  },
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
  setSessionAutonomy,
  startTeamRun,
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
