import type { Team } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startSession } from "../src/mcp/tools/pm/sessions";
import type { AppServices } from "../src/services/container";
import { createFactoryEnv } from "./support/factory-env";

let env: ReturnType<typeof createFactoryEnv>;
const launch = vi.fn().mockResolvedValue({ status: "started", sessionId: "agent" });
const member = { role: "writer", provider: "fake", model: "pinned", effort: "high" } as const;
const input = { purpose: "Write a feature", prompt: "Add a counter", title: "[Writer] Counter" };

beforeEach(() => {
  env = createFactoryEnv({ providers: ["fake", "codex"] });
  launch.mockClear();
});
afterEach(() => env.close());

function setTeam(team: Team) {
  const { data } = env.factory;
  const loop = data.loopOrNew(env.project.id);
  data.saveLoop({ ...loop, tuning: { ...loop.tuning, team } });
}

function start(
  overrides: Partial<typeof input> & { provider?: string; model?: string; effort?: "low" } = {},
) {
  return startSession.handler(startSession.input.parse({ ...input, ...overrides }), {
    services: {
      factory: env.factory,
      projects: { get: () => env.project },
      sessions: { start: launch },
    } as unknown as AppServices,
    role: "pm",
    sessionId: null,
    projectId: env.project.id,
    caller: "mcp",
    signal: new AbortController().signal,
  });
}

it("fills Team pins and preserves free choices for unpinned, untagged and empty teams", async () => {
  setTeam([member]);
  await start();
  expect(launch.mock.lastCall?.[0]).toMatchObject({
    provider: "fake",
    model: "pinned",
    effort: "high",
  });
  setTeam([{ ...member, model: null, effort: null }]);
  await start({ model: "different", effort: "low" });
  expect(launch.mock.lastCall?.[0]).toMatchObject({
    provider: "fake",
    model: "different",
    effort: "low",
  });
  setTeam([member]);
  await start({ title: "Counter" });
  expect(launch.mock.lastCall?.[0]).not.toHaveProperty("provider");
  setTeam([]);
  await start();
  expect(launch.mock.lastCall?.[0]).not.toHaveProperty("provider");
});

it.each([
  ["provider", "codex"],
  ["model", "default"],
  ["effort", "low"],
] as const)("rejects a conflicting %s", async (field, value) => {
  setTeam([member]);
  await expect(start({ [field]: value })).rejects.toThrow(
    `TEAM_MISMATCH: [Writer] in this project's Team is fake / pinned / high; got ${field} ${value}`,
  );
});

it("accepts exact resolved model IDs for the Team provider", async () => {
  env.models.fake = [
    { id: "pinned", resolvedId: "canonical", label: "Pinned", efforts: [] },
    { id: "alias", resolvedId: "canonical", label: "Alias", efforts: [] },
  ];
  env.models.codex = [{ id: "other", resolvedId: "canonical", label: "Other", efforts: [] }];
  setTeam([member]);
  await start({ model: "canonical" });
  expect(launch.mock.lastCall?.[0]).toMatchObject({ model: "canonical" });
  await start({ model: "alias" });
  expect(launch.mock.lastCall?.[0]).toMatchObject({ model: "alias" });
  await expect(start({ model: "other" })).rejects.toThrow("got model other");
  await expect(start({ model: "Pinned" })).rejects.toThrow("got model Pinned");
});
