import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { TeamWorkerJev } from "@codeden/contracts";
import type { Exec } from "../exec";
import { historyDigest, recordTeamHistory } from "./team-run-history";

export interface TeamReviewEvidence {
  /** Product acceptance criteria and the corresponding test, review and history command output. */
  criteria: string[];
  evidence: string[];
  /** Writer response, base and head diff, findings and any Arbiter ruling for this round. */
  history: string;
}

export async function runJevDone(
  exec: Exec,
  script: string,
  historyPath: string,
  { head, criteria, evidence, history }: TeamReviewEvidence & { head: string },
): Promise<TeamWorkerJev> {
  const historyBytes = await recordTeamHistory(historyPath, `${history}\n`);
  const historySha256 = historyDigest(historyBytes);
  const receipt: NonNullable<TeamWorkerJev["receipt"]> = {
    head,
    historyPath,
    historySha256,
    historyBytes: historyBytes.length,
  };
  const pointers = criteria.map((_criterion, index) => `criteria[${index}]`).join(" and ");
  const inputPath = `${historyPath}.${randomUUID()}.input.json`;
  await writeFile(
    inputPath,
    JSON.stringify({
      objective: `Verify the candidate at ${head}.`,
      criteria,
      evidence: [
        ...evidence,
        `${pointers}\nshasum -a 256 ${historyPath}\n${historySha256}  ${historyPath}`,
      ],
    }),
    { mode: 0o600, flag: "wx" },
  );
  let status: TeamWorkerJev["status"] = "unavailable";
  try {
    const result = await exec(
      process.execPath,
      [script, "done", inputPath, "--log", `${historyPath}.jsonl`],
      {
        timeoutMs: 180_000,
        env: {
          NODE_OPTIONS: "",
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
      },
    );
    const out = JSON.parse(result.stdout);
    if (!(await readFile(historyPath)).equals(historyBytes)) {
      receipt.reasons = ["Item history changed during the done invocation"];
    } else if (out.gate === "done" && !out.dryRun && !result.timedOut) {
      if (typeof out.inputSha256 === "string") receipt.inputSha256 = out.inputSha256;
      if (Array.isArray(out.reasons)) {
        receipt.reasons = out.reasons.filter((reason: unknown) => typeof reason === "string");
      }
      const scores = Object.entries(out.jev?.answers ?? {}).flatMap(([key, answer]) => {
        if (typeof answer !== "object" || answer === null || !("noul" in answer)) return [];
        return [[key, answer.noul]];
      });
      const parsed = TeamWorkerJev.shape.receipt
        .unwrap()
        .shape.scores.safeParse(Object.fromEntries(scores));
      if (scores.length && parsed.success) receipt.scores = parsed.data;
      if (result.code === 0 && out.verdict === "proceed" && out.pass === true) status = "pass";
      if (
        result.code === 2 &&
        out.verdict === "revise" &&
        out.pass === false &&
        !receipt.reasons?.some((reason) => reason.startsWith("unsupported claims"))
      ) {
        status = "revise";
      }
    }
  } catch {
    receipt.reasons = ["Jev did not return a valid result"];
  } finally {
    await unlink(inputPath);
  }
  await recordTeamHistory(
    historyPath,
    `Jev ${status} at ${head}: ${receipt.reasons?.join("; ") ?? ""} ${JSON.stringify(receipt.scores ?? {})}\n`,
  );
  return { status, receipt };
}
