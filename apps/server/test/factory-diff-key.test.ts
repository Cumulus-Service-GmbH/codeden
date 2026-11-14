import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/services/errors";
import { type PatchedFile, prDiffKey } from "../src/services/factory/diff-key";
import { GithubFactoryPort } from "../src/services/factory/github-port";
import type { GithubService } from "../src/services/github/github-service";

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

/** One entry of GitHub's compare `files`. */
interface CompareFile {
  filename: string;
  status: string;
  patch?: string;
}

const AT_A: CompareFile[] = [
  { filename: "src/fetch.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
];
const AT_B: CompareFile[] = [
  ...AT_A,
  { filename: "src/net.ts", status: "added", patch: "@@ -0,0 +1 @@\n+exfiltrate()" },
];
const keyOf = (files: CompareFile[]) =>
  prDiffKey(
    files.map((f) => ({ path: f.filename, status: f.status, patch: f.patch ?? null })),
    files.length,
  );

/**
 * A GitHub whose PR read says head `A` while its file listing already shows a push (B): the two
 * are separate requests, and a push can land between them. Compares answer per commit.
 */
function racingGithub(filesAt: Record<string, CompareFile[] | Error>) {
  const compares: string[] = [];
  const github = {
    githubRepo: () => ({ owner: "acme", repo: "app", defaultBranch: "main" }),
    getPrDetails: async () => ({
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      state: "open",
      title: "Harden fetch",
      body: "",
      headSha: "A",
      headBranch: "codeden/fetch",
      baseBranch: "main",
      checks: { state: "success", checks: [] },
      mergeable: "mergeable",
      mergeState: "clean",
      additions: 2,
      deletions: 1,
      changedFiles: AT_B.length,
      // The listing was read after B landed.
      files: AT_B.map((f) => ({ path: f.filename, status: f.status, additions: 1, deletions: 0 })),
    }),
    client: {
      run: async (fn: (octokit: unknown) => Promise<unknown>) =>
        fn({
          rest: {
            repos: {
              compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
                compares.push(basehead);
                const at = filesAt[basehead.split("...")[1] ?? ""];
                if (at === undefined) throw new ServiceError(404, "github_not_found", "Not Found");
                if (at instanceof Error) throw at;
                return { data: { files: at } };
              },
            },
          },
        }),
    },
  } as unknown as GithubService;
  return { port: new GithubFactoryPort(github), compares };
}

describe("the fingerprint the factory reads", () => {
  it("is pinned to the head commit it is filed under, never a push that came between reads", async () => {
    const { port, compares } = racingGithub({ A: AT_A, B: AT_B });
    const pr = await port.prDetails("p-app", 7);
    expect(pr.headSha).toBe("A");
    expect(compares).toEqual(["main...A"]);
    expect(pr.diffKey).toBe(keyOf(AT_A));
    expect(pr.diffKey).not.toBe(keyOf(AT_B));
    // A commit's own change never changes: read once per head.
    await port.prDetails("p-app", 7);
    expect(compares).toEqual(["main...A"]);
  });

  it("can't tell (null) when GitHub doesn't know the commit or lists too many files", async () => {
    expect((await racingGithub({}).port.prDetails("p-app", 7)).diffKey).toBeNull();
    const many = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@\n-a\n+b",
    }));
    expect((await racingGithub({ A: many }).port.prDetails("p-app", 7)).diffKey).toBeNull();
  });

  it("throws when GitHub doesn't answer properly, so the PR is read again later", async () => {
    const limited = new ServiceError(503, "github_rate_limited", "rate limited");
    await expect(racingGithub({ A: limited }).port.prDetails("p-app", 7)).rejects.toThrow(
      /rate limited/,
    );
  });
});
