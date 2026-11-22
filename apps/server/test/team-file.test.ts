import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Session, Settings, TEAM_FILE_ENV, type Team, TeamFile } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { runTool } from "../src/services/exec";
import {
  createTeamFileRefresher,
  type TeamFileDeps,
  teamFileChanges,
  teamFilePath,
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
let projectTeams: Map<string, Team>;
let sessions: Map<string, Session>;
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
  projectTeam: (id) => projectTeams.get(id) ?? [],
  project: (id) => projects.get(id),
  session: (id) => sessions.get(id),
  liveSessions: (projectId) =>
    [...sessions.values()].filter(
      (s) => (!projectId || s.projectId === projectId) && s.status !== "completed",
    ),
});

const launcher = () =>
  new SessionLauncher({
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
  // A listing failure keeps the change pending until a later batch can list.
  let listing = false;
  const unlisted = createTeamFileRefresher({
    ...deps(),
    liveSessions: (projectId) => {
      if (!listing) throw new Error("busy");
      return deps().liveSessions(projectId);
    },
  });
  projectTeams.set(id, []);
  unlisted([event("factory.loop.updated", { loop: { projectId: id } })]);
  expect(read(path).team).toHaveLength(3);
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
    liveSessions: (projectId) => repo.list({ projectId, status: ["running"] }),
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
