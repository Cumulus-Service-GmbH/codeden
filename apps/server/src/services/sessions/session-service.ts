import { randomUUID } from "node:crypto";
import type {
  AutonomyLevel,
  AutonomyPolicy,
  CompactSessionResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  HandoffSessionRequest,
  HandoffSessionResponse,
  JsonValue,
  ProviderInfo,
  QueuedMessage,
  QueueSender,
  RespondRequest,
  ReviewSessionRequest,
  ReviewSessionResponse,
  RoleDefaults,
  SendMessageRequest,
  SendMessageResponse,
  Session,
  SessionDetail,
  StartSessionRequest,
  StartSessionResponse,
  Team,
  TeamMember,
  UpdateSessionRequest,
  UserInput,
  WorkspaceRequest,
} from "@codeden/contracts";
import {
  AT_CAPACITY_CODE,
  defaultTeam,
  resolveTeam,
  teamMember,
  teamRoleOfTitle,
} from "@codeden/contracts";
import type { SandboxService } from "../../execution/sandboxes";
import type { McpTokenStore } from "../../mcp/tokens";
import type { SettingsStore } from "../../settings-store";
import type { ArtifactService } from "../artifacts";
import type { ChecklistService } from "../checklist/checklist-service";
import { checklistStartItem } from "../checklist/start";
import { badRequest, conflict, ServiceError } from "../errors";
import { isFactorySession } from "../factory/starter";
import type { InboxService } from "../inbox-service";
import { projectDefaultProvider } from "../projects/project-config";
import type { ProjectService } from "../projects/project-service";
import type { ProjectRedetector } from "../projects/redetector";
import {
  type RunnerDeps,
  type RunnerPort,
  runnerErrorCode,
  runnerForSession,
  toServiceError,
} from "../runner-port";
import type { UtilityService } from "../utility";
import type { SessionAdmission } from "./admission";
import { assertProjectActive, inArchivedProject } from "./archived-project";
import { assertAutonomy, policyFloorForSession, stricter } from "./autonomy-policy";
import { freezeChecks, roundAfter, withRound } from "./checks";
import { compactingRefusal, compactionRunning, compactRefusal, startCompaction } from "./compact";
import { derivePurpose, deriveWorkKey, findConflicts, firstPurposeLine } from "./conflicts";
import { planFork } from "./fork";
import { planHandoff } from "./handoff";
import type { InputDecorator } from "./input-decorator";
import type { LaunchFork, SessionLauncher } from "./launcher";
import type { Outbox } from "./outbox";
import { isTransientRunnerError, isTurnRunningError, OutboxHolds } from "./outbox-holds";
import {
  planModeUnsupported,
  readOnlyUnsupported,
  securityRulesUnenforced,
  supervisedUnsupported,
} from "./permissions";
import { deliverPriority } from "./priority-delivery";
import { autoOrder } from "./provider-order";
import type { QuestionBroker, ResponseActor } from "./questions";
import { applyPendingConfig, assertConfigRevision, updateSession } from "./reconfigure";
import { type AutonomyAudit, emptyStartMeta, type SessionRepo, type StoredStartMeta } from "./repo";
import { planReview } from "./review";
import { retireRoleSession } from "./role-retire";
import { startWorkspace } from "./start-workspace";
import { withTeamRole } from "./team-start";

export interface SessionServiceDeps extends RunnerDeps {
  forceFakeProvider?: boolean;
  repo: SessionRepo;
  admission?: SessionAdmission;
  projects: ProjectService;
  projectTeam?: (projectId: string, teamId?: string) => Team;
  projectAutonomyPolicy?: (projectId: string) => AutonomyPolicy | undefined;
  checklist?: Pick<ChecklistService, "get">;
  inbox: InboxService;
  artifacts: ArtifactService;
  settings: SettingsStore;
  launcher: SessionLauncher;
  outbox: Outbox;
  questions: QuestionBroker;
  /** Revokes a stopped session's MCP tokens. */
  tokens: Pick<McpTokenStore, "revokeSession">;
  /** Writes the summary in a handoff's brief (§7.4); without it the brief quotes the last reply. */
  utility?: Pick<UtilityService, "handoffSummary">;
  /** Wait before retrying a queued message the runner could not take (default 30 s). */
  outboxRetryMs?: number;
  /** Refuses starts a project's sandboxes can't host (`docs/remote-runners.md` §8). */
  sandboxes?: Pick<SandboxService, "assertStartable" | "wants">;
  /**
   * Brings a project's record up to date with its folder (`isGitRepo`) when the start-up check
   * hasn't reached it yet (#425). Without it, starts trust the record as it is.
   */
  projectChecks?: Pick<ProjectRedetector, "current">;
}

/** What the session service needs from the checks loop (`ChecksLoop`). */
export interface CheckRuns {
  /** End the session's check run; true when one was running. */
  cancel(sessionId: string, outcome: "stopped" | "superseded"): Promise<boolean>;
  /** Whether checks are running for the session now. */
  isRunning(sessionId: string): boolean;
}

const BUSY = new Set(["running", "waiting"]);
/** Messages from these senders can start a turn without a global session slot. */
const PRIORITY_SENDERS = new Set<QueueSender>(["user", "pm", "orchestrator"]);
const NOT_STARTED = new Set(["created", "queued", "starting"]);
/** Statuses in which the next queued message is delivered. */
const FLUSHABLE = new Set(["idle", "interrupted", "failed"]);
/** Final outcomes a stop never rewrites: the session's status keeps saying what happened. */
const FINISHED = new Set(["completed", "failed", "stopped"]);

/**
 * Agent sessions: start (with the §8.4 conflict check), messages, steering, interrupts,
 * approvals and stop. Starts return immediately; the runner work happens in the background
 * and shows up through the event stream.
 */
export class SessionService {
  /** Background launches, so tests and shutdown can await them. */
  readonly launching = new Map<string, Promise<void>>();
  /** Rewrites a turn's input at send time (the orchestration status digest, §8.4). */
  private inputDecorator: InputDecorator | undefined;
  private checkRuns: CheckRuns | undefined;
  private readonly holds: OutboxHolds;
  /**
   * Sessions with a turn on its way to the runner (between the status check and the runner's
   * answer). Another message for one of them waits in the queue instead of racing it into a
   * second turn.
   */
  private readonly delivering = new Set<string>();
  private readonly priorityWaits = new Map<
    string,
    { controller: AbortController; pending: number }
  >();

  constructor(private readonly deps: SessionServiceDeps) {
    this.holds = new OutboxHolds({
      retryMs: deps.outboxRetryMs,
      onRetry: (id) => {
        this.deps.admission?.scheduleDrain();
        void this.flushOutbox(id).catch(() => undefined);
      },
    });
  }

  setInputDecorator(fn: InputDecorator): void {
    this.inputDecorator = fn;
  }

  /** The checks loop (§9 Project checks): Stop and new messages end a check run. */
  setCheckRuns(runs: CheckRuns): void {
    this.checkRuns = runs;
  }

  /**
   * Model and effort (applied on the next turn), autonomy and plan mode (pushed to the runner)
   * or title. The owner can override the autonomy floor. Agents must respect it.
   */
  update(id: string, req: UpdateSessionRequest, audit?: AutonomyAudit): Promise<Session> {
    const session = this.deps.repo.get(id);
    assertRoleWritable(session);
    if (!(audit && "owner" in audit)) {
      assertAutonomy(req.autonomy, this.deps.repo.find(id)?.startMeta?.autonomyFloor);
    }
    if (req.untilChecksPass !== undefined || req.checkRounds !== undefined) {
      if (session.role !== "agent" || !session.checks?.commands.length) {
        throw badRequest(
          "This session has no project checks: add `checks` to .codeden/project.json and start a new session",
          "no_checks",
        );
      }
    }
    if (req.autonomy === "supervised") {
      this.assertSupervisedSupported(session.provider, req.autonomy, id);
    }
    if (req.autonomy === "read_only" || req.planMode !== undefined) {
      if (req.autonomy === "read_only") {
        this.assertReadOnlySupported(session.role, session.provider, req.autonomy, id);
      }
      if (req.planMode !== undefined) {
        this.assertPlanModeSupported(session.role, session.provider, id);
      }
    }
    return updateSession(this.deps.repo, this.runnerOf(id), id, req, audit);
  }

  /**
   * Reject the `read_only` level on a provider that cannot enforce it (§11.2), as loaded by the
   * session's runner (the home runner for a session not made yet).
   */
  private assertReadOnlySupported(
    role: Session["role"],
    providerId: string,
    level: AutonomyLevel,
    sessionId?: string,
  ) {
    const problem = readOnlyUnsupported(role, level, this.provider(providerId, sessionId));
    if (problem) throw badRequest(problem, "read_only_unsupported");
  }

  /**
   * Reject a new session whose provider its project doesn't allow (the machine's security rules
   * aren't enforced for it and the project hasn't allowed such providers), for every role, or
   * that would run `supervised` on a provider that can't enforce it.
   */
  private assertProviderAllowed(
    session: Session,
    workspace: WorkspaceRequest,
    existing?: Session,
    guardedInstall?: boolean,
  ): void {
    const project = session.projectId ? this.deps.projects.get(session.projectId) : null;
    const provider = this.provider(session.provider, existing?.id);
    if (existing && !provider) {
      throw new ServiceError(
        503,
        "runner_unavailable",
        "The runner isn't connected, so the session's provider can't be checked yet. Try again in a moment.",
      );
    }
    // A worktree session runs in a CodeDen worktree (the runner checks the real folder too).
    const inWorktree = workspace.mode === "worktree";
    const unenforced = securityRulesUnenforced(
      provider,
      guardedInstall ? null : project,
      session.role,
      inWorktree,
    );
    if (unenforced) throw badRequest(unenforced, "security_rules_unenforced");
    this.assertSupervisedSupported(session.provider, session.autonomy, existing?.id);
    this.assertReadOnlySupported(session.role, session.provider, session.autonomy, existing?.id);
  }

  /** Reject `supervised` on a provider that can't enforce it (`capabilities.supervised`). */
  private assertSupervisedSupported(providerId: string, level: AutonomyLevel, sessionId?: string) {
    const problem = supervisedUnsupported(level, this.provider(providerId, sessionId));
    if (problem) throw badRequest(problem, "supervised_unsupported");
  }

  /** Reject plan mode for role sessions and on providers without `capabilities.planMode`. */
  private assertPlanModeSupported(role: Session["role"], providerId: string, sessionId?: string) {
    const problem = planModeUnsupported(role, this.provider(providerId, sessionId));
    if (problem) throw badRequest(problem, "plan_mode_unsupported");
  }

  detail(id: string): SessionDetail {
    const found = this.deps.repo.find(id);
    if (!found) this.missing(id);
    return {
      session: found.session,
      usage: found.usage,
      followups: this.deps.repo.latestFollowups(found.session),
      startMeta: this.deps.repo.publicStartMeta(found.startMeta),
      queuedMessages: this.deps.outbox.count(id),
    };
  }

  async start(
    req: StartSessionRequest,
    options: {
      confirmChrome?: () => Promise<boolean | string>;
      chromeApproved?: true;
      checklistItemId?: string;
      /** A role conversation this one replaces ("Start fresh"): archived as this one starts. */
      replacesRoleId?: string;
      /**
       * The caller chose this session's provider or model itself (not filled from the Team): only
       * then is it the session's own layer of its Team (`sessionTeamMember`).
       */
      ownTeamPins?: boolean;
      runTeam?: Team;
      teamId?: string;
      teamSession?: TeamMember | null;
      autonomyFloor?: AutonomyLevel;
      readOnlyScope?: boolean;
      guardedInstall?: boolean;
      teamArchitect?: boolean;
    } = {},
  ): Promise<StartSessionResponse> {
    const { repo, projects } = this.deps;
    const ownTeamPins =
      options.ownTeamPins ??
      (req.startedBy.kind === "user" &&
        Boolean((req.provider && req.provider !== "auto") || req.model || req.effort));
    // The workspace follows `isGitRepo`: read it once the folder has been checked since start.
    if (req.projectId) await this.deps.projectChecks?.current(req.projectId);
    const project = req.projectId ? projects.get(req.projectId) : null;
    const pmStart = req.startedBy.kind === "pm";
    const floor = stricter(
      options.autonomyFloor,
      pmStart && project?.autonomy === "read_only" ? "read_only" : undefined,
    );
    assertAutonomy(req.autonomy, floor);
    if (project?.archivedAt) throw badRequest("The project is archived", "project_archived");
    if (!project && req.role !== "orchestrator") {
      throw badRequest("projectId is required for this role", "project_required");
    }
    if (project && req.role === "agent") {
      const checklist = this.deps.checklist?.get(project.id);
      if (checklist?.plan) {
        checklistStartItem(
          checklist,
          req.purpose ?? firstPurposeLine(req.input?.text),
          options.checklistItemId,
          true,
        );
      }
    }
    const roleSettings = this.roleSettings(req.role, req.projectId, options.teamId);
    const selectedRole = req.teamRole ?? teamRoleOfTitle(req.title);
    if (selectedRole) {
      req = withTeamRole(req, {
        defaults: defaultTeam(this.deps.settings.get()),
        project: project ? (this.deps.projectTeam?.(project.id, options.teamId) ?? []) : [],
        session: options.teamSession,
        approved: options.runTeam,
      });
    } else if (
      req.role !== "agent" &&
      roleSettings.provider !== "auto" &&
      (!req.provider || req.provider === "auto")
    ) {
      req = {
        ...req,
        provider: roleSettings.provider,
        model: req.model ?? roleSettings.model ?? undefined,
        effort: req.effort ?? roleSettings.effort ?? undefined,
      };
    }
    if (this.deps.forceFakeProvider && req.provider !== "fake") {
      req = { ...req, provider: "fake", model: undefined, effort: undefined, chrome: undefined };
    }
    const previous = options.replacesRoleId
      ? this.roleToArchive(options.replacesRoleId)
      : undefined;
    // Refused before the conflict check: a worktree that can't be made is never queued either.
    const workspace = startWorkspace(req.workspace, project);
    const browserOperator =
      req.role === "agent" && req.startedBy.kind === "pm" && selectedRole === "browserOperator";
    const browserProvider = browserOperator
      ? this.resolveProvider(req, project ? projectDefaultProvider(project) : null)
      : undefined;
    const browserInfo = browserProvider ? this.provider(browserProvider) : undefined;
    if (
      browserProvider &&
      (!browserInfo || browserInfo.capabilities.chrome) &&
      !options.chromeApproved
    ) {
      const confirmation = await options.confirmChrome?.();
      if (confirmation !== true) {
        return {
          status: "skipped",
          reason:
            typeof confirmation === "string" ? confirmation : "Chrome requires owner approval.",
        };
      }
      // Recheck the project and conflicts after waiting for the user, with the provider fixed.
      return this.start(
        { ...req, provider: browserProvider },
        {
          ...options,
          chromeApproved: true,
        },
      );
    }
    const purpose = derivePurpose(req.purpose, req.input?.text);
    const workKey = deriveWorkKey({
      workKey: req.workKey,
      issueNumber: req.issue?.number,
      purpose,
    });
    const scope = { projectId: req.projectId, ...req.scope };

    const conflicts = findConflicts({ workKey, scope }, repo.activeWork(req.projectId));
    let queuedBehind: string[] = [];
    let forced: StoredStartMeta["forced"] = null;
    if (conflicts.length > 0) {
      const decision = req.conflict;
      if (!decision) return { status: "conflict", existing: conflicts };
      switch (decision.resolution) {
        case "skip":
          return { status: "skipped", reason: "The conflicting session start was skipped." };
        case "join": {
          const target = repo.get(decision.sessionId);
          if (target.projectId !== req.projectId) {
            throw badRequest("Can only join a session in the same project", "join_mismatch");
          }
          const meta = repo.find(target.id)?.startMeta;
          const joinFloor = stricter(floor, req.autonomy);
          const keptFloor = stricter(meta?.autonomyFloor, joinFloor);
          assertAutonomy(target.autonomy, keptFloor);
          if (options.readOnlyScope || options.guardedInstall) {
            if (options.readOnlyScope && !meta?.readOnlyScope) {
              throw badRequest("Join requires a session with a read-only scope", "join_mismatch");
            }
            if (options.guardedInstall && !meta?.guardedInstall) {
              throw badRequest("Join requires a guarded install session", "join_mismatch");
            }
            this.assertProviderAllowed(
              target,
              { mode: target.worktreePath ? "worktree" : "repo_root" },
              target,
              options.guardedInstall,
            );
            if (options.readOnlyScope) {
              this.assertReadOnlySupported(target.role, target.provider, "read_only", target.id);
            }
          }
          if (keptFloor !== meta?.autonomyFloor) {
            repo.setStartMeta(target.id, (meta) => ({
              ...(meta ?? emptyStartMeta()),
              autonomyFloor: stricter(meta?.autonomyFloor, joinFloor),
            }));
          }
          if (req.input) {
            await this.send(target.id, { input: req.input, whenBusy: "queue" }, req.startedBy.kind);
          }
          return { status: "joined", sessionId: target.id };
        }
        case "wait":
          queuedBehind = decision.behindId ? [decision.behindId] : conflicts.map((c) => c.id);
          break;
        case "force":
          forced = { reason: decision.reason, conflictsWith: conflicts.map((c) => c.id) };
          break;
      }
    }

    const session = this.buildSession(req, project, roleSettings, floor, {
      purpose,
      workKey,
      scope,
      queued: queuedBehind.length > 0,
    });
    if (
      req.chrome &&
      (session.startedBy.kind !== "user" ||
        session.role !== "agent" ||
        (project?.execution.backend ?? "local") !== "local" ||
        !this.provider(session.provider)?.capabilities.chrome)
    ) {
      throw badRequest(
        "Chrome requires a user-started local agent with Chrome support",
        "chrome_unavailable",
      );
    }
    const queued = this.createAndLaunch(
      session,
      {
        workspaceMode: workspace.mode,
        workspaceFallback: null,
        forced,
        queuedBehind,
        chromeOptIn: options.chromeApproved,
        chromeRequested: req.chrome,
        ...(options.teamArchitect ? { teamArchitect: true } : {}),
        ...(floor ? { autonomyFloor: floor } : {}),
        ...(options.readOnlyScope ? { readOnlyScope: true } : {}),
        ...(options.guardedInstall ? { guardedInstall: true } : {}),
        ...(pmStart ? { autonomyChoice: req.autonomy ?? null } : {}),
        ...(ownTeamPins ? { ownTeamPins: true as const } : {}),
        ...(options.teamId ? { teamId: options.teamId } : {}),
        ...(options.runTeam ? { runTeam: options.runTeam } : {}),
        ...(req.tokenSaver ? { tokenSaver: req.tokenSaver } : {}),
        ...(req.role !== "agent" && {
          roleProvider: roleSettings.provider,
          roleModel: roleSettings.model,
          roleEffort: roleSettings.effort,
        }),
      },
      workspace,
      req.input,
      undefined,
      previous,
    );
    if (previous) {
      // Archived with the new one's creation: it doesn't run on, even while that one waits.
      void retireRoleSession(
        {
          stop: (id) => this.stop(id, { confirm: true }),
          revokeTokens: (id) => this.deps.tokens.revokeSession(id),
        },
        previous.id,
      );
    }
    return queued
      ? { status: "queued", sessionId: session.id, behind: queuedBehind }
      : { status: "started", sessionId: session.id };
  }

  private roleToArchive(id: string): Session {
    const session = this.deps.repo.get(id);
    assertRoleWritable(session);
    if (BUSY.has(session.status) || NOT_STARTED.has(session.status) || this.delivering.has(id)) {
      throw conflict("Wait for the current turn to finish", "turn_running");
    }
    if (this.deps.repo.hasOpenRequest(id)) {
      throw conflict("Answer or dismiss the open question first", "question_open");
    }
    if (this.deps.outbox.count(id) > 0) {
      throw conflict("Wait for queued messages to be delivered", "messages_queued");
    }
    const now = new Date().toISOString();
    return {
      ...session,
      status: FINISHED.has(session.status) ? session.status : "stopped",
      endedAt: session.endedAt ?? now,
      archivedAt: now,
      updatedAt: now,
    };
  }

  private createAndLaunch(
    session: Session,
    meta: StoredStartMeta,
    workspace: WorkspaceRequest,
    input?: UserInput,
    fork?: LaunchFork,
    archived?: Session,
  ): boolean {
    const { admission, repo } = this.deps;
    // Every new session (a start, a fork, a handoff to another provider) passes here.
    this.assertProviderAllowed(session, workspace, archived, meta.guardedInstall);
    if (meta.readOnlyScope) {
      this.assertReadOnlySupported(session.role, session.provider, "read_only");
    }
    const waitingForConflict = session.status === "queued";
    const waitingForSlot = !waitingForConflict && !this.reserve(session);
    try {
      if (waitingForConflict || waitingForSlot) {
        repo.create(
          { ...session, status: "queued" },
          {
            ...meta,
            // A pending start keeps pasted images as artifacts, like a queued message.
            pending: { workspace, input: input && this.externalize(session, input), fork },
          },
          archived,
        );
        if (waitingForSlot) admission?.enqueue(session.id);
        return true;
      }
      repo.create(session, { ...meta, pending: null }, archived);
      this.launchInBackground(session.id, input, workspace, fork);
      return false;
    } finally {
      if (!this.launching.has(session.id)) admission?.release(session.id);
    }
  }

  private reserve(session: Session): boolean {
    return (
      isFactorySession(session) ||
      (this.deps.admission?.tryReserve(session.id, session.role) ?? true)
    );
  }

  /**
   * Fork an agent session (§9): a new session with a copy of its conversation, in a new
   * worktree started from its latest checkpoint, or from a named turn's ("Fork from here",
   * `fork.ts`). The worktree is made in the background.
   */
  async fork(id: string, req: ForkSessionRequest): Promise<ForkSessionResponse> {
    const { repo, projects } = this.deps;
    this.assertForcedProvider(repo.get(id));
    await this.sourceProjectChecked(id);
    const plan = await planFork({ repo, projects, runner: this.runnerOf(id) }, id, req);
    const sourceMeta = repo.find(id)?.startMeta;
    if (sourceMeta?.autonomyFloor) plan.meta.autonomyFloor = sourceMeta.autonomyFloor;
    if (sourceMeta?.readOnlyScope) plan.meta.readOnlyScope = true;
    if (sourceMeta?.guardedInstall) plan.meta.guardedInstall = true;
    this.createAndLaunch(plan.session, plan.meta, plan.start.workspace, undefined, plan.start.fork);
    return { sessionId: plan.session.id };
  }

  /**
   * Hand an agent session off (§9): a new session, on any provider, with its code as a fork has
   * it and a brief of its work as the first message, which starts a turn (`handoff.ts`). The
   * worktree is made in the background. The brief is kept with the start metadata, and the
   * launcher sends it with whichever start opens the session, so a failed first start keeps it.
   */
  async handoff(id: string, req: HandoffSessionRequest): Promise<HandoffSessionResponse> {
    const { repo, projects, utility } = this.deps;
    await this.sourceProjectChecked(id);
    if (this.deps.forceFakeProvider && req.provider !== "fake") {
      req = { ...req, provider: "fake", model: undefined, effort: undefined };
    }
    const plan = await planHandoff({ repo, projects, runner: this.runnerOf(id), utility }, id, req);
    const sourceMeta = repo.find(id)?.startMeta;
    if (sourceMeta?.autonomyFloor) plan.meta.autonomyFloor = sourceMeta.autonomyFloor;
    if (sourceMeta?.readOnlyScope) plan.meta.readOnlyScope = true;
    if (sourceMeta?.guardedInstall) plan.meta.guardedInstall = true;
    this.createAndLaunch(plan.session, plan.meta, plan.start.workspace, undefined, plan.start.fork);
    return { sessionId: plan.session.id };
  }

  /**
   * Review an agent session's changes (§9): a new read-only session, on any provider that
   * enforces read-only, with its code as a handoff has it and a review brief as the first
   * message, which starts a turn (`review.ts`). The worktree is made in the background, and the
   * launcher delivers the brief as it does a handoff's.
   */
  async review(id: string, req: ReviewSessionRequest): Promise<ReviewSessionResponse> {
    const { repo, projects } = this.deps;
    await this.sourceProjectChecked(id);
    if (this.deps.forceFakeProvider && req.provider !== "fake") {
      req = { ...req, provider: "fake", model: undefined, effort: undefined };
    }
    const plan = await planReview({ repo, projects, runner: this.runnerOf(id) }, id, req);
    this.createAndLaunch(plan.session, plan.meta, plan.start.workspace, undefined, plan.start.fork);
    return { sessionId: plan.session.id };
  }

  /** Fork, handoff and review refuse a project that isn't a git repository: check it first. */
  private async sourceProjectChecked(sessionId: string): Promise<void> {
    const projectId = this.deps.repo.find(sessionId)?.session.projectId;
    if (projectId) await this.deps.projectChecks?.current(projectId);
  }

  /** Start a queued session whose blockers finished (called by the queue). */
  startQueued(session: Session): void {
    const { admission, repo } = this.deps;
    try {
      const meta = repo.find(session.id)?.startMeta;
      const pending = meta?.pending ?? { workspace: { mode: "worktree" as const } };
      admission?.dequeue(session.id);
      repo.setStartMeta(session.id, (m) => ({
        ...(m ?? emptyStartMeta()),
        pending: null,
      }));
      repo.update(session.id, (s) => (s.status === "queued" ? { ...s, status: "starting" } : s));
      this.launchInBackground(
        session.id,
        pending.input,
        meta?.pending?.workspace ?? meta?.forkStart?.workspace ?? pending.workspace,
        pending.fork ?? meta?.forkStart?.fork,
      );
    } finally {
      if (!this.launching.has(session.id)) admission?.release(session.id);
    }
  }

  /** Send now, steer or queue (`whenBusy`); `from` labels the message if it is queued. */
  async send(
    id: string,
    req: SendMessageRequest,
    from: QueueSender = "user",
  ): Promise<SendMessageResponse> {
    const session = this.deps.repo.get(id);
    assertProjectActive(this.deps.projects, session);
    assertRoleWritable(session);
    this.assertForcedProvider(session);
    if (NOT_STARTED.has(session.status)) return this.enqueue(id, req.input, from);
    // A turn on its way to the runner counts as running, though there is nothing to steer yet.
    const delivering = this.delivering.has(id);
    if (BUSY.has(session.status) || delivering) {
      if (req.whenBusy === "reject") throw conflict("A turn is running", "turn_running");
      if (
        !delivering &&
        (req.whenBusy === "steer" ||
          (req.whenBusy === "queue" &&
            session.status === "running" &&
            (from === "pm" || from === "orchestrator") &&
            this.provider(session.provider, id)?.capabilities.steer))
      ) {
        try {
          if ((await this.steer(id, req.input, from)) === "queued") return { status: "queued" };
        } catch (error) {
          if (runnerErrorCode(error) === "priority_cancelled") throw error;
          if (
            req.whenBusy === "steer" &&
            !["compacting", "no_turn"].includes(runnerErrorCode(error) ?? "")
          )
            throw error;
          const queued = this.enqueue(id, req.input, from);
          this.flushIfSettled(id);
          return queued;
        }
        if (PRIORITY_SENDERS.has(from) && !this.hasOutbox(id)) this.deps.admission?.dequeue(id);
        return { status: "steered" };
      }
      return this.enqueue(id, req.input, from);
    }
    const { admission, repo } = this.deps;
    const priority = PRIORITY_SENDERS.has(from);
    if (priority) this.reserve(session);
    else if (
      !isFactorySession(session) &&
      (repo.find(id)?.startMeta?.admission || !this.reserve(session))
    ) {
      if (req.whenBusy === "reject" || !this.canWaitForOutbox(session)) {
        throw conflict("All agent slots are in use", AT_CAPACITY_CODE);
      }
      const queued = this.enqueue(id, req.input, from);
      this.holds.release(id);
      if (!session.archivedAt) admission?.enqueue(id);
      return queued;
    }
    // Its place in the queue, should it end up there: ahead of messages that arrive meanwhile.
    const place = this.deps.outbox.reserve();
    try {
      await this.sendNow(session, req.input, from);
      if (priority && !this.hasOutbox(id)) admission?.dequeue(id);
    } catch (error) {
      // The provider is still running a turn the server had not seen: the message waits for it.
      if (isTurnRunningError(error)) {
        if (req.whenBusy === "reject") throw conflict("A turn is running", "turn_running");
        const queued = this.enqueue(id, req.input, from, place);
        this.flushIfSettled(id);
        return queued;
      }
      // CodeDen's own roles never lose a message to a runner restart: it waits in the queue.
      // The user sees the error instead; a wake (`reject`) is retried by its scheduler.
      if (from === "user" || req.whenBusy === "reject" || !isTransientRunnerError(error)) {
        throw error;
      }
      this.holds.hold(id, true);
      return this.enqueue(id, req.input, from, place);
    } finally {
      admission?.release(id);
    }
    this.holds.release(id);
    return { status: "sent" };
  }

  async steer(
    id: string,
    raw: UserInput,
    source: QueueSender | QueuedMessage = "user",
  ): Promise<"steered" | "queued"> {
    const session = this.deps.repo.get(id);
    assertProjectActive(this.deps.projects, session);
    this.assertForcedProvider(session);
    if (!BUSY.has(session.status)) throw conflict("No turn is running", "no_turn");
    const capabilities = this.provider(session.provider, id)?.capabilities;
    if (!capabilities?.steer) {
      throw conflict("This provider cannot steer a running turn", "unsupported");
    }
    if (compactionRunning(this.deps.repo, session)) throw compactingRefusal();
    const { outbox } = this.deps;
    const stored = typeof source === "string" ? this.externalize(session, raw) : source.input;
    const input = this.forRunner(session, stored);
    const delay = capabilities.interruptToolCall
      ? this.deps.settings.get().priorityInterruptMinutes * 60_000
      : undefined;
    let pending: QueuedMessage | undefined;
    const wait = this.priorityWaits.get(id) ?? { controller: new AbortController(), pending: 0 };
    wait.pending++;
    this.priorityWaits.set(id, wait);
    try {
      await deliverPriority(
        async (attempt) => {
          const runner = this.runnerOf(id);
          const revision = await applyPendingConfig(this.deps.repo, runner, session, true);
          assertConfigRevision(this.deps.repo, id, revision);
          const result = await runner.request({
            name: "session.steer",
            sessionId: id,
            input,
            revision,
            waitForShell: true,
            ...attempt,
          });
          if (
            result?.waitingFor &&
            !pending &&
            typeof source === "string" &&
            !wait.controller.signal.aborted
          ) {
            pending = outbox.push(id, stored, source);
            outbox.steering.add(pending.id);
          }
          return result;
        },
        (wake) => this.deps.repo.onPriorityBoundary(id, wake),
        delay,
        wait.controller.signal,
      );
      if (pending && outbox.get(id, pending.id)) outbox.remove(pending, "sent");
      return "steered";
    } catch (error) {
      if (
        (pending && isTransientRunnerError(error)) ||
        (runnerErrorCode(error) === "priority_suspended" && (pending || typeof source !== "string"))
      ) {
        return "queued";
      }
      if (pending && outbox.get(id, pending.id)) outbox.remove(pending, "dropped");
      throw toServiceError(error);
    } finally {
      if (pending) outbox.steering.delete(pending.id);
      // Keep Stop wired to all concurrent priority requests for this session.
      if (--wait.pending === 0 && this.priorityWaits.get(id) === wait) {
        this.priorityWaits.delete(id);
        this.flushIfSettled(id);
      }
    }
  }

  async interrupt(id: string): Promise<void> {
    const session = this.deps.repo.get(id);
    this.cancelPriorityWaits(id);
    this.deps.outbox.clear(id);
    if (session.status !== "queued") this.deps.admission?.dequeue(id);
    // Between turns, Stop ends the session's check run: no turn is running to interrupt.
    if (await this.checkRuns?.cancel(id, "stopped")) return;
    await this.runnerOf(id)
      .request({ name: "session.interrupt", sessionId: id })
      .catch((e) => {
        throw toServiceError(e);
      });
  }

  /**
   * "Compact now" (`./compact`): the provider compacts the conversation as a turn of its own.
   * Refused while a turn runs, checks run or messages wait, on providers without
   * `capabilities.compact`, and for sessions with no conversation yet or archived. Messages sent
   * meanwhile queue behind it.
   */
  async compact(id: string): Promise<CompactSessionResponse> {
    const session = this.deps.repo.get(id);
    assertProjectActive(this.deps.projects, session);
    this.assertForcedProvider(session);
    const refusal = compactRefusal(session, this.provider(session.provider, id), {
      delivering: this.delivering.has(id),
      queued: this.deps.outbox.count(id),
      checking: this.checkRuns?.isRunning(id) ?? false,
    });
    if (refusal) throw refusal;
    const { admission } = this.deps;
    if (!this.reserve(session)) {
      throw conflict("All agent slots are in use; try again when one frees", AT_CAPACITY_CODE);
    }
    this.delivering.add(id);
    try {
      await startCompaction(
        {
          repo: this.deps.repo,
          resume: (id) => this.resumeSession(id, this.runnerOf(id)),
          runnerOf: (id) => this.runnerOf(id),
        },
        session,
      );
    } finally {
      this.delivering.delete(id);
      admission?.release(id);
      // Messages that arrived meanwhile go once the compaction is over (or didn't start).
      if (this.deps.outbox.count(id) > 0) this.flushIfSettled(id);
    }
    return { status: "compacting" };
  }

  /** Answer a question or approval; `by` records who answered a question. */
  async respond(
    id: string,
    req: RespondRequest,
    by: ResponseActor = "user",
    options: { closeInbox?: boolean } = {},
  ): Promise<void> {
    const session = this.deps.repo.get(id);
    this.assertForcedProvider(session);
    // Questions asked through CodeDen's ask_user tool are answered here, not by the provider.
    if (await this.deps.questions.respond(id, req.requestId, req.response, by)) return;
    await this.runnerOf(id)
      .request({
        name: "session.respond",
        sessionId: id,
        requestId: req.requestId,
        response: req.response,
      })
      .catch((e) => {
        throw toServiceError(e);
      });
    // The orchestrator closes the request in the same transaction as its audit record.
    if (options.closeInbox === false) return;
    // Codex may apply a stale session approval once. Its completion event has the effective decision.
    if (
      session.provider === "codex" &&
      req.response.kind === "approval" &&
      req.response.decision === "allow_session"
    )
      return;
    const resolution: JsonValue =
      req.response.kind === "approval"
        ? { decision: req.response.decision, decidedBy: req.response.decidedBy ?? "user" }
        : req.response.kind === "answer"
          ? { answers: req.response.answers, decidedBy: by }
          : { status: "cancelled" };
    this.deps.inbox.closeForRequest(id, req.requestId, resolution);
  }

  /**
   * Stop a session: drop its queued messages, end its provider process, revoke its MCP tokens
   * and dismiss its open questions. A session that already finished (completed, failed) keeps
   * its status. `confirm` (retiring an archived role conversation) also fails when the runner
   * is unreachable, so the caller knows the stop was never confirmed.
   */
  async stop(id: string, opts: { confirm?: boolean } = {}): Promise<Session> {
    const session = this.deps.repo.get(id);
    this.cancelPriorityWaits(id);
    this.deps.outbox.clear(id);
    this.deps.admission?.dequeue(id);
    this.holds.release(id);
    if (session.status !== "queued" && session.status !== "created") {
      try {
        await this.runnerOf(id).request({ name: "session.stop", sessionId: id }, 15_000);
      } catch (error) {
        const code = runnerErrorCode(error);
        if (code !== "unknown_session" && (opts.confirm || code !== "runner_unavailable"))
          throw toServiceError(error);
      }
    }
    // The provider process is gone, so its tokens go too (§8.3), whatever status the session
    // keeps: a failed session isn't revoked by the lifecycle. Resuming mints a new token.
    this.deps.tokens.revokeSession(id);
    this.deps.inbox.dismissRequestsForSession(id, "session stopped");
    return this.deps.repo.update(id, (s) =>
      FINISHED.has(s.status) ? s : { ...s, status: "stopped", endedAt: new Date().toISOString() },
    );
  }

  canFlushOutbox(session: Session): boolean {
    return (
      !this.holds.isHeld(session.id) &&
      !this.delivering.has(session.id) &&
      !this.priorityWaits.has(session.id) &&
      FLUSHABLE.has(session.status) &&
      !inArchivedProject(this.deps.projects, session)
    );
  }

  canWaitForOutbox(session: Session): boolean {
    return (
      FLUSHABLE.has(session.status) || BUSY.has(session.status) || NOT_STARTED.has(session.status)
    );
  }

  /**
   * Stop a session whose queued messages move on to another session (a role moved to another
   * provider, `RoleSessions`): they are returned instead of dropped. They leave the queue
   * before anything is awaited, so no delivery can send one to the session being stopped; if
   * the stop fails they go back in their places.
   */
  async stopKeepingQueue(id: string): Promise<QueuedMessage[]> {
    const taken = this.deps.outbox.clear(id);
    try {
      await this.stop(id, { confirm: true });
    } catch (error) {
      this.restoreQueued(taken);
      throw error;
    }
    // Whatever was queued while the runner stopped it.
    return [...taken, ...this.deps.outbox.clear(id)];
  }

  /** Put messages taken with `stopKeepingQueue` back in their session's queue, in their places. */
  restoreQueued(messages: QueuedMessage[]): void {
    for (const message of messages) this.deps.outbox.restore(message);
  }

  /**
   * Queue messages taken from another session (`stopKeepingQueue`) for this one, in their
   * order and each with its sender. They are delivered like any queued message.
   */
  adoptQueued(id: string, messages: QueuedMessage[]): void {
    for (const message of messages) this.deps.outbox.push(id, message.input, message.from);
    if (messages.length > 0) this.flushIfSettled(id);
  }

  /**
   * Send the next queued message once no turn is running (idle, or after a failed or
   * interrupted turn). If delivery fails the message goes back in its place and delivery
   * pauses (`OutboxHolds`); only an error that is not a runner restart fails the session. A
   * turn still running on the runner is no error: the message waits for its end.
   */
  async flushOutbox(id: string, admissionHead = false): Promise<void> {
    const { admission, repo, outbox } = this.deps;
    let reserved = admissionHead;
    try {
      const found = repo.find(id);
      if (!found || !this.canFlushOutbox(found.session)) return;
      const { session, startMeta } = found;
      const next = outbox.peek(id);
      if (!next || outbox.steering.has(next.id)) return;
      const priority = PRIORITY_SENDERS.has(next.from);
      if (!admissionHead) {
        if (!priority && startMeta?.admission && !session.archivedAt) return;
        reserved = this.reserve(session);
        if (!reserved && !priority) {
          if (!session.archivedAt) admission?.enqueue(id);
          return;
        }
      }
      try {
        if (session.archivedAt) admission?.dequeue(id);
        outbox.remove(next, "sent");
        await this.sendNow(session, next.input, next.from);
      } catch (error) {
        if (isTurnRunningError(error)) {
          outbox.restore(next);
          this.flushIfSettled(id);
          return;
        }
        const transient = isTransientRunnerError(error);
        this.holds.hold(id, transient);
        outbox.restore(next);
        if (admissionHead && !transient) admission?.dequeue(id);
        if (!transient && session.status !== "failed") {
          this.deps.launcher.fail(id, `send-${Date.now()}`, error);
        }
        return;
      }
      if (priority ? !this.hasOutbox(id) : admissionHead) admission?.dequeue(id);
    } finally {
      if (reserved) admission?.release(id);
    }
  }

  /** A runner is ready again: retry the paused deliveries of its sessions (§4.2). */
  releaseOutboxes(which?: (sessionId: string) => boolean): void {
    this.holds.releaseAll(which);
    this.deps.admission?.scheduleDrain();
  }

  /** A turn is on its way to the runner for this session (sent, the runner hasn't answered). */
  isDelivering(id: string): boolean {
    return this.delivering.has(id);
  }

  /**
   * Re-open a session whose turn was cut off by a runner restart and tell the agent to carry
   * on (§4.2). Resumes through the provider's resume token. A message already on its way
   * re-opens it (a PM or the factory wrote to it first), so nothing is sent: a second resume
   * would open the conversation twice.
   */
  async continueAfterRestart(id: string, text: string): Promise<void> {
    if (this.delivering.has(id)) return;
    const session = this.deps.repo.get(id);
    if (inArchivedProject(this.deps.projects, session)) return;
    const input: UserInput = { text, attachments: [], from: "codeden" };
    if (this.deps.repo.find(id)?.startMeta?.admission) return;
    if (!this.reserve(session)) {
      this.enqueue(id, input, "codeden");
      this.deps.admission?.enqueue(id);
      return;
    }
    try {
      await this.sendNow(session, input, "codeden");
    } finally {
      this.deps.admission?.release(id);
    }
  }

  sessionsWithQueuedMessages(): string[] {
    return this.deps.outbox.sessionsWithMessages();
  }

  hasOutbox(id: string): boolean {
    return this.deps.outbox.count(id) > 0;
  }

  /**
   * Drop a session's queued messages from one sender (the factory withdrawing requests that no
   * longer apply). A message already taken out for delivery is gone from the queue and stays sent.
   * Returns how many were dropped.
   */
  dropQueued(id: string, from: QueueSender): number {
    const mine = this.deps.outbox
      .list(id)
      .filter((m) => m.from === from && !this.deps.outbox.steering.has(m.id));
    for (const m of mine) this.deps.outbox.remove(m, "dropped");
    if (!this.hasOutbox(id) && this.deps.repo.find(id)?.session.status !== "queued") {
      this.deps.admission?.dequeue(id);
    }
    return mine.length;
  }

  /** Shutdown releases the waiters while leaving their messages in the outbox. */
  suspendPriorityDelivery(): void {
    const reason = conflict("Priority delivery paused for shutdown", "priority_suspended");
    for (const wait of this.priorityWaits.values()) wait.controller.abort(reason);
    this.priorityWaits.clear();
  }

  private cancelPriorityWaits(id: string): void {
    const wait = this.priorityWaits.get(id);
    this.priorityWaits.delete(id);
    wait?.controller.abort(conflict("Priority message delivery was stopped", "priority_cancelled"));
  }

  // ---------------------------------------------------------------- internals

  /**
   * Start a turn. Marks the session `delivering` before anything is awaited; messages queued
   * meanwhile are delivered once it is settled again (`flushIfSettled`).
   */
  private async sendNow(session: Session, raw: UserInput, from: QueueSender): Promise<void> {
    this.delivering.add(session.id);
    try {
      // A new message takes over from a check run; the loop's own message comes after its run.
      await this.checkRuns?.cancel(session.id, "superseded");
      this.countChecksRound(session.id, raw, from);
      const decorated = this.inputDecorator?.(session, raw, from) ?? { input: raw };
      try {
        await this.deliver(session, this.forRunner(session, decorated.input));
      } catch (error) {
        decorated.failed?.(error);
        throw error;
      }
      decorated.delivered?.();
    } finally {
      this.delivering.delete(session.id);
      // The turn may have ended before the runner's answer: the flush its end triggered found
      // this delivery in flight and skipped, so nothing else would send what queued up.
      if (this.deps.outbox.count(session.id) > 0) this.flushIfSettled(session.id);
    }
  }

  /** The checks loop's round count follows a message on its way to the session (`roundAfter`). */
  private countChecksRound(id: string, input: UserInput, from: QueueSender): void {
    const round = roundAfter(input, from);
    if (round === undefined) return;
    this.deps.repo.update(id, (s) => {
      const checks = s.checks && withRound(s.checks, round);
      return checks && checks !== s.checks ? { ...s, checks } : s;
    });
  }

  /**
   * Deliver the queue on the next tick if no turn is running: after a delivery (its turn may
   * already be over) or a refusal because a turn was running (that turn may have ended before
   * the refusal was handled). Otherwise the end of the turn delivers it (`SessionLifecycle`).
   * It runs after the caller's error handling, so a delivery pause (`OutboxHolds`) set there
   * still applies.
   */
  private flushIfSettled(id: string): void {
    const status = this.deps.repo.find(id)?.session.status;
    if (!status || !FLUSHABLE.has(status)) return;
    setImmediate(() => void this.flushOutbox(id).catch(() => undefined));
  }

  /** Hand a turn's input to the runner, resuming the session when it no longer hosts it. */
  private async deliver(session: Session, input: UserInput): Promise<void> {
    this.assertForcedProvider(session);
    const runner = this.runnerOf(session.id);
    const previous = session.status;
    // Messaging an archived session brings it back.
    this.deps.repo.update(session.id, (s) => ({
      ...s,
      status: "running",
      endedAt: null,
      archivedAt: null,
    }));
    try {
      if (previous === "stopped") await this.refreshAutonomy(session.id, runner);
      // Cleanup removed the worktree (§9), or a container session's start failed and took its
      // container with it: make it again, then resume through the provider.
      if (session.worktreeRemovedAt || this.needsSandbox(session)) {
        await this.resumeSession(session.id, runner, input);
        return;
      }
      try {
        const revision = await applyPendingConfig(
          this.deps.repo,
          runner,
          this.deps.repo.get(session.id),
        );
        assertConfigRevision(this.deps.repo, session.id, revision);
        await runner.request({ name: "session.send", sessionId: session.id, input, revision });
      } catch (error) {
        // The runner no longer hosts it (restart, stopped): resume through the provider.
        if (runnerErrorCode(error) !== "unknown_session") throw error;
        await this.resumeSession(session.id, runner, input);
      }
    } catch (error) {
      // Refused because the provider is running a turn: the session is running, so it stays so
      // and that turn's end delivers what waits. Anything else: back to how it was.
      if (!isTurnRunningError(error)) {
        this.deps.repo.update(session.id, (s) =>
          s.status === "running" ? { ...s, status: previous } : s,
        );
      }
      throw toServiceError(error);
    }
  }

  private async resumeSession(id: string, runner: RunnerPort, input?: UserInput): Promise<void> {
    await this.refreshAutonomy(id, runner);
    await this.deps.launcher.resume(this.deps.repo.get(id), input);
  }

  private async refreshAutonomy(id: string, runner: RunnerPort): Promise<void> {
    const { repo, projects, settings, projectAutonomyPolicy } = this.deps;
    const found = repo.find(id);
    if (!found) return;
    const { session, startMeta } = found;
    const projectId = session.projectId;
    if (!projectId || (session.startedBy.kind !== "pm" && !startMeta?.autonomyFloor)) return;
    const project = projects.get(projectId);
    const autonomySettings = settings.get().autonomy;
    const floor = policyFloorForSession(
      session,
      project,
      autonomySettings,
      projectAutonomyPolicy?.(projectId),
      startMeta,
    );
    const choice = startMeta?.autonomyChoice;
    const preferred =
      startMeta?.ownerAutonomyOverride ??
      (choice === undefined
        ? session.autonomy
        : (choice ?? project.autonomy ?? autonomySettings.default));
    const autonomy = stricter(preferred, floor);
    if (autonomy === undefined || autonomy === session.autonomy) return;
    this.assertReadOnlySupported(session.role, session.provider, autonomy, id);
    this.assertSupervisedSupported(session.provider, autonomy, id);
    await updateSession(repo, runner, id, { autonomy }, undefined, true);
  }

  /** Queue a message; `at` is a place reserved for it earlier (`Outbox.reserve`). */
  private enqueue(
    id: string,
    input: UserInput,
    from: QueueSender,
    at?: string,
  ): SendMessageResponse {
    const session = this.deps.repo.get(id);
    this.deps.outbox.push(id, this.externalize(session, input), from, at);
    return { status: "queued" };
  }

  /** Pasted images and files saved as artifacts: the form CodeDen stores (queued messages). */
  private externalize(session: Session, input: UserInput): UserInput {
    return this.deps.artifacts.externalizeAttachments(input, {
      sessionId: session.id,
      projectId: session.projectId,
    });
  }

  /**
   * Input handed to the runner: artifacts resolved to the file paths providers read, only the
   * session's own (and its project's shared ones, from a conflicting start).
   */
  private forRunner(session: Session, input: UserInput): UserInput {
    return this.deps.artifacts.resolveAttachments(this.externalize(session, input), {
      sessionId: session.id,
      projectId: session.projectId,
    });
  }

  private launchInBackground(
    id: string,
    input: UserInput | undefined,
    workspace: WorkspaceRequest,
    fork?: LaunchFork,
  ) {
    const session = this.deps.repo.get(id);
    const prepared = input ? this.forRunner(session, input) : undefined;
    const promise = this.deps.launcher
      .launch(id, { input: prepared, workspace, ...(fork ? { fork } : {}) })
      .finally(() => {
        this.launching.delete(id);
        this.deps.admission?.release(id);
      });
    this.launching.set(id, promise);
  }

  /** A session of a `docker` project that has no container (its start failed). */
  private needsSandbox(session: Session): boolean {
    const sandboxes = this.deps.sandboxes;
    if (!sandboxes || !session.projectId || session.runnerId) return false;
    try {
      return sandboxes.wants(session, this.deps.projects.get(session.projectId));
    } catch {
      return false;
    }
  }

  /** The runner that hosts this session (`sessions.runnerId`, else the home runner). */
  private runnerOf(sessionId: string): RunnerPort {
    return runnerForSession(this.deps, sessionId);
  }

  /** A provider as loaded by the session's runner, or the home runner's without a session. */
  private provider(id: string, sessionId?: string): ProviderInfo | undefined {
    const runner = sessionId ? this.runnerOf(sessionId) : this.deps.runner;
    return runner.providers().find((p) => p.id === id);
  }

  private assertForcedProvider(session: Session): void {
    if (this.deps.forceFakeProvider && session.provider !== "fake") {
      throw conflict(
        "This session requires a real provider, but Fake is forced",
        "fake_provider_forced",
      );
    }
  }

  private resolveProvider(req: StartSessionRequest, projectDefault: string | null): string {
    if (this.deps.forceFakeProvider) return "fake";
    const available = this.deps.runner.providers().map((p) => p.id);
    const connected = this.deps.runner.isConnected();
    const explicit = req.provider && req.provider !== "auto" ? req.provider : null;
    if (explicit) {
      if (connected && !available.includes(explicit)) {
        throw badRequest(
          `Provider ${explicit} is not available. Loaded providers: ${available.join(", ") || "none"}`,
          "unknown_provider",
        );
      }
      return explicit;
    }
    const configured = this.configuredProvider(req.role, projectDefault);
    if (configured) return configured;
    const auto = autoOrder(available)[0];
    if (!auto)
      throw badRequest(
        "No provider is available. Choose a provider in Settings.",
        "unknown_provider",
      );
    return auto;
  }

  /** PMs use the project's effective Architect when one is configured. */
  roleSettings(role: Session["role"], projectId: string | null, teamId?: string): RoleDefaults {
    const settings = this.deps.settings.get();
    if (role === "pm" && projectId) {
      const { team } = resolveTeam({
        defaults: defaultTeam(settings),
        project: this.deps.projectTeam?.(projectId, teamId) ?? [],
      });
      const architect = teamMember(team, "architect");
      if (architect) return architect;
    }
    return settings.providers[role];
  }

  /** PM and orchestrator choices take precedence over the project default. */
  configuredProvider(role: Session["role"], projectDefault: string | null): string | null {
    const available = this.deps.runner.providers().map((p) => p.id);
    const connected = this.deps.runner.isConnected();
    const roleDefault = this.deps.settings.get().providers[role].provider;
    if (role !== "agent" && roleDefault !== "auto") {
      if (connected && !available.includes(roleDefault)) {
        throw badRequest(
          `Provider ${roleDefault} is not available. Loaded providers: ${available.join(", ") || "none"}`,
          "unknown_provider",
        );
      }
      return roleDefault;
    }
    for (const choice of [projectDefault, roleDefault === "auto" ? null : roleDefault]) {
      if (choice && (!connected || available.includes(choice))) return choice;
    }
    return null;
  }

  private buildSession(
    req: StartSessionRequest,
    project: ReturnType<ProjectService["get"]> | null,
    roleSettings: RoleDefaults,
    floor: AutonomyLevel | undefined,
    work: { purpose: string; workKey: string; scope: Session["scope"]; queued: boolean },
  ): Session {
    const settings = this.deps.settings.get();
    const now = new Date().toISOString();
    const provider = this.resolveProvider(req, project ? projectDefaultProvider(project) : null);
    const defaults =
      teamRoleOfTitle(req.title) || (isFactorySession(req) && req.provider !== "auto")
        ? { model: null, effort: null }
        : roleModelDefaults(
            roleSettings,
            provider,
            this.provider(provider),
            req.role,
            this.deps.forceFakeProvider,
          );
    const defaultAutonomy = project?.autonomy ?? settings.autonomy.default;
    const autonomy = req.autonomy ?? stricter(defaultAutonomy, floor) ?? defaultAutonomy;
    // A `docker` project's sessions run in containers, which no provider credentials reach yet.
    this.deps.sandboxes?.assertStartable(req.role, project, this.provider(provider));
    this.assertReadOnlySupported(req.role, provider, autonomy);
    // Either value is refused where plan mode doesn't exist, as for PATCH.
    if (req.planMode !== undefined) this.assertPlanModeSupported(req.role, provider);
    return {
      id: randomUUID(),
      projectId: req.projectId,
      role: req.role,
      parentSessionId: req.parentSessionId ?? null,
      startedBy: req.startedBy,
      purpose: work.purpose,
      workKey: work.workKey,
      scope: work.scope,
      progress: null,
      title: req.title ?? null,
      provider,
      model: req.model ?? defaults.model,
      effort:
        this.provider(provider)?.capabilities.reasoningEffort === false
          ? null
          : (req.effort ?? defaults.effort),
      autonomy,
      planMode: req.planMode ?? false,
      // Frozen now, from the project's own folder (§9 Project checks).
      checks: freezeChecks(project?.path, req.role, {
        untilPass: req.untilChecksPass,
        maxRounds: req.checkRounds,
      }),
      status: work.queued ? "queued" : "starting",
      cwd: project?.path ?? ".",
      worktreePath: null,
      branch: null,
      baseBranch: null,
      issue: req.issue ?? null,
      pr: null,
      resumeToken: null,
      runnerId: null,
      automationRunId: null,
      rootThreadId: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
  }

  private missing(id: string): never {
    throw new ServiceError(404, "session_not_found", `No session ${id}`);
  }
}

/**
 * The model and effort a new session takes from its role's defaults (Settings > Providers):
 * only on the role's own provider, whose model they name. A session on any other provider (a
 * cross-provider reviewer, a fallback builder, a start naming only a provider) gets null, that
 * provider's own default model and effort. The effort is left out where the provider has none.
 */
function roleModelDefaults(
  defaults: RoleDefaults,
  provider: string,
  info: ProviderInfo | undefined,
  role: Session["role"],
  forceFake?: boolean,
): Pick<Session, "model" | "effort"> {
  if (defaults.provider !== provider) {
    if (role !== "agent" && !forceFake && (defaults.model !== null || defaults.effort !== null)) {
      throw badRequest(
        `The ${role} role model or effort is configured for ${defaults.provider} and cannot be used with ${provider}.`,
        "role_model_provider_mismatch",
      );
    }
    return { model: null, effort: null };
  }
  // An unknown provider (runner not connected yet) is let through, as for plan mode.
  const hasEffort = info?.capabilities.reasoningEffort ?? true;
  return { model: defaults.model, effort: hasEffort ? defaults.effort : null };
}

function assertRoleWritable(session: Session): void {
  if (session.role !== "agent" && session.archivedAt) {
    throw conflict("This conversation is archived", "role_session_archived");
  }
}
