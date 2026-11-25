#!/usr/bin/env node
// TrioHarness Lean — clean end state. A run is finished only when nothing it produced exists in one place only:
//   - no uncommitted work: closeout preserved dirty trees on `trio/wip-*` snapshot refs; those are a defect to
//     resolve (fold into the PR branch, or the user accepts them), never a place to leave work;
//   - nothing unpushed: every task branch tip is on the LIVE remote (ls-remote, not a cached ref);
//   - nothing unmerged and unaccounted for: every task branch that has commits beyond the default branch has a
//     pull request that is MERGED (its merge commit is on the live default branch) or OPEN on the pushed tip and
//     waiting for the user's approval card. A branch with commits and no PR, a closed unmerged PR, or a PR whose
//     head is not the pushed tip is a blocker.
// Agents merge only through merge-verify.mjs (verified merge, opted-in repos): an open PR awaiting the user's approval is a legitimate end state, but it is
// reported by number and URL, never left implicit. Read-only: it fetches and asks GitHub; it never pushes,
// merges, closes or deletes anything.
//
// Usage:
//   node clean-state.mjs check   --repo <main checkout> --run <id> [--remote origin] [--default main]
//        records .trioharness-direct/runs/<id>/clean-state.json; exit 0 clean · 2 blockers · 3 error
//   node clean-state.mjs card    --repo <main checkout> --run <id>       card for the blockers only the user can decide
//   node clean-state.mjs resolve --repo <main checkout> --run <id> --set Q-<n>
//   node clean-state.mjs audit   --repo <main checkout> [--remote origin] [--days 3]
//        weekly watch: open PRs waiting longer than N days, task branches with commits and no PR, a dirty main checkout
// run-state.mjs refuses the learnings gate (and so the run's `finished`) for a run that registered a task branch
// until the record says clean and is newer than the closeout (cleanStateReason).
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSets } from './questions.mjs';
import { validRunId } from './ids.mjs';
import { isMain } from './is-main.mjs';

export const CARD_QUESTION_ID = 'cleanstate';
export const USER_DECIDES = new Set(['WIP_SNAPSHOT', 'PR_CLOSED_UNMERGED']);
const BRANCH_OK = /^[A-Za-z0-9._@+/-]{1,200}$/;
const validBranch = b => typeof b === 'string' && BRANCH_OK.test(b) && !b.startsWith('-') && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock');

const runDir = (repo, run) => join(repo, '.trioharness-direct', 'runs', run);
const recFile = (repo, run) => join(runDir(repo, run), 'clean-state.json');
const stateFile = (repo, run) => join(runDir(repo, run), 'state.json');
function atomicWrite(file, text) { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); }
function readState(repo, run) { try { return JSON.parse(readFileSync(stateFile(repo, run), 'utf8')); } catch { return null; } }

export const gitIn = cwd => args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000 });
export const ghJsonRunner = () => args => {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.error || r.status !== 0) throw new Error('gh failed');
  return JSON.parse(r.stdout || 'null');
};

// owner/repo from a GitHub remote URL (https or ssh); null for any other host.
export function repoSlug(url) {
  const m = String(url || '').trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Issue proof covers these bytes in this order; an absent file contributes empty bytes.
const ISSUE_FILES = ['issues.json', 'harness-defects.md', 'issues-failures.jsonl'];
const ISSUE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ISSUE_STATUSES = new Set(['triaged', 'in-progress', 'in-review', 'merged', 'deployed-qa', 'deployed-prod', 'released', 'withdrawn']);
const ISSUE_EVENTS = new Set(['writer-start', 'pr-open', 'merged', 'deployed-qa', 'deployed-prod', 'rollback', 'installed']);
const ISSUE_CATEGORIES = new Set(['IMPORT_FAILED', 'RUNNER_FAILED', 'GH_UNAVAILABLE', 'IDENTITY_UNVERIFIED', 'OTHER']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const hasIssueFiles = (repo, run) => ISSUE_FILES.some(f => existsSync(join(runDir(repo, run), f)));
function issuesDigest(repo, run) {
  const hash = createHash('sha256');
  for (const f of ISSUE_FILES) {
    const path = join(runDir(repo, run), f);
    if (existsSync(path)) hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}
function readIssueLedger(repo, run) {
  const path = join(runDir(repo, run), 'issues.json');
  if (!existsSync(path)) return null;
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  if (!object(ledger) || ledger.version !== 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ledger.repo) || !object(ledger.issues) || !Array.isArray(ledger.pending) || !Array.isArray(ledger.refusals)) throw new Error('ISSUES_LEDGER_UNREADABLE');
  const keys = new Set();
  for (const [key, issue] of Object.entries(ledger.issues)) {
    if (!ISSUE_KEY.test(key) || keys.has(key.toLowerCase()) || !object(issue) || issue.key !== key || !Number.isInteger(issue.number) || issue.number < 1 || typeof issue.url !== 'string' || typeof issue.title !== 'string' || !ISSUE_STATUSES.has(issue.status) || !['labels', 'observedLabels', 'history', 'prs', 'deliveries', 'rollbacks'].every(f => Array.isArray(issue[f])) || !(issue.mergeSha === null || typeof issue.mergeSha === 'string')) throw new Error('ISSUES_LEDGER_UNREADABLE');
    keys.add(key.toLowerCase());
  }
  if (ledger.pending.some(p => !object(p))) throw new Error('ISSUES_LEDGER_UNREADABLE');
  return ledger;
}
function hookFailureReason(repo, run) {
  const path = join(runDir(repo, run), 'issues-failures.jsonl');
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const unresolved = new Set();
    for (const text of lines) {
      const line = JSON.parse(text);
      if (!object(line) || Object.keys(line).some(k => !['v', 'kind', 'ts', 'run', 'event', 'category', 'key'].includes(k)) || line.v !== 1 || !['failure', 'resolved'].includes(line.kind) || typeof line.ts !== 'string' || new Date(line.ts).toISOString() !== line.ts || line.run !== run || !ISSUE_EVENTS.has(line.event) || !ISSUE_CATEGORIES.has(line.category) || ('key' in line && (typeof line.key !== 'string' || !ISSUE_KEY.test(line.key)))) throw new Error('invalid record');
      const id = JSON.stringify([line.event, line.key ?? null]);
      if (line.kind === 'failure') unresolved.add(id);
      else unresolved.delete(id);
    }
    return unresolved.size ? 'ISSUES_HOOK_FAILED: an issue transition has an unresolved failure record' : null;
  } catch { return 'ISSUES_HOOK_FAILED: issues-failures.jsonl is unreadable or contains a non-allowlisted record'; }
}

// Pure local check. Never calls GitHub and never echoes issue or error text.
export function issueLedgerReason(repo, run) {
  if (!validRunId(run)) return null;
  let ledger;
  try { ledger = readIssueLedger(repo, run); } catch { return 'ISSUES_LEDGER_UNREADABLE: issues.json is unreadable or has an invalid shape'; }
  const defects = join(runDir(repo, run), 'harness-defects.md');
  if (existsSync(defects)) {
    let headings;
    try { headings = [...readFileSync(defects, 'utf8').matchAll(/^##[ \t]+([^\r\n]*)/gm)].map(m => m[1].trim()); }
    catch { return 'ISSUE_KEY_INVALID: harness-defects.md is unreadable'; }
    if (headings.some(key => !ISSUE_KEY.test(key))) return 'ISSUE_KEY_INVALID: a defect heading is not an issue key';
    if (headings.some(key => !Object.hasOwn(ledger?.issues || {}, key))) return 'ISSUE_MISSING: a defect heading has no issue ledger entry';
  }
  if (ledger?.pending.some(p => !p.resolved)) return 'ISSUES_PENDING: unresolved issue operations remain';
  return hookFailureReason(repo, run);
}

// checkCleanState remains synchronous. The child imports issues lazily, and every issue read uses
// that module's verified runner (never the host-login ghJsonRunner used for existing PR checks).
function agentIssueJson(repo, slug, args) {
  const source = `const mod = await import(${JSON.stringify(new URL('./issues.mjs', import.meta.url).href)}); const gh = await mod.makeAgentGh({checkout:process.argv[1],repo:process.argv[2],env:process.env}); const r = await gh(JSON.parse(process.argv[3])); if (!r.ok) process.exitCode=2; else process.stdout.write(r.out);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source, repo, slug, JSON.stringify(args)], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error('issue state unavailable');
  return JSON.parse(r.stdout);
}

// The task branches a run produced: every registered tree's branch plus the run's own branch name.
export function taskBranches(state, run) {
  const set = new Set();
  for (const w of state?.worktrees || []) if (w?.branch && validBranch(w.branch)) set.add(w.branch);
  if (set.size) set.add(`bambooed/${run}`);
  return [...set].filter(validBranch);
}

const tryGit = (git, args) => { try { return git(args).trim(); } catch { return null; } };
const isAncestor = (git, a, b) => { try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };

export function checkCleanState(repo, run, { remote = 'origin', branch = 'main', git = gitIn(repo), ghJson, slug: slugOverride = null, now = new Date().toISOString() } = {}) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  const state = readState(repo, run);
  if (!state) throw new Error('RUN_UNKNOWN');
  const branches = taskBranches(state, run);
  const blockers = [], warnings = [], report = [];
  const block = (code, b, detail) => blockers.push({ code, branch: b, detail });

  const localIssueReason = issueLedgerReason(repo, run);
  if (localIssueReason) block(localIssueReason.split(':')[0], null, localIssueReason);
  const hasIssues = hasIssueFiles(repo, run);
  let digest;
  if (hasIssues) {
    try { digest = issuesDigest(repo, run); }
    catch { block('ISSUES_STATE_UNKNOWN', null, 'the issue proof bytes could not be read'); }
    let ledger;
    try { ledger = readIssueLedger(repo, run); } catch { /* already a local blocker */ }
    if (ledger) {
      const query = ghJson || (args => agentIssueJson(repo, ledger.repo, args));
      for (const issue of Object.values(ledger.issues)) {
        try {
          const live = query(['api', `repos/${ledger.repo}/issues/${issue.number}`]);
          if (!object(live) || !['open', 'closed'].includes(String(live.state).toLowerCase()) || !Array.isArray(live.labels) || live.labels.some(l => typeof l !== 'string' && (!object(l) || typeof l.name !== 'string'))) throw new Error('unreadable issue');
          const allLabels = live.labels.map(l => typeof l === 'string' ? l : l.name);
          const labels = allLabels.filter(l => l.startsWith('status:'));
          const state = ['deployed-prod', 'released', 'withdrawn'].includes(issue.status) ? 'closed' : 'open';
          const labelsMatch = issue.status === 'withdrawn' ? labels.length === 0 && allLabels.includes('wontfix') : labels.length === 1 && labels[0] === `status:${issue.status}`;
          if (String(live.state).toLowerCase() !== state || !labelsMatch) block('ISSUES_OUT_OF_SYNC', null, 'GitHub issue state or status labels differ from the ledger');
        } catch { block('ISSUES_STATE_UNKNOWN', null, 'GitHub could not be queried through the verified issue runner'); }
      }
    }
  }
  const issueProof = hasIssues ? { issuesDigest: digest } : {};
  if (!branches.length) return { run, at: now, ok: blockers.length === 0, verdict: blockers.length ? 'blocked' : hasIssues ? 'clean' : 'no-code', blockers, warnings, branches: report, awaitingApproval: [], ...issueProof };
  ghJson ||= ghJsonRunner();

  try { git(['fetch', '--quiet', remote, branch]); } catch { throw new Error(`CLEAN_STATE_FETCH_FAILED: could not fetch ${remote}/${branch}`); }
  const defaultSha = tryGit(git, ['rev-parse', '--verify', `${remote}/${branch}^{commit}`]);
  if (!defaultSha) throw new Error(`CLEAN_STATE_NO_DEFAULT: ${remote}/${branch} does not exist`);
  const slug = slugOverride || repoSlug(tryGit(git, ['remote', 'get-url', remote]));

  // Worktrees must be gone (closeout) — a tree left open holds work that is in one place only.
  for (const w of state.worktrees || []) if (w?.path && existsSync(w.path)) block('TREE_OPEN', w.branch || null, `registered worktree still exists: ${w.path}`);

  const wipRemote = (tryGit(git, ['ls-remote', '--heads', remote, 'refs/heads/trio/wip-*']) || '').split(/\r?\n/).map(l => l.split(/\s+/)[1]).filter(Boolean);
  const wipLocal = (tryGit(git, ['for-each-ref', '--format=%(refname)', 'refs/heads/trio/wip-*']) || '').split(/\r?\n/).filter(Boolean);
  const awaiting = [];

  for (const b of branches) {
    const lsLine = (tryGit(git, ['ls-remote', '--heads', remote, `refs/heads/${b}`]) || '').split(/\r?\n/)[0] || '';
    const remoteTip = lsLine.split(/\s+/)[0] || null;
    const localTip = tryGit(git, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
    const info = { branch: b, remoteTip: remoteTip ? remoteTip.slice(0, 12) : null, localTip: localTip ? localTip.slice(0, 12) : null };

    if (remoteTip) tryGit(git, ['fetch', '--quiet', remote, `refs/heads/${b}`]);
    if (localTip && remoteTip && localTip !== remoteTip && !isAncestor(git, localTip, remoteTip)) {
      const n = tryGit(git, ['rev-list', '--count', `${remoteTip}..${localTip}`]);
      block('UNPUSHED', b, `${n ?? 'some'} local commit(s) are not on ${remote}`);
    } else if (localTip && !remoteTip) {
      const n = tryGit(git, ['rev-list', '--count', `${defaultSha}..${localTip}`]);
      if (Number(n) > 0) block('UNPUSHED', b, `the branch has ${n} commit(s) and does not exist on ${remote}`);
    }

    const tip = remoteTip || localTip;
    const beyond = tip ? Number(tryGit(git, ['rev-list', '--count', `${defaultSha}..${tip}`]) || 0) : 0;
    info.commitsBeyondDefault = beyond;

    // snapshot refs created by closeout for this branch: dirty work was found and parked, not delivered
    const prefix = `refs/heads/trio/wip-${b}-`;
    for (const ref of [...new Set([...wipRemote, ...wipLocal])].filter(r => r.startsWith(prefix))) block('WIP_SNAPSHOT', b, `uncommitted work was parked on ${ref.replace('refs/heads/', '')}`);

    let pr = null, lookupFailed = false;
    if ((tip && beyond > 0) || !tip) {
      if (!slug) block('PR_STATE_UNKNOWN', b, 'the remote is not a GitHub repository this gate can query');
      else {
        try {
          const list = ghJson(['pr', 'list', '--repo', slug, '--head', b, '--state', 'all', '--limit', '5', '--json', 'number,state,mergedAt,headRefOid,url,isDraft,mergeCommit']) || [];
          pr = list.sort((x, y) => y.number - x.number)[0] || null;
        } catch { lookupFailed = true; block('PR_STATE_UNKNOWN', b, 'GitHub could not be queried for this branch (gh missing, not signed in, or offline)'); }
      }
    }
    if (pr) info.pr = { number: pr.number, state: pr.state, url: pr.url, draft: !!pr.isDraft };

    if (!tip && !pr) { warnings.push({ code: 'BRANCH_GONE', branch: b, detail: 'the branch exists nowhere and has no pull request: nothing to deliver' }); info.state = 'gone'; }
    else if (tip && beyond === 0 && !(pr && pr.state === 'OPEN')) info.state = tip === defaultSha ? 'no-changes' : 'in-default';
    else if (tip || pr) {
      if (!pr) { if (tip && beyond > 0 && slug && !lookupFailed) block('NO_PR', b, `${beyond} commit(s) beyond ${branch} are pushed but have no pull request`); info.state = 'no-pr'; }
      else if (pr.state === 'MERGED') {
        const oid = pr.mergeCommit?.oid || pr.headRefOid;
        tryGit(git, ['fetch', '--quiet', remote, branch]);
        const defNow = tryGit(git, ['rev-parse', '--verify', `${remote}/${branch}^{commit}`]) || defaultSha;
        if (oid && tryGit(git, ['cat-file', '-e', `${oid}^{commit}`]) === null && !tryGit(git, ['rev-parse', '--verify', '--quiet', `${oid}^{commit}`])) tryGit(git, ['fetch', '--quiet', remote, oid]);
        if (oid && isAncestor(git, oid, defNow)) info.state = 'merged';
        else { block('MERGED_NOT_ON_DEFAULT', b, `PR #${pr.number} is merged but its commit is not on ${remote}/${branch}`); info.state = 'merged-unverified'; }
      } else if (pr.state === 'OPEN') {
        if (remoteTip && pr.headRefOid && pr.headRefOid !== remoteTip) block('PR_HEAD_STALE', b, `PR #${pr.number} shows ${String(pr.headRefOid).slice(0, 12)} but the branch tip is ${remoteTip.slice(0, 12)}`);
        info.state = pr.isDraft ? 'draft' : 'awaiting-approval';
        awaiting.push({ number: pr.number, url: pr.url, branch: b, draft: !!pr.isDraft });
        if (pr.isDraft) warnings.push({ code: 'PR_DRAFT', branch: b, detail: `PR #${pr.number} is still a draft` });
      } else { block('PR_CLOSED_UNMERGED', b, `PR #${pr.number} was closed without merging; ${beyond} commit(s) are in no merged PR`); info.state = 'closed-unmerged'; }
    }
    report.push(info);
  }

  const dirty = tryGit(git, ['status', '--porcelain', '--untracked-files=normal']);
  if (dirty) warnings.push({ code: 'MAIN_CHECKOUT_DIRTY', branch: null, detail: `${dirty.split(/\r?\n/).length} changed path(s) in the main checkout (the user's own tree; the harness never touches it)` });

  // blockers the user explicitly accepted on an answered card
  const accepted = readRecord(repo, run)?.accepted || [];
  const open = blockers.filter(x => x.code.startsWith('ISSUE') || !accepted.some(a => a.code === x.code && a.branch === x.branch && (!a.detail || a.detail === x.detail)));
  const rec = { run, at: now, ok: open.length === 0, verdict: open.length ? 'blocked' : awaiting.length ? 'clean-awaiting-approval' : 'clean', base: defaultSha, blockers: open, accepted, warnings, branches: report, awaitingApproval: awaiting, ...issueProof };
  return rec;
}

export function recordCleanState(repo, run, rec) {
  mkdirSync(runDir(repo, run), { recursive: true });
  atomicWrite(recFile(repo, run), JSON.stringify(rec, null, 2));
  return rec;
}
export function readRecord(repo, run) {
  if (!validRunId(run) || !existsSync(recFile(repo, run))) return null;
  try { return JSON.parse(readFileSync(recFile(repo, run), 'utf8')); } catch { return { unreadable: true }; }
}

// The card for blockers only the user can decide. Everything else (unpushed, no PR, stale head) the Architect fixes itself.
export function buildCard(rec) {
  const items = (rec?.blockers || []).filter(x => USER_DECIDES.has(x.code));
  if (!items.length) throw new Error('NOTHING_FOR_THE_USER: the remaining blockers are the Architect\'s to fix (push, open the PR, update it)');
  const what = items.map(x => `${x.branch}: ${x.code === 'WIP_SNAPSHOT' ? 'work parked on a snapshot branch' : 'a pull request closed without merging'}`).join('; ').slice(0, 260);
  return { questions: [{
    id: CARD_QUESTION_ID, header: 'Loose work', multiSelect: false,
    question: `This run left work outside a merged or approved pull request (${what}). What should happen to it?`.slice(0, 399),
    options: [
      { id: 'a', label: 'Fold it into the pull request', description: 'The Architect brings that work into the task branch or reopens the pull request, pushes it and checks again. The run stays open until then.' },
      { id: 'b', label: 'Keep it as it is, I accept that', description: 'It stays where it is, recorded as accepted by you. Nothing is deleted. The run can finish.' },
      { id: 'c', label: 'It is scratch, I will delete it myself', description: 'Nothing is deleted by the agent. It is recorded as accepted and the run can finish; you remove the branch when you want.' }
    ],
    recommended: 'a',
    why: 'Work should live in a reviewed branch, not on a parked snapshot.'
  }] };
}

export function resolveCleanState(repo, run, setId, { now = new Date().toISOString() } = {}) {
  const rec = readRecord(repo, run);
  if (!rec || rec.unreadable) throw new Error('CLEAN_STATE_NOT_CHECKED: run `clean-state.mjs check --run <id>` first');
  const set = readSets(repo, run).find(s => s.id === setId);
  if (!set) throw new Error(`SET_UNKNOWN: ${setId}`);
  if (!['answered', 'assumed'].includes(set.status)) throw new Error(`SET_NOT_ANSWERED: ${setId} is ${set.status}; the run stays stopped until the user answers`);
  if (!set.card?.questions?.some(q => q.id === CARD_QUESTION_ID)) throw new Error(`SET_NOT_CLEAN_STATE: ${setId} is not the card from clean-state.mjs card`);
  const answer = set.answers?.[CARD_QUESTION_ID];
  if (!['a', 'b', 'c'].includes(answer)) throw new Error('ANSWER_INVALID: not an option of the clean-state card');
  if (answer === 'a') return { accepted: [], choice: 'fold-in', note: 'not accepted: the Architect folds the work in and checks again' };
  const add = (rec.blockers || []).filter(x => USER_DECIDES.has(x.code)).map(x => ({ code: x.code, branch: x.branch, detail: x.detail, by: set.status === 'assumed' ? 'assumed (unattended)' : (set.answeredVia || 'card'), set: setId, at: now }));
  rec.accepted = [...(rec.accepted || []), ...add];
  rec.blockers = (rec.blockers || []).filter(x => !add.some(a => a.code === x.code && a.branch === x.branch && a.detail === x.detail));
  rec.ok = rec.blockers.length === 0;
  rec.verdict = rec.ok ? (rec.awaitingApproval?.length ? 'clean-awaiting-approval' : 'clean') : 'blocked';
  recordCleanState(repo, run, rec);
  return { accepted: add.length, choice: answer === 'b' ? 'keep' : 'user-deletes', ok: rec.ok };
}

// Used by run-state: a run that produced a task branch cannot pass learnings / finish until this holds.
export function cleanStateReason(repo, run) {
  if (!validRunId(run)) return null;
  const localIssueReason = issueLedgerReason(repo, run);
  if (localIssueReason) return localIssueReason;
  if (hasIssueFiles(repo, run)) {
    const rec = readRecord(repo, run);
    if (!rec) return 'issue proof is missing: run `clean-state.mjs check --run <id>`';
    if (rec.unreadable) return 'clean-state.json is unreadable: run `clean-state.mjs check --run <id>` again';
    let digest;
    try { digest = issuesDigest(repo, run); } catch { return 'issue proof bytes are unreadable: run `clean-state.mjs check --run <id>` again'; }
    if (rec.issuesDigest !== digest) return 'clean-state.json is stale: the issue ledger, defect list or failure log changed after the last check; rerun clean-state.mjs check';
    const blockers = (rec.blockers || []).filter(b => String(b.code).startsWith('ISSUE'));
    if (blockers.length) return `clean end state not reached: ${blockers.map(b => b.code).join(', ')}`;
    if (!rec.ok) return 'clean end state not reached: the issue proof is not clean';
  }
  const state = readState(repo, run);
  if (!taskBranches(state, run).length) return null;
  // While closeout has not run or trees are still open, the existing closeout rules already keep the run unfinished; this gate applies from the moment the trees are closed.
  if (!state.closeout || state.closeout.open > 0) return null;
  const rec = readRecord(repo, run);
  if (!rec) return 'this run produced a task branch: run `clean-state.mjs check --run <id>` (nothing uncommitted, unpushed or unmerged may remain)';
  if (rec.unreadable) return 'clean-state.json is unreadable: run `clean-state.mjs check --run <id>` again';
  if (state.closeout?.at && rec.at < state.closeout.at) return 'clean-state.json is older than the closeout: run `clean-state.mjs check --run <id>` again';
  if (!rec.ok) return `clean end state not reached: ${(rec.blockers || []).map(b => `${b.code}${b.branch ? ` (${b.branch})` : ''}`).join(', ')}`;
  return null;
}

// Weekly watch (read-only): what is waiting, what is orphaned, what is dirty.
export function auditRepo(repo, { remote = 'origin', branch = 'main', days = 3, git = gitIn(repo), ghJson = ghJsonRunner(), slug: slugOverride = null, now = Date.now() } = {}) {
  const slug = slugOverride || repoSlug(tryGit(git, ['remote', 'get-url', remote]));
  if (!slug) throw new Error('AUDIT_NOT_GITHUB: the remote is not a GitHub repository');
  try { git(['fetch', '--quiet', remote]); } catch { throw new Error(`AUDIT_FETCH_FAILED: could not fetch ${remote}`); }
  const defaultSha = tryGit(git, ['rev-parse', '--verify', `${remote}/${branch}^{commit}`]);
  const open = ghJson(['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,updatedAt,url,isDraft']) || [];
  const waiting = open.filter(p => !p.isDraft).map(p => ({ number: p.number, url: p.url, branch: p.headRefName, idleDays: Math.floor((now - Date.parse(p.updatedAt)) / 86400000) })).filter(p => p.idleDays >= days);
  const heads = (tryGit(git, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}/codeden/`, `refs/remotes/${remote}/bambooed/`, `refs/remotes/${remote}/trio/`]) || '').split(/\r?\n/).filter(Boolean);
  const hasPr = new Set(open.map(p => `${remote}/${p.headRefName}`));
  const orphans = [];
  for (const r of heads) {
    const n = Number(tryGit(git, ['rev-list', '--count', `${defaultSha}..${r}`]) || 0);
    if (n > 0 && !hasPr.has(r)) {
      let merged = false;
      try { const prs = ghJson(['pr', 'list', '--repo', slug, '--head', r.slice(remote.length + 1), '--state', 'merged', '--limit', '1', '--json', 'number']) || []; merged = prs.length > 0; } catch { /* unknown: report it */ }
      if (!merged) orphans.push({ branch: r.slice(remote.length + 1), commitsBeyondDefault: n });
    }
  }
  const dirty = tryGit(git, ['status', '--porcelain', '--untracked-files=normal']);
  return { repo: slug, waitingForApproval: waiting, orphanBranches: orphans, mainCheckoutDirty: dirty ? dirty.split(/\r?\n/).length : 0, ok: !orphans.length };
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = resolve(opt('repo') || '.');
  const out = v => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  try {
    const remote = opt('remote') || 'origin';
    let branch = opt('default');
    if (!branch) { try { branch = gitIn(repo)(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]).trim().replace(`${remote}/`, ''); } catch { branch = 'main'; } }
    if (cmd === 'check') {
      const rec = recordCleanState(repo, opt('run'), checkCleanState(repo, opt('run'), { remote, branch }));
      for (const b of rec.blockers) process.stderr.write(`CLEAN-STATE: BLOCKER ${b.code}${b.branch ? ` (${b.branch})` : ''}: ${b.detail}\n`);
      for (const a of rec.awaitingApproval) process.stderr.write(`CLEAN-STATE: waiting for your approval card: PR #${a.number} ${a.url}\n`);
      out(rec);
      if (!rec.ok) process.exitCode = 2;
    } else if (cmd === 'card') out(buildCard(readRecord(repo, opt('run'))));
    else if (cmd === 'resolve') out(resolveCleanState(repo, opt('run'), opt('set')));
    else if (cmd === 'audit') { const r = auditRepo(repo, { remote, branch, days: Number(opt('days') || 3) }); out(r); if (!r.ok) process.exitCode = 2; }
    else throw new Error('USAGE: check|card|resolve|audit');
  } catch (e) { process.stderr.write(`CLEAN-STATE: ${e.message}\n`); process.exitCode = 3; }
}
