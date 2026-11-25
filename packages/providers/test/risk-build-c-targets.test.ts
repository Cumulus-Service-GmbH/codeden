import { describe, expect, it } from "vitest";
import { copyWrites } from "../src/policy/copies";
import { inlineCode, inlineCodeWrites } from "../src/policy/inline-code";
import type { PathContext } from "../src/policy/paths";
import { dotnetWrites } from "../src/policy/ps-dotnet";
import { runFolders } from "../src/policy/run-folder";
import { crontabChange } from "../src/policy/schedules";

const posix = { cwd: "/fixtures/repo", platform: "linux" } satisfies PathContext;
const windows = { cwd: "C:\\fixtures\\repo", platform: "win32", shell: "powershell" } as const;

describe("classifier target parsing", () => {
  it("keeps every tee destination, including dash-prefixed file names", () => {
    expect(copyWrites("tee", ["-a", "one.txt", "--", "two.txt", "-three.txt"], posix)).toEqual({
      targets: ["one.txt", "two.txt", "-three.txt"],
      words: ["one.txt", "two.txt", "-three.txt"],
    });
  });

  it("keeps copy destinations when options or file filters follow them", () => {
    expect(copyWrites("cp", ["a.txt", "b.txt", "--suffix", ".bak"], posix).targets).toEqual([
      "b.txt",
    ]);
    expect(copyWrites("robocopy", ["src", "dst", "*.txt", "/E"], windows).targets).toEqual(["dst"]);
    expect(
      copyWrites("set-content", ["-Encoding", "utf8", "a.txt", "sample"], windows).targets,
    ).toEqual(["a.txt"]);
  });

  it("keeps the current folder when a folder option belongs to an argument", () => {
    expect(
      runFolders(
        { words: ["echo", "git", "-C", "/fixtures/other"], writes: [], nested: [] },
        posix,
      ),
    ).toContain(posix.cwd);
    expect(
      runFolders(
        { words: ["git", "-C", "/fixtures/other", "status"], writes: [], nested: [] },
        posix,
      ),
    ).toEqual(["/fixtures/other"]);
  });

  it("keeps file write arguments inside a print call", () => {
    expect(inlineCodeWrites("print(os.replace('/fixtures/a.txt', '/fixtures/b.txt'))")).toEqual([
      "/fixtures/a.txt",
      "/fixtures/b.txt",
    ]);
    expect(inlineCodeWrites("console.log(fs.writeFileSync('/fixtures/a.txt', 'text'))")).toEqual([
      "/fixtures/a.txt",
    ]);
  });

  it.each([
    ["php", ["-B", "MARK", "-R", "MARK", "-E", "MARK"], ["MARK", "MARK", "MARK"]],
    ["php", ["-BMARK"], ["MARK"]],
    ["node", ["-ep", "MARK"], ["MARK"]],
    ["ts-node", ["-ep", "MARK"], ["MARK"]],
    ["bun", ["-ep", "MARK"], ["MARK"]],
    ["deno", ["eval", "--ext=ts", "--allow-write", "MARK"], ["MARK"]],
  ])("extracts %s inline source", (bin, args, expected) => {
    expect(inlineCode(bin, args)).toEqual(expected);
  });

  it("records writable .NET constructors and directory changes", () => {
    const targets = (word: string) =>
      dotnetWrites({ words: [word], writes: [], nested: [] }).targets;
    expect(targets("[IO.StreamWriter]::new('fixture.txt')")).toEqual(["fixture.txt"]);
    expect(targets("[IO.FileStream]::new('fixture.txt', 'Create')")).toEqual(["fixture.txt"]);
    expect(targets("New-Object IO.FileInfo('fixture.txt')")).toEqual(["fixture.txt"]);
    expect(targets("[IO.DirectoryInfo]::new('fixture')")).toEqual(["fixture"]);
    expect(targets("[IO.Directory]::SetCurrentDirectory('fixture')")).toEqual(["fixture"]);
    expect(targets("[IO.StreamReader]::new('fixture.txt')")).toEqual([]);
  });

  it("handles cron listing flags only before the option delimiter", () => {
    expect(crontabChange("crontab", ["-l"])).toBeUndefined();
    expect(crontabChange("crontab", ["--", "-l"])).toMatchObject({ action: "outside_worktree" });
  });
});
