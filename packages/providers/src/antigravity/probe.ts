import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyAcpError } from "../acp/errors";
import { notify } from "../acp/notify";
import { startAgent } from "../acp/process";
import type { AcpInitializeResult, AcpSessionSetup } from "../acp/protocol";
import { type AcpRpc, AcpRpcError, METHOD_NOT_FOUND } from "../acp/rpc";
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
  /** What a throwaway session listed (models, thinking levels), when it opened in time. */
  setup?: AcpSessionSetup;
  /** False when the throwaway session was refused because the CLI isn't signed in. */
  signedIn?: false;
  /** Why the ACP server didn't start, when it didn't. */
  error?: string;
}

/** Called the moment each reply arrives, so the caller orders them with its sessions' reports. */
export interface AntigravityProbeReports {
  onInfo?: (info: AcpInitializeResult) => void;
  onSetup?: (setup: AcpSessionSetup) => void;
}

/** How long the throwaway session may take to list the models; then Default stands in. */
const SETUP_TIMEOUT_MS = 8_000;

/**
 * Open one throwaway session (no MCP servers, no prompt) to read the account's models and
 * thinking levels, reported through `onSetup` as it arrives. Undefined when it fails or is
 * slow (a signed-out CLI, reported through `onSignedOut`, an old one, a hang); a reply after the
 * deadline is dropped.
 */
export async function listSetup(
  rpc: AcpRpc,
  cwd: string,
  timeoutMs: number,
  onSetup?: (setup: AcpSessionSetup) => void,
  onSignedOut?: () => void,
): Promise<AcpSessionSetup | undefined> {
  let timer: NodeJS.Timeout | undefined;
  // Checked against a monotonic clock, so a reply past the deadline never counts even when
  // the timer itself runs late.
  const due = performance.now() + timeoutMs;
  let late = false;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      resolve(undefined);
    }, timeoutMs);
  });
  const opened = rpc
    .request<AcpSessionSetup>("session/new", { cwd, mcpServers: [] })
    .then((setup) => {
      if (!setup || late || performance.now() > due) return undefined;
      notify(() => onSetup?.(setup));
      return setup;
    })
    .catch((error) => {
      // Refused for authentication: the CLI answers, but isn't signed in.
      if (!late && performance.now() <= due && classifyAcpError(error) === "auth") onSignedOut?.();
      return undefined;
    });
  try {
    return await Promise.race([opened, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start `agy acp` once, check it answers `initialize` with ACP version 1, and open one throwaway
 * session in an empty scratch folder to list the account's models (`listSetup`). No
 * `authenticate`, no prompt and so no model call; CodeDen passes no MCP servers, though the
 * CLI may start the user's own and keep the empty session in its history. Never throws.
 */
export async function probeAntigravity(
  exe: ResolvedCommand,
  opts: { timeoutMs?: number; setupTimeoutMs?: number } & AntigravityProbeReports = {},
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
    try {
      notify(() => opts.onInfo?.(started.info));
      const timeout = opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
      let signedOut = false;
      const setup = await listSetup(started.rpc, cwd, timeout, opts.onSetup, () => {
        signedOut = true;
      });
      return {
        acp: true,
        info: started.info,
        ...(setup ? { setup } : {}),
        ...(signedOut ? { signedIn: false as const } : {}),
      };
    } finally {
      await started.rpc.close();
    }
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
    try {
      if (cwd) rmSync(cwd, { recursive: true, force: true });
    } catch {
      // A leftover empty scratch folder doesn't change what the probe found.
    }
  }
}
