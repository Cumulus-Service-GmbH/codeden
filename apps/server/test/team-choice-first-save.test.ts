import { Team } from "@codeden/contracts";
import { expect, it } from "vitest";
import { createFactoryEnv } from "./support/factory-env";

it("keeps inherited roles out of the first saved factory settings draft", async () => {
  const env = createFactoryEnv();
  try {
    const { factory, project } = env;
    const team = Team.parse([{ role: "writer", provider: "claude", model: "sonnet" }]);
    env.settings.update({ teamSetup: { remembered: true, team, resultSummaryBytes: 256 } });

    expect(factory.data.loop(project.id)).toBeUndefined();
    const { team: draftTeam, resultSummaryBytes } = (await factory.status(project.id)).tuning;
    const tuning = { team: draftTeam, resultSummaryBytes };
    expect(tuning).toEqual({ team: [], resultSummaryBytes: 256 });
    expect(factory.data.loop(project.id)).toBeUndefined();

    await factory.setMode(project.id, {
      mode: "software_factory",
      limits: project.factoryLimits,
      tuning,
    });
    expect(factory.data.loop(project.id)?.tuning).toMatchObject(tuning);
  } finally {
    env.close();
  }
});

it("omits the Team effort from factory starts when the provider does not report support", async () => {
  const env = createFactoryEnv();
  try {
    await env.factory.ctx.sessions.startScout(env.project.id, "Scout", {
      provider: "claude",
      model: "sonnet",
      effort: "high",
    });

    expect(env.starts[0]).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(env.starts[0]).not.toHaveProperty("effort");
  } finally {
    env.close();
  }
});
