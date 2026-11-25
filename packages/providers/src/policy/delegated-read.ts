import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isPrivateReadPath, plainReadTargets } from "@codeden/contracts";
import { isInsidePath } from "../util/workspace-guard";
import { isSecretPath } from "./paths";

/** Worktree-scoped plain reads only. Recheck paths every time a grant is used. */
export function guardedReadCommand(
  tool: Parameters<typeof plainReadTargets>[0],
  cwd: string | undefined,
  root: string,
): string | undefined {
  const targets = plainReadTargets(tool);
  if (!targets || !tool.command || !cwd || !isAbsolute(cwd) || !isAbsolute(root)) return;
  const command = tool.command.trim();
  const listsDirectories = command === "ls" || command.startsWith("ls ");
  try {
    const realRoot = realpathSync(root);
    const realCwd = realpathSync(cwd);
    if (
      !isInsidePath(realRoot, realCwd) ||
      isPrivateReadPath(relative(realRoot, realCwd)) ||
      !statSync(realCwd).isDirectory()
    )
      return;
    if (command.startsWith("git ")) {
      if (realCwd !== realRoot) return;
      const gitEntry = lstatSync(resolve(realRoot, ".git"));
      if (!gitEntry.isFile() && !gitEntry.isDirectory()) return;
    }
    for (const read of targets) {
      const target = resolve(realCwd, read);
      if (
        !isInsidePath(realRoot, target) ||
        isPrivateReadPath(relative(realRoot, target)) ||
        isSecretPath(target) ||
        realpathSync(target) !== target
      )
        return;
      const stat = statSync(target);
      if (listsDirectories && stat.isDirectory()) continue;
      if (!stat.isFile() || stat.nlink !== 1) return;
    }
  } catch {
    return;
  }

  // Codex accepts the provider request unchanged. Its grammar requires the protections
  // that Claude can apply by substituting the hardened invocation.
  if (tool.toolName === "shell") return command;
  if (command.startsWith("rg ")) return `command rg --no-config ${command.slice(3)}`;
  if (command.startsWith("git ")) {
    const prefix = "command git --no-pager --no-optional-locks -c core.fsmonitor=false";
    return command.replace(/^git +(show|log|diff)\b/, (_match, sub: string) =>
      sub === "log"
        ? `${prefix} log --no-show-signature --no-notes --no-decorate`
        : `${prefix} ${sub} --no-ext-diff --no-textconv`,
    );
  }
  return `command ${command}`;
}
