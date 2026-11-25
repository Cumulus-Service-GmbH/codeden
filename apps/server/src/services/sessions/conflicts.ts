import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTIVE_SESSION_STATUSES,
  type WorkScope,
  type WorkSummary,
  type WorkspaceRequest,
} from "@codeden/contracts";
import { currentGitBranch } from "@codeden/providers";

/** Session statuses that count as running or queued work for conflict detection (§8.4). */
export { ACTIVE_SESSION_STATUSES };

/** Automation run statuses that count as running or queued work. */
export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

/** The work being started, as compared against existing work. */
export interface WorkCandidate {
  workKey: string;
  scope: WorkScope;
}

export interface WorkLocation {
  branch?: string | null;
  cwd?: string | null;
}

export function requestedLocation(workspace: WorkspaceRequest, projectPath?: string): WorkLocation {
  switch (workspace.mode) {
    case "worktree":
      return { branch: workspace.detachedSha ? null : workspace.branch };
    case "existing":
      return checkoutLocation(workspace.path);
    case "repo_root":
      return checkoutLocation(projectPath);
  }
}

export function checkoutLocation(cwd?: string, branch?: string | null): WorkLocation {
  if (!cwd) return { branch };
  return { cwd, branch: branch ?? currentGitBranch(cwd) };
}

function worktreePath(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return resolve(cwd);
  }
}

export function sameWorkLocation(a: WorkLocation, b: WorkLocation): boolean {
  return (
    (!!a.branch && a.branch === b.branch) ||
    (!!a.cwd && !!b.cwd && worktreePath(a.cwd) === worktreePath(b.cwd))
  );
}

/** `issue` from `issue:142`. */
export function workKind(workKey: string): string {
  return workKey.slice(0, workKey.indexOf(":"));
}

const norm = (p: string) =>
  p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();

/** True when one path equals or contains the other (`src` overlaps `src/auth/login.ts`). */
export function pathsOverlap(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x === "" || y === "") return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * Scopes overlap when they name the same area or overlapping paths. A scope with neither
 * (the whole project) never counts as overlapping, otherwise all work would conflict.
 */
export function scopesOverlap(a: WorkScope, b: WorkScope): boolean {
  if (a.projectId !== b.projectId) return false;
  if (a.area && b.area && a.area.toLowerCase() === b.area.toLowerCase()) return true;
  const pa = a.paths ?? [];
  const pb = b.paths ?? [];
  return pa.some((x) => pb.some((y) => pathsOverlap(x, y)));
}

/**
 * Existing work that conflicts with `candidate` (§8.4): the same `workKey`, or an overlapping
 * scope in the same project. Session admission checks workspace identity, while automation
 * preflight checks the kind of work. `existing` is limited to running or queued work.
 */
export function findConflicts(
  candidate: WorkCandidate,
  existing: WorkSummary[],
  sameWorkspace?: (work: WorkSummary) => boolean,
): WorkSummary[] {
  const kind = workKind(candidate.workKey);
  return existing.filter((w) => {
    if (w.projectId !== candidate.scope.projectId) return false;
    if (w.workKey === candidate.workKey) return true;
    return (
      scopesOverlap(candidate.scope, w.scope) &&
      (sameWorkspace ? sameWorkspace(w) : workKind(w.workKey) === kind)
    );
  });
}

/** Lowercase slug of up to `words` words, for derived work keys and branch names. */
export function slugWords(text: string, words = 6, maxLength = 48): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, words)
      .join("-")
      .slice(0, maxLength)
      .replace(/-+$/, "") || "work"
  );
}

/**
 * The work key for a start request: explicit, else `issue:<n>`, else `request:<slug>` derived
 * from the purpose so repeating the same request is detected as a duplicate.
 */
export function deriveWorkKey(input: {
  workKey?: string;
  issueNumber?: number;
  purpose: string;
}): string {
  if (input.workKey) return input.workKey;
  if (input.issueNumber !== undefined) return `issue:${input.issueNumber}`;
  return `request:${slugWords(input.purpose)}`;
}

export function firstPurposeLine(text: string | undefined): string {
  return (
    text
      ?.split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

/** One-line purpose from the request: explicit, else the first line of the input. */
export function derivePurpose(purpose: string | undefined, text: string | undefined): string {
  if (purpose) return purpose;
  const line = firstPurposeLine(text);
  if (!line) return "New session";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
