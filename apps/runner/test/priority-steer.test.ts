import { tmpdir } from "node:os";
import type { AgentEvent } from "@codeden/contracts";
import { FakeProvider, ProviderRegistry } from "@codeden/providers";
import { afterEach, expect, it, vi } from "vitest";
import { canInterruptShell } from "../src/priority-steer";
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
