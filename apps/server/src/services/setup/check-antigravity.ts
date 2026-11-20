import {
  ANTIGRAVITY_UPGRADE_COMMAND,
  antigravityTooOldMessage,
  isSupportedAntigravityVersion,
} from "@codeden/providers";
import { base, type CheckEnv, type CheckResult, installFix } from "./check-base";
import { loginFix, lookupTool } from "./tool-lookup";

/**
 * The Antigravity CLI (§14): a working `agy` (PATH, then `~/.local/bin`, where its installer
 * puts it) of at least the version CodeDen supports. Its ACP server reuses the login of an
 * interactive `agy`, which CodeDen can't see without reading credentials, so the login is left
 * unknown (`loggedIn: null`) and the check says how to sign in; a session that finds it signed
 * out says so too. The CLI has no login command: `agy` on its own asks how to sign in.
 */
export async function checkAntigravity({
  locate,
  shell,
  platform,
}: CheckEnv): Promise<CheckResult> {
  const tool = await lookupTool(locate, "agy", base("antigravity"), {
    message: "The Antigravity CLI is not installed",
    fix: installFix("antigravity", platform),
  });
  if (!tool.found) return tool.result;
  const installed = {
    ...base("antigravity"),
    ...tool.extra,
    installed: true,
    version: tool.version,
    executablePath: tool.path,
  };
  if (!isSupportedAntigravityVersion(tool.version)) {
    // Sessions refuse to open on it: "Antigravity CLI 1.5.0 is too old (needs 1.5.12+)".
    return {
      ...installed,
      state: "missing",
      message: antigravityTooOldMessage(tool.version),
      fix: { kind: "upgrade", command: ANTIGRAVITY_UPGRADE_COMMAND },
    };
  }
  return {
    ...installed,
    state: "ok",
    message: "Installed; uses the login from `agy`",
    detail: "Run `agy` once and sign in if sessions report that it is not signed in.",
    fix: loginFix("antigravity", shell, tool.path),
  };
}
