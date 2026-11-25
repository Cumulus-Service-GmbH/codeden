import { startServer } from "@codeden/server";
import { afterEach, expect, it, vi } from "vitest";
import { parseCli } from "../src/args";
import { runCommand } from "../src/commands";

vi.mock("@codeden/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codeden/server")>()),
  ensureHome: () => ({ token: "token", serverLock: "lock" }),
  ensureInstallToken: () => "test-token",
  startServer: vi.fn(),
}));
vi.mock("../src/running", () => ({ findRunningServer: async () => undefined }));

afterEach(() => vi.restoreAllMocks());

it("reports a failed server close and exits unsuccessfully on shutdown", async () => {
  const error = new Error("close failed");
  const registered = Promise.withResolvers<() => void>();
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGTERM") registered.resolve(listener as () => void);
    return process;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(startServer).mockResolvedValue({
    network: { enabled: false },
    close: () => Promise.reject(error),
  } as Awaited<ReturnType<typeof startServer>>);

  const args = ["--no-open"];
  void runCommand(args, parseCli(args));
  (await registered.promise)();
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  expect(report).toHaveBeenCalledWith(error);
});
