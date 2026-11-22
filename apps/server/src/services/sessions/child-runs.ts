import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { type ChildRunList, foldChildRuns } from "@codeden/contracts";

/** The most of a log that is read: its last 1 MB. */
const MAX_BYTES = 1024 * 1024;

/** A session's child-run log (`CHILD_RUNS_FILE`) under CodeDen's home. */
export function childRunsFile(dir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`unsafe session id ${sessionId}`);
  return join(dir, `${sessionId}.jsonl`);
}

/**
 * The worker runs a session's tools logged, newest first. Only a regular file is read (never a
 * link or a special file), and only its last 1 MB; a missing log means no runs.
 */
export function readChildRuns(
  dir: string,
  sessionId: string,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): ChildRunList {
  // Without an atomic no-follow open (Windows) the entry can't be bound to what is read: the
  // list is unavailable there, never read through a link.
  if (!noFollow) return { runs: [], skipped: 0, available: false };
  let fd: number;
  try {
    fd = openSync(
      childRunsFile(dir, sessionId),
      constants.O_RDONLY | noFollow | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { runs: [], skipped: 0, available: true };
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new Error(`child-run log of session ${sessionId} is not a regular file`);
    const length = Math.min(stat.size, MAX_BYTES);
    const start = stat.size - length;
    // One byte more in front of a cut window tells whether it starts at a line's start.
    const buffer = Buffer.alloc(length + (start > 0 ? 1 : 0));
    readSync(fd, buffer, 0, buffer.length, start > 0 ? start - 1 : 0);
    const text = buffer.toString("utf8");
    const lines = (start > 0 ? text.slice(1) : text).split("\n");
    // The window starts mid-line unless the byte before it ends a line: drop that partial first line.
    if (start > 0 && buffer[0] !== 0x0a) lines.shift();
    return foldChildRuns(lines);
  } finally {
    closeSync(fd);
  }
}
