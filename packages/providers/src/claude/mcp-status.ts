import { type McpServerLiveState, type McpServerState, mcpServerError } from "@codeden/contracts";

/** Claude Code's MCP server statuses (`system/init` `mcp_servers`, `mcpServerStatus()`). */
const STATES: Record<string, McpServerLiveState> = {
  connected: "connected",
  pending: "starting",
  failed: "failed",
  "needs-auth": "needs_sign_in",
  disabled: "disabled",
};

/**
 * The MCP servers Claude Code reports for a session, as live states: `system/init`'s
 * `mcp_servers` (name and status) or `mcpServerStatus()` (with the error of a failed server).
 * Only names, states and the clipped, masked error are kept: never a server's config. Entries
 * with no name or an unknown status are left out; the first entry of a name wins. A server
 * still failed keeps the error `before` knew when this report has none (init carries none).
 */
export function toMcpServerStates(
  list: unknown,
  before: readonly McpServerState[] = [],
): McpServerState[] {
  if (!Array.isArray(list)) return [];
  const known = new Map(before.map((s) => [s.name, s]));
  const out: McpServerState[] = [];
  const seen = new Set<string>();
  for (const raw of list as Record<string, unknown>[]) {
    const name = typeof raw?.name === "string" ? raw.name.trim().slice(0, 200) : "";
    const state = typeof raw?.status === "string" ? STATES[raw.status] : undefined;
    if (!name || !state || seen.has(name)) continue;
    seen.add(name);
    const prior = known.get(name);
    const error =
      state === "failed"
        ? (mcpServerError(raw.error) ?? (prior?.state === "failed" ? prior.error : undefined))
        : undefined;
    out.push({ name, state, ...(error ? { error } : {}) });
  }
  return out;
}
