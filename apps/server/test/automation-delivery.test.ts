import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Settings } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { reviewedAutomationHead } from "../src/services/automations/delivery";
import { automationBlocked, automationFork } from "../src/services/automations/policy";
import { type Exec, runTool } from "../src/services/exec";
import { removeTree } from "./support/remove-tree";

const upstream = {
  owner: "upstream",
  repo: "widgets",
  defaultBranch: "main",
  remoteUrl: "upstream",
};
const fork = { owner: "team", repo: "widgets", remote: "fork" };
const project = {
  kind: "github",
  github: { ...upstream, forkRemote: fork },
  killSwitch: false,
} as Project;

describe("built-in automation controls", () => {
  it("blocks on the master, the project switch, and either factory kill switch", () => {
    const settings = { automations: { enabled: true }, factory: { killSwitch: false } } as Settings;
    expect(automationBlocked(project, settings, true)).toBeNull();
    expect(automationBlocked(project, settings, false)).toMatch(/automations/i);
    expect(
      automationBlocked(project, { ...settings, automations: { enabled: false } }, true),
    ).toMatch(/automations/i);
    expect(
      automationBlocked(project, { ...settings, factory: { killSwitch: true } }, true),
    ).toMatch(/kill switch/i);
    expect(automationBlocked({ ...project, killSwitch: true }, settings, true)).toMatch(
      /kill switch/i,
    );
  });

  it("uses the bound fork and refuses the upstream origin or an unset binding", () => {
    expect(automationFork(project)).toMatchObject({ ...fork, defaultBranch: "main" });
    expect(() => automationFork({ ...project, github: upstream } as Project)).toThrow(
      /fork remote/i,
    );
    expect(() =>
      automationFork({
        ...project,
        github: { ...upstream, forkRemote: { ...fork, owner: "UPSTREAM" } },
      } as Project),
    ).toThrow(/upstream/i);
  });

  it("rejects a mismatched push URL before running the review check", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: "https://github.com/upstream/widgets.git\n",
      stderr: "",
      notFound: false,
      timedOut: false,
      path: null,
    }));
    await expect(
      reviewedAutomationHead(
        exec,
        "/scratch/project",
        "/scratch/team.json",
        automationFork(project),
        "run",
        "writer",
        "/scratch/home",
      ),
    ).rejects.toThrow(/push URL/i);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

it("accepts a clean receipt only when it covers the commit being delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeden-automation-review-"));
  const scripts = join(dir, ".claude", "skills", "trioharness-codeden", "scripts");
  const script = join(scripts, "team-review.mjs");
  const head = "a".repeat(40);
  const stale = "b".repeat(40);
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd !== "git") return runTool(cmd, args, opts);
    return {
      code: 0,
      stdout: args[0] === "remote" ? "https://github.com/team/widgets.git" : head,
      stderr: "",
      notFound: false,
      timedOut: false,
      path: null,
    };
  };
  const receipt = (reviewedHead: string, verdict: string) => {
    writeFileSync(
      script,
      `export const checkRun = () => ({ ok: true, highRisk: false });
      export const readRounds = () => ${JSON.stringify([
        {
          head: reviewedHead,
          verdict,
          status: "completed",
          slot: "primary",
          writer: { provider: "codex" },
        },
      ])};`,
    );
  };
  const reviewed = () =>
    reviewedAutomationHead(
      exec,
      dir,
      join(dir, "team.json"),
      automationFork(project),
      "run",
      "codex",
      dir,
    );
  try {
    mkdirSync(scripts, { recursive: true });
    receipt(stale, "CLEAN");
    await expect(reviewed()).rejects.toThrow(/clean Team review receipt/);
    receipt(head, "FINDINGS");
    await expect(reviewed()).rejects.toThrow(/clean Team review receipt/);
    receipt(head, "CLEAN");
    await expect(reviewed()).resolves.toBe(head);
  } finally {
    removeTree(dir);
  }
});
