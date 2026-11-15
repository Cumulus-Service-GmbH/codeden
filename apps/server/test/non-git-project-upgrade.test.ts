import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project, SessionDetail, StartSessionResponse } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { findMigrationsDir, openDatabase } from "../src/db/client";
import { type Exec, runTool } from "../src/services/exec";
import { waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

/**
 * Upgrading to the build that records `Project.isGitRepo` (#408): the migration adds the column
 * with `true` for every project, and the server's start-up re-detection corrects it in the
 * background, one project at a time (#425). A session started before that check reaches a
 * plain-folder project must still run in the project folder, not ask for a worktree.
 */
const TOKEN = "e".repeat(64);
const all = findMigrationsDir();
const names = readdirSync(all).filter((n) => /^\d{14}_/.test(n));
const ts = "2026-11-14T10:00:00.000Z";

let home: string;
let folder: string;
let server: RunningServer | undefined;
/** `git` runs in the project folder that the start-up re-detection hasn't been let through. */
let held: (() => void)[];

/** The migrations of the build before #408, which had no `is_git_repo` column. */
function migrationsBeforeIsGitRepo(): string {
  const dir = join(home, "migrations-0.7.4");
  for (const name of names.filter((n) => !n.endsWith("_project_is_git_repo"))) {
    mkdirSync(join(dir, name), { recursive: true });
    copyFileSync(join(all, name, "migration.sql"), join(dir, name, "migration.sql"));
  }
  return dir;
}

/** The re-detection of the plain folder waits until `release()`: a slow start-up check. */
const exec: Exec = (command, args, opts) =>
  command === "git" && args[0] === "-C" && args[1] === folder
    ? new Promise((resolve) => held.push(() => resolve(runTool(command, args, opts))))
    : runTool(command, args, opts);
const release = () => {
  for (const go of held.splice(0)) go();
};

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server?.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as unknown };
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codeden-upgrade-git-"));
  held = [];
  folder = join(home, "music-videos");
  mkdirSync(folder);
  writeFileSync(join(folder, "notes.txt"), "lyrics\n");
  // A database written by the previous build, holding one project in a plain folder.
  const dataDir = join(home, "data");
  mkdirSync(dataDir);
  const old = openDatabase(join(dataDir, "codeden.db"), migrationsBeforeIsGitRepo());
  old.client
    .prepare(
      "INSERT INTO projects (id, kind, name, slug, path, created_at, updated_at) VALUES ('p1', 'local', 'music-videos', 'music-videos', ?, ?, ?)",
    )
    .run(folder, ts, ts);
  old.close();
});

afterEach(async () => {
  release();
  await server?.close();
  server = undefined;
  await removeTree(home);
});

const start = () =>
  startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    exec,
    github: { sync: false },
  });

describe("a plain-folder project right after upgrading to the build with isGitRepo", () => {
  it("is not read as a git repository before the start-up re-detection reaches it", async () => {
    server = await start();
    // The start-up check of the folder has begun and is still running.
    await waitUntil(() => (held.length > 0 ? true : undefined));

    const project = Project.parse((await api("GET", "/projects/p1")).body);
    expect(project.isGitRepo).toBe(false);
  });

  it("runs a session started before the re-detection finishes in the project folder", async () => {
    server = await start();
    await waitUntil(() => (held.length > 0 ? true : undefined));

    // What the New session view sends: no workspace, so the default applies.
    const res = await api("POST", "/sessions", {
      projectId: "p1",
      provider: "fake",
      input: { text: "Hey" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const started = StartSessionResponse.parse(res.body);
    if (started.status !== "started") throw new Error(started.status);
    const detail = SessionDetail.parse((await api("GET", `/sessions/${started.sessionId}`)).body);
    expect(detail.startMeta?.workspaceMode).toBe("repo_root");

    // Once the check is let through it records the folder as it is: still no git repository.
    release();
    const checked = await waitUntil(async () => {
      const p = Project.parse((await api("GET", "/projects/p1")).body);
      return p.isGitRepo ? undefined : p;
    });
    expect(checked.isGitRepo).toBe(false);
  });
});
