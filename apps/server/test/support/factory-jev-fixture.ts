import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { vi } from "vitest";
import type { ExecResult } from "../../src/services/exec";
import type { FactoryEnv } from "./factory-env";

export const sha = (label: string) => createHash("sha1").update(label).digest("hex");

export const fixtureJevScript = "/fixture/jev.mjs";

export function installDoneFixture(env: FactoryEnv, done?: (result: ExecResult) => ExecResult) {
  env.factory.ctx.jevScript = fixtureJevScript;
  const openPr = env.gh.openPr.bind(env.gh);
  vi.spyOn(env.gh, "openPr").mockImplementation((opts) => {
    const pr = openPr(opts);
    pr.headSha = sha(pr.headSha ?? "");
    return pr;
  });
  const update = env.gh.updateBranch.bind(env.gh);
  vi.spyOn(env.gh, "updateBranch").mockImplementation(async (...args) => {
    await update(...args);
    const pr = env.gh.prs.get(args[1]);
    if (pr?.headSha) pr.headSha = sha(pr.headSha);
  });
  const exec = env.factory.ctx.exec;
  env.factory.ctx.exec = async (command, args, opts) => {
    const result = await exec(command, args, opts);
    if (command === "git" && args.includes("merge-base")) {
      return { ...result, stdout: sha("base") };
    }
    if (command !== process.execPath || args[1] !== "done") return result;
    const stdout = JSON.stringify({
      gate: "done",
      pass: true,
      verdict: "proceed",
      reasons: [],
      inputSha256: "1234567890abcdef",
    });
    await writeFile(args[4] ?? "", stdout);
    const passed = { ...result, stdout };
    return done ? done(passed) : passed;
  };
}

export const jevEvidence = (head: string) => ({
  head,
  tests: [
    "VITEST_MAX_WORKERS=2 pnpm -s vitest run --reporter=verbose test/counter.test.ts | grep -iE 'increments'\n✓ Counter increments\n Test Files  1 passed (1)\n Tests  1 passed (1)",
  ],
});
