import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type RunningServer, startServer } from "../src";
import { removeTree } from "./support/remove-tree";

it("acknowledges the API shutdown and requests a clean process exit", async () => {
  const home = mkdtempSync(join(tmpdir(), "codeden-api-shutdown-"));
  const token = "t".repeat(64);
  const exited = Promise.withResolvers<number>();
  const onShutdownRequest = vi.fn(exited.resolve);
  let server: RunningServer | undefined;
  try {
    server = await startServer({
      port: 0,
      dataDir: home,
      token,
      runner: false,
      secrets: "memory",
      checkSetupOnStart: false,
      onShutdownRequest,
    });
    const response = await fetch(`${server.url}/api/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect(exited.promise).resolves.toBe(0);
    expect(onShutdownRequest).toHaveBeenCalledExactlyOnceWith(0);
  } finally {
    await server?.close();
    await removeTree(home);
  }
});
