import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JevReceipt, type JevReceipt as Receipt } from "@codeden/contracts";
import type { Exec } from "./exec";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function resolveFactoryJevScript(script: string): string | null {
  try {
    return lstatSync(script, { throwIfNoEntry: false }) ? script : null;
  } catch {
    return script;
  }
}

export function jevPasses(receipt: Receipt | undefined, head: string | null) {
  return (
    receipt?.status === "pass" &&
    head !== null &&
    receipt.head === head &&
    Boolean(receipt.inputSha256 && receipt.historySha256 && receipt.historyPath)
  );
}

export function jevNext(status: Receipt["status"], priorRefusals: number) {
  return status === "revise" && priorRefusals === 0 ? "reviewer" : "owner";
}

/** The history path is part of the evidence, not an extra CLI flag. */
export async function runJevDone(
  exec: Exec,
  script: string,
  dir: string,
  input: {
    head: string;
    criteria: string[];
    evidence: string[];
    history: string;
    historyEvidence: string;
  },
): Promise<Receipt> {
  const unavailable = (reason: string): Receipt => ({
    head: input.head,
    status: "unavailable",
    reasons: [reason],
  });
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const attempt = await mkdtemp(join(dir, "attempt-"));
    const historyPath = join(dir, "history.md");
    const historySha256 = sha256(input.history);
    const inputPath = join(attempt, "input.json");
    const logPath = join(attempt, "jev.log");
    await writeFile(historyPath, input.history, { mode: 0o600 });
    await writeFile(
      inputPath,
      JSON.stringify({
        objective: `Verify the candidate at ${input.head}.`,
        criteria: input.criteria,
        historyPath,
        evidence: [
          ...input.evidence,
          `shasum -a 256 ${historyPath}\n${historySha256}  ${historyPath}\n${input.historyEvidence}`,
        ],
      }),
      { mode: 0o600 },
    );
    const result = await exec(
      process.versions.electron ? "node" : process.execPath,
      [script, "done", inputPath, "--log", logPath],
      { cwd: attempt, timeoutMs: 120_000, env: { NODE_OPTIONS: "" } },
    );
    if (result.timedOut || result.notFound || result.code === null) {
      return unavailable("The done gate was unreachable or timed out.");
    }
    const output = JSON.parse(result.stdout);
    if (output.gate !== "done" || sha256(await readFile(historyPath, "utf8")) !== historySha256) {
      return unavailable("The done result or its history did not match this invocation.");
    }
    const pass = result.code === 0 && output.pass === true && output.verdict === "proceed";
    if (pass && (await readFile(logPath, "utf8")).trim() !== result.stdout.trim()) {
      return unavailable("The done result did not match the logged receipt.");
    }
    const evidenceProblem =
      Array.isArray(output.reasons) &&
      output.reasons.some(
        (reason: unknown) => typeof reason === "string" && reason.startsWith("unsupported claims"),
      );
    const receipt = JevReceipt.parse({
      head: input.head,
      status: pass
        ? "pass"
        : result.code === 2 &&
            output.pass === false &&
            output.verdict === "revise" &&
            output.inputSha256 &&
            !evidenceProblem
          ? "revise"
          : "unavailable",
      historyPath,
      historySha256,
      inputSha256: output.inputSha256,
      reasons: output.reasons,
    });
    return pass && !jevPasses(receipt, input.head)
      ? {
          ...receipt,
          status: "unavailable",
          reasons: ["The done result did not include an input digest."],
        }
      : receipt;
  } catch {
    return unavailable("The done gate could not run or returned an invalid receipt.");
  }
}
