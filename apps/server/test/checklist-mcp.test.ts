import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEnvelope, ServerToClientMessage, Snapshot } from "@codeden/contracts";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { sampleProject } from "../../../packages/contracts/test/fixtures";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { type ToolCaller, ToolRegistry } from "../src/mcp/registry";
import { allTools } from "../src/mcp/tools";
import { type RunningServer, startServer } from "../src/server";
import { ChecklistService } from "../src/services/checklist/checklist-service";
import { removeTree } from "./support/remove-tree";

const token = "t".repeat(64);
const headers = { authorization: `Bearer ${token}` };
const projectId = sampleProject.id;
const otherProject = { ...sampleProject, id: "other", slug: "other", path: "/other" };

function seedProjects(store: EventStore): void {
  store.append(
    [sampleProject, otherProject].map((project) => ({
      type: "project.created",
      sessionId: null,
      payload: { project },
    })),
  );
}

function caller(role: ToolCaller["role"], project: string | null = projectId): ToolCaller {
  return {
    role,
    projectId: project,
    sessionId: `session-${role}`,
    signal: new AbortController().signal,
    caller: "mcp",
  };
}

it("limits writes to the orchestrator and reads to the PM's own project", async () => {
  const database = openDatabase(":memory:");
  try {
    const store = new EventStore(database.db);
    const checklist = new ChecklistService(database.db, store);
    const tools = new ToolRegistry(
      allTools.filter(({ name }) => name === "update_checklist" || name === "read_checklist"),
      { checklist } as never,
    );
    seedProjects(store);
    checklist.update(projectId, { items: [{ id: "own", text: "Own task", status: "done" }] });
    checklist.update(otherProject.id, { items: [{ id: "other", text: "Other task" }] });
    const head = store.headSeq();

    for (const role of ["orchestrator", "pm", "agent"] as const) {
      const names = tools.list(role).map(({ name }) => name);
      expect(names.includes("update_checklist")).toBe(role === "orchestrator");
      expect(names.includes("read_checklist")).toBe(role === "pm");
    }

    for (const role of ["pm", "agent"] as const) {
      expect(await tools.call("update_checklist", { projectId, items: [] }, caller(role))).toEqual({
        isError: true,
        text: "Unknown tool: update_checklist",
      });
    }
    expect(await tools.call("read_checklist", {}, caller("pm"))).toEqual({
      isError: false,
      text: "1/1 done · 100%\n- [done] Own task (own)",
    });
    expect(
      await tools.call("read_checklist", { projectId: otherProject.id }, caller("pm")),
    ).toMatchObject({
      isError: true,
    });
    expect(store.headSeq()).toBe(head);
  } finally {
    database.close();
  }
});

function receive<T>(
  ws: WebSocket,
  match: (message: ServerToClientMessage) => T | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for checklist WebSocket message"));
    }, 5_000);
    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    }
    function onError(error: Error) {
      cleanup();
      reject(error);
    }
    function onMessage(data: Buffer) {
      const message = ServerToClientMessage.parse(JSON.parse(data.toString()));
      const result = match(message);
      if (result === undefined) return;
      cleanup();
      resolve(result);
    }
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

it("includes the checklist in the snapshot and streams committed tool updates", async () => {
  const home = mkdtempSync(join(tmpdir(), "codeden-checklist-"));
  let server: RunningServer | undefined;
  try {
    server = await startServer({
      port: 0,
      dataDir: home,
      userHome: home,
      token,
      runner: false,
      secrets: "memory",
      checkSetupOnStart: false,
    });
    seedProjects(server.store);
    const { checklist, tools } = server.services;
    const initial = checklist.update(projectId, { items: [{ id: "test", text: "Test" }] });
    const response = await fetch(`${server.url}/api/snapshot`, { headers });
    expect(response.status).toBe(200);
    const snapshot = Snapshot.parse(await response.json());
    expect(snapshot.checklists).toEqual([initial]);

    const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`, { headers });
    try {
      await receive(ws, (message) => (message.type === "hello" ? message : undefined));
      const pong = receive(ws, (message) => (message.type === "pong" ? message : undefined));
      ws.send(JSON.stringify({ type: "subscribe", fromSeq: snapshot.seq }));
      ws.send(JSON.stringify({ type: "ping", id: "checklist" }));
      await pong;

      const event = receive(ws, (message) =>
        message.type === "events"
          ? message.events.find(({ type }) => type === "checklist.updated")
          : undefined,
      );
      const result = await tools.call(
        "update_checklist",
        { projectId, patch: [{ id: "test", status: "done" }] },
        caller("orchestrator", null),
      );
      expect(EventEnvelope.parse(await event)).toMatchObject({
        type: "checklist.updated",
        seq: snapshot.seq + 1,
        payload: {
          checklist: { projectId, items: [{ id: "test", text: "Test", status: "done" }] },
        },
      });
      expect(result).toEqual({ isError: false, text: "1/1 done · 100%\n- [done] Test (test)" });
    } finally {
      ws.close();
    }
  } finally {
    await server?.close();
    await removeTree(home);
  }
});
