import { expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { inlineScripts } from "../src/policy/inline-scripts";
import { locationsAfter } from "../src/policy/locations";
import { MAX_DEPTH, tooDeep } from "../src/policy/ran-scripts";
import { classifyCommand } from "../src/policy/risk";
import { xargsCommand } from "../src/policy/search-runs";
import { parseShell } from "../src/policy/shell";
import { shellReadings } from "../src/policy/shell-readings";

const posix = { cwd: "/repo/work", shell: "posix" } as const;
const win = { cwd: "C:\\work", platform: "win32" } as const;
const cmd = (words: string[]) => ({ words, writes: [], nested: [] });

it("P3-R1 resolves wrapped write operands in the effective folder", () => {
  const input = { command: "env -C /other tee report.txt" };
  expect(classifyCommand(input.command, posix)).toMatchObject({
    action: "outside_worktree",
    reason: expect.stringContaining("report.txt"),
  });
  expect(new ClaudePolicy("full", posix).needsUser("Bash", input)).toMatchObject({ ask: true });
});

it("P3-R5 treats unquoted pipeline output as unknown PowerShell input", () => {
  const source = cmd(["Get-Date"]);
  const consumer = { ...cmd(["iex"]), piped: true };
  expect(inlineScripts("iex", [], consumer, source)).toMatchObject([{ text: "", dynamic: true }]);
  expect(
    new ClaudePolicy("full", { ...win, shell: "powershell" }).needsUser("PowerShell", {
      command: "Get-Date | Invoke-Expression",
    }),
  ).toMatchObject({ ask: true });
});

it("P3-R9 carries a PowerShell launch directory into each script", () => {
  const args = ["-wd", "C:\\other", "-Command", "Get-Date"];
  expect(inlineScripts("pwsh", args, cmd(["pwsh", ...args]))).toMatchObject([
    { text: "Get-Date", dir: "C:\\other" },
  ]);
});

it("P3-R10 strips the eval option delimiter", () => {
  expect(inlineScripts("eval", ["--", "printf sample"], cmd(["eval"]))).toMatchObject([
    { text: "printf sample" },
  ]);
});

it("P3-R11 marks uninspected interpreter subprocess code beyond the depth limit", () => {
  expect(tooDeep(cmd(["python", "-c", "os.system('echo sample')"]), posix, MAX_DEPTH, {})).toBe(
    true,
  );
});

it.each(["-q", "-s", "-qP"])("P3-R13 keeps the cd operand after %s", (flag) => {
  expect(locationsAfter(cmd(["cd", flag, "/elsewhere"]), [posix])).toMatchObject([
    { dir: "/elsewhere" },
  ]);
});

it("P3-R15 keeps both Windows separators and POSIX escapes in auto mode", () => {
  const readings = shellReadings(String.raw`cat reports/n\ote.txt`, "auto", win);
  expect(readings.map((list) => list[0]?.words[1])).toEqual(
    expect.arrayContaining([String.raw`reports/n\ote.txt`, "reports/note.txt"]),
  );
});

it.each([["-0n", "2"], ["-rn2"], ["-J", "{}"], ["-R", "2"], ["-S", "20"], ["--max-lines", "1"]])(
  "P3-R16 consumes xargs option values for %j",
  (...args) => {
    expect(xargsCommand([...args, "printf", "sample"])).toEqual(["printf", "sample"]);
  },
);

it("P3-R5 still parses a quoted PowerShell string from a direct pipe", () => {
  const [source, consumer] = parseShell("'Get-Date' | iex", "powershell");
  if (!source || !consumer) throw new Error("Expected a two-command pipeline");
  expect(inlineScripts("iex", [], consumer, source)).toMatchObject([
    { text: "Get-Date", dynamic: false },
  ]);
});

const ordinaryWorktrees = [
  {
    home: "/home/example/.codeden",
    cwd: "/home/example/.codeden/wt/project/session",
    platform: "linux",
    shell: "posix",
    tool: "Bash",
  },
  ...(["auto", "posix", "powershell"] as const).map((shell) => ({
    home: "C:\\Users\\Example\\.codeden",
    cwd: "C:\\Users\\Example\\.codeden\\wt\\project\\session",
    platform: "win32" as const,
    shell,
    tool: shell === "powershell" ? "PowerShell" : "Bash",
  })),
] as const;

it.each(ordinaryWorktrees)(
  "allows ordinary Full-mode commands in its own worktree on $platform ($shell)",
  ({ cwd, home, platform, shell, tool }) => {
    const policy = new ClaudePolicy("full", { cwd, codedenHome: home, platform, shell });
    for (const command of [
      "git status --short",
      "git diff -- notes.txt",
      "git commit -m 'Update notes'",
      "pnpm test",
      "rg --no-config needle notes.txt",
      "cat notes.txt",
    ]) {
      expect(policy.needsUser(tool, { command }), command).toMatchObject({ ask: false });
    }
    expect(policy.needsUser(tool, { command: "tee ../../other.txt" })).toMatchObject({
      ask: true,
    });
  },
);
