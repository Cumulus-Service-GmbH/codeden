import { expect, it, vi } from "vitest";
import { startRunner } from "../src";
import { SessionHost } from "../src/session-host";
import { removeDir, TestServer, tempDir } from "./helpers";

it("closes and reports failure when draining rejects", async () => {
  const home = tempDir("codeden-drain-");
  const onShutdown = vi.fn();
  const runner = await startRunner({ home, enableFakeProvider: true, onShutdown });
  const server = await TestServer.attach(runner);
  const drain = vi
    .spyOn(SessionHost.prototype, "drain")
    .mockRejectedValueOnce(new Error("drain failed"));
  try {
    await server.request({ name: "runner.drain", reason: "upgrade", exitWhenDrained: true });
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledWith(1));
  } finally {
    drain.mockRestore();
    await server.close();
    await runner.close();
    removeDir(home);
  }
});

it("closes the server connection and reports failure when closing sessions rejects", async () => {
  const home = tempDir("codeden-close-");
  const onShutdown = vi.fn();
  const runner = await startRunner({ home, enableFakeProvider: true, onShutdown });
  const server = await TestServer.attach(runner);
  const closeAll = vi
    .spyOn(SessionHost.prototype, "closeAll")
    .mockRejectedValueOnce(new Error("close failed"));
  try {
    await server.request({ name: "runner.shutdown" });
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledWith(1));
    await expect(TestServer.connect(runner)).rejects.toThrow("ECONNREFUSED");
  } finally {
    closeAll.mockRestore();
    await server.close();
    await runner.close().catch(() => undefined);
    removeDir(home);
  }
});
