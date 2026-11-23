import { ProviderInfo } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { getProvider, listProviders, providerInfo } from "../src";
import { FakeProvider } from "../src/fake/adapter";

describe("provider registry", () => {
  it("lists the built-in providers with honest capabilities", () => {
    expect(listProviders().map((p) => p.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "cursor",
      "gemini",
      "antigravity",
    ]);
    const claude = getProvider("claude");
    const codex = getProvider("codex");
    expect(claude?.capabilities()).toMatchObject({ subagents: true, planMode: true, steer: true });
    expect(codex?.capabilities()).toMatchObject({ subagents: true, planMode: false, steer: true });
    expect(getProvider("opencode")?.capabilities()).toMatchObject({
      subagents: true,
      planMode: false,
      steer: true,
      liveAutonomy: true,
    });
    // Cursor: ACP has no steering, and subagents are not wired up yet.
    expect(getProvider("cursor")?.capabilities()).toMatchObject({
      subagents: false,
      planMode: true,
      steer: false,
      readOnly: true,
      liveAutonomy: true,
    });
    // Gemini CLI: no questions over ACP (it drops its ask_user tool), no steering.
    const gemini = getProvider("gemini");
    expect(gemini?.displayName).toBe("Gemini CLI");
    expect(gemini?.capabilities()).toMatchObject({
      userQuestions: false,
      planMode: true,
      steer: false,
      readOnly: true,
      liveAutonomy: true,
    });
    // Antigravity CLI: its thinking level is CodeDen's effort; no steering over ACP.
    const antigravity = getProvider("antigravity");
    expect(antigravity?.displayName).toBe("Antigravity CLI");
    expect(antigravity?.capabilities()).toMatchObject({
      reasoningEffort: true,
      skills: true,
      planMode: true,
      steer: false,
      readOnly: false,
      modelListAtStart: true,
      liveAutonomy: true,
    });
    for (const p of listProviders()) {
      ProviderInfo.parse(providerInfo(p));
      // Cursor and Gemini CLI offer no one-shot calls for the utility model.
      if (p.utilityModel) expect(p.utilityModel().providerId).toBe(p.id);
    }
    expect(getProvider("nope")).toBeUndefined();
  });
});

describe("which built-in providers the machine's security rules cover", () => {
  it("is declared only by those whose sessions run under the guard or execpolicy", () => {
    const covered = (id: string) => getProvider(id)?.capabilities().enforcesSecurityRules;
    // The guard covers Claude Code sessions, execpolicy Codex's; the Fake provider runs no tools.
    expect(covered("claude")).toBe(true);
    expect(covered("codex")).toBe(true);
    expect(new FakeProvider().capabilities().enforcesSecurityRules).toBe(true);
    // The rest declare nothing, which counts as not covered (fail closed), or false.
    for (const id of ["cursor", "gemini", "opencode", "antigravity"]) {
      expect(covered(id)).not.toBe(true);
    }
  });
});
