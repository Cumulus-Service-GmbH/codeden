import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { CodexRpc } from "../src/codex/rpc";
import { stopStdioChild } from "../src/util/exec";
import { readStdioLines, STDIO_LINE_LIMIT } from "../src/util/stdio-lines";

it("retries a timed-out stop even if closing stdin throws", async () => {
  vi.useFakeTimers();
  const end = vi.fn(() => {
    throw new Error("stdin already closed");
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 99,
    exitCode: null as number | null,
    signalCode: null,
    stdin: { end },
    kill: vi.fn(),
  });
  try {
    const stopping = stopStdioChild(child as unknown as ChildProcess);
    const first = expect(stopping).rejects.toThrow(
      "Child process 99 did not exit after termination",
    );
    // Keep the fixture out of platform-specific tree signaling.
    child.exitCode = 0;
    await Promise.all([vi.advanceTimersByTimeAsync(5000), first]);
    child.exitCode = null;
    const retry = stopStdioChild(child as unknown as ChildProcess);
    expect(retry).not.toBe(stopping);
    child.emit("exit");
    await retry;
    expect(end).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["line", "overflow"] as const)("stops scanning the current chunk on %s detach", (kind) => {
  const stdout = new PassThrough();
  const lines: string[] = [];
  const detach = readStdioLines(
    stdout,
    (line) => {
      lines.push(line);
      if (kind === "line") detach();
    },
    () => detach(),
  );
  const first = kind === "line" ? "first" : "x".repeat(STDIO_LINE_LIMIT + 1);
  stdout.end(Buffer.from(`${first}\nsecond\n`));
  expect(lines).toEqual(kind === "line" ? ["first"] : []);
});

it("rejects an oversized reply, warns once, and reaps the provider", async () => {
  const child = spawn(process.execPath, [
    "-e",
    `
    process.stdin.once("data", () => {
      process.stdout.write(Buffer.alloc(${STDIO_LINE_LIMIT + 1}, 0x61));
      process.stdout.write("\\n");
    });
  `,
  ]);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const onExit = vi.fn();
  const rpc = new CodexRpc(child, {
    onExit,
    onNotification: () => {},
    onRequest: async () => undefined,
  });
  try {
    await expect(rpc.request("thread/list", {})).rejects.toThrow("codex app-server exited");
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      `codex app-server stdout line truncated at ${STDIO_LINE_LIMIT} bytes`,
    );
    expect(child.exitCode).toBe(0);
    expect(onExit).toHaveBeenCalledTimes(1);
  } finally {
    warning.mockRestore();
    await rpc.close();
  }
});

it.skipIf(process.platform === "win32")(
  "reaps a provider child that ignores graceful stop",
  async () => {
    const child = spawn(process.execPath, [
      "-e",
      `
    process.on("SIGTERM", () => {});
    process.stdin.resume();
    setInterval(() => {}, 1000);
    process.stderr.write("ready");
  `,
    ]);
    const onExit = vi.fn();
    try {
      await once(child.stderr, "data");
      const rpc = new CodexRpc(child, {
        onExit,
        onNotification: () => {},
        onRequest: async () => undefined,
      });
      await rpc.close();
      expect(child.signalCode).toBe("SIGKILL");
      expect(onExit).toHaveBeenCalledTimes(1);
      const pid = child.pid;
      if (pid === undefined) throw new Error("Missing fixture pid");
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
  10_000,
);
