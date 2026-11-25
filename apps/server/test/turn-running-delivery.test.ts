import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings, type UserInput } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { ToolRegistry } from "../src/mcp/registry";
import { messageSession } from "../src/mcp/tools/pm/sessions";
import { RunnerCommandError } from "../src/runner/client";
import type { AppServices } from "../src/services/container";
import { LoopGuard } from "../src/services/orchestration/loop-guard";
import { WakeScheduler } from "../src/services/orchestration/wake-scheduler";
import type { RunnerPort } from "../src/services/runner-port";
import { mayHaveStarted } from "../src/services/sessions/input-decorator";
import type { SessionLauncher } from "../src/services/sessions/launcher";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

/**
 * Issue #96: a message delivered while a turn runs must be queued (or steered), never sent as a
 * second turn, keep its place in arrival order, and the provider's "A turn is already running"
 * must never fail the session. The factory side is in `factory-turn-race.test.ts`.
 */

let dir: string;
let database: Database;
let store: EventStore;
let repo: SessionRepo;
let outbox: Outbox;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-turn-running-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  store.append([{ type: "session.created", sessionId: "s1", payload: { session: sampleSession } }]);
  repo = new SessionRepo(database.db, store);
  outbox = new Outbox(database.db, store);
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

const input = (text: string): UserInput => ({ text, attachments: [] });
const texts = () => outbox.list("s1").map((m) => m.input.text);
/** Let pending `setImmediate` work (a scheduled queue flush) and its promises run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const submission = {
  input: input("priority"),
  whenBusy: "steer" as const,
  submissionId: "aca17489-09fa-4cef-9be5-48109d31dbd0",
};

/**
 * A session service over the real repo and outbox, with a runner that behaves like a provider
 * session: one turn at a time, and `session.send` during a turn fails the way runners before
 * the `turn_running` code reported it (`command_failed`, "A turn is already running").
 */
function providerLike(
  opts: {
    turnRunning?: boolean;
    steer?: boolean;
    interruptToolCall?: boolean;
    interruptMinutes?: number;
  } = {},
) {
  repo.update("s1", (s) => ({ ...s, status: "idle" }));
  const state = { turn: opts.turnRunning ?? false, connected: true };
  const sent: string[] = [];
  const request = vi.fn(async (command: { name: string; input?: UserInput }) => {
    if (!state.connected) throw new RunnerCommandError("runner_unavailable", "Runner disconnected");
    if (command.name !== "session.send") return {};
    if (state.turn) throw new RunnerCommandError("command_failed", "A turn is already running");
    state.turn = true;
    sent.push(command.input?.text ?? "");
    return {};
  });
  const runner = {
    isConnected: () => state.connected,
    providers: () =>
      opts.steer
        ? [{ id: "fake", capabilities: { steer: true, interruptToolCall: opts.interruptToolCall } }]
        : [],
    request,
  } as unknown as RunnerPort;
  // Like the real launcher: a failure marks the session failed.
  const launcher = {
    fail: vi.fn((id: string) => repo.update(id, (s) => ({ ...s, status: "failed" }))),
    resume: vi.fn(),
  };
  const sessions = new SessionService({
    repo,
    runner,
    outbox,
    launcher: launcher as unknown as SessionLauncher,
    artifacts: {
      externalizeAttachments: (i: UserInput) => i,
      resolveAttachments: (i: UserInput) => i,
    },
    settings: {
      get: () => Settings.parse({ priorityInterruptMinutes: opts.interruptMinutes }),
    },
    outboxRetryMs: 1_000,
  } as unknown as SessionServiceDeps);
  /** The provider ends its turn; the server sees the session go idle and drains its queue. */
  const endTurn = async () => {
    state.turn = false;
    repo.update("s1", (s) => (s.status === "running" ? { ...s, status: "idle" } : s));
    await sessions.flushOutbox("s1");
  };
  return { sessions, launcher, sent, state, request, endTurn };
}

it("acknowledges default PM delivery without waiting on a busy provider", async () => {
  const { sessions, request, endTurn, sent } = providerLike({ steer: true, turnRunning: true });
  repo.update("s1", (s) => ({ ...s, status: "running", projectId: "project" }));
  request.mockResolvedValueOnce({
    waitingFor: { itemId: "sleep", turnId: "turn", threadId: "thread", rootTurnId: "turn" },
  });
  const tools = new ToolRegistry([messageSession], { sessions, sessionRepo: repo } as AppServices);
  const sending = tools.call(
    "message_session",
    { sessionId: "s1", text: "PM follow-up" },
    {
      role: "pm",
      caller: "mcp",
      sessionId: "pm",
      projectId: "project",
      signal: new AbortController().signal,
    },
  );
  try {
    const result = await Promise.race([sending, settle().then(() => "still waiting")]);
    expect(result).toMatchObject({ text: "Message queued.", isError: false });
    expect(request).not.toHaveBeenCalled();
    expect(outbox.list("s1")).toMatchObject([
      { from: "pm", input: { text: "Message from your project manager:\nPM follow-up" } },
    ]);
    request.mockReset().mockImplementation(async ({ input }) => {
      sent.push(input?.text ?? "");
      return {};
    });
    await endTurn();
    expect(sent).toEqual(["Message from your project manager:\nPM follow-up"]);
    expect(outbox.list("s1")).toEqual([]);
  } finally {
    sessions.suspendPriorityDelivery();
    await sending;
  }
});

it.each([
  {
    name: "interrupts only the running shell call after the configured delay",
    minutes: 3,
    delay: 180_000,
  },
  {
    name: "interrupts the running shell call after two minutes by default",
    minutes: undefined,
    delay: 120_000,
  },
  {
    name: "never interrupts when the provider cannot stop just the tool call",
    minutes: 3,
    delay: 180_000,
    incapable: true,
  },
])("$name", async ({ minutes, delay, incapable }) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
  const { sessions, request } = providerLike({
    steer: true,
    interruptToolCall: !incapable,
    interruptMinutes: minutes,
  });
  repo.update("s1", (s) => ({ ...s, status: "running" }));
  const shell = { itemId: "sleep", turnId: "turn", threadId: "thread", rootTurnId: "turn" };
  request.mockResolvedValueOnce({ waitingFor: shell });
  const steer = {
    name: "session.steer",
    sessionId: "s1",
    input: input("priority"),
    revision: 0,
    waitForShell: true,
  };
  const sending = sessions.send("s1", { input: steer.input, whenBusy: "steer" });
  try {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(request.mock.calls).toEqual([[steer]]);
    await vi.advanceTimersByTimeAsync(1);
    if (incapable) {
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(request.mock.calls).toEqual([[steer]]);
      sessions.suspendPriorityDelivery();
      await expect(sending).resolves.toEqual({ status: "queued" });
    } else {
      expect(request.mock.calls).toEqual([
        [steer],
        [{ ...steer, expectedTurnId: shell.rootTurnId, interrupt: shell }],
      ]);
      await expect(sending).resolves.toEqual({ status: "steered" });
    }
  } finally {
    sessions.suspendPriorityDelivery();
    await sending.catch(() => {});
    vi.useRealTimers();
  }
});

it("persists a composer priority message while waiting, until Stop drops it", async () => {
  const { sessions, request } = providerLike({ steer: true });
  repo.update("s1", (s) => ({ ...s, status: "running" }));
  request.mockResolvedValueOnce({
    waitingFor: { itemId: "sleep", turnId: "turn", threadId: "thread", rootTurnId: "turn" },
  });
  const result = sessions
    .send("s1", { input: input("priority"), whenBusy: "steer" })
    .catch((error: unknown) => error);
  await settle();
  const reopened = openDatabase(join(dir, "codeden.db"));
  try {
    expect(new Outbox(reopened.db, new EventStore(reopened.db)).peek("s1")?.input.text).toBe(
      "priority",
    );
  } finally {
    reopened.close();
    await sessions.interrupt("s1");
    expect(await result).toMatchObject({ code: "priority_cancelled" });
  }
  expect(texts()).toEqual([]);
});

it("keeps waiting priority messages when the server shuts down", async () => {
  const { sessions, request } = providerLike({ steer: true });
  repo.update("s1", (s) => ({ ...s, status: "running" }));
  request.mockResolvedValueOnce({
    waitingFor: { itemId: "sleep", turnId: "turn", threadId: "thread", rootTurnId: "turn" },
  });
  const sending = sessions.send("s1", { input: input("priority"), whenBusy: "steer" });
  await settle();
  sessions.suspendPriorityDelivery();
  await expect(sending).resolves.toEqual({ status: "queued" });
  expect(texts()).toEqual(["priority"]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("deduplicates a retried submission after the first HTTP response was lost", async () => {
  const { sessions, request } = providerLike({ steer: true });
  repo.update("s1", (s) => ({ ...s, status: "running" }));

  // This request reached the server and provider, but its caller did not get the reply.
  await sessions.send("s1", submission);
  const restarted = providerLike({ steer: true });
  await expect(restarted.sessions.send("s1", submission)).resolves.toEqual({ status: "sent" });
  expect(request.mock.calls.map(([command]) => command.name)).toEqual(["session.steer"]);
  expect(restarted.request).not.toHaveBeenCalled();

  // A submission with no recorded attempt can still be sent normally.
  await expect(
    restarted.sessions.send("s1", {
      ...submission,
      submissionId: "5d191764-5124-4bf3-ada6-6fe935e839f2",
    }),
  ).resolves.toEqual({ status: "sent" });
  expect(restarted.sent).toEqual(["priority"]);
});

it("keeps a timed-out steer visible without replaying it when the turn settles", async () => {
  const { sessions, request, endTurn, sent } = providerLike({ steer: true });
  repo.update("s1", (s) => ({ ...s, status: "running" }));
  request.mockRejectedValueOnce(new RunnerCommandError("timeout", "Reply was lost"));

  await expect(sessions.send("s1", submission)).resolves.toEqual({ status: "queued" });
  const reopened = openDatabase(join(dir, "codeden.db"));
  try {
    const recovered = new Outbox(reopened.db, new EventStore(reopened.db));
    expect(recovered.list("s1")).toMatchObject([
      { input: { text: "priority" }, delivery: "uncertain" },
    ]);
  } finally {
    reopened.close();
  }
  await endTurn();
  await expect(sessions.send("s1", submission)).resolves.toEqual({ status: "queued" });
  expect(sent).toEqual([]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("queues an unsent tracked submission and delivers it when the runner reconnects", async () => {
  const { sessions, request, sent, state } = providerLike();
  state.connected = false;
  await expect(sessions.send("s1", submission)).resolves.toEqual({ status: "queued" });
  expect(request).not.toHaveBeenCalled();
  expect(outbox.list("s1")[0]?.delivery).toBeUndefined();

  state.connected = true;
  sessions.releaseOutboxes();
  await sessions.flushOutbox("s1");
  await expect(sessions.send("s1", submission)).resolves.toEqual({ status: "sent" });
  expect(sent).toEqual(["priority"]);
});

it("keeps a tracked message retryable if worktree recovery fails before sending", async () => {
  const { sessions, launcher, request } = providerLike();
  repo.update("s1", (s) => ({ ...s, worktreeRemovedAt: new Date().toISOString() }));
  launcher.resume.mockRejectedValueOnce(
    new RunnerCommandError("runner_unavailable", "Disconnected during setup"),
  );
  await expect(sessions.send("s1", submission)).resolves.toEqual({ status: "queued" });
  expect(request).not.toHaveBeenCalled();
  expect(outbox.list("s1")[0]?.delivery).toBeUndefined();
});

it("acknowledges an ambiguous reject submission without replaying it", async () => {
  const { sessions, request, endTurn } = providerLike();
  request.mockRejectedValueOnce(new RunnerCommandError("timeout", "Reply was lost"));
  const rejecting = { ...submission, whenBusy: "reject" as const };
  await expect(sessions.send("s1", rejecting)).resolves.toEqual({ status: "queued" });
  await endTurn();
  expect(outbox.list("s1")[0]?.delivery).toBe("uncertain");
  expect(request).toHaveBeenCalledTimes(1);
});

it("retains a queued tracked submission if its first flush finds a disconnected runner", async () => {
  const { sessions, request, sent, state, endTurn } = providerLike();
  repo.update("s1", (s) => ({ ...s, status: "running" }));
  await sessions.send("s1", { ...submission, whenBusy: "queue" });
  state.connected = false;
  await endTurn();
  expect(request).not.toHaveBeenCalled();
  expect(outbox.list("s1")[0]?.delivery).toBeUndefined();
  expect(texts()).toEqual(["priority"]);

  state.connected = true;
  sessions.releaseOutboxes();
  await sessions.flushOutbox("s1");
  expect(sent).toEqual(["priority"]);
  expect(texts()).toEqual([]);
});

it("refuses an unsent tracked request with reject semantics and leaves its ID reusable", async () => {
  const { sessions, request, sent, state } = providerLike();
  state.connected = false;
  const rejecting = { ...submission, whenBusy: "reject" as const };
  await expect(sessions.send("s1", rejecting)).rejects.toMatchObject({
    code: "runner_unavailable",
  });
  expect(request).not.toHaveBeenCalled();
  expect(texts()).toEqual([]);

  state.connected = true;
  await expect(sessions.send("s1", rejecting)).resolves.toEqual({ status: "sent" });
  expect(sent).toEqual(["priority"]);
});

it.each(["unknown_session", "config_unconfirmed"])(
  "does not retain a steer refused before delivery with %s",
  async (code) => {
    const { sessions, request } = providerLike({ steer: true });
    repo.update("s1", (s) => ({ ...s, status: "running" }));
    request.mockRejectedValueOnce(new RunnerCommandError(code, "Refused before send"));
    await expect(sessions.steer("s1", submission.input)).rejects.toMatchObject({ code });
    expect(texts()).toEqual([]);
  },
);

it("rejects a new steer once shutdown suspends priority delivery", async () => {
  const { sessions, request } = providerLike({ steer: true });
  repo.update("s1", (s) => ({ ...s, status: "running" }));
  sessions.suspendPriorityDelivery();
  await expect(sessions.steer("s1", input("late"))).rejects.toMatchObject({
    code: "priority_suspended",
  });
  expect(request).not.toHaveBeenCalled();
  expect(texts()).toEqual([]);
});

it("returns the shutdown error when the first steer is still awaiting its reply", async () => {
  const { sessions, request } = providerLike({ steer: true });
  repo.update("s1", (s) => ({ ...s, status: "running" }));
  const reply = Promise.withResolvers<Record<string, unknown>>();
  request.mockImplementationOnce(() => reply.promise);
  const steering = sessions.send("s1", { input: input("interrupted"), whenBusy: "steer" });
  await settle();
  expect(request).toHaveBeenCalledTimes(1);
  sessions.suspendPriorityDelivery();
  reply.resolve({
    waitingFor: { itemId: "sleep", turnId: "turn", threadId: "thread", rootTurnId: "turn" },
  });
  await expect(steering).rejects.toMatchObject({ code: "priority_suspended" });
  expect(texts()).toEqual([]);
});

it("keeps a waiting steer ahead of messages queued during its first request", async () => {
  const { sessions, request } = providerLike({ steer: true });
  repo.update("s1", (s) => ({ ...s, status: "running" }));
  const reply = Promise.withResolvers<Record<string, unknown>>();
  request.mockImplementationOnce(() => reply.promise);
  const steering = sessions.steer("s1", input("first"));
  try {
    await settle();
    await sessions.send("s1", { input: input("second"), whenBusy: "queue" });
    reply.resolve({
      waitingFor: { itemId: "sleep", turnId: "turn", threadId: "thread", rootTurnId: "turn" },
    });
    await settle();
    expect(texts()).toEqual(["first", "second"]);
  } finally {
    sessions.suspendPriorityDelivery();
    await steering;
  }
});

it("safely queues a waiting steer if the runner disconnects before the next attempt", async () => {
  const { sessions, request, sent, endTurn, state } = providerLike({
    steer: true,
    turnRunning: true,
  });
  repo.update("s1", (s) => ({ ...s, status: "running" }));
  request.mockResolvedValueOnce({
    waitingFor: { itemId: "sleep", turnId: "turn", threadId: "thread", rootTurnId: "turn" },
  });
  const sending = sessions.send("s1", { input: input("priority"), whenBusy: "steer" });
  await settle();
  state.connected = false;
  store.append([
    {
      type: "runner.disconnected",
      sessionId: null,
      payload: { id: "local", runnerId: "runner", reason: "connection closed" },
    },
  ]);
  await expect(sending).resolves.toEqual({ status: "queued" });
  expect(texts()).toEqual(["priority"]);
  expect(outbox.list("s1")[0]?.delivery).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  state.connected = true;
  await endTurn();
  expect(sent).toEqual(["priority"]);
  expect(texts()).toEqual([]);
});

it("retries a waiting steer when the shell completes in the event store", async () => {
  const { sessions, request } = providerLike({ steer: true });
  repo.update("s1", (s) => ({ ...s, status: "running" }));
  const shell = { itemId: "sleep", turnId: "turn", threadId: "thread", rootTurnId: "turn" };
  request.mockResolvedValueOnce({ waitingFor: shell });
  const sending = sessions.send("s1", { input: input("priority"), whenBusy: "steer" });
  try {
    await settle();
    store.append([
      {
        type: "agent.item.completed",
        sessionId: "s1",
        payload: {
          type: "item.completed",
          threadId: shell.threadId,
          turnId: shell.turnId,
          item: {
            id: shell.itemId,
            kind: "tool_call",
            toolKind: "command",
            toolName: "shell",
            command: "sleep 600",
            status: "completed",
          },
        },
      },
    ]);
    await expect(Promise.race([sending, settle().then(() => "still waiting")])).resolves.toEqual({
      status: "steered",
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      name: "session.steer",
      expectedTurnId: shell.rootTurnId,
    });
    expect(texts()).toEqual([]);
  } finally {
    sessions.suspendPriorityDelivery();
    await sending;
  }
});

describe("deliveries racing a running turn (#96)", () => {
  it("queues the second of two deliveries racing an idle session, and delivers both in order", async () => {
    const { sessions, launcher, sent, endTurn } = providerLike();
    // A factory revise message and a PM message arrive in the same moment.
    const results = await Promise.allSettled([
      sessions.send("s1", { input: input("revise"), whenBusy: "queue" }, "factory"),
      sessions.send("s1", { input: input("pm note"), whenBusy: "queue" }, "pm"),
    ]);
    expect(results).toEqual([
      { status: "fulfilled", value: { status: "sent" } },
      { status: "fulfilled", value: { status: "queued" } },
    ]);
    // The first message's turn is running; nothing reverted it to idle.
    expect(repo.get("s1").status).toBe("running");
    await endTurn();
    expect(sent).toEqual(["revise", "pm note"]);
    expect(launcher.fail).not.toHaveBeenCalled();
  });

  it("never fails the session when a queued-message flush races a send", async () => {
    const { sessions, launcher, sent, endTurn } = providerLike();
    outbox.push("s1", input("queued earlier"), "pm");
    // The session just went idle (flush scheduled) as the factory sends its next message.
    await Promise.allSettled([
      sessions.send("s1", { input: input("revise"), whenBusy: "queue" }, "factory"),
      sessions.flushOutbox("s1"),
    ]);
    expect(launcher.fail).not.toHaveBeenCalled();
    expect(repo.get("s1").status).toBe("running");
    await endTurn();
    expect(sent).toEqual(["revise", "queued earlier"]);
  });

  it("treats the runner's 'turn already running' as retryable: the message waits for the turn", async () => {
    // The runner has a turn the server doesn't know about yet (it still shows idle).
    const { sessions, launcher, sent, endTurn } = providerLike({ turnRunning: true });
    outbox.push("s1", input("queued"), "pm");
    await sessions.flushOutbox("s1");
    expect(launcher.fail).not.toHaveBeenCalled();
    expect(repo.get("s1").status).not.toBe("failed");
    await expect(
      sessions.send("s1", { input: input("nudge"), whenBusy: "queue" }, "factory"),
    ).resolves.toEqual({ status: "queued" });
    expect(outbox.list("s1").map((m) => m.input.text)).toEqual(["queued", "nudge"]);

    await endTurn();
    await endTurn();
    expect(sent).toEqual(["queued", "nudge"]);
  });

  it("delivers right away when the turn that refused a message ended before the refusal was handled", async () => {
    const { sessions, launcher, sent, state, request } = providerLike({ turnRunning: true });
    // The refusal and the end of the turn reach the server together.
    request.mockImplementationOnce(async () => {
      state.turn = false;
      repo.update("s1", (s) => ({ ...s, status: "idle" }));
      throw new RunnerCommandError("turn_running", "A turn is already running");
    });
    await expect(
      sessions.send("s1", { input: input("late"), whenBusy: "queue" }, "pm"),
    ).resolves.toEqual({ status: "queued" });
    await settle();
    expect(sent).toEqual(["late"]);
    expect(launcher.fail).not.toHaveBeenCalled();
  });

  it("delivers what queued up when the turn ended before the runner's answer to a send", async () => {
    const { sessions, sent, state, request } = providerLike();
    let answer = () => {};
    request.mockImplementationOnce(async (command) => {
      state.turn = true;
      sent.push(command.input?.text ?? "");
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return {};
    });
    const first = sessions.send("s1", { input: input("first"), whenBusy: "queue" }, "factory");
    await settle();
    expect(sent).toEqual(["first"]);
    await expect(
      sessions.send("s1", { input: input("second"), whenBusy: "queue" }, "pm"),
    ).resolves.toEqual({ status: "queued" });
    // The turn ends before the runner's answer is handled: the flush its end triggers finds the
    // delivery still in flight.
    state.turn = false;
    repo.update("s1", (s) => ({ ...s, status: "idle" }));
    await sessions.flushOutbox("s1");
    expect(texts()).toEqual(["second"]);

    answer();
    await expect(first).resolves.toEqual({ status: "sent" });
    await settle();
    expect(sent).toEqual(["first", "second"]);
    expect(texts()).toEqual([]);
  });

  it("delivers what queued behind a PM's delivery when its turn ends before the answer (#137)", async () => {
    // The orchestration decorator's turn-origin tracking holds the delivery open until the
    // runner answers; the turn's end must not strand what queued meanwhile.
    repo.update("s1", (s) => ({ ...s, role: "pm", projectId: "p1" }));
    const { sessions, sent, state, request } = providerLike();
    const guard = new LoopGuard({
      wakes: new WakeScheduler(async () => "empty"),
      notices: { create: () => undefined, undelivered: () => [] },
      wakePm: async () => "empty",
    });
    sessions.setInputDecorator((session, raw, from) => {
      const turn = guard.beginTurn(session, from, raw);
      return {
        input: raw,
        delivered: () => turn.accepted(),
        failed: (error) => turn.failed(mayHaveStarted(error)),
      };
    });
    let answer = () => {};
    request.mockImplementationOnce(async (command) => {
      state.turn = true;
      sent.push(command.input?.text ?? "");
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return {};
    });
    const first = sessions.send("s1", { input: input("first"), whenBusy: "queue" }, "automation");
    await settle();
    await expect(
      sessions.send("s1", { input: input("second"), whenBusy: "queue" }, "user"),
    ).resolves.toEqual({ status: "queued" });
    // The turn completes before 'first' is acknowledged: the flush its end triggers skips.
    state.turn = false;
    repo.update("s1", (s) => ({ ...s, status: "idle" }));
    await sessions.flushOutbox("s1");
    expect(texts()).toEqual(["second"]);

    answer();
    await expect(first).resolves.toEqual({ status: "sent" });
    await settle();
    expect(sent).toEqual(["first", "second"]);
    expect(texts()).toEqual([]);
    // The turn running now is the user's.
    expect(guard.humanLed({ caller: "mcp", sessionId: "s1" })).toBe(true);
    guard.dispose();
  });

  it("keeps arrival order when a busy runner refuses a send while another message arrives", async () => {
    // The server still shows the session idle; the runner is in a turn.
    const { sessions, sent, request, endTurn } = providerLike({ turnRunning: true });
    let refuse = () => {};
    request.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        refuse = resolve;
      });
      throw new RunnerCommandError("turn_running", "A turn is already running");
    });
    const first = sessions.send("s1", { input: input("first"), whenBusy: "queue" }, "factory");
    await settle();
    await expect(
      sessions.send("s1", { input: input("second"), whenBusy: "queue" }, "pm"),
    ).resolves.toEqual({ status: "queued" });
    refuse();
    await expect(first).resolves.toEqual({ status: "queued" });
    expect(texts()).toEqual(["first", "second"]);

    await endTurn();
    await endTurn();
    expect(sent).toEqual(["first", "second"]);
  });

  it("answers a wake (`reject`) with 409 turn_running instead of failing", async () => {
    const { sessions, launcher } = providerLike({ turnRunning: true });
    await expect(
      sessions.send("s1", { input: input("wake"), whenBusy: "reject" }, "codeden"),
    ).rejects.toMatchObject({ status: 409, code: "turn_running" });
    expect(launcher.fail).not.toHaveBeenCalled();
    expect(outbox.count("s1")).toBe(0);
  });
});
