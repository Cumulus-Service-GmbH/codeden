import type { Session } from "@codeden/contracts";
import { ApiRequestError } from "@/lib/api";

/**
 * Whether a session gets the right panel and its toggle (§13): every agent session, whether it
 * runs in its own worktree or in place in the project folder. Subagents, the browser, files,
 * the terminal and details don't need git; the Diff tab says so itself when the folder isn't a
 * git repository (`isNotGitRepo`).
 */
export function hasRightPanel(session: Session | undefined): boolean {
  return session?.role === "agent";
}

/**
 * True for the error of a git request (status, diff) in a folder that isn't a git repository:
 * the runner answers `not_a_repo`.
 */
export function isNotGitRepo(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "not_a_repo";
}
