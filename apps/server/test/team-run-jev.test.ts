import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { pinTeamJevHelper, runJevDone } from "../src/services/sessions/team-run-jev";

it.each(["sibling.mjs", "nested/sibling.mjs", "node_modules/pkg/index.mjs"])(
  "rejects changes to pinned module %s",
  async (name) => {
    const dir = await mkdtemp(join(tmpdir(), "team-jev-pin-"));
    const script = join(dir, "jev.mjs");
    const sibling = join(dir, name);
    try {
      await mkdir(dirname(sibling), { recursive: true, mode: 0o700 });
      if (name.startsWith("node_modules/")) {
        await symlink(
          await realpath(dirname(sibling)),
          join(dir, "node_modules", "alias"),
          "junction",
        );
      }
      await mkdir(join(dir, ".git"));
      await chmod(join(dir, ".git"), 0o777);
      await writeFile(join(dir, ".git", "ignored.json"), "{}");
      await chmod(join(dir, ".git", "ignored.json"), 0o666);
      await writeFile(script, `import "./${name}";\n`, { mode: 0o600 });
      await writeFile(sibling, "export const version = 1;\n", { mode: 0o600 });
      const resolve = pinTeamJevHelper(script);
      expect(resolve()).toEqual(expect.stringContaining("jev.mjs"));
      await writeFile(join(dir, ".git", "ignored.json"), '{"changed":true}');
      expect(resolve()).toEqual(expect.stringContaining("jev.mjs"));
      await writeFile(sibling, "export const version = 2;\n");
      expect(resolve()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("rejects package links that leave the pinned helper installation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "team-jev-pin-"));
  try {
    const script = join(dir, "jev.mjs");
    await writeFile(script, "export const version = 1;\n", { mode: 0o600 });
    await mkdir(join(dir, "node_modules"));
    const resolve = pinTeamJevHelper(script);
    expect(resolve()).toEqual(expect.stringContaining("jev.mjs"));
    await symlink(tmpdir(), join(dir, "node_modules", "alias"), "junction");
    expect(resolve()).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  [0, "proceed", "pass"],
  [2, "revise", "revise"],
  [3, "proceed", "unavailable"],
  [0, "revise", "unavailable"],
] as const)(
  "records the exact input and history digest for exit %s, verdict %s",
  async (code, verdict, status) => {
    const dir = await mkdtemp(join(tmpdir(), "team-jev-"));
    const head = "4c14da4867d9efc112e4bf030cd27dea6b305e2d";
    const criteria = ["A resolved history item raises no new notice."];
    const historyPath = join(dir, "item.md");
    const evidence = [
      `criteria[0] tests at ${head}\nVITEST_MAX_WORKERS=2 pnpm -s vitest run --reporter=verbose notices.test.ts | grep -iE 'resolved'\n ✓ ignores resolved history\n Test Files  1 passed (1)\n Tests  1 passed (1)`,
      '{"round":2,"status":"completed"}\nHIGH or MEDIUM findings: 0',
      "No such file",
    ];
    try {
      const exec = vi.fn<import("../src/services/exec").Exec>(async (_command, args, options) => {
        expect(args).toEqual([
          "/installed/jev.mjs",
          "done",
          expect.any(String),
          "--log",
          `${historyPath}.jsonl`,
        ]);
        expect(options).toMatchObject({ inheritEnv: false, env: { NODE_OPTIONS: "" } });
        expect(options?.env?.NODE_PATH).toBeUndefined();
        const input = JSON.parse(await readFile(args[2] ?? "", "utf8"));
        const digest = createHash("sha256")
          .update(await readFile(historyPath))
          .digest("hex");
        expect(input).toEqual({
          objective: `Verify the candidate at ${head}.`,
          criteria,
          evidence: [
            ...evidence,
            `criteria[0]\nshasum -a 256 ${historyPath}\n${digest}  ${historyPath}`,
          ],
        });
        return {
          code,
          stdout: JSON.stringify({
            gate: "done",
            verdict,
            pass: verdict === "proceed",
            reasons: [],
            jev: { answers: { met_0: { type: "noul", noul: 0.97 } } },
          }),
          stderr: "",
          timedOut: false,
          notFound: false,
          path: process.execPath,
        };
      });
      const result = await runJevDone(exec, "/installed/jev.mjs", historyPath, {
        head,
        criteria,
        evidence,
        history: "Pinned plan, writer response, diff and review findings.",
      });
      expect(exec.mock.calls[0]?.[0]).toBe(process.execPath);
      const digest = createHash("sha256")
        .update("Pinned plan, writer response, diff and review findings.\n")
        .digest("hex");
      expect(result).toMatchObject({
        status,
        receipt: { head, historyPath, historySha256: digest, scores: { met_0: 0.97 } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("refuses a proceed result if the history changes during the invocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "team-jev-"));
  const historyPath = join(dir, "item.md");
  try {
    const result = await runJevDone(
      async () => {
        await appendFile(historyPath, "Changed after input creation.\n");
        return {
          code: 0,
          stdout: JSON.stringify({ gate: "done", verdict: "proceed", pass: true }),
          stderr: "",
          notFound: false,
          timedOut: false,
          path: process.execPath,
        };
      },
      "/installed/jev.mjs",
      historyPath,
      {
        head: "a".repeat(40),
        criteria: ["Preserve history."],
        evidence: [],
        history: "Original history.",
      },
    );
    expect(result.status).toBe("unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
