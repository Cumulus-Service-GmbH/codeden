import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { McpTokenStore } from "../src/mcp/tokens";
import { runTool } from "../src/services/exec";
import { InboxService } from "../src/services/inbox-service";
import { ProjectService } from "../src/services/projects/project-service";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

// #221: agent sessions run with `CI=true` (#194); a project can turn it off for its agents.
let dir: string;
let database: Database;
let projects: ProjectService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-agent-ci-"));
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

function launcher(): SessionLauncher {
  const store = new EventStore(database.db);
  const unexpected = () => {
    throw new Error("Session options do not use this dependency");
  };
  return new SessionLauncher({
    repo: new SessionRepo(database.db, store),
    runner: {
      isConnected: () => true,
      runnerId: () => null,
      providers: () => [],
      mcpProxyUrl: () => null,
      waitForConnection: unexpected,
      request: unexpected,
    },
    inbox: new InboxService(database.db, store, unexpected),
    tokens: new McpTokenStore(database.db),
    projects,
    home: join(dir, "home"),
    worktreesDir: join(dir, "wt"),
    orchestratorDir: join(dir, "orchestrator"),
  });
}

describe("CI=true in a project's agent sessions", () => {
  it("is on for new projects and stays off once the project turns it off", async () => {
    const id = await addProject();
    expect(projects.get(id).agentCiEnv).toBe(true);
    expect(projects.update(id, { agentCiEnv: false }).agentCiEnv).toBe(false);
    // Read back from the projection, not the returned object.
    expect(projects.get(id).agentCiEnv).toBe(false);
    // Other changes leave it alone.
    projects.update(id, { pinned: true });
    expect(projects.get(id).agentCiEnv).toBe(false);
    expect(projects.update(id, { agentCiEnv: true }).agentCiEnv).toBe(true);
  });

  it("tells the runner to add no CI for a project that turned it off", async () => {
    const id = await addProject();
    const session = { ...sampleSession, projectId: id };
    expect(launcher().sessionOptions(session).ciEnv).toBeUndefined();
    projects.update(id, { agentCiEnv: false });
    expect(launcher().sessionOptions(session).ciEnv).toBe(false);
    // Sessions without a project (the orchestrator) keep the default.
    expect(launcher().sessionOptions({ ...sampleSession, projectId: null }).ciEnv).toBeUndefined();
  });
});
