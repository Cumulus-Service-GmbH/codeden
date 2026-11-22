import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
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
    const sessionId = payload?.session?.id;
    if (event.type === "session.updated" && typeof sessionId === "string") sessions.add(sessionId);
  }
  return { all, projects, sessions };
}
/**
 * Keeps the Team files current. On each batch it rewrites the files the events affect: one
 * session's (looked up by id), a project's (found by the project id inside each file) or all of
 * them. A file whose session is gone is removed. When a rewrite fails the old file is removed, so
 * tools fail closed instead of using a changed Team, and that session is retried on every later
 * batch until its file is written again. Every error stays within its session.
 */
export function createTeamFileRefresher(deps: TeamFileDeps) {
  const failed = new Set<string>();
  const dir = join(deps.home, "teams");
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const refresh = (sessionId: string) => {
    try {
      const session = deps.session(sessionId);
      if (session?.projectId) writeTeamFile(deps, session);
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
  return (events: readonly RawEventEnvelope[]) => {
    const { all, projects, sessions } = teamFileChanges(events);
    const targets = new Set(failed);
    for (const id of sessions) {
      if (/^[A-Za-z0-9_-]+$/.test(id) && existsSync(teamFilePath(deps.home, id))) targets.add(id);
    }
    if (all || projects.size > 0) {
      let names: string[] = [];
      try {
        names = existsSync(dir) ? readdirSync(dir) : [];
      } catch (error) {
        deps.log?.(`Team files in ${dir} not listed: ${message(error)}`);
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        if (all) {
          targets.add(id);
          continue;
        }
        try {
          const file = JSON.parse(readFileSync(join(dir, name), "utf8")) as { projectId?: unknown };
          if (typeof file.projectId !== "string" || projects.has(file.projectId)) targets.add(id);
        } catch {
          targets.add(id);
        }
      }
    }
    for (const id of targets) refresh(id);
  };
}
