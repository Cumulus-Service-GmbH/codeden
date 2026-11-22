import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Session, TEAM_FILE_ENV, type Team, TeamFile } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { runTool } from "../src/services/exec";
import {
  refreshTeamFiles,
  type TeamFileDeps,
  teamFileChanges,
  teamFilePath,
} from "../src/services/factory/team-file";
import { ProjectService } from "../src/services/projects/project-service";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
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

it("rewrites affected files on Team, settings and session changes and fails closed", async () => {
  const id = await addProject();
  const session: Session = { ...sampleSession, projectId: id };
  sessions.set(session.id, session);
  const path = launcher().sessionOptions(session).env?.[TEAM_FILE_ENV] as string;
  expect(read(path).team).toEqual([]);
  const event = (type: string, payload: unknown) => ({
    seq: 1,
    sessionId: null,
    type,
    payload,
    ts: "2026-11-22T19:00:00.000Z",
  });
  projectTeams.set(id, [opus]);
  refreshTeamFiles(deps(), [event("factory.loop.updated", { loop: { projectId: "other" } })]);
  expect(read(path).team).toEqual([]);
  refreshTeamFiles(deps(), [event("factory.loop.updated", { loop: { projectId: id } })]);
  expect(read(path).team).toEqual([opus]);
  defaults = [astra];
  refreshTeamFiles(deps(), [event("settings.updated", {})]);
  expect(read(path).team).toEqual([astra, opus]);
  expect(
    teamFileChanges([event("session.updated", { session: { id: "s9" } })]).sessions.has("s9"),
  ).toBe(true);
  // A failed rewrite removes the old file; a file whose session is gone is removed.
  const failing = {
    ...deps(),
    projectTeam: () => {
      throw new Error("db closed");
    },
  };
  refreshTeamFiles(failing, [event("settings.updated", {})]);
  expect(existsSync(path)).toBe(false);
  writeFileSync(teamFilePath(join(dir, "home"), "gone"), "{}");
  refreshTeamFiles(deps(), [event("settings.updated", {})]);
  expect(existsSync(teamFilePath(join(dir, "home"), "gone"))).toBe(false);
  expect(() => teamFilePath(join(dir, "home"), "../x")).toThrow(/unsafe/);
});
