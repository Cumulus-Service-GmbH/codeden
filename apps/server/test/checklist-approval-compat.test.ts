import { CLIENT_CAPABILITIES, Snapshot, UiServerMessage, type UserInput } from "@codeden/contracts";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { sampleInboxItem } from "../../../packages/contracts/test/fixtures";
import { startSession } from "../src/mcp/tools/pm/sessions";
import { WsCapabilitiesQuery, WsHub } from "../src/realtime/hub";
import { type ApiContext, createApi } from "../src/routes/api";
import { inboxRoutes } from "../src/routes/inbox";
import { queryOf } from "../src/routes/validate";
import { ChecklistService } from "../src/services/checklist/checklist-service";
import type { AppServices } from "../src/services/container";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { createFactoryEnv } from "./support/factory-env";

const previousKind = z.enum([
  "question",
  "approval",
  "pr_review",
  "run_failed",
  "triage",
  "automation_result",
  "message",
  "conflict",
  "cleanup_failed",
  "spec_approval",
  "spot_check",
  "setup_change",
]);
const runnerStatus: ApiContext["runnerStatus"] = () => ({
  runner: { state: "disabled", runnerId: null, version: null, providers: [], lastError: null },
  runners: [],
});
let env: ReturnType<typeof createFactoryEnv>;
let checklist: ChecklistService;

beforeEach(() => {
  env = createFactoryEnv();
  checklist = new ChecklistService(env.db.db, env.store, env.inbox);
});
afterEach(() => env.close());

function requestApproval() {
  const { pending } = checklist.update(
    env.project.id,
    { items: [{ text: "Planned work" }] },
    { requestApproval: true },
  );
  if (!pending) throw new Error("Expected a checklist approval card");
  return pending.inboxItemId;
}

it("binds the approved expansion item to its start purpose during enforcement", async () => {
  const projectId = env.project.id;
  checklist.decide(requestApproval(), "resolved");
  checklist.setEnforce(projectId, true);
  const services = {
    checklist,
    factory: env.factory,
    settings: env.settings,
    projects: { get: () => env.project },
    sessions: new SessionService({
      checklist,
      projects: { get: () => env.project },
      repo: env.repo,
      runner: { providers: () => [], isConnected: () => false },
      settings: env.settings,
      launcher: { launch: async () => undefined },
      artifacts: {
        externalizeAttachments: (input: UserInput) => input,
        resolveAttachments: (input: UserInput) => input,
      },
    } as unknown as SessionServiceDeps),
    sessionRepo: env.repo,
  } as unknown as AppServices;
  const start = (purpose: string, checklistItemId?: string) =>
    startSession.handler(
      startSession.input.parse({ purpose, prompt: "Implement it", checklistItemId }),
      {
        services,
        projectId,
        sessionId: null,
        role: "pm",
        caller: "mcp",
        signal: new AbortController().signal,
      },
    );

  expect(await start("Add a counter")).toMatchObject({ status: "approval_required" });
  const pending = checklist.get(projectId)?.pending;
  const itemId = pending?.diff[0]?.itemId;
  if (!pending || !itemId) throw new Error("Expected a start expansion card");
  checklist.decide(pending.inboxItemId, "resolved");
  expect(checklist.get(projectId)?.items.find(({ id }) => id === itemId)).toMatchObject({
    startPurpose: "Add a counter",
  });
  await expect(start("Remove a counter", itemId)).rejects.toThrow(/approved for "Add a counter"/);
  expect(env.repo.list({ projectId })).toHaveLength(0);
  expect(await start("  ADD A COUNTER  ", itemId)).toMatchObject({ status: "started" });
  const { pending: reword } = checklist.update(projectId, {
    patch: [{ id: itemId, text: "  Add two counters  " }],
  });
  if (!reword) throw new Error("Expected a rewording proposal");
  checklist.decide(reword.inboxItemId, "resolved");
  expect(checklist.get(projectId)?.items.find(({ id }) => id === itemId)).toMatchObject({
    startPurpose: "Add two counters",
  });
  expect(await start("Add two counters", itemId)).toMatchObject({ status: "started" });
});

it("gates checklist cards in the snapshot, inbox list and counts", async () => {
  const ordinary = env.inbox.put({ ...sampleInboxItem, projectId: env.project.id });
  const cardId = requestApproval();
  env.inbox.put({ ...ordinary, id: "resolved-ordinary", status: "resolved" });
  env.inbox.put({ ...ordinary, id: "dismissed-ordinary", status: "dismissed" });
  const app = createApi({
    services: {
      checklist,
      db: env.db.db,
      inbox: env.inbox,
      decisions: { pending: () => [] },
      store: env.store,
      settings: env.settings,
      projects: { list: () => [env.project] },
      orchestration: {
        automation: { listScheduledRuns: () => [] },
        roles: { refs: () => undefined },
      },
    } as unknown as AppServices,
    runnerStatus,
    network: { token: "test" } as ApiContext["network"],
    startedAt: Date.now(),
    shutdown: () => {},
  });
  const read = async (path: string) => {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    return response.json();
  };
  const query = `?capabilities=${CLIENT_CAPABILITIES.join(",")}`;
  const legacy = Snapshot.parse(await read("/snapshot"));
  expect(legacy.inbox.map(({ kind }) => previousKind.parse(kind))).toEqual([ordinary.kind]);
  expect(Snapshot.parse(await read(`/snapshot${query}`)).inbox.map(({ id }) => id)).toEqual(
    expect.arrayContaining([cardId, ordinary.id]),
  );
  expect(await read("/inbox")).toEqual([ordinary]);
  expect(await read(`/inbox${query}`)).toEqual(
    expect.arrayContaining([ordinary, env.inbox.get(cardId)]),
  );
  expect(await read("/inbox/counts")).toEqual({
    open: 1,
    byProject: { [env.project.id]: 1 },
    byKind: { [ordinary.kind]: 1 },
  });
  expect(await read(`/inbox/counts${query}`)).toEqual(env.inbox.counts());
});

it("filters replay and live inbox events per WebSocket subscription", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const hub = new WsHub(env.store, env.db.db, runnerStatus);
  try {
    const ordinary = env.inbox.put(sampleInboxItem);
    const cardId = requestApproval();
    function subscribe(capabilities?: readonly string[]) {
      const messages: UiServerMessage[] = [];
      const ws = {
        readyState: 1,
        send: (data: string) => messages.push(UiServerMessage.parse(JSON.parse(data))),
        close: () => {},
      } as unknown as WSContext;
      const handlers = hub.handlers();
      handlers.onOpen?.(new Event("open"), ws);
      handlers.onMessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "subscribe", fromSeq: 0, capabilities }),
        }),
        ws,
      );
      return () =>
        messages
          .splice(0)
          .flatMap((message) =>
            message.type === "events"
              ? message.events.filter(
                  ({ type }) => type === "inbox.created" || type === "inbox.updated",
                )
              : [],
          );
    }
    const legacy = subscribe();
    const capable = subscribe(CLIENT_CAPABILITIES);
    const event = (type: string, id: string) =>
      expect.objectContaining({ type, payload: { item: expect.objectContaining({ id }) } });
    expect(legacy()).toEqual([event("inbox.created", ordinary.id)]);
    expect(capable()).toEqual([
      event("inbox.created", ordinary.id),
      event("inbox.created", cardId),
    ]);

    checklist.decide(cardId, "resolved");
    env.inbox.put({ ...ordinary, title: "Updated" });
    vi.runOnlyPendingTimers();
    expect(legacy()).toEqual([event("inbox.updated", ordinary.id)]);
    expect(capable()).toEqual([
      event("inbox.updated", cardId),
      event("inbox.updated", ordinary.id),
    ]);
  } finally {
    hub.close();
    vi.useRealTimers();
  }
});

it("combines connection capabilities with the subscription frame", () => {
  const hub = new WsHub(env.store, env.db.db, runnerStatus);
  try {
    const cardId = requestApproval();
    const messages: UiServerMessage[] = [];
    const ws = {
      readyState: 1,
      send: (data: string) => messages.push(UiServerMessage.parse(JSON.parse(data))),
      close: () => {},
    } as unknown as WSContext;
    const handlers = hub.handlers(CLIENT_CAPABILITIES);
    handlers.onOpen?.(new Event("open"), ws);
    handlers.onMessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "subscribe", fromSeq: 0, capabilities: [] }),
      }),
      ws,
    );
    const cards = messages.flatMap((message) =>
      message.type === "events"
        ? message.events.filter(({ type }) => type === "inbox.created")
        : [],
    );
    expect(cards).toEqual([
      expect.objectContaining({ payload: { item: expect.objectContaining({ id: cardId }) } }),
    ]);
  } finally {
    hub.close();
  }
});

it("explicitly requests only open records for legacy inbox counts", async () => {
  const open = env.inbox.put({ ...sampleInboxItem, projectId: env.project.id });
  const resolved = env.inbox.put({ ...open, id: "resolved", status: "resolved" });
  const list = env.inbox.list.bind(env.inbox);
  vi.spyOn(env.inbox, "list").mockImplementation((query) =>
    query?.status === "open" ? list(query) : [open, resolved],
  );
  const response = await inboxRoutes({
    inbox: env.inbox,
    decisions: { pending: () => [] },
  } as unknown as AppServices).request("/counts");
  expect(await response.json()).toMatchObject({ open: 1 });
});

it("bounds WebSocket capability queries by total length and entry count", async () => {
  const app = new Hono().get("/ws", queryOf(WsCapabilitiesQuery), (c) => c.body(null, 204));
  const query = (capabilities: string) => app.request(`/ws?capabilities=${capabilities}`);
  expect((await query("x".repeat(512))).status).toBe(204);
  expect((await query(Array(32).fill("x").join(","))).status).toBe(204);
  for (const capabilities of ["x".repeat(513), Array(33).fill("x").join(",")]) {
    const response = await query(capabilities);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  }
});

it.each(["", "&future=1"])("accepts the checklist WebSocket URL with suffix %j", async (suffix) => {
  const app = new Hono().get("/ws", queryOf(WsCapabilitiesQuery), (c) =>
    c.text(c.req.valid("query").capabilities ?? ""),
  );
  const response = await app.request(`/ws?capabilities=inbox.checklist_approval${suffix}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("inbox.checklist_approval");
});
