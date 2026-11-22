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
export function readChildRuns(dir: string, sessionId: string): ChildRunList {
  let fd: number;
  try {
    fd = openSync(
      childRunsFile(dir, sessionId),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], skipped: 0 };
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new Error(`child-run log of session ${sessionId} is not a regular file`);
    const length = Math.min(stat.size, MAX_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.toString("utf8").split("\n");
    // A cut log starts mid-line: drop that partial first line.
    if (stat.size > MAX_BYTES) lines.shift();
    return foldChildRuns(lines);
  } finally {
    closeSync(fd);
  }
}
