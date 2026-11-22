import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runJevDone } from "../src/services/sessions/team-run-jev";

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
      const exec = vi.fn(async (_command: string, args: string[]) => {
        expect(args).toEqual([
          "/installed/jev.mjs",
          "done",
          expect.any(String),
          "--log",
          `${historyPath}.jsonl`,
        ]);
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
        receipt: { head, historyPath, historySha256: digest },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
