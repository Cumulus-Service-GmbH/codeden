import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { type ForkCandidate, verifyReceipt, verifySigner } from "./fork-release";

const run = promisify(execFile);
const MAX_ARCHIVE = 512 * 1024 * 1024;

export async function inspectSigner(verifier: string, bundle: string) {
  const { stdout } = await run(verifier, [bundle], { encoding: "buffer", timeout: 60_000 });
  const certificate = new X509Certificate(stdout);
  const { CN } = certificate.toLegacyObject().subject;
  return {
    commonName: typeof CN === "string" ? CN : undefined,
    usages: certificate.keyUsage ?? [],
    fingerprint: certificate.fingerprint256,
  };
}

export async function stageForkUpdate(bundle: string, verifier: string, candidate: ForkCandidate) {
  if (basename(bundle) !== "CodeDen.app" || (await realpath(bundle)) !== bundle) {
    throw new Error("Update requires a local CodeDen.app bundle at its real install path");
  }
  const installed = await inspectSigner(verifier, bundle);
  verifySigner(installed, installed.fingerprint);
  await access(dirname(bundle), constants.W_OK);
  const receiptResponse = await fetch(candidate.receiptUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!receiptResponse.ok) throw new Error("Could not download the update receipt");
  const receipt = verifyReceipt(await receiptResponse.json(), candidate.tag, candidate.artifact);
  const work = await mkdtemp(join(dirname(bundle), ".codeden-update-"));
  try {
    const archive = join(work, candidate.artifact);
    const response = await fetch(candidate.archiveUrl, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error("Could not download the update archive");
    let bytes = 0;
    const hash = createHash("sha256");
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_ARCHIVE)
          return callback(new Error("Update archive exceeds the size limit"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.from(response.body),
      digest,
      createWriteStream(archive, { flags: "wx" }),
    );
    verifyReceipt(receipt, candidate.tag, candidate.artifact, hash.digest("hex"));

    const listing = await run("/usr/bin/tar", ["-tf", archive], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (
      listing.stdout
        .trimEnd()
        .split("\n")
        .some(
          (file) =>
            !(/^(?:__MACOSX\/)?CodeDen\.app\//.test(file) || file === "__MACOSX/") ||
            file.split("/").some((part) => part === ".."),
        )
    )
      throw new Error("Update archive contains unexpected paths");
    await run("/usr/bin/tar", ["-xkf", archive, "-C", work], { timeout: 60_000 });
    const staged = join(work, "CodeDen.app");
    if (!(await lstat(staged)).isDirectory()) throw new Error("Update bundle is missing");
    verifySigner(await inspectSigner(verifier, staged), installed.fingerprint);
    const commit = (
      await readFile(join(staged, "Contents", "Resources", "app", "dist", "fork-commit"), "utf8")
    ).trim();
    if (commit !== receipt.commit) throw new Error("Bundle commit does not match the receipt");
    await rm(archive);
    return { work, staged, commit, version: candidate.version };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}
