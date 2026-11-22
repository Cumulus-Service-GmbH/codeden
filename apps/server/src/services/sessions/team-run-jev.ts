import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import type { TeamWorkerJev } from "@codeden/contracts";
import type { Exec } from "../exec";

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
  await appendFile(historyPath, `${history}\n`, { mode: 0o600 });
  const historyBytes = await readFile(historyPath);
  const historySha256 = createHash("sha256").update(historyBytes).digest("hex");
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
        env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : undefined,
      },
    );
    const out = JSON.parse(result.stdout);
    if (out.gate === "done" && !out.dryRun && !result.timedOut) {
      if (typeof out.inputSha256 === "string") receipt.inputSha256 = out.inputSha256;
      if (Array.isArray(out.reasons)) {
        receipt.reasons = out.reasons.filter((reason: unknown) => typeof reason === "string");
      }
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
  await appendFile(historyPath, `Jev ${status} at ${head}: ${receipt.reasons?.join("; ") ?? ""}\n`);
  return { status, receipt };
}
