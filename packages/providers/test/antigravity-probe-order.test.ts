import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AcpInitializeResult, AcpSessionSetup } from "../src/acp/protocol";
import type { AntigravityProbe, AntigravityProbeReports } from "../src/antigravity/probe";

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
/** What a real session reports when it opens (the adapter's `onSetup`, as sessions call it). */
const sessionReports = (adapter: Adapter, setup: AcpSessionSetup, init: AcpInitializeResult) =>
  (adapter as unknown as { onSetup: (s: AcpSessionSetup, i: AcpInitializeResult) => void }).onSetup(
    setup,
    init,
  );

describe("the Antigravity CLI's model list and flags", () => {
  it("come from whatever arrived last: a session's report beats a probe that finishes later", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const detected = adapter.detect();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const probe = pending[0] as Pending;
    probe.onInfo?.(info(false));
    probe.onSetup?.(listing("probe-model"));
    expect(ids(adapter)).toContain("probe-model");
    sessionReports(adapter, listing("gemini-4-neon"), info(true));
    probe.finish({ acp: true, info: info(false), setup: listing("probe-model") });
    await detected;
    expect(ids(adapter)).toContain("gemini-4-neon");
    expect(ids(adapter)).not.toContain("probe-model");
    expect(adapter.capabilities().images).toBe(true);
  });

  it("run one detection at a time and keep a list over an empty or malformed one", async () => {
    pending.length = 0;
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const first = adapter.detect();
    const again = adapter.detect();
    expect(again).toBe(first);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.onSetup?.(listing("gemini-4-neon"));
    pending[0]?.finish({ acp: true });
    await first;

    const second = adapter.detect();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]?.onSetup?.({ models: { availableModels: {} } } as unknown as AcpSessionSetup);
    pending[1]?.finish({ acp: true });
    await expect(second).resolves.toMatchObject({ supported: true });
    expect(ids(adapter)).toContain("gemini-4-neon");
  });
});
