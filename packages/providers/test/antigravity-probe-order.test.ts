import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpInitializeResult, AcpSessionSetup } from "../src/acp/protocol";
import type { AntigravityProbe, AntigravityProbeReports } from "../src/antigravity/probe";

// These tests start the fake CLI as a real process: room for a busy machine, as for the
// repo's other process-spawning suites.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

/** Each probe the adapter starts: its reports and how to finish it. */
type Pending = AntigravityProbeReports & { finish: (probe: AntigravityProbe) => void };
const pending: Pending[] = [];
vi.mock("../src/antigravity/probe", async (load) => ({
  ...(await load<typeof import("../src/antigravity/probe")>()),
  probeAntigravity: (_exe: unknown, opts: AntigravityProbeReports) =>
    new Promise<AntigravityProbe>((finish) => pending.push({ ...opts, finish })),
}));
const { AntigravityAdapter } = await import("../src/antigravity/adapter");

const fakeAgy = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-agy", "agy.mjs"),
};
const listing = (...ids: string[]): AcpSessionSetup => ({
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: ids[0],
      options: ids.map((value) => ({ value, name: value })),
    },
  ],
});
const info = (image: boolean): AcpInitializeResult =>
  ({
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image } },
  }) as AcpInitializeResult;
type Adapter = InstanceType<typeof AntigravityAdapter>;
const ids = (adapter: Adapter) => adapter.models().map((m) => m.id);
/** A real session's two reports, as `AcpSession` makes them: its handshake, then its setup. */
const session = (adapter: Adapter) => {
  const hooks = adapter as unknown as {
    onInfo: (i: AcpInitializeResult) => void;
    applySetup: (s: AcpSessionSetup) => void;
  };
  return { handshake: hooks.onInfo.bind(adapter), setup: hooks.applySetup.bind(adapter) };
};
/** Start a detection and return its probe once the adapter has started it. */
async function probing(adapter: Adapter) {
  const at = pending.length;
  const done = adapter.detect();
  // Detection runs the fake CLI's `--version` first: give a busy machine time.
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(at), { timeout: 30_000 });
  return { done, probe: pending[at] as Pending };
}

beforeEach(() => {
  pending.length = 0;
});

describe("the Antigravity CLI's model list and flags", () => {
  it("come from whatever arrived last: a session's report beats a probe that finishes later", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const { done, probe } = await probing(adapter);
    probe.onInfo?.(info(false));
    probe.onSetup?.(listing("probe-model"));
    expect(ids(adapter)).toContain("probe-model");
    const s = session(adapter);
    s.handshake(info(true));
    s.setup(listing("gemini-4-neon"));
    probe.finish({ acp: true, info: info(false), setup: listing("probe-model") });
    await done;
    expect(ids(adapter)).toContain("gemini-4-neon");
    expect(ids(adapter)).not.toContain("probe-model");
    expect(adapter.capabilities().images).toBe(true);
  });

  it("keep a newer handshake's flags when an older session's setup arrives after it", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const s = session(adapter);
    s.handshake(info(false));
    const { done, probe } = await probing(adapter);
    probe.onInfo?.(info(true));
    s.setup(listing("gemini-4-neon"));
    probe.finish({ acp: true, info: info(true) });
    await done;
    expect(adapter.capabilities().images).toBe(true);
    expect(ids(adapter)).toContain("gemini-4-neon");
  });

  it("take a real session's handshake and list over a probe that reported before it", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const { done, probe } = await probing(adapter);
    probe.onInfo?.(info(false));
    probe.onSetup?.(listing("probe-model"));
    expect(adapter.capabilities().images).toBe(false);
    const cwd = mkdtempSync(join(tmpdir(), "codeden-agy-order-"));
    try {
      const opened = await adapter.openSession({
        sessionId: "s1",
        role: "agent",
        cwd,
        autonomy: "auto",
        mcpServers: [],
        additionalDirectories: [],
        planMode: false,
      });
      try {
        // Through AcpSession's own reports: the fake CLI's handshake has images, its list Neon.
        expect(adapter.capabilities().images).toBe(true);
        expect(ids(adapter)).toContain("gemini-4-neon");
        expect(ids(adapter)).not.toContain("probe-model");
        probe.finish({ acp: true, info: info(false), setup: listing("probe-model") });
        await done;
        expect(adapter.capabilities().images).toBe(true);
      } finally {
        await opened.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("run one detection at a time", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const first = adapter.detect();
    expect(adapter.detect()).toBe(first);
    await vi.waitFor(() => expect(pending).toHaveLength(1), { timeout: 30_000 });
    pending[0]?.finish({ acp: true });
    await first;
    expect(pending).toHaveLength(1);
  });

  it("merge a report of options only with the newest setup taken, and clear plan mode on an empty mode list", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const s = session(adapter);
    s.setup({
      ...listing("gemini-4-neon"),
      modes: { availableModes: [{ id: "plan", name: "Plan" }] },
    });
    expect(adapter.capabilities().planMode).toBe(true);
    // A reply's options only: the models change, plan mode stays as the last report said.
    s.setup({ configOptions: listing("gemini-4-argon").configOptions });
    expect(ids(adapter)).toContain("gemini-4-argon");
    expect(adapter.capabilities().planMode).toBe(true);
    // A setup that says it has no modes at all clears plan mode.
    s.setup({ ...listing("gemini-4-argon"), modes: { availableModes: [] } });
    expect(adapter.capabilities().planMode).toBe(false);
  });

  it("keep a list over an empty one and over a malformed one", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const first = await probing(adapter);
    first.probe.onSetup?.(listing("gemini-4-neon"));
    first.probe.finish({ acp: true });
    await first.done;

    const empty = await probing(adapter);
    empty.probe.onSetup?.({ configOptions: [], models: { availableModels: [] } });
    empty.probe.finish({ acp: true });
    await empty.done;
    expect(ids(adapter)).toContain("gemini-4-neon");

    const bad = await probing(adapter);
    bad.probe.onSetup?.({ models: { availableModels: {} } } as unknown as AcpSessionSetup);
    bad.probe.finish({ acp: true });
    await expect(bad.done).resolves.toMatchObject({ supported: true });
    expect(ids(adapter)).toContain("gemini-4-neon");
  });
});
