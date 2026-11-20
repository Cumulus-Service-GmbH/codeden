import type { ProviderIssue, ProviderStatus } from "@codeden/contracts";
import { brokenInstallMessage, type DetectExeOptions, lookupForDetect } from "../util/detect-exe";
import type { ResolvedCommand } from "../util/exec";
import { compareVersions } from "../util/version";
import type { AntigravityProbe } from "./probe";

/**
 * Oldest Antigravity CLI CodeDen supports: 1.5.12, the release whose ACP server takes
 * `--process-per-session` (needed for HTTP MCP servers) and lists its models and thinking
 * levels as session config options.
 */
export const ANTIGRAVITY_MIN_VERSION = "1.5.12";
export const ANTIGRAVITY_INSTALL_COMMAND =
  "curl -fsSL https://antigravity.google/cli/install.sh | bash";
/** Its installer also updates an existing copy. */
export const ANTIGRAVITY_UPGRADE_COMMAND = ANTIGRAVITY_INSTALL_COMMAND;
/** The CLI has no login command: started on its own, it asks how to sign in. */
export const ANTIGRAVITY_LOGIN_COMMAND = "agy";

/** Whether an Antigravity CLI version is one CodeDen supports. */
export function isSupportedAntigravityVersion(version: string | null | undefined): boolean {
  return !!version && compareVersions(version, ANTIGRAVITY_MIN_VERSION) >= 0;
}

/** "Antigravity CLI 1.5.0 is too old (needs 1.5.12+)": detection, the setup check, a refused open. */
export function antigravityTooOldMessage(version: string | null | undefined): string {
  return `Antigravity CLI ${version || "(unknown version)"} is too old (needs ${ANTIGRAVITY_MIN_VERSION}+)`;
}

export interface AntigravityDetectOptions extends DetectExeOptions {
  /** Start `agy acp` once to check it answers (`probeAntigravity`); supported versions only. */
  probe?: (exe: ResolvedCommand, version: string | null) => Promise<AntigravityProbe>;
}

/**
 * Find a working `agy` (PATH, then `~/.local/bin`, where its installer puts it), check its
 * version and that its ACP server answers (§14). The CLI reuses the login of an interactive
 * `agy`, which CodeDen can't read without touching credentials, so the login is reported as
 * unknown (`loggedIn: null`); a session that finds it signed out says how to sign in. Never
 * throws.
 */
export async function detectAntigravity(
  opts: AntigravityDetectOptions = {},
): Promise<ProviderStatus> {
  const status: ProviderStatus = {
    providerId: "antigravity",
    installed: false,
    version: null,
    executablePath: null,
    loggedIn: null,
    authMethod: null,
    account: null,
    loginExpiresAt: null,
    supported: false,
    issues: [],
    checkedAt: new Date().toISOString(),
  };
  const issues: ProviderIssue[] = [];
  const install = { kind: "install" as const, command: ANTIGRAVITY_INSTALL_COMMAND };
  const upgrade = { kind: "upgrade" as const, command: ANTIGRAVITY_UPGRADE_COMMAND };
  const lookup = await lookupForDetect("agy", { ...opts, timeoutMs: opts.timeoutMs ?? 15_000 });
  const broken = lookup.broken.length > 0 ? { broken: lookup.broken } : {};
  const exe = lookup.command;
  if (!exe) {
    issues.push(
      lookup.broken.length > 0
        ? {
            code: "broken_install",
            message: brokenInstallMessage("Antigravity CLI", lookup.broken),
            fix: install,
          }
        : {
            code: "not_installed",
            message: "The Antigravity CLI is not installed (no `agy` on PATH or in ~/.local/bin).",
            fix: install,
          },
    );
    return { ...status, ...broken, issues };
  }
  const found = {
    ...status,
    ...broken,
    installed: true,
    version: lookup.version,
    executablePath: exe.kind === "node-script" ? exe.script : exe.path,
  };
  if (!isSupportedAntigravityVersion(lookup.version)) {
    // Sessions refuse to open on it (`AntigravityAdapter.openSession`): `minVersion` makes it
    // unavailable.
    issues.push({
      code: "version_unsupported",
      message: `${antigravityTooOldMessage(lookup.version)}. Update it.`,
      fix: upgrade,
      minVersion: ANTIGRAVITY_MIN_VERSION,
    });
    return { ...found, issues };
  }
  let supported = true;
  const probe = await opts.probe?.(exe, lookup.version);
  if (probe && !probe.acp) {
    supported = false;
    issues.push({
      code: "version_unsupported",
      message: `Antigravity CLI ${lookup.version} did not start its ACP server (\`agy acp\`)${probe.error ? `: ${probe.error}` : ""}. Update it.`,
      fix: upgrade,
    });
  }
  return { ...found, supported, issues };
}
