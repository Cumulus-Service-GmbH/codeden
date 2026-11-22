import { FactoryTuning, Team } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  builderWanted,
  chooseAgent,
  needsFreshSession,
  scoutAgent,
} from "../src/services/factory/agent-choice";
import { pickReviewer } from "../src/services/factory/reviewer-choice";
import { createFactoryEnv } from "./support/factory-env";

const legacy = {
  builderProvider: "codex",
  builderModel: "legacy",
  docsBuilderProvider: "codex",
  docsBuilderModel: "docs",
  scoutProvider: "codex",
  scoutModel: "scout",
  reviewerProvider: "codex",
  reviewerModel: "review",
};
const team = Team.parse(
  ["writer", "agentsMdWriter", "architect", "reviewer"].map((role) => ({
    role,
    provider: "claude",
    model: role,
    effort: "high",
  })),
);
let env: ReturnType<typeof createFactoryEnv>;
beforeEach(() => {
  env = createFactoryEnv({ providers: ["codex", "claude"] });
});
afterEach(() => env.close());

function reviewer(tuning: FactoryTuning, available = ["codex", "claude"]) {
  return pickReviewer({
    tuning,
    available,
    unavailable: [],
    author: { provider: "codex", model: "author" },
  });
}

it("keeps legacy choices with an empty team", () => {
  const tuning = FactoryTuning.parse(legacy);
  expect(builderWanted({ type: "bug" }, tuning)).toEqual({ provider: "codex", model: "legacy" });
  expect(builderWanted({ type: "docs" }, tuning)).toEqual({ provider: "codex", model: "docs" });
  expect(scoutAgent(env.factory.ctx, env.project, tuning).choice).toEqual({
    provider: "codex",
    model: "scout",
  });
  const review = reviewer(tuning);
  expect(review).toMatchObject({ provider: "codex", model: "review" });
  expect(review).not.toHaveProperty("effort");
});

it("uses the Team choices and replaces a scout with a different pinned effort", () => {
  const tuning = FactoryTuning.parse({ ...legacy, team });
  expect(builderWanted({ type: "bug" }, tuning)).toEqual({
    provider: "claude",
    model: "writer",
    effort: "high",
  });
  expect(builderWanted({ type: "docs" }, tuning)).toEqual({
    provider: "claude",
    model: "agentsMdWriter",
    effort: "high",
  });
  const scout = scoutAgent(env.factory.ctx, env.project, tuning);
  expect(scout.choice).toEqual({ provider: "claude", model: "architect", effort: "high" });
  expect(
    needsFreshSession(
      { provider: "claude", model: "architect", effort: "low" },
      { ...scout, reasoningEffort: true },
      [],
    ),
  ).toBe(true);
  expect(reviewer(tuning)).toMatchObject({ provider: "claude", model: "reviewer", effort: "high" });
  const fallback = reviewer(tuning, ["codex"]);
  expect(fallback).toMatchObject({
    provider: "codex",
    model: "author",
  });
  expect(fallback).not.toHaveProperty("effort");
});

it("drops a pinned model and effort when its provider is unavailable", async () => {
  env.detected.claude = { loggedIn: false };
  env.factory.ctx.sessions.refreshAvailability();
  await new Promise((resolve) => setImmediate(resolve));
  const wanted = { provider: "claude", model: "writer", effort: "high" } as const;
  expect(chooseAgent(env.factory.ctx, env.project, wanted, "build")).toStrictEqual({
    provider: "codex",
    model: null,
  });
});

it("seeds only new loops when setup is remembered", () => {
  const { data } = env.factory;
  const projectId = env.project.id;
  env.settings.update({ teamSetup: { remembered: false, team, resultSummaryBytes: 256 } });
  const existing = data.saveLoop(data.loopOrNew(projectId));
  expect(existing.tuning).toMatchObject({ team: [], resultSummaryBytes: null });
  env.settings.update({ teamSetup: { remembered: true } });
  const draft = data.loopOrNew("new-project");
  expect(draft.tuning).toMatchObject({ team, resultSummaryBytes: 256 });
  expect(data.loop("new-project")).toBeUndefined();
  expect(data.saveLoop(draft).tuning).toMatchObject({ team, resultSummaryBytes: 256 });
  expect(data.loop("new-project")?.tuning).toMatchObject({ team, resultSummaryBytes: 256 });
  expect(data.loopOrNew(projectId)).toEqual(existing);
});

it("uses the legacy docs builder before the Team writer, then falls back to that writer", () => {
  const writers = team.filter(({ role }) => role === "writer");
  const tuning = FactoryTuning.parse({ ...legacy, team: writers });
  expect(builderWanted({ type: "docs" }, tuning)).toEqual({ provider: "codex", model: "docs" });
  expect(builderWanted({ type: "docs" }, { ...tuning, docsBuilderProvider: null })).toEqual({
    provider: "claude",
    model: "writer",
    effort: "high",
  });
});
