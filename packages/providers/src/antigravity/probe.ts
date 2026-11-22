import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAgent } from "../acp/process";
import type { AcpInitializeResult } from "../acp/protocol";
import { AcpRpcError, METHOD_NOT_FOUND } from "../acp/rpc";
import type { ResolvedCommand } from "../util/exec";

/**
 * The arguments that start the Antigravity CLI's ACP server. `--process-per-session` serves each
 * session from its own worker process; without it `initialize` reports no `mcpCapabilities`,
 * and CodeDen's tools are an HTTP MCP server.
 */
export const ANTIGRAVITY_ACP_ARGS = ["acp", "--process-per-session"] as const;

/** What a short-lived `agy acp` showed. */
export interface AntigravityProbe {
  /** The CLI answered `initialize` with ACP version 1. */
  acp: boolean;
  /** What it reported in `initialize` (its capabilities). */
  info?: AcpInitializeResult;
  /** Why the ACP server didn't start, when it didn't. */
  error?: string;
}

/**
 * Start `agy acp` once and check it answers `initialize` with ACP version 1. Only the handshake
 * runs: no `authenticate`, no session (that would save a conversation and start the user's MCP
 * servers), no model call. Never throws.
 */
export async function probeAntigravity(
  exe: ResolvedCommand,
  opts: { timeoutMs?: number } = {},
): Promise<AntigravityProbe> {
  let stderr = "";
  let cwd: string | undefined;
  try {
    // A fresh owner-only folder of its own, so the probe never touches a project.
    cwd = mkdtempSync(path.join(tmpdir(), "codeden-antigravity-probe-"));
    const started = await startAgent(
      exe,
      {
        onNotification: () => {},
        onRequest: async () => {
          throw new AcpRpcError(METHOD_NOT_FOUND, "not supported");
        },
        onExit: (_code, tail) => {
          stderr = tail;
        },
      },
      {
        args: ANTIGRAVITY_ACP_ARGS,
        label: "Antigravity CLI",
        cwd,
        timeoutMs: opts.timeoutMs ?? 20_000,
      },
    );
    await started.rpc.close();
    return { acp: true, info: started.info };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      acp: false,
      error: [message, stderr.trim().split(/\r?\n/).slice(-3).join(" ")]
        .filter(Boolean)
        .join(": ")
        .slice(0, 400),
    };
  } finally {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
}
