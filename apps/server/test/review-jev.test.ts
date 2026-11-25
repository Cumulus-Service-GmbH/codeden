import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FactoryItem, FactoryLimits, ReviewVerdict } from "@codeden/contracts";
import { expect, it, vi } from "vitest";
import type { Exec } from "../src/services/exec";
import type { FactoryContext } from "../src/services/factory/context";
import { advanceJev, submitJevReview } from "../src/services/factory/jev";
import { autoMerge } from "../src/services/factory/merge";
import {
  jevNext,
  jevPasses,
  resolveFactoryJevScript,
  runJevDone,
} from "../src/services/review-jev";

const jevScript = "/fixture/jev.mjs";
const head = "a".repeat(40);

it("detects configuration from the installed Jev script", async () => {
  const home = await mkdtemp(join(tmpdir(), "review-jev-home-"));
  try {
    const script = join(home, "jev.mjs");
    expect(resolveFactoryJevScript(script)).toBeNull();
    await writeFile(script, "");
    expect(resolveFactoryJevScript(script)).toBe(script);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("refuses to call GitHub merge without a Jev pass", async () => {
  const merge = vi.fn();
  const result = await autoMerge(
    { github: { merge }, jevScript } as never,
    {} as never,
    {} as never,
    { id: "item", title: "Candidate" } as never,
    { headSha: head, ref: { number: 1 } } as never,
    [],
    { path: "direct" } as never,
  );
  expect(result).toMatchObject({ failed: expect.stringContaining("Jev") });
  expect(merge).not.toHaveBeenCalled();
});

it("passes the history by path and binds its digest and result to the item head", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-jev-"));
  try {
    const exec: Exec = async (node, args) => {
      expect(node).toBe(process.execPath);
      expect(args.slice(1, 2)).toEqual(["done"]);
      expect(args.slice(3)).toEqual(["--log", expect.any(String)]);
      const input = JSON.parse(await readFile(args[2] ?? "", "utf8"));
      expect(input.objective).toBe(`Verify the candidate at ${head}.`);
      expect(await readFile(input.historyPath, "utf8")).toBe("Pinned history");
      expect(input.evidence.at(-1)).toContain(input.historyPath);
      const stdout = JSON.stringify({
        gate: "done",
        pass: true,
        verdict: "proceed",
        reasons: [],
        inputSha256: "1234567890abcdef",
      });
      await writeFile(args[4] ?? "", stdout);
      return {
        code: 0,
        stdout,
        stderr: "",
        timedOut: false,
        notFound: false,
        path: node,
      };
    };
    const receipt = await runJevDone(exec, jevScript, dir, {
      head,
      criteria: ["Saves the item."],
      evidence: ["criterion output"],
      history: "Pinned history",
      historyEvidence: "",
    });
    expect(receipt).toMatchObject({
      head,
      status: "pass",
      historySha256: createHash("sha256").update("Pinned history").digest("hex"),
    });
    expect(jevPasses(receipt, head)).toBe(true);
    const movedHead = "b".repeat(40);
    expect(jevPasses(receipt, movedHead)).toBe(false);
    const merge = vi.fn();
    const result = await autoMerge(
      { github: { merge }, jevScript } as never,
      {} as never,
      {} as never,
      { id: "item", title: "Candidate", jev: receipt } as never,
      { headSha: movedHead, ref: { number: 1 } } as never,
      [],
      { path: "direct" } as never,
    );
    expect(result).toMatchObject({ failed: expect.stringContaining("Jev") });
    expect(merge).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("runs the done script using the bundled runtime in Electron", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-jev-electron-"));
  const prior = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process.versions, "electron", { value: "fixture", configurable: true });
  try {
    const exec = vi.fn<Exec>(async (path) => ({
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      notFound: true,
      path,
    }));
    await runJevDone(exec, jevScript, dir, {
      head,
      criteria: [],
      evidence: [],
      history: "",
      historyEvidence: "",
    });
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({ env: { NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "1" } }),
    );
  } finally {
    if (prior) Object.defineProperty(process.versions, "electron", prior);
    else Reflect.deleteProperty(process.versions, "electron");
    await rm(dir, { recursive: true, force: true });
  }
});

it("sends a product refusal to the reviewer once and then to the owner inbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-jev-"));
  try {
    const reviewer = {
      id: "reviewer",
      status: "idle",
      worktreePath: dir,
      provider: "fixture",
      model: "fixture-reviewer",
    };
    const tuning = {
      team: [
        { role: "reviewer", provider: reviewer.provider, model: reviewer.model, effort: null },
      ],
    } as const;
    const verdict = ReviewVerdict.parse({
      verdict: "approve",
      summary: "Saves the item.",
      vision: { aligned: true },
      tests: { adequate: true },
      security: { concerns: [] },
      jevEvidence: {
        head,
        tests: [
          "VITEST_MAX_WORKERS=2 pnpm -s vitest run --reporter=verbose item.test.ts | grep -iE 'saves'\n✓ saves the item\n Test Files  1 passed (1)\n Tests  1 passed (1)",
        ],
      },
    });
    let item = {
      id: "item",
      projectId: "project",
      title: "Candidate",
      reviewerSessionId: reviewer.id,
      acceptanceCriteria: ["Saves the item."],
      review: verdict,
      nudges: { [`head_${head}`]: "2026-11-23T00:00:00.000Z" },
      checks: [],
    } as unknown as FactoryItem;
    const startTurn = vi.fn();
    const put = vi.fn();
    const exec: Exec = vi.fn(async (command, args) => {
      const result = { code: 0, stderr: "", timedOut: false, notFound: false, path: command };
      if (command === "git") {
        return { ...result, stdout: args.includes("merge-base") ? "b".repeat(40) : "+new line" };
      }
      return {
        ...result,
        code: 2,
        stdout: JSON.stringify({
          gate: "done",
          pass: false,
          verdict: "revise",
          reasons: ["criterion 0 not shown"],
          inputSha256: "1234567890abcdef",
        }),
      };
    });
    const ctx = {
      reviewDataDir: dir,
      jevScript,
      store: {
        updateItem: (_id: string, change: (current: FactoryItem) => FactoryItem) => {
          item = change(item);
          return item;
        },
      },
      repo: { find: () => ({ session: reviewer }) },
      settings: { get: () => ({ teamSetup: { remembered: false, team: [] } }) },
      sessions: { startTurn, list: () => [reviewer], models: () => [] },
      inbox: { find: () => undefined, put },
      admission: { free: () => 1 },
      slots: { wokenThisTick: () => new Set(), claim: () => true, woke: () => {} },
      exec,
      now: () => new Date("2026-11-23T00:00:00Z"),
    } as unknown as FactoryContext;
    const project = {
      id: item.projectId,
      defaultBranch: "main",
      factoryLimits: FactoryLimits.parse({}),
    } as Parameters<typeof advanceJev>[1];
    expect(await advanceJev(ctx, project, item, head, { team: [...tuning.team] })).toBe(false);
    expect(startTurn).toHaveBeenCalledExactlyOnceWith(reviewer.id, expect.stringContaining(head));
    expect(put).not.toHaveBeenCalled();
    expect(submitJevReview(ctx, item, verdict)).toBe(true);
    expect(await advanceJev(ctx, project, item, head, { team: [...tuning.team] })).toBe(false);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "owner_decision",
        body: expect.stringContaining(head),
      }),
    );
    expect(item.jev?.status).toBe("owner decision");
    expect(item.jevHistory?.map((entry) => entry.status)).toEqual(["revise", "revise"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("routes an unavailable gate straight to the owner", () => {
  expect(jevNext("unavailable", 0)).toBe("owner");
});

it.each(["docs", "revert", "criteria-less"] as const)(
  "runs the done gate with pinned verification evidence for %s",
  async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "review-jev-"));
    try {
      let item = {
        id: "item",
        projectId: "project",
        title: "Candidate",
        type: kind === "docs" ? "docs" : "feature",
        source: kind === "revert" ? "revert" : "issue",
        revertOf: kind === "revert" ? "original" : undefined,
        builderSessionId: kind === "revert" ? null : "builder",
        reviewerSessionId: kind === "criteria-less" ? "reviewer" : null,
        acceptanceCriteria: kind === "docs" ? ["Documents how to save."] : [],
        review: kind === "docs" ? null : { verdict: "approve", criteria: [] },
        nudges: { [`head_${head}`]: "2026-11-23T00:00:00.000Z" },
        checks: [
          { name: "ci", state: "pass" },
          { name: "review", state: kind === "docs" ? "skipped" : "pass" },
        ],
      } as unknown as FactoryItem;
      const revertMatches = vi.fn(async () => true);
      const exec: Exec = async (command, args) => {
        const result = { code: 0, stderr: "", timedOut: false, notFound: false, path: command };
        if (command === "git") {
          return {
            ...result,
            stdout: args.includes("merge-base") ? "b".repeat(40) : "+Click Save.",
          };
        }
        const input = JSON.parse(await readFile(args[2] ?? "", "utf8"));
        expect(input.objective).toContain(head);
        expect(input.criteria).not.toHaveLength(0);
        expect(input.evidence[0]).toContain(head);
        expect(input.evidence[0]).toContain(kind === "docs" ? "+Click Save." : '"state":"pass"');
        const stdout = JSON.stringify({
          gate: "done",
          pass: true,
          verdict: "proceed",
          reasons: [],
          inputSha256: "1234567890abcdef",
        });
        await writeFile(args[4] ?? "", stdout);
        return { ...result, stdout };
      };
      const put = vi.fn();
      const ctx = {
        reviewDataDir: dir,
        jevScript,
        store: {
          updateItem: (_id: string, change: (current: FactoryItem) => FactoryItem) => {
            item = change(item);
            return item;
          },
          item: () => ({ mergeSha: "c".repeat(40) }),
        },
        github: { revertMatches },
        repo: { find: () => ({ session: { status: "idle", worktreePath: dir } }) },
        inbox: { find: () => undefined, put },
        exec,
        now: () => new Date("2026-11-23T00:00:00Z"),
      } as unknown as FactoryContext;
      const project = {
        id: item.projectId,
        defaultBranch: "main",
        factoryLimits: FactoryLimits.parse({}),
      } as Parameters<typeof advanceJev>[1];

      expect(await advanceJev(ctx, project, item, head, { team: [] })).toBe(true);
      expect(jevPasses(item.jev, head)).toBe(true);
      expect(put).not.toHaveBeenCalled();
      if (kind === "revert") {
        expect(revertMatches).toHaveBeenCalledWith(item.projectId, {
          headSha: head,
          mergeSha: "c".repeat(40),
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
