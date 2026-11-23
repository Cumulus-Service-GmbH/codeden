import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { SeedOptions } from "./seed";

const tmp = "/tmp";
const runGit = promisify(execFile);
const maxBytes = 8 * 1024 * 1024;

function owned(stats: Stats) {
  return (
    (process.getuid === undefined || stats.uid === process.getuid()) && (stats.mode & 0o022) === 0
  );
}

/** Verify each directory below the system temporary directory before following it. */
function trustedPath(path: string, directory: boolean): string | undefined {
  const parts = relative(tmp, path).split(sep);
  if (parts[0] === ".." || !parts[0]) return;
  try {
    let current = realpathSync(tmp);
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stats = lstatSync(current);
      const folder = directory || index < parts.length - 1;
      if (!owned(stats) || (folder ? !stats.isDirectory() : !stats.isFile())) return;
    }
    return current;
  } catch {
    return;
  }
}

function directories(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function listFiles() {
  const files: { file: string; tree?: string }[] = [];
  const history = join(tmp, "fb-history");
  if (trustedPath(history, true)) {
    for (const item of directories(history)) files.push({ file: join(item, "tech-debt.json") });
  }
  for (const tree of directories(tmp)) {
    const runs = join(tree, ".trioharness-direct", "runs");
    if (!trustedPath(runs, true)) continue;
    for (const run of directories(runs)) files.push({ file: join(run, "tech-debt.json"), tree });
  }
  return files;
}

function readFile(file: string) {
  const path = trustedPath(file, false);
  if (!path) return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || stat.size > maxBytes) return;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    return { text: buffer.toString("utf8", 0, offset), date: stat.mtime.toISOString() };
  } finally {
    closeSync(fd);
  }
}

/** The startup issue references and local review locations used by production entry points. */
export function defaultTechDebtSeed(): SeedOptions {
  return {
    issues: [
      {
        repo: "Cumulus-Service-GmbH/foundry-agent-webapp",
        issue: "Cumulus-Service-GmbH/foundry-agent-webapp#246",
      },
      {
        repo: "Cumulus-Service-GmbH/WebChatMobile",
        issue: "Cumulus-Service-GmbH/WebChatMobile#202",
      },
    ],
    backfill: { files: [join(tmp, "fb-out", "tech-debt.md")] },
    listFiles,
    readFile,
    gitOrigin: async (tree) => {
      const path = trustedPath(tree, true);
      if (!path) return null;
      try {
        const { stdout } = await runGit("git", ["-C", path, "remote", "get-url", "origin"], {
          timeout: 5000,
          maxBuffer: 8192,
        });
        return stdout.trim();
      } catch {
        return null;
      }
    },
  };
}
