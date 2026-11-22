import { runnerErrorCode } from "../runner-port";

export interface RetireDeps {
  stop: (id: string) => Promise<unknown>;
  revokeTokens: (id: string) => void;
  warn?: (message: string) => void;
}

/**
 * Retire a role conversation that "Start fresh" archived: its MCP tokens go at once, so it can't
 * act through CodeDen even if stopping it fails (a failed revocation is tried again with each
 * stop, since it needs no runner), then it is stopped. A failed stop is logged
 * (the session id and error code only) and tried once more; an unreachable runner counts as a
 * failed stop. Never rejects.
 */
export async function retireRoleSession(deps: RetireDeps, id: string): Promise<void> {
  const warn =
    deps.warn ?? ((message) => console.warn(`[codeden] ${new Date().toISOString()} ${message}`));
  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    try {
      deps.revokeTokens(id);
      revoked = true;
    } catch {
      warn(`Revoking the tokens of archived role session ${id} failed`);
    }
  };
  revoke();
  for (const attempt of [1, 2]) {
    try {
      await deps.stop(id);
      return;
    } catch (error) {
      const code = runnerErrorCode(error) ?? "unknown_error";
      // A revocation doesn't need the runner: try it again with each stop.
      revoke();
      const tokens = revoked ? "its tokens are revoked" : "its tokens could not be revoked";
      warn(
        attempt === 1
          ? `Stopping archived role session ${id} failed (${code}); trying once more`
          : `Stopping archived role session ${id} failed again (${code}); ${tokens}`,
      );
    }
  }
}
