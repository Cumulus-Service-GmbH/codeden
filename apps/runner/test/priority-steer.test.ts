import { tmpdir } from "node:os";
import type { AgentEvent, ToolCallItem } from "@codeden/contracts";
import { AsyncQueue, FakeProvider, ProviderRegistry } from "@codeden/providers";
import { afterEach, expect, it, vi } from "vitest";
import { ActiveTools, canInterruptShell } from "../src/priority-steer";
import { SessionHost } from "../src/session-host";

let host: SessionHost | undefined;
afterEach(async () => {
  const closing = host?.closeAll();
  if (closing) await vi.runAllTimersAsync();
  await closing;
  host = undefined;
  vi.useRealTimers();
});

it.each([
  ["sleep 600", true],
  ["sleep 600 && git status", false],
  ["git status", false],
  ["pnpm install", false],
  ["sed -i s/a/b/ file", false],
  ["sleep 600 > file", false],
  ["sh -c 'sleep 600; npm install'", false],
])("classifies %s", (command, allowed) => {
  expect(canInterruptShell(command)).toBe(allowed);
});

it("never interrupts an edit, git or install command", () => {
  const call = { itemId: "protected", threadId: "thread", turnId: "turn" };
  const base = { kind: "tool_call", id: call.itemId, status: "in_progress" } as const;
  const protectedTools: ToolCallItem[] = [
    { ...base, toolKind: "file_edit", toolName: "edit", changes: [] },
    ...["git status", "pnpm install", "sed -i s/a/b/ file"].map((command) => ({
      ...base,
      toolKind: "command" as const,
      toolName: "shell",
      command,
    })),
  ];
  for (const item of protectedTools) {
    const active = new ActiveTools();
    active.track({ type: "item.started", threadId: call.threadId, turnId: call.turnId, item });
    expect(active.canInterrupt(call)).toBe(false);
    if (item.toolKind === "command") expect(active.shell()).toEqual(call);
    const wait = { ...item, toolKind: "command" as const, command: "sleep 600" };
    active.track({
      type: "item.started",
      threadId: call.threadId,
      turnId: call.turnId,
      item: wait,
    });
    expect(active.canInterrupt(call)).toBe(true);
  }
});

it("drops unfinished child tools when their root turn ends", async () => {
  vi.useFakeTimers({ toFake: ["setImmediate"] });
  const fake = new FakeProvider();
  const stream = new AsyncQueue<AgentEvent>();
  const steer = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(fake, "openSession").mockImplementation(async (options) => {
    const session = await new FakeProvider().openSession(options);
    return Object.assign(session, { events: stream, steer, close: async () => stream.close() });
  });
  host = new SessionHost(new ProviderRegistry([fake]), () => {});
  const starting = host.start({
    name: "session.start",
    sessionId: "s",
    providerId: "fake",
    checkpoints: false,
    options: {
      sessionId: "s",
      role: "agent",
      cwd: tmpdir(),
      autonomy: "auto",
      mcpServers: [],
      additionalDirectories: [],
      planMode: false,
    },
  });
  await vi.runAllTimersAsync();
  await starting;

  stream.push({ type: "thread.started", thread: { id: "root" } });
  stream.push({ type: "turn.started", threadId: "root", turnId: "first" });
  stream.push({
    type: "item.started",
    threadId: "child",
    turnId: "child-turn",
    item: {
      id: "tool",
      kind: "tool_call",
      toolKind: "command",
      toolName: "shell",
      command: "sleep 600",
      status: "in_progress",
    },
  });
  const cmd = {
    name: "session.steer" as const,
    sessionId: "s",
    waitForShell: true as const,
    input: { text: "priority", attachments: [] },
  };
  await vi.runAllTimersAsync();
  const before = host.steer(cmd);
  await expect(before).resolves.toMatchObject({ waitingFor: { itemId: "tool" } });

  stream.push({ type: "turn.interrupted", threadId: "root", turnId: "first", reason: "provider" });
  stream.push({ type: "turn.started", threadId: "root", turnId: "second" });
  await vi.runAllTimersAsync();
  const after = host.steer(cmd);
  await expect(after).resolves.toEqual({});
  expect(steer).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "waits for the shell and only interrupts with capability %s",
  async (capable) => {
    vi.useFakeTimers({ toFake: ["Date", "setImmediate", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const shell = Promise.withResolvers<void>();
    const fake = new FakeProvider({ holdShell: shell.promise });
    const caps = fake.capabilities();
    vi.spyOn(fake, "capabilities").mockReturnValue({ ...caps, interruptToolCall: capable });
    const events: AgentEvent[] = [];
    const finished = Promise.withResolvers<void>();
    host = new SessionHost(new ProviderRegistry([fake]), (event) => {
      if (event.kind !== "agent") return;
      events.push(event.event);
      const { event: itemEvent } = event;
      if (itemEvent.type === "item.completed" && itemEvent.item.kind === "tool_call") {
        finished.resolve();
      }
    });
    const starting = host.start({
      name: "session.start",
      sessionId: "s1",
      providerId: "fake",
      checkpoints: false,
      options: {
        sessionId: "s1",
        role: "agent",
        cwd: tmpdir(),
        autonomy: "auto",
        mcpServers: [],
        additionalDirectories: [],
        planMode: false,
      },
    });
    await vi.runAllTimersAsync();
    await starting;
    await host.send({
      name: "session.send",
      sessionId: "s1",
      input: { text: "wait", attachments: [] },
    });
    await vi.runAllTimersAsync();
    const cmd = {
      name: "session.steer" as const,
      sessionId: "s1",
      waitForShell: true as const,
      input: { text: "priority", attachments: [] },
    };
    const waiting = await host.steer(cmd);
    expect(waiting).toMatchObject({ waitingFor: { itemId: expect.any(String) } });
    expect(
      events.some(
        (e) =>
          e.type === "item.completed" &&
          e.item.kind === "user_message" &&
          e.item.input.text === "priority",
      ),
    ).toBe(false);

    vi.setSystemTime(Date.now() + 120_000);
    await host.steer({ ...cmd, interrupt: waiting.waitingFor });
    if (!capable) {
      expect(
        events.some((event) => event.type === "item.completed" && event.item.kind === "tool_call"),
      ).toBe(false);
      shell.resolve();
    }
    await finished.promise;
    await expect(
      host.steer({ ...cmd, expectedTurnId: waiting.waitingFor?.rootTurnId }),
    ).resolves.toEqual({});
    await vi.runAllTimersAsync();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        turnId: waiting.waitingFor?.rootTurnId,
        item: expect.objectContaining({ kind: "user_message", input: cmd.input }),
      }),
    );
    expect(
      events.some(
        (e) =>
          e.type === "item.completed" &&
          e.item.kind === "tool_call" &&
          e.item.toolKind === "command" &&
          e.item.status === "cancelled",
      ),
    ).toBe(capable);
    expect(events.some((e) => e.type === "turn.interrupted")).toBe(false);
  },
);
