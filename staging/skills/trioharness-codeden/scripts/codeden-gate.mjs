#!/usr/bin/env node
// The factory audit binds guard proof and Team review to the accepted commit.
// Run "record --run <id>" on a committed candidate, then "check" in the builder worktree.
// The installed receipt policy controls Jev done checks. A suspended receipt policy still requires
// the accepted commit history, valid reviewer receipts, any required second pass and settled findings.
// Docs-only changes retain the existing exemption after escalation checks.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

// Gate paths from subdirectories: without --repo, the run ledger belongs to the worktree ROOT, never the cwd.
const worktreeRoot = d => { try { const t = execFileSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return t ? resolve(t) : resolve(d); } catch { return resolve(d); } };
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRun, readRounds } from './team-review.mjs';
import { highRiskPaths, loadTeamChecked } from './team.mjs';
import { LOOP_CAPS } from './run-state.mjs';
const policyFile = new URL('../../../../.config/trioharness/jev-receipt-policy.mjs', import.meta.url);
const { JEV_RECEIPT_REQUIRED } = await import(existsSync(policyFile) ? policyFile :
  pathToFileURL(join(userInfo().homedir, '.config', 'trioharness', 'jev-receipt-policy.mjs')));
if (typeof JEV_RECEIPT_REQUIRED !== 'boolean') throw new Error('JEV_RECEIPT_POLICY_INVALID');

const arb = await import(existsSync(new URL('./arbiter.mjs', import.meta.url)) ? './arbiter.mjs' : '../../config/arbiter-lib.mjs');
const planRounds = LOOP_CAPS['plan-review'] + LOOP_CAPS.replan;

export const RUNS = ['.trioharness-direct', 'runs'];
export const RECEIPTS = 'jev-receipts.jsonl';
export const RECORD = 'codeden-gate.json';
const DOCS_ONLY = /^(docs\/|README|CHANGELOG|LICENSE|AGENTS\.md$|LEARNINGS\.md$|.*\.(md|mdx|txt)$)/i;

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (repo, ...args) => { try { return git(repo, ...args); } catch { return null; } };
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
const runsDir = repo => join(repo, ...RUNS);

export function lastDoneReceipt(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let r; try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r.gate === 'done' && !r.dryRun) return r;
  }
  return null;
}

// Team review gate: reviewer identity per team.json plus the high-risk second pass. Returns problem strings.
export function reviewProblems(repo, run, base) {
  const r = checkRun(repo, run, base, loadTeamChecked({ real: true }));
  return r.problems.map(p => `REVIEW_GATE: ${p}`);
}

export function record(repo, run, base) {
  const dir = join(runsDir(repo), run);
  if (!existsSync(join(dir, 'state.json'))) throw new Error(`NO_RUN: ${dir}/state.json missing`);
  const receipt = JEV_RECEIPT_REQUIRED ? lastDoneReceipt(join(dir, RECEIPTS)) : null;
  if (JEV_RECEIPT_REQUIRED) {
    if (!receipt) throw new Error(`NO_DONE_RECEIPT: run Jev done with --log "${join(dir, RECEIPTS)}" first (absolute path)`);
    if (receipt.verdict !== 'proceed' || receipt.pass !== true) throw new Error(`DONE_NOT_PROCEED: last Jev done verdict is ${receipt.verdict}`);
    if (!receipt.jev?.model) throw new Error('DONE_NOT_JUDGED: the done receipt carries no Jev answer');
  }
  if (tryGit(repo, 'status', '--porcelain', '--untracked-files=no')) throw new Error('DIRTY_TREE: commit the accepted candidate before recording');
  const review = reviewProblems(repo, run, base);
  if (review.length) throw new Error(review.join('; '));
  const out = { run, head: git(repo, 'rev-parse', 'HEAD'), tree: git(repo, 'rev-parse', 'HEAD^{tree}'), ...(receipt ? { inputSha256: receipt.inputSha256, jevAt: receipt.at } : {}), recordedAt: new Date().toISOString() };
  writeFileSync(join(dir, RECORD), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

function escalationProblems(repo, base, head, dir, runs) {
  const problems = [];
  let team, highRiskCandidate;
  for (const run of runs) {
    const runDir = join(dir, run);
    try {
      const blocked = arb.itemBlocked(runDir);
      if (blocked && !arb.isModelRoundCeilingBlock(blocked)) { problems.push(`${run}: ITEM_BLOCKED: ${blocked.reason}`); continue; }
      team ??= arb.loadEscalationTeam({ real: true, repo }) ?? false;
      if (!team) {
        if (blocked) problems.push(`${run}: ITEM_BLOCKED: ${blocked.reason}`);
        continue;
      }
      const rows = readRounds(repo, run);
      if (highRiskCandidate === undefined) {
        const ref = base || tryGit(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD') || 'origin/main';
        const paths = (tryGit(repo, 'diff', '--no-renames', '--name-only', '-z', `${ref}...HEAD`) || '').split('\0').filter(Boolean);
        const agents = join(repo, 'AGENTS.md');
        highRiskCandidate = highRiskPaths(team, paths, existsSync(agents) ? readFileSync(agents, 'utf8') : '').length > 0;
      }
      const highRisk = highRiskCandidate || rows.some(row => row.highRisk === true);
      problems.push(...arb.arbiterProblems(team, runDir, rows, { head, highRisk, planRounds }).map(p => `${run}: ${p}`));

      const escalation = arb.escalationRows(runDir);
      if (JEV_RECEIPT_REQUIRED && ['code', 'plan', 'jev-plan', 'jev-done'].some(scope => arb.arbiterState(escalation, scope).decision === 'APPROVE')) {
        const receipt = arb.jevReceipts(runDir).findLast(row => row.gate === 'done' && !row.dryRun);
        if (!receipt) problems.push(`${run}: NO_DONE_RECEIPT`);
        else if (receipt.verdict !== 'proceed' || receipt.pass !== true) problems.push(`${run}: DONE_NOT_PROCEED: ${receipt.verdict}`);
        else if (!receipt.jev?.model) problems.push(`${run}: DONE_NOT_JUDGED`);
      }
    } catch (error) { problems.push(`${run}: ${error.message.split('\n')[0]}`); }
  }
  return problems;
}

export function check(repo, base) {
  const problems = [];
  const head = git(repo, 'rev-parse', 'HEAD');
  const dir = runsDir(repo);
  const entries = existsSync(dir) ? readdirSync(dir) : [];
  const recorded = entries.filter(run => [RECORD, 'state.json', arb.BLOCKED, arb.ESCALATION].some(file => existsSync(join(dir, run, file))));
  const escalation = escalationProblems(repo, base, head, dir, recorded);
  if (escalation.length) return { pass: false, head, problems: escalation };
  if (base && tryGit(repo, 'rev-parse', '--verify', base)) {
    const changed = (tryGit(repo, 'diff', '--name-only', `${base}...HEAD`) || '').split('\n').filter(Boolean);
    if (changed.length && changed.every(p => DOCS_ONLY.test(p))) return { pass: true, docsOnly: true, head, changed };
  }
  const runs = entries.filter(r => existsSync(join(dir, r, RECORD)))
    .sort((a, b) => statSync(join(dir, b, RECORD)).mtimeMs - statSync(join(dir, a, RECORD)).mtimeMs);
  if (!runs.length) return { pass: false, head, problems: ['NO_GATE_RECORD: no trioharness run in this worktree recorded acceptance (codeden-gate.mjs record)'] };
  for (const run of runs) {
    const rec = readJson(join(dir, run, RECORD));
    const isAncestor = rec.head === head || tryGit(repo, 'merge-base', '--is-ancestor', rec.head, head) !== null;
    if (!isAncestor) { problems.push(`${run}: STALE_RECORD bound to ${rec.head.slice(0, 12)}, not an ancestor of HEAD`); continue; }
    const p = [];
    const extra = (tryGit(repo, 'rev-list', '--first-parent', '--no-merges', `${rec.head}..${head}`) || '').split('\n').filter(Boolean);
    if (extra.length) p.push(`HEAD_MISMATCH: ${extra.length} non-merge commit(s) after the accepted head`);
    let state; try { state = readJson(join(dir, run, 'state.json')); } catch { p.push('NO_STATE'); }
    const gates = ['guard-proof', ...(JEV_RECEIPT_REQUIRED ? ['done-jev'] : [])];
    for (const g of gates) if (state && state.gates?.[g]?.status !== 'passed') p.push(`GATE_NOT_PASSED: ${g} is ${state.gates?.[g]?.status || 'missing'}`);
    if (JEV_RECEIPT_REQUIRED) {
      const receipt = lastDoneReceipt(join(dir, run, RECEIPTS));
      if (!receipt) p.push('NO_DONE_RECEIPT');
      else {
        if (receipt.verdict !== 'proceed' || receipt.pass !== true) p.push(`DONE_NOT_PROCEED: ${receipt.verdict}`);
        if (!receipt.jev?.model) p.push('DONE_NOT_JUDGED');
        if (receipt.inputSha256 !== rec.inputSha256) p.push('RECEIPT_MISMATCH: newest Jev done differs from the recorded one; record again');
      }
    }
    try { p.push(...reviewProblems(repo, run, base)); } catch (e) { p.push(`REVIEW_GATE: ${e.message.split('\n')[0]}`); }
    if (!p.length) return { pass: true, run, head, boundTo: rec.head };
    problems.push(...p.map(x => `${run}: ${x}`));
    break; // newest applicable run decides
  }
  return { pass: false, head, problems };
}

if ((() => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ''); } catch { return false; } })()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const repo = opt('--repo') ? resolve(opt('--repo')) : worktreeRoot('.');
  try {
    if (cmd === 'record') {
      const run = opt('--run'); if (!run) throw new Error('USAGE: record --run <run-id>');
      console.log(JSON.stringify(record(repo, run, opt('--base'))));
    } else if (cmd === 'check') {
      const base = opt('--base') || (tryGit(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD') ?? 'origin/main');
      const r = check(repo, base);
      console.log(JSON.stringify(r, null, 2));
      if (!r.pass) { console.error('TrioHarness gate refused: ' + r.problems.join('; ')); process.exit(2); }
    } else { console.error('Usage: codeden-gate.mjs record --run <id> | check [--base origin/<default>]'); process.exit(3); }
  } catch (e) { console.error(`codeden-gate: ${e.message}`); process.exit(3); }
}
