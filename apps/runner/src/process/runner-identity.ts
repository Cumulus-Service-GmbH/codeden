import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, realpathSync, rmSync } from "node:fs";
import { holdsMacFile } from "./table";

function markerPath(lockFile: string, token: string): string {
  const digest = createHash("sha256").update(token).digest("hex");
  return `${lockFile}.owner-${digest}`;
}

/** A separate, private marker bound to this lock generation and held open for writing. */
export function holdRunnerIdentity(lockFile: string, token: string) {
  const path = markerPath(lockFile, token);
  const fd = openSync(path, "wx", 0o600);
  let closed = false;
  return {
    fd,
    path,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } finally {
        rmSync(path, { force: true });
      }
    },
  };
}

export async function verifyRunnerIdentity(lockFile: string, token: string, pid: number) {
  const path = markerPath(lockFile, token);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
      return false;
    }
    const canonical = realpathSync(path);
    return await holdsMacFile(pid, canonical);
  } catch {
    return false;
  }
}
