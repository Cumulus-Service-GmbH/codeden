import { FORK_RELEASE_REPOSITORY } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { UpdateController } from "../src/main/updates/controller";
import { verifyForkHealth } from "../src/main/updates/fork-health";
import { findForkUpdate, verifyReceipt, verifySigner } from "../src/main/updates/fork-release";
import { replaceApp } from "../src/main/updates/fork-transaction";

const artifact = "CodeDen-0.7.8-arm64.zip";
const tag = "fork-v0.7.8";
const digest = "b".repeat(64);
const commit = "a".repeat(40);
const receipt = { repository: FORK_RELEASE_REPOSITORY, tag, commit, artifact, sha256: digest };
const signer = {
  commonName: "CodeDen Local Signing",
  usages: ["1.3.6.1.5.5.7.3.3"],
  fingerprint: "pinned",
};

describe("fork update safety", () => {
  it("uses only fork assets and reads upstream metadata separately", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const fork = String(input).includes(`/repos/${FORK_RELEASE_REPOSITORY}/`);
      return Response.json({
        tag_name: fork ? tag : "v99.0.0",
        assets: [{ name: artifact }, { name: `${artifact}.receipt.json` }],
      });
    });
    const found = await findForkUpdate("arm64", fetcher);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/releases/latest`,
      "https://api.github.com/repos/leonvanzyl/codeden/releases/latest",
    ]);
    expect(found.candidate?.archiveUrl).toContain(
      `/Cumulus-Service-GmbH/codeden/releases/download/${tag}/`,
    );
    expect(found.upstream?.version).toBe("v99.0.0");
    fetcher.mockImplementation(async (input) =>
      String(input).includes(FORK_RELEASE_REPOSITORY)
        ? new Response(null, { status: 404 })
        : Response.json({ tag_name: tag, assets: [{ name: artifact }] }),
    );
    expect((await findForkUpdate("arm64", fetcher)).candidate).toBeNull();
  });

  it("refuses a bad receipt, mismatched release and incorrect digest", () => {
    expect(verifyReceipt(receipt, tag, artifact, digest)).toEqual(receipt);
    expect(() => verifyReceipt({}, tag, artifact, digest)).toThrow(/receipt/i);
    expect(() => verifyReceipt(receipt, "fork-v9.9.9", artifact, digest)).toThrow(/receipt/i);
    expect(() => verifyReceipt(receipt, tag, artifact, "c".repeat(64))).toThrow(/SHA-256/);
  });

  it("refuses the wrong signer, an unpinned signer, and a missing codeSigning EKU", () => {
    expect(() => verifySigner(signer, signer.fingerprint)).not.toThrow();
    expect(() => verifySigner({ ...signer, commonName: "Other" }, signer.fingerprint)).toThrow(
      /signer/i,
    );
    expect(() => verifySigner(signer, "different")).toThrow(/signer/i);
    expect(() => verifySigner({ ...signer, usages: [] }, signer.fingerprint)).toThrow(/EKU/);
  });

  it("restores the old path, records failure, and relaunches after a failed health check", async () => {
    const files = new Map([
      ["live", "old"],
      ["staged", "new"],
    ]);
    const launches: Array<string | undefined> = [];
    const report = vi.fn();
    const stop = vi.fn();
    await replaceApp({
      live: "live",
      staged: "staged",
      backup: "backup",
      failed: "failed",
      version: "0.7.8",
      move: async (from, to) => {
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      },
      swap: async (left, right) => {
        const before = files.get(left) ?? "";
        files.set(left, files.get(right) ?? "");
        files.set(right, before);
      },
      start: async () => {
        launches.push(files.get("live"));
        return { stop };
      },
      health: async () => {
        throw new Error("failed health check");
      },
      report,
    });
    expect(files.get("live")).toBe("old");
    expect(files.get("failed")).toBe("new");
    expect(launches).toEqual(["new", "old"]);
    expect(stop).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      status: "restored",
      message: expect.stringContaining("failed health check"),
    });
  });
});

describe("fork owner action", () => {
  it("checks and quits without applying, then applies only once per explicit click", async () => {
    const candidate = {
      tag,
      artifact,
      version: "0.7.8",
      archiveUrl: "fork-zip",
      receiptUrl: "fork-receipt",
    };
    const apply = vi.fn(async () => {});
    const controller = new UpdateController({
      current: "0.7.7",
      unsupported: null,
      updater: () => {
        throw new Error("Legacy updater must not load");
      },
      beforeInstall: async () => {},
      fork: { check: async () => ({ candidate, upstream: null }), arch: "arm64", apply },
    });
    await controller.run("check");
    await controller.installOnQuit();
    await expect(controller.run("install")).rejects.toThrow("Update now");
    await expect(controller.run("download")).rejects.toThrow("Update now");
    expect(apply).not.toHaveBeenCalled();
    await expect(controller.run("apply", "9.0.0")).rejects.toThrow("No fork update is ready");
    const started = controller.run("apply", "0.7.8");
    await expect(controller.run("apply", "0.7.8")).rejects.toThrow("No fork update is ready");
    await started;
    expect(apply).toHaveBeenCalledExactlyOnceWith(candidate);
  });

  it("probes all three endpoints and refuses a stale build or an HTML fallback", async () => {
    const health = { ok: true, name: "codeden", version: "0.7.8", uptimeSec: 0 };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json(String(url).endsWith("/build-info") ? { version: "0.7.8", commit } : health),
      );
    await verifyForkHealth(4317, "fixture", "0.7.8", commit, fetcher);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/health",
      "/api/health",
      "/build-info",
    ]);
    await expect(verifyForkHealth(4317, "fixture", "0.7.8", "wrong", fetcher)).rejects.toThrow(
      /Unexpected CodeDen build/,
    );
    fetcher.mockResolvedValue(new Response("<html></html>"));
    await expect(verifyForkHealth(4317, "fixture", "0.7.8", commit, fetcher)).rejects.toThrow();
  });
});
