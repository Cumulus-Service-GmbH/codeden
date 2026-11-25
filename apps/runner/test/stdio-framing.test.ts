import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { STDIO_LINE_LIMIT } from "@codeden/providers";
import { expect, it, vi } from "vitest";
import { McpStdioTransport } from "../src/mcp/stdio-transport";

it("scans only incoming bytes and concatenates a fragmented frame once", async () => {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout });
  const transport = new McpStdioTransport({
    command: "fixture",
    args: [],
    env: {},
    cwd: process.cwd(),
    onStderr: () => {},
    spawn: () => child as unknown as ChildProcess,
  });
  const received = vi.fn();
  transport.onmessage = received;
  const started = transport.start();
  child.emit("spawn");
  await started;

  const chunk = Buffer.alloc(4096, 0x61);
  const header = Buffer.from('{"jsonrpc":"2.0","method":"notice","params":{"text":"');
  const end = Buffer.from('"}}\r\n');
  const indexOf = vi.spyOn(Buffer.prototype, "indexOf");
  const concat = vi.spyOn(Buffer, "concat");
  const copy = vi.spyOn(Buffer.prototype, "copy");
  let scanned = 0;
  let copied = 0;
  try {
    stdout.write(header);
    for (let i = 0; i < 768; i++) stdout.write(chunk);
    stdout.write(end);
    for (let i = 0; i < indexOf.mock.calls.length; i++) {
      scanned +=
        (indexOf.mock.contexts[i] as Buffer).length - Number(indexOf.mock.calls[i]?.[1] ?? 0);
    }
    for (const [parts] of concat.mock.calls) {
      copied += parts.reduce((sum, part) => sum + part.length, 0);
    }
    for (let i = 0; i < copy.mock.calls.length; i++) {
      const [, , start = 0, end] = copy.mock.calls[i] ?? [];
      copied += Number(end ?? (copy.mock.contexts[i] as Buffer).length) - Number(start);
    }
  } finally {
    indexOf.mockRestore();
    concat.mockRestore();
    copy.mockRestore();
    await transport.close();
  }
  const size = header.length + 768 * chunk.length + end.length;
  expect(received).toHaveBeenCalledTimes(1);
  expect(scanned).toBeLessThanOrEqual(size);
  expect(copied).toBeLessThanOrEqual(3 * size);
});

it("warns once for an oversized MCP line and accepts the next UTF-8 frame", async () => {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout });
  const onStderr = vi.fn();
  const transport = new McpStdioTransport({
    command: "fixture",
    args: [],
    env: {},
    cwd: process.cwd(),
    onStderr,
    spawn: () => child as unknown as ChildProcess,
  });
  const received = vi.fn();
  transport.onmessage = received;
  const started = transport.start();
  child.emit("spawn");
  await started;
  try {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let i = 0; i < STDIO_LINE_LIMIT / chunk.length + 2; i++) stdout.write(chunk);
    stdout.write(Buffer.from('\n{"jsonrpc":"2.0","method":"'));
    stdout.write(Buffer.from([0xc3]));
    stdout.write(Buffer.from([0xa9]));
    stdout.end(Buffer.from('"}\r\n'));
    expect(onStderr).toHaveBeenCalledExactlyOnceWith(
      `Warning: MCP stdout line truncated at ${STDIO_LINE_LIMIT} bytes\n`,
    );
    expect(received).toHaveBeenCalledExactlyOnceWith({ jsonrpc: "2.0", method: "é" });
  } finally {
    await transport.close();
  }
});
