import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ownerApprovalCheck } from "../src/services/github/owner-approval-check";

const target = {
  kind: "merge_verify",
  repository: "Org/Repo",
  pullNumber: 17,
  headSha: "c".repeat(40),
} as const;
const cardId = "67eb3bb7-e1c9-410e-947a-8e1f2c87bf0d";

afterEach(() => vi.unstubAllEnvs());

it("publishes a signed, neutral check for the claimed card and exact head", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("CODEDEN_OWNER_APPROVAL_CHECK", "1");
  vi.stubEnv("CODEDEN_OWNER_APPROVAL_APP_ID", "23");
  vi.stubEnv("CODEDEN_OWNER_APPROVAL_INSTALLATION_ID", "45");
  const readKey = async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fixture = "installation-token-fixture";
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ token: fixture }, { status: 201 }))
    .mockResolvedValueOnce(
      Response.json(
        { app: { id: 23 }, head_sha: target.headSha, external_id: cardId },
        { status: 201 },
      ),
    );
  expect(await ownerApprovalCheck(readKey, fetch)?.(target, cardId)).toBe("posted");
  const [auth, check] = fetch.mock.calls;
  expect(auth?.[0]).toBe("https://api.github.com/app/installations/45/access_tokens");
  expect(JSON.parse(String(auth?.[1]?.body))).toEqual({
    repositories: ["Repo"],
    permissions: { checks: "write" },
  });
  const jwt = new Headers(auth?.[1]?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
  const [header, claims, jwtSignature] = jwt.split(".");
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${claims}`),
      publicKey,
      Buffer.from(jwtSignature ?? "", "base64url"),
    ),
  ).toBe(true);
  expect(check?.[0]).toBe("https://api.github.com/repos/Org/Repo/check-runs");
  const body = JSON.parse(String(check?.[1]?.body));
  expect(body).toMatchObject({
    name: "codeden/owner-approval",
    head_sha: target.headSha,
    external_id: cardId,
    status: "completed",
    conclusion: "neutral",
  });
  const summary = JSON.parse(body.output.summary);
  expect(summary.cardId).toBe(cardId);
  const message = (head: string, id: string) =>
    Buffer.from(JSON.stringify(["codeden-owner-approval:v1", "org/repo", 17, head, id]));
  const signature = Buffer.from(summary.signature, "base64url");
  expect(verify("RSA-SHA256", message(target.headSha, cardId), publicKey, signature)).toBe(true);
  expect(verify("RSA-SHA256", message("a".repeat(40), cardId), publicKey, signature)).toBe(false);
  expect(verify("RSA-SHA256", message(target.headSha, "wrong-card"), publicKey, signature)).toBe(
    false,
  );
});

it("defaults off and fails closed if enabled with incomplete configuration", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  expect(ownerApprovalCheck(async () => null, fetch)).toBeUndefined();
  vi.stubEnv("CODEDEN_OWNER_APPROVAL_CHECK", "1");
  expect(await ownerApprovalCheck(async () => null, fetch)?.(target, cardId)).toBe("failed");
  expect(fetch).not.toHaveBeenCalled();
});
