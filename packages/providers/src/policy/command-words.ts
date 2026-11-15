/** Helpers for reading the words of a parsed simple command (§11.2). */

/** Shell keywords that start a compound command (`if`, `then`, `do`, `{`, ...). */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "time", "!", "{"]);

/** A shell variable assignment (`NAME=value`). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Words that don't change what runs: elevation (`sudo`), wrappers (`env -u X Y=1`, `command`,
 * `exec`) and shell keywords that start a compound command (`if`, `then`, `do`, `{`, ...).
 * `env` with no command to run prints the environment, so it stays the program then.
 */
export function unwrap(words: string[]): { tokens: string[]; elevated: boolean } {
  let elevated = false;
  let rest = words;
  for (;;) {
    const head = rest[0]?.toLowerCase();
    if (head === "sudo" || head === "doas" || head === "runas" || head === "gsudo") {
      elevated = true;
      rest = rest.slice(1).filter((t, i) => !(i === 0 && t.startsWith("-")));
    } else if (binName(head) === "env") {
      // Also `/usr/bin/env node x.js` and `env.exe …`.
      const command = envCommand(rest.slice(1));
      if (command.every((w) => ASSIGNMENT.test(w))) break;
      rest = command;
    } else if (head === "command" || head === "exec" || head === "nohup") {
      rest = rest.slice(1);
    } else if (head && KEYWORDS.has(head)) {
      rest = rest.slice(1);
    } else if (head && ASSIGNMENT.test(head)) {
      rest = rest.slice(1);
    } else break;
  }
  return { tokens: rest, elevated };
}

/** `env`'s short options that take a value: `-u NAME`, `-C DIR`, `-S STRING`, `-P PATH`, `-a ARG`. */
const ENV_VALUE = "uCSPa";
/** `env`'s long options that take a value. */
const ENV_LONG_VALUE = new Set(["--unset", "--chdir", "--split-string", "--argv0"]);

/**
 * The words after `env`'s options: its assignments and the command it runs. `-S "cmd args"`
 * (`--split-string`) gives the command as one string, split here.
 */
function envCommand(args: string[]): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") return args.slice(i + 1);
    if (!arg.startsWith("-")) return args.slice(i);
    let value: string | undefined;
    let split = false;
    if (arg.startsWith("--")) {
      const [name = "", ...rest] = arg.split("=");
      if (!ENV_LONG_VALUE.has(name)) continue;
      value = rest.length > 0 ? rest.join("=") : args[++i];
      split = name === "--split-string";
    } else {
      const at = [...arg.slice(1)].findIndex((c) => ENV_VALUE.includes(c)) + 1;
      if (at === 0) continue;
      value = arg.slice(at + 1) || args[++i];
      split = arg[at] === "S";
    }
    if (split) return [...(value ?? "").split(/\s+/).filter(Boolean), ...args.slice(i + 1)];
  }
  return [];
}

/** Commands that change the shell's current directory. */
export const CD = new Set(["cd", "pushd", "chdir", "set-location", "sl", "push-location"]);

/** Redirect targets that write nothing anywhere (`2>/dev/null`, `> nul`, `> $null`). */
export const DISCARD = /^(\/dev\/(null|stdout|stderr|tty)|nul|\$null)$/i;

/** The program a command word names, lower-cased, without its directory or extension. */
export const binName = (token: string | undefined): string =>
  (token ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, "") ?? "";
