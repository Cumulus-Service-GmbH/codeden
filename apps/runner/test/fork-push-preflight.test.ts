import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as gitExec from "../src/git/exec";
import { forkPushPreflight } from "../src/git/ops";
import { makeRepo, removeDir, sh, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

function withFork() {
  const cwd = makeRepo();
  const fork = tempDir("codeden-fork-");
  dirs.push(cwd, fork);
  sh(fork, "init", "-q", "--bare");
  sh(cwd, "remote", "add", "fork", fork);
  return { cwd, fork, name: "git.forkPushPreflight", branch: "main" } as const;
}

it("checks a proposed fork push without creating a remote ref or tracking branch", async () => {
  const { fork, ...command } = withFork();
  expect(await forkPushPreflight(command)).toEqual({ status: "passed" });
  expect(sh(fork, "for-each-ref")).toBe("");
  expect(sh(command.cwd, "for-each-ref", "refs/remotes")).toBe("");
});

it("distinguishes existing-ref rejection, a changed checkout and a missing fork", async () => {
  const { fork, ...command } = withFork();
  sh(command.cwd, "push", "fork", "main");
  const before = sh(fork, "rev-parse", "refs/heads/main");
  sh(command.cwd, "commit", "-q", "--amend", "-m", "Different root");
  expect(await forkPushPreflight(command)).toEqual({ status: "rejected" });
  expect(sh(fork, "rev-parse", "refs/heads/main")).toBe(before);
  expect(await forkPushPreflight({ ...command, branch: "another" })).toEqual({
    status: "inconclusive",
  });
  sh(command.cwd, "remote", "rename", "fork", "origin");
  expect(await forkPushPreflight(command)).toEqual({ status: "missing_fork" });
});

it("reports an authenticated SSH write denial as rejected without exposing its output", async () => {
  const { fork: _fork, ...command } = withFork();
  const request = vi.spyOn(gitExec, "git").mockResolvedValueOnce({
    code: 128,
    stdout: Buffer.alloc(0),
    stderr:
      "ERROR: Permission to owner/repo.git denied to another-user.\nfatal: Could not read from remote repository.",
  });
  try {
    expect(await forkPushPreflight(command)).toEqual({ status: "rejected" });
  } finally {
    request.mockRestore();
  }
});

it.skipIf(process.platform === "win32")(
  "does not run an external transport or fall back to origin",
  async () => {
    const { fork, ...command } = withFork();
    sh(command.cwd, "remote", "rename", "fork", "origin");
    sh(command.cwd, "remote", "add", "fork", "ext::touch preflight-ran");
    sh(command.cwd, "config", "protocol.ext.allow", "always");
    expect(await forkPushPreflight(command)).toEqual({ status: "inconclusive" });
    expect(existsSync(join(command.cwd, "preflight-ran"))).toBe(false);
    expect(sh(fork, "for-each-ref")).toBe("");
  },
);
