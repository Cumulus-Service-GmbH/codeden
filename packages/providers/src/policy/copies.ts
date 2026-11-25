import { isScriptBlock, joinScriptBlocks, scriptBlockWords } from "./command-words";
import { isTempRoot, isWin, type PathContext } from "./paths";
import { matchesLong } from "./read-only-options";
import type { ShellDialect } from "./shell";

/**
 * Where a copy, move or file-writing command writes (§11.2): `cp`, `mv`, cmd's `copy`, `move`,
 * `xcopy` and `robocopy`, PowerShell's `Copy-Item` and `Move-Item`, the `cpy` and `cpx` packages,
 * and `tee`, `Set-Content`, `Out-File` and `Add-Content`.
 */

const COPIES = [
  ...["cp", "mv", "copy", "move", "copy-item", "move-item", "xcopy", "robocopy"],
  ...["cpy", "cpx"],
];
const WRITERS = ["tee", "set-content", "out-file", "add-content"];
/** The context of a copy: the paths, and the shell the command runs in when it is known. */
type CopyContext = PathContext & { shell?: ShellDialect };

/** cmd's own copies, and the switches each takes. */
const CMD_SWITCHES = new Map<string, RegExp>([
  ["copy", /^\/(?:-?y|[abdvnzl])$/i],
  ["move", /^\/-?y$/i],
]);
/** A switch of `xcopy` or `robocopy`: `/E`, `/R:3`. */
const TOOL_SWITCH = /^\/[a-z]+(:\S*)?$/i;

/**
 * True when `word` is a switch of the copy `bin`, not a path. `copy` and `move` are cmd's own
 * commands only where cmd may be the shell; in PowerShell they are `Copy-Item` and `Move-Item`,
 * and `/o` is a path. `xcopy` and `robocopy` are programs that read `/X` as a switch in any shell
 * but a POSIX one on Windows, which hands them `/c` as the `C:` drive. For `cp` and `mv`, `/tmp`
 * is a path.
 */
function isSwitch(bin: string, word: string, ctx: CopyContext): boolean {
  if (bin === "xcopy" || bin === "robocopy") return ctx.shell !== "posix" && TOOL_SWITCH.test(word);
  const cmd = isWin(ctx) && ctx.shell !== "posix" && ctx.shell !== "powershell";
  return cmd && CMD_SWITCHES.get(bin)?.test(word) === true;
}

/** What a copy or write writes: the paths to judge, and the words naming them that read nothing. */
export interface CopyWrites {
  targets: string[];
  words: string[];
}

/**
 * The destination of a copy, move or write. One a script block computes (`-Destination
 * { 'C:\Old\' + $_.Name }`) may be named by any of its words.
 */
export function copyWrites(bin: string, args: string[], ctx: CopyContext): CopyWrites {
  if (!COPIES.includes(bin) && !WRITERS.includes(bin)) return { targets: [], words: [] };
  const { positional, named, sources } = operands(bin, joinScriptBlocks(args), ctx);
  const destinations = destinationsOf(bin, positional, named);
  const words = destinations.flatMap((dest) =>
    isScriptBlock(dest) ? scriptBlockWords(dest).filter((w) => !w.startsWith("-")) : [dest],
  );
  return {
    targets: words.flatMap((word) => copyTargets(bin, [...sources, ...positional], word, ctx)),
    words,
  };
}

const PS_WRITERS = ["set-content", "out-file", "add-content"];
const PS_PATHS = ["path", "literalpath", "filepath", "lp", "pspath"];
const PS_OPTION_VALUES = [
  ...PS_PATHS,
  "destination",
  "encoding",
  "value",
  "filter",
  "include",
  "exclude",
  "credential",
  "width",
  "stream",
  "inputobject",
  "erroraction",
  "warningaction",
  "informationaction",
  "progressaction",
  "errorvariable",
  "warningvariable",
  "informationvariable",
  "outvariable",
  "outbuffer",
  "pipelinevariable",
];
const PS_SWITCHES = [
  "force",
  "recurse",
  "passthru",
  "nonewline",
  "append",
  "noclobber",
  "whatif",
  "confirm",
  "verbose",
  "debug",
];

/** Read option values before identifying positional write targets. */
function operands(bin: string, args: string[], ctx: CopyContext) {
  const positional: string[] = [];
  const named: string[] = [];
  const sources: string[] = [];
  const couldBePowerShell = ctx.shell === "powershell" || (isWin(ctx) && ctx.shell !== "posix");
  const psWriter = PS_WRITERS.includes(bin) || (bin === "tee" && couldBePowerShell);
  const unixCopy = bin === "cp" || bin === "mv";
  const ps =
    psWriter ||
    bin.endsWith("-item") ||
    (couldBePowerShell && (unixCopy || bin === "copy" || bin === "move"));
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (isSwitch(bin, arg, ctx)) continue;
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (ps) {
      const option = /^-([^:]+)(?::(.*))?$/s.exec(arg);
      const name = option?.[1]?.toLowerCase() ?? "";
      const matches = [...PS_OPTION_VALUES, ...PS_SWITCHES].filter((candidate) =>
        candidate.startsWith(name),
      );
      const parameter = matches.includes(name)
        ? name
        : matches.length === 1
          ? matches[0]
          : undefined;
      if (parameter !== undefined && PS_OPTION_VALUES.includes(parameter)) {
        const value = option?.[2] ?? args[++i];
        if (value === undefined) continue;
        if (parameter === "destination" || (psWriter && PS_PATHS.includes(parameter)))
          named.push(value);
        else if (PS_PATHS.includes(parameter)) sources.push(value);
        continue;
      }
    }
    if (unixCopy) {
      const short = /^-[a-zA-Z]*?([St])(.*)$/s.exec(arg);
      const directory = matchesLong(arg, "--target-directory") || short?.[1] === "t";
      if (directory || matchesLong(arg, "--suffix") || short?.[1] === "S") {
        const equals = arg.indexOf("=");
        const attached = equals >= 0 && !short ? arg.slice(equals + 1) : short?.[2] || undefined;
        const value = attached ?? args[++i];
        if (directory && value !== undefined) named.push(value);
      }
    } else if (
      (bin === "cpy" || bin === "cpx") &&
      /^(?:--cwd|--rename|--include|--exclude|-i|-x)$/.test(arg)
    ) {
      i += 1;
    }
  }
  return { positional, named, sources };
}

function destinationsOf(bin: string, positional: string[], named: string[]): string[] {
  if (named.length > 0) return named;
  if (bin === "tee") return positional;
  if (PS_WRITERS.includes(bin)) return positional.slice(0, 1);
  if (bin === "robocopy" || bin === "xcopy") return positional.slice(1, 2);
  return positional.slice(-1);
}

/**
 * The paths a copy or write lands on. A copy into a temp directory itself (`cp a.png /tmp/`)
 * writes the copied names inside it, so they are checked instead (a secrets file there asks).
 */
function copyTargets(bin: string, operands: string[], dest: string, ctx: CopyContext): string[] {
  if (!COPIES.includes(bin) || !isTempRoot(dest, ctx)) return [dest];
  const sources = (bin === "robocopy" || bin === "xcopy" ? operands.slice(0, 1) : operands).filter(
    (a) => a !== dest,
  );
  const names = sources
    .map(
      (s) =>
        s
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() ?? "",
    )
    .filter(Boolean);
  return names.length ? names.map((name) => `${dest.replace(/[\\/]+$/, "")}/${name}`) : [dest];
}
