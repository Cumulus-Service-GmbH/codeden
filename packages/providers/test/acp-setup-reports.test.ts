import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AcpConfigOption, AcpSessionSetup } from "../src/acp/protocol";
import { AcpSession } from "../src/acp/session";
import { AntigravityAdapter } from "../src/antigravity/adapter";
import { CURSOR_AGENT } from "../src/cursor/adapter";
import { chunk, fakeAcp, fakeAgent, isTurnEnd } from "./support/fake-acp";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const acp = fakeAcp();
const fakeAgy = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-agy", "agy.mjs"),
};

/** Run one turn of `session` to its end. */
async function oneTurn(session: { events: AsyncIterable<unknown>; send: AcpSession["send"] }) {
  const it = session.events[Symbol.asyncIterator]();
  await session.send({ text: "go", attachments: [] });
  for (;;) {
    const next = await it.next();
    if (next.done || isTurnEnd(next.value as never)) break;
  }
}

describe("what an ACP session reports to its adapter after a config_option_update", () => {
  it("Cursor: session/new's whole setup, then only the options the update sent", async () => {
    const pushed: AcpConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-6",
        options: [{ value: "gpt-6", name: "GPT-6" }],
      },
    ];
    const seen: AcpSessionSetup[] = [];
    const session = new AcpSession(
      acp.options([
        { update: { sessionUpdate: "config_option_update", configOptions: pushed } },
        chunk("Done."),
      ]),
      { executable: fakeAgent, spec: CURSOR_AGENT, onSetup: (setup) => seen.push(setup) },
    );
    try {
      await session.start();
      await oneTurn(session);
    } finally {
      await session.close();
    }
    // The first report is session/new's reply as it came: the whole snapshot.
    expect(seen[0]).toHaveProperty("sessionId");
    // The update's report never carries the session's older modes or models with it.
    expect(seen.at(-1)).toEqual({ configOptions: pushed });
  });

  it("Cursor: its adapter takes the update's models from that report", async () => {
    const pushed: AcpConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-6",
        options: [{ value: "gpt-6", name: "GPT-6" }],
      },
    ];
    const { session, adapter } = await acp.open([
      { update: { sessionUpdate: "config_option_update", configOptions: pushed } },
      chunk("Done."),
    ]);
    await oneTurn(session as unknown as AcpSession);
    expect(adapter.models().map((m) => m.id)).toContain("gpt-6");
  });

  it("Antigravity: the picker ignores the update and keeps session/new's snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-agy-reports-"));
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const session = await adapter.openSession({
      sessionId: "s1",
      role: "agent",
      cwd: dir,
      autonomy: "auto",
      mcpServers: [],
      additionalDirectories: [],
      planMode: false,
      allowUnenforcedProviders: true,
      env: { FAKE_AGY_PUSH_DROP_MODEL: "claude-opus-5-5" },
    });
    try {
      expect(adapter.models().map((m) => m.id)).toContain("claude-opus-5-5");
      expect(adapter.capabilities().planMode).toBe(true);
      await oneTurn(session);
      expect(adapter.models().map((m) => m.id)).toContain("claude-opus-5-5");
      expect(adapter.capabilities().planMode).toBe(true);
    } finally {
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
