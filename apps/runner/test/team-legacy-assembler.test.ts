import { join } from "node:path";
import { expect, it } from "vitest";
import { mergeTeamWorker } from "../src/git/ops";
import { makeRepo, removeDir, sh, tempDir, write } from "./helpers";

it("merges a legacy assembler only if its checkout belongs to the project's repository", async () => {
  const repoPath = makeRepo();
  const foreign = makeRepo();
  const root = tempDir("codeden-legacy-assembler-");
  const cwd = join(root, "assembler");
  const other = join(root, "foreign");
  try {
    sh(repoPath, "switch", "-c", "worker");
    write(repoPath, "worker.txt", "Ready");
    sh(repoPath, "add", "worker.txt");
    sh(repoPath, "commit", "-m", "Complete assignment.");
    const head = sh(repoPath, "rev-parse", "HEAD");
    sh(repoPath, "worktree", "add", "-b", "assembler", cwd, "main");
    sh(foreign, "branch", "worker");
    sh(foreign, "worktree", "add", "-b", "assembler", other, "main");
    const command = {
      name: "git.mergeLegacyTeamWorker",
      assembler: "assembler",
      workerBranch: "worker",
      head,
      repoPath,
    } as const;
    const foreignHead = sh(other, "rev-parse", "HEAD");
    expect(await mergeTeamWorker({ ...command, cwd: other })).toEqual({
      conflict: "Team assembler is not a registered worktree of this project",
    });
    expect(sh(other, "rev-parse", "HEAD")).toBe(foreignHead);
    expect(await mergeTeamWorker({ ...command, cwd })).toEqual({});
    expect(sh(cwd, "show", "HEAD:worker.txt")).toBe("Ready");
  } finally {
    for (const dir of [root, foreign, repoPath]) removeDir(dir);
  }
});
