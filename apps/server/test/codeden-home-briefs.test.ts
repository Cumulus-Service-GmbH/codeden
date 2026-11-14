import { describe, expect, it } from "vitest";
import { agentPrompt, type PromptSession } from "../src/mcp/prompt";
import { builderPrompt, reviewerPrompt } from "../src/services/factory/prompts";
import { lensPrompt, scoutPlanPrompt } from "../src/services/factory/prompts-scout";
import { rolePrompt } from "../src/services/orchestration/prompts";

/**
 * Agents are told plainly to keep out of CodeDen's own home and database (#320): CodeDen state
 * reaches them through the CodeDen MCP tools. The classifier asks when they try anyway
 * (`packages/providers/test/codeden-home-reads.test.ts`). No brief names the home's path.
 */
const RULE =
  "Never read or list CodeDen's own home or database; use the CodeDen MCP tools for CodeDen state.";

const item = (over: Record<string, unknown> = {}) =>
  ({
    id: "i1",
    source: "issue",
    area: null,
    type: "bug",
    title: "Crash on save",
    summary: "Saving an empty task crashes.",
    acceptanceCriteria: ["Saving an empty task works"],
    issue: { number: 7, url: "https://github.com/acme/app/issues/7", title: "Crash on save" },
    investigation: null,
    pr: { number: 9, url: "https://github.com/acme/app/pull/9", state: "open" },
    ...over,
  }) as never;

const agent: PromptSession = {
  role: "agent",
  startedBy: { kind: "pm", id: "pm-1" },
  worktreePath: "/home/me/.codeden/wt/shop/abcd1234",
  autonomy: "auto",
};

/** Every brief a factory role, a PM, the orchestrator or an agent session starts from. */
function briefs(): Record<string, string> {
  return {
    "builder (bug)": builderPrompt(item(), "v"),
    "builder (feature)": builderPrompt(item({ type: "feature" }), "v"),
    "builder (docs)": builderPrompt(item({ type: "docs" }), "v"),
    reviewer: reviewerPrompt(item(), "v", null, null, false),
    "reviewer (local)": reviewerPrompt(item(), "v", null, "main", true),
    scout: scoutPlanPrompt({
      round: 1,
      vision: "v",
      defaultBranch: "main",
      areas: ["performance"],
      maxLenses: 1,
      maxIssues: 3,
      known: [],
      firstRound: true,
    }),
    "area reviewer": lensPrompt({
      area: "performance",
      focus: "the event log",
      vision: "v",
      defaultBranch: "main",
      known: [],
      firstRun: true,
    }),
    pm: rolePrompt("pm"),
    orchestrator: rolePrompt("orchestrator"),
    agent: agentPrompt(agent, { kind: "github" }),
  };
}

describe("CodeDen's home in the briefs (#320)", () => {
  it("every role's brief states the rule", () => {
    for (const [role, text] of Object.entries(briefs())) {
      expect(text, role).toContain(RULE);
    }
  });

  it("no brief names the home's path or its variable", () => {
    for (const [role, text] of Object.entries(briefs())) {
      expect(text, role).not.toContain("CODEDEN_HOME");
      expect(text, role).not.toMatch(/[~/\\]\.codeden\b/);
    }
  });
});
