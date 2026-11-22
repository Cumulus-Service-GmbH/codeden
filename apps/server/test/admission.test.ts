import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionAdmission } from "../src/services/sessions/admission";
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
  it("counts active sessions, reservations and holds as a union, and frees released slots", () => {
    const slots = admission();
    const { id } = env.addSession({ status: "idle" });
    expect(slots.tryReserve(id, "agent")).toBe(true);
    env.repo.update(id, (s) => ({ ...s, status: "running" }));
    slots.hold(id);
    expect(slots.status().active).toBe(1);
    expect(slots.tryReserve("next", "agent")).toBe(false);
    slots.release(id);
    env.repo.update(id, (s) => ({ ...s, status: "idle" }));
    expect(slots.free()).toBe(0);
    slots.unhold(id);
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
    slots.hold(id);
    expect(slots.status().active).toBe(1);
    slots.unhold(id);
    checking.clear();
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
