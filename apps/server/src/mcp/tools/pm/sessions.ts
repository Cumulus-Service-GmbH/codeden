import {
  ChecklistItem,
  ConflictDecision,
  defaultTeam,
  messageFrom,
  ProviderId,
  ReasoningEffort,
  resolveTeam,
  SessionStatus,
  StartedBy,
  StartSessionRequest,
  sessionTeamMember,
  teamMember,
  teamRoleOfTitle,
  WorkKey,
} from "@codeden/contracts";
import { z } from "zod";
import { sameChecklistPurpose } from "../../../services/checklist/checklist-service";
import { applyTeamRole } from "../../../services/factory/team-role";
import { defineTool, ToolError } from "../../define";
import { currentTurn } from "../../transcript";
import { agentSessionOf, compactSession, compactWork, projectFor } from "../shared/helpers";
import { assertMayStartOnIssues, issuesNamed } from "./issue-trust";

const ENDED = new Set(["completed", "failed", "stopped"]);

/** `list_sessions` (§8.4, always loaded): the project's agent sessions. */
export const listSessions = defineTool({
  name: "list_sessions",
  description:
    "List this project's agent sessions, newest first, with work key, purpose, status, progress and result. Filter by status, workKey or who started them. Ended sessions (completed, failed, stopped) are left out unless includeEnded is true or you filter by status.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({
    status: z.array(SessionStatus).optional(),
    workKey: z.string().min(1).optional(),
    startedBy: StartedBy.shape.kind.optional(),
    includeEnded: z.boolean().optional(),
    limit: z.int().min(1).max(100).optional(),
  }),
  handler: async (input, { services, projectId }) => {
    const list = services.sessionRepo
      .list({ projectId, role: "agent", workKey: input.workKey, status: input.status })
      .filter((s) => !input.startedBy || s.startedBy.kind === input.startedBy)
      .filter((s) => input.status || input.includeEnded || !ENDED.has(s.status))
      .slice(0, input.limit ?? 20);
    const bytes = services.factory.data.loop(projectId)?.tuning.resultSummaryBytes ?? null;
    return {
      count: list.length,
      sessions: list.map((session) => compactSession(session, { summaryBytes: bytes })),
    };
  },
});

/** `start_session` (§8.2, §8.4): start an agent session, with the conflict check built in. */
export const startSession = defineTool({
  name: "start_session",
  description:
    "Start an agent session in its own worktree to do one piece of work. Always pass a workKey (issue:<n>, pr:<n>, automation:<name> or request:<slug>) and a one-line purpose; add scope (paths or area) when known. For an issue whose author isn't trusted (not a trusted author, not CodeDen's GitHub account, no write access), it starts only in a turn the user's own message started; otherwise it is refused and you put the issue in the user's inbox with report_triage (decision 'ready'). If matching work is already running or queued, nothing starts and the result is 'conflict' with the existing work: choose the resolution yourself and call again with conflict = {resolution: 'wait'} (queue behind it), {resolution: 'skip'} (it is the same work), {resolution: 'join', sessionId} (send the prompt to the existing session) or {resolution: 'force', reason}.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({
    prompt: z
      .string()
      .min(1)
      .max(50_000)
      .describe(
        "The brief for the agent: goal, context, acceptance criteria, and the decisions you already made (defaults, scope, whether to open a pull request), so the agent doesn't have to ask",
      ),
    purpose: z.string().trim().min(1).max(300),
    checklistItemId: ChecklistItem.shape.id
      .optional()
      .describe("The approved checklist item for this work, when applicable"),
    workKey: WorkKey.optional(),
    scope: z
      .object({ paths: z.array(z.string()).optional(), area: z.string().optional() })
      .optional(),
    title: z.string().trim().min(1).max(200).optional(),
    issueNumber: z.int().positive().optional(),
    provider: ProviderId.optional(),
    model: z.string().min(1).optional(),
    effort: ReasoningEffort.optional(),
    conflict: ConflictDecision.optional(),
    reportTo: z
      .enum(["orchestrator"])
      .optional()
      .describe(
        "'orchestrator' when the orchestrator passed this work on: its finish or failure also reaches the orchestrator, so it can tell the user",
      ),
  }),
  handler: async (input, { services, projectId, sessionId, caller, signal }) => {
    const project = projectFor(services, projectId);
    await assertMayStartOnIssues(services, { caller, sessionId }, project, issuesNamed(input));
    const issue =
      input.issueNumber && project.kind === "github"
        ? {
            number: input.issueNumber,
            url: `https://github.com/${project.github.owner}/${project.github.repo}/issues/${input.issueNumber}`,
          }
        : undefined;
    // The same Team the caller's Team file holds (and the guard checks): the caller's own role
    // choice over the project's Team over the default Team.
    const callerRow = sessionId ? services.sessionRepo.find(sessionId) : undefined;
    const callerSession = callerRow?.session;
    // The guard judged this start by the caller's Team file, which holds its own role layer: without
    // the caller's row that layer is unknown, so the start is refused rather than judged by another Team.
    if (sessionId && !callerSession) {
      throw new ToolError(
        `TEAM_UNRESOLVED: the calling session ${sessionId} could not be read for its Team`,
      );
    }
    const { team } = resolveTeam({
      defaults: defaultTeam(services.settings.get()),
      project: services.factory.data.loop(projectId)?.tuning.team ?? [],
      session:
        callerSession && callerRow?.startMeta?.ownTeamPins
          ? sessionTeamMember(callerSession)
          : null,
    });
    const role = teamRoleOfTitle(input.title);
    const member = teamMember(team, role);
    // A tagged role the resolved Team does not set has no pin to start on: refused, as the guard refuses it.
    // [Arbiter] is a Team role tag CodeDen does not resolve yet: refused like an unset role.
    const reserved = /^\[Arbiter\]/.test(input.title ?? "");
    if ((role && !member) || reserved) {
      throw new ToolError(
        `TEAM_ROLE_UNSET: this project's Team (with the default Team) sets no ${input.title?.match(/^\[[^\]]+\]/)?.[0]}; set that role in CodeDen`,
      );
    }
    const models =
      member?.model && input.model ? services.factory.ctx.sessions.models(member.provider) : [];
    const { choice, mismatch } = applyTeamRole(input, team, models);
    if (!choice) throw new ToolError(mismatch);
    const { provider, model, effort } = choice;
    const req = StartSessionRequest.parse({
      projectId,
      role: "agent",
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      purpose: input.purpose,
      workKey: input.workKey ?? (input.issueNumber ? `issue:${input.issueNumber}` : undefined),
      scope: input.scope,
      title: input.title,
      issue,
      startedBy: { kind: "pm", id: sessionId ?? undefined, reportTo: input.reportTo },
      parentSessionId: sessionId ?? undefined,
      // The brief is the session's first message: no sender line, but the transcript shows
      // it as the PM's.
      input: { text: input.prompt, from: "pm" },
      conflict: input.conflict,
    });
    const checklist = services.checklist?.get(projectId);
    if (checklist?.pending?.plan && !checklist.plan) {
      throw new ToolError("The reviewed plan is awaiting owner approval.");
    }
    const enforcing = checklist?.state === "approved" && checklist.enforce;
    const itemId = input.checklistItemId;
    const item = checklist?.items.find((entry) => entry.id === itemId);
    const known = item !== undefined;
    if (enforcing && !known) {
      if (itemId) throw new ToolError(`Unknown approved checklistItemId: ${itemId}.`);
      if (checklist.plan)
        throw new ToolError("Work outside the pinned plan requires a reviewed revision.");
      const expansionId = services.checklist.expansionForStart(
        projectId,
        project.name,
        input.purpose,
      );
      return {
        status: "approval_required",
        message: `Not in the approved plan: an expansion card is waiting for the owner. Once approved, start again with checklistItemId ${expansionId}.`,
      };
    }
    if (enforcing && item?.status === "done") {
      throw new ToolError(
        `Checklist item ${item.id} is done; ask the orchestrator for an expansion card.`,
      );
    }
    if (
      enforcing &&
      item?.startPurpose !== undefined &&
      !sameChecklistPurpose(item.startPurpose, input.purpose)
    ) {
      throw new ToolError(
        `Checklist item ${item.id} was approved for "${item.startPurpose}". Use the same purpose to start this item.`,
      );
    }
    const releaseLink =
      enforcing && item ? services.checklist.reserveLink(projectId, item) : undefined;
    if (enforcing && item && !releaseLink) {
      throw new ToolError(`Checklist item ${item.id} already has 200 active session links.`);
    }
    try {
      const result = await services.sessions.start(req, {
        // Pins the PM gave are this session's own; ones CodeDen filled from the Team are not.
        ...((input.provider && input.provider !== "auto") || input.model
          ? { ownTeamPins: true }
          : {}),
        confirmChrome: async () => {
          if (!sessionId || services.factory.isUnattended(sessionId)) return false;
          const approve = "Allow Chrome";
          const outcome = await services.questions.ask(
            sessionId,
            currentTurn(services, sessionId),
            {
              header: "Start with Claude in Chrome?",
              question: `Allow this session to connect to your browser? ${req.title?.replace(/\s+/g, " ")}`,
              options: [{ label: approve }, { label: "Cancel" }],
              allowFreeText: false,
              multiSelect: false,
            },
            signal,
            { waitOnly: true },
          );
          return (
            !signal.aborted &&
            outcome.status === "answered" &&
            outcome.by === "user" &&
            outcome.answers.q1?.length === 1 &&
            outcome.answers.q1[0] === approve
          );
        },
      });
      let note = itemId && !known ? { note: `Unknown checklistItemId ${itemId} was ignored.` } : {};
      if (item && (result.status === "started" || result.status === "queued")) {
        try {
          const session = services.sessionRepo.find(result.sessionId)?.session;
          if (!session || !services.checklist.link(projectId, item.id, session)) {
            const stillListed = services.checklist
              .get(projectId)
              ?.items.some(({ id }) => id === item.id);
            note = {
              note: stillListed
                ? `${result.status}, but the session could not be linked to item ${item.id}`
                : `${result.status}, but item ${item.id} is no longer in the approved plan: not linked`,
            };
          }
        } catch (error) {
          console.error(`[codeden] Checklist link failed for session ${result.sessionId}`, error);
          const message = error instanceof Error ? error.message : String(error);
          const status = result.status === "queued" ? "Queued" : "Started";
          note = { note: `${status}, but linking checklist item ${item.id} failed: ${message}` };
        }
      }
      switch (result.status) {
        case "started":
          return { status: "started", sessionId: result.sessionId, ...note };
        case "queued":
          return { status: "queued", sessionId: result.sessionId, behind: result.behind, ...note };
        case "skipped":
          return { status: "skipped", message: "Nothing was started.", ...note };
        case "joined":
          return {
            status: "joined",
            sessionId: result.sessionId,
            message: "Sent to the existing session.",
            ...note,
          };
        case "conflict":
          return {
            status: "conflict",
            message:
              "Matching work is already running or queued; nothing was started. Choose a resolution yourself and call start_session again with it: wait (queue behind it), skip (it is the same work), join with sessionId (it adds to that work) or force with a reason. Then say in one line what you chose.",
            existing: result.existing.map(compactWork),
            ...note,
          };
      }
    } finally {
      releaseLink?.();
    }
  },
});

/** `message_session` (§8.2): follow up with one of the project's agents. */
export const messageSession = defineTool({
  name: "message_session",
  description:
    "Send a message to one of this project's agent sessions (follow-up, correction, answer). Queued while it is busy unless whenBusy is 'steer' (inject into the running turn).",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({
    sessionId: z.string().min(1),
    text: z.string().min(1).max(50_000),
    whenBusy: z.enum(["queue", "steer"]).optional(),
  }),
  handler: async ({ sessionId, text, whenBusy }, { services, projectId }) => {
    const session = agentSessionOf(services, sessionId, projectId);
    const res = await services.sessions.send(
      session.id,
      {
        input: messageFrom("pm", text),
        whenBusy: whenBusy ?? "queue",
      },
      "pm",
    );
    return `Message ${res.status}.`;
  },
});

/** `stop_session` (§8.4, always loaded): stop one of the project's agents. */
export const stopSession = defineTool({
  name: "stop_session",
  description:
    "Stop one of this project's agent sessions (it can be resumed later). Use it for duplicates, runaway work or work that is no longer wanted; say why in reason.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({ sessionId: z.string().min(1), reason: z.string().max(500).optional() }),
  handler: async ({ sessionId }, { services, projectId }) => {
    const session = agentSessionOf(services, sessionId, projectId);
    if (ENDED.has(session.status))
      throw new ToolError(`Session ${session.id} already ${session.status}`);
    const stopped = await services.sessions.stop(session.id);
    return { status: stopped.status, sessionId: session.id };
  },
});
