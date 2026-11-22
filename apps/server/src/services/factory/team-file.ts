import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * Rewrite the existing Team files the events affect. A file whose session is gone is removed;
 * when a rewrite fails the old file is removed too, so tools fail closed instead of using a
 * changed Team. Every error stays within its session.
 */
export function refreshTeamFiles(deps: TeamFileDeps, events: readonly RawEventEnvelope[]) {
  const { all, projects, sessions } = teamFileChanges(events);
  if (!all && projects.size === 0 && sessions.size === 0) return;
  const dir = join(deps.home, "teams");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const sessionId = name.slice(0, -".json".length);
    try {
      const session = deps.session(sessionId);
      if (!session?.projectId) {
        rmSync(join(dir, name), { force: true });
        continue;
      }
      if (all || projects.has(session.projectId) || sessions.has(sessionId)) {
        writeTeamFile(deps, session);
      }
    } catch (error) {
      let removed = "removed";
      try {
        rmSync(join(dir, name), { force: true });
      } catch (rmError) {
        removed = `NOT removed (${rmError instanceof Error ? rmError.message : String(rmError)})`;
      }
      deps.log?.(
        `session ${sessionId}: Team file not written, old file ${removed}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
