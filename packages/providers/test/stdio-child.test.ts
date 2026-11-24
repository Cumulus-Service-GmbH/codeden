import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { CodexRpc } from "../src/codex/rpc";
import { STDIO_LINE_LIMIT } from "../src/util/stdio-lines";

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
