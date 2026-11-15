import { type RiskAssessment, risky } from "./assessment";
import { commandWrite } from "./command-writes";
import { type PathContext, resolveAgainst } from "./paths";
import type { SimpleCommand } from "./shell";

/**
 * CodeDen's project config, `.codeden/project.json` (§9): its `setup` commands run in every new
 * worktree and its `checks` are what sessions run after each turn. An agent that rewrites it
 * would choose commands CodeDen runs outside the approval flow, for later sessions once it is
 * merged. A running session's checks are frozen when it is created and never read from its
 * worktree, so the edit can't reach it; still, writing the file is a risk that Supervised and
 * Auto ask about (Full, with no approvals inside the worktree, runs it). Reads don't ask.
 */

/** Whether `target` is `.codeden/project.json`, or the `.codeden` folder a copy may land in. */
export function isProjectConfigPath(target: string, ctx: PathContext): boolean {
  const parts = resolveAgainst(target, ctx)
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const base = parts.at(-1) ?? "";
  return base === ".codeden" || (base === "project.json" && parts.at(-2) === ".codeden");
}

/** The verdict on writing CodeDen's project config. */
export function projectConfigRisk(target: string): RiskAssessment {
  return risky(
    "file_change",
    `Changes CodeDen's project config (${target}): its setup and check commands run in later sessions`,
  );
}

/** The verdict on writing `target` when it is CodeDen's project config, else undefined. */
export function projectConfigWrite(target: string, ctx: PathContext): RiskAssessment | undefined {
  return isProjectConfigPath(target, ctx) ? projectConfigRisk(target) : undefined;
}

/** The project config named in code (`'.codeden/project.json'`). */
const MENTION = /\.codeden[\\/]+project\.json/i;

/**
 * One simple command's write of CodeDen's project config: a redirect, inline interpreter code
 * that names it, or a writing command's argument (`tee`, `cp`, `sed -i`, `Set-Content`,
 * `git checkout -- .codeden/project.json`, ...).
 */
export function projectConfigCommand(
  cmd: SimpleCommand,
  ctx: PathContext,
): RiskAssessment | undefined {
  return commandWrite(cmd, {
    write: (path) => projectConfigWrite(path, ctx),
    mention: (code) => {
      const named = MENTION.exec(code);
      return named ? projectConfigRisk(named[0]) : undefined;
    },
  });
}
