import { expect, it, vi } from "vitest";
import { sampleProject, sampleSession } from "../../../packages/contracts/test/fixtures";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { ChecklistListener } from "../src/services/checklist/checklist-listener";
import { ChecklistService } from "../src/services/checklist/checklist-service";
import { SessionRepo } from "../src/services/sessions/repo";

it("tracks linked sessions and their children using the result written by finish", async () => {
  const database = openDatabase(":memory:");
  const store = new EventStore(database.db);
  const checklist = new ChecklistService(database.db, store);
  const repo = new SessionRepo(database.db, store);
  const listener = new ChecklistListener(store, repo, checklist);
  try {
    const projectId = sampleProject.id;
    const session = { ...sampleSession, projectId, status: "idle" as const };
    const child = { ...session, id: "child", parentSessionId: session.id };
    const runningChild = { ...child, id: "running-child", status: "running" as const };
    store.append([
      { type: "project.created", sessionId: null, payload: { project: sampleProject } },
      ...[session, child, runningChild].map((entry) => ({
        type: "session.created" as const,
        sessionId: entry.id,
        payload: { session: entry },
      })),
    ]);
    await Promise.resolve();
    checklist.update(projectId, { items: [{ id: "linked", text: "Work" }, { text: "Unlinked" }] });
    checklist.link(projectId, "linked", session);
    const statuses = () => checklist.get(projectId)?.items.map((item) => item.status);
    repo.update(runningChild.id, (entry) => ({ ...entry, title: "Renamed" }));
    await Promise.resolve();
    expect(statuses()).toEqual(["todo", "todo"]);
    repo.update(child.id, (entry) => ({ ...entry, status: "running" }));
    expect(statuses()).toEqual(["todo", "todo"]);
    await Promise.resolve();
    expect(statuses()).toEqual(["doing", "todo"]);
    repo.update(child.id, (entry) => ({ ...entry, status: "failed" }));
    await Promise.resolve();
    expect(statuses()).toEqual(["blocked", "todo"]);
    repo.update(session.id, (entry) => ({
      ...entry,
      status: "idle",
      result: { outcome: "success", summary: "Done", at: entry.updatedAt },
    }));
    await Promise.resolve();
    expect(statuses()).toEqual(["done", "todo"]);
    checklist.updateItem(projectId, "linked", { status: "blocked" }, session);
    repo.update(session.id, (entry) => ({ ...entry, title: "Renamed" }));
    await Promise.resolve();
    expect(statuses()).toEqual(["blocked", "todo"]);
    repo.update(session.id, (entry) => ({
      ...entry,
      result: { outcome: "success", summary: "Done again", at: "2026-11-22T12:00:00Z" },
    }));
    await Promise.resolve();
    expect(statuses()).toEqual(["done", "todo"]);
    repo.update(child.id, (entry) => ({ ...entry, archivedAt: entry.updatedAt, status: "failed" }));
    await Promise.resolve();
    expect(statuses()).toEqual(["done", "todo"]);

    listener.onWorkSignal(session.id, "started");
    expect(statuses()).toEqual(["done", "todo"]);
  } finally {
    listener.stop();
    database.close();
  }
});

it("logs failed automatic updates and keeps listening", async () => {
  const database = openDatabase(":memory:");
  const store = new EventStore(database.db);
  const checklist = new ChecklistService(database.db, store);
  const repo = new SessionRepo(database.db, store);
  const listener = new ChecklistListener(store, repo, checklist);
  const session = { ...sampleSession, projectId: sampleProject.id, status: "idle" as const };
  try {
    store.append([{ type: "session.created", sessionId: session.id, payload: { session } }]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const markWork = vi.spyOn(checklist, "markWork").mockImplementationOnce(() => {
      throw new Error("Write failed");
    });
    try {
      repo.update(session.id, (entry) => ({ ...entry, status: "failed" }));
      await Promise.resolve();
      expect(log).toHaveBeenCalledOnce();
      repo.update(session.id, (entry) => ({ ...entry, title: "Renamed" }));
      await Promise.resolve();
      expect(markWork).toHaveBeenCalledTimes(2);
      expect(markWork).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: session.id }),
        "blocked",
      );
    } finally {
      log.mockRestore();
      markWork.mockRestore();
    }
  } finally {
    listener.stop();
    database.close();
  }
});

it("preserves manual status when an existing session receives an unrelated update after startup", async () => {
  const database = openDatabase(":memory:");
  const store = new EventStore(database.db);
  const checklist = new ChecklistService(database.db, store);
  const repo = new SessionRepo(database.db, store);
  const projectId = sampleProject.id;
  const session = { ...sampleSession, projectId, status: "running" as const };
  store.append([
    { type: "project.created", sessionId: null, payload: { project: sampleProject } },
    { type: "session.created", sessionId: session.id, payload: { session } },
  ]);
  const listener = new ChecklistListener(store, repo, checklist);
  try {
    checklist.update(projectId, { items: [{ id: "linked", text: "Work" }] });
    checklist.link(projectId, "linked", session);
    checklist.updateItem(projectId, "linked", { status: "blocked" }, session);
    repo.update(session.id, (entry) => ({ ...entry, title: "Renamed" }));
    await Promise.resolve();
    expect(checklist.get(projectId)?.items[0]?.status).toBe("blocked");
  } finally {
    listener.stop();
    database.close();
  }
});

it("marks an item when a linked child is created already waiting", async () => {
  const database = openDatabase(":memory:");
  const store = new EventStore(database.db);
  const checklist = new ChecklistService(database.db, store);
  const repo = new SessionRepo(database.db, store);
  const projectId = sampleProject.id;
  const session = { ...sampleSession, projectId };
  store.append([
    { type: "project.created", sessionId: null, payload: { project: sampleProject } },
    { type: "session.created", sessionId: session.id, payload: { session } },
  ]);
  checklist.update(projectId, { items: [{ id: "linked", text: "Work" }] });
  checklist.link(projectId, "linked", session);
  const listener = new ChecklistListener(store, repo, checklist);
  try {
    const child = {
      ...session,
      id: "waiting-child",
      parentSessionId: session.id,
      status: "waiting" as const,
    };
    store.append([{ type: "session.created", sessionId: child.id, payload: { session: child } }]);
    await Promise.resolve();
    expect(checklist.get(projectId)?.items[0]?.needsOwner).toEqual({
      reason: "Waiting for your answer",
      sessionId: child.id,
      source: "work",
    });
  } finally {
    listener.stop();
    database.close();
  }
});

it("exposes the work signal handler without the unused child event export", async () => {
  const listener = await import("../src/services/checklist/checklist-listener");
  expect(listener.ChecklistListener.prototype.onWorkSignal).toBeTypeOf("function");
  expect(listener).not.toHaveProperty("CHILD_RUN_EVENT_TYPES");
});
