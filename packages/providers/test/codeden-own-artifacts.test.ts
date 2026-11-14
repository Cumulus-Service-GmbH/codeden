import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { assessClaudeTool } from "../src/claude/tools";
import { classifyCommand, classifyRead, classifyWrite, type RiskContext } from "../src/policy/risk";

/**
 * A session may read its own artifacts (#338): the `File:` path `browser_screenshot` prints is in
 * `<home>/artifacts/<session id>/`, and `browser_upload` takes it back. Reading there runs freely,
 * like the session's own worktree under `<home>/wt/`. The artifacts root, `.incoming`, other
 * sessions' folders, wildcards and searches that reach past the session's own folder, and any
 * write or delete there (artifacts are created through CodeDen's tools) still ask at every level.
 */
const OWN = "6f1d0c3a-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const OTHER = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";

const posix: RiskContext = {
  cwd: "/home/me/.codeden/wt/repo/abc123",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  codedenHome: "/home/me/.codeden",
  artifactsDir: `/home/me/.codeden/artifacts/${OWN}`,
};
const win: RiskContext = {
  cwd: "C:\\Users\\me\\.codeden\\wt\\repo\\abc123",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  codedenHome: "C:\\Users\\me\\.codeden",
  artifactsDir: `C:\\Users\\me\\.codeden\\artifacts\\${OWN}`,
};

const ownDir = `/home/me/.codeden/artifacts/${OWN}`;
const own = `${ownDir}/2b3c4d5e-aaaa-4bbb-8ccc-0123456789ab.png`;
const other = `/home/me/.codeden/artifacts/${OTHER}/7c8d9e0f-aaaa-4bbb-8ccc-0123456789ab.png`;
const winOwn = `C:\\Users\\me\\.codeden\\artifacts\\${OWN}\\2b3c4d5e-aaaa-4bbb-8ccc-0123456789ab.png`;

const guarded = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky && r.codeden === true;
};

describe("a session's own artifacts: reading (#338)", () => {
  it("Claude's Read of its own artifact runs freely", () => {
    expect(assessClaudeTool("Read", { file_path: own }, posix)).toEqual({ risky: false });
    expect(classifyRead(own, posix)).toEqual({ risky: false });
    expect(assessClaudeTool("Read", { file_path: winOwn }, win)).toEqual({ risky: false });
  });

  it("reading commands on its own artifacts run freely", () => {
    for (const cmd of [
      `cat ${own}`,
      `head -c 8 ${own}`,
      `file ${own}`,
      `stat ${own}`,
      `wc -c ${own}`,
      `ls ${ownDir}`,
      `ls -la ${ownDir}/`,
      `find ${ownDir} -name '*.png'`,
      `rg -l x ${ownDir}`,
      `cat $CODEDEN_HOME/artifacts/${OWN}/x.png`,
      `cat ~/.codeden/artifacts/${OWN}/x.png`,
      `cat ${ownDir}/*.png`,
      `cd ${ownDir} && cat x.png`,
      `cat < ${own}`,
      `cat src/a.ts && cat ${own}`,
    ]) {
      expect(classifyCommand(cmd, posix), cmd).toEqual({ risky: false });
    }
    for (const cmd of [
      `Get-Content ${winOwn}`,
      `Get-Content -Path ${winOwn} -Encoding Byte -TotalCount 8`,
      `Get-ChildItem C:\\Users\\me\\.codeden\\artifacts\\${OWN}`,
      `Get-Content $env:CODEDEN_HOME\\artifacts\\${OWN}\\x.png`,
      `type %CODEDEN_HOME%\\artifacts\\${OWN}\\x.png`,
    ]) {
      expect(classifyCommand(cmd, { ...win, shell: "powershell" }), cmd).toEqual({ risky: false });
    }
  });

  it("Claude's Grep and Glob inside its own artifacts folder run freely", () => {
    expect(assessClaudeTool("Grep", { pattern: "x", path: ownDir }, posix)).toEqual({
      risky: false,
    });
    expect(assessClaudeTool("Glob", { path: ownDir, pattern: "*.png" }, posix)).toEqual({
      risky: false,
    });
  });
});

describe("a session's own artifacts: what still asks (#338)", () => {
  it("another session's artifact asks", () => {
    for (const cmd of [
      `cat ${other}`,
      `ls /home/me/.codeden/artifacts/${OTHER}`,
      `cat ${ownDir}/../${OTHER}/x.png`,
      `cd ${ownDir} && cat ../${OTHER}/x.png`,
      `cat ${own} ${other}`,
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    expect(assessClaudeTool("Read", { file_path: other }, posix)).toMatchObject({ codeden: true });
  });

  it("the artifacts root, .incoming and shared ask", () => {
    for (const cmd of [
      "ls /home/me/.codeden/artifacts",
      "ls ~/.codeden/artifacts/",
      "ls $CODEDEN_HOME/artifacts",
      "cat /home/me/.codeden/artifacts/.incoming/x.png",
      "ls /home/me/.codeden/artifacts/.incoming",
      "cat /home/me/.codeden/artifacts/shared/x.png",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    expect(guarded("Get-ChildItem C:\\Users\\me\\.codeden\\artifacts", win)).toBe(true);
  });

  it("wildcards and searches from the artifacts root ask", () => {
    for (const cmd of [
      "cat /home/me/.codeden/artifacts/*/x.png",
      "cat ~/.codeden/artifacts/*",
      `cat /home/me/.codeden/artifacts/${OWN.slice(0, 4)}*/x.png`,
      "rg token ~/.codeden/artifacts",
      "grep -r token /home/me/.codeden/artifacts",
      "find ~/.codeden/artifacts -name '*.png'",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    for (const input of [
      { path: "/home/me/.codeden/artifacts", pattern: "**/*.png" },
      { pattern: "/home/me/.codeden/artifacts/*/*.png" },
    ]) {
      expect(assessClaudeTool("Glob", input, posix), JSON.stringify(input)).toMatchObject({
        codeden: true,
      });
    }
    expect(
      assessClaudeTool("Grep", { pattern: "x", path: "/home/me/.codeden/artifacts" }, posix),
    ).toMatchObject({ codeden: true });
  });

  it("writing or deleting in its own artifacts folder asks", () => {
    expect(classifyWrite(own, posix)).toMatchObject({ codeden: true });
    for (const name of ["Write", "Edit"]) {
      expect(assessClaudeTool(name, { file_path: own }, posix), name).toMatchObject({
        codeden: true,
      });
    }
    for (const cmd of [
      `echo hi > ${ownDir}/x.txt`,
      `echo hi >> ${own}`,
      `cp /tmp/a.png ${ownDir}/`,
      `cp src/a.png ${own}`,
      `mv ${own} /tmp/a.png`,
      `rm ${own}`,
      `rm -rf ${ownDir}`,
      `touch ${ownDir}/new.png`,
      `sed -i s/a/b/ ${own}`,
      `tee ${own}`,
      `ln -s ~/.codeden/codeden.db ${ownDir}/db.png`,
      // Reading programs with an option that writes or runs something.
      `find ${ownDir} -delete`,
      `find ${ownDir} -name '*.png' -exec rm {} +`,
      `sort -o ${own} /tmp/a`,
      `uniq /tmp/a ${own}`,
      // Copying goes through a command that writes: it asks like before, both ways.
      `cp ${own} /tmp/shot.png`,
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    for (const cmd of [
      `Remove-Item ${winOwn}`,
      `Set-Content -Path ${winOwn} -Value x`,
      `Copy-Item C:\\tmp\\a.png ${winOwn}`,
    ]) {
      expect(guarded(cmd, { ...win, shell: "powershell" }), cmd).toBe(true);
    }
  });

  it("a read whose output feeds another command asks: the names could reach one that deletes", () => {
    for (const cmd of [
      `ls ${ownDir} | xargs rm`,
      `find ${ownDir} -name '*.png' | xargs rm`,
      `echo ${own} | xargs rm`,
      `rm $(ls ${ownDir}/*.png)`,
      `cat ${own} | base64`,
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
  });

  it("an artifacts folder that would open the home or a whole folder in it opens nothing", () => {
    for (const artifactsDir of [
      "/home/me/.codeden",
      "/home/me/.codeden/artifacts",
      "/home/me/.codeden/runner",
      "/home/me",
    ]) {
      const ctx = { ...posix, artifactsDir };
      expect(classifyRead("/home/me/.codeden/codeden.db", ctx), artifactsDir).toMatchObject({
        codeden: true,
      });
      expect(guarded("ls ~/.codeden/artifacts", ctx), artifactsDir).toBe(true);
      expect(guarded("cat ~/.codeden/runner/runner.log", ctx), artifactsDir).toBe(true);
    }
    // Credential files ask whatever the context says.
    const wide = { ...posix, artifactsDir: "/home/me/.codeden/runner/x" };
    expect(classifyRead("/home/me/.codeden/runner/runner.json", wide)).toMatchObject({
      codeden: true,
    });
  });

  it("without the session's artifacts folder, its artifacts ask as before", () => {
    const { artifactsDir: _, ...noArtifacts } = posix;
    expect(classifyRead(own, noArtifacts)).toMatchObject({ codeden: true });
    expect(guarded(`cat ${own}`, noArtifacts)).toBe(true);
  });
});

describe("a session's own artifacts: every level (#338)", () => {
  it("Claude reads its own artifact without asking at Auto and Full, and asks for the rest", () => {
    for (const level of ["auto", "full"] as const) {
      const p = new ClaudePolicy(level, posix);
      expect(p.gate("Read", { file_path: own }), level).toMatchObject({ ask: false });
      expect(p.gate("Bash", { command: `cat ${own}` }), level).toMatchObject({ ask: false });
      expect(p.gate("Read", { file_path: other }), level).toMatchObject({ ask: true });
      expect(p.gate("Bash", { command: "ls ~/.codeden/artifacts" }), level).toMatchObject({
        ask: true,
      });
      expect(p.gate("Write", { file_path: own, content: "x" }), level).toMatchObject({
        ask: true,
      });
    }
  });
});
