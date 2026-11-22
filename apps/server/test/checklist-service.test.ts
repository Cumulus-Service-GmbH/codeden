import { EventEnvelope } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleProject } from "../../../packages/contracts/test/fixtures";
import { type Database, openDatabase } from "../src/db/client";
import { projectChecklists } from "../src/db/schema";
import { applyProjection } from "../src/events/projector";
import { EventStore } from "../src/events/store";
import { ChecklistService } from "../src/services/checklist/checklist-service";

const projectId = sampleProject.id;
let database: Database;
let store: EventStore;
let service: ChecklistService;

beforeEach(() => {
  database = openDatabase(":memory:");
  store = new EventStore(database.db);
  service = new ChecklistService(database.db, store);
  store.append([{ type: "project.created", sessionId: null, payload: { project: sampleProject } }]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  database.close();
});

describe("checklist service", () => {
  it("replaces, patches and removes items without stamping unchanged items", () => {
    const before = service.update(projectId, {
      items: [{ id: "tests", text: "Run tests" }, { text: "Review" }, { id: "docs", text: "Docs" }],
    });
    expect(before.items.map((item) => item.status)).toEqual(["todo", "todo", "todo"]);
    expect(before.items[1]?.id).toBeTruthy();
    expect(before.changes).toHaveLength(3);

    vi.setSystemTime(new Date("2026-11-22T10:01:00Z"));
    const after = service.update(projectId, {
      patch: [
        { id: "tests", status: "done" },
        { id: "ship", text: "Ship" },
      ],
      remove: ["docs"],
    });
    expect(after.items.map((item) => item.id)).toEqual(["tests", before.items[1]?.id, "ship"]);
    expect(after.items[0]?.updatedAt).toBe(after.updatedAt);
    expect(after.items[1]).toEqual(before.items[1]);
    expect(after.changes).toEqual([
      { itemId: "tests", text: "Run tests", from: "todo", to: "done", at: after.updatedAt },
      { itemId: "ship", text: "Ship", from: null, to: "todo", at: after.updatedAt },
      { itemId: "docs", text: "Docs", from: "todo", to: null, at: after.updatedAt },
    ]);
    expect(service.list()).toEqual([after]);
    const head = store.headSeq();
    expect(service.update(projectId, { patch: [{ id: "tests", status: "done" }] })).toEqual(after);
    expect(store.headSeq()).toBe(head);
  });

  it("leaves the projection and event head intact when an update is rejected", () => {
    const checklist = service.update(projectId, { items: [{ id: "a", text: "A" }] });
    const head = store.headSeq();
    expect(() => service.update("missing", { items: [] })).toThrow(/project/i);
    expect(() => service.update(projectId, { patch: [{ id: "new" }] })).toThrow(/text/i);
    expect(() =>
      service.update(projectId, {
        items: [
          { id: "a", text: "A" },
          { id: "a", text: "B" },
        ],
      }),
    ).toThrow(/duplicate/i);
    expect(() => service.update(projectId, { patch: [{ id: "a", text: "" }] })).toThrow();
    expect(store.headSeq()).toBe(head);
    expect(service.get(projectId)).toEqual(checklist);

    store.append([{ type: "project.archived", sessionId: null, payload: { projectId } }]);
    expect(() => service.update(projectId, { items: [] })).toThrow(/archived/i);
    expect(store.headSeq()).toBe(head + 1);
  });

  it("rebuilds the checklist projection from the event log", () => {
    service.update(projectId, { items: [{ id: "tests", text: "Run tests" }] });
    service.update(projectId, { patch: [{ id: "tests", status: "done" }] });
    const rebuilt = openDatabase(":memory:");
    try {
      rebuilt.db.transaction((tx) => {
        for (const raw of store.listAfter(0)) applyProjection(tx, EventEnvelope.parse(raw));
      });
      expect(rebuilt.db.select().from(projectChecklists).all()).toEqual(
        database.db.select().from(projectChecklists).all(),
      );
      const last = EventEnvelope.parse(store.listAfter(0).at(-1));
      expect(last.type).toBe("checklist.updated");
      if (last.type !== "checklist.updated") throw new Error("Missing checklist update");
      expect(rebuilt.db.select().from(projectChecklists).get()?.checklist).toEqual(
        last.payload.checklist,
      );
    } finally {
      rebuilt.close();
    }
  });
});
