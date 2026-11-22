import {
  TokenSaverSettings as Schema,
  Settings,
  type TokenSaverSettings,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { tokenSaverNote } from "../src/services/sessions/token-saver";
import { deepMerge } from "../src/settings-store";
import { sampleSession } from "./helpers";

// #602: the token saver note rides on the system prompt, at the session's resolved level.
function launcher(tokenSaver?: TokenSaverSettings): SessionLauncher {
  return new SessionLauncher({
    runner: { mcpProxyUrl: () => null, providers: () => [] },
    projects: { get: () => null },
    home: "/tmp/codeden-home",
    ...(tokenSaver ? { tokenSaver: () => tokenSaver } : {}),
  } as unknown as LauncherDeps);
}

const p = "p1";
const sessionKinds = [
  { kind: "user session", role: "agent", startedBy: { kind: "user" }, projectId: p },
  { kind: "project manager", role: "pm", startedBy: { kind: "user" }, projectId: p },
  { kind: "orchestrator", role: "orchestrator", startedBy: { kind: "user" }, projectId: null },
  { kind: "factory builder", role: "agent", startedBy: { kind: "pm" }, projectId: p },
  { kind: "factory reviewer", role: "agent", startedBy: { kind: "pm" }, projectId: p },
  { kind: "scout", role: "agent", startedBy: { kind: "pm" }, projectId: p },
  { kind: "automation", role: "agent", startedBy: { kind: "automation" }, projectId: p },
  { kind: "PM hand-off", role: "agent", startedBy: { kind: "orchestrator" }, projectId: p },
] as const;
const providers = ["claude", "codex", "opencode", "gemini", "cursor", "agy", "fake"];

it("includes a standing background-wait instruction in every session note", () => {
  const plain = launcher(Schema.parse({ default: "off" }));
  for (const provider of providers) {
    for (const { kind, ...fields } of sessionKinds) {
      const prompt = plain.sessionOptions({ ...sampleSession, ...fields, provider }).systemPrompt;
      expect(prompt, `${kind} on ${provider}`).toContain(
        "Run long waits in the background and check their progress between short steps to keep the turn responsive to new messages.",
      );
    }
  }
});

describe("token saver note", () => {
  it("is absent when off or not configured", () => {
    expect(tokenSaverNote("off")).toBeNull();
    const plain = launcher().sessionOptions(sampleSession).systemPrompt;
    expect(plain).not.toContain("Token saver");
    expect(
      launcher(Schema.parse({ default: "off" })).sessionOptions(sampleSession).systemPrompt,
    ).toBe(plain);
  });

  it("reaches every kind of session CodeDen starts, on every provider", () => {
    const lite = launcher(Schema.parse({ default: "lite" }));
    // Providers with and without `capabilities.systemPrompt` (Claude Code, Codex, ACP agents).
    for (const provider of providers) {
      for (const { kind, ...fields } of sessionKinds) {
        const session = { ...sampleSession, ...fields, provider };
        const prompt = lite.sessionOptions(session).systemPrompt ?? "";
        expect(prompt, `${kind} on ${provider}`).toContain("Token saver is on for this session");
      }
    }
  });

  it("adds more terse rules per level and always keeps the exceptions", () => {
    const lite = tokenSaverNote("lite") ?? "";
    const full = tokenSaverNote("full") ?? "";
    const ultra = tokenSaverNote("ultra") ?? "";
    for (const note of [lite, full, ultra]) {
      expect(note).toContain("Never drop the words not, never, no or only.");
      expect(note).toContain(
        "Use plain full sentences for security warnings, irreversible actions",
      );
      expect(note).toContain("Code: write the least code");
      expect(note).toContain("Tools: search narrowly");
    }
    expect(lite).not.toContain("Sentence fragments");
    expect(full).toContain("Sentence fragments");
    expect(full).not.toContain("telegraphically");
    expect(ultra).toContain("telegraphically");
  });

  it("appends the project's override, else the role default, else the global level", () => {
    const settings = Schema.parse({
      default: "lite",
      roles: { pm: "off" },
      projects: { p1: { level: "ultra" } },
    });
    const inProject = { ...sampleSession, projectId: "p1" };
    const prompt = (s = inProject) => launcher(settings).sessionOptions(s).systemPrompt ?? "";
    expect(prompt()).toContain("Token saver is on for this session (ultra).");
    const elsewhere = { ...sampleSession, projectId: "other" };
    expect(prompt(elsewhere)).toContain("Token saver is on for this session (lite).");
    expect(prompt({ ...elsewhere, role: "pm" })).not.toContain("Token saver");
  });
});

describe("token saver settings patches", () => {
  it("clears a project override and a role default with null", () => {
    const base = Settings.parse({
      tokenSaver: { roles: { pm: "full" }, projects: { p1: { level: "ultra" } } },
    });
    const next = Settings.parse(
      deepMerge(base, { tokenSaver: { roles: { pm: null }, projects: { p1: null } } }),
    );
    expect(next.tokenSaver.projects).toEqual({});
    expect(next.tokenSaver.roles.pm).toBeNull();
  });
});
