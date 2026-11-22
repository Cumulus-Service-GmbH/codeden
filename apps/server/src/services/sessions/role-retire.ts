import { runnerErrorCode } from "../runner-port";

export interface RetireDeps {
  stop: (id: string) => Promise<unknown>;
  revokeTokens: (id: string) => void;
  warn?: (message: string) => void;
}

/**
 * Retire a role conversation that "Start fresh" archived: its MCP tokens go at once, so it can't
 * act through CodeDen even if stopping it fails, then it is stopped. A failed stop is logged
 * (the session id and error code only) and tried once more; an unreachable runner counts as a
 * failed stop. Never rejects.
 */
export async function retireRoleSession(deps: RetireDeps, id: string): Promise<void> {
  const warn =
    deps.warn ?? ((message) => console.warn(`[codeden] ${new Date().toISOString()} ${message}`));
  try {
    deps.revokeTokens(id);
  } catch {
    // A confirmed stop revokes them again (`SessionService.stop`).
    warn(`Revoking the tokens of archived role session ${id} failed; stopping it anyway`);
  }
  for (const attempt of [1, 2]) {
    try {
      await deps.stop(id);
      return;
    } catch (error) {
      const code = runnerErrorCode(error) ?? "unknown_error";
      warn(
        attempt === 1
          ? `Stopping archived role session ${id} failed (${code}); trying once more`
          : `Stopping archived role session ${id} failed again (${code}); its tokens stay revoked`,
      );
    }
  }
}
