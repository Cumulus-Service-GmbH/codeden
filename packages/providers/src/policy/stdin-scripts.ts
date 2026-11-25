import { binName, unwrap } from "./command-words";
import type { InlineScript } from "./inline-scripts";
import { runsStdin, shellScriptFile } from "./remote-scripts";
import type { ShellDialect, SimpleCommand } from "./shell";

/**
 * Scripts a shell or an interpreter reads on its input (§11.2): a pipe (`… | sh`), a here-string
 * (`bash <<< '…'`), a heredoc (`bash <<EOF`, `python - <<EOF`) and a process substitution that is
 * sourced or run (`source <(…)`, `bash <(…)`). `at` and `batch` read the script they schedule
 * there too. When the script is written out (the here-string, the heredoc's body, what an
 * `echo '…'` or a PowerShell string at the head of the pipe prints) it is judged like the script
 * of `bash -c`; code for `python`, `node`, `php` and the like, like that of `python -c`
 * (`./inline-code`). Anything else is only known when it runs.
 */

/** The pipe a command reads: the command at its head, and whether other commands sit between. */
export interface Feed {
  source?: SimpleCommand;
  filtered?: boolean;
}

/** What a command reads on its input: the text when it is written out, and whether that is all. */
export interface Input {
  text: string;
  /** True when the shell fills in parts of it, or it isn't written out at all. */
  dynamic: boolean;
  /** True when the printed text is only a candidate because the format is not modelled. */
  opaque?: boolean;
}

const UNKNOWN: Input = { text: "", dynamic: true };

/** Shells, and the schedulers that hand what they read to one (`echo '…' | at now`). */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "at", "batch"]);
const SOURCES = new Set(["source", "."]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);
/** Commands that print their words. */
const PRINTS = new Set(["echo", "printf", "write-output"]);

/** The dialect of the lines `bin` runs from its input; undefined when it runs code, or nothing. */
function dialectOf(bin: string): ShellDialect | undefined {
  if (SHELLS.has(bin) || SOURCES.has(bin)) return "posix";
  if (POWERSHELLS.has(bin)) return "powershell";
  return bin === "cmd" ? "auto" : undefined;
}

/** True when `word` of `cmd` is as written: the shell expands nothing in it. */
const literal = (cmd: SimpleCommand, word: string): boolean =>
  !cmd.vars?.has(word) && !word.includes("`");

/** What `cmd` reads from a heredoc or a here-string of its own, the last one given. */
function ownInput(cmd: SimpleCommand): Input | undefined {
  const heredoc = cmd.inputKind === "here-string" ? undefined : cmd.heredocs?.at(-1);
  if (heredoc?.quoted) return { text: heredoc.body, dynamic: false };
  if (heredoc) {
    // The shell takes the backslash out of `\$`, `` \` `` and `\\` before the command reads the body.
    const text = heredoc.body.replace(/\\([$`\\])/g, "$1");
    return { text, dynamic: /[$`]/.test(heredoc.body.replace(/\\[$`\\]/g, "")) };
  }
  const word = cmd.input?.at(-1);
  return word === undefined ? undefined : { text: word, dynamic: !literal(cmd, word) };
}

/**
 * What `source` prints: its words for `echo` and `printf`, its own input for a bare `cat`, and a
 * string standing alone, which PowerShell prints (`'Get-Content x' | pwsh -Command -`). Where the
 * shell may be POSIX that string may name a program instead, so the script is not all known then.
 */
function printed(source: SimpleCommand, dialect?: ShellDialect): Input {
  const [only] = source.words;
  const alone = source.words.length === 1 && source.nested.length === 0;
  if (alone && only !== undefined && source.quoted?.has(only) && dialect !== "posix") {
    return { text: only, dynamic: dialect !== "powershell" || !literal(source, only) };
  }
  const { tokens } = unwrap(source.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  if (bin === "cat" && args.length === 0) return ownInput(source) ?? UNKNOWN;
  if (!PRINTS.has(bin)) return UNKNOWN;
  const words = bin === "echo" && /^-[neE]+$/.test(args[0] ?? "") ? args.slice(1) : args;
  const text = words.join(bin === "printf" ? "\n" : " ").replace(/\\n/g, "\n");
  const opaque =
    (bin === "printf" && (words.length > 1 || words.some((w) => /%|\\(?!n)/.test(w)))) ||
    (bin === "echo" &&
      (words.some((w) => w.includes("\\")) ||
        (words !== args && /^-[neE]+$/.test(words[0] ?? ""))));
  const dynamic = opaque || source.nested.length > 0 || !words.every((w) => literal(source, w));
  return { text, dynamic, opaque };
}

/**
 * What `cmd` reads on its input; undefined when nothing feeds it. `at.stdin`: what the subshell,
 * block, function or script it is in reads, which is its input too (`… | (sh)`, `{ sh; } <<EOF`);
 * `at.shell`: the shell the command line is in.
 */
function inputOf(cmd: SimpleCommand, feed: Feed, at: WithStdin): Input | undefined {
  const own = ownInput(cmd);
  if (own) return own;
  if (!cmd.piped) return at.stdin;
  if (!feed.source) return UNKNOWN;
  const out = printed(feed.source, at.shell);
  return feed.filtered ? { ...out, dynamic: true } : out;
}

/**
 * The script a process substitution hands `cmd` as its file (`source <(echo '…')`): what its one
 * command prints, or unknown.
 */
function substituted(cmd: SimpleCommand, file: string | undefined): Input | undefined {
  if (!file?.startsWith("<(")) return undefined;
  const [list] = cmd.nested;
  const [head] = list ?? [];
  if (cmd.nested.length !== 1 || !head) return UNKNOWN;
  const out = printed(head, "posix");
  return list?.length === 1 ? out : { ...out, dynamic: true };
}

/**
 * The command lines `cmd` (program `bin`, its `args`) runs from its input, when it is a shell that
 * reads its script there. `at`: what the commands around it read, and the shell they are in.
 */
export function stdinScripts(
  cmd: SimpleCommand,
  bin: string,
  args: string[],
  feed: Feed,
  at: WithStdin,
): InlineScript[] {
  const dialect = dialectOf(bin);
  if (!dialect) return [];
  const file = SOURCES.has(bin) ? args[args[0] === "--" ? 1 : 0] : shellScriptFile(args);
  const sourced = dialect === "posix" ? substituted(cmd, file) : undefined;
  const input = sourced ?? (runsStdin(cmd) ? inputOf(cmd, feed, at) : undefined);
  if (!input) return [];
  const scripts = [{ text: input.text, dialect, dynamic: input.dynamic }];
  if (input.opaque) scripts.push({ ...UNKNOWN, dialect });
  return scripts;
}

/** Interpreters that run the code they read on their input. */
const CODE = /^(?:(?:python|pypy)[\d.]*|py|node|nodejs|perl|ruby|php)$/;

/**
 * The code `cmd` reads on its input, when it is an interpreter that runs it (`python - <<EOF`,
 * `echo '…' | node`): the code when it is written out, and whether some of it is only known when
 * it runs.
 */
export function stdinCode(
  cmd: SimpleCommand,
  bin: string,
  feed: Feed,
  at: WithStdin,
): Input | undefined {
  if (!CODE.test(bin) || !runsStdin(cmd)) return undefined;
  return inputOf(cmd, feed, at);
}

/** A context that carries what the commands being read get on their input. */
export interface WithStdin {
  /** Set by the classifier as it reads a command line; callers leave it out. */
  stdin?: Input;
  /** The shell the command line is in, which decides what a string alone prints (`printed`). */
  shell?: ShellDialect;
}

const GROUP_END = new Map([
  ["{", "}"],
  ["for", "done"],
  ["select", "done"],
  ["while", "done"],
  ["until", "done"],
  ["if", "fi"],
  ["case", "esac"],
]);

interface Group {
  end: string;
  parent: Group | undefined;
  input?: SimpleCommand;
}

/**
 * `list` with the heredoc or here-string written after a POSIX group or loop (`{ sh; } <<EOF`)
 * given to the commands it encloses that have no input of their own.
 */
export function groupInputs(list: SimpleCommand[]): SimpleCommand[] {
  const groups: Group[] = [];
  let group: Group | undefined;
  const enclosures = list.map((cmd) => {
    const [head] = cmd.words;
    if (group && head === group.end && !cmd.quoted?.has(head)) {
      if (ownInput(cmd)) group.input = cmd;
      group = group.parent;
      return group;
    }
    for (const word of cmd.words) {
      if (cmd.quoted?.has(word)) break;
      if (word === "then" || word === "else" || word === "do" || word === "!") continue;
      const end = GROUP_END.get(word);
      if (!end) break;
      group = { end, parent: group };
      groups.push(group);
      if (word !== "{" && word !== "if" && word !== "while" && word !== "until") break;
    }
    return group;
  });
  for (const current of groups) current.input ??= current.parent?.input;
  return list.map((cmd, i) => {
    if (cmd.nested.length || cmd.blocks?.length) {
      cmd = { ...cmd, nested: cmd.nested.map(groupInputs), blocks: cmd.blocks?.map(groupInputs) };
    }
    const from = enclosures[i]?.input;
    if (!from || cmd.piped || ownInput(cmd)) return cmd;
    const { heredocs, input, inputKind } = from;
    const vars = new Set([...(cmd.vars ?? []), ...(from.vars ?? [])]);
    return { ...cmd, heredocs, input, inputKind, vars };
  });
}

/**
 * `ctx` for what runs inside `cmd` (its subshells and substitutions, its blocks, a function it
 * calls, a script it runs): they read what it reads. What a `>(…)` reads is the command's own
 * output, which isn't followed.
 */
export function within<T extends WithStdin>(ctx: T, cmd: SimpleCommand, feed: Feed): T {
  const fed = cmd.words.some((w) => w.startsWith(">(")) ? UNKNOWN : undefined;
  const stdin = fed ?? inputOf(cmd, feed, ctx);
  return stdin === ctx.stdin ? ctx : { ...ctx, stdin };
}
