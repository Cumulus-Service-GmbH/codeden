import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionOptions } from "@codeden/contracts";
import { codexSandboxPolicy } from "./config";
import type { CommandExecResponse } from "./protocol/v2";
import type { CodexRpc } from "./rpc";

export function allowsWorktreeGit(opts: SessionOptions): boolean {
  return !opts.readOnly && (opts.autonomy === "auto" || opts.autonomy === "full");
}

async function safeFilePath(root: string, parts: string[]): Promise<string | undefined> {
  let path = root;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (stat && !(i === parts.length - 1 ? stat.isFile() : stat.isDirectory())) return undefined;
  }
  return path;
}

/** The launcher sets ownBranch only for a session that owns its worktree branch. */
async function worktreeGitRoots(
  cwd: string,
  ownBranch: string,
): Promise<[string, ...string[]] | undefined> {
  const gitFile = join(await realpath(cwd), ".git");
  const entry = await lstat(gitFile);
  if (entry.isDirectory()) return undefined;

  const pointer =
    entry.isFile() && /^gitdir: (.+)\r?\n?$/.exec(await readFile(gitFile, "utf8"))?.[1];
  if (!pointer) throw new Error("Invalid linked worktree .git file");
  const gitDir = await realpath(resolve(dirname(gitFile), pointer.trim()));
  const common = dirname(dirname(gitDir));
  const metadataPath = async (name: string) =>
    realpath(resolve(gitDir, (await readFile(join(gitDir, name), "utf8")).trim()));
  if (
    basename(dirname(gitDir)) !== "worktrees" ||
    basename(common) !== ".git" ||
    (await metadataPath("commondir")) !== common ||
    (await metadataPath("gitdir")) !== gitFile
  ) {
    throw new Error("Git metadata does not belong to this linked worktree");
  }

  // A branch reset uses a lock and renames it into the ref. Grant both exact paths,
  // and the exact reflog paths, while keeping sibling refs and shared objects protected.
  const branch = ownBranch.split("/");
  if (branch.some((part) => !part || part === "." || part === ".." || /[\\:]/.test(part))) {
    throw new Error("Invalid owned Git branch path");
  }
  const leaf = branch.pop();
  const roots: [string, ...string[]] = [gitDir];
  for (const prefix of [
    ["refs", "heads"],
    ["logs", "refs", "heads"],
  ]) {
    const file = await safeFilePath(common, [...prefix, ...branch, `${leaf}`]);
    const lock = await safeFilePath(common, [...prefix, ...branch, `${leaf}.lock`]);
    if (!file || !lock) throw new Error("Owned Git branch or lock path is not a regular file");
    roots.push(file, lock);
  }
  return roots;
}

export async function prepareWorktreeGit(rpc: CodexRpc, opts: SessionOptions): Promise<string[]> {
  if (!opts.ownBranch || !allowsWorktreeGit(opts)) return [];
  try {
    const roots = await worktreeGitRoots(opts.cwd, opts.ownBranch);
    if (!roots) return [];
    // Git acquires index.lock even for an ignored path in a dry run. A worktree's .git
    // cannot be staged, and disabling fsmonitor keeps the probe free of external hooks.
    const result = await rpc.request<CommandExecResponse>("command/exec", {
      command: [
        "git",
        "-c",
        "core.fsmonitor=false",
        "add",
        "--dry-run",
        "--ignore-missing",
        "--",
        ".git",
      ],
      cwd: opts.cwd,
      env: { GIT_INDEX_FILE: join(roots[0], "index"), GIT_DIR: roots[0], GIT_WORK_TREE: opts.cwd },
      timeoutMs: 5000,
      sandboxPolicy: codexSandboxPolicy({
        ...opts,
        additionalDirectories: [...opts.additionalDirectories, ...roots],
      }),
    });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || `Git exited ${result.exitCode}`);
    return roots;
  } catch (error) {
    throw new Error(`Git lock preflight failed for ${opts.cwd}: ${String(error)}`, {
      cause: error,
    });
  }
}
