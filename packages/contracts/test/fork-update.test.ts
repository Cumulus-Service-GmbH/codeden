import { describe, expect, it } from "vitest";
import { FORK_BUILD, FORK_RELEASE_REPOSITORY, ForkUpdateReceipt } from "../src/index";

const receipt = {
  repository: "Cumulus-Service-GmbH/codeden",
  tag: "fork-v0.7.8",
  commit: "a".repeat(40),
  artifact: "CodeDen-0.7.8-arm64.zip",
  sha256: "b".repeat(64),
};

describe("fork update receipt", () => {
  it("round-trips a receipt issued for the fork", () => {
    expect(FORK_BUILD).toBe(true);
    expect(FORK_RELEASE_REPOSITORY).toBe(receipt.repository);
    expect(ForkUpdateReceipt.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it("rejects upstream receipts and malformed digests", () => {
    expect(
      ForkUpdateReceipt.safeParse({ ...receipt, repository: "leonvanzyl/codeden" }).success,
    ).toBe(false);
    expect(ForkUpdateReceipt.safeParse({ ...receipt, sha256: "bad" }).success).toBe(false);
  });
});
