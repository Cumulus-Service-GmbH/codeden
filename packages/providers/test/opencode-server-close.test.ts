import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { OpenCodeServer } from "../src/opencode/server";
import { spawnResolved, stopStdioChild } from "../src/util/exec";

vi.mock("../src/util/exec", () => ({
  spawnResolved: vi.fn(),
  stopStdioChild: vi.fn(),
}));

const executable = { kind: "native", path: "opencode" } as const;
const stopError = new Error("Child process did not exit after termination");

function fakeChild() {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  vi.mocked(spawnResolved).mockReturnValue(
    Object.assign(child, { stdin, stdout }) as unknown as ReturnType<typeof spawnResolved>,
  );
  vi.mocked(stopStdioChild).mockRejectedValue(stopError);
  return stdout;
}

it("handles abort cleanup failure and preserves the original startup error", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const beforeStart = new AbortController();
    beforeStart.abort();
    fakeChild();
    await expect(
      OpenCodeServer.start(executable, { cwd: process.cwd(), signal: beforeStart.signal }),
    ).rejects.toThrow("Aborted while starting OpenCode");

    const afterStart = new AbortController();
    const stdout = fakeChild();
    const started = OpenCodeServer.start(executable, {
      cwd: process.cwd(),
      signal: afterStart.signal,
    });
    stdout.write('{"url":"http://127.0.0.1:1234"}\n');
    await started;
    afterStart.abort();
    await Promise.resolve();
    expect(warning).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
  }
});
