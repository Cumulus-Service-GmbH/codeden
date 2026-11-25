#!/usr/bin/env node
// TrioHarness CI rerun helper: reruns only the failed jobs of failed CI runs for one commit.
//   node <skill>/scripts/ci-rerun.mjs --workflow <CI workflow name> --job <CI job name> [--workflow ... --job ...] [--pr <n> | --sha <sha>] [--repo <owner/name>] [--dry-run]
// Default commit: HEAD. Only runs of the named workflows whose every job is a named --job are rerun, and never when a job is
// a deploy, release, publish or promote job: those stay owner gates. It never reruns a whole workflow (always
// `gh run rerun <id> --failed`), and it reruns nothing while a run for that commit is still queued or in progress.
// Exit 0 rerun requested or nothing to rerun, 2 caller error, runs still in progress or an incomplete list, 3 gh failed.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);
const RESERVED = /deploy|release|publish|promot/i;
const LIMIT = 1000;

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw Object.assign(new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`), { exit: 3 });
  return r.stdout.trim();
};

/** Split a commit's runs: pending, failed runs of allowlisted workflows, and failed runs that are skipped (with why). */
// A run is eligible only when it is positively identified as CI: its workflow is named with --workflow, its job list
// is known and not empty, every job is named with --job, and no name looks like a deploy, release, publish or promote.
export function rerunPlan(runs, workflows, jobs, jobsOf) {
  const pending = runs.filter(r => r.status !== 'completed');
  if (pending.length) return { pending, failed: [], skipped: [] };
  const failed = [];
  const skipped = [];
  for (const r of runs.filter(r => FAILED.has(r.conclusion))) {
    if (!workflows.includes(r.workflowName)) { skipped.push({ run: r, why: 'workflow not named with --workflow' }); continue; }
    const listed = jobsOf(r);
    const names = Array.isArray(listed) ? listed.map(j => j?.name) : listed;
    // A skipped or unfinished job is a dependent that has not run yet: --failed could start work nobody inspected.
    if (Array.isArray(listed) && listed.some(j => j?.status !== 'completed' || j?.conclusion === 'skipped')) { skipped.push({ run: r, why: 'dependent jobs not materialized (skipped or unfinished)' }); continue; }
    if (!Array.isArray(names) || !names.length) { skipped.push({ run: r, why: 'job list unknown' }); continue; }
    const reserved = [r.name, r.workflowName, ...names].find(name => RESERVED.test(String(name)));
    if (reserved) { skipped.push({ run: r, why: `deploy or release job "${reserved}" is an owner gate` }); continue; }
    const unknown = names.findIndex(name => typeof name !== 'string' || !name || !jobs.includes(name));
    if (unknown >= 0) skipped.push({ run: r, why: `job ${JSON.stringify(names[unknown] ?? null)} not named with --job` });
    else failed.push(r);
  }
  return { pending, failed, skipped };
}

function main(argv) {
  const o = { workflows: [], jobs: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') { o.dryRun = true; continue; }
    if (!['--pr', '--sha', '--repo', '--workflow', '--job'].includes(k) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw Object.assign(new Error(`bad argument ${k}`), { exit: 2 });
    if (k === '--workflow') o.workflows.push(argv[++i]); else if (k === '--job') o.jobs.push(argv[++i]); else o[k.slice(2)] = argv[++i];
  }
  if (o.pr && o.sha) throw Object.assign(new Error('use --pr or --sha, not both'), { exit: 2 });
  if (!o.workflows.length || !o.jobs.length) throw Object.assign(new Error('name the CI workflow(s) and their jobs to rerun with --workflow <name> and --job <name>'), { exit: 2 });
  const repo = o.repo ? ['--repo', o.repo] : [];
  const sha = o.sha || (o.pr ? run('gh', ['pr', 'view', o.pr, ...repo, '--json', 'headRefOid', '-q', '.headRefOid']) : run('git', ['rev-parse', 'HEAD']));
  const runs = JSON.parse(run('gh', ['run', 'list', ...repo, '--commit', sha, '--limit', String(LIMIT), '--json', 'databaseId,name,workflowName,status,conclusion']) || '[]');
  if (runs.length >= LIMIT) throw Object.assign(new Error(`${runs.length} runs for ${sha}: the list may be incomplete, rerun nothing`), { exit: 2 });
  const jobsOf = r => JSON.parse(run('gh', ['run', 'view', String(r.databaseId), ...repo, '--json', 'jobs']) || '{}').jobs ?? null;
  const { pending, failed, skipped } = rerunPlan(runs, o.workflows, o.jobs, jobsOf);
  if (pending.length) {
    console.log(`CI_PENDING ${sha.slice(0, 12)}: ${pending.map(r => `${r.name} (${r.status})`).join(', ')}; wait for them to finish, then rerun`);
    return 2;
  }
  for (const { run: r, why } of skipped) console.log(`SKIPPED ${r.databaseId} ${r.name} (${r.conclusion}): ${why}`);
  if (!failed.length) {
    console.log(`CI_NOTHING_TO_RERUN ${sha.slice(0, 12)}: ${runs.length} run(s), ${skipped.length} failed run(s) skipped, none eligible for rerun`);
    return 0;
  }
  for (const r of failed) {
    if (!o.dryRun) run('gh', ['run', 'rerun', String(r.databaseId), '--failed', ...repo]);
    console.log(`${o.dryRun ? 'WOULD_RERUN' : 'RERUN'} --failed ${r.databaseId} ${r.name} (${r.conclusion})`);
  }
  return 0;
}

const isMain = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ''); } catch { return false; } })();
if (isMain) { try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`ci-rerun: ${e.message}`); process.exitCode = e.exit || 2; } }
