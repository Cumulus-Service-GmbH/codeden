import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Project, type RawEventEnvelope, type Team, TeamFile } from "@codeden/contracts";

/** Where a project's Team file lives under CodeDen's home (`TEAM_FILE` points here). */
export function teamFilePath(home: string, projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error(`unsafe project id ${projectId}`);
  return join(home, "teams", `${projectId}.json`);
}

/** The folders whose code the project's Team governs: its own folder and its worktrees. */
export function teamRoots(project: Pick<Project, "path" | "slug">, worktreesDir: string) {
  return [project.path, join(worktreesDir, project.slug)];
}

/** Write a project's Team file atomically, readable only by the user, and return its path. */
export function writeTeamFile(
  home: string,
  projectId: string,
  team: Team,
  roots: string[],
  now = new Date(),
) {
  const path = teamFilePath(home, projectId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = TeamFile.parse({ version: 1, projectId, roots, team, updatedAt: now.toISOString() });
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
 * Rewrite a project's Team file after its factory loop changed (only once it has a file or a
 * Team). On failure the old file is removed, so tools fail closed instead of using a changed
 * Team; every error stays within this project.
 */
export function refreshTeamFile(opts: {
  home: string;
  worktreesDir: string;
  projectId: string;
  team: () => Team;
  project: () => Pick<Project, "path" | "slug">;
  log?: (message: string) => void;
}) {
  const { home, projectId } = opts;
  try {
    const team = opts.team();
    if (!team.length && !existsSync(teamFilePath(home, projectId))) return;
    writeTeamFile(home, projectId, team, teamRoots(opts.project(), opts.worktreesDir));
  } catch (error) {
    let removed = "removed";
    try {
      rmSync(teamFilePath(home, projectId), { force: true });
    } catch (rmError) {
      removed = `NOT removed (${rmError instanceof Error ? rmError.message : String(rmError)})`;
    }
    opts.log?.(
      `project ${projectId}: Team file not written, old file ${removed}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Projects whose factory loop (and so possibly its Team) changed in a batch of events. */
export function loopProjects(events: readonly RawEventEnvelope[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "factory.loop.updated") continue;
    const id = (event.payload as { loop?: { projectId?: unknown } } | null)?.loop?.projectId;
    if (typeof id === "string") ids.add(id);
  }
  return [...ids];
}
