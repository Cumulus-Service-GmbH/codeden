import { type RiskAssessment, risky, SAFE } from "./assessment";
import { binName, unwrap } from "./command-words";
import { isWritable, type PathContext } from "./paths";
import { type SimpleCommand, wordPaths } from "./shell";

/**
 * Deletes outside the worktree (§11.2). `rm`, `del`, `Remove-Item` and their kin ask when they
 * name the filesystem root or a path outside where the agent may write (the worktree, the extra
 * roots, a folder in the OS temp directory). So do `xargs rm …` and a `ForEach-Object` block that
 * runs `Remove-Item`.
 *
 * A delete fed by a pipe (#449) removes what the pipeline hands it: `Get-ChildItem C:\Users |
 * Remove-Item -Recurse` deletes in `C:\Users` like `Remove-Item -Recurse C:\Users\*` does, and so
 * do `… | ForEach-Object { Remove-Item $_ }` and `… | xargs rm`. The command at the head of the
 * pipeline is checked: the paths it names, or the current directory for a listing that names
 * none (`Get-ChildItem -Recurse`, `find -name x`). Stages in between (`Where-Object`, `grep`,
 * `Select-Object -First 5`) only pass items on, and are not read as paths.
 */

/** Commands that delete the paths they are given. */
const DELETES = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "unlink",
  "shred",
]);
/** Listings: what they output lies under the paths they name, or the current directory. */
const LISTINGS = new Set(["get-childitem", "gci", "ls", "dir", "get-item", "gi", "find"]);
/** Listing parameters whose value is a pattern or a number, not a path. */
const PATTERN_PARAMS = new Set(["-filter", "-include", "-exclude", "-depth", "-attributes"]);
/** `xargs` options that take the next word as their value. */
const XARGS_VALUED = new Set([
  "-a",
  "-d",
  "-E",
  "-I",
  "-L",
  "-n",
  "-P",
  "-s",
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-chars",
  "--max-procs",
  "--process-slot-var",
]);
const FOREACH = new Set(["foreach-object", "%", "foreach"]);

/**
 * The delete risk of `cmd`: the paths it deletes itself and, when it reads a pipe, those the
 * command at the head of its pipeline (`source`) lists or names.
 */
export function classifyDelete(
  cmd: SimpleCommand,
  ctx: PathContext,
  source?: SimpleCommand,
): RiskAssessment {
  const own = deletedPaths(cmd);
  if (!own) return SAFE;
  for (const target of own) {
    const where = outside(target, ctx);
    if (where !== undefined) return risky("outside_worktree", `Deletes ${target}${where}`);
  }
  if (!source) return SAFE;
  for (const target of listedPaths(source)) {
    const where = outside(target, ctx);
    if (where !== undefined) {
      return risky("outside_worktree", `Deletes what a pipe lists from ${target}${where}`);
    }
  }
  return SAFE;
}

/**
 * Why deleting `target` asks: `""` for the filesystem root, `", outside the worktree"` for a path
 * the agent may not write. Undefined when it may delete it. `*` empties the current directory:
 * fine in the worktree or a folder in temp.
 */
function outside(target: string, ctx: PathContext): string | undefined {
  if (/^[\\/]$/.test(target) || /^[a-z]:[\\/]?$/i.test(target)) return "";
  return isWritable(target === "*" ? "." : target, ctx) ? undefined : ", outside the worktree";
}

/** The paths `cmd` deletes by name, or undefined when it deletes nothing. */
function deletedPaths(cmd: SimpleCommand): string[] | undefined {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  if (DELETES.has(bin)) return operands(cmd, args);
  if (bin === "xargs") {
    const inner = unwrap(xargsCommand(args)).tokens;
    return DELETES.has(binName(inner[0])) ? operands(cmd, inner.slice(1)) : undefined;
  }
  if (FOREACH.has(bin)) {
    // The words of `{ Remove-Item $_.FullName -Recurse }`, without the braces.
    const words = args.map((w) => w.replace(/^\{+/, "").replace(/[};]+$/, "")).filter(Boolean);
    const at = words.findIndex((w) => DELETES.has(w.toLowerCase()));
    return at >= 0 ? operands(cmd, words.slice(at + 1)) : undefined;
  }
  return undefined;
}

/** The command `xargs` runs: the words after its options. */
function xargsCommand(args: string[]): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") return args.slice(i + 1);
    if (!arg.startsWith("-")) return args.slice(i);
    if (XARGS_VALUED.has(arg)) i += 1;
  }
  return [];
}

/**
 * The paths a command lists or names, for the delete it feeds. A listing that names none lists
 * the current directory. `find`'s paths are the words before its expression.
 */
function listedPaths(source: SimpleCommand): string[] {
  const { tokens } = unwrap(source.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  const paths =
    bin === "find"
      ? findPaths(args)
      : operands(
          source,
          args.filter((_, k) => !PATTERN_PARAMS.has(args[k - 1]?.toLowerCase() ?? "")),
        );
  return paths.length > 0 || !LISTINGS.has(bin) ? paths : ["."];
}

/** `find [-H|-L|-P] [-D x] [-O1] path… expression`: the paths. */
function findPaths(args: string[]): string[] {
  let k = 0;
  while (k < args.length && /^-([HLP]|D|O\d*)$/.test(args[k] as string)) {
    k += args[k] === "-D" ? 2 : 1;
  }
  const rest = args.slice(k);
  const end = rest.findIndex((a) => /^[-(!)]/.test(a));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The path words among `args`: not options or cmd switches (`/s`), with PowerShell's bound
 * `-Path:x` and `-LiteralPath:x`, and each element of a PowerShell list (`a,b`).
 */
function operands(cmd: SimpleCommand, args: string[]): string[] {
  const paths: string[] = [];
  for (const arg of args) {
    const bound = /^-(path|literalpath|lp):/i.exec(arg);
    if (bound) paths.push(...wordPaths(cmd, arg, bound[0].length));
    else if (!arg.startsWith("-") && !/^\/[a-z]$/i.test(arg)) paths.push(...wordPaths(cmd, arg));
  }
  return paths;
}
