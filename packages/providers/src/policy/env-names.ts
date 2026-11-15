import { binName, DISCARD, unwrap } from "./command-words";
import { ENV_DRIVE, listsEnvironment } from "./env-dumps";
import type { SimpleCommand } from "./shell";

/**
 * Names-only environment listings (§11.2, #422). Listing the environment counts as dumping it
 * (`listsEnvironment`), unless the pipeline after the listing keeps only the names and those
 * reach the agent: `… | Select-Object -ExpandProperty Name`, `… | ForEach-Object { $_.Name }`,
 * `(Get-ChildItem env:).Name`, `Get-ChildItem env: -Name`, `printenv | cut -d= -f1`, a `sed`
 * that drops `=` and the rest, `awk -F= '{print $1}'`, cmd's
 * `for /f "delims==" %i in ('set') do @echo %i`, or clearing the listed variables
 * (`… | Remove-Item`, `… | ForEach-Object { Remove-Item "Env:$($_.Name)" }`). Each stage after
 * the listing is followed. A stage this module doesn't know, one that mentions values or looks
 * them up, one that writes entries to a file, or names handed to another command (a substitution,
 * an inline script piped on) keeps the listing a dump.
 */

/**
 * Where a command list's output goes: shown to the agent, projected to names by the command it
 * sits in (`(…).Name`), or handed to another command (a substitution or piped inline script).
 */
export type ListOutput = "shown" | "names" | "feeds";

/** What flows down a pipeline from a listing: entries (names with values), names, or nothing. */
type Flow = "entries" | "names" | "none";

/** The listings in a command list that only show names, and the `(…).Name` projections. */
export interface NamesOnly {
  /** Indexes of listings (`listsEnvironment`) whose pipeline keeps only the names. */
  listings: ReadonlySet<number>;
  /**
   * Indexes of commands that project their first nested list to names: `(…).Name`, and cmd's
   * `for /f "delims==" %i in ('…') do @echo %i`.
   */
  projections: ReadonlySet<number>;
}

/** Words that mention a variable's value or may look one up. */
const LOOKUP = /value|environment|env:|getenv/i;

const WHERE = new Set(["where-object", "where", "?"]);
const SORT = new Set(["sort-object", "sort"]);
const SELECT = new Set(["select-object", "select"]);
const FOREACH = new Set(["foreach-object", "foreach", "%"]);
const FORMAT = new Set(["format-table", "ft", "format-list", "fl", "format-wide", "fw"]);
const REMOVE = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
/** Line filters: they pass lines on (entries stay entries, names stay names). */
const LINES = new Set([
  "grep",
  "egrep",
  "fgrep",
  "findstr",
  "select-string",
  "sls",
  "head",
  "tail",
  "uniq",
]);
/** Commands that only reshape or show text, fine once just names flow. */
const TEXT = new Set([
  "cut",
  "tr",
  "wc",
  "column",
  "more",
  "less",
  "nl",
  "rev",
  "get-unique",
  "gu",
]);
const OUT = new Set(["out-string", "out-host", "out-default", "measure-object", "measure"]);
const AWK = new Set(["awk", "gawk", "mawk", "nawk"]);

/** `(Get-ChildItem env:).Name`: one plain group (no quotes, no inner groups) and its names. */
const PROJECTION = /^\$?\(([^()'"`]*)\)\.(name|key)$/i;
/** `$_.Name` in a script block. */
const ITEM_NAME = /^\$(_|psitem)\.(name|key)$/i;
/** The variable a removal in a script block names: `Env:$($_.Name)`, `Env:\$_`. */
const ITEM_VARIABLE = /^env:\\?(\$\(\$(_|psitem)\.(name|key)\)|\$(_|psitem))$/i;
/** Switches and named parameters a removal may carry; they print no values. */
const REMOVE_SWITCHES = new Set(["-force", "-verbose", "-whatif", "-recurse"]);
const REMOVE_NAMED = new Set(["-erroraction", "-ea"]);

const isName = (property: string) => /^(name|key)$/i.test(property);
const elements = (word = "") =>
  word
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Which listings and projections of `list` only show names, given where its output goes. */
export function namesOnly(list: SimpleCommand[], output: ListOutput): NamesOnly {
  const listings = new Set<number>();
  const projections = new Set<number>();
  if (output === "feeds") return { listings, projections };
  const keeps = (flow: Flow | undefined) =>
    output === "shown" ? flow === "names" || flow === "none" : flow !== undefined;
  for (const [i, cmd] of list.entries()) {
    const from = source(cmd);
    if (from && keeps(flowFrom(list, i, from))) listings.add(i);
    if ((projects(cmd) || echoesNames(cmd)) && keeps(flowFrom(list, i, "names"))) {
      projections.add(i);
    }
  }
  return { listings, projections };
}

/**
 * What a listing outputs: entries, or names with `Get-ChildItem env: -Name`. Bare `printenv`
 * only.
 */
function source(cmd: SimpleCommand): Flow | undefined {
  if (cmd.writes.some((w) => !DISCARD.test(w))) return undefined;
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  if (bin === "printenv") return args.length === 0 ? "entries" : undefined;
  if (!listsEnvironment(bin, args)) return undefined;
  const names = ENV_DRIVE.test(bin) && args.some((a) => a.toLowerCase() === "-name");
  return names ? "names" : "entries";
}

/**
 * cmd's `for /f "delims==" %i in ('set') do @echo %i` (`tokens=1` allowed, `%%i` in a batch
 * file): the loop echoes what comes before the first `=` of each line its command prints.
 */
function echoesNames(cmd: SimpleCommand): boolean {
  const [loop, mode, options = "", variable = "", inWord, , doWord, ...body] = cmd.words;
  if (loop?.toLowerCase() !== "for" || mode?.toLowerCase() !== "/f") return false;
  if (cmd.nested.length !== 1 || inWord?.toLowerCase() !== "in" || doWord?.toLowerCase() !== "do") {
    return false;
  }
  const settings = options.toLowerCase().split(/\s+/).filter(Boolean);
  return (
    settings.includes("delims==") &&
    settings.every((s) => s === "delims==" || s === "tokens=1") &&
    /^%%?[a-z]$/i.test(variable) &&
    body.length === 2 &&
    /^@?echo$/i.test(body[0] as string) &&
    body[1] === variable
  );
}

/** `(…).Name` as the command, with no other substitution and no value in its operators. */
function projects(cmd: SimpleCommand): boolean {
  const [first, ...rest] = cmd.words;
  return (
    cmd.nested.length === 1 &&
    first !== undefined &&
    PROJECTION.test(first) &&
    !rest.some((w) => LOOKUP.test(w))
  );
}

/** What reaches the end of the pipeline that `list[i]` starts, from `flow`. */
function flowFrom(list: SimpleCommand[], i: number, flow: Flow): Flow | undefined {
  let current: Flow | undefined = flow;
  for (let j = i + 1; current && list[j]?.piped; j += 1) {
    current = stage(current, list[j] as SimpleCommand);
  }
  return current;
}

/** What one stage of the pipeline passes on; undefined when it may show or look up values. */
function stage(flow: Flow, cmd: SimpleCommand): Flow | undefined {
  if (flow === "none") return "none";
  if (flow === "entries" && cmd.writes.some((w) => !DISCARD.test(w))) return undefined;
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  // A removal's `Env:$($_.Name)` is a substitution; it is classified on its own.
  if (FOREACH.has(bin)) return forEach(args, cmd.nested.length > 0);
  if (cmd.nested.length > 0) return undefined;
  if (WHERE.has(bin) || SORT.has(bin)) return args.some((a) => LOOKUP.test(a)) ? undefined : flow;
  if (SELECT.has(bin)) return select(flow, args);
  if (FORMAT.has(bin)) return format(flow, args);
  if (REMOVE.has(bin)) return flow === "entries" && onlyRemoveOptions(args) ? "none" : undefined;
  if (LINES.has(bin)) return flow;
  if (flow === "names") return TEXT.has(bin) || OUT.has(bin) ? "names" : undefined;
  if (bin === "cut") return cutsName(args) ? "names" : undefined;
  if (bin === "sed") return stripsValue(args) ? "names" : undefined;
  if (AWK.has(bin)) return printsName(args) ? "names" : undefined;
  return undefined;
}

/**
 * `ForEach-Object { $_.Name }`, `ForEach-Object Name` or `-MemberName Name` pass names on;
 * `ForEach-Object { Remove-Item "Env:$($_.Name)" }` clears the variables and passes nothing.
 */
function forEach(args: string[], nested: boolean): Flow | undefined {
  const inner = scriptBlock(args);
  if (inner) {
    if (removesItem(inner)) return "none";
    return !nested && inner.length === 1 && ITEM_NAME.test(inner[0] as string)
      ? "names"
      : undefined;
  }
  if (nested) return undefined;
  const member = args[0]?.toLowerCase() === "-membername" ? args.slice(1) : args;
  return member.length === 1 && isName(member[0] as string) ? "names" : undefined;
}

/** The words inside `{ … }` when the arguments are exactly one script block. */
function scriptBlock(args: string[]): string[] | undefined {
  const first = args[0];
  const last = args.at(-1);
  if (!first?.startsWith("{") || !last?.endsWith("}")) return undefined;
  const words =
    args.length === 1
      ? [first.slice(1, -1)]
      : [first.slice(1), ...args.slice(1, -1), last.slice(0, -1)];
  const inner = words.map((w) => w.trim()).filter(Boolean);
  return inner.some((w) => /[{}]/.test(w)) ? undefined : inner;
}

/** `Remove-Item [-Path] Env:$($_.Name) [-ErrorAction X] [-Force]`. */
function removesItem(words: string[]): boolean {
  if (!REMOVE.has(binName(words[0]))) return false;
  const args = words.slice(1);
  const at = /^-(path|literalpath)$/i.test(args[0] ?? "") ? 1 : 0;
  return ITEM_VARIABLE.test(args[at] ?? "") && onlyRemoveOptions(args.slice(at + 1));
}

function onlyRemoveOptions(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] as string).toLowerCase();
    if (REMOVE_NAMED.has(arg)) i += 1;
    else if (!REMOVE_SWITCHES.has(arg)) return false;
  }
  return true;
}

/** `Select-Object` keeping only `Name` (or `-First 5`, `-Unique`, which keep what flows). */
function select(flow: Flow, args: string[]): Flow | undefined {
  const named: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] as string).toLowerCase();
    if (/^-(expandproperty|expand|exp|property|prop)$/.test(arg)) {
      named.push(...elements(args[i + 1]));
      i += 1;
    } else if (/^-(first|last|skip)$/.test(arg)) {
      if (!/^\d+$/.test(args[i + 1] ?? "")) return undefined;
      i += 1;
    } else if (arg !== "-unique") {
      if (arg.startsWith("-")) return undefined;
      named.push(...elements(args[i]));
    }
  }
  if (named.length === 0) return flow;
  return named.every(isName) ? "names" : undefined;
}

/** `Format-Table Name`: a table of names. Without properties it shows what flows. */
function format(flow: Flow, args: string[]): Flow | undefined {
  const named: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] as string).toLowerCase();
    if (/^-(property|prop)$/.test(arg)) {
      named.push(...elements(args[i + 1]));
      i += 1;
    } else if (!["-autosize", "-hidetableheaders", "-wrap"].includes(arg)) {
      if (arg.startsWith("-")) return undefined;
      named.push(...elements(args[i]));
    }
  }
  if (named.length === 0) return flow === "names" ? "names" : undefined;
  return named.every(isName) ? "names" : undefined;
}

/** `cut -d= -f1` (or `-d '='`, `--delimiter==`, `-f 1`, `--fields=1`): the names of `NAME=value`. */
function cutsName(args: string[]): boolean {
  let delimiter: string | undefined;
  let fields: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const d = /^(?:-d|--delimiter=?)(.*)$/.exec(arg);
    const f = /^(?:-f|--fields=?)(.*)$/.exec(arg);
    if (d) delimiter = d[1] || args[++i];
    else if (f) fields = f[1] || args[++i];
    else return false;
  }
  return delimiter === "=" && fields === "1";
}

/**
 * `sed` with one script that drops `=` and the rest of the line: `s`, a delimiter, `=.*`, then
 * the delimiter twice (any delimiter; `$` before it and `g` after optional; `-e`, `-E`, `-r` allowed).
 */
function stripsValue(args: string[]): boolean {
  const scripts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-e" || arg === "--expression") scripts.push(args[++i] ?? "");
    else if (arg === "-E" || arg === "-r" || arg === "--regexp-extended") continue;
    else if (arg.startsWith("-") || scripts.length > 0) return false;
    else scripts.push(arg);
  }
  return scripts.length === 1 && /^s(.)=\.\*\$?\1\1g?$/.test(scripts[0] as string);
}

/** `awk -F= '{print $1}'` (or `-F '='`). */
function printsName(args: string[]): boolean {
  let separator: string | undefined;
  const programs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith("-F")) separator = arg.slice(2) || args[++i];
    else if (arg.startsWith("-")) return false;
    else programs.push(arg);
  }
  return (
    separator === "=" &&
    programs.length === 1 &&
    /^\{\s*print\s+\$1\s*;?\s*\}$/.test(programs[0] as string)
  );
}
