import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { seedTechDebt } from "../src/services/tech-debt/seed";
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
