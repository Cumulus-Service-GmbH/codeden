import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { seedTechDebt } from "../src/services/tech-debt/seed";
import { defaultTechDebtSeed } from "../src/services/tech-debt/seed-defaults";
import { TechDebtService } from "../src/services/tech-debt/service";
import { createGithubEnv } from "./support/github-env";

it("seeds matching projects atomically and retries only the failed issue", async () => {
  const env = createGithubEnv();
  try {
    const date = "2026-11-23T00:00:00.000Z";
    const base = env.githubProject;
    if (base.kind !== "github") throw new Error("Expected a GitHub project");
    const code = { ...base, github: { ...base.github, owner: "Acme", repo: "CodeDen" } };
    const tree = join(env.dir, "x");
    const other = {
      ...code,
      id: env.localProject.id,
      path: tree,
      github: { ...code.github, repo: "other" },
    };
    const md = join(env.dir, "fb-out", "tech-debt.md");
    const json = join(tree, ".trioharness-direct", "runs", "r1", "tech-debt.json");
    mkdirSync(dirname(md), { recursive: true });
    mkdirSync(dirname(json), { recursive: true });
    writeFileSync(
      md,
      [
        "## Item 2 (receipt /tmp/receipt, head abc123)",
        "- ID: R1 | SEVERITY: LOW | FILE: src/file.ts:2 | PROBLEM: Reuse the helper. | EVIDENCE: Example.",
        "- ID: R2 | SEVERITY: LOW | FILE: (packet) | PROBLEM: Skip this.",
        "- ID: R3 | SEVERITY: MEDIUM | FILE: src/file.ts:3 | PROBLEM: Skip this too.",
      ].join("\n"),
    );
    writeFileSync(
      json,
      JSON.stringify({ findings: [{ file: "src/local.ts:9", problem: "Add the label." }] }),
    );
    const good = "acme/codeden#1";
    const bad = "acme/other#2";
    const read = vi.fn(async (issue: string) => {
      if (issue === bad) throw new Error("Issue unavailable");
      return { body: "- [ ] LOW `src/import.ts:3` — Keep the existing check.", date };
    });
    const write = vi.fn();
    const service = new TechDebtService(env.db.db, env.store, { read, write }, vi.fn());
    env.db.client
      .prepare("INSERT INTO project_tech_debt (project_id, view) VALUES (?, ?)")
      .run(
        code.id,
        JSON.stringify({ projectId: code.id, issue: null, imported: false, findings: [] }),
      );
    const projects = () => [code, other];
    const deps = {
      service,
      projects,
      codedenRepos: ["leonvanzyl/codeden"],
      issues: [
        { repo: "acme/codeden", issue: good },
        { repo: "acme/other", issue: bad },
      ],
      backfill: { files: [md] },
      listFiles: () => [{ file: json, tree }],
      readFile: (file: string) => ({
        text: readFileSync(file, "utf8"),
        date: statSync(file).mtime.toISOString(),
      }),
      log: vi.fn(),
    };
    const startSeq = env.store.headSeq();
    await seedTechDebt(deps);
    const codeView = await service.list(code);
    expect(codeView).toMatchObject({ issue: null, imported: false });
    expect(codeView.findings).toMatchObject([
      { source: good, location: "src/import.ts:3" },
      {
        source: "backfill",
        location: "src/file.ts:2",
        text: "Reuse the helper.",
        receipt: "/tmp/receipt head abc123",
        date: statSync(md).mtime.toISOString(),
        pr: null,
      },
    ]);
    expect(codeView.seeds).toEqual([`issue:${good}`, `backfill:${md}`]);
    expect(service.summaries(projects())).toEqual([
      { projectId: code.id, open: 2 },
      { projectId: other.id, open: 1, importError: "Issue unavailable" },
    ]);
    const seedSeq = env.store.headSeq();
    expect(seedSeq - startSeq).toBe(4);
    await seedTechDebt(deps);
    expect(read.mock.calls).toEqual([[good], [bad], [bad]]);
    expect(env.store.headSeq()).toBe(seedSeq);
    expect(await service.list(code)).toEqual(codeView);
    expect(write).not.toHaveBeenCalled();
  } finally {
    await env.close();
  }
});

it.each([
  { repos: ["ACME/CodeDen"], otherRepo: "codeden", expected: true },
  { repos: ["leonvanzyl/codeden"], otherRepo: "other", expected: true },
  { repos: ["leonvanzyl/codeden"], otherRepo: "codeden", expected: false },
])("maps CodeDen backfill using $repos with a second $otherRepo project", async (testCase) => {
  const env = createGithubEnv();
  try {
    const base = env.githubProject;
    if (base.kind !== "github") throw new Error("Expected a GitHub project");
    const code = { ...base, github: { ...base.github, owner: "acme", repo: "codeden" } };
    const other = {
      ...base,
      id: env.localProject.id,
      github: { ...base.github, owner: "other", repo: testCase.otherRepo },
    };
    const service = new TechDebtService(
      env.db.db,
      env.store,
      { read: vi.fn(), write: vi.fn() },
      vi.fn(),
    );
    await seedTechDebt({
      service,
      projects: () => [other, code],
      codedenRepos: testCase.repos,
      issues: [],
      backfill: { files: [join(env.dir, "fb-out", "tech-debt.md")] },
      listFiles: () => [{ file: join(env.dir, "fb-history", "r1", "tech-debt.json") }],
      readFile: (file) => ({
        text: file.endsWith(".md")
          ? "- ID: R1 | SEVERITY: LOW | FILE: src/file.ts:2 | PROBLEM: Reuse the helper."
          : JSON.stringify([{ file: "src/file.ts:3", problem: "Add the label." }]),
        date: "2026-11-23T00:00:00.000Z",
      }),
      log: vi.fn(),
    });
    expect(service.summaries([other, code])).toEqual([
      { projectId: other.id, open: 0 },
      { projectId: code.id, open: testCase.expected ? 2 : 0 },
    ]);
  } finally {
    await env.close();
  }
});

it("continues to the next issue and backfill if the first issue import throws", async () => {
  const env = createGithubEnv();
  try {
    const project = env.githubProject;
    if (project.kind !== "github") throw new Error("Expected a GitHub project");
    const repo = `${project.github.owner}/${project.github.repo}`;
    const first = `${repo}#1`;
    const second = `${repo}#2`;
    const date = "2026-11-23T00:00:00.000Z";
    const read = vi.fn(async () => ({
      body: "- [ ] LOW `src/issue.ts:2` — Use the helper.",
      date,
    }));
    const service = new TechDebtService(env.db.db, env.store, { read, write: vi.fn() }, vi.fn());
    vi.spyOn(service, "importIssue").mockRejectedValueOnce(new Error("Import unavailable"));
    const log = vi.fn();
    await seedTechDebt({
      service,
      projects: () => [project],
      codedenRepos: [repo],
      issues: [
        { repo, issue: first },
        { repo, issue: second },
      ],
      backfill: { files: [join(env.dir, "tech-debt.md")] },
      listFiles: () => [],
      readFile: () => ({
        text: "- ID: R1 | SEVERITY: LOW | FILE: src/file.ts:2 | PROBLEM: Add the label.",
        date,
      }),
      log,
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(`Tech debt seed could not import ${first}`);
    expect((await service.list(project)).findings).toMatchObject([
      { source: second },
      { source: "backfill" },
    ]);
  } finally {
    await env.close();
  }
});

it("opts out of startup sources only when CODEDEN_TECH_DEBT_SEED is zero", () => {
  try {
    vi.stubEnv("CODEDEN_TECH_DEBT_SEED", "0");
    expect(defaultTechDebtSeed()).toBe(false);
    vi.stubEnv("CODEDEN_TECH_DEBT_SEED", undefined);
    expect(defaultTechDebtSeed()).toMatchObject({ codedenRepos: ["leonvanzyl/codeden"] });
  } finally {
    vi.unstubAllEnvs();
  }
});

it.skipIf(process.platform === "win32")(
  "reads the tree's Git origin without discovering an enclosing repository",
  async () => {
    const parent = mkdtempSync("/tmp/codeden-tech-debt-");
    try {
      vi.stubEnv("CODEDEN_TECH_DEBT_SEED", undefined);
      const options = defaultTechDebtSeed();
      if (options === false || !options.gitOrigin)
        throw new Error("Expected startup Git origin lookup");
      const tree = join(parent, "tree");
      const origin = "https://github.com/acme/codeden.git";
      mkdirSync(tree);
      execFileSync("git", ["-C", parent, "init", "--quiet"]);
      execFileSync("git", [
        "-C",
        parent,
        "config",
        "remote.origin.url",
        "https://github.com/acme/parent.git",
      ]);
      await expect(options.gitOrigin(tree)).resolves.toBeNull();
      execFileSync("git", ["-C", tree, "init", "--quiet"]);
      execFileSync("git", ["-C", tree, "config", "remote.origin.url", origin]);
      await expect(options.gitOrigin(tree)).resolves.toBe(origin);
    } finally {
      vi.unstubAllEnvs();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
