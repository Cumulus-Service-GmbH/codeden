import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AcpSessionSetup } from "../src/acp/protocol";
import type { AntigravityProbe } from "../src/antigravity/probe";

const pending: Array<(probe: AntigravityProbe) => void> = [];
vi.mock("../src/antigravity/probe", async (load) => ({
  ...(await load<typeof import("../src/antigravity/probe")>()),
  probeAntigravity: () => new Promise<AntigravityProbe>((resolve) => pending.push(resolve)),
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

describe("detection probes that finish out of order", () => {
  it("keep the newest probe's models, and survive a malformed list", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const first = adapter.detect();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = adapter.detect();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]?.({ acp: true, setup: listing("gemini-4-neon", "gemini-4-argon") });
    await second;
    pending[0]?.({ acp: true, setup: listing("old-model") });
    await first;
    const ids = adapter.models().map((m) => m.id);
    expect(ids).toContain("gemini-4-argon");
    expect(ids).not.toContain("old-model");

    const third = adapter.detect();
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2]?.({
      acp: true,
      setup: { models: { availableModels: {} } } as unknown as AcpSessionSetup,
    });
    await expect(third).resolves.toMatchObject({ supported: true });
    expect(adapter.models().map((m) => m.id)).toContain("gemini-4-argon");
  });
});
