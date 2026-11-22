import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEAM_FILE_ENV, type Team, TeamFile } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { runTool } from "../src/services/exec";
import {
  loopProjects,
  refreshTeamFile,
  teamFilePath,
  writeTeamFile,
} from "../src/services/factory/team-file";
import { ProjectService } from "../src/services/projects/project-service";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

// The in-app Team reaches the tools agents run through `TEAM_FILE`.
let dir: string;
let database: Database;
let projects: ProjectService;
const opus: Team = [
  { role: "reviewer", provider: "claude", model: "claude-opus-5-5", effort: "high" },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-team-file-"));
  database = openDatabase(join(dir, "codeden.db"));
  projects = new ProjectService({
    db: database.db,
    store: new EventStore(database.db),
    exec: runTool,
    projectsDir: join(dir, "clones"),
  });
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

const launcher = (team: Map<string, Team>) =>
  new SessionLauncher({
    runner: { mcpProxyUrl: () => null },
    projects,
    home: join(dir, "home"),
    worktreesDir: join(dir, "wt"),
    team: (projectId: string) => team.get(projectId) ?? null,
  } as unknown as LauncherDeps);

it("passes TEAM_FILE with the project's current Team, empty until the project has one", async () => {
  const id = await addProject();
  const teams = new Map<string, Team>();
  const session = { ...sampleSession, projectId: id };
  const path = launcher(teams).sessionOptions(session).env?.[TEAM_FILE_ENV];
  expect(path).toBe(teamFilePath(join(dir, "home"), id));
  expect(TeamFile.parse(JSON.parse(readFileSync(path as string, "utf8"))).team).toEqual([]);
  teams.set(id, opus);
  expect(launcher(teams).sessionOptions(session).env?.[TEAM_FILE_ENV]).toBe(path);
  expect(TeamFile.parse(JSON.parse(readFileSync(path as string, "utf8"))).team).toEqual(opus);
  expect(
    launcher(teams).sessionOptions({ ...sampleSession, projectId: null }).env?.[TEAM_FILE_ENV],
  ).toBeUndefined();
});

it("rewrites the file in place and refuses unsafe project ids", () => {
  const home = join(dir, "home");
  writeTeamFile(home, "p1", opus, ["/work"]);
  writeTeamFile(home, "p1", [], ["/work"]);
  expect(JSON.parse(readFileSync(teamFilePath(home, "p1"), "utf8")).team).toEqual([]);
  expect(() => teamFilePath(home, "../x")).toThrow(/unsafe/);
});

it("finds the projects whose factory loop changed", () => {
  const event = (type: string, projectId: string) => ({
    seq: 1,
    sessionId: null,
    type,
    payload: { loop: { projectId } },
    ts: "2026-11-22T19:00:00.000Z",
  });
  expect(
    loopProjects([
      event("factory.loop.updated", "a"),
      event("factory.loop.updated", "a"),
      event("project.updated", "b"),
    ]),
  ).toEqual(["a"]);
});

it("binds the file to the project's folders and removes it when a refresh fails", async () => {
  const id = await addProject();
  const path = launcher(new Map([[id, opus]])).sessionOptions({ ...sampleSession, projectId: id })
    .env?.[TEAM_FILE_ENV] as string;
  const project = projects.get(id);
  expect(TeamFile.parse(JSON.parse(readFileSync(path, "utf8"))).roots).toEqual([
    project.path,
    join(dir, "wt", project.slug),
  ]);
  const logs: string[] = [];
  refreshTeamFile({
    home: join(dir, "home"),
    worktreesDir: join(dir, "wt"),
    projectId: id,
    team: () => {
      throw new Error("db closed");
    },
    project: () => project,
    log: (message) => logs.push(message),
  });
  expect(existsSync(path)).toBe(false);
  expect(logs[0]).toMatch(/old file removed: db closed/);
});
