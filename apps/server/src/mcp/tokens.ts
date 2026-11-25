import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { McpTokenClaims, Role } from "@codeden/contracts";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { mcpTokens, sessions } from "../db/schema";

/** Prefix of CodeDen MCP tokens, so they are recognisable (and never confused with others). */
const PREFIX = "cdm_";

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function workerSignature(id: string, tokenHash: string): Buffer {
  return createHmac("sha256", tokenHash).update(`codeden-worker:${id}`).digest();
}

/**
 * Per-session MCP bearer tokens (§8.3, §15). A token encodes nothing itself: it is a random
 * secret whose SHA-256 hash maps to the claims (role, project, session), so it survives
 * restarts. Each provider process a session is opened with gets its own token. Minting
 * revokes nothing: the launcher retires tokens once the runner has answered the open
 * (`SessionLauncher`), so an open that fails never strands a process still running with an
 * earlier one. Ending a session revokes them all. The install token is never accepted here,
 * and MCP tokens are never accepted by the HTTP API.
 */
export class McpTokenStore {
  constructor(private readonly db: Db) {}

  /** A write-only worker bearer tied to the same lifetime as a provider's MCP token. */
  workerToken(token: string): string | undefined {
    const claims = this.verify(token);
    if (claims)
      return `cdw_${claims.jti}.${workerSignature(claims.jti, hash(token)).toString("hex")}`;
  }

  workerSession(token: string): string | undefined {
    const match = /^cdw_([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(token);
    const id = match?.[1];
    const signature = match?.[2];
    if (!id || !signature) return undefined;
    const row = this.db
      .select({ token: mcpTokens })
      .from(mcpTokens)
      .innerJoin(sessions, eq(sessions.id, mcpTokens.sessionId))
      .where(and(eq(mcpTokens.id, id), isNull(mcpTokens.revokedAt), isNull(sessions.archivedAt)))
      .get()?.token;
    if (row && timingSafeEqual(workerSignature(id, row.tokenHash), Buffer.from(signature, "hex")))
      return row.sessionId;
  }

  /** Issue a token for a session; returns the secret (store it only in the agent config). */
  mint(claims: { role: Role; sessionId: string; projectId: string | null }): string {
    const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
    this.db
      .insert(mcpTokens)
      .values({
        id: randomUUID(),
        tokenHash: hash(token),
        role: claims.role,
        sessionId: claims.sessionId,
        projectId: claims.projectId,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      })
      .run();
    return token;
  }

  /** Claims of a live token, or undefined for unknown and revoked tokens. */
  verify(token: string | undefined): McpTokenClaims | undefined {
    if (!token?.startsWith(PREFIX)) return undefined;
    const result = this.db
      .select({ token: mcpTokens, archivedAt: sessions.archivedAt })
      .from(mcpTokens)
      .leftJoin(sessions, eq(sessions.id, mcpTokens.sessionId))
      .where(and(eq(mcpTokens.tokenHash, hash(token)), isNull(mcpTokens.revokedAt)))
      .get();
    if (!result || (result.token.role !== "agent" && result.archivedAt)) return undefined;
    const row = result.token;
    return {
      role: row.role as Role,
      sessionId: row.sessionId,
      projectId: row.projectId,
      jti: row.id,
    };
  }

  /** Revoke one token (the provider process it was minted for never started). */
  revoke(token: string): void {
    this.db
      .update(mcpTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(mcpTokens.tokenHash, hash(token)), isNull(mcpTokens.revokedAt)))
      .run();
  }

  /**
   * Revoke every token of a session (it ended), or, with `except`, every token but that one
   * (the session was reopened with it, so the processes the others were given are gone).
   */
  revokeSession(sessionId: string, except?: string): void {
    this.db
      .update(mcpTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(
        and(
          eq(mcpTokens.sessionId, sessionId),
          isNull(mcpTokens.revokedAt),
          except === undefined ? undefined : ne(mcpTokens.tokenHash, hash(except)),
        ),
      )
      .run();
  }
}
