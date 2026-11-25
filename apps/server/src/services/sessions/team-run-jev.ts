import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TeamWorkerJev } from "@codeden/contracts";
import type { Exec } from "../exec";
import { jevToolEnv } from "../review-jev";
import { historyDigest, recordTeamHistory } from "./team-run-history";

export interface TeamReviewEvidence {
  /** Product acceptance criteria and the corresponding test, review and history command output. */
  criteria: string[];
  evidence: string[];
  /** Writer response, base and head diff, findings and any Arbiter ruling for this round. */
  history: string;
}

function secureSource(path: string) {
  const stat = lstatSync(path);
  const owner = process.getuid?.();
  if (owner !== undefined && ((stat.uid !== owner && stat.uid !== 0) || stat.mode & 0o022)) {
    throw new Error("Team gate helper is not owner-controlled");
  }
  return stat;
}

/** Pin the host installation before dispatch. A running server never adopts changed helper source. */
export function pinTeamJevHelper(configuredPath: string): () => string | null {
  const fingerprint = () => {
    const path = realpathSync(configuredPath);
    const directory = dirname(path);
    if (!secureSource(directory).isDirectory()) throw new Error("Missing helper directory");
    const hash = createHash("sha256");
    let entries = 0;
    let sources = 0;
    let packageSources = 0;
    let total = 0;
    const packageTarget = (path: string) => {
      const target = relative(directory, path);
      const parts = target.split(sep);
      if (
        isAbsolute(target) ||
        !parts.includes("node_modules") ||
        parts.some((p) => p === ".." || p === ".git")
      ) {
        throw new Error("Helper link target is outside the pinned packages");
      }
      return target;
    };
    const addFile = (file: string, name: string, inPackage: boolean) => {
      if (inPackage ? ++packageSources > 4096 : ++sources > 256) {
        throw new Error("Too many helper sources");
      }
      const stat = secureSource(file);
      total += stat.size;
      if (!stat.isFile() || total > 32 * 1024 * 1024) throw new Error("Unexpected helper source");
      hash.update(name).update("\0").update(readFileSync(file)).update("\0");
    };
    const visit = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.name === ".git") continue;
        if (++entries > 8192) throw new Error("Helper installation is too large");
        const file = join(dir, entry.name);
        const name = `${prefix}${entry.name}`;
        const inPackage = prefix.split("/").includes("node_modules");
        if (entry.isSymbolicLink()) {
          if (!inPackage) throw new Error("Unexpected helper symlink");
          packageTarget(resolve(dir, readlinkSync(file)));
          const resolved = realpathSync(file);
          const target = packageTarget(resolved);
          hash.update(name).update("\0link\0").update(target).update("\0");
          // Physical directories are visited once. File aliases can target extensionless executables.
          if (!secureSource(resolved).isDirectory()) addFile(resolved, name, true);
        } else if (entry.isDirectory()) {
          if (!secureSource(file).isDirectory()) throw new Error("Unexpected helper directory");
          visit(file, `${name}/`);
        } else if (inPackage || /\.(?:[cm]?js|json)$/.test(entry.name)) {
          addFile(file, name, inPackage);
        }
      }
    };
    visit(directory, "");
    return { path, digest: hash.digest("hex") };
  };
  try {
    const pinned = fingerprint();
    return () => {
      try {
        const current = fingerprint();
        return current.path === pinned.path && current.digest === pinned.digest
          ? current.path
          : null;
      } catch {
        return null;
      }
    };
  } catch {
    return () => null;
  }
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
        inheritEnv: false,
        env: jevToolEnv(),
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
