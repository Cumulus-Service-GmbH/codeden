import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  FORK_RELEASE_REPOSITORY,
  FORK_SIGNER_NAME,
} from "../../packages/contracts/src/fork-build.ts";

const commit = process.env.GITHUB_SHA;
const output = process.argv[2];
if (
  !output ||
  !/^[0-9a-f]{40}$/.test(commit ?? "") ||
  process.env.GITHUB_REPOSITORY !== FORK_RELEASE_REPOSITORY
) {
  throw new Error("Expected the reviewed fork build and a receipt output directory");
}
const desktop = resolve("apps/desktop");
const { version } = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable desktop version");
const tag = `fork-v${version}`;
await mkdir(output);
for (const [arch, directory] of [
  ["arm64", "mac-arm64"],
  ["x64", "mac"],
]) {
  const bundle = join(desktop, "release", directory, "CodeDen.app");
  const certificate = new X509Certificate(
    execFileSync(join(desktop, "dist", "fork-signature"), [bundle]),
  );
  if (
    certificate.toLegacyObject().subject.CN !== FORK_SIGNER_NAME ||
    !certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.3")
  ) {
    throw new Error(
      `${arch} artifact lacks the required ${FORK_SIGNER_NAME} signer and codeSigning EKU`,
    );
  }
  const artifact = `CodeDen-${version}-${arch}.zip`;
  const archive = join(output, artifact);
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive]);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const receipt = {
    repository: FORK_RELEASE_REPOSITORY,
    tag,
    commit,
    artifact,
    sha256: hash.digest("hex"),
  };
  await writeFile(`${archive}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
}
