import { type RiskAssessment, risky } from "./assessment";
import { commandWrite } from "./command-writes";
import { type PathContext, resolveAgainst } from "./paths";
import type { SimpleCommand } from "./shell";

/**
 * CodeDen's files in a project's `.codeden` folder that decide what CodeDen itself runs:
 * - `project.json` (§9): its `setup` commands run in every new worktree and its `checks` are
 *   what sessions run after each turn.
 * - `automations/*.md` (§10): each project automation's prompt, permission level and schedule.
 * - `VISION.md` (§10.1): the factory's vision, including its protected areas.
 * An agent that rewrites one would choose what CodeDen runs or allows outside the approval
 * flow, for later sessions once it is merged. A running session's checks are frozen when it is
 * created, and an automation whose file changes what it does is switched off until a person
 * switches it on again; still, writing these files is a risk that Supervised and Auto ask about
 * (Full, with no approvals inside the worktree, runs it). Reads don't ask.
 */

type CodedenFile = "config" | "automation" | "vision";

/** Which of CodeDen's files `target` is, or the folder (`.codeden`, `.codeden/automations`) a copy may land in. */
function codedenFileOf(target: string, ctx: PathContext): CodedenFile | undefined {
  const parts = resolveAgainst(target, ctx)
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const base = parts.at(-1) ?? "";
  if (base === ".codeden") return "config";
  const dot = parts.lastIndexOf(".codeden");
  if (dot === -1) return undefined;
  const inside = parts.slice(dot + 1);
  if (inside[0] === "automations") return "automation";
  if (inside.length !== 1) return undefined;
  if (base === "project.json") return "config";
  if (base === "vision.md") return "vision";
  return undefined;
}

/** Whether `target` is one of CodeDen's protected `.codeden` files, or a folder they live in. */
export function isProjectConfigPath(target: string, ctx: PathContext): boolean {
  return codedenFileOf(target, ctx) !== undefined;
}

const REASONS: Record<CodedenFile, (target: string) => string> = {
  config: (target) =>
    `Changes CodeDen's project config (${target}): its setup and check commands run in later sessions`,
  automation: (target) =>
    `Changes a CodeDen automation file (${target}): what an automation runs, with which permissions and when`,
  vision: (target) =>
    `Changes the project's vision (${target}): it sets what the factory builds and its protected areas`,
};

/** The verdict on writing one of CodeDen's protected files (the project config by default). */
export function projectConfigRisk(target: string, file: CodedenFile = "config"): RiskAssessment {
  return risky("file_change", REASONS[file](target));
}

/** The verdict on writing `target` when it is one of CodeDen's protected files, else undefined. */
export function projectConfigWrite(target: string, ctx: PathContext): RiskAssessment | undefined {
  const file = codedenFileOf(target, ctx);
  return file ? projectConfigRisk(target, file) : undefined;
}

/** A protected file named in code (`'.codeden/project.json'`, `.codeden/automations/x.md`). */
const MENTION = /\.codeden[\\/]+(?:(project\.json)|(vision\.md)|(automations)(?![\w.-]))/i;

/**
 * One simple command's write of CodeDen's protected files: a redirect, inline interpreter code
 * that names one, or a writing command's argument (`tee`, `cp`, `sed -i`, `Set-Content`,
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
      if (!named) return undefined;
      const file: CodedenFile = named[1] ? "config" : named[2] ? "vision" : "automation";
      return projectConfigRisk(named[0], file);
    },
  });
}
