import { binName, DISCARD, FUNCTION_NAME, unwrap } from "./command-words";
import { inlineScripts } from "./inline-scripts";
import { locationsAfter, MAX_LOCATIONS } from "./locations";
import type { PathContext } from "./paths";
import { MAX_DEPTH } from "./ran-scripts";
import { programDenial } from "./read-only";
import type { SimpleCommand } from "./shell";
import { shellReadings } from "./shell-readings";

/**
 * Commands a command line runs through braces and functions (§11.2): a PowerShell script block
 * (`if (…) { … }`, `try { … } catch { … }`, `foreach (…) { … }`, `& { … }`, `. { … }`), and the
 * body of a function where it is called (`f() { rm -rf x; }; f`, `function f { … }; f`). The risk
 * classifier judges each like the commands around it, in the folder the shell is in at that point,
 * and follows the folder changes they make (`if (…) { cd .. }; git clean -fdx`).
 */

type FunctionBody = SimpleCommand[];
export type FunctionTable = ReadonlyMap<string, readonly FunctionBody[]>;

/** A context carrying the function bodies encountered so far. */
export interface WithFunctions {
  functions?: FunctionTable;
  activeFunctions?: ReadonlySet<FunctionBody>;
}

interface FunctionDefinition {
  name: string;
  body: FunctionBody;
}

/** Analysis stopped before every command could be read. */
export class ShellTraversalError extends Error {}

/** Shared by the command and location walks, including every way the shell could read the line. */
export class ShellTraversalBudget {
  private remaining = 16_384;
  readonly lists = new WeakMap<SimpleCommand[], SimpleCommand[]>();
  readonly definitions = new WeakMap<SimpleCommand, FunctionDefinition>();

  visit(depth: number, cost = 1): void {
    this.remaining -= cost;
    if (this.remaining < 0 || depth > 32) {
      throw new ShellTraversalError("Runs more shell commands than can be followed");
    }
  }
}

const NO_COMMAND: SimpleCommand = { words: [], writes: [], nested: [] };
const HEADER = /^([A-Za-z_][\w-]*)\(\)(\{)?$/;
const CASE_PATTERN = /^[^()]+\)$/;
const PREFIXES = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
const CLOSERS = new Map([
  ["{", "}"],
  ["if", "fi"],
  ["for", "done"],
  ["select", "done"],
  ["while", "done"],
  ["until", "done"],
  ["case", "esac"],
]);

/** Shell syntax only exists in unquoted words. */
function wordAt(cmd: SimpleCommand, i: number): string {
  const word = cmd.words[i] ?? "";
  return cmd.quoted?.has(word) || cmd.vars?.has(word) ? "" : word;
}

function header(
  cmd: SimpleCommand,
  start = 0,
): { name: string; end: number; brace: boolean } | undefined {
  const keyword = wordAt(cmd, start).toLowerCase();
  const named = keyword === "function" || keyword === "filter";
  const i = named ? start + 1 : start;
  const first = named ? wordAt(cmd, i).replace(/^\w+:/, "") : wordAt(cmd, i);
  const posix = HEADER.exec(first);
  if (posix?.[1]) return { name: posix[1].toLowerCase(), end: i + 1, brace: Boolean(posix[2]) };
  if (FUNCTION_NAME.test(first) && wordAt(cmd, i + 1) === "()") {
    return { name: first.toLowerCase(), end: i + 2, brace: false };
  }
  if (!named) return undefined;
  // Parameter expressions can contain variables even when the function name is literal.
  const rawName = cmd.words[i] ?? "";
  const name = rawName.replace(/\(.*$/s, "").replace(/^\w+:/, "").toLowerCase();
  return FUNCTION_NAME.test(name) ? { name, end: i + 1, brace: false } : undefined;
}

function leadingHeader(
  cmd: SimpleCommand,
  budget: ShellTraversalBudget,
): ReturnType<typeof header> {
  let i = 0;
  for (;;) {
    const word = wordAt(cmd, i).toLowerCase();
    budget.visit(0);
    if (PREFIXES.has(word) || CASE_PATTERN.test(word)) {
      i += 1;
    } else if (word === "case") {
      // The parser may put the first pattern on the same command as the case header.
      const inWord = cmd.words.findIndex((_word, k) => k > i && wordAt(cmd, k) === "in");
      if (inWord === -1) break;
      i = inWord + 1;
    } else break;
  }
  const def = header(cmd, i);
  if (!def && /^(?:function|filter)$/i.test(wordAt(cmd, i)) && i + 1 < cmd.words.length) {
    throw unreadableFunction();
  }
  return def;
}

function startsSubshell(cmd: SimpleCommand, i: number): boolean {
  const word = cmd.words[i] ?? "";
  if (cmd.quoted?.has(word)) return false;
  return word.startsWith("(") && word.endsWith(")") && word !== "()";
}

/**
 * Read one function declaration. The POSIX reading keeps a brace body as several commands.
 * The other readings keep the same words as well as a parsed block.
 */
function captureBody(
  list: SimpleCommand[],
  index: number,
  def: NonNullable<ReturnType<typeof header>>,
  budget: ShellTraversalBudget,
): { body: FunctionBody; last: number; tail?: SimpleCommand } {
  const declaration = list[index] as SimpleCommand;
  let first = declaration;
  let start = def.end;
  let last = index;
  if (!def.brace && start === first.words.length) {
    first = list[++last] ?? NO_COMMAND;
    start = 0;
  }
  const block = first.blocks?.[0];
  const opener = wordAt(first, start);
  if (declaration.unparsed || first.unparsed) throw unreadableFunction();
  if (startsSubshell(first, start)) {
    return { body: [{ ...first, words: first.words.slice(start) }], last };
  }
  const close = def.brace ? "}" : CLOSERS.get(opener);
  if (!close) {
    if (block && opener === "{}") return { body: block, last };
    throw unreadableFunction();
  }

  const closers = [close];
  const body: SimpleCommand[] = [];
  const firstWord = start + Number(!def.brace && opener === "{");
  for (; last < list.length; last += 1) {
    const cmd = list[last] as SimpleCommand;
    budget.visit(0);
    const from = cmd === first ? firstWord : 0;
    const scanFrom = cmd === first && closers[0] !== "}" ? from + 1 : from;
    const end = scanClosers(cmd, scanFrom, closers, block !== undefined, budget);
    if (end !== from || !cmd.words.length) {
      const words = cmd.words.slice(from, end);
      const nested = cmd.nested.filter((group) => group.length > 0);
      body.push({ ...cmd, words, nested });
    }
    if (end !== undefined) {
      const tailWords = cmd.words.slice(end + 1);
      const tail = { ...cmd, words: tailWords, blocks: undefined };
      const redirect = { ...tail, words: [], nested: [] };
      const captured = block ?? body;
      // A redirection on the compound closer supplies input to the entire function.
      // The flattened list cannot attach it to all of the function's commands.
      if ((block || end === from) && (cmd.input?.length || cmd.heredocs?.length)) {
        throw unreadableFunction();
      }
      if (tailWords.length) return { body: captured, last, tail };
      if ((block || end === from) && (cmd.writes.length || cmd.reads?.length)) {
        return { body: [...captured, redirect], last };
      }
      return { body: captured, last };
    }
  }
  throw unreadableFunction();
}

function unreadableFunction(): ShellTraversalError {
  return new ShellTraversalError("Runs a function whose body could not be read");
}

/** Read compound openers at command position, and locate the closer for the outer body. */
function scanClosers(
  cmd: SimpleCommand,
  from: number,
  closers: string[],
  hasBlock: boolean,
  budget: ShellTraversalBudget,
): number | undefined {
  let i = from;
  while (i < cmd.words.length) {
    budget.visit(closers.length);
    const word = wordAt(cmd, i);
    if (word === closers.at(-1)) {
      closers.pop();
      if (closers.length === 0) return i;
      i += 1;
      continue;
    }
    const closes = CLOSERS.get(word);
    if (closes && (!hasBlock || word === "{")) closers.push(closes);
    const def = header(cmd, i);
    if (def) {
      if (def.brace) closers.push("}");
      i = def.end;
      continue;
    }
    if (!closes && !PREFIXES.has(word) && !CASE_PATTERN.test(word)) break;
    if (closes && word !== "{" && !PREFIXES.has(word)) break;
    i += 1;
  }
  // PowerShell does not require a separator before the closing brace.
  if (hasBlock) {
    for (; i < cmd.words.length; i += 1) {
      budget.visit(closers.length);
      const word = wordAt(cmd, i);
      if (word === "{") closers.push("}");
      if (word.endsWith("}") && closers.pop() === "}" && closers.length === 0) return i;
    }
  }
  return undefined;
}

/** Split function declarations from the commands that run in their surrounding list. */
export function functionAwareList(
  list: SimpleCommand[],
  budget: ShellTraversalBudget,
): SimpleCommand[] {
  const cached = budget.lists.get(list);
  if (cached) return cached;
  const result: SimpleCommand[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const cmd = list[i] as SimpleCommand;
    budget.visit(0, 1 + cmd.words.length);
    const def = leadingHeader(cmd, budget);
    if (!def) {
      result.push(cmd);
      continue;
    }
    const { body, last, tail } = captureBody(list, i, def, budget);
    const declaration = { ...NO_COMMAND, piped: cmd.piped };
    budget.definitions.set(declaration, { name: def.name, body });
    result.push(declaration);
    if (tail) result.push(tail);
    i = last;
  }
  budget.lists.set(list, result);
  return result;
}

/** The blocks and function bodies to inspect, each in the context in which it can run. */
export function ranLists<T extends WithFunctions>(
  cmd: SimpleCommand,
  ctx: T,
  budget: ShellTraversalBudget,
): Array<{ list: SimpleCommand[]; ctx: T }> {
  const declaration = budget.definitions.get(cmd);
  const { tokens } = unwrap(cmd.words);
  const word = tokens[0] === "." || tokens[0] === "&" ? tokens[1] : tokens[0];
  const bodies = declaration ? [declaration.body] : ctx.functions?.get(word?.toLowerCase() ?? "");
  const out: Array<{ list: SimpleCommand[]; ctx: T }> = [];
  for (const list of cmd.blocks ?? []) {
    budget.visit(0);
    out.push({ list, ctx });
  }
  for (const list of bodies ?? []) {
    budget.visit(0);
    if (ctx.activeFunctions?.has(list)) continue;
    out.push({
      list,
      ctx: { ...ctx, activeFunctions: new Set([...(ctx.activeFunctions ?? []), list]) },
    });
  }
  return out;
}

/** Keep all bodies that may have reached this point, including definitions in conditional lists. */
function mergeFunctions(
  prior: FunctionTable | undefined,
  incoming: FunctionTable,
  budget: ShellTraversalBudget,
): FunctionTable {
  if (!prior || prior === incoming) return incoming;
  let result: Map<string, readonly FunctionBody[]> | undefined;
  for (const [name, bodies] of incoming) {
    const before = prior.get(name) ?? [];
    budget.visit(0, 1 + before.length * bodies.length);
    const added = bodies.filter((body) => !before.includes(body));
    if (!added.length) continue;
    if (!result) {
      budget.visit(0, prior.size);
      result = new Map(prior);
    }
    result.set(name, [...before, ...added]);
  }
  return result ?? prior;
}

/** The programs that run a string in the shell itself, so its folder changes stay. */
const EVALS = new Set(["eval", "iex", "invoke-expression"]);

/** The command lists the string `cmd` evaluates holds (`eval 'cd ..'`), in each reading. */
function evaluated(cmd: SimpleCommand, ctx: PathContext, evalDepth: number): SimpleCommand[][] {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  if (!EVALS.has(bin)) return [];
  const scripts = inlineScripts(bin, tokens.slice(1), cmd);
  if (scripts.length && evalDepth >= MAX_DEPTH) {
    throw new ShellTraversalError("Runs shell evaluations nested too deep to follow");
  }
  return scripts.flatMap((script) => shellReadings(script.text, script.dialect, ctx, cmd.scope));
}

/**
 * Every location the shell may be in after `cmd`, from each of `ctxs`: where `cmd` itself moves
 * (`./locations`), and where its blocks, a function it calls and a string it evaluates may, since
 * they may run or not.
 */
export function locationsThrough<T extends PathContext & WithFunctions>(
  cmd: SimpleCommand,
  ctxs: readonly T[],
  budget: ShellTraversalBudget,
  traversalDepth = 0,
  evalDepth = 0,
): T[] {
  budget.visit(traversalDepth, ctxs.length);
  const declaration = budget.definitions.get(cmd);
  if (declaration) {
    const defined = new Map([[declaration.name, [declaration.body]]]);
    const functions = mergeFunctions(ctxs[0]?.functions, defined, budget);
    return ctxs.map((ctx) => ({ ...ctx, functions }));
  }

  let out = locationsAfter(cmd, ctxs);
  let functions = ctxs[0]?.functions;
  for (const here of ctxs) {
    const strings = evaluated(cmd, here, evalDepth);
    const runs = [
      ...ranLists(cmd, here, budget).map((run) => ({ ...run, evalDepth })),
      ...strings.map((list) => ({ list, ctx: here, evalDepth: evalDepth + 1 })),
    ];
    for (const ran of runs) {
      let inner: T[] = [ran.ctx];
      for (const one of functionAwareList(ran.list, budget)) {
        inner = locationsThrough(one, inner, budget, traversalDepth + 1, ran.evalDepth);
        if (inner.length > MAX_LOCATIONS) return inner;
      }
      for (const one of inner) {
        if (one.functions) functions = mergeFunctions(functions, one.functions, budget);
      }
      const back = inner.map((ctx) => ({ ...ctx, activeFunctions: here.activeFunctions }));
      out = locationsAfter(NO_COMMAND, [...out, ...back]);
      if (out.length > MAX_LOCATIONS) return out;
    }
  }
  return out.map((ctx) => ({ ...ctx, functions }));
}

/**
 * True when every command of `list` only reads (`./read-only`'s rules), with no redirect to a
 * file, substitution or block: what a script built when it runs must be to run without asking.
 */
export function listOnlyReads(list: SimpleCommand[]): boolean {
  if (list.length === 0) return false;
  return list.every((cmd) => {
    const { tokens, elevated } = unwrap(cmd.words);
    if (elevated || cmd.nested.length > 0 || cmd.blocks?.length) return false;
    if (cmd.writes.some((target) => !DISCARD.test(target))) return false;
    return programDenial(binName(tokens[0]), tokens.slice(1)) === undefined;
  });
}
