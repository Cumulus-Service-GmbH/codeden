import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RawEventEnvelope, type Team, TeamFile } from "@codeden/contracts";

/** Where a project's Team file lives under CodeDen's home (`TEAM_FILE` points here). */
export function teamFilePath(home: string, projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error(`unsafe project id ${projectId}`);
  return join(home, "teams", `${projectId}.json`);
}

/** Write a project's Team file atomically, readable only by the user, and return its path. */
export function writeTeamFile(home: string, projectId: string, team: Team, now = new Date()) {
  const path = teamFilePath(home, projectId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = TeamFile.parse({ version: 1, projectId, team, updatedAt: now.toISOString() });
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
