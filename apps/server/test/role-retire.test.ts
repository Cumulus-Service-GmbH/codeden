import { describe, expect, it, vi } from "vitest";
import { retireRoleSession } from "../src/services/sessions/role-retire";

const failure = (code: string) => Object.assign(new Error("runner said no"), { code });

describe("retiring an archived role conversation", () => {
  it("revokes its tokens first and retries a failed stop once, logging only id and code", async () => {
    const order: string[] = [];
    const warn = vi.fn();
    const stop = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push("stop");
        throw failure("runner_timeout");
      })
      .mockImplementationOnce(async () => {
        order.push("stop");
      });
    await retireRoleSession({ stop, revokeTokens: () => order.push("revoke"), warn }, "o1");
    expect(order).toEqual(["revoke", "stop", "stop"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "Stopping archived role session o1 failed (runner_timeout); trying once more",
    );
  });

  it("gives up after the second failure without rejecting", async () => {
    const warn = vi.fn();
    const stop = vi.fn(async () => {
      throw failure("runner_timeout");
    });
    await expect(
      retireRoleSession({ stop, revokeTokens: () => {}, warn }, "o1"),
    ).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      "Stopping archived role session o1 failed again (runner_timeout); its tokens stay revoked",
    );
    expect(warn.mock.calls.flat().join(" ")).not.toContain("runner said no");
  });
});
