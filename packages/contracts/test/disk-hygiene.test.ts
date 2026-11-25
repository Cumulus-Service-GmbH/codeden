import { describe, expect, it } from "vitest";
import { DiskHygieneCommand, DiskHygieneStatus } from "../src";

describe("disk hygiene contracts", () => {
  it("round-trips a preview and its version-specific approval", () => {
    const report = {
      id: "preview",
      version: "1.2.3",
      at: "2026-11-25T02:00:00.000Z",
      trigger: "update",
      dryRun: true,
      scopes: [
        {
          projectId: "p1",
          name: "Project",
          bytesFreed: 0,
          items: [
            { path: "/work/tree", disposition: "listed", bytes: 0, reason: "Unpushed commits" },
          ],
        },
      ],
    };
    const status = {
      config: { enabled: true, dryRun: true, cacheBudgetBytes: 1024, protectPaths: [] },
      version: report.version,
      previewId: report.id,
      approved: false,
      report,
      history: [],
    };
    expect(DiskHygieneStatus.parse(JSON.parse(JSON.stringify(status)))).toEqual(status);
    const approve = { action: "approve", previewId: report.id };
    expect(DiskHygieneCommand.parse(JSON.parse(JSON.stringify(approve)))).toEqual(approve);
    expect(DiskHygieneCommand.safeParse({ action: "approve" }).success).toBe(false);
  });
});
