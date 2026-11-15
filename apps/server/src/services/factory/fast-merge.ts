import type { FactoryLoop, Project } from "@codeden/contracts";
import { type FactoryContext, raiseInbox } from "./context";
import type { FactoryPr, MainSince } from "./github-port";
import { matchesGlob } from "./globs";
import { changedPaths } from "./policy";
import { isLockfile } from "./size";

/**
 * The merge queue's fast path (§10.1, `MergePolicy` `fast`). A queued PR that is behind the
 * default branch merges on its own green CI, without being brought up to date first, when the
 * commits it is missing touch none of its files: GitHub's merge commit combines them. Files
 * whose change can break code they don't touch (dependencies, CI, TypeScript and build config,
 * migrations, shared barrels) count as overlapping whichever side changed them, so semantic
 * clashes in shared plumbing are still re-tested. Anything uncertain takes the strict path.
 */

/** Root files that change how every package installs, builds or runs. */
const ROOT_FILES = new Set([
  "pnpm-workspace.yaml",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "deno.json",
  "deno.jsonc",
  "go.work",
]);

/**
 * Dependency manifests, wherever they are: a workspace package's `package.json` installs and
 * runs scripts like the root one (their lockfiles are covered by `isLockfile`).
 */
const MANIFESTS = new Set([
  "package.json",
  "go.mod",
  "cargo.toml",
  "pyproject.toml",
  "pipfile",
  "gemfile",
  "composer.json",
  "pubspec.yaml",
  "mix.exs",
  "package.swift",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

/** Build, test and lint config by base name: `vite.config.ts`, `tsconfig.base.json`, ... */
const CONFIG_NAME =
  /^(?:tsconfig|jsconfig)(?:\.[\w-]+)*\.json$|^(?:vite|vitest|vitest\.workspace|tsdown|tsup|webpack|rollup|esbuild|babel|next|nuxt|svelte|astro|remix|playwright|jest|eslint|postcss|tailwind|drizzle|turbo)\.config\.[cm]?[jt]s$|^(?:\.babelrc|\.swcrc|biome\.jsonc?|requirements(?:[-.][\w-]+)?\.txt)$/i;

/** Globs for CI, migrations and shared barrels (`globs.ts` syntax). */
const SENSITIVE_GLOBS = [
  ".github/workflows/**",
  ".github/actions/**",
  ".gitlab-ci.yml",
  ".circleci/**",
  "**/migrations/**",
  "**/migration/**",
  "**/drizzle/**",
  "*migration*",
  "*.prisma",
  "packages/*/src/index.*",
  "packages/*/index.*",
];

/** Whether a change to `path` can break code that doesn't touch it, so it always re-tests. */
export function isMergeSensitive(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const name = normalized.split("/").at(-1) ?? "";
  if (ROOT_FILES.has(normalized) || isLockfile(normalized)) return true;
  if (MANIFESTS.has(name.toLowerCase()) || CONFIG_NAME.test(name)) return true;
  return SENSITIVE_GLOBS.some((g) => matchesGlob(normalized, g));
}

/** Whether the PR may merge on its own CI, or why it takes the strict path. */
export type FastVerdict =
  | { fast: true }
  | {
      fast: false;
      /** Why, in words that follow "re-testing against main: ". */
      reason: string;
      /** Branch protection requires up-to-date branches: the user hears once. */
      protection?: boolean;
    };

/** "a.ts", "a.ts (+2 more)". */
function some(paths: string[]): string {
  const [first] = paths;
  return paths.length > 1 ? `${first} (+${paths.length - 1} more)` : (first ?? "");
}

/**
 * The fast path's verdict for a queue head that is behind the default branch (`main`: what
 * changed there since the PR's merge base). Every other check already passed on the PR's own
 * head. `hold` is the loop's `fastMergeHold`.
 */
export function fastMergeVerdict(input: {
  branch: string;
  hold: string | null;
  pr: Pick<FactoryPr, "files" | "changedFiles" | "renamedFrom" | "mergeState">;
  main: MainSince;
}): FastVerdict {
  const { branch, hold, pr, main } = input;
  if (hold) return { fast: false, reason: `${hold}; fast merges resume once it is green` };
  const state = pr.mergeState ?? "unknown";
  if (state === "behind")
    return {
      fast: false,
      reason: `branch protection requires it to be up to date with ${branch}`,
      protection: true,
    };
  if (state !== "clean" && state !== "has_hooks")
    return { fast: false, reason: `GitHub reports its merge state as ${state}` };
  const mine = changedPaths(pr);
  if (!main.complete || (pr.changedFiles ?? 0) > pr.files.length)
    return { fast: false, reason: "too many changed files to compare" };
  const sensitive = mine.filter(isMergeSensitive);
  if (sensitive.length > 0)
    return {
      fast: false,
      reason: `it changes ${some(sensitive)}, and dependency, build and migration files always re-test`,
    };
  const theirs = main.files.filter(isMergeSensitive);
  if (theirs.length > 0)
    return {
      fast: false,
      reason: `${some(theirs)} changed on ${branch}, and dependency, build and migration files always re-test`,
    };
  const changed = new Set(main.files);
  const overlap = mine.filter((f) => changed.has(f));
  if (overlap.length > 0) return { fast: false, reason: `overlaps in ${some(overlap)}` };
  return { fast: true };
}

/**
 * Hold or release fast merges by CI on the default branch's head: red holds them (the next PRs
 * take the strict path), green lets them go again. Pending or no CI changes nothing. Null when
 * GitHub couldn't be read: the queue tries again on the next tick.
 */
export async function withMainCi(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  branch: string,
): Promise<FactoryLoop | null> {
  let main: Awaited<ReturnType<typeof ctx.github.mainHead>>;
  try {
    main = await ctx.github.mainHead(project.id);
  } catch {
    return null;
  }
  if (main.checks === "success")
    return loop.fastMergeHold ? { ...loop, fastMergeHold: null } : loop;
  if (main.checks !== "failure" || loop.fastMergeHold) return loop;
  const failing = main.failed.join(", ") || "CI";
  return {
    ...loop,
    fastMergeHold: `CI on ${branch} is red (${failing} on ${main.sha.slice(0, 7)})`,
  };
}

/** Inbox id of "branch protection keeps the merge queue strict" (raised once per project). */
export const strictProtectionInboxId = (projectId: string) =>
  `inbox:factory-strict-merges:${projectId}`;

/**
 * Tell the user, once per project, that branch protection forces every PR through the strict
 * path. Never raised again, even after it is dismissed.
 */
export function noteProtectionForcesStrict(
  ctx: FactoryContext,
  project: Project,
  branch: string,
): void {
  const id = strictProtectionInboxId(project.id);
  if (ctx.inbox.find(id)) return;
  ctx.log?.(`factory: ${project.id}: branch protection requires up-to-date branches`);
  raiseInbox(ctx, {
    id,
    kind: "message",
    notify: "factory",
    priority: "low",
    projectId: project.id,
    title: "Branch protection keeps the merge queue on the strict path",
    body: `Branch protection on ${branch} requires pull requests to be up to date before they merge, so the factory brings each one up to date and waits for CI again before merging it, even when nothing it changes was touched on ${branch}. To let those merge on their own CI, turn off "Require branches to be up to date before merging" for ${branch} on GitHub. Nothing else is needed: merges carry on either way.`,
  });
}
