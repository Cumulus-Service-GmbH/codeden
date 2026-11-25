import { SessionDetail, Settings } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { setSessionAutonomy } from "../src/mcp/tools/pm/sessions";
import { sessionRoutes } from "../src/routes/sessions";
import type { AppServices } from "../src/services/container";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";

const session = {
  ...sampleSession,
  status: "running" as const,
  autonomy: "supervised" as const,
  projectId: "p1",
  title: "[Writer] Work",
  purpose: "prd migration",
};
const { id } = session;

function setup() {
  const database = openDatabase(":memory:");
  const store = new EventStore(database.db);
  const repo = new SessionRepo(database.db, store);
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
    outbox: { count: () => 0 },
    runner: {
      request,
      providers: () => [{ id: session.provider, capabilities: { supervised: true } }],
    },
  } as unknown as SessionServiceDeps);
  const overrideEvents = () =>
    store.listAfter(0).filter((event) => event.type === "session.autonomy_overridden");
  return { database, repo, request, sessions, overrideEvents };
}

let fixture: ReturnType<typeof setup>;
beforeEach(() => {
  fixture = setup();
});
afterEach(() => fixture.database.close());

it("the owner raises a protected running session to Full and it applies at once", async () => {
  const { sessions, repo, request } = fixture;
  await expect(sessions.update(id, { autonomy: "full" }, { owner: true })).resolves.toMatchObject({
    autonomy: "full",
  });
  expect(repo.get(id).autonomy).toBe("full");
  expect(request).toHaveBeenCalledWith(
    { name: "session.configure", sessionId: id, autonomy: "full", revision: 1 },
    expect.any(Number),
  );
});

it("records the owner override with actor, time, session, old and new level", async () => {
  const { sessions, repo, overrideEvents } = fixture;
  await sessions.update(id, { autonomy: "full" }, { owner: true });
  const at = repo.get(id).updatedAt;
  expect(new Date(at).toISOString()).toBe(at);
  expect(overrideEvents()).toEqual([
    expect.objectContaining({
      type: "session.autonomy_overridden",
      sessionId: id,
      payload: { actor: "owner", at, sessionId: id, previous: "supervised", autonomy: "full" },
    }),
  ]);
  const events = overrideEvents();
  await sessions.update(id, { title: "x" }, { owner: true });
  expect(overrideEvents()).toEqual(events);
});

it("an agent still can't lower it", async () => {
  const { sessions, repo, overrideEvents } = fixture;
  await sessions.update(id, { autonomy: "full" }, { owner: true });
  await sessions.update(id, { autonomy: "supervised" }, { owner: true });
  const events = overrideEvents();
  const services = {
    sessionRepo: repo,
    sessions,
    settings: { get: () => Settings.parse({}) },
    factory: { data: { loop: () => undefined } },
  } as unknown as AppServices;
  await expect(
    setSessionAutonomy.handler(
      { sessionId: id, autonomy: "full", reason: "lower it" },
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
  expect(() => sessions.update(id, { autonomy: "full" })).toThrow(
    "Autonomy policy requires supervised",
  );
  expect(() =>
    sessions.update(id, { autonomy: "full" }, { changedBy: "pm1", reason: "x" }),
  ).toThrow("Autonomy policy requires supervised");
  expect(repo.get(id).autonomy).toBe("supervised");
  expect(overrideEvents()).toEqual(events);
});

it("the UI route passes the owner", async () => {
  const update = vi.fn(async () => ({ ...session, autonomy: "full" }));
  const app = sessionRoutes({ sessions: { update } } as unknown as AppServices, "token");
  const response = await app.request("/s1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autonomy: "full" }),
  });
  expect(response.status).toBe(200);
  expect(update).toHaveBeenCalledWith("s1", { autonomy: "full" }, { owner: true });
});

it("reports the PM policy to the owner and still allows an explicit override", async () => {
  const { sessions, repo } = fixture;
  const services = {
    sessionRepo: repo,
    sessions,
    settings: {
      get: () => Settings.parse({ autonomy: { pmPolicy: { writer: { "*": "read_only" } } } }),
    },
    factory: { data: { loop: () => undefined } },
  } as unknown as AppServices;
  const app = sessionRoutes(services, "token");
  const detail = await app.request(`/${id}`);
  expect(detail.status).toBe(200);
  expect(SessionDetail.parse(await detail.json()).autonomyFloor).toBe("read_only");
  await expect(
    setSessionAutonomy.handler(
      { sessionId: id, autonomy: "full", reason: "Change permissions" },
      {
        services,
        projectId: "p1",
        sessionId: "pm1",
        role: "pm",
        caller: "mcp",
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toThrow("Autonomy policy requires read_only or more supervision. Requested full.");

  const response = await app.request(`/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autonomy: "full" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ autonomy: "full" });
});
