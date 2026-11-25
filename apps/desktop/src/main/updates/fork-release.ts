import {
  FORK_RELEASE_REPOSITORY,
  FORK_SIGNER_NAME,
  ForkUpdateReceipt,
  fetchGithubLatest,
  forkReleaseVersion,
  watchUpstream,
} from "@codeden/contracts";

export interface ForkCandidate {
  version: string;
  tag: string;
  artifact: string;
  archiveUrl: string;
  receiptUrl: string;
}

export async function findForkUpdate(arch: string, doFetch = fetch) {
  const [release, upstream] = await Promise.all([
    fetchGithubLatest(FORK_RELEASE_REPOSITORY, doFetch).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({
        value: null,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    watchUpstream(doFetch),
  ]);
  if (release.error) return { candidate: null, upstream, error: release.error };
  const tag = release.value?.tag_name;
  const version = forkReleaseVersion(tag);
  if (!version || typeof tag !== "string" || (arch !== "arm64" && arch !== "x64")) {
    return { candidate: null, upstream };
  }
  const artifact = `CodeDen-${version}-${arch}.zip`;
  const receipt = `${artifact}.receipt.json`;
  const names = Array.isArray(release.value?.assets)
    ? release.value.assets.map((asset) => asset.name)
    : [];
  if (!names.includes(artifact) || !names.includes(receipt)) return { candidate: null, upstream };
  const base = `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/download/${tag}`;
  return {
    candidate: {
      version,
      tag,
      artifact,
      archiveUrl: `${base}/${artifact}`,
      receiptUrl: `${base}/${receipt}`,
    },
    upstream,
  };
}

export function verifyReceipt(raw: unknown, tag: string, artifact: string, digest?: string) {
  const result = ForkUpdateReceipt.safeParse(raw);
  if (!result.success || result.data.tag !== tag || result.data.artifact !== artifact) {
    throw new Error("Update receipt does not match the fork release and artifact");
  }
  if (digest !== undefined && result.data.sha256 !== digest) {
    throw new Error("Update archive SHA-256 does not match the receipt");
  }
  return result.data;
}

export interface Signer {
  commonName: string | undefined;
  usages: string[];
  fingerprint: string;
}

export function verifySigner(signer: Signer, installedFingerprint: string) {
  if (signer.commonName !== FORK_SIGNER_NAME || signer.fingerprint !== installedFingerprint) {
    throw new Error(`Update signer must match the installed ${FORK_SIGNER_NAME} certificate`);
  }
  if (!signer.usages.includes("1.3.6.1.5.5.7.3.3")) {
    throw new Error("Update signer certificate is missing the codeSigning EKU");
  }
}
