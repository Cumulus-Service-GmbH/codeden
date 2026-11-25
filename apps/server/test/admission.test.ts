import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiContext, createApi } from "../src/routes/api";
import { sessionRoutes } from "../src/routes/sessions";
import type { AppServices } from "../src/services/container";
import { SessionAdmission } from "../src/services/sessions/admission";
import { SettingsStore } from "../src/settings-store";
import { createGithubEnv } from "./support/github-env";

let env: ReturnType<typeof createGithubEnv>;

beforeEach(() => {
  env = createGithubEnv();
});

afterEach(async () => {
  vi.useRealTimers();
  await env.close();
});

function admission(projects = 0) {
  return new SessionAdmission(
    env.repo,
    () => 1,
    () => projects,
  );
}

describe("session admission", () => {
  it("runs a selected waiter next without skipping the slot limit", () => {
    const slots = admission();
    const first = env.addSession({ status: "queued" });
    const next = env.addSession({ status: "idle" });
    const last = env.addSession({ status: "queued" });
    expect(slots.tryReserve("active", "agent")).toBe(true);
    slots.enqueue(first.id);
    slots.enqueue(next.id);
    expect(slots.runNext(next.id)).toBe(true);
    slots.enqueue(last.id);
    expect(
      admission()
        .waiters()
        .map(({ id }) => id),
    ).toEqual([next.id, first.id, last.id]);
    expect(slots.tryReserve(next.id, "agent", true)).toBe(false);
    expect(slots.runNext("missing")).toBe(false);
  });

  it("returns the new queue order from the Run next route", async () => {
    const slots = admission();
    const first = env.addSession({ status: "queued" });
    const next = env.addSession({ status: "queued" });
    slots.enqueue(first.id);
    slots.enqueue(next.id);
    const api = sessionRoutes({ admission: slots } as AppServices, "test");
    const response = await api.request(`/${next.id}/admission/run-next`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      waiting: [
        { sessionId: next.id, place: 1 },
        { sessionId: first.id, place: 2 },
      ],
    });
  });

  it("counts active sessions and reservations as a union, and frees released slots", () => {
    const slots = admission();
    const { id } = env.addSession({ status: "idle" });
    expect(slots.tryReserve(id, "agent")).toBe(true);
    env.repo.update(id, (s) => ({ ...s, status: "running" }));
    expect(slots.status().active).toBe(1);
    expect(slots.free(id)).toBe(1);
    expect(slots.tryReserve("next", "agent")).toBe(false);
    slots.release(id);
    env.repo.update(id, (s) => ({ ...s, status: "idle" }));
    expect(slots.free()).toBe(1);
    expect(slots.tryReserve("next", "agent")).toBe(true);
  });

  it("counts an idle session's running checks as one slot", () => {
    const { id } = env.addSession({ status: "idle" });
    const checking = new Set([id]);
    const slots = new SessionAdmission(
      env.repo,
      () => 1,
      () => 0,
      undefined,
      () => checking,
    );
    expect(slots.tryReserve("next", "agent")).toBe(false);
    expect(slots.status().active).toBe(1);
    expect(slots.tryReserve(id, "agent")).toBe(true);
    checking.clear();
    expect(slots.tryReserve("next", "agent")).toBe(false);
    slots.release(id);
    expect(slots.tryReserve("next", "agent")).toBe(true);
  });

  it("exempts one control session plus one per non-archived project", () => {
    const slots = admission(1);
    expect(slots.tryReserve("agent", "agent")).toBe(true);
    expect(slots.tryReserve("pm", "pm")).toBe(true);
    expect(slots.tryReserve("orchestrator", "orchestrator")).toBe(true);
    expect(slots.tryReserve("extra", "pm")).toBe(false);
    expect(slots.status()).toMatchObject({ active: 1, control: 2 });
    slots.release("agent");
    expect(slots.tryReserve("extra", "pm")).toBe(true);
    expect(slots.status()).toMatchObject({ active: 1, control: 3 });
  });

  it("leaves room for new work beyond the slots owed to existing waiters", () => {
    const slots = new SessionAdmission(
      env.repo,
      () => 2,
      () => 0,
    );
    const waiter = env.addSession({ status: "idle" });
    slots.enqueue(waiter.id);
    expect(slots.tryReserve("new", "agent")).toBe(true);
    expect(slots.tryReserve("later", "agent")).toBe(false);
    expect(slots.tryReserve(waiter.id, "agent", true)).toBe(true);
  });

  it("persists FIFO order at tied timestamps and leaves capacity for waiters", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const slots = admission();
    const first = env.addSession({ id: "z", status: "queued" });
    const second = env.addSession({ id: "a", status: "idle" });
    slots.enqueue(first.id);
    slots.enqueue(second.id);
    slots.enqueue(first.id);

    const restarted = admission();
    expect(restarted.status().waiting).toEqual([
      { sessionId: "z", kind: "start", place: 1, since: new Date().toISOString() },
      { sessionId: "a", kind: "turn", place: 2, since: new Date().toISOString() },
    ]);
    expect(restarted.free()).toBe(0);
    expect(restarted.tryReserve("new", "agent")).toBe(false);
    expect(restarted.tryReserve(first.id, "agent", true)).toBe(true);
    restarted.dequeue(first.id);
    restarted.release(first.id);
    expect(restarted.tryReserve(second.id, "agent", true)).toBe(true);
    restarted.dequeue(second.id);
    restarted.release(second.id);
    expect(restarted.free()).toBe(1);
  });
});

it("PATCH /api/settings persists the session limit and remembered Team setup", async () => {
  const settings = new SettingsStore(join(env.dir, "settings.json"));
  const api = createApi({
    services: {
      settings,
      store: env.store,
      orchestration: { roles: { applyProviderSettings: vi.fn() } },
    },
    network: {},
  } as unknown as ApiContext);
  const patch = {
    limits: { maxActiveSessions: 3 },
    teamSetup: { remembered: true, resultSummaryBytes: 256 },
  };
  const response = await api.request("/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject(patch);
  const saved = await api.request("/settings");
  expect(await saved.json()).toMatchObject(patch);
});
