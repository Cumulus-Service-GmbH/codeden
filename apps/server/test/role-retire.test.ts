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

  it("still stops it when revoking the tokens throws", async () => {
    const warn = vi.fn();
    const stop = vi.fn(async () => {});
    const revokeTokens = () => {
      throw new Error("token store closed");
    };
    await expect(retireRoleSession({ stop, revokeTokens, warn }, "o1")).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Revoking the tokens of archived role session o1 failed");
  });

  it("tries the revocation again without the runner, and says when it still failed", async () => {
    const warn = vi.fn();
    const stop = vi.fn(async () => {
      throw failure("runner_unavailable");
    });
    let calls = 0;
    const revokeTokens = vi.fn(() => {
      calls++;
      if (calls < 3) throw new Error("token store busy");
    });
    await retireRoleSession({ stop, revokeTokens, warn }, "o1");
    expect(revokeTokens).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenLastCalledWith(
      "Stopping archived role session o1 failed again (runner_unavailable); its tokens are revoked",
    );

    const stuck = vi.fn();
    await retireRoleSession(
      {
        stop,
        revokeTokens: () => {
          throw new Error("token store closed");
        },
        warn: stuck,
      },
      "o2",
    );
    expect(stuck).toHaveBeenLastCalledWith(
      "Stopping archived role session o2 failed again (runner_unavailable); its tokens could not be revoked",
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
      "Stopping archived role session o1 failed again (runner_timeout); its tokens are revoked",
    );
    expect(warn.mock.calls.flat().join(" ")).not.toContain("runner said no");
  });
});
