import { describe, expect, it } from "vitest";
import { type PatchedFile, prDiffKey } from "../src/services/factory/diff-key";

/**
 * The fingerprint of what a PR itself changes (#322): an approval carries over to a new head
 * only when it is the same, so it must not move when main only shifts the PR's hunks, and must
 * move on any change to the PR's own lines.
 */

const file = (patch: string | null, extra: Partial<PatchedFile> = {}): PatchedFile => ({
  path: "src/fetch.ts",
  status: "modified",
  patch,
  ...extra,
});

const PATCH = [
  "diff --git a/src/fetch.ts b/src/fetch.ts",
  "--- a/src/fetch.ts",
  "+++ b/src/fetch.ts",
  "@@ -10,6 +10,7 @@ export function get(url) {",
  "   const u = new URL(url);",
  "+  assertPublic(u);",
  "   return fetch(u);",
].join("\n");

describe("prDiffKey", () => {
  it("stays the same when only the hunks' positions moved, in any file order", () => {
    const moved = PATCH.replace(
      "@@ -10,6 +10,7 @@ export function get(url) {",
      "@@ -42,6 +43,7 @@",
    );
    const other = file("@@ -1 +1 @@\n-a\n+b", { path: "src/a.ts" });
    expect(prDiffKey([file(PATCH), other], 2)).toBe(prDiffKey([other, file(moved)], 2));
  });

  it("changes with the PR's own lines, the lines around them, a status or a rename", () => {
    const key = prDiffKey([file(PATCH)], 1);
    expect(key).toMatch(/^[0-9a-f]{24}$/);
    expect(prDiffKey([file(PATCH.replace("assertPublic", "noop"))], 1)).not.toBe(key);
    expect(prDiffKey([file(PATCH.replace("return fetch", "return get"))], 1)).not.toBe(key);
    expect(prDiffKey([file(PATCH, { status: "added" })], 1)).not.toBe(key);
    expect(prDiffKey([file(PATCH, { previousPath: "src/old.ts" })], 1)).not.toBe(key);
    expect(prDiffKey([file(PATCH), file("@@ -0,0 +1 @@\n+x", { path: "b.ts" })], 2)).not.toBe(key);
  });

  it("can't tell without every file's patch", () => {
    expect(prDiffKey([file(PATCH), file(null, { path: "logo.png" })], 2)).toBeNull();
    expect(prDiffKey([file(PATCH)], 3001)).toBeNull();
  });
});
