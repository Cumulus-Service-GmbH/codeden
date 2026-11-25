/**
 * How the shell lexer (`./shell`) reads escape characters (§11.2). A POSIX shell removes a
 * backslash before an ordinary character, so `\.\./x` is `../x` and `r\m` is `rm`. PowerShell's
 * escape is the backtick (the lexer reads it by dialect) and cmd's is `^`; to both, a backslash is
 * a path separator. A word is unescaped before any rule resolves it as a path.
 *
 * - `keep`: backslashes stay as written, as PowerShell and cmd read them.
 * - `posix`: a backslash is removed and the character after it kept, and `$'…'` is decoded.
 * - `careful`: on Windows, also read POSIX escapes while retaining explicitly rooted
 *   Windows paths and PowerShell drive paths.
 * - `caret`: cmd's `^` is removed and the character after it kept; backslashes stay.
 */
export type EscapeMode = "keep" | "posix" | "careful" | "caret";

/** True when the mode reads `$'…'` and backslashes the POSIX way. */
export const readsPosix = (mode: EscapeMode): boolean => mode === "posix" || mode === "careful";

/** A native Windows absolute path, UNC path, or PowerShell drive expression. */
const NATIVE_PATH = /^(?:[a-z]:\\|\\\\|\$env:[\w]+\\|[a-z][\w-]+:\\)/i;

/**
 * The text of a word that held a backslash escape: `kept` as written, `plain` with the escapes
 * taken out.
 */
export function escapedWord(kept: string, plain: string, mode: EscapeMode): string {
  if (mode === "posix" || (mode === "careful" && !NATIVE_PATH.test(kept))) return plain;
  return kept;
}

const ANSI_C: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** One escape of a `$'…'` string: `\xHH`, `\uHHHH`, `\UHHHHHHHH`, octal `\NNN`, or one character. */
const ANSI_ESCAPE = /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g;

/** The text of bash's `$'…'` string (`body`: what is between the quotes), escapes decoded. */
export function decodeAnsiC(body: string): string {
  return body.replace(ANSI_ESCAPE, (_, esc: string) => {
    const head = esc[0] as string;
    if ("xuU".includes(head) && esc.length > 1) return fromCode(Number.parseInt(esc.slice(1), 16));
    if (/^[0-7]+$/.test(esc)) return fromCode(Number.parseInt(esc, 8));
    return ANSI_C[head] ?? esc;
  });
}

function fromCode(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}
