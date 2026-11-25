import { describe, expect, it } from "vitest";
import { unwrap } from "../src/policy/command-words";
import { runsStdin } from "../src/policy/remote-scripts";
import { parseShell, type SimpleCommand } from "../src/policy/shell";
import { groupInputs, stdinScripts } from "../src/policy/stdin-scripts";

const parse = (text: string) => parseShell(text, "posix", "posix");
const scripts = (cmd: SimpleCommand, source?: SimpleCommand) =>
  stdinScripts(cmd, "sh", unwrap(cmd.words).tokens.slice(1), { source }, { shell: "posix" });

describe("stdin parsing", () => {
  it("ends the heredoc delimiter before a quoted redirection target", () => {
    const [cmd] = parse("cat <<END>'notes.txt'\n$(echo hello)\nEND");
    expect(cmd?.heredocs).toEqual([{ body: "$(echo hello)", quoted: false }]);
    expect(cmd?.nested[0]?.[0]?.words).toEqual(["echo", "hello"]);
  });

  it("treats unmodelled print formatting as unknown input", () => {
    for (const line of ["printf '%s' 'echo hello'", "echo -e 'echo \\x61'"]) {
      const [source, cmd] = parse(`${line} | sh`);
      expect(scripts(cmd as SimpleCommand, source)).toContainEqual({
        text: "",
        dialect: "posix",
        dynamic: true,
      });
    }
  });

  it("keeps consecutive group inputs with their respective commands", () => {
    const list = groupInputs(parse("sh; { sh; } <<< one; { sh; } <<< two"));
    expect(
      list.filter((cmd) => cmd.words.includes("sh")).map((cmd) => scripts(cmd)[0]?.text),
    ).toEqual([undefined, "one", "two"]);
  });

  it("uses the last input redirect regardless of its kind", () => {
    for (const [line, expected] of [
      ["sh <<END <<< string", "string"],
      ["sh <<< string <<END", "document"],
    ] as const) {
      const [cmd] = parse(`${line}\ndocument\nEND`);
      expect(scripts(cmd as SimpleCommand)[0]?.text).toBe(expected);
    }
  });

  it("reads a process substitution following a shell option and its value", () => {
    const [cmd] = parse("sh -o errexit <(echo 'echo hello')");
    expect(scripts(cmd as SimpleCommand)[0]?.text).toBe("echo hello");
  });

  it("treats an attached scheduler queue name as an option value", () => {
    for (const queue of ["-qc", "-qd", "-q c"]) {
      const [cmd] = parse(`at ${queue} now`);
      expect(runsStdin(cmd as SimpleCommand)).toBe(true);
    }
    const [cmd] = parse("at -f notes.sh now");
    expect(runsStdin(cmd as SimpleCommand)).toBe(false);
  });
});
