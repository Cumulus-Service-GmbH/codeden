import { describe, expect, it } from "vitest";
import * as contracts from "../src/index";

describe("admission contracts", () => {
  it("round-trips status with all waiter kinds", () => {
    const status = {
      limit: 4,
      active: 4,
      control: 2,
      waiting: ["start", "turn", "checks"].map((kind, index) => ({
        sessionId: `session-${index}`,
        kind,
        since: "2026-11-22T10:00:00.000Z",
        place: index + 1,
      })),
    };
    expect(contracts.AdmissionStatus.parse(JSON.parse(JSON.stringify(status)))).toEqual(status);
    expect(contracts.AT_CAPACITY_CODE).toBe("at_capacity");
  });

  it("fills the default limit for new and older settings", () => {
    expect(contracts.Settings.parse({}).limits).toEqual({ maxActiveSessions: 4 });
    expect(contracts.Settings.parse({ appearance: { theme: "light" } }).limits).toEqual({
      maxActiveSessions: 4,
    });
  });

  it("round-trips a configured limit", () => {
    const settings = contracts.Settings.parse({ limits: { maxActiveSessions: 64 } });
    expect(settings.limits).toEqual({ maxActiveSessions: 64 });
    expect(contracts.Settings.parse(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  it.each([0, 65])("rejects an out-of-range limit of %i", (maxActiveSessions) => {
    expect(contracts.Settings.safeParse({ limits: { maxActiveSessions } }).success).toBe(false);
  });
});
