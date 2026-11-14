import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { assessClaudeTool } from "../src/claude/tools";
import { classifyCommand, classifyRead, type RiskContext } from "../src/policy/risk";

/**
 * CodeDen's whole home is off limits to agents (#320), not only its credential files: the
 * SQLite database (and its `-wal`/`-shm` files) holds other sessions' transcripts, inbox items
 * and MCP token hashes; settings, logs and backups hold the rest. Reading, listing, copying or
 * searching anything there asks at every level, Full included. CodeDen state reaches agents
 * through its MCP tools instead. The one exception is the session's own worktree under
 * `<home>/wt/`: another session's worktree asks.
 */
const posix: RiskContext = {
  cwd: "/home/me/.codeden/wt/repo/abc123",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  codedenHome: "/home/me/.codeden",
};
const win: RiskContext = {
  cwd: "C:\\Users\\me\\.codeden\\wt\\repo\\abc123",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  codedenHome: "C:\\Users\\me\\.codeden",
};
/** A custom `CODEDEN_HOME` outside the user's home folder. */
const custom: RiskContext = {
  cwd: "/data/codeden-dev/wt/repo/abc123",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  codedenHome: "/data/codeden-dev",
};

const guarded = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky && r.codeden === true;
};

/** Reads, listings, searches and copies of the database and the runner's folder. */
const POSIX_READS = [
  "cat ~/.codeden/codeden.db",
  "cat /home/me/.codeden/codeden.db-wal",
  "head -c 100 $CODEDEN_HOME/codeden.db-shm",
  'sqlite3 ~/.codeden/codeden.db "select * from events"',
  "sqlite3 -readonly $CODEDEN_HOME/codeden.db .tables",
  "ls ~/.codeden",
  "ls -la $CODEDEN_HOME/runner",
  "ls /home/me/.codeden/runner/",
  "cat ~/.codeden/runner/runner.log",
  "cat ~/.codeden/runner/*",
  "rg token ~/.codeden/runner",
  "rg factory_report_findings ~/.codeden/codeden.db",
  "grep -a findings ~/.codeden/codeden.db",
  "cp ~/.codeden/codeden.db /tmp/db",
  "cp -r $CODEDEN_HOME/runner /tmp/r",
  "cat ~/.codeden/settings.json",
  "cat ~/.codeden/logs/server.log",
  "tail -f ~/.codeden/logs/server.log",
  "ls ~/.codeden/backups",
  "cd ~/.codeden && sqlite3 codeden.db .dump",
  "cd ~/.codeden && ls",
  "python3 -c 'print(1)' ~/.codeden/codeden.db",
  "strings ~/.codeden/codeden.db",
  "xxd ~/.codeden/codeden.db-wal",
  "find ~/.codeden -name '*.db'",
];

describe("CodeDen's whole home: the classifier (#320)", () => {
  it("reading, listing, searching or copying the database and the runner folder asks", () => {
    for (const cmd of POSIX_READS) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
  });

  it("a custom CODEDEN_HOME is guarded the same way", () => {
    for (const cmd of [
      "cat /data/codeden-dev/codeden.db",
      "sqlite3 /data/codeden-dev/codeden.db .tables",
      "ls /data/codeden-dev",
      "ls $CODEDEN_HOME/runner",
      "cp /data/codeden-dev/codeden.db-wal /tmp/x",
      "rg x /data/codeden-dev/runner",
    ]) {
      expect(guarded(cmd, custom), cmd).toBe(true);
    }
  });

  it("PowerShell and cmd reads of the database and the runner folder ask", () => {
    for (const cmd of [
      "Get-Content $env:CODEDEN_HOME\\codeden.db",
      "Get-Content C:\\Users\\me\\.codeden\\codeden.db-wal",
      "sqlite3 C:\\Users\\me\\.codeden\\codeden.db .tables",
      "Get-ChildItem $env:CODEDEN_HOME",
      "Get-ChildItem C:\\Users\\me\\.codeden\\runner",
      "dir %USERPROFILE%\\.codeden",
      "type %CODEDEN_HOME%\\settings.json",
      "Copy-Item $env:CODEDEN_HOME\\codeden.db $env:TEMP\\db",
      "Select-String -Pattern findings -Path C:\\Users\\me\\.codeden\\codeden.db",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
  });

  it("Claude's Read, Grep and Glob of the home ask", () => {
    for (const file_path of [
      "/home/me/.codeden/codeden.db",
      "/home/me/.codeden/codeden.db-wal",
      "/home/me/.codeden/settings.json",
      "/home/me/.codeden/logs/server.log",
      "/home/me/.codeden/runner/runner.log",
      "~/.codeden/backups/settings.json",
    ]) {
      expect(assessClaudeTool("Read", { file_path }, posix), file_path).toMatchObject({
        risky: true,
        codeden: true,
      });
      expect(classifyRead(file_path, posix), file_path).toMatchObject({ codeden: true });
    }
    for (const input of [
      { pattern: "findings", path: "/home/me/.codeden/logs" },
      { pattern: "findings", path: "/home/me/.codeden/codeden.db" },
    ]) {
      expect(assessClaudeTool("Grep", input, posix), JSON.stringify(input)).toMatchObject({
        codeden: true,
      });
    }
    for (const input of [
      { path: "/home/me/.codeden", pattern: "*.db" },
      { path: "/home/me/.codeden", pattern: "logs/*.log" },
      { path: "/home/me/.codeden", pattern: "**/*.log" },
      { pattern: "/home/me/.codeden/runner/*" },
    ]) {
      expect(assessClaudeTool("Glob", input, posix), JSON.stringify(input)).toMatchObject({
        codeden: true,
      });
    }
  });

  it("the session's own worktree under the home stays readable", () => {
    for (const cmd of [
      "cat /home/me/.codeden/wt/repo/abc123/src/a.ts",
      "cat src/a.ts",
      "ls",
      "ls /home/me/.codeden/wt/repo/abc123",
      "rg token .",
      "rg token /home/me/.codeden/wt/repo/abc123",
      "cp src/a.ts /tmp/a.ts",
      "cat $CODEDEN_HOME/wt/repo/abc123/package.json",
      "cd ~/.codeden/wt/repo/abc123 && pnpm build",
    ]) {
      expect(classifyCommand(cmd, posix), cmd).toEqual({ risky: false });
    }
    expect(
      assessClaudeTool("Read", { file_path: "/home/me/.codeden/wt/repo/abc123/src/a.ts" }, posix),
    ).toEqual({ risky: false });
    expect(
      assessClaudeTool(
        "Glob",
        { path: "/home/me/.codeden/wt/repo/abc123", pattern: "**/*" },
        posix,
      ),
    ).toEqual({ risky: false });
    expect(classifyCommand("Get-Content src\\a.ts", win)).toEqual({ risky: false });
    expect(
      classifyCommand("Get-Content C:\\Users\\me\\.codeden\\wt\\repo\\abc123\\src\\a.ts", win),
    ).toEqual({ risky: false });
  });

  it("another session's worktree under the home asks", () => {
    for (const cmd of [
      "cat /home/me/.codeden/wt/repo/zzz999/src/a.ts",
      "cat ../zzz999/src/a.ts",
      "ls ~/.codeden/wt/repo",
      "ls ~/.codeden/wt/other/def456",
      "rg token ~/.codeden/wt",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    expect(
      assessClaudeTool("Read", { file_path: "/home/me/.codeden/wt/repo/zzz999/src/a.ts" }, posix),
    ).toMatchObject({ codeden: true });
    expect(guarded("Get-Content C:\\Users\\me\\.codeden\\wt\\repo\\zzz999\\src\\a.ts", win)).toBe(
      true,
    );
  });

  it("leaves the rest of the machine alone", () => {
    for (const cmd of ["cat ~/notes.txt", "ls ~", "ls /home/me/projects", "cat /etc/hosts"]) {
      expect(classifyCommand(cmd, posix), cmd).toEqual({ risky: false });
    }
    // Without the session's home the rule is off.
    const { codedenHome: _, ...noHome } = posix;
    expect(classifyRead("/home/me/.codeden/codeden.db", noHome)).toEqual({ risky: false });
  });
});

describe("CodeDen's whole home: every level (#320)", () => {
  it("Claude asks under Auto and Full, and refuses at Read-only", () => {
    for (const level of ["auto", "full"] as const) {
      const p = new ClaudePolicy(level, posix);
      for (const command of POSIX_READS) {
        expect(p.gate("Bash", { command }), `${level}: ${command}`).toMatchObject({ ask: true });
      }
      expect(p.gate("Read", { file_path: "/home/me/.codeden/codeden.db" }), level).toMatchObject({
        ask: true,
      });
      expect(p.gate("Bash", { command: "cat src/a.ts" }), level).toMatchObject({ ask: false });
      expect(
        p.gate("Bash", { command: "cat /home/me/.codeden/wt/repo/zzz999/src/a.ts" }),
        level,
      ).toMatchObject({ ask: true });
    }
    const readOnly = new ClaudePolicy("read_only", posix);
    expect(readOnly.denial("Bash", { command: "sqlite3 ~/.codeden/codeden.db .tables" })).toMatch(
      /off limits/,
    );
    expect(readOnly.denial("Read", { file_path: "src/a.ts" })).toBeUndefined();
  });
});
