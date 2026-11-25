import { createPrivateKey, sign } from "node:crypto";
import type { GitHubApprovalTarget, GitHubCommentOutcome } from "@codeden/contracts";

type MergeTarget = Extract<GitHubApprovalTarget, { kind: "merge_verify" }>;

const CHECK_NAME = "codeden/owner-approval";
const githubId = (value: string | undefined) =>
  value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? value : undefined;

export function ownerApprovalCheck(
  readKey: () => Promise<string | null>,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): ((target: MergeTarget, cardId: string) => Promise<GitHubCommentOutcome>) | undefined {
  if (process.env.CODEDEN_OWNER_APPROVAL_CHECK !== "1") return undefined;
  const appId = githubId(process.env.CODEDEN_OWNER_APPROVAL_APP_ID);
  const installationId = githubId(process.env.CODEDEN_OWNER_APPROVAL_INSTALLATION_ID);

  function post(path: string, token: string, body: object) {
    return fetch(`https://api.github.com${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  }

  return async (target, cardId) => {
    if (!appId || !installationId) return "failed";
    let publicationAttempted = false;
    try {
      const pem = await readKey();
      if (!pem) return "failed";
      const key = createPrivateKey(pem);
      if (
        key.asymmetricKeyType !== "rsa" ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      ) {
        return "failed";
      }
      const signature = (data: string) =>
        sign("RSA-SHA256", Buffer.from(data), key).toString("base64url");
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      const jwt = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
        iat: now - 60,
        exp: now + 480,
        iss: appId,
      })}`;
      const response = await post(
        `/app/installations/${installationId}/access_tokens`,
        `${jwt}.${signature(jwt)}`,
        { repositories: [target.repository.split("/")[1]], permissions: { checks: "write" } },
      );
      if (response.status !== 201) return "failed";
      const { token } = (await response.json()) as { token?: unknown };
      if (typeof token !== "string" || !token) return "failed";

      const signed = JSON.stringify([
        "codeden-owner-approval:v1",
        target.repository.toLowerCase(),
        target.pullNumber,
        target.headSha,
        cardId,
      ]);
      publicationAttempted = true;
      const result = await post(`/repos/${target.repository}/check-runs`, token, {
        name: CHECK_NAME,
        head_sha: target.headSha,
        external_id: cardId,
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "CodeDen owner approval",
          summary: JSON.stringify({ cardId, signature: signature(signed) }),
        },
      });
      if (result.status >= 400 && result.status < 500 && result.status !== 408) return "failed";
      if (result.status !== 201) return "unknown";
      const run = (await result.json()) as {
        app?: { id?: number };
        head_sha?: string;
        external_id?: string;
      };
      return run.app?.id === Number(appId) &&
        run.head_sha === target.headSha &&
        run.external_id === cardId
        ? "posted"
        : "unknown";
    } catch {
      // GitHub or crypto errors can contain credential material.
      return publicationAttempted ? "unknown" : "failed";
    }
  };
}
