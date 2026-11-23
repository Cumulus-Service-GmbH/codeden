import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export function historyDigest(history: Buffer): string {
  return createHash("sha256").update(history).digest("hex");
}

/** Rebuild the item history atomically, preserving all prior round sections. */
export async function recordTeamHistory(path: string, section: string): Promise<Buffer> {
  const previous = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return Buffer.alloc(0);
  });
  const contents = Buffer.concat([previous, Buffer.from(section)]);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return contents;
}
