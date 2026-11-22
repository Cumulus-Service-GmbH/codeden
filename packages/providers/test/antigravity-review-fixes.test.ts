import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionOptions } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionSetup } from "../src/acp/protocol";
import { type AcpRpc, AcpRpcError } from "../src/acp/rpc";
import { AcpSession } from "../src/acp/session";
import type { ProviderSession } from "../src/adapter";
import { ANTIGRAVITY_AGENT, AntigravityAdapter } from "../src/antigravity/adapter";
import { detectAntigravity } from "../src/antigravity/detect";
import { listSetup, probeAntigravity } from "../src/antigravity/probe";
import { clearExecutableCache } from "../src/util/locate";

// These tests start the fake CLI as a real process: room for a busy machine.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const fakeAgy = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-agy", "agy.mjs"),
};
let dir: string;
const logFile = () => join(dir, "acp.log");
const sets = () =>
  existsSync(logFile())
    ? readFileSync(logFile(), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> })
        .filter((m) => m.method === "session/set_config_option")
        .map((m) => `${m.params.configId}=${m.params.value}`)
    : [];
const options = (extra: Partial<SessionOptions> = {}): SessionOptions => ({
  sessionId: "s1",
  role: "agent",
  cwd: dir,
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
  allowUnenforcedProviders: true,
  ...extra,
  env: { FAKE_AGY_LOG: logFile(), ...extra.env },
});
const sessions: ProviderSession[] = [];
async function turn(session: ProviderSession): Promise<AgentEvent | undefined> {
  const it = session.events[Symbol.asyncIterator]();
  await session.send({ text: "go", attachments: [] });
  for (;;) {
    const next = await it.next();
    if (next.done) return undefined;
    const t = next.value.type;
    if (t === "turn.completed" || t === "turn.failed" || t === "turn.interrupted")
      return next.value;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-agy-fixes-"));
});
afterEach(async () => {
  delete process.env.FAKE_AGY_AUTH;
  clearExecutableCache();
  try {
    await Promise.all(sessions.splice(0).map((s) => s.close()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the Antigravity CLI after the provider review", () => {
  it("doesn't offer read-only: its default mode asks only per its own permission settings", () => {
    expect(new AntigravityAdapter({ executable: fakeAgy }).capabilities().readOnly).toBe(false);
  });

  it("doesn't offer Supervised either, and says the security rules don't cover it", () => {
    expect(new AntigravityAdapter({ executable: fakeAgy }).capabilities()).toMatchObject({
      supervised: false,
      enforcesSecurityRules: false,
    });
  });

  it("can't start in Supervised or switch into it", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    await expect(adapter.openSession(options({ autonomy: "supervised" }))).rejects.toMatchObject({
      code: "unsupported",
    });
    const session = await adapter.openSession(options());
    sessions.push(session);
    await expect(session.setAutonomy?.("supervised")).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("refuses to start unless the session's project allows providers without enforced rules", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const refused = { ...options(), allowUnenforcedProviders: undefined };
    await expect(adapter.openSession(refused)).rejects.toMatchObject({
      code: "security_rules_unenforced",
    });
    const allowed = await adapter.openSession(options());
    sessions.push(allowed);
    expect(allowed).toBeDefined();
  });

  it("fails the start when the CLI refuses the session's model, instead of running another", async () => {
    const reject = join(dir, "reject");
    writeFileSync(reject, "");
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    await expect(
      adapter.openSession(
        options({ model: "gemini-4-argon", env: { FAKE_AGY_REJECT_FILE: reject } }),
      ),
    ).rejects.toThrow(/invalid/);
  });

  it("keeps a refused start effort pending, so the first turn tries it again before its prompt", async () => {
    const reject = join(dir, "reject");
    writeFileSync(reject, "");
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const session = await adapter.openSession(
      options({ effort: "medium", env: { FAKE_AGY_REJECT_FILE: reject } }),
    );
    sessions.push(session);
    await expect(session.send({ text: "go", attachments: [] })).rejects.toThrow(/invalid/);
    rmSync(reject);
    expect((await turn(session))?.type).toBe("turn.completed");
    expect(sets().at(-1)).toBe("thought_level=medium");
  });

  it("sends nothing when the session picks the model the CLI already runs", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const session = await adapter.openSession(options());
    sessions.push(session);
    // gemini-4-neon is the CLI's own model at session/new.
    await session.configure?.({ model: "gemini-4-neon" });
    await turn(session);
    expect(sets().filter((s) => s.startsWith("model="))).toEqual([]);
  });

  it("treats a fixed-level model as at its effort even when the CLI lists no thought_level", async () => {
    const session = new AcpSession(options(), { executable: fakeAgy, spec: ANTIGRAVITY_AGENT });
    const inner = session as unknown as {
      setup: AcpSessionSetup;
      applyEffort: (rpc: unknown, id: string, effort: string, strict: boolean) => Promise<boolean>;
    };
    inner.setup = {
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-oss-120b-medium",
          options: [{ value: "gpt-oss-120b-medium", name: "GPT-OSS" }],
        },
      ],
      models: { availableModels: [{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS" }] },
    } as AcpSessionSetup;
    await expect(inner.applyEffort({}, "x", "high", true)).resolves.toBe(true);
  });

  it("switches when the CLI's live model differs, even back to the model it opened with", async () => {
    const session = new AcpSession(options(), { executable: fakeAgy, spec: ANTIGRAVITY_AGENT });
    const requests: string[] = [];
    const rpc = {
      request: async (method: string, params: { configId?: string; value?: string }) => {
        requests.push(`${method}:${params.configId}=${params.value}`);
        return null;
      },
    };
    const inner = session as unknown as {
      setup: AcpSessionSetup;
      acpSession: string;
      openedModel: string | undefined;
      nextModel: string | null | undefined;
      applyModelChange: (rpc: unknown) => Promise<void>;
    };
    // The CLI opened on Neon, then an update moved it to Argon on its own.
    inner.openedModel = "gemini-4-neon";
    inner.acpSession = "x";
    inner.setup = {
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gemini-4-argon",
          options: [
            { value: "gemini-4-neon", name: "Neon" },
            { value: "gemini-4-argon", name: "Argon" },
          ],
        },
      ],
    };
    inner.nextModel = "gemini-4-neon";
    await inner.applyModelChange(rpc);
    expect(requests).toContain("session/set_config_option:model=gemini-4-neon");
  });

  it("keeps the picker on fresh snapshots: a resumed session's saved setup isn't one", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const savedId = "saved-session";
    const resumed = await adapter.openSession(options({ resumeToken: savedId }));
    sessions.push(resumed);
    // session/load succeeded: its saved setup leaves the picker on Default.
    expect(adapter.models().map((m) => m.id)).toEqual(["default"]);
    const fresh = await adapter.openSession(options({ sessionId: "s2" }));
    sessions.push(fresh);
    expect(adapter.models().map((m) => m.id)).toContain("gemini-4-neon");
  });

  it("sends no level for a model that runs at one fixed level", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const session = await adapter.openSession(
      options({ model: "gpt-oss-120b-medium", effort: "xhigh" }),
    );
    sessions.push(session);
    expect(sets()).toEqual(["model=gpt-oss-120b-medium"]);
  });

  it("says so, instead of claiming Default, when the CLI never named its own model", async () => {
    const session = new AcpSession(options(), { executable: fakeAgy, spec: ANTIGRAVITY_AGENT });
    const inner = session as unknown as {
      setup: AcpSessionSetup;
      acpSession: string;
      model: string | undefined;
      openedModel: string | undefined;
      nextModel: string | null | undefined;
      events: { push: (e: unknown) => void };
      applyModelChange: (rpc: unknown) => Promise<void>;
    };
    const pushed: unknown[] = [];
    inner.events = { push: (e) => pushed.push(e) };
    inner.setup = {};
    inner.acpSession = "x";
    inner.model = "gemini-4-argon";
    inner.openedModel = undefined;
    inner.nextModel = null;
    await inner.applyModelChange({});
    expect(inner.model).toBe("gemini-4-argon");
    expect(pushed).toContainEqual({ type: "session.updated", model: "gemini-4-argon" });
  });

  it("goes back to the CLI's own model when the session is switched to Default", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const session = await adapter.openSession(options({ model: "gemini-4-argon" }));
    sessions.push(session);
    await session.configure?.({ model: null });
    await turn(session);
    // gemini-4-neon is the model the CLI's session/new reported as current.
    expect(sets().at(-1)).toBe("model=gemini-4-neon");
  });

  it("keeps its list and efforts through a config_option_update (snapshots only)", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const session = await adapter.openSession(
      options({ env: { FAKE_AGY_PUSH_DROP_MODEL: "claude-opus-5-5" } }),
    );
    sessions.push(session);
    const before = adapter.models().find((m) => m.id === "gemini-4-neon")?.efforts;
    expect(before?.length).toBeGreaterThan(0);
    await turn(session);
    expect(adapter.models().map((m) => m.id)).toContain("claude-opus-5-5");
    expect(adapter.models().find((m) => m.id === "gemini-4-neon")?.efforts).toEqual(before);
  });

  it("keeps an effort pending when the CLI doesn't list the effort option", async () => {
    const session = new AcpSession(options(), { executable: fakeAgy, spec: ANTIGRAVITY_AGENT });
    const inner = session as unknown as {
      setup: AcpSessionSetup;
      acpSession: string;
      nextEffort: unknown;
      applyModelChange: (rpc: unknown) => Promise<void>;
    };
    inner.setup = { configOptions: [] };
    inner.acpSession = "x";
    inner.nextEffort = "high";
    // The turn fails before its prompt rather than run at another effort, and it stays pending.
    await expect(inner.applyModelChange({})).rejects.toMatchObject({ code: "effort_unavailable" });
    expect(inner.nextEffort).toBe("high");
  });

  it("keeps the CLI's own level until it is back, when clearing an effort can't restore it yet", async () => {
    const session = new AcpSession(options(), { executable: fakeAgy, spec: ANTIGRAVITY_AGENT });
    const inner = session as unknown as {
      setup: AcpSessionSetup;
      agentEffort: string | undefined;
      applyEffort: (
        rpc: unknown,
        id: string,
        effort: undefined,
        strict: boolean,
      ) => Promise<boolean>;
    };
    inner.setup = {
      configOptions: [
        {
          id: "thought_level",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "low",
          options: [{ value: "low", name: "Low" }],
        },
      ],
    };
    inner.agentEffort = "xhigh";
    await expect(inner.applyEffort({}, "x", undefined, true)).resolves.toBe(false);
    expect(inner.agentEffort).toBe("xhigh");
  });

  it("clears plan mode on a snapshot that lists no modes, even without models", () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    const apply = (adapter as unknown as { applySetup: (s: AcpSessionSetup) => void }).applySetup;
    expect(adapter.capabilities().planMode).toBe(true);
    apply.call(adapter, { modes: { availableModes: [] } });
    expect(adapter.capabilities().planMode).toBe(false);
  });

  it("never reports sign-out for a refusal that arrives after the probe's deadline", async () => {
    let refuse: (error: Error) => void = () => undefined;
    const rpc = {
      request: () => new Promise((_resolve, reject) => (refuse = reject)),
    } as unknown as AcpRpc;
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    try {
      const signedOut = vi.fn();
      const listed = listSetup(rpc, "/tmp", 60_000, undefined, signedOut);
      now.mockReturnValue(1_000 + 60_001);
      refuse(new AcpRpcError(-32000, "Authentication required"));
      await expect(listed).resolves.toBeUndefined();
      expect(signedOut).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("reports the CLI as signed out when its throwaway session is refused for that", async () => {
    process.env.FAKE_AGY_AUTH = "missing";
    const status = await detectAntigravity({
      executable: fakeAgy,
      probe: (exe) => probeAntigravity(exe, { timeoutMs: 10_000 }),
    });
    expect(status).toMatchObject({ supported: true, loggedIn: false });
    expect(status.issues).toEqual([
      expect.objectContaining({ code: "not_logged_in", fix: { kind: "login", command: "agy" } }),
    ]);
  });
});
