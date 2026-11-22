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
const ids = (adapter: InstanceType<typeof AntigravityAdapter>) => adapter.models().map((m) => m.id);

/** Start a detection and wait until its probe is pending; returns the detection and its answer. */
async function detection(adapter: InstanceType<typeof AntigravityAdapter>) {
  const at = pending.length;
  const done = adapter.detect();
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(at));
  return { done, answer: pending[at] as (probe: AntigravityProbe) => void };
}

describe("the Antigravity CLI's model list", () => {
  it("is the newest complete list, whatever order the probes finish in", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const older = await detection(adapter);
    const newer = await detection(adapter);
    newer.answer({ acp: true, setup: listing("gemini-4-argon"), listedAt: 2_000 });
    await newer.done;
    older.answer({ acp: true, setup: listing("old-model"), listedAt: 1_000 });
    await older.done;
    expect(ids(adapter)).toContain("gemini-4-argon");
    expect(ids(adapter)).not.toContain("old-model");
  });

  it("keeps a list when a newer probe listed nothing or something malformed", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const first = await detection(adapter);
    first.answer({ acp: true, setup: listing("gemini-4-neon"), listedAt: 1_000 });
    await first.done;

    const empty = await detection(adapter);
    empty.answer({ acp: true });
    await empty.done;
    const bad = await detection(adapter);
    bad.answer({
      acp: true,
      setup: { models: { availableModels: {} } } as unknown as AcpSessionSetup,
      listedAt: 3_000,
    });
    await expect(bad.done).resolves.toMatchObject({ supported: true });
    expect(ids(adapter)).toContain("gemini-4-neon");
  });
});
