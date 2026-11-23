import { basename, resolve } from "node:path";
import { type Project, TechDebtFindingInput } from "@codeden/contracts";
import { parseGitHubRemote } from "../projects/detect";
import type { TechDebtService } from "./service";

/** Injectable sources for the one-time startup import. */
export interface SeedOptions {
  issues: { repo: string; issue: string }[];
  backfill: { files: string[] };
  listFiles: () => { file: string; tree?: string }[];
  readFile: (file: string) => { text: string; date: string } | undefined;
  gitOrigin?: (dir: string) => Promise<string | null>;
}

type SeedDeps = SeedOptions & {
  service: TechDebtService;
  projects: () => Project[];
  log: (message: string) => void;
};

function forRepo(projects: Project[], slug: string) {
  return projects.find(
    (project) =>
      project.kind === "github" &&
      `${project.github.owner}/${project.github.repo}`.toLowerCase() === slug.toLowerCase(),
  );
}

function forPath(projects: Project[], path: string) {
  return projects.find((project) => resolve(project.path) === resolve(path));
}

function finding(location: unknown, text: unknown, receipt: unknown, date: string, file: string) {
  return TechDebtFindingInput.safeParse({
    location,
    text: typeof text === "string" ? text.trim().slice(0, 4000) : text,
    receipt: (typeof receipt === "string" && receipt.trim() ? receipt.trim() : file).slice(0, 1000),
    date,
    pr: null,
  });
}

function markdown(text: string) {
  let receipt: string | undefined;
  return text.split(/\r?\n/).flatMap((line) => {
    if (/^#{1,6}\s/.test(line)) {
      const match = /^## Item \d+ \(receipt (.+), head ([a-f\d]+)\)\s*$/i.exec(line);
      receipt = match ? `${match[1]} head ${match[2]}` : undefined;
    }
    const entry =
      /^- ID: .*? \| SEVERITY: LOW \| FILE: (.*?) \| PROBLEM: (.*?)(?: \| (?:EVIDENCE|MINIMAL FIX):.*)?$/.exec(
        line,
      );
    return entry ? [{ location: entry[1], text: entry[2], receipt }] : [];
  });
}

function json(text: string): Record<string, unknown>[] {
  const value = JSON.parse(text);
  const entries: unknown = Array.isArray(value) ? value : value?.findings;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry &&
      typeof entry === "object" &&
      (entry.severity === undefined || entry.severity === "LOW"),
  );
}

/** Import each matching issue and backfill file once per active project. */
export async function seedTechDebt(deps: SeedDeps): Promise<void> {
  const projects = deps.projects().filter((project) => !project.archivedAt);
  for (const { repo, issue } of deps.issues) {
    const project = forRepo(projects, repo);
    if (project) await deps.service.importIssue(project, issue, { seed: `issue:${issue}` });
    else deps.log(`Tech debt seed skipped: no project for ${repo}`);
  }

  const codeden = projects.find(
    (project) => project.kind === "github" && project.github?.repo.toLowerCase() === "codeden",
  );
  const files = [
    ...deps.backfill.files.map((file) => ({ file, tree: undefined })),
    ...deps.listFiles(),
  ];
  for (const { file: path, tree } of files) {
    const file = resolve(path);
    try {
      const input = deps.readFile(file);
      if (!input) continue;
      const entries: Record<string, unknown>[] =
        basename(file) === "tech-debt.md" ? markdown(input.text) : json(input.text);
      let project = tree ? forPath(projects, tree) : codeden;
      if (tree && !project && deps.gitOrigin) {
        const origin = await deps.gitOrigin(tree);
        const repo = origin && parseGitHubRemote(origin);
        if (repo) project = forRepo(projects, `${repo.owner}/${repo.repo}`);
      }

      const byProject = new Map<Project, TechDebtFindingInput[]>();
      for (const entry of entries) {
        const parsed = finding(
          entry.location ?? entry.file,
          entry.text ?? entry.problem,
          entry.receipt,
          input.date,
          file,
        );
        if (!parsed.success) continue;
        const target =
          typeof entry.repoPath === "string"
            ? forPath(projects, entry.repoPath)
            : typeof entry.repo === "string"
              ? forRepo(projects, entry.repo)
              : project;
        if (!target) continue;
        const findings = byProject.get(target) ?? [];
        findings.push(parsed.data);
        byProject.set(target, findings);
      }
      if (project && entries.length === 0) byProject.set(project, []);
      for (const [target, findings] of byProject) {
        await deps.service.backfill(target, `backfill:${file}`, findings);
      }
    } catch {
      deps.log(`Tech debt seed could not read or import ${file}`);
    }
  }
}
