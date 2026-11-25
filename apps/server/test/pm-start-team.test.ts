import {
  type AutonomyLevel,
  type AutonomyPolicy,
  type Session,
  Settings,
  type StartSessionRequest,
  TEAM_ROLE_TAGS,
  type Team,
} from "@codeden/contracts";
import { expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { ToolRegistry } from "../src/mcp/registry";
import { setSessionAutonomy, startSession } from "../src/mcp/tools/pm/sessions";
import type { AppServices } from "../src/services/container";
import { DecisionApprovals } from "../src/services/decision-approvals";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession, sampleSessionEvent } from "./helpers";

// A PM start resolves the same Team as the caller's Team file: the caller's own role layer, then
// the project's Team, then the default Team; the guard checks the start by that same Team.
async function start(
  input: Record<string, unknown>,
  opts: {
    sessionId?: string;
    project?: Team;
    defaults?: Team;
    callerTitle?: string;
    architect?: boolean;
    pmPolicy?: AutonomyPolicy;
    teamPolicy?: AutonomyPolicy;
    autonomy?: AutonomyLevel;
    resumeWith?: AutonomyLevel;
  },
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
        ...(opts.architect ? { teamArchitect: true } : {}),
      }));
      sessionRepo.update(sampleSession.id, (s) => ({
        ...s,
        title: opts.callerTitle ?? null,
        projectId: "p1",
        provider: "codex",
        model: "caller-model",
      }));
    }
    const started: Session[] = [];
    const project = {
      id: "p1",
      kind: "local",
      archivedAt: null,
      path: process.cwd(),
      autonomy: opts.autonomy ?? "full",
      allowUnenforcedProviders: true,
    };
    const services = {
      db: database.db,
      projects: { get: () => project },
      factory: {
        isUnattended: () => false,
        providerChoices: async () => [{ id: "claude", runnable: true }],
        data: {
          loop: () => ({
            tuning: {
              team: opts.project ?? [],
              autonomyPolicy: opts.teamPolicy,
              resultSummaryBytes: null,
            },
          }),
        },
        ctx: { sessions: { models: () => [] } },
      },
      settings: {
        get: () =>
          Settings.parse({
            autonomy: { pmPolicy: opts.pmPolicy },
            teamSetup: { remembered: true, team: opts.defaults ?? [] },
          }),
      },
      sessionRepo,
      decisions: new DecisionApprovals(store, { check: vi.fn(), post: vi.fn() }),
    } as unknown as AppServices;
    const resume = vi.fn(async (_session: Session) => {});
    const sessions = new SessionService({
      repo: sessionRepo,
      projects: services.projects,
      settings: services.settings,
      outbox: new Outbox(database.db, store),
      runner: {
        isConnected: () => true,
        providers: () =>
          ["claude", "codex", "cursor", "gemini", "opencode"].map((id) => ({
            id,
            capabilities: { readOnly: true, supervised: true, reasoningEffort: true },
          })),
        request: async () => {
          throw Object.assign(new Error("Stopped"), { code: "unknown_session" });
        },
      },
      artifacts: {
        externalizeAttachments: (input: unknown) => input,
        resolveAttachments: (input: unknown) => input,
      },
      launcher: { launch: vi.fn(async () => {}), resume },
    } as unknown as SessionServiceDeps);
    services.sessions = {
      start: async (req: StartSessionRequest, options: Parameters<SessionService["start"]>[1]) => {
        const result = await sessions.start(req, { ...options, chromeApproved: true });
        if (result.status === "started") started.push(sessionRepo.get(result.sessionId));
        return result;
      },
    } as SessionService;
    const ctx = {
      services,
      projectId: "p1",
      sessionId: opts.sessionId ?? sampleSession.id,
      role: opts.callerTitle === "[Architect] Lead" ? ("agent" as const) : ("pm" as const),
      caller: "mcp" as const,
      signal: new AbortController().signal,
    };
    const args = { prompt: "Go", purpose: "Go", ...input };
    if (ctx.role === "agent" && opts.architect) {
      const registry = new ToolRegistry([startSession], services);
      const result = await registry.call("start_session", args, ctx);
      expect(result.isError, result.text).toBe(false);
      return { started };
    }
    const result = await startSession.handler(startSession.input.parse(args), ctx);
    const child = started[0];
    if (opts.resumeWith && child) {
      project.autonomy = opts.resumeWith;
      sessionRepo.update(child.id, (s) => ({ ...s, status: "stopped" }));
      await sessions.send(child.id, {
        input: { text: "Resume", attachments: [] },
        whenBusy: "queue",
      });
      expect(resume).toHaveBeenCalledOnce();
    }
    return { result, started, resumed: resume.mock.calls[0]?.[0] };
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

it.each([
  "PRD deployment",
  "Provisioning",
  "Database migration",
  "Install requiring an owner card",
])("opens card-gated work supervised for %s", async (purpose) => {
  const { started } = await start({ purpose }, {});
  expect(started[0]?.autonomy).toBe("supervised");
});

it("accepts an explicit request for supervision", async () => {
  const { started } = await start({ autonomy: "supervised" }, {});
  expect(started[0]?.autonomy).toBe("supervised");
});

it.each([
  ["full", undefined, undefined, "full"],
  ["auto", "full", undefined, "auto"],
  ["full", "supervised", undefined, "supervised"],
  ["read_only", "supervised", undefined, "read_only"],
  ["auto", "full", "full", "full"],
] as const)(
  "resolves project %s, floor %s and choice %s",
  async (autonomy, floor, choice, want) => {
    const { started } = await start(
      { autonomy: choice },
      { autonomy, pmPolicy: floor ? { agent: { "*": floor } } : undefined },
    );
    expect(started[0]?.autonomy).toBe(want);
  },
);

it.each([
  ["supervised", "auto", undefined, "supervised"],
  ["full", "read_only", undefined, "read_only"],
  [undefined, "auto", undefined, "auto"],
  [undefined, "auto", "supervised", "supervised"],
] as const)(
  "resumes choice %s with project default %s and floor %s",
  async (autonomy, resumeWith, floor, want) => {
    const { resumed } = await start(
      { autonomy },
      { autonomy: "full", resumeWith, pmPolicy: floor ? { agent: { "*": floor } } : undefined },
    );
    expect(resumed?.autonomy).toBe(want);
  },
);

it("refuses an explicit request below a Read-only project default", async () => {
  await expect(start({ autonomy: "full" }, { autonomy: "read_only" })).rejects.toThrow(
    "Autonomy policy requires read_only",
  );
});

it("refuses a request below the purpose policy", async () => {
  await expect(start({ purpose: "Provisioning", autonomy: "full" }, {})).rejects.toThrow(
    "supervised",
  );
});

it("resolves the PM and Team policies for the role and purpose", async () => {
  const { started } = await start(
    { title: "[Writer] Fix it", purpose: "documentation" },
    {
      project: [writer],
      pmPolicy: { writer: { "*": "full" } },
      teamPolicy: { writer: { documentation: "auto" } },
    },
  );
  expect(started[0]?.autonomy).toBe("auto");
});

it("keeps each role's configured autonomy for work without owner cards", async () => {
  const opts = {
    project: [writer, { ...writer, role: "planReviewer" as const }],
    teamPolicy: { writer: { "*": "full" }, planReviewer: { "*": "read_only" } } as const,
  };
  const input = { purpose: "Documentation" };
  const writerRun = await start({ ...input, title: "[Writer] Work" }, opts);
  const reviewerRun = await start({ ...input, title: "[Plan Reviewer] Work" }, opts);
  expect(writerRun.started[0]?.autonomy).toBe("full");
  expect(reviewerRun.started[0]?.autonomy).toBe("read_only");
});

it("uses the strictest matching purpose rule in a free-text purpose", async () => {
  const { started } = await start(
    { title: "[Writer] Fix it", purpose: "Update USER TABLE documentation" },
    {
      project: [writer],
      teamPolicy: {
        writer: { "*": "full", documentation: "auto", "user table": "supervised" },
      },
    },
  );
  expect(started[0]?.autonomy).toBe("supervised");
});

it("does not match purpose keys inside another word", async () => {
  const { started } = await start(
    { title: "[Writer] Fix it", purpose: "Update documentation" },
    { project: [writer], teamPolicy: { writer: { "*": "auto", doc: "supervised" } } },
  );
  expect(started[0]?.autonomy).toBe("auto");
});

it("applies current policy to a running agent with no stored floor", async () => {
  const database = openDatabase(":memory:");
  try {
    const repo = new SessionRepo(database.db, new EventStore(database.db));
    const session = {
      ...sampleSession,
      projectId: "p1",
      title: "[Writer] Work",
      purpose: "documentation",
      autonomy: "supervised" as const,
    };
    repo.create(session, {
      workspaceMode: "repo_root",
      workspaceFallback: null,
      forced: null,
      queuedBehind: [],
    });
    const update = vi.fn(async () => ({ autonomy: "full" }));
    const services = {
      sessionRepo: repo,
      sessions: { update },
      settings: { get: () => Settings.parse({}) },
      factory: {
        data: {
          loop: () => ({ tuning: { autonomyPolicy: { writer: { documentation: "supervised" } } } }),
        },
      },
    } as unknown as AppServices;
    await expect(
      setSessionAutonomy.handler(
        { sessionId: session.id, autonomy: "full", reason: "Try to lower supervision" },
        {
          services,
          projectId: "p1",
          sessionId: "pm1",
          role: "pm",
          caller: "mcp",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow("Autonomy policy requires supervised");
    expect(update).not.toHaveBeenCalled();
  } finally {
    database.close();
  }
});

it("raises a running agent to supervised, audits the reason, and refuses a later downgrade", async () => {
  const database = openDatabase(":memory:");
  try {
    const store = new EventStore(database.db);
    const repo = new SessionRepo(database.db, store);
    const session = { ...sampleSession, projectId: "p1", autonomy: "full" as const };
    repo.create(session, {
      workspaceMode: "repo_root",
      workspaceFallback: null,
      forced: null,
      queuedBehind: [],
      autonomyFloor: "supervised",
    });
    const request = vi.fn(async () => ({}));
    const sessions = new SessionService({
      repo,
      runner: {
        isConnected: () => true,
        request,
        providers: () => [{ id: session.provider, capabilities: { supervised: true } }],
      },
    } as unknown as SessionServiceDeps);
    const services = {
      sessionRepo: repo,
      sessions,
      settings: { get: () => Settings.parse({}) },
      factory: { data: { loop: () => undefined } },
    } as unknown as AppServices;
    const ctx = {
      services,
      projectId: "p1",
      sessionId: "pm1",
      role: "pm" as const,
      caller: "mcp" as const,
      signal: new AbortController().signal,
    };
    await expect(
      setSessionAutonomy.handler(
        { sessionId: session.id, autonomy: "supervised", reason: "Migration approval" },
        ctx,
      ),
    ).resolves.toEqual({ sessionId: session.id, autonomy: "supervised" });
    expect(request).toHaveBeenCalledWith(
      { name: "session.configure", sessionId: session.id, autonomy: "supervised", revision: 1 },
      expect.any(Number),
    );
    expect(store.listAfter(0)).toContainEqual(
      expect.objectContaining({
        type: "session.autonomy_changed",
        sessionId: session.id,
        payload: {
          autonomy: "supervised",
          previous: "full",
          reason: "Migration approval",
          changedBy: "pm1",
        },
      }),
    );
    await expect(
      setSessionAutonomy.handler(
        { sessionId: session.id, autonomy: "auto", reason: "Try to skip approval" },
        ctx,
      ),
    ).rejects.toThrow("Autonomy policy requires supervised");
    expect(() => sessions.update(session.id, { autonomy: "full" })).toThrow(
      "Autonomy policy requires supervised",
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(repo.get(session.id).autonomy).toBe("supervised");
  } finally {
    database.close();
  }
});

it.each(Object.entries(TEAM_ROLE_TAGS))("checks every Team role %s", async (tag, role) => {
  const title = `${tag} Work`;
  await expect(start({ title }, {})).rejects.toThrow("TEAM_ROLE_UNSET");
  const defaults: Team = [{ ...writer, role, model: "global-model" }];
  const project: Team = [{ ...writer, role }];
  for (const [opts, provider, model] of [
    [{ defaults }, "claude", "global-model"],
    [{ defaults, project }, "claude", "project-model"],
    [{ defaults, project, callerTitle: `${tag} Lead`, architect: true }, "codex", "caller-model"],
  ] as const) {
    const { started } = await start({ title, provider, model }, opts);
    expect(started[0]).toMatchObject({ provider, model });
    const wrongProvider = provider === "claude" ? "codex" : "claude";
    await expect(start({ title, provider: wrongProvider }, opts)).rejects.toThrow("TEAM_MISMATCH");
    await expect(start({ title, model: "wrong-model" }, opts)).rejects.toThrow("TEAM_MISMATCH");
  }
});

it("allows only the PM's delegated Architect to open child sessions", async () => {
  const input = { title: "[Writer] Work", autonomy: "supervised" };
  await expect(
    start(input, { project: [writer], callerTitle: "[Architect] Lead" }),
  ).rejects.toThrow("delegated Team Architect");
  const result = await start(input, {
    project: [writer],
    callerTitle: "[Architect] Lead",
    architect: true,
  });
  expect(result.started[0]).toMatchObject({ autonomy: "supervised", parentSessionId: "s1" });
});
