import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  AutonomyLevel,
  type AutonomyPolicy,
  REVIEW_TEAM_ROLES,
  roleAutonomyFloor,
  type Settings,
  type TeamRole,
  type WorkScope,
} from "@codeden/contracts";
import { badRequest } from "../errors";

export function stricter(a?: AutonomyLevel, b?: AutonomyLevel): AutonomyLevel | undefined {
  if (!a || !b) return a ?? b;
  return AutonomyLevel.options.indexOf(a) <= AutonomyLevel.options.indexOf(b) ? a : b;
}

function purposeTokens(purpose: string): string {
  return (purpose.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

function outsideProject(projectPath: string, path: string): boolean {
  const expanded = /^~[/\\]/.test(path) ? resolve(homedir(), path.slice(2)) : path;
  const fromProject = relative(projectPath, resolve(projectPath, expanded));
  return fromProject === ".." || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject);
}

function matchingFloor(rules: Record<string, AutonomyLevel> | undefined, tokens: string) {
  let floor: AutonomyLevel | undefined;
  for (const [name, rule] of Object.entries(rules ?? {})) {
    const phrase = purposeTokens(name);
    if (phrase && tokens.includes(` ${phrase} `)) floor = stricter(floor, rule);
  }
  return floor;
}

/** Resolve PM-started work. Scope qualifies for a lane default; it grants no write authority. */
export function resolveAutonomy(
  role: TeamRole | null,
  purpose: string,
  scope: Pick<WorkScope, "paths" | "area"> | undefined,
  projectPath: string | undefined,
  settings: Settings["autonomy"],
  projectPolicy?: AutonomyPolicy,
  existing?: { readOnlyScope?: boolean; guardedInstall?: boolean },
) {
  const key = role ?? "agent";
  const paths = scope?.paths ?? [];
  const outside = projectPath ? paths.filter((path) => outsideProject(projectPath, path)) : [];
  const readOnlyScope = Boolean(
    role &&
      REVIEW_TEAM_ROLES.has(role) &&
      !paths.length &&
      !scope?.area &&
      (!existing || existing.readOnlyScope),
  );
  const tokens = ` ${purposeTokens(purpose)} `;
  const sensitive =
    /\b(prd|prod|production|provision\w*|migrat\w*|secrets?|dbops)\b/.test(tokens) ||
    (/\bazure\b/.test(tokens) && /\b(creat\w*|new)\b/.test(tokens));
  const install = /\binstall\w*\b/.test(tokens);
  const guardedInstall =
    !sensitive &&
    install &&
    outside.length > 0 &&
    outside.length === paths.length &&
    (!existing || existing.guardedInstall === true);
  const gated = sensitive || (install && !guardedInstall);
  const scopeDefault = outside.length ? "auto" : readOnlyScope ? "full" : undefined;
  const baseline = roleAutonomyFloor(key, settings.roleFloors, settings.pmPolicy, scopeDefault);
  const localPurpose = matchingFloor(settings.pmPolicy?.[key], tokens);
  const local =
    baseline.source === "local"
      ? stricter(baseline.level, localPurpose)
      : (localPurpose ?? baseline.level);
  const projectRules = projectPolicy?.[key];
  const project = matchingFloor(projectRules, tokens) ?? projectRules?.["*"];
  const floor = stricter(stricter(local, project), gated ? "supervised" : scopeDefault);
  return { floor, readOnlyScope, guardedInstall };
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
