import { describe, expect, it } from "vitest";
import { ShellTraversalError } from "../src/policy/blocks";
import { unwrap } from "../src/policy/command-words";
import { firstInList } from "../src/policy/first-in-list";
import { parseShell, type SimpleCommand } from "../src/policy/shell";
import type { RiskContext } from "../src/policy/targets";

const cwd = "/virtual/work";
const ctx: RiskContext = { cwd, platform: "linux", shell: "posix" };

function echoedFromSubdirectory(source: string): string[] {
  const args = new Set<string>();
  firstInList(parseShell(source, "posix"), ctx, 0, (cmd, here) => {
    const { tokens } = unwrap(cmd.words);
    if (here.dir === `${cwd}/sub` && tokens[0] === "echo" && tokens[1]) {
      args.add(tokens[1]);
    }
    return undefined;
  });
  return [...args];
}

describe("shell function traversal", () => {
  it("sees the first function body at an earlier call site", () => {
    expect(
      echoedFromSubdirectory("label() { echo first; }; (cd sub; label); label() { echo second; }"),
    ).toEqual(["first"]);
  });

  it.each([
    ["keyword before a function definition", "if true; then label() { echo body; }; fi"],
    ["nested braces", "label() { { echo inner; }; echo body; }"],
    ["function keyword with adjacent parentheses and brace", "function label(){ echo body; }"],
    ["conditional body", "label() if true; then echo body; fi"],
    ["case pattern before a declaration", "case x in x) label() { echo body; };; esac"],
  ])("reads the whole body at the call site with %s", (_label, definition) => {
    expect(echoedFromSubdirectory(`${definition}; (cd sub; label)`)).toContain("body");
  });

  it("stops traversing overly deep command lists", () => {
    let list: SimpleCommand[] = [{ words: ["echo", "body"], writes: [], nested: [] }];
    for (let i = 0; i < 40; i += 1) list = [{ words: [], writes: [], nested: [list] }];
    expect(() => firstInList(list, ctx, 0, () => undefined)).toThrow(ShellTraversalError);
  });

  it("bounds total visits even when individual lists fit the depth limit", () => {
    let list: SimpleCommand[] = [{ words: ["echo", "body"], writes: [], nested: [] }];
    for (let i = 0; i < 15; i += 1) list = [{ words: [], writes: [], nested: [list, list] }];
    expect(() => firstInList(list, ctx, 0, () => undefined)).toThrow(ShellTraversalError);
  });

  it("fails closed when the parser cannot delimit a function body", () => {
    expect(() => echoedFromSubdirectory("label() { echo body")).toThrow(ShellTraversalError);
  });
});
