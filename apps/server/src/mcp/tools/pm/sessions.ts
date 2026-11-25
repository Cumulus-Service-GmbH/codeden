import {
  defaultTeam,
  FACTORY_HOLD_REASON_MAX,
  messageFrom,
  PmStartSessionInput,
  resolveTeam,
  SessionStatus,
  SetSessionAutonomyInput,
  StartedBy,
  StartSessionRequest,
  sessionTeamMember,
  teamMember,
  teamRoleOfTitle,
} from "@codeden/contracts";
import { z } from "zod";
import { checklistStartItem } from "../../../services/checklist/start";
import type { AppServices } from "../../../services/container";
import { applyTeamRole } from "../../../services/factory/team-role";
import {
  assertAutonomy,
  resolveAutonomy,
  stricter,
} from "../../../services/sessions/autonomy-policy";
import { defineTool, type ToolAvailabilityContext, ToolError } from "../../define";
import { currentTurn } from "../../transcript";
import { agentSessionOf, compactSession, compactWork, projectFor } from "../shared/helpers";
import { describeProviderParam, fallbackProvider } from "../shared/provider-choices";
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

function canStartSessions(services: AppServices, caller?: ToolAvailabilityContext): boolean {
  if (!caller?.sessionId) return false;
  const row = services.sessionRepo.find(caller.sessionId);
  return row?.session.projectId === caller.projectId && row.startMeta?.teamArchitect === true;
}

/** `start_session` (§8.2, §8.4): start an agent session, with the conflict check built in. */
export const startSession = defineTool({
  name: "start_session",
  description:
    "Start an agent session in its own worktree to do one piece of work. Specify autonomy to request more supervision. The policy opens card-gated purposes as supervised by default. Always pass a workKey (issue:<n>, pr:<n>, automation:<name> or request:<slug>) and a one-line purpose; add scope (paths or area) when known. For an issue whose author isn't trusted (not a trusted author, not CodeDen's GitHub account, no write access), it starts only in a turn the user's own message started; otherwise it is refused and you put the issue in the user's inbox with report_triage (decision 'ready'). If matching work is already running or queued, nothing starts and the result is 'conflict' with the existing work: choose the resolution yourself and call again with conflict = {resolution: 'wait'} (queue behind it), {resolution: 'skip'} (it is the same work), {resolution: 'join', sessionId} (send the prompt to the existing session) or {resolution: 'force', reason}.",
  roles: ["pm", "agent"],
  isAvailable: (services, caller, role) => role === "pm" || canStartSessions(services, caller),
  scope: "project",
  alwaysLoad: true,
  // The loaded providers and whether each is ready, as of this listing.
  describeInput: describeProviderParam(
    "provider",
    "Leave it out to use the project's default provider when it is ready, else the default provider for agents in Settings when it is ready (when that is auto, the first ready provider in a fixed order); when none of them is ready, the call is refused with this list.",
    "An id that isn't loaded is refused while the runner is connected. A provider you name isn't checked for readiness: on one that isn't ready the session is created and then fails to start or fails its first turn, so pick one that is ready.",
  ),
  input: PmStartSessionInput,
  handler: async (input, { services, projectId, sessionId, caller, role: callerRole, signal }) => {
    if (callerRole !== "pm" && !canStartSessions(services, { projectId, sessionId })) {
      throw new ToolError("Only the PM or its delegated Team Architect can start a session.");
    }
    const project = projectFor(services, projectId);
    await assertMayStartOnIssues(services, { caller, sessionId }, project, issuesNamed(input));
    // `auto` names none, as for the session service. Joining or skipping starts nothing, so it
    // needs no provider.
    const named = input.provider === "auto" ? undefined : input.provider;
    const startsNothing =
      input.conflict?.resolution === "join" || input.conflict?.resolution === "skip";
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
    const settings = services.settings.get();
    const tuning = services.factory.data.loop(projectId)?.tuning;
    const { team } = resolveTeam({
      defaults: defaultTeam(settings),
      project: tuning?.team ?? [],
      session:
        callerSession && callerRow?.startMeta?.ownTeamPins
          ? sessionTeamMember(callerSession)
          : null,
    });
    const role = teamRoleOfTitle(input.title);
    const member = teamMember(team, role);
    const autonomyFloor = resolveAutonomy(
      role,
      input.purpose,
      settings.autonomy.pmPolicy,
      tuning?.autonomyPolicy,
    );
    assertAutonomy(input.autonomy, autonomyFloor);
    if (
      role === "arbiter" &&
      (!member?.model?.trim() || member.model.trim().toLowerCase() === "default")
    ) {
      throw new ToolError("TEAM_ROLE_UNSET: Set the Arbiter in Settings → Team");
    }
    // A tagged role the resolved Team does not set has no pin to start on: refused, as the guard refuses it.
    if (role && !member) {
      throw new ToolError(
        `TEAM_ROLE_UNSET: this project's Team (with the default Team) sets no ${input.title?.match(/^\[[^\]]+\]/)?.[0]}; set that role in CodeDen`,
      );
    }
    const models =
      member?.model && input.model ? services.factory.ctx.sessions.models(member.provider) : [];
    const { choice, mismatch } = applyTeamRole({ ...input, provider: named }, team, models);
    if (!choice) throw new ToolError(mismatch);
    const { model, effort } = choice;
    const provider =
      choice.provider ?? (startsNothing ? undefined : await fallbackProvider(services, project));
    const req = StartSessionRequest.parse({
      projectId,
      role: "agent",
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      autonomy: input.autonomy,
      purpose: input.purpose,
      workKey: input.workKey ?? (input.issueNumber ? `issue:${input.issueNumber}` : undefined),
      scope: input.scope,
      title: input.title,
      issue,
      startedBy: { kind: "pm", id: sessionId ?? undefined, reportTo: input.reportTo },
      parentSessionId: sessionId ?? undefined,
      tokenSaver: input.tokenSaver,
      // The brief is the session's first message: no sender line, but the transcript shows
      // it as the PM's.
      input: { text: input.prompt, from: "pm" },
      conflict: input.conflict,
    });
    const checklist = services.checklist?.get(projectId);
    const enforcing = checklist?.state === "approved" && checklist.enforce;
    const itemId = input.checklistItemId;
    const item = checklistStartItem(checklist, input.purpose, itemId);
    if (enforcing && !item) {
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
    const releaseLink =
      enforcing && item ? services.checklist.reserveLink(projectId, item) : undefined;
    if (enforcing && item && !releaseLink) {
      throw new ToolError(`Checklist item ${item.id} already has 200 active session links.`);
    }
    try {
      const result = await services.sessions.start(req, {
        autonomyFloor,
        // A PM grants the Architect delegation when choosing that role. A later title edit grants nothing.
        teamArchitect: callerRole === "pm" && role === "architect",
        ...(itemId ? { checklistItemId: itemId } : {}),
        // Pins the PM gave are this session's own; ones CodeDen filled from the Team are not.
        ...((input.provider && input.provider !== "auto") || input.model
          ? { ownTeamPins: true }
          : {}),
        confirmChrome: async () => {
          if (!sessionId) return "Chrome approval requires an active project manager session.";
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
          if (signal.aborted || outcome.status !== "answered" || outcome.by !== "user") {
            return "The owner did not approve the Chrome launch.";
          }
          const answers = outcome.answers.q1;
          return answers?.length === 1 && answers[0] === approve
            ? true
            : "The owner cancelled the Chrome launch.";
        },
      });
      let note = itemId && !item ? { note: `Unknown checklistItemId ${itemId} was ignored.` } : {};
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
          return { status: "skipped", message: result.reason, ...note };
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

/** Change a project agent's autonomy and record why the PM changed it. */
export const setSessionAutonomy = defineTool({
  name: "set_session_autonomy",
  description:
    "Change a project agent session's autonomy. Give a reason. The session's policy can require a more supervised level.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: SetSessionAutonomyInput,
  handler: async ({ sessionId, autonomy, reason }, ctx) => {
    const session = agentSessionOf(ctx.services, sessionId, ctx.projectId);
    if (!ctx.sessionId) throw new ToolError("An active PM session is required");
    if (ENDED.has(session.status) || session.archivedAt) {
      throw new ToolError("The agent session has ended.");
    }
    const { settings, factory, sessionRepo } = ctx.services;
    const currentFloor = resolveAutonomy(
      teamRoleOfTitle(session.title ?? undefined),
      session.purpose,
      settings.get().autonomy.pmPolicy,
      factory.data.loop(ctx.projectId)?.tuning.autonomyPolicy,
    );
    assertAutonomy(
      autonomy,
      stricter(currentFloor, sessionRepo.find(session.id)?.startMeta?.autonomyFloor),
    );
    const updated = await ctx.services.sessions.update(
      session.id,
      { autonomy },
      { changedBy: ctx.sessionId, reason },
    );
    return { sessionId, autonomy: updated.autonomy };
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
    if (session.status === "stopped") {
      throw new ToolError("Resuming a stopped session requires a confirmed orchestrator plan");
    }
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

/**
 * `stop_session` (§8.4, always loaded): stop one of the project's agents. A factory builder or
 * reviewer stopped with a reason stops its item as the PM's call, not as a failure (§10.1).
 */
export const stopSession = defineTool({
  name: "stop_session",
  description:
    "Stop one of this project's agent sessions (it can be resumed later). Use it for duplicates, runaway work or work that is no longer wanted; say why in reason. For a factory builder or reviewer, the reason (held, superseded, waiting on another PR) stops its item as your call: it never counts towards the factory's pause after failures in a row, and factory_retry_item runs it again later. Without a reason it counts as a failed item. To keep an issue from being started at all, use factory_hold_issue.",
  roles: ["orchestrator"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({
    sessionId: z.string().min(1),
    reason: z.string().max(FACTORY_HOLD_REASON_MAX).optional(),
  }),
  handler: async ({ sessionId, reason }, { services, projectId, role }) => {
    const session = agentSessionOf(services, sessionId, projectId);
    if (session.id !== sessionId) throw new ToolError("Use the full session ID");
    if (ENDED.has(session.status))
      throw new ToolError(`Session ${session.id} already ${session.status}`);
    // Recorded before the stop, so the loop never sees the stopped session without it.
    const why = reason?.trim();
    const item = why
      ? services.factory.recordStop(projectId, session.id, {
          reason: why,
          by: role === "orchestrator" ? "orchestrator" : "pm",
        })
      : null;
    let stopped: Awaited<ReturnType<typeof services.sessions.stop>>;
    try {
      stopped = await services.sessions.stop(session.id);
    } catch (error) {
      if (item) services.factory.recordStop(projectId, session.id, null);
      throw error;
    }
    return {
      status: stopped.status,
      sessionId: session.id,
      ...(item ? { factoryItemId: item.id } : {}),
    };
  },
});
