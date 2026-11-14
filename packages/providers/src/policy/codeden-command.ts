import type { RiskAssessment } from "./assessment";
import {
  codedenAccess,
  credentialsRisk,
  touchesCodedenCredentials,
  touchesCodedenHome,
} from "./codeden-home";
import { listsCodedenHome, reachesHomeThroughFolder, reachesThroughFolder } from "./codeden-search";
import { binName, CD, DISCARD, unwrap } from "./command-words";
import type { PathContext } from "./paths";
import { secretArgument } from "./secrets";
import { type SimpleCommand, type WordPaths, wordPaths } from "./shell";

/** How a verdict names what was touched in CodeDen's home (`codedenAccess`). */
export const CODEDEN_WHAT = {
  credentials: "CodeDen's own credentials",
  home: "CodeDen's own home",
} as const;

/** The paths each word of `cmd` may stand for: itself, and a PowerShell list's elements. */
export const pathsOf =
  (cmd: SimpleCommand): WordPaths =>
  (word, from) =>
    wordPaths(cmd, word, from);

/**
 * One simple command's access to CodeDen's home (§11.2, #320), its credentials first: a
 * redirect onto a path there, any argument (or here-string) that reaches one (read, written,
 * copied or deleted), a listing of a folder there, or a search or listing that reaches it from a
 * folder above (`./codeden-search`). The session's own worktree under the home is not part of
 * it. Moving into the home with `cd` reads nothing; the command that then reads is caught.
 * `feeds`: the command's output is used by another command (a pipe or a substitution).
 */
export function codedenCommand(
  cmd: SimpleCommand,
  ctx: PathContext,
  feeds: boolean,
): RiskAssessment | undefined {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  for (const target of cmd.writes) {
    const access = DISCARD.test(target) ? undefined : codedenAccess(target, ctx);
    if (access) return credentialsRisk(`Writes ${CODEDEN_WHAT[access]}: ${target}`);
  }
  for (const word of cmd.input ?? []) {
    const access = codedenAccess(word, ctx);
    if (access) return credentialsRisk(`Passes ${CODEDEN_WHAT[access]}: ${word}`);
  }
  if (CD.has(bin)) return undefined;
  const paths = pathsOf(cmd);
  const reads = (a: string) => touchesCodedenCredentials(a, ctx);
  const touched = secretArgument(bin, args, [], reads, paths);
  if (touched) return credentialsRisk(`Accesses CodeDen's own credentials: ${touched}`);
  const through = reachesThroughFolder(bin, args, ctx, feeds, paths);
  if (through) return credentialsRisk(`Reaches CodeDen's own credentials from ${through}`);
  const inHome = (a: string) => touchesCodedenHome(a, ctx);
  const opened = secretArgument(bin, args, [], inHome, paths);
  if (opened) return credentialsRisk(`Accesses CodeDen's own home: ${opened}`);
  const listed = listsCodedenHome(bin, args, ctx);
  if (listed) return credentialsRisk(`Lists CodeDen's own home: ${listed}`);
  const below = reachesHomeThroughFolder(bin, args, ctx, feeds, paths);
  return below ? credentialsRisk(`Reaches CodeDen's own home from ${below}`) : undefined;
}
