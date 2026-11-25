import {
  type CreateGithubIssueRequest,
  type GitHubRepo,
  type GithubConnection,
  type GithubIssue,
  type GithubIssueDetails,
  type GithubIssuesResponse,
  type GithubLabelRequest,
  type GithubPr,
  type GithubPrDetails,
  type GithubPrDiff,
  type GithubPrsResponse,
  type MergePrRequest,
  type MergePrResponse,
  PrMergeState,
  type Project,
  parseGithubPrId,
  type RawEventEnvelope,
  type Session,
  type SessionGithubResponse,
  type TriageIssueRequest,
  type TriageIssueResult,
} from "@codeden/contracts";
import type { Db } from "../../db/client";
import type { EventStore } from "../../events/store";
import type { ArtifactService } from "../artifacts";
import { reviewedAutomationHead } from "../automations/delivery";
import { automationFork } from "../automations/policy";
import { badRequest, conflict, errorMessage, ServiceError } from "../errors";
import type { Exec } from "../exec";
import { teamFilePath } from "../factory/team-file";
import type { GitBroker } from "../git-broker";
import type { InboxService } from "../inbox-service";
import type { ProjectService } from "../projects/project-service";
import { isRemoteRunner, type RunnerDeps, type RunnerPort } from "../runner-port";
import type { SecretStore } from "../secrets";
import type { SessionRepo } from "../sessions/repo";
import { remoteWorkspaceFs } from "../workspace-fs/workspace-fs";
import { type AttachEvidenceInput, type AttachEvidenceResult, attachEvidence } from "./attach";
import { GithubAuth } from "./auth";
import { GithubClient } from "./client";
import { type RestIssue, toGithubIssue } from "./diff";
import { PrFollowUp } from "./follow-up";
import { fetchPullRequests, toGithubPr } from "./graphql";
import * as issues from "./issues";
import { PrFilesCache, readPrInfo, withoutPatch } from "./pr-files";
import {
  type CreatePullRequestInput,
  type CreatePullRequestResult,
  createPullRequest,
  refreshPr,
} from "./pull-requests";
import { PrReviewInbox } from "./review-inbox";
import { GithubStore, type IssueStateFilter } from "./store";
import { GithubSync } from "./sync";

export interface GithubServiceDeps extends RunnerDeps {
  db: Db;
  store: EventStore;
  projects: ProjectService;
  repo: SessionRepo;
  artifacts: ArtifactService;
  inbox: InboxService;
  exec: Exec;
  secrets: SecretStore;
  /** CodeDen's data directory: its credential files are never attached as evidence (§15). */
  home?: string;
  userHome?: string;
  automationRun?: (session: Session) => string | undefined;
  forkTriage?: {
    enabled: (project: Project) => boolean;
    opened: (project: Project, issue: GithubIssue) => Promise<void>;
  };
  /** Brokers push credentials for runners that don't share this disk (§9.2). */
  git?: GitBroker;
  /** `fetch` for Octokit and the API base URL (tests point them at a fake GitHub). */
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Poll intervals (ms): idle (default 60 s) and while a session PR is open (default 15 s). */
  idleIntervalMs?: number;
  activeIntervalMs?: number;
  log?: (message: string) => void;
}

/**
 * GitHub for CodeDen (§9): connection state, issue and PR sync, and the operations agents, PMs
 * and the UI share. Every method that needs GitHub takes a project id and fails with
 * `409 not_a_github_project` for local-only projects and `409 github_not_connected` without a
 * token; list reads never fail for those reasons (they return the projection and the state).
 */
export class GithubService {
  readonly auth: GithubAuth;
  readonly client: GithubClient;
  readonly data: GithubStore;
  readonly sync: GithubSync;
  private readonly followUp: PrFollowUp;
  private readonly reviewInbox: PrReviewInbox;
  private readonly prFiles: PrFilesCache;
  private readonly forkCursor = new Map<string, { target: string; since: string }>();
  private unsubscribe: (() => void) | undefined;
  private login: { value: string; token: string } | null = null;

  constructor(private readonly deps: GithubServiceDeps) {
    this.auth = new GithubAuth({ exec: deps.exec, secrets: deps.secrets });
    this.client = new GithubClient({ auth: this.auth, fetch: deps.fetch, baseUrl: deps.baseUrl });
    this.data = new GithubStore(deps.db);
    this.sync = new GithubSync({
      client: this.client,
      store: this.data,
      events: deps.store,
      projects: () => deps.projects.list(),
      ownsOriginPr: (session) => !deps.automationRun?.(session),
      afterSync: async (project) => {
        await Promise.all([this.syncForkTriage(project), this.syncForkAutomationPrs(project)]);
      },
      idleIntervalMs: deps.idleIntervalMs,
      activeIntervalMs: deps.activeIntervalMs,
      log: deps.log,
    });
    this.followUp = new PrFollowUp({
      client: this.client,
      repo: deps.repo,
      runner: deps.runner,
      runners: deps.runners,
      inbox: deps.inbox,
      repoOf: (projectId) => this.repoOrNull(projectId),
      log: deps.log,
    });
    this.reviewInbox = new PrReviewInbox({ inbox: deps.inbox, repo: deps.repo });
    this.prFiles = new PrFilesCache(this.client);
  }

  private async syncForkTriage(project: Project): Promise<void> {
    if (
      project.kind !== "github" ||
      !project.github.forkRemote ||
      !this.deps.forkTriage?.enabled(project)
    ) {
      this.forkCursor.delete(project.id);
      return;
    }
    const fork = automationFork(project);
    const target = `${fork.owner}/${fork.repo}`.toLowerCase();
    const before = this.forkCursor.get(project.id);
    // Initial polling is a baseline, just like origin issue sync.
    const until = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    if (before?.target !== target) {
      this.forkCursor.set(project.id, { target, since: until });
      return;
    }
    if (before.since >= until) return;
    const rows = await this.client.run((octokit) =>
      octokit.paginate(octokit.rest.issues.listForRepo, {
        owner: fork.owner,
        repo: fork.repo,
        since: before.since,
        state: "open",
        per_page: 100,
      }),
    );
    for (const row of rows) {
      if (row.pull_request || row.created_at < before.since || row.created_at >= until) continue;
      await this.deps.forkTriage.opened(project, toGithubIssue(project.id, row as RestIssue));
    }
    this.forkCursor.set(project.id, { target, since: until });
  }

  private async syncForkAutomationPrs(project: Project): Promise<void> {
    if (project.kind !== "github" || !project.github.forkRemote) return;
    const fork = automationFork(project);
    const prefix = `https://github.com/${fork.owner}/${fork.repo}/pull/`.toLowerCase();
    const sessions = this.deps.repo
      .sessionsWithOpenPr(project.id)
      .filter(
        (session) =>
          this.deps.automationRun?.(session) && session.pr?.url.toLowerCase().startsWith(prefix),
      );
    if (!sessions.length) return;
    const numbers = sessions.flatMap((session) => (session.pr ? [session.pr.number] : []));
    for (const { node } of await fetchPullRequests(this.client, fork.owner, fork.repo, numbers)) {
      const pr = toGithubPr(project.id, node, null);
      for (const session of sessions) {
        if (session.pr?.number !== pr.number || session.pr.state === pr.state) continue;
        this.deps.repo.update(session.id, (s) =>
          s.pr?.url === session.pr?.url
            ? { ...s, pr: { number: pr.number, url: pr.url, state: pr.state, title: pr.title } }
            : s,
        );
      }
    }
  }

  /**
   * Follow PR events (merge follow-up, the `pr_review` inbox item) and, unless `sync: false`,
   * poll GitHub projects.
   */
  start(opts: { sync?: boolean } = {}): void {
    this.unsubscribe ??= this.deps.store.subscribe((events) => {
      this.followUp.onEvents(events);
      this.linkSoon(events);
      if (!events.some((e) => e.type.startsWith("pr."))) return;
      // After commit, never inside the store's notification.
      setImmediate(() => {
        try {
          this.reviewInbox.onEvents(events);
        } catch (error) {
          this.deps.log?.(`github: review inbox: ${errorMessage(error)}`);
        }
      });
    });
    if (opts.sync !== false) this.sync.start();
  }

  /**
   * A session that starts on (or moves to) the head branch of an open PR nobody owns yet gets
   * that PR at the next scheduler tick instead of waiting for the next poll.
   */
  private linkSoon(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type !== "session.created" && e.type !== "session.updated") continue;
      const { session } = e.payload as { session?: Session };
      if (!session?.projectId || !session.branch || session.pr) continue;
      if (this.sync.hasUnlinkedPr(session.projectId, session.branch)) {
        this.sync.soon(session.projectId);
      }
    }
  }

  stop(): void {
    this.sync.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Whether GitHub is reachable with the user's `gh` login or keychain token. */
  async connection(): Promise<GithubConnection> {
    const token = await this.auth.token();
    if (!token) {
      return {
        connected: false,
        source: null,
        login: null,
        message: this.auth.lastReason() ?? "GitHub is not connected",
      };
    }
    if (this.login?.token !== token.value) {
      try {
        const login = await this.client.run(
          async (o) => (await o.rest.users.getAuthenticated()).data.login,
        );
        this.login = { value: login, token: token.value };
      } catch (error) {
        const message = error instanceof ServiceError ? error.message : errorMessage(error);
        return { connected: false, source: token.source, login: null, message };
      }
    }
    return {
      connected: true,
      source: token.source,
      login: this.login?.value ?? null,
      message: null,
    };
  }

  // ------------------------------------------------------------ issues (PM tools, UI)

  /** Issues from the projection (synced in the background); `labels` must all match. */
  async listIssues(
    projectId: string,
    opts: { state?: IssueStateFilter; labels?: string[]; limit?: number } = {},
  ): Promise<GithubIssue[]> {
    this.githubRepo(projectId);
    const all = this.data.issues(
      projectId,
      opts.state ?? "open",
      opts.labels?.length ? 500 : (opts.limit ?? 100),
    );
    const wanted = opts.labels ?? [];
    return all.filter((i) => wanted.every((l) => i.labels.includes(l))).slice(0, opts.limit ?? 100);
  }

  /** One issue, fresh from GitHub, with its latest comments. */
  getIssue(projectId: string, number: number, automation = false): Promise<GithubIssueDetails> {
    const repo = automation
      ? automationFork(this.deps.projects.get(projectId))
      : this.githubRepo(projectId);
    return issues.getIssueDetails(
      { ...this.issueDeps(), isolated: automation },
      projectId,
      repo,
      number,
    );
  }

  triageIssue(
    projectId: string,
    number: number,
    req: TriageIssueRequest,
    automation = false,
  ): Promise<TriageIssueResult> {
    const repo = automation
      ? automationFork(this.deps.projects.get(projectId))
      : this.githubRepo(projectId);
    return issues.triageIssue(
      { ...this.issueDeps(), isolated: automation },
      projectId,
      repo,
      number,
      req,
    );
  }

  createIssue(
    projectId: string,
    req: CreateGithubIssueRequest,
    automation = false,
  ): Promise<GithubIssue> {
    const repo = automation
      ? automationFork(this.deps.projects.get(projectId))
      : this.githubRepo(projectId);
    return issues.createIssue({ ...this.issueDeps(), isolated: automation }, projectId, repo, req);
  }

  commentOnIssue(
    projectId: string,
    number: number,
    body: string,
    session?: Session,
  ): Promise<{ id: number; url: string }> {
    const repo =
      session && this.deps.automationRun?.(session) && projectId
        ? automationFork(this.deps.projects.get(projectId))
        : this.githubRepo(projectId);
    return issues.commentOnIssue(this.issueDeps(), repo, number, body);
  }

  labelIssue(projectId: string, number: number, req: GithubLabelRequest): Promise<GithubIssue> {
    return issues.labelIssue(this.issueDeps(), projectId, this.githubRepo(projectId), number, req);
  }

  // ------------------------------------------------------------ pull requests

  listPrs(projectId: string, state: IssueStateFilter = "open", limit = 100): GithubPr[] {
    this.githubRepo(projectId);
    return this.data.prs(projectId, state, limit);
  }

  /** A PR's state, checks, reviews and mergeability; re-read from GitHub unless `cached`. */
  async getPrStatus(
    projectId: string,
    number: number,
    opts: { cached?: boolean; session?: Session } = {},
  ): Promise<GithubPr> {
    if (opts.session && this.deps.automationRun?.(opts.session)) {
      const fork = automationFork(this.deps.projects.get(projectId));
      return refreshPr(this.prDeps(), projectId, fork, number, opts.session.id, true);
    }
    const repo = this.githubRepo(projectId);
    const cached = this.data.pr(projectId, number);
    if (opts.cached && cached) return cached;
    return refreshPr(this.prDeps(), projectId, repo, number);
  }

  /** `/api/prs/:id`: status plus body, size and every changed file (without patches). */
  async getPrDetails(prId: string): Promise<GithubPrDetails> {
    const { projectId, number } = this.parsePrId(prId);
    const repo = this.githubRepo(projectId);
    const pr = await refreshPr(this.prDeps(), projectId, repo, number);
    const [info, files] = await Promise.all([
      readPrInfo(this.client, repo, number),
      this.prFiles.get(repo, number, pr),
    ]);
    return {
      ...pr,
      body: info.body,
      additions: info.additions,
      deletions: info.deletions,
      changedFiles: info.changedFiles,
      mergeState: PrMergeState.parse(info.mergeableState),
      files: files.map(withoutPatch),
    };
  }

  /** `/api/prs/:id/diff`: every changed file with its patch, at the PR's current head. */
  async getPrDiff(prId: string): Promise<GithubPrDiff> {
    const { projectId, number } = this.parsePrId(prId);
    const repo = this.githubRepo(projectId);
    const info = await readPrInfo(this.client, repo, number);
    const files = await this.prFiles.get(repo, number, info);
    return { headSha: info.headSha, changedFiles: info.changedFiles, files };
  }

  /** Merge a PR (squash by default); the merge follow-up runs from the `pr.merged` event. */
  async mergePr(prId: string, req: MergePrRequest): Promise<MergePrResponse> {
    const { projectId, number } = this.parsePrId(prId);
    const repo = this.githubRepo(projectId);
    const res = await this.client.run((octokit) =>
      octokit.rest.pulls.merge({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        merge_method: req.method,
        ...(req.sha ? { sha: req.sha } : {}),
        ...(req.commitTitle ? { commit_title: req.commitTitle } : {}),
        ...(req.commitMessage ? { commit_message: req.commitMessage } : {}),
      }),
    );
    await refreshPr(this.prDeps(), projectId, repo, number).catch((error: unknown) =>
      this.deps.log?.(`github: refresh after merge: ${errorMessage(error)}`),
    );
    return { merged: res.data.merged, sha: res.data.sha ?? null };
  }

  // ------------------------------------------------------------ agent tools

  /** `create_pull_request`: push the session's branch and open or update its PR. */
  async createPullRequest(
    sessionId: string,
    input: CreatePullRequestInput,
  ): Promise<CreatePullRequestResult> {
    const session = this.deps.repo.get(sessionId);
    if (
      session.role === "agent" &&
      (session.autonomy === "read_only" || this.deps.repo.find(sessionId)?.startMeta?.readOnlyScope)
    ) {
      throw conflict(
        "This session has read-only permissions: it cannot commit, push or open a pull request",
        "read_only",
      );
    }
    const run = this.deps.automationRun?.(session);
    if (run && session.projectId) {
      const fork = automationFork(this.deps.projects.get(session.projectId));
      return createPullRequest(this.prDeps(), session, fork, input, async (cwd, base, runner) => {
        return this.authorizeAutomationPush(session, cwd, runner, run, fork, base);
      });
    }
    const repo = this.githubRepo(session.projectId);
    const result = await createPullRequest(this.prDeps(), session, repo, input);
    if (session.projectId) this.sync.soon(session.projectId);
    return result;
  }

  /** Validate the fork push and return the immutable refspec for app callers. */
  async authorizeAutomationPush(
    session: Session,
    cwd: string,
    runner: RunnerPort,
    run: string,
    fork: ReturnType<typeof automationFork>,
    base?: string,
  ): Promise<{ remote: string; sourceCommit: string }> {
    if (isRemoteRunner(runner) || !this.deps.home || !this.deps.userHome) {
      throw conflict(
        "The Team review gate needs the local automation worktree.",
        "automation_review_unavailable",
      );
    }
    const sourceCommit = await reviewedAutomationHead(
      this.deps.exec,
      cwd,
      teamFilePath(this.deps.home, session.id),
      fork,
      run,
      session.provider,
      this.deps.userHome,
      base,
    );
    return { remote: fork.remote, sourceCommit };
  }

  /** `attach_evidence`: files to the evidence branch plus a comment on the PR or issue. */
  attachEvidence(sessionId: string, input: AttachEvidenceInput): Promise<AttachEvidenceResult> {
    const session = this.deps.repo.get(sessionId);
    return attachEvidence(
      this.client,
      this.deps.artifacts,
      session,
      this.deps.automationRun?.(session) && session.projectId
        ? automationFork(this.deps.projects.get(session.projectId))
        : this.githubRepo(session.projectId),
      input,
      this.deps.home,
      remoteWorkspaceFs(this.deps, session),
    );
  }

  /** `/api/sessions/:id/github`: the session's issue and PR (projection, no network). */
  async sessionGithub(sessionId: string): Promise<SessionGithubResponse> {
    const session = this.deps.repo.get(sessionId);
    const pr =
      session.projectId && session.pr
        ? (this.data.pr(session.projectId, session.pr.number) ?? null)
        : null;
    const local = !session.projectId || this.repoOrNull(session.projectId) === null;
    const connection: GithubConnection = local
      ? {
          connected: false,
          source: null,
          login: null,
          message: "Local-only project: GitHub features are off",
        }
      : await this.connection();
    return { connection, issue: session.issue, pr };
  }

  // ------------------------------------------------------------ list responses for routes

  async issuesResponse(
    projectId: string,
    state: IssueStateFilter,
    limit: number,
  ): Promise<GithubIssuesResponse> {
    const project = this.deps.projects.get(projectId);
    if (project.kind !== "github") return { connection: localConnection(), sync: null, issues: [] };
    return {
      connection: await this.connection(),
      sync: this.sync.status(projectId),
      issues: this.data.issues(projectId, state, limit),
    };
  }

  async prsResponse(
    projectId: string,
    state: IssueStateFilter,
    limit: number,
  ): Promise<GithubPrsResponse> {
    const project = this.deps.projects.get(projectId);
    if (project.kind !== "github") return { connection: localConnection(), sync: null, prs: [] };
    return {
      connection: await this.connection(),
      sync: this.sync.status(projectId),
      prs: this.data.prs(projectId, state, limit),
    };
  }

  /** Sync a project now; errors surface (not connected, rate limited). */
  async syncNow(projectId: string): Promise<void> {
    this.githubRepo(projectId);
    await this.sync.syncProject(projectId);
  }

  // ------------------------------------------------------------ helpers

  /** The GitHub coordinates of a project, or a 409 for local-only projects. */
  githubRepo(projectId: string | null): GitHubRepo {
    if (!projectId) throw conflict("This session has no project", "no_project");
    const project: Project = this.deps.projects.get(projectId);
    if (project.kind !== "github") {
      throw conflict(
        `${project.name} is a local-only project; GitHub features are off`,
        "not_a_github_project",
      );
    }
    return project.github;
  }

  private repoOrNull(projectId: string): GitHubRepo | null {
    try {
      return this.githubRepo(projectId);
    } catch {
      return null;
    }
  }

  private parsePrId(prId: string): { projectId: string; number: number } {
    const parsed = parseGithubPrId(prId);
    if (!parsed) throw badRequest("PR ids look like <projectId>:<number>", "invalid_pr_id");
    if (!this.data.pr(parsed.projectId, parsed.number)) {
      // Not synced yet: still allowed, the project must exist.
      this.deps.projects.get(parsed.projectId);
    }
    return parsed;
  }

  private issueDeps() {
    return { client: this.client, store: this.data, events: this.deps.store };
  }

  private prDeps() {
    const { runner, runners, repo, git } = this.deps;
    return { ...this.issueDeps(), runner, runners, repo, git };
  }
}

function localConnection(): GithubConnection {
  return {
    connected: false,
    source: null,
    login: null,
    message: "Local-only project: GitHub features are off",
  };
}
