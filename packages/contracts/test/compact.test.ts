import { describe, expect, it } from "vitest";
import {
  CompactSessionResponse,
  ProviderCapabilities,
  RunnerCommand,
  RunnerCommandResults,
} from "../src";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const capabilities = {
  resume: true,
  steer: false,
  interrupt: true,
  approvals: true,
  userQuestions: false,
  subagents: false,
  rollback: false,
  fork: false,
  images: false,
  planMode: false,
  reasoningEffort: false,
  mcp: true,
  skills: false,
};

describe("compaction contracts", () => {
  it("keeps compact optional on capabilities (absent counts as false)", () => {
    expect(ProviderCapabilities.parse(capabilities).compact).toBeUndefined();
    expect(roundTrip(ProviderCapabilities, { ...capabilities, compact: true }).compact).toBe(true);
  });

  it("round-trips the runner's session.compact and its result", () => {
    expect(roundTrip(RunnerCommand, { name: "session.compact", sessionId: "s1" })).toEqual({
      name: "session.compact",
      sessionId: "s1",
    });
    expect(RunnerCommand.safeParse({ name: "session.compact" }).success).toBe(false);
    roundTrip(RunnerCommandResults["session.compact"], {});
  });

  it("round-trips the API response", () => {
    expect(roundTrip(CompactSessionResponse, { status: "compacting" })).toEqual({
      status: "compacting",
    });
    expect(CompactSessionResponse.safeParse({ status: "sent" }).success).toBe(false);
  });
});
