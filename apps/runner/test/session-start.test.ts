import { tmpdir } from "node:os";
import type { RunnerEvent, SessionOptions } from "@codeden/contracts";
import {
  FakeProvider,
  type ProviderAdapter,
  ProviderRegistry,
  ProviderSessionError,
} from "@codeden/providers";
import { afterEach, describe, expect, it } from "vitest";
import { SessionHost } from "../src/session-host";

const options: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

let host: SessionHost | undefined;
afterEach(async () => {
  await host?.closeAll();
  host = undefined;
});

/** The Fake provider, whose opens wait until `release` (a real CLI takes seconds to start). */
function slowFake() {
  const inner = new FakeProvider();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { opens: 0 };
  const adapter: ProviderAdapter = {
    id: inner.id,
    displayName: inner.displayName,
    detect: () => inner.detect(),
    capabilities: () => inner.capabilities(),
    models: () => inner.models(),
    openSession: async (opts) => {
      state.opens += 1;
      await gate;
      return inner.openSession(opts);
    },
  };
  return { adapter, state, release: () => release() };
}

describe("session.start", () => {
  it("refuses a second start while the first is still opening the session (#208)", async () => {
    const fake = slowFake();
    const running = new SessionHost(new ProviderRegistry([fake.adapter]), () => {});
    host = running;
    const start = () =>
      running.start({
        name: "session.start",
        sessionId: "s1",
        providerId: "fake",
        options,
        checkpoints: false,
      });
    const first = start();
    // A second open would run the conversation twice, one of them with a retired MCP token.
    await expect(start()).rejects.toMatchObject({ code: "session_exists" });
    fake.release();
    await first;
    expect(fake.state.opens).toBe(1);
    expect(running.list().map((s) => s.sessionId)).toEqual(["s1"]);
    await expect(start()).rejects.toMatchObject({ code: "session_exists" });
  });

  it("reports how the provider classified a refused open (#269)", async () => {
    const inner = new FakeProvider();
    const message = "Gemini CLI 0.36.0 is too old (needs 0.68.0+).";
    const adapter: ProviderAdapter = {
      id: inner.id,
      displayName: inner.displayName,
      detect: () => inner.detect(),
      capabilities: () => inner.capabilities(),
      models: () => inner.models(),
      openSession: async () => {
        throw new ProviderSessionError("version_unsupported", message, "setup");
      },
    };
    const events: RunnerEvent[] = [];
    host = new SessionHost(new ProviderRegistry([adapter]), (e) => events.push(e));
    await expect(
      host.start({ name: "session.start", sessionId: "s1", providerId: "fake", options }),
    ).rejects.toMatchObject({ code: "open_failed" });
    expect(events.at(-1)).toEqual({
      kind: "session.process",
      sessionId: "s1",
      state: "crashed",
      error: { code: "open_failed", message, kind: "setup" },
    });
  });
});

describe("session.start on a provider the machine's security rules don't cover", () => {
  /** The Fake provider, declaring nothing about the rules (absent counts as not covered). */
  function uncovered() {
    const inner = new FakeProvider();
    const opened: SessionOptions[] = [];
    const { enforcesSecurityRules: _drop, ...caps } = inner.capabilities();
    const adapter: ProviderAdapter = {
      id: inner.id,
      displayName: inner.displayName,
      detect: () => inner.detect(),
      capabilities: () => caps,
      models: () => inner.models(),
      openSession: async (opts) => {
        opened.push(opts);
        return inner.openSession(opts);
      },
    };
    return { adapter, opened };
  }

  it("refuses it (fail closed) unless the session's project allows such providers", async () => {
    const { adapter, opened } = uncovered();
    host = new SessionHost(new ProviderRegistry([adapter]), () => {});
    await expect(
      host.start({ name: "session.start", sessionId: "s1", providerId: "fake", options }),
    ).rejects.toMatchObject({ code: "security_rules_unenforced" });
    expect(opened).toHaveLength(0);
    await host.start({
      name: "session.start",
      sessionId: "s2",
      providerId: "fake",
      options: { ...options, sessionId: "s2", allowUnenforcedProviders: true },
    });
    expect(opened).toHaveLength(1);
  });
});

describe("session.start for the read-only roles", () => {
  it("never lets the orchestrator take a project's exception, and needs enforced read-only", async () => {
    const inner = new FakeProvider();
    const { enforcesSecurityRules: _drop, ...uncovered } = inner.capabilities();
    const make = (caps: ReturnType<FakeProvider["capabilities"]>): ProviderAdapter => ({
      id: inner.id,
      displayName: inner.displayName,
      detect: () => inner.detect(),
      capabilities: () => caps,
      models: () => inner.models(),
      openSession: (opts) => inner.openSession(opts),
    });
    host = new SessionHost(new ProviderRegistry([make(uncovered)]), () => {});
    await expect(
      host.start({
        name: "session.start",
        sessionId: "o1",
        providerId: "fake",
        options: { ...options, role: "orchestrator", allowUnenforcedProviders: true },
      }),
    ).rejects.toMatchObject({ code: "security_rules_unenforced" });
    await host.closeAll();
    const { readOnly: _ro, ...noReadOnly } = inner.capabilities();
    host = new SessionHost(new ProviderRegistry([make(noReadOnly)]), () => {});
    await expect(
      host.start({
        name: "session.start",
        sessionId: "p1",
        providerId: "fake",
        options: { ...options, role: "pm" },
      }),
    ).rejects.toMatchObject({ code: "read_only_unsupported" });
  });
});

describe("session.start on a provider whose rules cover worktrees only", () => {
  it("refuses an agent session outside a CodeDen worktree unless the project allowed it", async () => {
    const inner = new FakeProvider();
    const adapter: ProviderAdapter = {
      id: inner.id,
      displayName: inner.displayName,
      detect: () => inner.detect(),
      capabilities: () => ({ ...inner.capabilities(), securityRulesWorktreesOnly: true }),
      models: () => inner.models(),
      openSession: (opts) => inner.openSession(opts),
    };
    host = new SessionHost(new ProviderRegistry([adapter]), () => {});
    await expect(
      host.start({ name: "session.start", sessionId: "a1", providerId: "fake", options }),
    ).rejects.toMatchObject({ code: "security_rules_unenforced" });
    await host.start({
      name: "session.start",
      sessionId: "a2",
      providerId: "fake",
      options: { ...options, sessionId: "a2", inCodedenWorktree: true },
    });
  });
});
