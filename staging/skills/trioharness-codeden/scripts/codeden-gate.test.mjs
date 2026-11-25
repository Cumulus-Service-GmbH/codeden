import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadTeamChecked, reviewChain } from './team.mjs';
import { arbiterPin, parseRuling, verifiedFindings } from './arbiter.mjs';
import { JEV_RECEIPT_REQUIRED } from '../../../../.config/trioharness/jev-receipt-policy.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { record, check } from './codeden-gate.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'cdgate-'));
  g(d, 'init', '-q', '-b', 'main'); g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't');
  writeFileSync(join(d, '.gitignore'), '.trioharness-direct/\n');
  writeFileSync(join(d, 'a.js'), '1\n'); g(d, 'add', '.'); g(d, 'commit', '-qm', 'base');
  g(d, 'checkout', '-qb', 'codeden/x'); writeFileSync(join(d, 'a.js'), '2\n'); g(d, 'commit', '-qam', 'fix');
  return d;
}
function run(d, { gates = { 'guard-proof': 'passed', 'done-jev': 'passed' }, verdict = 'proceed' } = {}) {
  const dir = join(d, '.trioharness-direct', 'runs', 'r1'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ run: 'r1', gates: Object.fromEntries(Object.entries(gates).map(([k, s]) => [k, { status: s }])) }));
  const team = loadTeamChecked({ real: true, repo: d });
  writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({
    schema: 2, kind: 'team-review', status: 'completed', slot: 'native-factory',
    reviewer: { provider: 'codeden', model: team.factory.recordAs, effort: null },
  }) + '\n');
  appendFileSync(join(dir, 'jev-receipts.jsonl'), `${JSON.stringify({ gate: 'done', verdict, pass: verdict === 'proceed', jev: { model: 'm' }, inputSha256: 'abc', at: 'now' })}\n`);
}
test('record refuses a done receipt without a Jev answer', () => {
  const d = repo(); run(d); const f = join(d, '.trioharness-direct', 'runs', 'r1', 'jev-receipts.jsonl');
  appendFileSync(f, `${JSON.stringify({ gate: 'done', verdict: 'proceed', pass: true, jev: null, inputSha256: 'z' })}\n`);
  if (JEV_RECEIPT_REQUIRED) assert.throws(() => record(d, 'r1'), /DONE_NOT_JUDGED/);
  else assert.equal(record(d, 'r1').head, g(d, 'rev-parse', 'HEAD'));
});

test('passes for a recorded proceed on HEAD', () => { const d = repo(); run(d); record(d, 'r1'); assert.equal(check(d, 'main').pass, true); });
test('refuses without any run', () => { const d = repo(); const r = check(d, 'main'); assert.equal(r.pass, false); assert.match(r.problems[0], /NO_GATE_RECORD/); });
test('record refuses a non-proceed done', () => { const d = repo(); run(d, { verdict: 'revise' }); if (JEV_RECEIPT_REQUIRED) assert.throws(() => record(d, 'r1'), /DONE_NOT_PROCEED/); else assert.equal(record(d, 'r1').head, g(d, 'rev-parse', 'HEAD')); });
test('refuses new commits after done', () => {
  const d = repo(); run(d); record(d, 'r1'); writeFileSync(join(d, 'a.js'), '3\n'); g(d, 'commit', '-qam', 'more');
  const r = check(d, 'main'); assert.equal(r.pass, false); assert.match(r.problems.join(' '), /HEAD_MISMATCH/);
});
test('keeps the default-branch merge allowance in either receipt mode', () => {
  const d = repo(); run(d); record(d, 'r1');
  g(d, 'checkout', '-q', 'main'); writeFileSync(join(d, 'b.js'), 'x\n'); g(d, 'add', '.'); g(d, 'commit', '-qm', 'main moved');
  g(d, 'checkout', '-q', 'codeden/x'); g(d, 'merge', '-q', '--no-edit', 'main');
  assert.equal(check(d, 'main').pass, true);
});
test('refuses when guard-proof did not pass', () => { const d = repo(); run(d, { gates: { 'guard-proof': 'failed', 'done-jev': 'passed' } }); record(d, 'r1'); assert.equal(check(d, 'main').pass, false); });
function docsRepo() {
  const d = repo();
  g(d, 'checkout', '-q', 'main'); g(d, 'checkout', '-qb', 'codeden/docs');
  writeFileSync(join(d, 'README.md'), 'hi\n'); g(d, 'add', '.'); g(d, 'commit', '-qm', 'docs');
  return d;
}
test('docs-only change passes without a run', () => {
  assert.equal(check(docsRepo(), 'main').docsOnly, true);
});


function withArbiterTeam(t, home) {
  const installed = existsSync(new URL('./arbiter.mjs', import.meta.url));
  const teamDir = installed ? join(os.userInfo().homedir, '.config', 'trioharness') : null;
  const team = readFileSync(teamDir ? join(teamDir, 'team.json') : new URL('../../config/team.json', import.meta.url));
  const policy = readFileSync(teamDir ? join(teamDir, 'team-policy.json') : new URL('../../config/team-policy.json', import.meta.url));
  const config = join(home, '.config', 'trioharness');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'team.json'), team);
  writeFileSync(join(config, 'team-policy.json'), policy);
  writeFileSync(join(config, 'team-sync.mjs'), '');
  const user = os.userInfo();
  const stub = mock.method(os, 'userInfo', () => ({ ...user, homedir: home }));
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); });
}

test('docs-only check reports escalation problems from every recorded run', t => {
  const d = docsRepo();
  withArbiterTeam(t, d);
  run(d);
  const runs = join(d, '.trioharness-direct', 'runs');
  const head = g(d, 'rev-parse', 'HEAD');
  for (const id of ['r1', 'r2']) {
    const dir = join(runs, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codeden-gate.json'), JSON.stringify({ head }));
  }
  writeFileSync(join(runs, 'r1', 'ITEM_BLOCKED.json'), JSON.stringify({ reason: 'ROUNDS_CEILING' }));
  writeFileSync(join(runs, 'r2', 'ESCALATION.jsonl'), JSON.stringify({ kind: 'arbiter', scope: 'code', status: 'unavailable', reason: 'offline' }) + '\n');
  const result = check(d, 'main');
  assert.equal(result.pass, false);
  assert.deepEqual(result.problems.sort(), ['r1: ITEM_BLOCKED: ROUNDS_CEILING', 'r2: ARBITER_UNAVAILABLE: code: offline']);
});

test('Arbiter APPROVE still requires a passing Jev done receipt on docs-only candidates', t => {
  const d = docsRepo();
  withArbiterTeam(t, d);
  const dir = join(d, '.trioharness-direct', 'runs', 'r1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'codeden-gate.json'), JSON.stringify({ head: g(d, 'rev-parse', 'HEAD') }));
  const log = join(dir, 'first.jsonl');
  const esc = join(dir, 'ESCALATION.jsonl');
  const ruling = JSON.stringify({ kind: 'arbiter', scope: 'jev-done', mode: 'ruling', status: 'completed', decision: 'APPROVE', rulings: [] }) + '\n';
  const registration = JSON.stringify({ kind: 'jev-log', file: 'first.jsonl' }) + '\n';
  writeFileSync(esc, ruling + registration);
  if (JEV_RECEIPT_REQUIRED) assert.deepEqual(check(d, 'main').problems, ['r1: NO_DONE_RECEIPT']);
  else assert.equal(check(d, 'main').docsOnly, true);
  assert.equal(existsSync(log), false);
  const failure = JSON.stringify({ gate: 'done', verdict: 'revise', pass: false, jev: { model: 'm' } }) + '\n';
  writeFileSync(log, failure);
  if (JEV_RECEIPT_REQUIRED) assert.deepEqual(check(d, 'main').problems, ['r1: DONE_NOT_PROCEED: revise']);
  else assert.equal(check(d, 'main').docsOnly, true);
  assert.equal(readFileSync(log, 'utf8'), failure);
  assert.equal(readFileSync(esc, 'utf8'), ruling + registration);
  appendFileSync(log, JSON.stringify({ gate: 'done', verdict: 'proceed', pass: true, jev: { model: 'm' } }) + '\n');
  assert.equal(check(d, 'main').docsOnly, true);
});

function gateReview(d, { head = g(d, 'rev-parse', 'HEAD'), severity = null, round = 1, completedAt } = {}) {
  const dir = join(d, '.trioharness-direct', 'runs', 'r1');
  const reviewer = reviewChain(loadTeamChecked({ real: true, writer: 'codex', repo: d }), 'codex').primary;
  const verdict = severity ? 'FINDINGS' : 'CLEAN';
  const text = severity
    ? `REVIEW_DECISION: FINDINGS\nFINDINGS:\n- ID: R1 | SEVERITY: ${severity} | FILE: a.js:1 | PROBLEM: Missing validation | EVIDENCE: a.js:1 | MINIMAL FIX: Validate input\n`
    : 'REVIEW_DECISION: CLEAN\n';
  const output = join(dir, `review-${round}.md`);
  writeFileSync(output, text);
  appendFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({
    schema: 2, kind: 'team-review', status: 'completed', slot: 'primary', round,
    writer: { provider: 'codex' }, reviewer, head, verdict, output, completedAt,
    outputSha256: createHash('sha256').update(text).digest('hex'),
    evidence: { initModel: reviewer.model, runtime: { model: reviewer.model } },
  }) + '\n');
  return dir;
}

test('a guarded, exactly reviewed head can record and pass without a Jev receipt', t => {
  const d = repo();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  run(d, { gates: { 'guard-proof': 'passed' } });
  const dir = gateReview(d);
  rmSync(join(dir, 'jev-receipts.jsonl'));
  if (JEV_RECEIPT_REQUIRED) assert.throws(() => record(d, 'r1', 'main'), /NO_DONE_RECEIPT/);
  else {
    record(d, 'r1', 'main');
    assert.equal(check(d, 'main').pass, true);
  }
  assert.equal(existsSync(join(dir, 'jev-receipts.jsonl')), false);
});
for (const [name, severity, mismatch] of [
  ['clean at HEAD', null, false], ['HIGH still open', 'HIGH', false],
  ['MEDIUM still open', 'MEDIUM', false], ['clean on another head', null, true],
]) {
  test(`8 of 8 model rounds: ${name}`, t => {
    const d = repo();
    t.after(() => rmSync(d, { recursive: true, force: true }));
    run(d);
    const head = g(d, 'rev-parse', 'HEAD');
    const dir = gateReview(d, { head: mismatch ? g(d, 'rev-parse', 'main') : head, severity });
    gateReview(d, { head: mismatch ? g(d, 'rev-parse', 'main') : head, severity, round: 2 });
    writeFileSync(join(dir, 'ESCALATION.jsonl'), Array.from({ length: 5 }, (_, n) =>
      JSON.stringify({ kind: 'plan-review-start', n: n + 1 })).join('\n') + '\n');
    writeFileSync(join(dir, 'ITEM_BLOCKED.json'), JSON.stringify({
      status: 'BLOCKED', reason: 'ROUNDS_CEILING: 8 of 8 model rounds used',
    }));
    writeFileSync(join(dir, 'codeden-gate.json'), JSON.stringify({
      run: 'r1', head, tree: g(d, 'rev-parse', 'HEAD^{tree}'), inputSha256: 'abc',
    }));
    const result = check(d, 'main');
    assert.equal(result.pass, !mismatch && severity === null, result.problems?.join('\n'));
    if (mismatch || severity) assert.match(result.problems.join(' '), /ITEM_BLOCKED|REVIEW_HEAD|CODE_REVIEW_PENDING/);
    else {
      writeFileSync(join(dir, 'review-2.md'), 'REVIEW_DECISION: FINDINGS\n');
      assert.match(check(d, 'main').problems.join(' '), /ITEM_BLOCKED|CODE_REVIEW_PENDING/);
    }
  });
}

test('a final Arbiter approval on the delivered head survives a ceiling marker', t => {
  const d = repo();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  run(d);
  const head = g(d, 'rev-parse', 'HEAD');
  const dir = gateReview(d, { severity: 'HIGH' });
  const team = loadTeamChecked({ real: true, writer: 'codex', repo: d });
  const participants = { writer: 'codex', reviewers: [reviewChain(team, 'codex').primary] };
  const arbiter = arbiterPin(team, participants);
  const output = join(dir, 'arbiter-ruling.md');
  const text = 'ARBITER_DECISION: APPROVE\nRULINGS:\n- ID: 1.R1 | RULING: INVALID | REASON: The caller validates input\n';
  writeFileSync(output, text);
  const review = readFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  const ruling = {
    id: 'r1-code', kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'completed',
    participants, arbiter, decision: 'APPROVE', head, completedAt: '2026-11-24T14:00:00Z',
    output, outputSha256: createHash('sha256').update(text).digest('hex'),
    rulings: parseRuling(text, verifiedFindings(review).findings).rulings,
  };
  writeFileSync(join(dir, 'ESCALATION.jsonl'), JSON.stringify(ruling) + '\n');
  writeFileSync(join(dir, 'ITEM_BLOCKED.json'), JSON.stringify({
    status: 'BLOCKED', reason: 'ROUNDS_CEILING: 8 of 8 model rounds used',
  }));
  record(d, 'r1', 'main');
  assert.equal(check(d, 'main').pass, true);
  writeFileSync(output, `${text}unexpected line\n`);
  assert.match(check(d, 'main').problems.join(' '), /ITEM_BLOCKED/);

  const mustFix = text.replace('INVALID', 'VALID-must-fix');
  writeFileSync(output, mustFix);
  ruling.outputSha256 = createHash('sha256').update(mustFix).digest('hex');
  ruling.rulings = parseRuling(mustFix, verifiedFindings(review).findings).rulings;
  const escalation = join(dir, 'ESCALATION.jsonl');
  writeFileSync(escalation, JSON.stringify(ruling) + '\n');
  assert.match(check(d, 'main').problems.join(' '), /ARBITER_CONFIRM_MISSING/);

  writeFileSync(join(d, 'a.js'), 'export const validated = true;\n');
  g(d, 'add', 'a.js'); g(d, 'commit', '-qm', 'apply mandatory fix');
  const fixedHead = g(d, 'rev-parse', 'HEAD');
  gateReview(d, { head: fixedHead, round: 2, completedAt: '2026-11-24T14:01:00Z' });
  const confirmedReview = readFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  const { round, slot, verdict, outputSha256 } = confirmedReview;
  const confirm = {
    kind: 'review-confirm', scope: 'code', decision: 'APPROVE', rulingId: ruling.id, head: fixedHead,
    rounds: [{ round, slot, verdict, outputSha256 }], completedAt: '2026-11-24T14:02:00Z',
  };
  appendFileSync(escalation, JSON.stringify(confirm) + '\n');
  record(d, 'r1', 'main');
  assert.equal(check(d, 'main').pass, true);
  const unlinkedRuling = { ...ruling, id: undefined };
  const unlinkedConfirm = { ...confirm, rulingId: undefined };
  writeFileSync(escalation, [unlinkedRuling, unlinkedConfirm].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.match(check(d, 'main').problems.join(' '), /ITEM_BLOCKED/);

  confirm.head = head;
  writeFileSync(escalation, [ruling, confirm].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.match(check(d, 'main').problems.join(' '), /ARBITER_HEAD/);
});
