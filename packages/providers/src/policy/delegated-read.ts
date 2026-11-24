import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { plainReadTargets } from "@codeden/contracts";
import { isInsidePath } from "../util/workspace-guard";
import { isSecretPath, SECRET_SEARCH_GLOBS } from "./paths";

/** Worktree-scoped plain reads only. Recheck paths every time a grant is used. */
export function guardedReadCommand(
  tool: Parameters<typeof plainReadTargets>[0],
  cwd: string | undefined,
  root: string,
): string | undefined {
  const targets = plainReadTargets(tool);
  if (!targets || !tool.command || !cwd || !isAbsolute(cwd) || !isAbsolute(root)) return;
  try {
    const realRoot = realpathSync(root);
    const realCwd = realpathSync(cwd);
    if (!isInsidePath(realRoot, realCwd) || !statSync(realCwd).isDirectory()) return;
    for (const read of targets) {
      const target = resolve(realCwd, read);
      if (
        !isInsidePath(realRoot, target) ||
        isSecretPath(target) ||
        realpathSync(target) !== target
      )
        return;
      const stat = statSync(target);
      if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) return;
    }
  } catch {
    return;
  }

  const command = tool.command.trim();
  if (command.startsWith("rg ")) {
    const exclusions = SECRET_SEARCH_GLOBS.map((glob) => `--iglob '!**/${glob}'`).join(" ");
    return `command rg --no-config ${exclusions} ${command.slice(3)}`;
  }
  if (command.startsWith("git ")) {
    const prefix = "command git --no-pager --no-optional-locks -c core.fsmonitor=false";
    return /^git +show /.test(command)
      ? command.replace(/^git +show\b/, `${prefix} show --no-ext-diff --no-textconv`)
      : command.replace(/^git +status\b/, `${prefix} status --ignore-submodules=all`);
  }
  return `command ${command}`;
}
