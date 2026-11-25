import { join } from "node:path";
import { conflict } from "../errors";
import type { Exec } from "../exec";
import { parseGitHubRemote } from "../projects/detect";
import { sameGithubRepo } from "../projects/reconcile";
import type { automationFork } from "./policy";

// Use the installed Team gate for policy and reviewer verification. Delivery also binds
// every required clean verdict to the commit it will push.
const CHECK_TEAM_REVIEW = `
import { pathToFileURL } from "node:url";
const [script, run, base, head, writer] = process.argv.slice(1);
const { checkRun, readRounds } = await import(pathToFileURL(script).href);
const repo = process.cwd();
const gate = checkRun(repo, run, base);
const rows = readRounds(repo, run).filter((row) => row.head === head);
const clean = (row) => row?.status === "completed" && !row.partial &&
  row.verdict === "CLEAN" && row.writer?.provider === writer;
const first = rows.findLast((row) => row.slot === "primary" || row.slot === "fallback");
const second = rows.findLast((row) => row.slot === "second-pass");
if (!gate.ok || gate.note || !clean(first) || (gate.highRisk && !clean(second))) process.exitCode = 1;
`;

export async function reviewedAutomationHead(
  exec: Exec,
  cwd: string,
  teamFile: string,
  fork: ReturnType<typeof automationFork>,
  run: string,
  writer: string,
  userHome: string,
  base = fork.defaultBranch,
): Promise<string> {
  const remote = await exec("git", ["remote", "get-url", "--push", "--all", fork.remote], { cwd });
  const urls = remote.stdout.trim().split(/\r?\n/);
  const target = urls.length === 1 ? parseGitHubRemote(urls[0] ?? "") : null;
  if (remote.code !== 0 || !target || !sameGithubRepo(fork, target)) {
    throw conflict(
      "The fork remote push URL must match the configured GitHub fork.",
      "automation_fork_mismatch",
    );
  }
  const result = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd });
  const head = result.stdout.trim();
  if (result.code !== 0 || !/^[a-f0-9]{40}$/.test(head) || !/^[a-zA-Z0-9_-]+$/.test(run)) {
    throw conflict(
      "Cannot identify this automation's candidate commit.",
      "automation_head_unknown",
    );
  }
  const script = join(
    userHome,
    ".claude",
    "skills",
    "trioharness-codeden",
    "scripts",
    "team-review.mjs",
  );
  const reviewed = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      CHECK_TEAM_REVIEW,
      "--",
      script,
      run,
      `refs/remotes/${fork.remote}/${base}`,
      head,
      writer,
    ],
    { cwd, env: { ...process.env, TEAM_FILE: teamFile }, timeoutMs: 30_000 },
  );
  if (reviewed.code !== 0) {
    throw conflict(
      `A clean Team review receipt for ${head} is required before opening this PR.`,
      "automation_review_required",
    );
  }
  return head;
}
