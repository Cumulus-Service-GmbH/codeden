import { Settings, type Team } from "@codeden/contracts";
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
      projectTeam: () => env.factory.data.loop(env.project.id)?.tuning.team ?? [],
      projects: { get: () => env.project },
      settings: { get: () => Settings.parse({}) },
      sessions: { start: launch },
    } as unknown as AppServices,
    role: "pm",
    sessionId: null,
    projectId: env.project.id,
    caller: "mcp",
    signal: new AbortController().signal,
  });
}

it("fills Team pins, keeps free choices for unpinned and untagged starts, refuses an unset tagged role", async () => {
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
  expect(launch.mock.lastCall?.[0]).toMatchObject({ provider: "codex" });
  // A tagged role the resolved Team does not set is refused, as the guard refuses it.
  setTeam([]);
  await expect(start()).rejects.toThrow("Set the Writer in Settings → Team");
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

it("accepts Auto as an omitted provider for a matching effective Team role", async () => {
  setTeam([member]);
  await start({ provider: "auto", model: member.model });
  expect(launch.mock.lastCall?.[0]).toMatchObject({
    provider: member.provider,
    model: member.model,
    effort: member.effort,
  });
});
