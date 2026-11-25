import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import budgets from "../../../../scripts/instruction-budgets.json" with { type: "json" };

type Guide = keyof typeof budgets.root;
export type InstructionWarning = { path: string; bytes: number; limit: number; revision: string };
type InstructionFile = Omit<InstructionWarning, "limit"> & { imports: string[] };

const overrides: Readonly<Record<string, number>> = budgets.overrides;
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && !rel.split(sep).some((part) => part === ".." || part === ".git");
}

function importsOf(source: string): string[] {
  const prose = source
    .replace(/^\s*(?:`{3,}|~{3,}).*$[\s\S]*?^\s*(?:`{3,}|~{3,}).*$/gm, "")
    .replace(/`+[^`\n]*?`+/g, "");
  return [...prose.matchAll(/(?:^|\s)@((?:\\[ \t]|[^\s\\])+)/g)].flatMap((match) => {
    const path = match[1]?.replace(/\\([ \t])/g, "$1");
    return path && !isAbsolute(path) && !path.startsWith("~") ? [path] : [];
  });
}

/** Read only regular files that resolve inside the project. File bodies never reach notices. */
export function readInstructionFile(
  root: string,
  path: string,
  followImports = false,
): InstructionFile | undefined {
  try {
    const base = realpathSync(root);
    if (!within(root, path)) return;
    const file = realpathSync(path);
    if (!within(base, file)) return;
    const stat = statSync(file, { bigint: true });
    if (!stat.isFile()) return;
    // A file larger than this already exceeds the entire chain budget on its own.
    const contents = stat.size <= 1_048_576n ? readFileSync(file) : undefined;
    return {
      path: relative(base, file).split(sep).join("/"),
      bytes: Number(stat.size),
      revision: digest(contents ?? [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")),
      imports: followImports && contents ? importsOf(contents.toString("utf8")) : [],
    };
  } catch {
    // The provider owns instruction loading. Missing and unreadable files must not stop it.
  }
}

export function overInstructionBudget(
  { path, bytes, revision }: InstructionFile,
  defaultLimit: number,
): InstructionWarning | undefined {
  const limit = Object.hasOwn(overrides, path) ? (overrides[path] ?? defaultLimit) : defaultLimit;
  if (bytes > limit) return { path, bytes, limit, revision };
}

export function instructionWarnings(root: string, cwd: string): InstructionWarning[] {
  if (!within(root, cwd)) return [];
  const dirs = [root];
  const nested = relative(root, cwd);
  if (nested) for (const part of nested.split(sep)) dirs.push(resolve(dirs.at(-1) ?? root, part));
  const warnings: InstructionWarning[] = [];
  for (const guide of Object.keys(budgets.root) as Guide[]) {
    const members = new Map<string, InstructionFile>();
    const pending: string[] = [];
    const inspect = (path: string) => {
      const file = readInstructionFile(root, path, guide === "CLAUDE.md");
      if (!file || members.has(file.path)) return file;
      members.set(file.path, file);
      for (const target of file.imports) pending.push(resolve(root, dirname(file.path), target));
      return file;
    };
    for (const dir of dirs) {
      const override = guide === "AGENTS.md" ? resolve(dir, budgets.agentOverride) : undefined;
      const overrideFile = override ? inspect(override) : undefined;
      const path = overrideFile && override ? override : resolve(dir, guide);
      const canonical = overrideFile ?? inspect(path);
      const logical = relative(root, path).split(sep).join("/");
      if (!canonical) continue;
      const warning = overInstructionBudget(
        { ...canonical, path: logical },
        dir === root ? budgets.root[guide] : budgets.scopedGuideBytes,
      );
      if (warning) warnings.push(warning);
    }
    for (let path = pending.pop(); path; path = pending.pop()) inspect(path);
    const files = [...members.values()].sort((a, b) => a.path.localeCompare(b.path));
    const bytes = files.reduce((size, file) => size + file.bytes, 0);
    if (bytes > budgets.chainWarningBytes) {
      warnings.push({
        path: `${guide} chain`,
        bytes,
        limit: budgets.chainWarningBytes,
        revision: digest(JSON.stringify(files.map(({ path, revision }) => [path, revision]))),
      });
    }
  }
  return warnings;
}
