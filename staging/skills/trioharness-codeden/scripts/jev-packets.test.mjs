import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPacket, packetDigest, explain } from './jev-packets.mjs';
import { GATES, runGate, T } from './jev.mjs';

const model = 'jev-fixture-2026-11-25';
const requirements = { objective: 'Keep quantity', criteria: ['Quantity persists'] };
const plan = {
  changes: [{ file: 'quantity.mjs', change: 'Store the value', claims: [{ criterion: 0, evidence: [0] }] }],
  evidence: [{ file: 'quantity.mjs', excerpt: 'export let quantity;' }],
  proof: [
    { phase: 'red', command: 'node --test quantity.test.mjs', expected: 'Quantity persists fails' },
    { phase: 'final', command: 'node --test quantity.test.mjs', expected: 'Quantity persists passes' }
  ],
  checks: [{ check: 'Quantity persists', before: 'assert value', after: 'assert stored value', evidence: [0] }]
};
const done = {
  baseline: { base: 'a'.repeat(40), head: 'b'.repeat(40), diff: '+store(quantity)' },
  runs: [
    { phase: 'red', command: 'node --test quantity.test.mjs', exit: 1, output: 'FAIL Quantity persists', criteria: [0] },
    { phase: 'final', command: 'node --test quantity.test.mjs', exit: 0, output: 'PASS Quantity persists', criteria: [0] }
  ]
};
const planPacket = (source = plan) => buildPacket('plan', requirements, source, model);
const donePacket = (source = done) => buildPacket('done', requirements, source, model);
const scores = values => Object.fromEntries(Object.entries(values).map(([id, noul]) => [id, { type: 'noul', noul }]));

test('r1 takes requirements from the frozen source and isolates each claim', () => {
  const packet = planPacket({ ...plan, objective: 'Replace scope', criteria: ['Override'] });
  const { state } = GATES.plan.build(packet);
  assert.deepEqual(state.criteria, requirements.criteria);
  assert.equal(state.objective, requirements.objective);
  assert.deepEqual(state.changes[0].claims[0].evidence, plan.evidence);
  assert.throws(() => planPacket({ ...plan, evidence: [{ ...plan.evidence[0], file: 'other.mjs' }] }), /changes\[0\].*quantity.mjs/);
});

test('r3 evaluates each current check and keeps the coverage threshold', () => {
  const packet = planPacket({ ...plan, checks: [...plan.checks, { ...plan.checks[0], check: 'Restore quantity' }] });
  const { questions } = GATES.plan.build(packet);
  assert.equal(questions.weakens, undefined);
  assert.match(questions.coverage_1.instructions, /checks\[1\]/);
  const answers = scores({ scope_0: .8, grounded_0: .7, claim_0_0: .7, proof: .7, coverage_0: .2, coverage_1: .21 });
  assert.match(GATES.plan.decide(answers, packet).reasons[0], /Restore quantity/);
  answers.coverage_1.noul = T.weakensMax;
  assert.equal(GATES.plan.decide(answers, packet).pass, true);
});

test('r4 and RED scoring keep expected regression output and reject a failed final run', () => {
  const packet = donePacket();
  const { state, questions } = GATES.done.build(packet);
  assert.deepEqual(state.baseline, done.baseline);
  assert.equal(state.runs[0].output, 'FAIL Quantity persists');
  assert.match(questions.failing.instructions, /expected RED/);
  assert.throws(() => donePacket({ ...done, runs: done.runs.map(run => ({ ...run, exit: 1 })) }), /runs\[1\]/);
  assert.throws(() => donePacket({ ...done, baseline: { ...done.baseline, head: done.baseline.base } }), /baseline/);
});

test('builder IndexError refuses a new packet instead of returning an earlier one', () => {
  const previous = planPacket();
  const next = structuredClone(plan);
  next.changes[0].claims[0].evidence = [99];
  assert.throws(() => planPacket(next), /changes\[0\].*evidence\[99\]/);
  assert.notEqual(packetDigest(previous), packetDigest(planPacket({ ...plan, proof: [...plan.proof, plan.proof[1]] })));
});

test('r5 replays corpus scores, explains decisions and refuses model drift', async () => {
  const { default: corpus } = await import('./jev-replay.json', { with: { type: 'json' } });
  const packet = donePacket();
  for (const entry of corpus) {
    const judgement = await explain('done', packet, scores(entry.scores), model);
    assert.equal(judgement.verdict, entry.verdict);
    assert.equal(judgement.model, model);
    assert.match(judgement.rubric, /^codeden-jev\//);
  }
  const result = { model: model + '-different', answers: scores(corpus[0].scores) };
  await assert.rejects(runGate('done', packet, {
    key: 'fixture', fetchImpl: async () => ({ ok: true, json: async () => result })
  }), /JEV_MODEL_MISMATCH/);
});

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { blockingJevFindings, jevClosure, itemUsage, parseRuling, sha } from './arbiter.mjs';
import { inputDigest, loadPacketSource } from './jev.mjs';

test('Jev arbitration keeps supported MEDIUMs and folds missing context and out-of-scope LOWs', () => {
  const report = [
    'FINDINGS:',
    '- ID: R1 | SEVERITY: MEDIUM | FILE: quantity.mjs:1 | PROBLEM: context missing: test output',
    '- ID: R2 | SEVERITY: MEDIUM | FILE: quantity.mjs:2 | PROBLEM: lost quantity | FAILURE_SCENARIO: reload resets to zero | REPRO: reload the view',
    'OUT_OF_SCOPE_RISKS:',
    '- ID: R3 | SEVERITY: LOW | FILE: other.mjs:1 | PROBLEM: stale comment',
    'SUMMARY: high=0 medium=2 low=1'
  ].join('\n');
  assert.deepEqual(blockingJevFindings(report, {}).map(f => f.id), ['R2']);
});

test('Jev verdict and waiver fields cannot enter the gate as input', () => {
  for (const key of ['override', 'exception', 'waiver', 'pass', 'verdict']) {
    assert.throws(() => loadPacketSource('plan', { ...plan, [key]: true }), /JEV_OVERRIDE_INPUT/);
  }
});

test('735cd9fa: exact Arbiter APPROVE closes the plan before a full round ceiling', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-final-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workers = join(dir, 'workers');
  mkdirSync(workers);
  const head = 'a'.repeat(40);
  const pin = { provider: 'agy', model: 'gemini-fixture-v1', effort: 'high' };
  const team = { roles: { arbiter: pin }, vendors: { agy: 'Google', codex: 'OpenAI' },
    arbiterLimits: { reviewFixRounds: 2, jevReviewRounds: 1, jevAttempts: 3, callsPerItem: 1, totalRounds: 1, dailyBudgetUsd: null } };
  const packet = planPacket();
  const subject = join(dir, 'subject.json');
  const subjectBytes = JSON.stringify(packet);
  writeFileSync(subject, subjectBytes);
  const output = join(workers, 'arbiter.md');
  const report = 'ARBITER_DECISION: APPROVE\nRULINGS:\n- ID: j1 | RULING: INVALID | REASON: The owner explicitly requested this file.';
  writeFileSync(output, report);
  const row = { id: 'fc20d11e-16d1-4152-8041-92ac6295eaa3', scope: 'plan', head, run: basename(dir),
    arbiter: pin, participants: { writer: 'codex' }, mode: 'ruling', packetSha256: sha('fixture'),
    completedAt: '2026-11-25T11:16:00Z', subject: { path: subject, sha256: sha(subjectBytes) } };
  const ledger = join(dir, 'ESCALATION.jsonl');
  const append = entry => appendFileSync(ledger, JSON.stringify(entry) + '\n');
  append({ ...row, kind: 'arbiter-start', status: 'dispatched' });
  append({ ...row, kind: 'arbiter', status: 'completed', output, outputSha256: sha(report),
    ...parseRuling(report, [{ id: 'j1', finding: 'wrong scope' }]) });
  const log = join(dir, 'jev-receipts.jsonl');
  const refused = at => JSON.stringify({ gate: 'plan', verdict: 'revise', pass: false, at });
  writeFileSync(log, [refused('2026-11-25T11:15:00Z'), refused('2026-11-25T11:16:44Z')].join('\n') + '\n');
  const digest = other => inputDigest('plan', other ?? packet);
  assert.ok(itemUsage(dir, log).total >= team.arbiterLimits.totalRounds);
  assert.equal(jevClosure(team, dir, 'plan', head, digest, log).rulingId, row.id);
  assert.equal(jevClosure(team, dir, 'plan', 'b'.repeat(40), digest, log), null);
  const altered = planPacket({ ...plan, changes: plan.changes.map(c => ({ ...c, change: 'Change beyond the ruling' })) });
  assert.throws(() => jevClosure(team, dir, 'plan', head, other => inputDigest('plan', other ?? altered), log), /ARBITER_PLAN_UNBOUND/);
  writeFileSync(subject, '{}');
  assert.throws(() => jevClosure(team, dir, 'plan', head, digest, log), /ARBITER_PLAN_CHANGED/);
});

test('builder IndexError and stale source fail the CLI before dispatch with an earlier valid packet present', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'plan.json');
  const owner = join(dir, 'owner.json');
  const old = join(dir, 'old-packet.json');
  const log = join(dir, 'jev.jsonl');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const ownerBytes = JSON.stringify({ ...requirements, model });
  writeFileSync(owner, ownerBytes);
  writeFileSync(old, JSON.stringify(planPacket()));
  const marker = join(dir, 'fetch-called');
  const preload = "import { writeFileSync } from 'node:fs'; globalThis.fetch = () => { writeFileSync(" + JSON.stringify(marker) + ", ''); throw Error('UNEXPECTED_FETCH'); };";
  const run = digest => spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload),
    fileURLToPath(new URL('./jev.mjs', import.meta.url)), 'plan', path, '--log', log,
    '--requirements', owner, '--requirements-sha256', hash(ownerBytes), '--source-sha256', digest], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir, TEAM_FILE: '',
      TRIOHARNESS_TEAM_HOME: dir, JEV_KEY_FILE: join(dir, 'absent') }
  });
  const invalid = structuredClone(plan);
  invalid.changes[0].claims[0].evidence = [99];
  const bytes = JSON.stringify(invalid);
  writeFileSync(path, bytes);
  const bad = run(hash(bytes));
  assert.equal(bad.status, 3, bad.stderr);
  assert.match(bad.stderr, /changes\[0\].*evidence\[99\]/);
  const stale = run(hash(JSON.stringify(plan)));
  assert.equal(stale.status, 3, stale.stderr);
  assert.match(stale.stderr, /JEV_SOURCE_CHANGED/);
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(old, 'utf8'), JSON.stringify(planPacket()));
});
