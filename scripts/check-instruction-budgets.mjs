import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import budgets from "./instruction-budgets.json" with { type: "json" };

export function checkInstructionBudgets({
  cwd,
  baseline,
  head = "HEAD",
  budgets: limits = budgets,
}) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const tree = (ref) => git("rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`).trim();
  const after = tree(head);
  const changed = git(
    "diff",
    "--no-renames",
    "--name-only",
    "--diff-filter=ACMT",
    "-z",
    tree(baseline),
    after,
    "--",
  )
    .split("\0")
    .filter(Boolean);
  return changed.flatMap((path) => {
    const name = posix.basename(path);
    const guide = name === limits.agentOverride ? "AGENTS.md" : name;
    const limit =
      (Object.hasOwn(limits.overrides, path) ? limits.overrides[path] : undefined) ??
      (name === "VISION.md"
        ? limits.visionBytes
        : Object.hasOwn(limits.root, guide)
          ? path === name
            ? limits.root[guide]
            : limits.scopedGuideBytes
          : undefined);
    if (limit === undefined) return [];
    const bytes = Number(git("cat-file", "-s", `${after}:${path}`).trim());
    return bytes > limit ? [{ path, bytes, limit }] : [];
  });
}

if (import.meta.main) {
  const [baseline, head] = process.argv.slice(2);
  if (!baseline) {
    console.error("Usage: node scripts/check-instruction-budgets.mjs <baseline> [head]");
    process.exitCode = 2;
  } else {
    const violations = checkInstructionBudgets({ baseline, head });
    for (const { path, bytes, limit } of violations) {
      console.error(`${JSON.stringify(path)} is ${bytes} B (limit ${limit} B).`);
    }
    process.exitCode = violations.length ? 1 : 0;
  }
}
