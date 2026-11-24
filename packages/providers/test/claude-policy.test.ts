import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudePolicy, permissionModeFor } from "../src/claude/permissions";
import { guardedReadCommand } from "../src/policy/delegated-read";

it("delegates explicit file searches without loading ripgrep config", () => {
  const cwd = import.meta.dirname;
  const command = guardedReadCommand(
    { action: "command", toolName: "Bash", command: "rg needle claude-policy.test.ts" },
    cwd,
    cwd,
  );
  expect(command).toBe("command rg --no-config needle claude-policy.test.ts");
});

it("does not delegate a Git blob read of a provider login file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "codeden-read-approval-"));
  try {
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, "opencode"));
    writeFileSync(join(cwd, "opencode", "auth.json"), "{}");
    writeFileSync(join(cwd, "opencode", "notes.json"), "{}");
    const commandFor = (file: string) =>
      guardedReadCommand(
        { action: "command", toolName: "Bash", command: `git show HEAD:opencode/${file}` },
        cwd,
        cwd,
      );
    expect(commandFor("notes.json")).toContain("show --no-ext-diff --no-textconv");
    expect(commandFor("auth.json")).toBeUndefined();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("ClaudePolicy", () => {
  const ctx = {
    cwd: "/work/repo",
    platform: "linux" as const,
    home: "/home/me",
    tempRoots: ["/tmp"],
  };

  it("maps autonomy to permission modes", () => {
    expect(permissionModeFor("supervised", false)).toBe("default");
    expect(permissionModeFor("auto", false)).toBe("acceptEdits");
    expect(permissionModeFor("full", false)).toBe("bypassPermissions");
    expect(permissionModeFor("full", true)).toBe("plan");
  });

  it("supervised asks for every edit and command", () => {
    const p = new ClaudePolicy("supervised", { ...ctx, cwd: import.meta.dirname });
    expect(p.gate("Bash", { command: "ls" })).toMatchObject({ ask: true, action: "command" });
    expect(p.gate("Edit", { file_path: "a.ts" })).toMatchObject({
      ask: true,
      action: "file_change",
    });
    expect(p.gate("Read", { file_path: "a.ts" }).ask).toBe(false);
    expect(p.needsUser("mcp__x__y", {}).ask).toBe(true);
    p.allowForSession("Bash", { command: "ls" });
    expect(p.needsUser("Bash", { command: "ls" })).toEqual({ ask: false, command: "command ls" });
    expect(p.gate("Bash", { command: "pwd" }).ask).toBe(true);
  });

  it("auto asks only for risky actions", () => {
    const p = new ClaudePolicy("auto", ctx);
    expect(p.gate("Bash", { command: "pnpm test" }).ask).toBe(false);
    expect(p.needsUser("Bash", { command: "pnpm test" }).ask).toBe(false);
    expect(p.gate("Bash", { command: "git push --force" })).toMatchObject({
      ask: true,
      action: "git_destructive",
    });
    expect(p.gate("Write", { file_path: "/etc/x" })).toMatchObject({
      ask: true,
      action: "outside_worktree",
    });
    expect(p.gate("Read", { file_path: ".env" })).toMatchObject({ ask: true, action: "secrets" });
    expect(p.gate("AskUserQuestion", {}).ask).toBe(true);
  });

  it("auto: searching and listing are not secrets reads, and writing an env file in the worktree is fine", () => {
    const p = new ClaudePolicy("auto", ctx);
    expect(p.gate("Grep", { pattern: "process.env", path: "src" }).ask).toBe(false);
    expect(p.gate("Grep", { pattern: "import\\.meta\\.env", glob: "*.ts" }).ask).toBe(false);
    expect(p.gate("Grep", { pattern: "x", glob: "**/.env*" }).ask).toBe(false);
    expect(p.gate("Glob", { pattern: "**/*.env" }).ask).toBe(false);
    expect(p.gate("Write", { file_path: "/work/repo/.env" }).ask).toBe(false);
    expect(p.gate("Edit", { file_path: ".env.local" }).ask).toBe(false);
    expect(p.gate("Bash", { command: "cp .env.example .env" }).ask).toBe(false);
    // Reading a secret still asks, wherever the agent finds it.
    expect(p.gate("Grep", { pattern: "KEY", path: ".env" })).toMatchObject({
      ask: true,
      action: "secrets",
    });
    expect(p.gate("Grep", { pattern: "KEY", path: "/home/me/.npmrc" })).toMatchObject({
      action: "secrets",
    });
    expect(p.gate("Read", { file_path: "/work/repo/.env.local" })).toMatchObject({
      action: "secrets",
    });
    // Writing one outside the worktree asks too, under Full as well.
    expect(p.gate("Write", { file_path: "/home/me/.npmrc" })).toMatchObject({
      action: "outside_worktree",
    });
    expect(new ClaudePolicy("full", ctx).gate("Write", { file_path: "/tmp/.env" }).ask).toBe(true);
  });

  it("full asks only for writes outside the worktree (temp counts as inside, but not its secrets)", () => {
    const p = new ClaudePolicy("full", ctx);
    expect(p.gate("Bash", { command: "git push --force" }).ask).toBe(false);
    expect(p.gate("Bash", { command: "npm i -g x" }).ask).toBe(false);
    expect(p.gate("Write", { file_path: "/etc/x" })).toMatchObject({
      ask: true,
      action: "outside_worktree",
    });
    expect(p.gate("Write", { file_path: "/tmp/x/probe.ts" }).ask).toBe(false);
    expect(p.gate("Bash", { command: "pnpm build > /tmp/build.log" }).ask).toBe(false);
    // Inside the worktree nothing asks, secrets included (§11.2).
    expect(p.gate("Read", { file_path: ".env" }).ask).toBe(false);
    expect(p.gate("Write", { file_path: ".env" }).ask).toBe(false);
    // A secrets file in temp is still outside the worktree.
    expect(p.gate("Write", { file_path: "/tmp/.env" })).toMatchObject({
      ask: true,
      action: "outside_worktree",
    });
    expect(p.gate("Bash", { command: "cp .env /tmp/x/.env" })).toMatchObject({
      ask: true,
      action: "outside_worktree",
    });
  });

  it("resolves relative paths from a shell directory Claude reports in Git Bash form (Windows)", () => {
    const win = {
      cwd: "C:\\Users\\me\\.codeden\\wt\\myproj\\abcd1234",
      platform: "win32" as const,
      home: "C:\\Users\\me",
      tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
    };
    const dir = "/c/Users/me/.codeden/wt/myproj/abcd1234";
    const sub = "/c/Users/me/.codeden/wt/myproj/abcd1234/apps/web";
    for (const level of ["auto", "full"] as const) {
      const p = new ClaudePolicy(level, win);
      for (const command of [
        "rm -rf dist",
        "pnpm test > test.log 2>&1",
        "cp src/a.ts src/b.ts",
        "Remove-Item -Recurse -Force node_modules",
        "cd apps && rm -rf build",
      ]) {
        expect(p.gate("Bash", { command }, dir).ask, `${level}: ${command}`).toBe(false);
      }
      expect(p.gate("Bash", { command: "cp a.ts ../../a.ts.bak" }, sub).ask).toBe(false);
      expect(p.gate("Bash", { command: "rm -rf /tmp/scratch" }, "/tmp").ask).toBe(false);
      expect(p.gate("Bash", { command: "rm -rf ../abcd9999" }, dir)).toMatchObject({
        ask: true,
        action: "outside_worktree",
      });
      expect(p.gate("Bash", { command: "cp a.ts ../../../../b.ts" }, sub)).toMatchObject({
        ask: true,
        action: "outside_worktree",
      });
    }
  });

  it("auto and supervised treat temp writes by their own rules", () => {
    expect(new ClaudePolicy("auto", ctx).gate("Write", { file_path: "/tmp/a.ts" }).ask).toBe(false);
    expect(
      new ClaudePolicy("supervised", ctx).gate("Write", { file_path: "/tmp/a.ts" }),
    ).toMatchObject({ ask: true, action: "file_change" });
  });

  it("switches level for the next call and keeps allow_session decisions", () => {
    const p = new ClaudePolicy("auto", { ...ctx, cwd: import.meta.dirname });
    const outside = { command: "cp build/app /usr/local/bin/app" };
    const push = { command: "git push --force" };
    expect(p.gate("Bash", push).ask).toBe(true);
    p.allowForSession("Bash", { command: "ls -la" });

    p.setAutonomy("full");
    expect(p.level).toBe("full");
    expect(p.gate("Bash", push).ask).toBe(false);
    expect(p.needsUser("Bash", push).ask).toBe(false);
    expect(p.gate("Bash", outside)).toMatchObject({ ask: true, action: "outside_worktree" });

    p.setAutonomy("supervised");
    expect(p.gate("Bash", { command: "ls" }).ask).toBe(true);
    expect(p.needsUser("Bash", { command: "ls -la" })).toEqual({
      ask: false,
      command: "command ls -la",
    });

    p.setAutonomy("auto");
    expect(p.gate("Bash", { command: "ls" }).ask).toBe(false);
  });
});
