import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditRepo, buildCard, checkCleanState, cleanStateReason, readRecord, recordCleanState, repoSlug, resolveCleanState, taskBranches } from './clean-state.mjs';
import { askCard, answerCard, validateCard } from './questions.mjs';
import { readState, recordCloseout, registerWorktree, reserveAttempt, setGate, updateFindings } from './run-state.mjs';
// Hermetic: the user's own standing orders must never answer a test card.
process.env.TRIOHARNESS_HOME = process.env.TRIOHARNESS_HOME_FOR_TESTS || '/nonexistent-trioharness-home';

const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const BR = 'bambooed/r1';
function mk() {
  const base = mkdtempSync(join(tmpdir(), 'cs-'));
  const remote = join(base, 'remote.git'), work = join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { env: { ...process.env, ...env } });
  mkdirSync(work); g(work, 'init', '-b', 'main'); g(work, 'remote', 'add', 'origin', remote);
  writeFileSync(join(work, '.git', 'info', 'exclude'), '.trioharness-direct/\n');
  const commit = n => { writeFileSync(join(work, n), n); g(work, 'add', '-A'); g(work, 'commit', '-m', n); return g(work, 'rev-parse', 'HEAD'); };
  commit('c1'); g(work, 'push', 'origin', 'main');
  const branchWith = (b, n) => { g(work, 'checkout', '-b', b, 'main'); const sha = commit(n); g(work, 'push', 'origin', b); g(work, 'checkout', 'main'); return sha; };
  // a run that registered one tree whose folder is already gone (closed)
  registerWorktree(work, 'r1', { path: join(base, 'wt-gone'), branch: BR, role: 'writer' });
  return { base, remote, work, commit, branchWith };
}
const gh = list => args => { assert.equal(args[0], 'pr'); return typeof list === 'function' ? list(args) : list; };
const codes = rec => rec.blockers.map(b => b.code);

test('repoSlug and taskBranches', () => {
  assert.equal(repoSlug('https://github.com/Cumulus-Service-GmbH/agent-harness-erpure.git'), 'Cumulus-Service-GmbH/agent-harness-erpure');
  assert.equal(repoSlug('git@github.com:a/b.git'), 'a/b');
  assert.equal(repoSlug('https://x-access-token:abc@github.com/a/b'), 'a/b');
  assert.equal(repoSlug('https://gitlab.com/a/b'), null);
  assert.deepEqual(taskBranches({ worktrees: [{ branch: 'bambooed/x' }, { branch: '-bad' }, { branch: null }] }, 'x'), ['bambooed/x']);
  assert.deepEqual(taskBranches({ worktrees: [] }, 'x'), []);
});

test('a run with no task branch is clean by definition', () => {
  const t = mk(); const empty = join(t.base, 'w2'); mkdirSync(empty);
  setGate(t.work, 'r0', { gate: 'base', status: 'passed', task: 'analysis only' });
  const rec = checkCleanState(t.work, 'r0', { slug: 'o/r', ghJson: gh([]) });
  assert.equal(rec.ok, true); assert.equal(rec.verdict, 'no-code');
  assert.equal(cleanStateReason(t.work, 'r0'), null);
});

test('pushed branch with no pull request is a blocker the Architect fixes', () => {
  const t = mk(); t.branchWith(BR, 'work1');
  const rec = checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh([]) });
  assert.equal(rec.ok, false); assert.deepEqual(codes(rec), ['NO_PR']);
  assert.throws(() => buildCard(rec), /NOTHING_FOR_THE_USER/);
});

test('open PR on the pushed tip: clean, reported as waiting for the approval card', () => {
  const t = mk(); const tip = t.branchWith(BR, 'work1');
  const rec = checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh([{ number: 7, state: 'OPEN', headRefOid: tip, url: 'https://github.com/o/r/pull/7', isDraft: false }]) });
  assert.equal(rec.ok, true, JSON.stringify(rec.blockers)); assert.equal(rec.verdict, 'clean-awaiting-approval');
  assert.deepEqual(rec.awaitingApproval.map(a => a.number), [7]); assert.equal(rec.branches[0].state, 'awaiting-approval');
});

test('open PR whose head is not the pushed tip is stale', () => {
  const t = mk(); t.branchWith(BR, 'work1');
  const rec = checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh([{ number: 7, state: 'OPEN', headRefOid: 'a'.repeat(40), url: 'u', isDraft: false }]) });
  assert.deepEqual(codes(rec), ['PR_HEAD_STALE']);
});

test('commits only in the local branch are unpushed', () => {
  const t = mk(); const tip = t.branchWith(BR, 'work1');
  g(t.work, 'checkout', BR); writeFileSync(join(t.work, 'more'), 'more'); g(t.work, 'add', '-A'); g(t.work, 'commit', '-m', 'more'); g(t.work, 'checkout', 'main');
  const rec = checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh([{ number: 7, state: 'OPEN', headRefOid: tip, url: 'u', isDraft: false }]) });
  assert.ok(codes(rec).includes('UNPUSHED'));
  // a branch that only exists locally
  const t2 = mk(); g(t2.work, 'checkout', '-b', BR); t2.commit('lonely'); g(t2.work, 'checkout', 'main');
  assert.ok(codes(checkCleanState(t2.work, 'r1', { slug: 'o/r', ghJson: gh([]) })).includes('UNPUSHED'));
});

test('merged PR: clean only when its merge commit is on the live default branch', () => {
  const t = mk(); const tip = t.branchWith(BR, 'work1');
  g(t.work, 'merge', '--no-ff', '-m', 'merge pr', BR); const merge = g(t.work, 'rev-parse', 'HEAD');
  const pr = { number: 8, state: 'MERGED', headRefOid: tip, mergeCommit: { oid: merge }, url: 'u', isDraft: false };
  const notYet = checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh([pr]) });
  assert.deepEqual(codes(notYet), ['MERGED_NOT_ON_DEFAULT'], 'merged locally only: the live remote default does not have it');
  g(t.work, 'push', 'origin', 'main');
  const rec = checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh([pr]) });
  assert.equal(rec.ok, true, JSON.stringify(rec.blockers)); assert.equal(rec.verdict, 'clean'); assert.equal(rec.branches[0].state, 'in-default', 'a merge commit makes every branch commit part of the default branch');
});

test('closed-unmerged PR and parked snapshot refs need the user; cards resolve them; acceptance survives a re-check', () => {
  const t = mk(); const tip = t.branchWith(BR, 'work1');
  g(t.work, 'push', 'origin', `${tip}:refs/heads/trio/wip-${BR}-20261025-abc1234`);
  const closed = [{ number: 9, state: 'CLOSED', headRefOid: tip, url: 'u', isDraft: false }];
  let rec = recordCleanState(t.work, 'r1', checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh(closed) }));
  assert.deepEqual(codes(rec).sort(), ['PR_CLOSED_UNMERGED', 'WIP_SNAPSHOT']);
  const card = buildCard(rec); validateCard(card); assert.equal(card.questions[0].recommended, 'a');
  // fold-in does not accept anything
  let asked = askCard(t.work, 'r1', card);
  answerCard(t.work, 'r1', asked.id, { cleanstate: 'a' }, { via: 'card', quote: 'Fold it into the pull request' });
  assert.equal(resolveCleanState(t.work, 'r1', asked.id).choice, 'fold-in');
  assert.equal(readRecord(t.work, 'r1').ok, false);
  // user keeps it
  const t2 = t; const asked2 = askCard(t2.work, 'r1', card);
  answerCard(t2.work, 'r1', asked2.id, { cleanstate: 'b' }, { via: 'card', quote: 'Keep it as it is' });
  const out = resolveCleanState(t2.work, 'r1', asked2.id);
  assert.equal(out.ok, true); assert.equal(out.accepted, 2);
  rec = recordCleanState(t.work, 'r1', checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh(closed) }));
  assert.equal(rec.ok, true, 'the accepted blockers stay accepted on a re-check'); assert.equal(rec.accepted.length, 2);
  // a NEW problem is not covered by an old acceptance
  g(t.work, 'checkout', BR); writeFileSync(join(t.work, 'late'), 'late'); g(t.work, 'add', '-A'); g(t.work, 'commit', '-m', 'late'); g(t.work, 'checkout', 'main');
  assert.ok(codes(checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh(closed) })).includes('UNPUSHED'));
});

test('a registered worktree that still exists blocks; dirty main checkout only warns', () => {
  const t = mk(); const tip = t.branchWith(BR, 'work1');
  const wt = join(t.base, 'wt-open'); mkdirSync(wt);
  registerWorktree(t.work, 'r1', { path: wt, branch: BR, role: 'slice' });
  writeFileSync(join(t.work, 'scratch'), 'users own work');
  const rec = checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh([{ number: 7, state: 'OPEN', headRefOid: tip, url: 'u', isDraft: false }]) });
  assert.deepEqual(codes(rec), ['TREE_OPEN']);
  assert.ok(rec.warnings.some(w => w.code === 'MAIN_CHECKOUT_DIRTY'));
});

test('gh failure is a blocker, never a silent pass', () => {
  const t = mk(); t.branchWith(BR, 'work1');
  const rec = checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: () => { throw new Error('offline'); } });
  assert.deepEqual(codes(rec), ['PR_STATE_UNKNOWN']);
});

test('run-state: learnings and finish are refused until the clean end state is recorded and fresh', () => {
  const t = mk(); const tip = t.branchWith(BR, 'work1');
  const closed = { closed: 1, open: 0, details: [{ path: join(t.base, 'wt-gone'), branch: BR, head: tip, status: 'closed' }] };
  const open = [{ number: 7, state: 'OPEN', headRefOid: tip, url: 'u', isDraft: false }];
  const emptyFindings = join(t.base, 'empty-findings.json'); writeFileSync(emptyFindings, '[]');
  for (const gt of ['shape', 'base', 'route', 'task-card', 'plan-review', 'plan-jev', 'build', 'guard-proof', 'review', 'low-fold', 'done-jev', 'commit-push']) {
    if (gt === 'plan-jev') reserveAttempt(t.work, 'r1', 'plan');
    if (gt === 'done-jev') updateFindings(t.work, 'r1', 'sync', { round: readState(t.work, 'r1').reviewRound, file: emptyFindings });
    setGate(t.work, 'r1', { gate: gt, status: 'passed', task: 't' });
    if (gt === 'review') writeFileSync(join(t.work, '.trioharness-direct/runs/r1/CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({ status: 'completed', round: readState(t.work, 'r1').reviewRound }) + '\n');
  }
  recordCloseout(t.work, 'r1', closed);
  assert.match(cleanStateReason(t.work, 'r1'), /clean-state\.mjs check/);
  assert.throws(() => setGate(t.work, 'r1', { gate: 'learnings', status: 'passed', note: 'nothing new' }), /CLEAN_STATE_NOT_REACHED/);
  recordCleanState(t.work, 'r1', checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh([]) }));
  assert.throws(() => setGate(t.work, 'r1', { gate: 'learnings', status: 'passed' }), /CLEAN_STATE_NOT_REACHED: clean end state not reached: NO_PR/);
  recordCleanState(t.work, 'r1', checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh(open) }));
  assert.equal(cleanStateReason(t.work, 'r1'), null);
  // a later closeout makes the record stale
  recordCloseout(t.work, 'r1', closed, new Date(Date.now() + 60000).toISOString());
  assert.match(cleanStateReason(t.work, 'r1'), /older than the closeout/);
  recordCleanState(t.work, 'r1', checkCleanState(t.work, 'r1', { slug: 'o/r', ghJson: gh(open), now: new Date(Date.now() + 120000).toISOString() }));
  const done = setGate(t.work, 'r1', { gate: 'learnings', status: 'passed', note: 'nothing new' });
  assert.equal(done.finished, true);
});

test('audit: stale approvals, orphan task branches, no false alarm for merged ones', () => {
  const t = mk(); t.branchWith('bambooed/orphan', 'o1'); t.branchWith('bambooed/merged', 'm1'); t.branchWith('bambooed/open', 'p1');
  g(t.work, 'fetch', 'origin');
  const now = Date.parse('2026-10-25T12:00:00Z');
  const ghj = args => {
    if (args.includes('open')) return [{ number: 3, headRefName: 'bambooed/open', updatedAt: '2026-10-20T12:00:00Z', url: 'u3', isDraft: false }];
    if (args.includes('merged')) return args[args.indexOf('--head') + 1] === 'bambooed/merged' ? [{ number: 2 }] : [];
    return [];
  };
  const r = auditRepo(t.work, { slug: 'o/r', ghJson: ghj, now });
  assert.deepEqual(r.orphanBranches.map(o => o.branch), ['bambooed/orphan']);
  assert.equal(r.waitingForApproval[0].idleDays, 5); assert.equal(r.ok, false);
});

test('before closeout the older closeout rules hold the run; the clean end state applies once the trees are closed', () => {
  const t = mk();
  assert.equal(cleanStateReason(t.work, 'r1'), null, 'no closeout recorded yet: the existing rule ("closeout has not run") already keeps the run unfinished');
  const s = setGate(t.work, 'r1', { gate: 'done-jev', status: 'passed' });
  const l = setGate(t.work, 'r1', { gate: 'learnings', status: 'passed' });
  assert.notEqual(l.finished, true); assert.match(l.notFinishedBecause, /closeout has not run/);
  recordCloseout(t.work, 'r1', { closed: 0, open: 1, details: [] });
  assert.equal(cleanStateReason(t.work, 'r1'), null, 'still open trees: closeout rules apply');
  recordCloseout(t.work, 'r1', { closed: 1, open: 0, details: [] });
  assert.match(cleanStateReason(t.work, 'r1'), /clean-state\.mjs check/);
});

// S6 preservation controls: authored against the unchanged production base.
import { USER_DECIDES } from './clean-state.mjs';
import { createHash } from 'node:crypto';
const issueRun = 's6-clean';
const issueFiles = ['issues.json', 'harness-defects.md', 'issues-failures.jsonl'];
function issueFixture({branch = false} = {}) {
  const repo = mkdtempSync(join(tmpdir(), 's6-clean-'));
  const rd = join(repo, '.trioharness-direct', 'runs', issueRun); mkdirSync(rd, {recursive:true});
  writeFileSync(join(rd,'state.json'), JSON.stringify({run:issueRun, gates:{}, history:[], worktrees:branch ? [{branch:'bambooed/s6-clean'}] : []}));
  const ledger = {version:1, repo:'o/r', issues:{A:{key:'A',number:1,url:'https://github.com/o/r/issues/1',title:'a',labels:[],observedLabels:[],status:'triaged',history:[],prs:[],mergeSha:null,deliveries:[],rollbacks:[]}},pending:[],refusals:[]};
  const put = (file, value) => writeFileSync(join(rd,file), typeof value === 'string' ? value : JSON.stringify(value));
  const digest = () => { const h=createHash('sha256'); for(const file of issueFiles) {try {h.update(readFileSync(join(rd,file)));} catch {}} return h.digest('hex'); };
  const proof = (blockers=[]) => recordCleanState(repo,issueRun,{run:issueRun,ok:!blockers.length,at:new Date().toISOString(),blockers,issuesDigest:digest()});
  return {repo,rd,ledger,put,digest,proof};
}
test('hf5b1e-s6-p-clean-01 synchronized branchless proof passes both callers', () => {
  const t=issueFixture(); t.put('issues.json',t.ledger); t.proof();
  assert.equal(cleanStateReason(t.repo,issueRun),null);
  assert.equal(setGate(t.repo,issueRun,{gate:'learnings',status:'passed',note:'nothing new'}).gates.learnings.status,'passed');
});
test('hf5b1e-s6-p-clean-02 no issue files and no branch remains no-code without a record', () => {
  const t=issueFixture(); assert.equal(checkCleanState(t.repo,issueRun).verdict,'no-code');
  assert.equal(readRecord(t.repo,issueRun),null); assert.equal(cleanStateReason(t.repo,issueRun),null);
});
test('hf5b1e-s6-p-clean-03 user choices remain exactly the original two codes', () => {
  assert.deepEqual([...USER_DECIDES],['WIP_SNAPSHOT','PR_CLOSED_UNMERGED']);
  assert.throws(()=>buildCard({blockers:[{code:'ISSUES_PENDING'},{code:'ISSUE_MISSING'}]}),/NOTHING_FOR_THE_USER/);
  assert.equal(buildCard({blockers:[{code:'ISSUES_PENDING'},{code:'WIP_SNAPSHOT',branch:'x'}]}).questions.length,1);
});

import { issueLedgerReason } from './clean-state.mjs';
const s6IssueGh = (over={}) => () => ({state:'open',labels:[{name:'status:triaged'}],...over});
const s6Check = (t, ghJson=s6IssueGh()) => checkCleanState(t.repo,issueRun,{slug:'o/r',ghJson});
function s6Refuses(t, pattern) {
  // Both run-state callers use this exact exported predicate; no run-state CLI is invoked.
  assert.match(String(cleanStateReason(t.repo,issueRun)),pattern);
  assert.throws(()=>setGate(t.repo,issueRun,{gate:'learnings',status:'passed',note:'nothing new'}),/CLEAN_STATE_NOT_REACHED/);
  const source=readFileSync(new URL('./run-state.mjs',import.meta.url),'utf8');
  assert.match(source.slice(source.indexOf("cmd === 'finish'")),/const csReason = cleanStateReason\(repo, run\)/);
}
const s6Failure = (over={}) => ({v:1,kind:'failure',ts:'2026-10-31T00:00:00.000Z',run:issueRun,event:'merged',category:'IMPORT_FAILED',...over});
test('hf5b1e-s6-d-clean-01 pending ledger operations block',()=>{
  const t=issueFixture();t.ledger.pending.push({op:'status',key:'A',args:{},error:'offline',at:'now'});t.put('issues.json',t.ledger);
  assert.match(String(issueLedgerReason(t.repo,issueRun)),/ISSUES_PENDING/);assert.ok(codes(s6Check(t)).includes('ISSUES_PENDING'));
});
test('hf5b1e-s6-d-clean-02 GitHub state or status disagreement blocks',()=>{
  for(const over of [{state:'closed'},{labels:[{name:'status:merged'}]}]) {const t=issueFixture();t.put('issues.json',t.ledger);assert.ok(codes(s6Check(t,s6IssueGh(over))).includes('ISSUES_OUT_OF_SYNC'));}
  const t=issueFixture();t.ledger.issues.A.status='deployed-qa';t.put('issues.json',t.ledger);assert.equal(s6Check(t,s6IssueGh({labels:[{name:'status:deployed-qa'}]})).ok,true);
});
test('hf5b1e-s6-d-clean-03 zero or multiple status labels block',()=>{
  for(const labels of [[],[{name:'status:triaged'},{name:'status:merged'}]]) {const t=issueFixture();t.put('issues.json',t.ledger);assert.ok(codes(s6Check(t,s6IssueGh({labels}))).includes('ISSUES_OUT_OF_SYNC'));}
});
test('hf5b1e-s6-d-clean-04 unavailable GitHub blocks as unknown',()=>{
  const t=issueFixture();t.put('issues.json',t.ledger);assert.ok(codes(s6Check(t,()=>{throw new Error('offline')})).includes('ISSUES_STATE_UNKNOWN'));
});
test('hf5b1e-s6-d-clean-05 defect heading without ledger is missing',()=>{
  const t=issueFixture();t.put('harness-defects.md','## A\n');assert.match(String(issueLedgerReason(t.repo,issueRun)),/ISSUE_MISSING/);
  t.put('harness-defects.md','## bad key\n');assert.match(String(issueLedgerReason(t.repo,issueRun)),/ISSUE_KEY_INVALID/);
});
test('hf5b1e-s6-d-clean-06 defect missing from existing ledger blocks',()=>{
  const t=issueFixture();t.put('issues.json',t.ledger);t.put('harness-defects.md','## B\n');assert.match(String(issueLedgerReason(t.repo,issueRun)),/ISSUE_MISSING/);
});
test('hf5b1e-s6-d-clean-07 corrupt and malformed ledgers are unreadable',()=>{
  for(const value of ['{',{version:2},[],{version:1,repo:'o/r',issues:[],pending:[],refusals:[]}]) {const t=issueFixture();t.put('issues.json',value);assert.match(String(issueLedgerReason(t.repo,issueRun)),/ISSUES_LEDGER_UNREADABLE/);}
});
test('hf5b1e-s6-d-clean-08 branchless defects block check and both gate callers',()=>{
  const t=issueFixture();t.put('harness-defects.md','## A\n');assert.equal(s6Check(t).ok,false);s6Refuses(t,/ISSUE_MISSING/);
});
test('hf5b1e-s6-d-clean-09 issue bytes invalidate proofs until a recheck',()=>{
  for(const file of issueFiles) {const t=issueFixture();t.put('issues.json',t.ledger);t.proof();
    if(file==='issues.json') {t.ledger.issues.A.title='changed';t.put(file,t.ledger);}
    else if(file==='harness-defects.md') t.put(file,'## A\n');
    else t.put(file,JSON.stringify(s6Failure({kind:'resolved'}))+'\n');
    assert.match(String(cleanStateReason(t.repo,issueRun)),/clean-state.json is stale: the issue ledger, defect list or failure log changed after the last check; rerun clean-state.mjs check/);
    const rec=recordCleanState(t.repo,issueRun,s6Check(t));assert.equal(rec.issuesDigest,t.digest());assert.equal(cleanStateReason(t.repo,issueRun),null);
  }
});
for(const [nn,code] of [['10','ISSUES_OUT_OF_SYNC'],['11','ISSUES_STATE_UNKNOWN']]) test(`hf5b1e-s6-d-clean-${nn} recorded ${code} refuses even with current digest`,()=>{
  const t=issueFixture();t.put('issues.json',t.ledger);t.proof([{code}]);s6Refuses(t,new RegExp(code));
});
test('hf5b1e-s6-d-clean-12 unresolved hook failure blocks branch and branchless gates',()=>{
  for(const branch of [false,true]) {const t=issueFixture({branch});const failure=s6Failure();t.put('issues-failures.jsonl',JSON.stringify(failure)+'\n');
    assert.match(String(issueLedgerReason(t.repo,issueRun)),/ISSUES_HOOK_FAILED/);s6Refuses(t,/ISSUES_HOOK_FAILED/);
    t.put('issues-failures.jsonl',JSON.stringify(failure)+'\n'+JSON.stringify({...failure,kind:'resolved'})+'\n');assert.equal(issueLedgerReason(t.repo,issueRun),null);
    t.put('issues-failures.jsonl',JSON.stringify({...failure,key:'A'})+'\n'+JSON.stringify({...failure,kind:'resolved',key:'B'})+'\n');assert.match(String(issueLedgerReason(t.repo,issueRun)),/ISSUES_HOOK_FAILED/);
  }
});
test('hf5b1e-s6-d-clean-13 issue proof precedes branch and closeout returns',()=>{
  const t=issueFixture({branch:true});t.put('issues.json',t.ledger);assert.match(String(cleanStateReason(t.repo,issueRun)),/clean-state.mjs check/);
  t.put('clean-state.json','{');assert.match(String(cleanStateReason(t.repo,issueRun)),/unreadable/);
  t.proof();t.ledger.issues.A.title='changed';t.put('issues.json',t.ledger);assert.match(String(cleanStateReason(t.repo,issueRun)),/stale/);
});
test('hf5b1e-s6-d-clean-14 failure records enforce every fixed allowlist field',()=>{
  for(const over of [{message:'detail'},{v:2},{kind:'error'},{ts:'invalid'},{run:'other'},{event:'other'},{category:'Error'},{key:'bad key'}]) {const t=issueFixture();t.put('issues-failures.jsonl',JSON.stringify(s6Failure(over))+'\n');assert.match(String(issueLedgerReason(t.repo,issueRun)),/ISSUES_HOOK_FAILED/);}
});


test('hf5b1e-s6-d-fix-08 withdrawn issues require wontfix and no status labels',()=>{
  const t=issueFixture();t.ledger.issues.A.status='withdrawn';t.put('issues.json',t.ledger);
  assert.equal(s6Check(t,s6IssueGh({state:'closed',labels:['wontfix']})).ok,true);
  for(const labels of [[],['status:withdrawn'],['wontfix','status:withdrawn'],['wontfix','status:triaged']])assert.ok(codes(s6Check(t,s6IssueGh({state:'closed',labels}))).includes('ISSUES_OUT_OF_SYNC'));
  assert.ok(codes(s6Check(t,s6IssueGh({state:'open',labels:['wontfix']}))).includes('ISSUES_OUT_OF_SYNC'));
});
