import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { instructionWarnings } from "../src/services/instruction-budgets";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temp() {
  const root = mkdtempSync(join(tmpdir(), "codeden-instructions-"));
  roots.push(root);
  return root;
}

it("counts scoped imports once, including escaped spaces, and ignores code samples and escapes", () => {
  const parent = temp();
  const root = join(parent, "repo");
  const cwd = join(root, "app");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(parent, "outside.md"), "X".repeat(40_000));
  symlinkSync(join(parent, "outside.md"), join(root, "outside-link.md"));
  writeFileSync(
    join(root, "CLAUDE.md"),
    `${String.raw`@notes\ with\ spaces.md @alias.md @../outside.md @outside-link.md
\@example.md
`}\n\`\`\`\n@example.md\n\`\`\`\n`,
  );
  writeFileSync(join(root, "notes with spaces.md"), `@CLAUDE.md\n${"A".repeat(13_000)}`);
  writeFileSync(join(root, "example.md"), "C".repeat(40_000));
  symlinkSync("notes with spaces.md", join(root, "alias.md"));
  writeFileSync(join(cwd, "CLAUDE.md"), `@../notes\\ with\\ spaces.md\n${"B".repeat(6_144)}`);
  expect(instructionWarnings(root, cwd).map(({ path }) => path)).toEqual(["app/CLAUDE.md"]);
  writeFileSync(join(root, "notes with spaces.md"), `@CLAUDE.md\n${"A".repeat(19_000)}`);
  expect(instructionWarnings(root, cwd).map(({ path }) => path)).toEqual([
    "app/CLAUDE.md",
    "CLAUDE.md chain",
  ]);
});

it("uses the scoped agent guide override when it exists", () => {
  const root = temp();
  const cwd = join(root, "app");
  mkdirSync(cwd);
  writeFileSync(join(root, "AGENTS.md"), "X".repeat(12_288));
  writeFileSync(join(cwd, "AGENTS.md"), "X".repeat(13_000));
  writeFileSync(join(cwd, "AGENTS.override.md"), "X");
  expect(instructionWarnings(root, cwd)).toEqual([]);
  writeFileSync(join(cwd, "AGENTS.override.md"), "X".repeat(6_145));
  expect(instructionWarnings(root, cwd).map(({ path }) => path)).toEqual([
    "app/AGENTS.override.md",
  ]);
});
