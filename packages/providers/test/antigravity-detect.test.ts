import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpSessionSetup } from "../src/acp/protocol";
import { AntigravityAdapter } from "../src/antigravity/adapter";
import {
  ANTIGRAVITY_INSTALL_COMMAND,
  antigravityInstallCommand,
  detectAntigravity,
  isSupportedAntigravityVersion,
} from "../src/antigravity/detect";
import {
  antigravityModelInfos,
  fallbackAntigravityModels,
  thoughtLevel,
} from "../src/antigravity/models";
import { probeAntigravity } from "../src/antigravity/probe";
import type { ResolvedCommand } from "../src/util/exec";
import { clearExecutableCache } from "../src/util/locate";

const fixtures = join(import.meta.dirname, "fixtures", "fake-agy");
const fakeAgy = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(fixtures, "agy.mjs"),
};
/** agy 1.5.13's real `session/new` reply. */
const captured = JSON.parse(readFileSync(join(fixtures, "capture.json"), "utf8")) as {
  sessionNew: AcpSessionSetup;
};

afterEach(() => {
  for (const key of [
    "FAKE_AGY_VERSION",
    "FAKE_AGY_NO_ACP",
    "FAKE_AGY_NEW_HANG",
    "FAKE_AGY_DROP_MODEL",
  ])
    delete process.env[key];
  clearExecutableCache();
});

describe("Antigravity CLI versions, models and thinking levels", () => {
  it("supports 1.5.12 and later", () => {
    expect(isSupportedAntigravityVersion("1.5.12")).toBe(true);
    expect(isSupportedAntigravityVersion("1.5.13")).toBe(true);
    expect(isSupportedAntigravityVersion("1.6.0")).toBe(true);
    expect(isSupportedAntigravityVersion("1.5.11")).toBe(false);
    expect(isSupportedAntigravityVersion(null)).toBe(false);
  });

  it("maps CodeDen's efforts to the nearest thinking level the session lists", () => {
    const listed = ["low", "medium", "high", "xhigh"];
    expect(thoughtLevel("minimal", listed)).toBe("low");
    expect(thoughtLevel("low", listed)).toBe("low");
    expect(thoughtLevel("medium", listed)).toBe("medium");
    expect(thoughtLevel("high", listed)).toBe("high");
    expect(thoughtLevel("xhigh", listed)).toBe("xhigh");
    // No `max` here: the nearest lower level.
    expect(thoughtLevel("max", listed)).toBe("xhigh");
    expect(thoughtLevel("max", [...listed, "max"])).toBe("max");
    // Nothing lower listed: the nearest higher one.
    expect(thoughtLevel("minimal", ["medium", "high"])).toBe("medium");
    expect(thoughtLevel("high", [])).toBeUndefined();
  });

  it("lists each model once, with the thinking levels its variants offer", () => {
    const models = antigravityModelInfos(captured.sessionNew) ?? [];
    expect(models.map((m) => m.id)).toEqual([
      "default",
      "gemini-4-neon",
      "gemini-4-argon",
      "gemini-4-hydrogen",
      "gemini-pro-orchestrator-neon",
      "gemini-pro-orchestrator-g1-pro",
      "gemini-3.8-flash",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gpt-oss-120b-medium",
    ]);
    const byId = new Map(models.map((m) => [m.id, m]));
    expect(byId.get("default")).toMatchObject({
      isDefault: true,
      efforts: ["low", "medium", "high", "xhigh"],
    });
    expect(byId.get("gemini-4-neon")).toMatchObject({
      label: "Gemini 4 Neon",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
    });
    expect(byId.get("gemini-4-argon")?.efforts).toEqual(["low", "medium", "high"]);
    // One fixed level, no variants: no efforts.
    expect(byId.get("gpt-oss-120b-medium")?.efforts).toEqual([]);
    expect(byId.get("gpt-oss-120b-medium")?.defaultEffort).toBeUndefined();
  });

  it("lists Default at the documented levels before any session", () => {
    expect(fallbackAntigravityModels()).toEqual([
      expect.objectContaining({ id: "default", efforts: ["low", "medium", "high", "xhigh"] }),
    ]);
    expect(antigravityModelInfos({})).toBeUndefined();
  });
});

describe("detectAntigravity", () => {
  const probe = (exe: ResolvedCommand) => probeAntigravity(exe, { timeoutMs: 10_000 });

  it("reports the version and ACP support of a working CLI, its login as unknown", async () => {
    const status = await detectAntigravity({ executable: fakeAgy, probe });
    expect(status).toMatchObject({
      providerId: "antigravity",
      installed: true,
      version: "1.5.13",
      loggedIn: null,
      supported: true,
      issues: [],
    });
  });

  it("asks for an update below 1.5.12 without starting the CLI's ACP server", async () => {
    process.env.FAKE_AGY_VERSION = "1.5.11";
    let probed = false;
    const status = await detectAntigravity({
      executable: fakeAgy,
      probe: async () => {
        probed = true;
        return { acp: true };
      },
    });
    expect(probed).toBe(false);
    expect(status.supported).toBe(false);
    expect(status.issues).toEqual([
      {
        code: "version_unsupported",
        message: "Antigravity CLI 1.5.11 is too old (needs 1.5.12+). Update it.",
        fix: { kind: "upgrade", command: antigravityInstallCommand() },
        minVersion: "1.5.12",
      },
    ]);
  });

  it("flags a CLI whose ACP server doesn't answer", async () => {
    process.env.FAKE_AGY_NO_ACP = "1";
    const status = await detectAntigravity({ executable: fakeAgy, probe });
    expect(status.supported).toBe(false);
    expect(status.issues).toEqual([expect.objectContaining({ code: "version_unsupported" })]);
  });

  it("runs the real handshake when no probe is given", async () => {
    process.env.FAKE_AGY_NO_ACP = "1";
    const status = await detectAntigravity({ executable: fakeAgy, timeoutMs: 10_000 });
    expect(status.supported).toBe(false);
  });

  it("opens the install instructions on native Windows, whose shell has no Bash", () => {
    expect(antigravityInstallCommand("win32")).toBe("start https://antigravity.google/docs/cli");
    expect(antigravityInstallCommand("darwin")).toBe(ANTIGRAVITY_INSTALL_COMMAND);
  });

  it("reports the installer when nothing is installed", async () => {
    const status = await detectAntigravity({
      locate: { pathEnv: "", knownLocations: [], platform: "linux" },
    });
    expect(status.installed).toBe(false);
    expect(status.issues[0]).toMatchObject({
      code: "not_installed",
      fix: { kind: "install", command: antigravityInstallCommand() },
    });
  });

  it("refines its flags from the CLI's real `initialize` answer", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    await adapter.detect();
    expect(adapter.capabilities()).toMatchObject({
      resume: true,
      images: true,
      mcp: true,
      planMode: true,
      approvals: true,
      readOnly: true,
      liveAutonomy: true,
      reasoningEffort: true,
      skills: true,
      userQuestions: false,
      subagents: false,
      steer: false,
      fork: false,
    });
  });
});

describe("the Antigravity CLI's models before any session", () => {
  it("are read at detection from a throwaway session, with no prompt sent", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy });
    expect(adapter.models().map((m) => m.id)).toEqual(["default"]);
    await adapter.detect();
    const ids = adapter.models().map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["default", "gemini-4-neon", "claude-opus-5-5"]));
  });

  it("stay Default when the throwaway session doesn't answer in time, and detection still passes", async () => {
    process.env.FAKE_AGY_NEW_HANG = "1";
    const adapter = new AntigravityAdapter({ executable: fakeAgy, listTimeoutMs: 300 });
    const status = await adapter.detect();
    expect(status).toMatchObject({ installed: true, supported: true, issues: [] });
    expect(adapter.models().map((m) => m.id)).toEqual(["default"]);
  });
});

describe("probeAntigravity's reports", () => {
  it("keep a working handshake working when the caller's report throws", async () => {
    const result = await probeAntigravity(fakeAgy, {
      timeoutMs: 10_000,
      onInfo: () => {
        throw new Error("caller failed");
      },
      onSetup: () => {
        throw new Error("caller failed");
      },
    });
    expect(result.acp).toBe(true);
    expect(result.setup?.configOptions?.length).toBeGreaterThan(0);
  });
});
