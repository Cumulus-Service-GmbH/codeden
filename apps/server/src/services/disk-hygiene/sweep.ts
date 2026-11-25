import { existsSync, lstatSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  compareVersions,
  type DiskHygieneConfig,
  type DiskHygieneReport,
  type Project,
} from "@codeden/contracts";
import type { Exec } from "../exec";
import { isVersionName, pointerFile, readPointer } from "../updates/app-dir";
import type { HygieneGit } from "./git";
import { canonical, children, contains, hygieneEnv, measure, overlaps } from "./paths";

type Scope = DiskHygieneReport["scopes"][number];
type SessionArea = { path: string; projectId: string | null; removedAt: string | null };
export interface SweepDeps {
  home: string;
  userHome: string;
  tempRoots: string[];
  version: string;
  projects: () => Project[];
  sessionAreas: () => SessionArea[];
  git: Pick<HygieneGit, "worktrees" | "eligibility" | "remove">;
  exec: Exec;
}

const DAY = 86400_000;
const GENERATED = new Set(["node_modules", "dist", "build", ".turbo", ".vitest"]);

export async function sweep(
  deps: SweepDeps,
  config: DiskHygieneConfig,
  dryRun: boolean,
  now: number,
) {
  const shared: Scope = { projectId: null, name: "This machine", items: [], bytesFreed: 0 };
  const projects = deps.projects();
  const scopes: Scope[] = [shared];
  const user = canonical(deps.userHome);
  const home = canonical(deps.home);
  const external = join(user, "Projects", ".trioharness");
  const areas = deps.sessionAreas();
  const worktrees = join(home, "wt");
  const roots = [worktrees, join(user, ".codeden", "wt")];
  const protections = config.protectPaths.flatMap((path) => [
    resolve(user, path.replace(/^~[/\\]/, "")),
    canonical(resolve(user, path.replace(/^~[/\\]/, ""))),
  ]);
  const seen = new Set<string>();

  function protectedPath(path: string, sessionArtifact: string | undefined) {
    const real = canonical(path);
    if (/(?:^|[/\\])[^/\\]*kv-migration[^/\\]*(?:[/\\]|$)/i.test(real)) return "Protected worktree";
    if (protections.some((p) => overlaps(p, real) || overlaps(p, path)))
      return "On the protect list";
    if (!sessionArtifact && roots.some((p) => overlaps(p, real) || overlaps(p, path))) {
      return "CodeDen session area";
    }
    if (projects.some((p) => contains(real, canonical(p.path))))
      return "Contains a project directory";
    if (
      deps
        .sessionAreas()
        .some(
          (area) =>
            (area.path !== sessionArtifact || !area.removedAt) &&
            overlaps(canonical(area.path), real),
        )
    )
      return "CodeDen session area";
    return null;
  }

  async function candidate(
    scope: Scope,
    path: string,
    anchor: string,
    reason: string,
    opts: {
      worktree?: Project;
      sessionArtifact?: string;
      cache?: ["npm" | "pnpm", string[]];
      keep?: string;
      stillEligible?: () => boolean;
    } = {},
  ) {
    if (seen.has(path)) return;
    seen.add(path);
    const add = (disposition: Scope["items"][number]["disposition"], reason: string, bytes = 0) => {
      scope.items.push({ path, disposition, reason, bytes });
      if (disposition === "removed") scope.bytesFreed += bytes;
    };
    try {
      const keep = protectedPath(path, opts.sessionArtifact) ?? opts.keep;
      if (keep) return add("protected", keep);
      if (opts.sessionArtifact && existsSync(join(opts.sessionArtifact, ".git"))) {
        return add("protected", "Session worktree has been recreated");
      }
      const identity = lstatSync(path);
      const size = measure(path, anchor, Boolean(opts.worktree));
      if (opts.worktree) {
        const why = await deps.git.eligibility(opts.worktree, path);
        if (why) return add("listed", why);
      }
      if (opts.cache && size <= config.cacheBudgetBytes) return;
      if (dryRun) return add("preview", reason, size);
      const current = lstatSync(path);
      if (
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        protectedPath(path, opts.sessionArtifact)
      ) {
        return add("protected", "Candidate changed during the scan");
      }
      if (opts.sessionArtifact && existsSync(join(opts.sessionArtifact, ".git"))) {
        return add("protected", "Session worktree has been recreated");
      }
      if (opts.stillEligible && !opts.stillEligible()) {
        return add("protected", "Eligibility changed during the scan");
      }
      const before = measure(path, anchor, Boolean(opts.worktree));
      if (opts.worktree) {
        if (!(await deps.git.remove(opts.worktree, anchor, path)))
          return add("listed", "Git declined removal");
      } else if (opts.cache) {
        const [command, args] = opts.cache;
        const result = await deps.exec(command, args, {
          cwd: path,
          timeoutMs: 180000,
          env: {
            ...hygieneEnv(),
            CI: "true",
            npm_config_offline: "true",
            npm_config_userconfig: process.platform === "win32" ? "NUL" : "/dev/null",
            npm_config_globalconfig: process.platform === "win32" ? "NUL" : "/dev/null",
            COREPACK_ENABLE_NETWORK: "0",
            COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          },
        });
        const freed = Math.max(0, before - measure(path, anchor));
        if (freed) add("removed", reason, freed);
        if (result.code !== 0)
          return add("listed", `${command} could not complete cache maintenance`);
        if (!freed) add("listed", "Cache maintenance freed no space");
        return;
      } else {
        rmSync(path, { recursive: true });
      }
      add("removed", reason, before);
    } catch (error) {
      const message =
        (error as NodeJS.ErrnoException).code ??
        (error instanceof Error ? error.message : "Candidate could not be checked");
      add("listed", message);
    }
  }

  async function scan(scope: Scope, root: string, visit: (path: string) => Promise<void>) {
    try {
      if (canonical(root) !== root) throw new Error("Cleanup root uses a symbolic link");
      for (const path of children(root)) await visit(path);
    } catch {
      scope.items.push({
        path: root,
        disposition: "listed",
        reason: "Cleanup directory could not be verified",
        bytes: 0,
      });
    }
  }

  for (const project of projects) {
    const scope: Scope = { projectId: project.id, name: project.name, items: [], bytesFreed: 0 };
    scopes.push(scope);
    if (project.isGitRepo) {
      try {
        for (const tree of await deps.git.worktrees(project)) {
          const path = resolve(tree);
          if (
            contains(external, path) ||
            contains(external, canonical(path)) ||
            roots.some((root) => contains(root, path))
          ) {
            await candidate(scope, path, external, "Clean external worktree", {
              worktree: project,
            });
          }
        }
      } catch {
        scope.items.push({
          path: project.path,
          disposition: "listed",
          reason: "Git worktrees could not be verified",
          bytes: 0,
        });
      }
    }
    for (const area of areas) {
      const path = resolve(area.path);
      if (
        area.projectId !== project.id ||
        !area.removedAt ||
        !contains(worktrees, path) ||
        path === worktrees ||
        existsSync(join(path, ".git"))
      )
        continue;
      await scan(scope, path, async (artifact) => {
        if (GENERATED.has(basename(artifact))) {
          await candidate(scope, artifact, path, "Generated files after built-in cleanup", {
            sessionArtifact: area.path,
          });
        }
      });
    }
  }

  const tempRoots = new Set(deps.tempRoots.map(canonical));
  for (const temp of tempRoots) {
    await scan(shared, temp, async (path) => {
      if (!/^codeden-image-[a-zA-Z0-9]{6}$/.test(basename(path))) return;
      const stat = lstatSync(path);
      if (!stat.isDirectory() || now - stat.mtimeMs < 7 * DAY) return;
      const dockerfile = join(path, "Dockerfile");
      if (!existsSync(dockerfile) || !lstatSync(dockerfile).isFile()) return;
      if (children(path).some((child) => !["Dockerfile", "codeden"].includes(basename(child))))
        return;
      await candidate(shared, path, temp, "Stale CodeDen build staging");
    });
  }

  const app = join(home, "app");
  if (canonical(app) === app && safePointer(home)) {
    const pointer = readPointer(home);
    if (pointer) {
      const versions = children(app)
        .map((path) => basename(path))
        .filter(isVersionName)
        .sort((a, b) => compareVersions(b, a));
      const newestBackup = versions.find(
        (version) => compareVersions(version, pointer.version) < 0 && version !== deps.version,
      );
      for (const version of versions) {
        if (version === pointer.version || version === deps.version) continue;
        const keep =
          version === newestBackup ||
          version === pointer.previous ||
          compareVersions(version, pointer.version) >= 0
            ? "App version available for startup or rollback"
            : undefined;
        await candidate(shared, join(app, version), app, "Older app backup", {
          keep,
          stillEligible: () => {
            const current = safePointer(home) ? readPointer(home) : null;
            return (
              current?.version === pointer.version &&
              current.previous === pointer.previous &&
              current.updatedAt === pointer.updatedAt
            );
          },
        });
      }
    }
  }

  for (const name of ["vitest", "turbo"]) {
    const path = join(user, ".cache", name);
    if (existsSync(path) && lstatSync(path).mtimeMs <= now - 7 * DAY) {
      await candidate(shared, path, user, `Stale ${name} cache`);
    }
  }
  const npm = join(user, process.platform === "win32" ? "AppData/Local/npm-cache" : ".npm");
  const pnpm = join(
    user,
    process.platform === "darwin"
      ? "Library/pnpm/store"
      : process.platform === "win32"
        ? "AppData/Local/pnpm/store"
        : ".local/share/pnpm/store",
  );
  for (const [path, command, args] of [
    [npm, "npm", ["cache", "verify", "--cache", npm]],
    [pnpm, "pnpm", ["store", "prune", "--store-dir", pnpm]],
  ] as const) {
    if (existsSync(path)) {
      await candidate(shared, path, user, "Package cache exceeds its budget", {
        cache: [command, [...args]],
      });
    }
  }
  return scopes;
}

function safePointer(home: string) {
  const file = pointerFile(home);
  return existsSync(file) && lstatSync(file).isFile() && canonical(file) === file;
}
