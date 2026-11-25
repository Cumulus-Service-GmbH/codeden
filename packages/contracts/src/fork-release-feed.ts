import { UPSTREAM_RELEASE_REPOSITORY } from "./fork-build";
import type { UpstreamRelease } from "./fork-update";

export async function fetchGithubLatest(repository: string, doFetch: typeof fetch) {
  const response = await doFetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`);
  return (await response.json()) as { tag_name?: unknown; assets?: Array<{ name: string }> };
}

export async function watchUpstream(doFetch: typeof fetch): Promise<UpstreamRelease | null> {
  const release = await fetchGithubLatest(UPSTREAM_RELEASE_REPOSITORY, doFetch).catch(() => null);
  const tag = release?.tag_name;
  return typeof tag === "string" && /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)
    ? { version: tag, url: `https://github.com/${UPSTREAM_RELEASE_REPOSITORY}/releases/tag/${tag}` }
    : null;
}

export function forkReleaseVersion(tag: unknown): string | undefined {
  return typeof tag === "string" ? /^fork-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1] : undefined;
}
