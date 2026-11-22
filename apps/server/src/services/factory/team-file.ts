import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Project,
  type RawEventEnvelope,
  resolveTeam,
  type Session,
  sessionTeamMember,
  type Team,
  TeamFile,
} from "@codeden/contracts";

/** Where a session's Team file lives under CodeDen's home (`TEAM_FILE` points here). */
export function teamFilePath(home: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`unsafe session id ${sessionId}`);
  return join(home, "teams", `${sessionId}.json`);
}

/** The folders whose code the project's Team governs: its own folder and its worktrees. */
export function teamRoots(project: Pick<Project, "path" | "slug">, worktreesDir: string) {
  return [project.path, join(worktreesDir, project.slug)];
}

/** Whether the file already holds this Team (all but its time stamp): then it is not rewritten. */
function sameTeamFile(path: string, body: TeamFile): boolean {
  try {
    const { updatedAt: _old, ...current } = TeamFile.parse(JSON.parse(readFileSync(path, "utf8")));
    const { updatedAt: _new, ...wanted } = body;
    return JSON.stringify(current) === JSON.stringify(wanted);
  } catch {
    return false;
  }
}

/** Sessions in these states keep a Team file; any other state has none. */
export const TEAM_FILE_STATUSES = [
  "created",
  "queued",
  "starting",
  "running",
  "waiting",
  "idle",
] as const;

/** What a session's Team is resolved from; every model comes from one of these UI choices. */
export interface TeamFileDeps {
  home: string;
  worktreesDir: string;
  /** The default Team (Settings, Factory > Team setup). */
  defaults: () => Team;
  /** The project's Team (its factory settings). */
  projectTeam: (projectId: string) => Team;
  project: (projectId: string) => Pick<Project, "path" | "slug">;
  session: (sessionId: string) => Session | undefined;
  /** Sessions that are live (not ended), all or one project's. */
  liveSessions: (projectId?: string) => Session[];
  log?: (message: string) => void;
}

/**
 * Write a session's effective Team (`resolveTeam`: its own choice for its role, the project's
 * Team, the default Team) atomically, readable only by the user, and return the path.
 */
export function writeTeamFile(deps: TeamFileDeps, session: Session, now = new Date()): string {
  if (!session.projectId) throw new Error(`session ${session.id} has no project`);
  const path = teamFilePath(deps.home, session.id);
  const { team, sources } = resolveTeam({
    defaults: deps.defaults(),
    project: deps.projectTeam(session.projectId),
    session: sessionTeamMember(session),
  });
  const body = TeamFile.parse({
    version: 1,
    sessionId: session.id,
    projectId: session.projectId,
    roots: teamRoots(deps.project(session.projectId), deps.worktreesDir),
    team,
    sources,
    updatedAt: now.toISOString(),
  });
  if (sameTeamFile(path, body)) return path;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A fresh name opened exclusively: never an existing file or a planted symlink.
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return path;
}

/**
 * The sessions whose Team files a batch of events can change: one session (its row changed), a
 * project's sessions (its Team changed) or all of them (the default Team may have changed).
 */
export function teamFileChanges(events: readonly RawEventEnvelope[]) {
  const sessions = new Set<string>();
  const projects = new Set<string>();
  let all = false;
  for (const event of events) {
    const payload = event.payload as {
      loop?: { projectId?: unknown };
      session?: { id?: unknown };
    } | null;
    if (event.type === "settings.updated") all = true;
    const projectId = payload?.loop?.projectId;
    if (event.type === "factory.loop.updated" && typeof projectId === "string") {
      projects.add(projectId);
    }
    const sessionId = payload?.session?.id ?? event.sessionId;
    if ((event.type === "session.updated" || event.type === "session.created") && typeof sessionId === "string") {
      sessions.add(sessionId);
    }
  }
  return { all, projects, sessions };
}

/**
 * Keeps the Team files of live project sessions current. At creation it writes the file of every
 * live project session, so a server restart repairs files a failed rewrite removed. On each batch it
 * rewrites: one session's file when that session changed; a project's live sessions' files only
 * when the project's Team actually changed; every live session's file when the default Team
 * changed. When a rewrite fails the old file is removed, so tools fail closed instead of using a
 * changed Team, and the session is retried on every later batch until its file is written again.
 * A lookup that fails keeps its scope pending for the next batch. Errors stay within their scope.
 */
export function createTeamFileRefresher(deps: TeamFileDeps) {
  const failed = new Set<string>();
  const pendingProjects = new Set<string>();
  let pendingAll = false;
  const seenProjects = new Map<string, string>();
  let seenDefaults: string | null = null;
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const refresh = (session: Session | undefined, sessionId: string) => {
    try {
      const keeps =
        session?.projectId && (TEAM_FILE_STATUSES as readonly string[]).includes(session.status);
      if (session && keeps) writeTeamFile(deps, session);
      else rmSync(teamFilePath(deps.home, sessionId), { force: true });
      failed.delete(sessionId);
    } catch (error) {
      failed.add(sessionId);
      let removed = "removed";
      try {
        rmSync(teamFilePath(deps.home, sessionId), { force: true });
      } catch (rmError) {
        removed = `NOT removed (${message(rmError)})`;
      }
      deps.log?.(
        `session ${sessionId}: Team file not written, old file ${removed}: ${message(error)}`,
      );
    }
  };
  const live = (projectId?: string): Session[] | null => {
    try {
      return deps.liveSessions(projectId);
    } catch (error) {
      deps.log?.(
        `live sessions${projectId ? ` of project ${projectId}` : ""} not listed: ${message(error)}`,
      );
      return null;
    }
  };
  const run = (events: readonly RawEventEnvelope[], initial: boolean) => {
    const { all, projects, sessions } = teamFileChanges(events);
    const targets = new Map<string, Session | undefined>();
    for (const id of [...failed, ...sessions]) {
      try {
        targets.set(id, deps.session(id));
      } catch (error) {
        failed.add(id);
        deps.log?.(`session ${id}: not read for its Team file: ${message(error)}`);
      }
    }
    if (all || initial) {
      try {
        const key = JSON.stringify(deps.defaults());
        if (key !== seenDefaults) pendingAll = true;
        seenDefaults = key;
      } catch (error) {
        pendingAll = true;
        deps.log?.(`default Team not read: ${message(error)}`);
      }
    }
    for (const projectId of projects) {
      try {
        const key = JSON.stringify(deps.projectTeam(projectId));
        if (seenProjects.get(projectId) !== key) pendingProjects.add(projectId);
        seenProjects.set(projectId, key);
      } catch (error) {
        pendingProjects.add(projectId);
        deps.log?.(`project ${projectId}: Team not read: ${message(error)}`);
      }
    }
    if (pendingAll) {
      const list = live();
      if (list) {
        pendingAll = false;
        pendingProjects.clear();
        for (const session of list) targets.set(session.id, session);
      }
    }
    for (const projectId of [...pendingProjects]) {
      const list = live(projectId);
      if (!list) continue;
      pendingProjects.delete(projectId);
      for (const session of list) targets.set(session.id, session);
    }
    for (const [id, session] of targets) refresh(session, id);
  };
  run([], true);
  return (events: readonly RawEventEnvelope[]) => run(events, false);
}
