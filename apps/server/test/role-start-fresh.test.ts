import {
  ArchivedSessionsPage,
  InboxItem,
  Session,
  Snapshot,
  ThreadItemsPage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

describe("starting a fresh role conversation", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({
      orchestration: { wake: { debounceMs: 10, maxWaitMs: 100 }, wakeupMinDelayMs: 0 },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  const rotate = (id: string) => h.api("POST", `/orchestration/sessions/${id}/start-fresh`);
  const transcript = async (session: Session) =>
    ThreadItemsPage.parse(
      (await h.api("GET", `/sessions/${session.id}/threads/${session.rootThreadId}/items`)).body,
    ).items;
  const idle = (id: string, withMessages = false) =>
    waitUntil(async () => {
      const { session } = await h.detail(id);
      if (session.status !== "idle" || !session.rootThreadId) return;
      if (withMessages && !(await transcript(session)).some((r) => r.item.kind === "user_message"))
        return;
      return session;
    });
  const seed = async (role: "pm" | "orchestrator", path: string) => {
    h.server.services.settings.update({
      providers: { [role]: { provider: "fake", model: "fake-1" } },
    });
    const response = await h.api("POST", `${path}/messages`, {
      input: { text: "Old conversation" },
    });
    expect(response.status).toBe(200);
    return idle((response.body as { sessionId: string }).sessionId, true);
  };

  it("rotates the PM, preserves its project state and delivers a scheduled wake to the replacement", async () => {
    const { orchestration, inbox, mcpTokens, projects, sessionRepo, settings } = h.server.services;
    const path = `/orchestration/projects/${h.projectId}/pm`;
    const old = await seed("pm", path);
    const past = await transcript(old);
    orchestration.notes.write(h.projectId, "Keep this note.", "replace");
    const at = new Date().toISOString();
    const item = inbox.put(
      InboxItem.parse({
        id: "test-inbox",
        kind: "message",
        status: "open",
        title: "Open work",
        body: null,
        projectId: h.projectId,
        sessionId: old.id,
        threadId: null,
        itemId: null,
        requestId: null,
        issue: null,
        pr: null,
        automationRunId: null,
        createdAt: at,
        updatedAt: at,
        resolvedAt: null,
        resolution: null,
      }),
    );
    const openItem = inbox.get(item.id);
    const workId = await h.startFakeSession("Still tracked");
    sessionRepo.update(workId, (session) => ({ ...session, status: "running" }));
    const target = { target: "pm" as const, projectId: h.projectId, sessionId: old.id };
    const wake = orchestration.reminders.schedule(
      target,
      new Date(Date.now() + 60_000),
      "Follow up",
    );

    sessionRepo.update(old.id, (session) => ({ ...session, status: "running" }));
    expect(await rotate(old.id)).toMatchObject({
      status: 409,
      body: { error: { code: "turn_running" } },
    });
    sessionRepo.update(old.id, (session) => ({ ...session, status: "idle" }));
    const question = inbox.put({ ...item, id: "test-question", kind: "question" });
    expect(await rotate(old.id)).toMatchObject({
      status: 409,
      body: { error: { code: "question_open" } },
    });
    inbox.close(question, "resolved", null);

    projects.update(h.projectId, { defaultProvider: "fake" });
    settings.update({ providers: { pm: { provider: "missing-provider" } } });
    expect(await rotate(old.id)).toMatchObject({
      status: 400,
      body: { error: { code: "unknown_provider" } },
    });
    expect((await h.detail(old.id)).session.archivedAt).toBeNull();
    expect((await h.api("GET", path)).body).toMatchObject({ session: { id: old.id } });

    settings.update({ providers: { pm: { provider: "fake", model: "fake-2" } } });
    const results = await Promise.all([rotate(old.id), rotate(old.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const fresh = Session.parse(results.find((r) => r.status === 200)?.body);
    expect(fresh).toMatchObject({
      role: "pm",
      workKey: old.workKey,
      provider: "fake",
      model: "fake-2",
    });
    expect(fresh.id).not.toBe(old.id);
    expect(await transcript(await idle(fresh.id))).toEqual([]);
    expect(await transcript(old)).toEqual(past);
    expect((await h.detail(old.id)).session.archivedAt).not.toBeNull();
    expect(
      (await h.api("POST", `/sessions/${old.id}/messages`, { input: { text: "stale" } })).status,
    ).toBe(409);
    expect((await h.api("POST", `/sessions/${old.id}/unarchive`)).status).toBe(409);
    expect((await h.api("PATCH", `/sessions/${old.id}`, { title: "stale" })).status).toBe(409);
    const oldToken = mcpTokens.mint({ role: "pm", projectId: h.projectId, sessionId: old.id });
    expect(mcpTokens.verify(oldToken)).toBeUndefined();
    mcpTokens.revoke(oldToken);

    const snapshot = Snapshot.parse((await h.api("GET", "/snapshot")).body);
    expect(snapshot.roleSessions?.pms[h.projectId]).toBe(fresh.id);
    expect(snapshot.archivedSessionCounts[h.projectId]).toBe(1);
    const archives = ArchivedSessionsPage.parse(
      (await h.api("GET", `/projects/${h.projectId}/sessions/archived`)).body,
    );
    expect(archives.sessions.map((session) => session.id)).toEqual([old.id]);
    expect(orchestration.notes.read(h.projectId)).toBe("Keep this note.\n");
    expect(inbox.get(item.id)).toEqual(openItem);
    expect(orchestration.projectStatus(h.projectId).running.map((work) => work.id)).toContain(
      workId,
    );
    expect(orchestration.reminders.pending("pm", h.projectId).map((notice) => notice.id)).toContain(
      wake.id,
    );
    orchestration.reminders.cancel("pm", h.projectId, wake.id);
    orchestration.reminders.schedule(target, new Date(Date.now() + 100), "Wake the replacement PM");
    const replacement = await idle(fresh.id, true);
    expect(await transcript(replacement)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            kind: "user_message",
            input: expect.objectContaining({
              text: expect.stringContaining("Wake the replacement PM"),
            }),
          }),
        }),
      ]),
    );
    expect(await transcript(old)).toEqual(past);
  });

  it("rotates the orchestrator and lists its archive without a project", async () => {
    const path = "/orchestration/orchestrator";
    const old = await seed("orchestrator", path);
    const response = await rotate(old.id);
    expect(response.status).toBe(200);
    const fresh = Session.parse(response.body);
    expect(fresh).toMatchObject({ role: "orchestrator", projectId: null, workKey: old.workKey });
    expect(fresh.id).not.toBe(old.id);
    expect(await transcript(await idle(fresh.id))).toEqual([]);
    const archives = ArchivedSessionsPage.parse((await h.api("GET", `${path}/archived`)).body);
    expect(archives.sessions.map((session) => session.id)).toEqual([old.id]);
    const snapshot = Snapshot.parse((await h.api("GET", "/snapshot")).body);
    expect(snapshot.roleSessions?.orchestrator).toBe(fresh.id);
  });
});
