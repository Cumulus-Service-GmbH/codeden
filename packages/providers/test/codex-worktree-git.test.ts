import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionOptions } from "@codeden/contracts";
import { afterEach, expect, it } from "vitest";
import { CodexSession } from "../src/codex/session";
import { osTempRoots } from "../src/policy/paths";

const executable = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-codex", "app-server.mjs"),
};
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function lane(autonomy: SessionOptions["autonomy"] = "auto") {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "codeden-codex-git-"));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const branch = "codeden/lane";
  git("init", "--quiet");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "start",
  );
  git("worktree", "add", "-qb", branch, "lane");
  const common = join(root, ".git");
  const gitDir = join(common, "worktrees", "lane");
  const ref = join(common, "refs", "heads", branch);
  const reflog = join(common, "logs", "refs", "heads", branch);
  const gitRoots = [gitDir, ref, `${ref}.lock`, reflog, `${reflog}.lock`];
  const log = join(root, "requests.log");
  const requests = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const session = new CodexSession(
    {
      sessionId: "lane",
      role: "agent",
      cwd: join(root, "lane"),
      autonomy,
      ownBranch: branch,
      mcpServers: [],
      additionalDirectories: [],
      planMode: false,
      env: { FAKE_CODEX_LOG: log },
    },
    { executable },
  );
  cleanup.push(() => session.close());
  return { session, requests, gitDir, gitRoots };
}

it("grants exact worktree Git roots and keeps them when a turn changes to Full", async () => {
  const { session, requests, gitRoots } = lane();
  await session.start();
  const sandboxRoots = [...new Set([...gitRoots, ...osTempRoots()])];
  const start = requests().find((request) => request.method === "thread/start");
  expect(start.params.config["sandbox_workspace_write.writable_roots"]).toEqual(sandboxRoots);
  expect(
    requests()
      .map((request) => request.method)
      .slice(0, 3),
  ).toEqual(["initialize", "command/exec", "thread/start"]);
  await session.setAutonomy("full");
  await session.send({ text: "start", attachments: [] });
  const turn = requests().find((request) => request.method === "turn/start");
  expect(turn.params.sandboxPolicy.writableRoots).toEqual(sandboxRoots);
});

it("surfaces an occupied index lock before opening the thread", async () => {
  const { session, requests, gitDir } = lane("full");
  const lock = join(gitDir, "index.lock");
  writeFileSync(lock, "occupied", { flag: "wx" });
  await expect(session.start()).rejects.toThrow(/Git lock preflight failed.*index\.lock/s);
  expect(requests().some((request) => request.method === "thread/start")).toBe(false);
  expect(readFileSync(lock, "utf8")).toBe("occupied");
});

it.each(["read_only", "supervised"] as const)(
  "keeps Git roots out of %s sessions",
  async (level) => {
    const { session, requests } = lane(level);
    await session.start();
    const start = requests().find((request) => request.method === "thread/start");
    expect(start.params.config).not.toHaveProperty("sandbox_workspace_write.writable_roots");
    expect(requests().some((request) => request.method === "command/exec")).toBe(false);
  },
);

it("checks the index lock when a read-only session first becomes writable", async () => {
  const { session, requests, gitDir } = lane("read_only");
  await session.start();
  writeFileSync(join(gitDir, "index.lock"), "", { flag: "wx" });
  await session.setAutonomy("auto");
  await expect(session.send({ text: "start", attachments: [] })).rejects.toThrow(
    /Git lock preflight failed.*index\.lock/s,
  );
  expect(requests().some((request) => request.method === "turn/start")).toBe(false);
});

it("rejects metadata without a backlink to the session's worktree", async () => {
  const { session, requests, gitDir } = lane();
  writeFileSync(join(gitDir, "gitdir"), "../../../.git\n");
  await expect(session.start()).rejects.toThrow(
    "Git metadata does not belong to this linked worktree",
  );
  expect(requests().some((request) => request.method === "command/exec")).toBe(false);
});
