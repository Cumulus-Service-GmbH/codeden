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
    listener.onWorkSignal(session.id, "blocked");
    expect(statuses()).toEqual(["blocked", "todo"]);
    listener.onWorkSignal(session.id, "done");
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
    checklist.updateItem(projectId, "linked", { status: "done", note: "Verified" }, session);
    for (const status of ["idle", "running"] as const) {
      repo.update(session.id, (entry) => ({ ...entry, status }));
      await Promise.resolve();
      expect(checklist.get(projectId)?.items[0]).toMatchObject({
        status: "done",
        note: "Verified",
      });
    }
    repo.update(session.id, (entry) => ({ ...entry, status: "waiting" }));
    await Promise.resolve();
    expect(checklist.get(projectId)?.items[0]).toMatchObject({
      status: "blocked",
      note: "Waiting for your answer",
    });
    repo.update(session.id, (entry) => ({ ...entry, status: "running" }));
    await Promise.resolve();
    expect(checklist.get(projectId)?.items[0]).toMatchObject({ status: "done", note: "Verified" });
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
  const session = { ...sampleSession, projectId, status: "idle" as const };
  const second = { ...session, id: "second-parent", workKey: "issue:2" };
  store.append([
    { type: "project.created", sessionId: null, payload: { project: sampleProject } },
    { type: "session.created", sessionId: session.id, payload: { session } },
    { type: "session.created", sessionId: second.id, payload: { session: second } },
  ]);
  checklist.update(projectId, { items: [{ id: "linked", text: "Work" }] });
  checklist.link(projectId, "linked", session);
  checklist.update(projectId, { patch: [{ id: "linked", workKeys: [second.workKey] }] });
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
    checklist.reportInstallHealthy(projectId, second.id);
    expect(checklist.get(projectId)?.items[0]?.status).toBe("blocked");
    expect(checklist.get(projectId)?.items[0]?.needsOwner).toEqual({
      reason: "Waiting for your answer",
      sessionId: child.id,
      source: "work",
    });
    repo.update(session.id, (entry) => ({ ...entry, archivedAt: entry.updatedAt }));
    await Promise.resolve();
    expect.soft(checklist.get(projectId)?.items[0]?.needsOwner).toBeUndefined();
    const late = { ...child, id: "late-waiting-child" };
    store.append([{ type: "session.created", sessionId: late.id, payload: { session: late } }]);
    await Promise.resolve();
    expect(checklist.get(projectId)?.items[0]?.needsOwner).toBeUndefined();
    expect(checklist.get(projectId)?.items[0]?.status).toBe("doing");
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

it("audits linked session and work-key progress within the project", async () => {
  const database = openDatabase(":memory:");
  const store = new EventStore(database.db);
  const checklist = new ChecklistService(database.db, store);
  const repo = new SessionRepo(database.db, store);
  const listener = new ChecklistListener(store, repo, checklist);
  const projectId = sampleProject.id;
  const one = { ...sampleSession, projectId, status: "idle" as const };
  const two = { ...one, id: "lane-two", workKey: "issue:2" };
  const foreign = { ...two, id: "foreign", projectId: "foreign-project" };
  const item = () => checklist.get(projectId)?.items[0];
  try {
    store.append([
      { type: "project.created", sessionId: null, payload: { project: sampleProject } },
      {
        type: "project.created",
        sessionId: null,
        payload: {
          project: {
            ...sampleProject,
            id: foreign.projectId,
            slug: "foreign",
            path: "/tmp/foreign-project",
          },
        },
      },
      ...[one, two, foreign].map((session) => ({
        type: "session.created" as const,
        sessionId: session.id,
        payload: { session },
      })),
    ]);
    await Promise.resolve();
    checklist.update(projectId, { items: [{ id: "linked", text: "Combined build" }] });
    expect(() =>
      checklist.update(projectId, {
        patch: [{ id: "linked", sessionIds: [foreign.id] }],
      }),
    ).toThrow("project");
    checklist.update(projectId, {
      patch: [{ id: "linked", sessionIds: [one.id], workKeys: [two.workKey] }],
    });
    expect(item()).toMatchObject({ sessionIds: [one.id], workKeys: [two.workKey], status: "todo" });
    const transition = async (
      id: string,
      status: typeof one.status | "running" | "waiting" | "completed" | "failed",
    ) => {
      const before = store.headSeq();
      repo.update(id, (entry) => ({ ...entry, status }));
      await Promise.resolve();
      return store.listAfter(before).map((event) => event.type);
    };
    expect(await transition(foreign.id, "failed")).toEqual(["session.updated"]);
    expect(await transition(one.id, "running")).toContain("checklist.updated");
    expect(item()).toMatchObject({
      status: "doing",
      autoUpdatedAt: expect.any(String),
      note: expect.any(String),
    });
    await transition(two.id, "waiting");
    expect(item()).toMatchObject({ status: "blocked", note: expect.stringMatching(/waiting/i) });
    repo.update(two.id, (entry) => ({ ...entry, archivedAt: entry.updatedAt }));
    await Promise.resolve();
    expect(item()?.status).toBe("doing");
    expect(item()?.needsOwner).toBeUndefined();

    await transition(one.id, "waiting");
    repo.update(two.id, (entry) => ({
      ...entry,
      status: "failed",
      archivedAt: null,
      result: { outcome: "failed", summary: "Build check failed", at: entry.updatedAt },
    }));
    await Promise.resolve();
    expect(item()).toMatchObject({ status: "blocked", note: "Build check failed" });
    await transition(one.id, "completed");
    expect(item()?.status).toBe("blocked");
    repo.update(two.id, (entry) => ({ ...entry, status: "completed", result: null }));
    await Promise.resolve();
    expect(item()).toMatchObject({ status: "done", note: "All linked work done" });

    await transition(one.id, "running");
    await transition(two.id, "running");
    checklist.reportInstallHealthy(projectId, two.id);
    expect(item()?.status).toBe("doing");
    listener.stop();
    const restarted = new ChecklistListener(store, repo, new ChecklistService(database.db, store));
    try {
      await transition(one.id, "completed");
      expect(item()).toMatchObject({ status: "done", note: expect.stringContaining("LIVE") });
      await transition(two.id, "failed");
      expect(item()?.status).toBe("blocked");
      checklist.reportInstallHealthy(projectId, two.id);
      expect(item()?.status).toBe("done");
      checklist.update(projectId, { patch: [{ id: "linked", sessionIds: [], workKeys: [] }] });
      expect(await transition(one.id, "failed")).toEqual(["session.updated"]);
      expect(item()?.status).toBe("done");
    } finally {
      restarted.stop();
    }
  } finally {
    listener.stop();
    database.close();
  }
});

it("clears an automatic failure when the work key moves to an idle retry", async () => {
  const database = openDatabase(":memory:");
  const store = new EventStore(database.db);
  const checklist = new ChecklistService(database.db, store);
  const repo = new SessionRepo(database.db, store);
  const listener = new ChecklistListener(store, repo, checklist);
  const projectId = sampleProject.id;
  const failed = { ...sampleSession, projectId, status: "failed" as const };
  const retry = {
    ...failed,
    id: "idle-retry",
    status: "idle" as const,
    createdAt: "2026-11-26T00:00:00Z",
  };
  try {
    store.append([
      { type: "project.created", sessionId: null, payload: { project: sampleProject } },
    ]);
    checklist.update(projectId, { items: [{ id: "linked", text: "Build" }] });
    checklist.update(projectId, { patch: [{ id: "linked", workKeys: [failed.workKey] }] });
    store.append([{ type: "session.created", sessionId: failed.id, payload: { session: failed } }]);
    await Promise.resolve();
    expect(checklist.get(projectId)?.items[0]?.status).toBe("blocked");
    store.append([{ type: "session.created", sessionId: retry.id, payload: { session: retry } }]);
    await Promise.resolve();
    expect(checklist.get(projectId)?.items[0]).toMatchObject({
      status: "todo",
      note: "Waiting for linked work to start",
    });
  } finally {
    listener.stop();
    database.close();
  }
});
