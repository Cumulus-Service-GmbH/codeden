import { join } from "node:path";
import type { SessionOptions } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AcpConfigOption, AcpSessionSetup } from "../src/acp/protocol";
import { AcpSession } from "../src/acp/session";
import { ANTIGRAVITY_AGENT } from "../src/antigravity/adapter";

const fakeAgy = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-agy", "agy.mjs"),
};
const options: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: "/tmp",
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};
const list = (...ids: string[]): AcpConfigOption[] => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: ids[0],
    options: ids.map((value) => ({ value, name: value })),
  },
];

/** An unstarted session whose setup a change started from, then moved on while it ran. */
function session(live: AcpSessionSetup) {
  const onSetup = vi.fn();
  const s = new AcpSession(options, { executable: fakeAgy, spec: ANTIGRAVITY_AGENT, onSetup });
  const inner = s as unknown as {
    setup: AcpSessionSetup;
    applyReply: (before: AcpSessionSetup, next: AcpSessionSetup) => void;
  };
  inner.setup = live;
  return { inner, onSetup };
}

describe("what an ACP change's reply does to the session's setup", () => {
  const before: AcpSessionSetup = {
    configOptions: list("old"),
    modes: { currentModeId: "default" },
  };
  const live: AcpSessionSetup = { ...before, configOptions: list("newer") };

  it("takes an option list the agent answered with into its own setup, and reports nothing", () => {
    const liveModes: AcpSessionSetup = { ...live, modes: { currentModeId: "plan" } };
    const { inner, onSetup } = session(liveModes);
    const reply = list("reply");
    // The rest of `next` is the request's starting copy, older than the live setup.
    inner.applyReply(before, { ...before, configOptions: reply });
    expect(inner.setup.configOptions).toBe(reply);
    expect(inner.setup.modes?.currentModeId).toBe("plan");
    expect(onSetup).not.toHaveBeenCalled();
  });

  it("keeps the live options after session/set_mode's acknowledgement, taking only its mode", () => {
    const { inner, onSetup } = session(live);
    inner.applyReply(before, { ...before, modes: { currentModeId: "plan" } });
    expect(inner.setup.configOptions).toBe(live.configOptions);
    expect(inner.setup.modes?.currentModeId).toBe("plan");
    expect(onSetup).not.toHaveBeenCalled();
  });

  it("keeps the live options after session/set_model's acknowledgement", () => {
    const { inner, onSetup } = session(live);
    inner.applyReply(before, before);
    expect(inner.setup).toBe(live);
    expect(onSetup).not.toHaveBeenCalled();
  });
});
