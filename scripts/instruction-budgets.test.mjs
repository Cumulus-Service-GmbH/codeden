import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkInstructionBudgets } from "./check-instruction-budgets.mjs";
import budgets from "./instruction-budgets.json" with { type: "json" };

let cwd;
afterEach(() => {
  if (cwd) rmSync(cwd, { force: true, recursive: true });
});

it("counts bytes in changed tracked files, including scoped paths and explicit overrides", () => {
  cwd = mkdtempSync(join(tmpdir(), "codeden-instruction-ci-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const file = (path, contents) => {
    const target = join(cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const commit = (message) => {
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", message);
  };
  git("init", "-q");
  file("AGENTS.md", "x".repeat(12_289));
  file("delete/AGENTS.md", "x".repeat(7_000));
  commit("baseline");
  const baseline = git("rev-parse", "HEAD");

  git("rm", "-q", "delete/AGENTS.md");
  file("CLAUDE.md", "é".repeat(512));
  file("a path/AGENTS.md", "é".repeat(3_073));
  file(".codeden/VISION.md", "x".repeat(4_097));
  file("elsewhere/CLAUDE.md", "xxxx");
  commit("candidate");
  file("untracked/AGENTS.md", "x".repeat(10_000));

  expect(
    checkInstructionBudgets({
      cwd,
      baseline,
      budgets: {
        ...budgets,
        overrides: { "elsewhere/CLAUDE.md": 3 },
      },
    }),
  ).toEqual([
    { path: ".codeden/VISION.md", bytes: 4097, limit: 4096 },
    { path: "a path/AGENTS.md", bytes: 6146, limit: 6144 },
    { path: "elsewhere/CLAUDE.md", bytes: 4, limit: 3 },
  ]);

  file("AGENTS.override.md", "x".repeat(12_289));
  rmSync(join(cwd, "untracked"), { recursive: true });
  file("AGENTS.md", "y".repeat(12_289));
  file("CLAUDE.md", "x".repeat(1_025));
  commit("edit existing guides");
  expect(checkInstructionBudgets({ cwd, baseline }).map(({ path }) => path)).toEqual([
    ".codeden/VISION.md",
    "AGENTS.md",
    "AGENTS.override.md",
    "CLAUDE.md",
    "a path/AGENTS.md",
  ]);
});
