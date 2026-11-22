import { describe, expect, it } from "vitest";
import { Project, securityRulesCover, UpdateProjectRequest } from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

describe("allowing providers without enforced security rules, per project", () => {
  it("is off by default (fail closed), also for projects written before the setting existed", () => {
    const { allowUnenforcedProviders: _a, ...rest } = {
      ...sampleProject,
      allowUnenforcedProviders: true,
    };
    expect(Project.parse(rest).allowUnenforcedProviders).toBe(false);
  });

  it("round-trips a project that turned it on", () => {
    const on = roundTrip(Project, { ...sampleProject, allowUnenforcedProviders: true });
    expect(on.allowUnenforcedProviders).toBe(true);
    expect(Project.safeParse({ ...sampleProject, allowUnenforcedProviders: "yes" }).success).toBe(
      false,
    );
  });

  it("is changed through the project update request", () => {
    expect(roundTrip(UpdateProjectRequest, { allowUnenforcedProviders: true })).toEqual({
      allowUnenforcedProviders: true,
    });
  });
});

describe("whether the machine's security rules cover a session", () => {
  const worktreesOnly = { enforcesSecurityRules: true, securityRulesWorktreesOnly: true };
  it("covers a worktree session, and a read-only role anywhere, on a worktrees-only provider", () => {
    expect(securityRulesCover(worktreesOnly, { role: "agent", inCodedenWorktree: true })).toBe(
      true,
    );
    expect(securityRulesCover(worktreesOnly, { role: "pm" })).toBe(true);
    expect(securityRulesCover(worktreesOnly, { role: "orchestrator" })).toBe(true);
  });

  it("doesn't cover an agent session outside a worktree, or any provider that declares nothing", () => {
    expect(securityRulesCover(worktreesOnly, { role: "agent" })).toBe(false);
    expect(securityRulesCover({}, { role: "agent", inCodedenWorktree: true })).toBe(false);
    expect(securityRulesCover({ enforcesSecurityRules: true }, { role: "agent" })).toBe(true);
  });
});
