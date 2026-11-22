import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
// Only a regular file (opened without following a link or blocking on a special file) whose stored text, as written,
// has a valid time stamp and the same Team counts; anything else is replaced atomically.
function sameTeamFile(path: string, body: TeamFile): boolean {
  // Without O_NOFOLLOW (Windows) a link can't be told from a file here: never reuse, always replace.
  if (!constants.O_NOFOLLOW) return false;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    // Owner-only, as written: a file anyone else may read or write is replaced.
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return false;
    // The same Team written again has exactly this size (the time stamp keeps its length): anything else is
    // replaced without reading it, so a damaged or huge file is never parsed.
    if (stat.size !== Buffer.byteLength(`${JSON.stringify(body, null, 2)}\n`)) return false;
    const { updatedAt, ...current } = JSON.parse(readFileSync(fd, "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) return false;
    const { updatedAt: _new, ...wanted } = body;
    return JSON.stringify(current) === JSON.stringify(wanted);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
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
  /** Whether the session's provider or model was its starter's own choice (its own Team layer). */
  ownTeamPins?: (sessionId: string) => boolean;
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
    // Only pins the starter chose are the session's own; ones filled from the Team follow the Team.
    session: deps.ownTeamPins?.(session.id) ? sessionTeamMember(session) : null,
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
    if (
      (event.type === "session.updated" || event.type === "session.created") &&
      typeof sessionId === "string"
    ) {
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
  // The files this refresher wrote, by session, with their project: what a failed lookup must invalidate.
  const published = new Map<string, string>();
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  // Fail closed: remove the file now and retry the session on every later batch.
  const invalidate = (sessionId: string, why: string) => {
    failed.add(sessionId);
    published.delete(sessionId);
    let removed = "removed";
    try {
      rmSync(teamFilePath(deps.home, sessionId), { force: true });
    } catch (rmError) {
      removed = `NOT removed (${message(rmError)})`;
    }
    deps.log?.(`session ${sessionId}: Team file not current, old file ${removed}: ${why}`);
  };
  const invalidateWhere = (projectId: string | null, why: string) => {
    for (const [id, project] of [...published]) {
      if (projectId === null || project === projectId) invalidate(id, why);
    }
  };
  const removeLeftovers = (keep: ReadonlySet<string>) => {
    const dir = join(deps.home, "teams");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        deps.log?.(`Team files in ${dir} not listed: ${message(error)}`);
    }
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      if (keep.has(id)) continue;
      // Only a known session that is no longer live loses its file; a name that is no session is left alone. A
      // lookup that fails is retried (`pendingLeftovers`), and a file that can't be removed is retried as failed.
      let known: boolean;
      try {
        known = deps.session(id) !== undefined;
      } catch {
        pendingLeftovers.set(id, "session not read at start");
        continue;
      }
      if (known) invalidate(id, "session is not live");
    }
  };
  // At start nothing is published yet: when the live sessions can't be listed, every file a previous run left is
  // invalidated (and retried), since none of them can be checked.
  const invalidateLeftovers = (why: string) => {
    const dir = join(deps.home, "teams");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        deps.log?.(`Team files in ${dir} not listed: ${message(error)}`);
    }
    for (const name of names) pendingLeftovers.set(name.slice(0, -".json".length), why);
    checkLeftovers();
  };
  // Leftover files whose session couldn't be checked: a confirmed session's file is invalidated (and
  // retried); a name that is no session is left alone; one that still can't be looked up waits.
  const pendingLeftovers = new Map<string, string>();
  const checkLeftovers = () => {
    for (const [id, why] of [...pendingLeftovers]) {
      let known: boolean;
      try {
        known = deps.session(id) !== undefined;
      } catch {
        continue;
      }
      pendingLeftovers.delete(id);
      if (known) invalidate(id, why);
    }
  };
  const refresh = (session: Session | undefined, sessionId: string) => {
    try {
      const keeps =
        session?.projectId && (TEAM_FILE_STATUSES as readonly string[]).includes(session.status);
      if (session?.projectId && keeps) {
        writeTeamFile(deps, session);
        published.set(sessionId, session.projectId);
      } else {
        rmSync(teamFilePath(deps.home, sessionId), { force: true });
        published.delete(sessionId);
      }
      failed.delete(sessionId);
    } catch (error) {
      invalidate(sessionId, `not written: ${message(error)}`);
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
    checkLeftovers();
    const { all, projects, sessions } = teamFileChanges(events);
    const targets = new Map<string, Session | undefined>();
    for (const id of [...failed, ...sessions]) {
      try {
        targets.set(id, deps.session(id));
      } catch (error) {
        invalidate(id, `session not read: ${message(error)}`);
      }
    }
    if (all || initial) {
      try {
        const key = JSON.stringify(deps.defaults());
        if (key !== seenDefaults) pendingAll = true;
        seenDefaults = key;
      } catch (error) {
        pendingAll = true;
        invalidateWhere(null, `default Team not read: ${message(error)}`);
      }
    }
    for (const projectId of projects) {
      try {
        const key = JSON.stringify(deps.projectTeam(projectId));
        if (seenProjects.get(projectId) !== key) pendingProjects.add(projectId);
        seenProjects.set(projectId, key);
      } catch (error) {
        pendingProjects.add(projectId);
        invalidateWhere(projectId, `project Team not read: ${message(error)}`);
      }
    }
    if (pendingAll) {
      const list = live();
      if (!list) {
        if (initial) invalidateLeftovers("live sessions not listed at start");
        else invalidateWhere(null, "live sessions not listed");
      }
      if (list) {
        pendingAll = false;
        pendingProjects.clear();
        for (const session of list) targets.set(session.id, session);
        // At start, a file left for a session that is no longer live (an interrupted cleanup) is removed.
        if (initial) removeLeftovers(new Set(list.map((session) => session.id)));
      }
    }
    for (const projectId of [...pendingProjects]) {
      const list = live(projectId);
      if (!list) {
        invalidateWhere(projectId, "live sessions not listed");
        continue;
      }
      pendingProjects.delete(projectId);
      for (const session of list) targets.set(session.id, session);
    }
    for (const [id, session] of targets) refresh(session, id);
  };
  run([], true);
  return (events: readonly RawEventEnvelope[]) => run(events, false);
}
