import { Settings, type StartSessionRequest, type Team } from "@codeden/contracts";
import { expect, it } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { startSession } from "../src/mcp/tools/pm/sessions";
import type { AppServices } from "../src/services/container";
import { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession, sampleSessionEvent } from "./helpers";

// A PM start resolves the same Team as the caller's Team file: the caller's own role layer, then
// the project's Team, then the default Team; the guard checks the start by that same Team.
async function start(
  input: Record<string, unknown>,
  opts: { sessionId?: string; project?: Team; defaults?: Team; callerTitle?: string },
) {
  const database = openDatabase(":memory:");
  try {
    const store = new EventStore(database.db);
    store.append(sampleSessionEvent());
    const sessionRepo = new SessionRepo(database.db, store);
    if (opts.callerTitle) {
      sessionRepo.setStartMeta(sampleSession.id, (m) => ({
        ...(m ?? {
          workspaceMode: "worktree",
          workspaceFallback: null,
          forced: null,
          queuedBehind: [],
        }),
        ownTeamPins: true,
      }));
      sessionRepo.update(sampleSession.id, (s) => ({
        ...s,
        title: opts.callerTitle ?? null,
        provider: "codex",
        model: "caller-model",
      }));
    }
    const started: StartSessionRequest[] = [];
    const services = {
      db: database.db,
      projects: { get: () => ({ kind: "local", archivedAt: null }) },
      factory: {
        isUnattended: () => false,
        data: { loop: () => ({ tuning: { team: opts.project ?? [], resultSummaryBytes: null } }) },
        ctx: { sessions: { models: () => [] } },
      },
      settings: {
        get: () => Settings.parse({ teamSetup: { remembered: true, team: opts.defaults ?? [] } }),
      },
      sessionRepo,
      sessions: {
        start: async (req: StartSessionRequest) => {
          started.push(req);
          return { status: "started", sessionId: "child" };
        },
      },
    } as unknown as AppServices;
    const result = await startSession.handler(
      startSession.input.parse({ prompt: "Go", purpose: "Go", ...input }),
      {
        services,
        projectId: "p1",
        sessionId: opts.sessionId ?? sampleSession.id,
        role: "pm",
        caller: "mcp",
        signal: new AbortController().signal,
      },
    );
    return { result, started };
  } finally {
    database.close();
  }
}

const writer = {
  role: "writer" as const,
  provider: "claude" as const,
  model: "project-model",
  effort: "high" as const,
};

it("fills an omitted pin from the caller's own role layer over the project Team", async () => {
  const { started } = await start(
    { title: "[Writer] Fix it" },
    { project: [writer], callerTitle: "[Writer] Lead" },
  );
  expect(started[0]).toMatchObject({ provider: "codex", model: "caller-model" });
});

it("fills an omitted pin from the project Team over the default Team", async () => {
  const { started } = await start(
    { title: "[Writer] Fix it" },
    { project: [writer], defaults: [{ ...writer, model: "default-model" }] },
  );
  expect(started[0]).toMatchObject({ provider: "claude", model: "project-model", effort: "high" });
});

it("refuses a start whose calling session can't be read for its Team", async () => {
  await expect(
    start({ title: "[Writer] Fix it" }, { sessionId: "missing", project: [writer] }),
  ).rejects.toThrow(/TEAM_UNRESOLVED/);
});
