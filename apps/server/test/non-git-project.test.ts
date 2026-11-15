import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CreateProjectResponse, type Session, StartSessionResponse } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sameRealPath } from "../src/services/projects/detect";
import { type Harness, startHarness, waitUntil } from "./support/harness";

/**
 * Sessions in a project whose folder isn't a git repository (#408): none of them gets a
 * worktree, and no turn fails on a worktree that could never be made.
 */
let h: Harness;
let folder: string;
let projectId: string;

const SETTLED = new Set(["idle", "failed", "stopped", "completed", "interrupted"]);

/** The session once its start or turn has settled. */
const settled = (id: string): Promise<Session> =>
  waitUntil(() => {
    const s = h.server.services.sessionRepo.get(id);
    return SETTLED.has(s.status) && !h.server.services.sessions.launching.has(id) ? s : undefined;
  });

/** The session's inbox items that blame the folder for not being a git repository. */
const notARepoItems = (id: string) =>
  h.server.services.inbox
    .list({ sessionId: id })
    .filter((i) => JSON.stringify(i).includes("is not a git repository"))
    .map((i) => `${i.kind}: ${i.title}${i.body ? ` | ${i.body}` : ""}`);

beforeAll(async () => {
  h = await startHarness();
  folder = join(h.home, "music-videos");
  mkdirSync(folder);
  writeFileSync(join(folder, "notes.txt"), "lyrics\n");
  const created = CreateProjectResponse.parse(
    (await h.api("POST", "/projects", { source: { type: "local", path: folder } })).body,
  );
  expect(created.detected.isGitRepo).toBe(false);
  projectId = created.project.id;
});

afterAll(async () => {
  await h?.close();
});

describe("a new session in a project that isn't a git repository", () => {
  it("runs its first message in the project folder", async () => {
    // What the New session view sends: no workspace, so the default applies.
    const res = await h.api("POST", "/sessions", {
      projectId,
      provider: "fake",
      input: { text: "Hey" },
    });
    const started = StartSessionResponse.parse(res.body);
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const id = started.sessionId;

    const session = await settled(id);
    expect(session.status, notARepoItems(id).join("\n")).toBe("idle");
    expect(h.server.services.sessionRepo.turnCount(id)).toBe(1);
    expect(session.worktreePath).toBeNull();
    expect(sameRealPath(session.cwd, folder)).toBe(true);
    expect((await h.detail(id)).startMeta?.workspaceMode).toBe("repo_root");
    expect(notARepoItems(id)).toEqual([]);
  });

  it("refuses a worktree when the session is created, with not_a_repo", async () => {
    const res = await h.api("POST", "/sessions", {
      projectId,
      provider: "fake",
      input: { text: "Hey" },
      workspace: { mode: "worktree" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "not_a_repo" } });
  });
});

describe("a worktree session whose worktree could not be made", () => {
  it("never runs its next message in the project folder instead", async () => {
    // A git project, but the worktree can't be made: the base it branches from doesn't exist.
    const res = await h.api("POST", "/sessions", {
      projectId: h.projectId,
      provider: "fake",
      input: { text: "first" },
      workspace: { mode: "worktree", baseRef: "no-such-branch" },
    });
    const started = StartSessionResponse.parse(res.body);
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const id = started.sessionId;
    expect((await settled(id)).status).toBe("failed");
    expect(h.server.services.sessionRepo.turnCount(id)).toBe(0);

    // The next message prepares the worktree again; it still can't be made, so the message is
    // refused with the reason instead of running in the project folder.
    const sent = await h.api("POST", `/sessions/${id}/messages`, { input: { text: "second" } });
    expect(sent.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(sent.body)).toContain("no-such-branch");
    const after = await settled(id);
    // The session asked for a worktree: a turn never runs in the project folder in its place.
    const turns = h.server.services.sessionRepo.turnCount(id);
    expect(turns, `a turn ran in ${after.cwd} (worktree: ${after.worktreePath})`).toBe(0);
    expect(after.status).toBe("failed");
  });

  it("makes the worktree with the next message once it can be made", async () => {
    const res = await h.api("POST", "/sessions", {
      projectId: h.projectId,
      provider: "fake",
      input: { text: "first" },
      workspace: { mode: "worktree", baseRef: "later-branch" },
    });
    const started = StartSessionResponse.parse(res.body);
    if (started.status !== "started") throw new Error(started.status);
    const id = started.sessionId;
    expect((await settled(id)).status).toBe("failed");

    // The base exists now: the next message makes the worktree it asked for, then runs there.
    execFileSync("git", ["-C", h.repo, "branch", "later-branch"], { stdio: "pipe" });
    const sent = await h.api("POST", `/sessions/${id}/messages`, { input: { text: "second" } });
    expect(sent.status).toBe(200);
    const after = await waitUntil(() => {
      const s = h.server.services.sessionRepo.get(id);
      return s.status === "idle" ? s : undefined;
    });
    expect(h.server.services.sessionRepo.turnCount(id)).toBe(1);
    expect(after.worktreePath).not.toBeNull();
    expect(sameRealPath(after.cwd, after.worktreePath ?? "")).toBe(true);
    expect(sameRealPath(after.cwd, h.repo)).toBe(false);
  });
});
