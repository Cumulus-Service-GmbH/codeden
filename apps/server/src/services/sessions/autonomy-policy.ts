import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  AutonomyLevel,
  REVIEW_TEAM_ROLES,
  type TeamRole,
  type WorkScope,
} from "@codeden/contracts";
import { badRequest } from "../errors";

export function stricter(a?: AutonomyLevel, b?: AutonomyLevel): AutonomyLevel | undefined {
  if (!a || !b) return a ?? b;
  return AutonomyLevel.options.indexOf(a) <= AutonomyLevel.options.indexOf(b) ? a : b;
}

function outsideProject(projectPath: string, path: string): boolean {
  const expanded = /^~[/\\]/.test(path) ? resolve(homedir(), path.slice(2)) : path;
  const fromProject = relative(projectPath, resolve(projectPath, expanded));
  return fromProject === ".." || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject);
}

/** Scope can require provider enforcement independently of the session's autonomy level. */
export function scopeEnforcement(
  role: TeamRole | null,
  purpose: string,
  scope: Pick<WorkScope, "paths" | "area"> | undefined,
  projectPath: string,
) {
  const paths = scope?.paths ?? [];
  return {
    readOnlyScope: Boolean(role && REVIEW_TEAM_ROLES.has(role) && !paths.length && !scope?.area),
    guardedInstall:
      /\binstall\w*\b/i.test(purpose) && paths.some((path) => outsideProject(projectPath, path)),
  };
}

export function assertAutonomy(
  requested: AutonomyLevel | undefined,
  floor: AutonomyLevel | undefined,
): void {
  if (requested && floor && stricter(requested, floor) !== requested) {
    throw badRequest(
      `Autonomy policy requires ${floor} or more supervision. Requested ${requested}.`,
      "autonomy_policy",
    );
  }
}
