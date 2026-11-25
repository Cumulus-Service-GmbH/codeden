import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskHygieneConfig, type Project } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiskHygiene } from "../src/services/disk-hygiene/service";
import { type SweepDeps, sweep } from "../src/services/disk-hygiene/sweep";
import { writePointer } from "../src/services/updates/app-dir";

let root: string;
const now = Date.parse("2026-11-25T02:00:00.000Z");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeden-hygiene-test-")));
});
afterEach(() => rmSync(root, { recursive: true }));

function directory(path: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "fixture.bin"), Buffer.alloc(8192, 1));
  return path;
}

function fixture() {
  const home = join(root, "data");
  const tmp = join(root, "tmp");
  const external = join(root, "Projects", ".trioharness");
  const staging = join(tmp, "codeden-image-AbC123");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "Dockerfile"), "FROM scratch");
  utimesSync(staging, new Date(now - 8 * 86400_000), new Date(now - 8 * 86400_000));
  const outside = directory(join(root, "outside"));
  const escapedTree = directory(join(external, "escape"));
  symlinkSync(outside, join(escapedTree, "link"), "junction");
  const protectedTree = directory(join(external, "kv-migration"));
  const configured = directory(join(external, "protected"));
  const unpushed = directory(join(external, "unpushed"));
  const session = directory(join(external, "session"));
  const clean = directory(join(external, "clean"));
  const old = directory(join(home, "app", "1.0.0"));
  const newest = directory(join(home, "app", "1.1.0"));
  const active = directory(join(home, "app", "1.2.0"));
  const removed = directory(join(home, "wt", "proj", "removed", "node_modules"));
  const project = {
    id: "p",
    name: "Project",
    path: directory(join(root, "repo")),
    isGitRepo: true,
  } as Project;
  writePointer(home, "1.2.0", "1.1.0");
  const git = {
    worktrees: vi.fn(async () => [
      protectedTree,
      configured,
      unpushed,
      session,
      clean,
      escapedTree,
    ]),
    eligibility: vi.fn(async (_: Project, path: string) =>
      path === unpushed ? "Unpushed commits" : null,
    ),
    remove: vi.fn(async (_: Project, _anchor: string, path: string) => {
      rmSync(path, { recursive: true });
      return true;
    }),
  };
  const deps: SweepDeps = {
    home,
    userHome: root,
    tempRoots: [tmp],
    version: "1.2.0",
    projects: () => [project],
    sessionAreas: () => [
      { path: session, projectId: "other", removedAt: null },
      { path: join(home, "wt", "proj", "removed"), projectId: "p", removedAt: "2026-11-24" },
    ],
    git,
    exec: vi.fn(async () => {
      throw new Error("Unexpected package manager call");
    }),
  };
  return {
    deps,
    git,
    config: DiskHygieneConfig.parse({ protectPaths: [configured], dryRun: false }),
    staging,
    outside,
    escapedTree,
    protectedTree,
    configured,
    unpushed,
    session,
    clean,
    old,
    newest,
    active,
    removed,
  };
}

describe("disk hygiene", () => {
  it("preserves owned, protected, unpushed and escaped paths, and keeps the newest backup", async () => {
    const f = fixture();
    const scopes = await sweep(f.deps, f.config, false, now);
    for (const path of [
      f.outside,
      f.escapedTree,
      f.protectedTree,
      f.configured,
      f.unpushed,
      f.session,
      f.newest,
      f.active,
    ]) {
      expect(existsSync(path), path).toBe(true);
    }
    for (const path of [f.staging, f.clean, f.old, f.removed])
      expect(existsSync(path), path).toBe(false);
    const items = scopes.flatMap((scope) => scope.items);
    expect(items.find((item) => item.path === f.unpushed)).toMatchObject({
      disposition: "listed",
      reason: "Unpushed commits",
    });
    expect(items.find((item) => item.path === f.escapedTree)?.reason).toMatch(/symbolic link/);
    expect(items.find((item) => item.path === f.session)).toMatchObject({
      disposition: "protected",
      reason: "CodeDen session area",
    });
    expect(f.git.remove).toHaveBeenCalledTimes(1);
    for (const scope of scopes) {
      expect(scope.bytesFreed).toBe(
        scope.items
          .filter((item) => item.disposition === "removed")
          .reduce((sum, item) => sum + item.bytes, 0),
      );
      expect(scope.bytesFreed).toBeGreaterThan(0);
    }
  });

  it("lists preview candidates without deleting anything", async () => {
    const f = fixture();
    const scopes = await sweep(f.deps, f.config, true, now);
    expect(scopes.every((scope) => scope.bytesFreed === 0)).toBe(true);
    for (const path of [f.staging, f.clean, f.old, f.removed]) {
      expect(existsSync(path), path).toBe(true);
      expect(
        scopes.flatMap((scope) => scope.items).find((item) => item.path === path)?.disposition,
      ).toBe("preview");
    }
    expect(f.git.remove).not.toHaveBeenCalled();
  });

  it("requires a matching preview and resets approval exactly once on a newer app version", async () => {
    const f = fixture();
    const first = new DiskHygiene(f.deps, () => true);
    await first.command({ action: "configure", config: { ...f.config, enabled: true } });
    await expect(first.command({ action: "approve", previewId: "invented" })).rejects.toThrow(
      /dry run/,
    );
    const preview = await first.command({ action: "run" });
    expect(preview.report?.dryRun).toBe(true);
    expect(existsSync(f.clean)).toBe(true);
    await first.command({ action: "approve", previewId: String(preview.previewId) });
    expect(first.status().approved).toBe(true);
    const nextDeps = { ...f.deps, version: "1.3.0" };
    const second = new DiskHygiene(nextDeps, () => true);
    second.start();
    await second.stop();
    expect(second.status()).toMatchObject({
      approved: false,
      report: { trigger: "update", dryRun: true, version: nextDeps.version },
    });
    await expect(
      second.command({ action: "approve", previewId: String(preview.previewId) }),
    ).rejects.toThrow(/dry run/);
    const restart = new DiskHygiene(nextDeps, () => true);
    restart.start();
    await restart.stop();
    expect(restart.status().report?.id).toBe(second.status().report?.id);
    expect(existsSync(f.clean)).toBe(true);
  });
});

it("limits package commands to over-budget caches and accounts for observed removals", async () => {
  const f = fixture();
  const npm = directory(
    join(root, process.platform === "win32" ? "AppData/Local/npm-cache" : ".npm"),
  );
  const pnpm = directory(
    join(root, process.platform === "darwin" ? "Library/pnpm/store" : ".local/share/pnpm/store"),
  );
  const exec = vi.fn<SweepDeps["exec"]>(async (_command, _args, opts) => {
    if (opts?.cwd === npm || opts?.cwd === pnpm) rmSync(join(opts.cwd, "fixture.bin"));
    return { code: 0, stdout: "", stderr: "", notFound: false, timedOut: false, path: null };
  });
  f.deps.exec = exec;
  await sweep(f.deps, f.config, false, now);
  expect(exec).not.toHaveBeenCalled();
  await sweep(f.deps, { ...f.config, cacheBudgetBytes: 0 }, true, now);
  expect(exec).not.toHaveBeenCalled();
  const scopes = await sweep(f.deps, { ...f.config, cacheBudgetBytes: 0 }, false, now);
  expect(exec.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ["npm", ["cache", "verify", "--cache", npm]],
    ["pnpm", ["store", "prune", "--store-dir", pnpm]],
  ]);
  const shared = scopes.find((scope) => scope.projectId === null);
  expect(
    shared?.items.filter((item) => item.disposition === "removed").map((item) => item.path),
  ).toEqual([npm, pnpm]);
  expect(shared?.bytesFreed).toBeGreaterThan(0);
});
