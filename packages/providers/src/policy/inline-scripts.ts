import type { ShellDialect } from "./shell";

/**
 * Command lines that another command runs (§11.2): a shell's inline script (`bash -c "…"`,
 * `pwsh -Command …`, `cmd /c …`) and the commands of cmd's `for` loop (#499). The risk
 * classifier parses each one and classifies it like a command line of its own.
 */

export interface InlineScript {
  /** The command line, as the shell gets it. */
  text: string;
  dialect: ShellDialect;
  /**
   * True when its output goes to the command that runs it rather than to the agent, like the
   * command a `for /f` loop reads (`('set AWS')`).
   */
  feeds?: boolean;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);

/** The command lines `bin` runs, given the words after it. */
export function inlineScripts(bin: string, args: string[]): InlineScript[] {
  if (SHELLS.has(bin)) {
    const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    const text = flag >= 0 ? args.slice(flag + 1).find((a) => !a.startsWith("-")) : undefined;
    return text ? [{ text, dialect: "posix" }] : [];
  }
  if (bin === "pwsh" || bin === "powershell") {
    const flag = args.findIndex((a) => /^-(c|command)$/i.test(a));
    return flag >= 0 ? [{ text: args.slice(flag + 1).join(" "), dialect: "powershell" }] : [];
  }
  if (bin === "cmd") {
    const flag = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return flag >= 0 ? [{ text: args.slice(flag + 1).join(" "), dialect: "auto" }] : [];
  }
  if (bin === "for") return forLoop(args);
  return [];
}

/** The `(…)` set of a `for` loop, maybe with `do` written right after it: `('set')do`. */
const SET = /^\(([\s\S]*)\)(do)?$/i;
/** A command a `for /f` loop reads: `'set AWS'`, or backquoted with `usebackq`. */
const QUOTED_COMMAND = /^(['`])([\s\S]*)\1$/;

/**
 * cmd's `for` loop: `for [/d | /r dir | /l | /f ["options"]] %i in (set) do command`. The command
 * after `do` runs for each item. `for /f` loops over lines, which it reads from a command's output
 * (`('set AWS')`, or `` (`set AWS`) `` with `usebackq`), from files (`(.env)`, or `("my file")` with
 * `usebackq`) or from a string (`("a b")`, or `('a b')` with `usebackq`). The lexer keeps the set
 * as written, so the command is parsed here; files are read as `type` reads them. Text in single
 * quotes or backquotes counts as a command whatever the switches and options say, so they can't
 * hide one. cmd's `^` escapes (`'set AWS ^| findstr KEY'`) are taken out. A POSIX `for`
 * (`for f in *.txt; do`) has no `(…)` set and runs its body as commands of their own.
 */
function forLoop(args: string[]): InlineScript[] {
  const lower = args.map((a) => a.toLowerCase());
  const at = lower.findIndex((w, i) => w === "in" && SET.test(args[i + 1] ?? ""));
  const set = SET.exec(args[at + 1] ?? "");
  if (at < 0 || !set) return [];
  const scripts: InlineScript[] = [];
  const options = lower.slice(0, at);
  const lines = options.some((o) => o.startsWith("/f"));
  const read = loopInput((set[1] as string).trim(), lines, options.join(" ").includes("usebackq"));
  if (read) scripts.push({ text: read, dialect: "auto", feeds: true });
  const body = set[2] ? args.slice(at + 2) : doBody(args.slice(at + 2));
  if (body.length > 0) scripts.push({ text: uncaret(body.join(" ")), dialect: "auto" });
  return scripts;
}

/**
 * What a loop's set runs or reads, as a command line: its quoted command, or `type` reading the
 * files a `for /f` set names. A plain `for` only names its items.
 */
function loopInput(set: string, lines: boolean, usebackq: boolean): string | undefined {
  const command = QUOTED_COMMAND.exec(set);
  if (command) return uncaret(command[2] as string);
  if (!lines || set === "" || (set.startsWith('"') && !usebackq)) return undefined;
  return `type ${uncaret(set)}`;
}

/** The words of the command after `do`: `do @echo %i`, or `do(set AWS)` written together. */
function doBody(rest: string[]): string[] {
  const first = rest[0]?.toLowerCase();
  if (first === "do") return rest.slice(1);
  if (first?.startsWith("do(")) return [(rest[0] as string).slice(2), ...rest.slice(1)];
  return [];
}

/** cmd's `^` escapes the character after it. */
const uncaret = (text: string) => text.replace(/\^([\s\S])/g, "$1");
