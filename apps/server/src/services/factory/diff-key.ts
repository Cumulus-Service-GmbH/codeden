import { createHash } from "node:crypto";

/** One changed file of a PR with its unified patch against the merge base (null: none sent). */
export interface PatchedFile {
  path: string;
  previousPath?: string;
  status: string;
  patch: string | null;
}

/** A hunk header (`@@ -12,6 +14,7 @@ function name`): where the hunk is, not what it changes. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm;

/**
 * A fingerprint of what a pull request itself changes (§10.1, Review): every file's path, status
 * and patch against the merge base, with the hunk headers left out (commits the default branch
 * gained elsewhere in a file only move its hunks). Merging the default branch in (update-branch)
 * or a rebase that brought only its commits in keeps the fingerprint, so an approval carries
 * over to that head (`approval.ts`). Any change to the PR's own lines, the lines around them, or
 * a file it adds, removes or renames changes it. Null when it can't be told: a file GitHub sent
 * no patch for (binary, too large) or a file list GitHub cut short (`changedFiles` is more).
 */
export function prDiffKey(files: readonly PatchedFile[], changedFiles: number): string | null {
  if (files.length < changedFiles) return null;
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const f of sorted) {
    if (f.patch === null) return null;
    const body = f.patch.replace(HUNK_HEADER, "@@");
    hash.update(`${JSON.stringify([f.path, f.previousPath ?? null, f.status, body])}\n`);
  }
  return hash.digest("hex").slice(0, 24);
}
