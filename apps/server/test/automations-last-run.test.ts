import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationListItem, AutomationRun, CreateProjectResponse } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { removeTree } from "./support/remove-tree";

const TOKEN = "b".repeat(64);

describe("automation list last run", () => {
  let home: string;
  let server: RunningServer;
  let projectA: string;
  let projectB: string;
  let projectC: string;
  let automationId: string;

  const request = async (method: "POST" | "PATCH", path: string, body: unknown, status: number) => {
    const response = await fetch(`${server.url}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(status);
    return response.json();
  };

  async function createProject(userHome: string, name: string): Promise<string> {
    const path = join(userHome, name);
    mkdirSync(path, { recursive: true });
    const body = await request("POST", "/projects", { source: { type: "local", path } }, 201);
    return CreateProjectResponse.parse(body).project.id;
  }

  function saveRun(id: string, projectId: string, startedAt: string, finishedAt: string) {
    server.services.automations.runs.save(
      AutomationRun.parse({
        id,
        automationId,
        projectId,
        status: "completed",
        triggeredBy: "cron",
        startedBy: { kind: "automation", id: automationId },
        purpose: "Check the project",
        workKey: `automation:${automationId}`,
        scope: { projectId },
        progress: null,
        skipReason: null,
        sessionId: null,
        startedAt,
        finishedAt,
        error: null,
      }),
    );
  }

  function lastRun(projectId?: string): AutomationRun | null {
    const item = server.services.automations
      .list(projectId)
      .automations.find(({ automation }) => automation.id === automationId);
    if (!item) throw new Error(`Missing automation ${automationId} in the list`);
    return item.lastRun;
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "codeden-automation-last-run-"));
    const userHome = join(home, "user");
    server = await startServer({
      port: 0,
      dataDir: join(home, "data"),
      token: TOKEN,
      runner: false,
      secrets: "memory",
      checkSetupOnStart: false,
      userHome,
      automations: { rescanMs: 0 },
    });

    projectA = await createProject(userHome, "project-a");
    projectB = await createProject(userHome, "project-b");
    projectC = await createProject(userHome, "project-c");
    const created = await request(
      "POST",
      "/automations",
      {
        projectId: projectA,
        name: "Weekday check",
        trigger: { type: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Amsterdam" },
        action: { type: "start_session", prompt: "Check {{project.name}}", autonomy: "read_only" },
      },
      201,
    );
    automationId = AutomationListItem.parse(created).automation.id;
    await request(
      "PATCH",
      `/automations/${automationId}`,
      { target: { type: "all_projects" } },
      200,
    );

    saveRun("a-first", projectA, "2026-01-05T09:00:00Z", "2026-01-05T09:01:00Z");
    saveRun("a-second", projectA, "2026-01-06T09:00:00Z", "2026-01-06T09:01:00Z");
    saveRun("b-latest", projectB, "2026-01-07T09:00:00Z", "2026-01-07T09:01:00Z");
  });

  afterAll(async () => {
    await server?.close();
    await removeTree(home);
  });

  it("shows project A's newest run", () => {
    expect(lastRun(projectA)?.id).toBe("a-second");
  });

  it("shows project B's run", () => {
    expect(lastRun(projectB)?.id).toBe("b-latest");
  });

  it("shows no last run for project C", () => {
    expect(lastRun(projectC)).toBeNull();
  });

  it("shows the newest run across projects when unscoped", () => {
    expect(lastRun()?.id).toBe("b-latest");
  });
});
