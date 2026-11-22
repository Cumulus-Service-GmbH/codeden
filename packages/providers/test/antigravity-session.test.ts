import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionOptions } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcpSessionSetup } from "../src/acp/protocol";
import { AcpSession } from "../src/acp/session";
import type { ProviderSession } from "../src/adapter";
import { ANTIGRAVITY_AGENT, AntigravityAdapter } from "../src/antigravity/adapter";

const fakeAgy = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-agy", "agy.mjs"),
};

type Logged = { method: string; params: Record<string, unknown> };
let dir: string;
const logFile = () => join(dir, "acp.log");
const logged = (method?: string): Logged[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Logged)
        .filter((m) => !method || m.method === method)
    : [];
/** The `session/set_config_option` calls, as `configId=value`. */
const configSets = () =>
  logged("session/set_config_option").map((m) => `${m.params.configId}=${m.params.value}`);

const codeden = {
  transport: "http" as const,
  name: "codeden",
  url: "http://127.0.0.1:4000/mcp",
  headers: { Authorization: "Bearer test" },
  trusted: true,
};

function options(extra: Partial<SessionOptions> = {}): SessionOptions {
  return {
    sessionId: "s1",
    role: "agent",
    cwd: dir,
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
    ...extra,
    env: { FAKE_AGY_LOG: logFile(), ...extra.env },
  };
}

const isTurnEnd = (e: AgentEvent) =>
  e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted";

const sessions: ProviderSession[] = [];
async function open(extra: Partial<SessionOptions> = {}) {
  const adapter = new AntigravityAdapter({ executable: fakeAgy });
  const session = await adapter.openSession(options(extra));
  sessions.push(session);
  const events: AgentEvent[] = [];
  const it = session.events[Symbol.asyncIterator]();
  const turn = async (text: string) => {
    const from = events.length;
    await session.send({ text, attachments: [] });
    for (;;) {
      const next = await it.next();
      if (next.done) throw new Error("event stream ended");
      events.push(next.value);
      if (isTurnEnd(next.value)) return events.slice(from);
    }
  };
  return { session, adapter, turn };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-agy-"));
});

afterEach(async () => {
  try {
    await Promise.all(sessions.splice(0).map((s) => s.close()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Antigravity CLI session over ACP", () => {
  it("runs `acp --process-per-session` on the user's own login with CodeDen's HTTP MCP server", async () => {
    const { adapter, turn } = await open({ mcpServers: [codeden] });
    expect(logged("authenticate")).toEqual([]);
    expect(logged("session/new")[0]?.params.mcpServers).toEqual([
      {
        type: "http",
        name: "codeden",
        url: "http://127.0.0.1:4000/mcp",
        headers: [{ name: "Authorization", value: "Bearer test" }],
      },
    ]);
    // Already in `default`, no effort asked for: nothing to set.
    expect(configSets()).toEqual([]);
    const events = await turn("hi");
    expect(events.at(-1)?.type).toBe("turn.completed");
    // The session's own list replaces Default-only.
    expect(adapter.models().map((m) => m.id)).toContain("gemini-4-neon");
  });

  it("sets the model, then its thinking level, at the start and when changed", async () => {
    const { session, turn } = await open({ model: "gemini-4-argon", effort: "max" });
    // Argon lists `xhigh` as a thinking level, so `max` runs at it.
    expect(configSets()).toEqual(["model=gemini-4-argon", "thought_level=xhigh"]);
    await session.configure?.({ effort: "minimal" });
    await turn("go");
    expect(configSets().at(-1)).toBe("thought_level=low");
    await session.configure?.({ model: "claude-opus-5-5" });
    await turn("again");
    // A new model: the effort is checked again after it, and set only when the level changed.
    expect(configSets().at(-1)).toBe("model=claude-opus-5-5");
  });

  it("puts the agent's own thinking level back when the effort is cleared", async () => {
    const { session, turn } = await open({ effort: "low" });
    expect(configSets()).toEqual(["thought_level=low"]);
    await session.configure?.({ effort: null });
    await turn("go");
    expect(configSets()).toEqual(["thought_level=low", "thought_level=high"]);
  });

  it("fails a turn whose asked-for effort the agent refuses, and retries it next turn", async () => {
    const reject = join(dir, "reject");
    const { session, turn } = await open({ env: { FAKE_AGY_REJECT_FILE: reject } });
    await session.configure?.({ effort: "medium" });
    writeFileSync(reject, "");
    await expect(session.send({ text: "go", attachments: [] })).rejects.toThrow(/invalid/);
    expect(logged("session/prompt")).toEqual([]);
    rmSync(reject);
    await turn("again");
    expect(configSets().at(-1)).toBe("thought_level=medium");
  });

  it("keeps a refused model and effort change pending and applies both next turn", async () => {
    const reject = join(dir, "reject");
    const { session, turn } = await open({ env: { FAKE_AGY_REJECT_FILE: reject } });
    await session.configure?.({ model: "gemini-4-argon", effort: "medium" });
    writeFileSync(reject, "");
    await expect(session.send({ text: "go", attachments: [] })).rejects.toThrow(/invalid/);
    rmSync(reject);
    await turn("again");
    expect(configSets().slice(-2)).toEqual(["model=gemini-4-argon", "thought_level=medium"]);
    expect(logged("session/prompt")).toHaveLength(1);
  });

  it("refreshes the models detection read when a real session lists newer ones", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    await adapter.detect();
    expect(adapter.models().map((m) => m.id)).toContain("claude-opus-5-5");
    const session = await adapter.openSession(
      options({ env: { FAKE_AGY_DROP_MODEL: "claude-opus-5-5" } }),
    );
    sessions.push(session);
    const ids = adapter.models().map((m) => m.id);
    expect(ids).toContain("gemini-4-neon");
    expect(ids).not.toContain("claude-opus-5-5");
  });

  it("opens even when the adapter's handshake report throws", async () => {
    const session = new AcpSession(options(), {
      executable: fakeAgy,
      spec: ANTIGRAVITY_AGENT,
      onInfo: () => {
        throw new Error("adapter failed");
      },
    });
    sessions.push(session);
    await expect(session.start()).resolves.toBeUndefined();
    expect(logged("session/new")).toHaveLength(1);
  });

  it("reports the setup a model switch brought, so the adapter's list follows it", async () => {
    const reported: AcpSessionSetup[] = [];
    const session = new AcpSession(options(), {
      executable: fakeAgy,
      spec: ANTIGRAVITY_AGENT,
      onSetup: (setup) => reported.push(setup),
    });
    sessions.push(session);
    await session.start();
    const at = reported.length;
    await session.configure({ model: "gemini-4-argon" });
    const it = session.events[Symbol.asyncIterator]();
    await session.send({ text: "go", attachments: [] });
    for (;;) {
      const next = await it.next();
      if (next.done || isTurnEnd(next.value)) break;
    }
    const model = (s?: AcpSessionSetup) => s?.configOptions?.find((o) => o.id === "model");
    expect(reported.length).toBeGreaterThan(at);
    expect(model(reported.at(-1))?.currentValue).toBe("gemini-4-argon");
  });

  it("opens when the adapter's async reports reject later, with no unhandled rejection", async () => {
    const session = new AcpSession(options(), {
      executable: fakeAgy,
      spec: ANTIGRAVITY_AGENT,
      onInfo: async () => {
        throw new Error("adapter failed later");
      },
      onSetup: async () => {
        throw new Error("adapter failed later");
      },
    });
    sessions.push(session);
    await expect(session.start()).resolves.toBeUndefined();
  });

  it("refuses to open a given CLI that is too old", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    process.env.FAKE_AGY_VERSION = "1.5.11";
    try {
      await expect(adapter.openSession(options())).rejects.toMatchObject({
        code: "version_unsupported",
      });
    } finally {
      delete process.env.FAKE_AGY_VERSION;
    }
    expect(logged("initialize")).toEqual([]);
  });

  it("plans in its `plan` mode, and stays in `default` read-only", async () => {
    await open({ planMode: true });
    expect(configSets()).toEqual(["mode=plan"]);
    const readOnly = await open({ autonomy: "read_only" });
    await readOnly.session.setAutonomy?.("read_only");
    expect(configSets()).toEqual(["mode=plan"]);
  });

  it("explains how to sign in when the CLI has no login", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    await expect(
      adapter.openSession(options({ env: { FAKE_AGY_AUTH: "missing" } })),
    ).rejects.toMatchObject({ code: "not_logged_in", message: expect.stringMatching(/`agy`/) });
  });
});
