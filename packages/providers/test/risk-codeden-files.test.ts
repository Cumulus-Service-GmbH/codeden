import { describe, expect, it } from "vitest";
import type { AcpToolState } from "../src/acp/items";
import { AcpPolicy } from "../src/acp/policy";
import { ClaudePolicy } from "../src/claude/permissions";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, classifyRead, classifyWrite, type RiskContext } from "../src/policy/risk";

/**
 * Issue #389: `.codeden/automations/*.md` defines what project automations run (prompt,
 * permissions, schedule) and `.codeden/VISION.md` the factory's protected areas. Writing them
 * asks at Auto, like `.codeden/project.json`.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
};
const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};

const reason = (command: string, ctx: RiskContext = posix) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.reason : null;
};

describe("CodeDen's automation files and vision (#389)", () => {
  it("asks before an edit of .codeden/automations/*.md and .codeden/VISION.md", () => {
    for (const file of [
      ".codeden/automations/x.md",
      "/work/repo/.codeden/automations/nightly.md",
      ".codeden/VISION.md",
      "/work/repo/.codeden/vision.md",
    ]) {
      const verdict = classifyWrite(file, posix);
      expect(verdict, file).toMatchObject({ risky: true, action: "file_change" });
      // Not an every-level verdict: Full runs it.
      expect(verdict.risky && verdict.always, file).toBeFalsy();
    }
    expect(classifyWrite(".codeden\\Automations\\x.md", win)).toMatchObject({ risky: true });
    expect(classifyWrite(".codeden\\VISION.md", win)).toMatchObject({ risky: true });
  });

  it("asks before a shell write of them, naming what the file is", () => {
    for (const command of [
      "echo x > .codeden/automations/x.md",
      "echo x | tee .codeden/automations/x.md",
      "cp /tmp/evil.md .codeden/automations/",
      "cp /tmp/evil.md .codeden/automations",
      "sed -i 's/read_only/full/' .codeden/automations/audit.md",
      "git checkout origin/evil -- .codeden/automations/audit.md",
      `node -e "require('fs').writeFileSync('.codeden/automations/x.md', 'x')"`,
      "cd .codeden/automations && echo x > x.md",
    ]) {
      expect(reason(command), command).toContain("automation file");
    }
    for (const command of [
      "echo vision > .codeden/VISION.md",
      "cp /tmp/v.md .codeden/VISION.md",
      `python -c "open('.codeden/VISION.md','w').write('x')"`,
    ]) {
      expect(reason(command), command).toContain("vision");
    }
    expect(
      reason("Set-Content -Path .codeden\\automations\\x.md -Value x", {
        ...win,
        shell: "powershell",
      }),
    ).toContain("automation file");
  });

  it("asks at Auto and Supervised, runs at Full, for every provider", () => {
    for (const path of ["/work/repo/.codeden/automations/x.md", "/work/repo/.codeden/VISION.md"]) {
      const edit: AcpToolState = { toolCallId: "e", kind: "edit", locations: [{ path }] };
      expect(new AcpPolicy("auto", posix).decide(edit).kind, path).toBe("ask");
      expect(new AcpPolicy("full", posix).decide(edit).kind, path).toBe("allow");
      expect(new ClaudePolicy("auto", posix).gate("Write", { file_path: path }).ask, path).toBe(
        true,
      );
      expect(new ClaudePolicy("full", posix).gate("Write", { file_path: path }).ask, path).toBe(
        false,
      );
      const verdict = classifyWrite(path, posix);
      expect(levelAllows("auto", verdict), path).toBe(false);
      expect(levelAllows("full", verdict), path).toBe(true);
    }
  });

  it("leaves reads, the notes file and look-alike paths alone", () => {
    for (const command of [
      "cat .codeden/automations/x.md",
      "ls .codeden/automations",
      "git diff -- .codeden/automations .codeden/VISION.md",
      "echo note >> .codeden/notes.md",
      "echo x > docs/automations/x.md",
      "echo x > .codeden-automations.md",
    ]) {
      expect(classifyCommand(command, posix).risky, command).toBe(false);
    }
    expect(classifyRead(".codeden/automations/x.md", posix).risky).toBe(false);
    expect(classifyWrite("docs/VISION.md", posix).risky).toBe(false);
    expect(classifyWrite(".codeden/sub/VISION.md", posix).risky).toBe(false);
  });
});
