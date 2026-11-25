import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Session,
  Settings,
  TEAM_FILE_ENV,
  type Team,
  TeamFile,
  TeamReviewLimitSettings,
} from "@codeden/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { runTool } from "../src/services/exec";
import {
  createTeamFileRefresher,
  type TeamFileDeps,
  teamFileChanges,
  teamFilePath,
  writeTeamFile,
} from "../src/services/factory/team-file";
import { ProjectService } from "../src/services/projects/project-service";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

// The Team the UI chose reaches the tools agents run through `TEAM_FILE`, one file per session.
let dir: string;
let database: Database;
let projects: ProjectService;
let defaults: Team;
let reviewLimits: TeamReviewLimitSettings;
let projectTeams: Map<string, Team>;
let sessions: Map<string, Session>;
// Sessions whose pins came from the Team (not their starter's own choice).
const inherited = new Set<string>();
const opus = {
  role: "reviewer",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "high",
} as const;
const astra = {
  role: "planReviewer",
  provider: "codex",
  model: "gpt-6.2-astra",
  effort: "high",
} as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-team-file-"));
  database = openDatabase(join(dir, "codeden.db"));
  projects = new ProjectService({
    db: database.db,
    store: new EventStore(database.db),
    exec: runTool,
    projectsDir: join(dir, "clones"),
  });
  defaults = [];
  reviewLimits = TeamReviewLimitSettings.parse({});
  projectTeams = new Map();
  sessions = new Map();
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

async function addProject(): Promise<string> {
  const path = join(dir, "work", "app");
  mkdirSync(path, { recursive: true });
  return (await projects.create({ source: { type: "local", path } })).project.id;
}

const deps = (): TeamFileDeps => ({
  home: join(dir, "home"),
  worktreesDir: join(dir, "wt"),
  defaults: () => defaults,
  reviewLimits: () => reviewLimits,
  projectTeam: (id) => projectTeams.get(id) ?? [],
  project: (id) => projects.get(id),
  session: (id) => sessions.get(id),
  ownTeamPins: (id) => !inherited.has(id),
  liveSessions: (projectId) =>
    [...sessions.values()].filter(
      (s) => (!projectId || s.projectId === projectId) && s.status !== "completed",
    ),
});

const launcher = () =>
  new SessionLauncher({
    repo: { find: () => undefined },
    runner: { mcpProxyUrl: () => null },
    projects,
    home: join(dir, "home"),
    worktreesDir: join(dir, "wt"),
    teamFiles: deps(),
  } as unknown as LauncherDeps);

const read = (path: string) => TeamFile.parse(JSON.parse(readFileSync(path, "utf8")));

it("writes each project session's Team: its own role over the project's Team over the defaults", async () => {
  const id = await addProject();
  const session: Session = {
    ...sampleSession,
    projectId: id,
    title: "[Writer] Fix it",
    provider: "claude",
    model: "claude-opus-5-5",
  };
  sessions.set(session.id, session);
  defaults = [{ ...opus, provider: "codex", model: "gpt-default" }, astra];
  projectTeams.set(id, [opus]);
  const path = launcher().sessionOptions(session).env?.[TEAM_FILE_ENV] as string;
  expect(path).toBe(teamFilePath(join(dir, "home"), session.id));
  const file = read(path);
  expect(file.team).toEqual([
    { role: "writer", provider: "claude", model: "claude-opus-5-5", effort: null },
    astra,
    opus,
  ]);
  expect(file.sources).toEqual({ writer: "session", planReviewer: "default", reviewer: "project" });
  const project = projects.get(id);
  expect(file.roots).toEqual([project.path, join(dir, "wt", project.slug)]);
  expect(
    launcher().sessionOptions({ ...sampleSession, projectId: null }).env?.[TEAM_FILE_ENV],
  ).toBeUndefined();
});

it("keeps live sessions' files current, retries failures and repairs files at start", async () => {
  const id = await addProject();
  const session: Session = { ...sampleSession, projectId: id, status: "running" };
  sessions.set(session.id, session);
  const path = teamFilePath(join(dir, "home"), session.id);
  const event = (type: string, payload: unknown) => ({
    seq: 1,
    sessionId: null,
    type,
    payload,
    ts: "2026-11-22T19:00:00.000Z",
  });
  // At creation every live project session's file is written (a restart repairs missing ones).
  const refresh = createTeamFileRefresher(deps());
  expect(read(path).team).toEqual([]);
  expect(read(path)).toMatchObject({
    arbiterLimits: { totalRounds: 8, reviewFixRounds: 2 },
    arbiterSettingsSource: TEAM_FILE_ENV,
  });
  reviewLimits = TeamReviewLimitSettings.parse({
    defaults: { totalRounds: 12 },
    projects: { [id]: { reviewerRounds: 4 } },
  });
  refresh([event("settings.updated", {})]);
  expect(read(path).arbiterLimits).toEqual({ totalRounds: 12, reviewFixRounds: 4 });
  projectTeams.set(id, [opus]);
  refresh([event("factory.loop.updated", { loop: { projectId: "other" } })]);
  expect(read(path).team).toEqual([]);
  refresh([event("factory.loop.updated", { loop: { projectId: id } })]);
  expect(read(path).team).toEqual([opus]);
  defaults = [astra];
  refresh([event("settings.updated", {})]);
  expect(read(path).team).toEqual([astra, opus]);
  sessions.set(session.id, { ...session, title: "[Writer] x", provider: "codex", model: "m" });
  refresh([event("session.updated", { session: { id: session.id } })]);
  expect(read(path).sources).toEqual({
    writer: "session",
    planReviewer: "default",
    reviewer: "project",
  });
  // A failed rewrite removes the old file, and the session is retried on the next batch.
  let down = true;
  const flaky = createTeamFileRefresher({
    ...deps(),
    projectTeam: (projectId) => {
      if (down) throw new Error("db closed");
      return projectTeams.get(projectId) ?? [];
    },
  });
  expect(existsSync(path)).toBe(false);
  down = false;
  flaky([event("inbox.updated", {})]);
  expect(read(path).team).toHaveLength(3);
  // A listing failure at start removes the files it cannot check; each is rewritten, current, as soon as it can be.
  writeFileSync(teamFilePath(join(dir, "home"), "notasession2"), "{}");
  let listing = false;
  const unlisted = createTeamFileRefresher({
    ...deps(),
    liveSessions: (projectId) => {
      if (!listing) throw new Error("busy");
      return deps().liveSessions(projectId);
    },
  });
  expect(existsSync(path)).toBe(false);
  projectTeams.set(id, []);
  // A name that is no session is left alone even when the listing fails.
  expect(existsSync(teamFilePath(join(dir, "home"), "notasession2"))).toBe(true);
  unlisted([event("factory.loop.updated", { loop: { projectId: id } })]);
  expect(read(path).sources).toEqual({ writer: "session", planReviewer: "default" });
  listing = true;
  unlisted([event("inbox.updated", {})]);
  expect(read(path).sources).toEqual({ writer: "session", planReviewer: "default" });
  // A session that ended keeps no file.
  sessions.set(session.id, { ...session, status: "completed" });
  refresh([event("session.updated", { session: { id: session.id } })]);
  expect(existsSync(path)).toBe(false);
  expect(
    teamFileChanges([event("session.updated", { session: { id: "s9" } })]).sessions.has("s9"),
  ).toBe(true);
  expect(() => teamFilePath(join(dir, "home"), "../x")).toThrow(/unsafe/);
});

it("follows the events CodeDen's own write paths emit", async () => {
  const id = await addProject();
  const store = new EventStore(database.db);
  const repo = new SessionRepo(database.db, store);
  repo.create(
    { ...sampleSession, id: "s7", projectId: id, status: "running" },
    {
      workspaceMode: "worktree",
      workspaceFallback: null,
      forced: null,
      queuedBehind: [],
    },
  );
  const refresher = createTeamFileRefresher({
    ...deps(),
    session: (sessionId) => repo.find(sessionId)?.session,
    liveSessions: (projectId) => repo.listInStatus(["running"], projectId),
  });
  store.subscribe(refresher);
  const path = teamFilePath(join(dir, "home"), "s7");
  expect(read(path).team).toEqual([]);
  repo.update("s7", (s) => ({ ...s, title: "[Writer] Fix", provider: "codex", model: "m" }));
  expect(read(path).sources).toEqual({ writer: "session" });
  defaults = [astra];
  store.append([
    { type: "settings.updated", sessionId: null, payload: { settings: Settings.parse({}) } },
  ]);
  expect(read(path).sources).toEqual({ writer: "session", planReviewer: "default" });
});

it("invalidates a file whose session can't be read, and replaces a linked or stale-stamped file", async () => {
  const id = await addProject();
  const session: Session = { ...sampleSession, projectId: id, status: "running" };
  sessions.set(session.id, session);
  const path = teamFilePath(join(dir, "home"), session.id);
  const event = {
    seq: 1,
    sessionId: null,
    type: "session.updated",
    payload: { session: { id: session.id } },
    ts: "2026-11-22T19:00:00.000Z",
  };
  let readable = true;
  const refresh = createTeamFileRefresher({
    ...deps(),
    session: (sessionId) => {
      if (!readable) throw new Error("db closed");
      return sessions.get(sessionId);
    },
  });
  expect(existsSync(path)).toBe(true);
  readable = false;
  refresh([event]);
  expect(existsSync(path)).toBe(false);
  readable = true;
  refresh([]);
  expect(existsSync(path)).toBe(true);
  // A link in place of the file, or a stored time stamp that is not a date, is replaced, never kept.
  const elsewhere = join(dir, "elsewhere.json");
  writeFileSync(elsewhere, readFileSync(path, "utf8"));
  rmSync(path);
  symlinkSync(elsewhere, path);
  refresh([event]);
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/"updatedAt": "[^"]*"/, '"updatedAt": "soon"'),
  );
  refresh([event]);
  expect(Number.isNaN(Date.parse(read(path).updatedAt))).toBe(false);
});

it("lists every live session for the Team files, past the session list's page limit", async () => {
  const id = await addProject();
  const repo = new SessionRepo(database.db, new EventStore(database.db));
  const meta = {
    workspaceMode: "worktree" as const,
    workspaceFallback: null,
    forced: null,
    queuedBehind: [],
  };
  for (let i = 0; i < 1005; i++) {
    repo.create(
      {
        ...sampleSession,
        id: `live-${i}`,
        projectId: id,
        status: i === 0 ? "completed" : "running",
      },
      meta,
    );
  }
  expect(repo.listInStatus(["running"], id)).toHaveLength(1004);
  expect(repo.listInStatus(["running"])).toHaveLength(1004);
});

it("removes leftover files of sessions that are not live at start, and replaces a file others can read", async () => {
  const id = await addProject();
  const live: Session = { ...sampleSession, id: "live1", projectId: id, status: "running" };
  sessions.set(live.id, live);
  const home = join(dir, "home");
  mkdirSync(join(home, "teams"), { recursive: true });
  sessions.set("ended1", { ...sampleSession, id: "ended1", projectId: id, status: "completed" });
  writeFileSync(teamFilePath(home, "ended1"), "{}");
  writeFileSync(teamFilePath(home, "notasession"), "{}");
  const refresh = createTeamFileRefresher(deps());
  expect(existsSync(teamFilePath(home, "ended1"))).toBe(false);
  // A name that is no session (e.g. not CodeDen's) is left alone.
  expect(existsSync(teamFilePath(home, "notasession"))).toBe(true);
  const path = teamFilePath(home, live.id);
  expect(existsSync(path)).toBe(true);
  chmodSync(path, 0o644);
  refresh([
    {
      seq: 1,
      sessionId: null,
      type: "session.updated",
      payload: { session: { id: live.id } },
      ts: "2026-11-22T19:00:00.000Z",
    },
  ]);
  expect(statSync(path).mode & 0o077).toBe(0);
});

it("a session whose pins came from the Team has no layer of its own: a Team change reaches it", async () => {
  const id = await addProject();
  const session: Session = {
    ...sampleSession,
    id: "filled",
    projectId: id,
    status: "running",
    title: "[Writer] x",
    provider: "claude",
    model: "old",
  };
  sessions.set(session.id, session);
  inherited.add(session.id);
  projectTeams.set(id, [{ role: "writer", provider: "codex", model: "new", effort: null }]);
  createTeamFileRefresher(deps());
  const file = read(teamFilePath(join(dir, "home"), session.id));
  expect(file.team).toEqual([{ role: "writer", provider: "codex", model: "new", effort: null }]);
  expect(file.sources).toEqual({ writer: "project" });
  inherited.delete(session.id);
});

it("keeps the approved run Team in the session's Team file when project and global defaults change", async () => {
  const id = await addProject();
  const session: Session = { ...sampleSession, projectId: id, status: "running" };
  sessions.set(session.id, session);
  inherited.add(session.id);
  projectTeams.set(id, [{ ...opus, model: "project-default-reviewer" }]);
  const teamDeps = {
    ...deps(),
    runTeam: (sessionId: string) => (sessionId === session.id ? [opus] : undefined),
  };
  const refresh = createTeamFileRefresher(teamDeps);
  refresh([]);
  const path = teamFilePath(join(dir, "home"), session.id);
  expect(read(path).team).toContainEqual(opus);
  projectTeams.set(id, [{ ...opus, model: "new-default-reviewer" }]);
  defaults = [astra];
  refresh([
    {
      seq: 1,
      sessionId: null,
      ts: new Date().toISOString(),
      type: "project.updated",
      payload: { project: projects.get(id) },
    },
    {
      seq: 2,
      sessionId: null,
      ts: new Date().toISOString(),
      type: "settings.updated",
      payload: { settings: Settings.parse({}) },
    },
  ]);
  expect(read(path).team).toEqual([opus]);
  inherited.delete(session.id);
});

it("exports the Team selected for the session, including sibling role pins", async () => {
  const projectId = await addProject();
  const session = { ...sampleSession, projectId };
  const selected = { ...opus, model: "selected-reviewer" };
  const path = writeTeamFile(
    {
      ...deps(),
      projectTeam: (_id, teamId) => (teamId === "selected" ? [selected] : [opus]),
      teamId: () => "selected",
    },
    session,
  );
  expect(read(path)).toMatchObject({ team: [selected], sources: { reviewer: "project" } });
});
