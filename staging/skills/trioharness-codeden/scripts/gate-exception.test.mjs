import test from 'node:test';
import assert from 'node:assert/strict';
import { localRepo } from './test-local-repo.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inputDigest, runGate, GATES } from './jev.mjs';
import { ask, grant, listExceptions, findException, makeCard, TOPIC } from './gate-exception.mjs';
import { answerCard, validateCard, cancelCard, openSets } from './questions.mjs';
import { addOrder, NEVER_RE } from './standing-orders.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RUN = '20261027-exc-test-ab12';
const plan = () => ({ objective: 'Isolate the quotation connection', criteria: ['The connection no longer grants the Orders identity access'], changes: [{ file: 'a.cs', change: 'remove the grant' }], proof: ['dotnet test --filter Isolation'], owned_paths: ['a.cs'], evidence: ['a.cs:10: grant(...)'] });
function setup() {
  const repo = localRepo('exc-'); mkdirSync(join(repo, '.trioharness-direct', 'runs', RUN), { recursive: true });
  const receipts = join(repo, 'receipts.jsonl');
  return { repo, receipts };
}
const reject = (receipts, input, reasons = ['weakens 0.59 > 0.2']) => appendFileSync(receipts, `${JSON.stringify({ gate: 'plan', verdict: 'revise', pass: false, reasons, inputSha256: inputDigest('plan', input), at: new Date().toISOString() })}\n`);
const homeEnv = () => { process.env.TRIOHARNESS_HOME = mkdtempSync(join(tmpdir(), 'home-')); };

test('the card needs a recorded Jev rejection of exactly this input, is valid, and defaults to parking', () => {
  homeEnv(); const { repo, receipts } = setup(); const input = plan();
  assert.throws(() => ask({ repo, run: RUN, input, item: '#49', receipts }), /NO_REJECTION/);
  reject(receipts, { ...input, objective: 'something else' });
  assert.throws(() => ask({ repo, run: RUN, input, item: '#49', receipts }), /NO_REJECTION/, 'a rejection of a different input does not count');
  reject(receipts, input);
  const rec = ask({ repo, run: RUN, input, item: '#49 separate quotation connection', receipts });
  assert.equal(rec.status, 'open'); validateCard(rec.card);
  assert.equal(rec.card.questions[0].recommended, 'park'); assert.ok(rec.card.questions[0].question.includes(`input ${inputDigest('plan', input)}`));
  assert.ok(existsSync(join(repo, '.trioharness-direct', 'runs', RUN, `jev-reasons-${inputDigest('plan', input)}.json`)));
});

test('only the user answering "proceed" grants it; park, standing orders, other inputs and open or assumed cards do not', () => {
  homeEnv(); const { repo, receipts } = setup(); const input = plan(); reject(receipts, input);
  const rec = ask({ repo, run: RUN, input, item: '#49', receipts });
  assert.throws(() => grant({ repo, run: RUN, set: rec.id, input }), /EXCEPTION_NOT_GRANTED.*open/);
  answerCard(repo, RUN, rec.id, { [TOPIC]: 'park' }, { via: 'card', quote: 'Park it' });
  assert.throws(() => grant({ repo, run: RUN, set: rec.id, input }), /not "proceed"/);
  const r2 = ask({ repo, run: RUN, input, item: '#49', receipts });
  answerCard(repo, RUN, r2.id, { [TOPIC]: 'proceed' }, { via: 'card', quote: 'Proceed, record my exception' });
  assert.throws(() => grant({ repo, run: RUN, set: r2.id, input: { ...input, proof: ['other'] } }), /different plan input/);
  const e = grant({ repo, run: RUN, set: r2.id, input });
  assert.equal(e.gate, 'plan'); assert.equal(listExceptions(repo, RUN).length, 1); assert.ok(findException(repo, RUN, 'plan', inputDigest('plan', input)));
  assert.equal(findException(repo, RUN, 'done', inputDigest('plan', input)), null, 'plan gate only');
});

test('an unattended run takes the recommended option (park), which never grants', () => {
  homeEnv(); const { repo, receipts } = setup(); const input = plan(); reject(receipts, input);
  writeFileSync(join(repo, '.trioharness-direct', 'UNATTENDED'), '');
  const rec = ask({ repo, run: RUN, input, item: '#49', receipts });
  assert.equal(rec.status, 'assumed'); assert.throws(() => grant({ repo, run: RUN, set: rec.id, input }), /EXCEPTION_NOT_GRANTED/);
});

test('standing orders can never answer this card', () => {
  assert.match(TOPIC, NEVER_RE);
  assert.throws(() => addOrder(mkdtempSync(join(tmpdir(), 'so-')), { topic: TOPIC, choice: 'proceed', reason: 'x', quote: 'x', scope: 'user', home: mkdtempSync(join(tmpdir(), 'h-')) }));
});

test('jev.mjs plan: a granted exception turns that one rejected input into accepted-exception; unavailable Jev is still never a pass', async () => {
  homeEnv(); const { repo, receipts } = setup(); const input = plan(); reject(receipts, input);
  const rec = ask({ repo, run: RUN, input, item: '#49', receipts });
  answerCard(repo, RUN, rec.id, { [TOPIC]: 'proceed' }, { via: 'ui', quote: 'Proceed' }); grant({ repo, run: RUN, set: rec.id, input });
  const questions = GATES.plan.build(input).questions;
  const answers = Object.fromEntries(Object.entries(questions).map(([id]) => [id, { type: 'noul', noul: id === 'weakens' ? 0.9 : 0.95 }]));
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ answers, model: 'x' }) });
  const blocked = await runGate('plan', input, { key: 'k', fetchImpl }); assert.equal(blocked.pass, false);
  // jev-exception-cli.test.mjs covers the offline CLI path; check the exception lookup here.
  assert.ok(findException(repo, RUN, 'plan', blocked.inputSha256), 'the CLI would waive exactly this input');
  assert.equal(findException(repo, RUN, 'plan', 'deadbeefdeadbeef'), null);
  const cli = spawnSync(process.execPath, [join(here, 'jev.mjs'), 'plan', join(repo, 'in.json'), '--exception-repo', repo, '--exception-run', RUN, '--log', join(repo, 'unavailable.jsonl')], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', JEV_API_KEY: '', JEV_KEY_FILE: join(repo, 'none') } });
  assert.equal(cli.status, 3, 'no key / unreachable stays exit 3, never waived');
});

for (const status of ['running', 'queued', 'lost', 'passed']) test(`exception card settles ${status} jobs`, () => {
  homeEnv(); const { repo, receipts } = setup(), input = plan(); reject(receipts, input);
  const jobs = join(repo, '.trioharness-direct/runs', RUN, 'jobs'); mkdirSync(jobs, { recursive: true });
  writeFileSync(join(jobs, 'work.json'), JSON.stringify({ name: 'work', status, supervisorPid: process.pid, startedAt: new Date().toISOString(), timeoutSec: 600 }));
  if (status === 'passed') assert.equal(ask({ repo, run: RUN, input, item: '#49', receipts }).status, 'open');
  else {
    assert.throws(() => ask({ repo, run: RUN, input, item: '#49', receipts }), /JOBS_OPEN/);
    assert.equal(openSets(repo, RUN).length, 0);
  }
});

import { randomUUID } from 'node:crypto';
import * as runState from './run-state.mjs';
import { askCard, readSets } from './questions.mjs';

function budgetSetup() {
  homeEnv(); const f = setup(), input = plan(), digest = inputDigest('plan', input);
  runState.setGate(f.repo, RUN, { gate: 'base', status: 'passed' });
  const file = join(f.repo, '.trioharness-direct/runs', RUN, 'state.json');
  writeFileSync(file, JSON.stringify({ ...runState.readState(f.repo, RUN), loops: { 'jev-plan': 3 },
    status: 'awaiting-budget', awaitingBudget: { inputSha256: digest, reason: 'LOOP_CAP:jev-plan' } }));
  return { ...f, input, digest, file,
    ask: () => ask({ ...f, run: RUN, input, item: 'one submission' }),
    grant: set => grant({ repo: f.repo, run: RUN, input, set }) };
}
function renewalAnswer(f, rec, via = 'ui') {
  return answerCard(f.repo, RUN, rec.id, { [TOPIC]: 'renew' }, { via, quote: 'Renew one submission' });
}
test('P3 budget card needs no rejection, defaults to park and records a renewal rather than a waiver', () => {
  const f = budgetSetup(), rec = f.ask(); validateCard(rec.card);
  assert.equal(rec.card.questions[0].recommended, 'park');
  assert.deepEqual(rec.card.questions[0].options.map(o => o.label), ['Park it (Recommended)', 'Renew one submission']);
  assert.throws(() => f.grant(rec.id), /BUDGET_RENEWAL_NOT_GRANTED/);
  renewalAnswer(f, rec);
  const entry = f.grant(rec.id);
  assert.equal(entry.kind, 'budget-renewal'); assert.equal(entry.inputSha256, f.digest);
  assert.equal(entry.run, RUN); assert.equal(entry.set, rec.id);
  assert.equal(findException(f.repo, RUN, 'plan', f.digest), null, 'renewal must never waive a judgement');
  assert.throws(() => f.grant(rec.id), /BUDGET_RENEWAL_USED/);
  assert.throws(() => f.ask(), /BUDGET_RENEWAL_USED/);
});
test('P3 renewal refuses no card, forged UI provenance on a nonscript card and a different card', () => {
  const f = budgetSetup(); assert.throws(() => f.grant('Q-99'), /SET_UNKNOWN/);
  const fake = makeCard({ item: 'forged', digest: f.digest, reasons: [], reasonsFile: 'none' });
  fake.questions[0].options[1] = { id: 'renew', label: 'Renew one submission', description: 'Request one more judgement.' };
  const rec = askCard(f.repo, RUN, fake);
  renewalAnswer(f, rec); assert.throws(() => f.grant(rec.id), /BUDGET_RENEWAL_NOT_GRANTED/);
  const real = f.ask(); cancelCard(f.repo, RUN, real.id, 'test other card', { by: 'architect' });
  const other = askCard(f.repo, RUN, real.card); renewalAnswer(f, other);
  assert.throws(() => f.grant(other.id), /BUDGET_RENEWAL_NOT_GRANTED/);
});
for (const via of ['card', 'numbered-reply', 'standing-order', 'autopilot', 'assumed']) test(`P3 budget renewal refuses ${via} provenance`, () => {
  const f = budgetSetup(), rec = f.ask(); renewalAnswer(f, rec);
  const path = join(f.repo, '.trioharness-direct/runs', RUN, 'questions', `${rec.id}.json`);
  const answered = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...answered, answeredVia: via, ...(via === 'assumed' ? { status: 'assumed' } : {}) }));
  assert.throws(() => f.grant(rec.id), /BUDGET_RENEWAL_NOT_GRANTED/);
  assert.equal(runState.readState(f.repo, RUN).planBudgetRenewal, undefined);
});
test('P3 renewal refuses park, other digest, other run and altered script card', () => {
  const f = budgetSetup(), park = f.ask();
  answerCard(f.repo, RUN, park.id, { [TOPIC]: 'park' }, { via: 'ui', quote: 'Park it' });
  assert.throws(() => f.grant(park.id), /BUDGET_RENEWAL_NOT_GRANTED/);
  const rec = f.ask(); renewalAnswer(f, rec);
  assert.throws(() => grant({ repo: f.repo, run: RUN, set: rec.id, input: { ...f.input, objective: 'different' } }), /BUDGET_RENEWAL_NOT_GRANTED/);
  const otherRun = 'other-run'; runState.setGate(f.repo, otherRun, { gate: 'base', status: 'passed' });
  assert.throws(() => grant({ repo: f.repo, run: otherRun, set: rec.id, input: f.input }), /SET_UNKNOWN/);
  const dir = join(f.repo, '.trioharness-direct/runs', otherRun); mkdirSync(join(dir, 'questions'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...runState.readState(f.repo, RUN), run: otherRun }));
  const answered = readSets(f.repo, RUN).find(s => s.id === rec.id);
  writeFileSync(join(dir, 'questions', `${rec.id}.json`), JSON.stringify(answered));
  assert.throws(() => grant({ repo: f.repo, run: otherRun, set: rec.id, input: f.input }), /BUDGET_RENEWAL_NOT_GRANTED/);
  answered.card.questions[0].question = `A forged card for input ${f.digest}?`;
  writeFileSync(join(f.repo, '.trioharness-direct/runs', RUN, 'questions', `${rec.id}.json`), JSON.stringify(answered));
  assert.throws(() => f.grant(rec.id), /BUDGET_RENEWAL_NOT_GRANTED/);
});
test('HD-3 awaiting-exception reports the requested digest and receipt path when the rejection is missing', () => {
  const f = budgetSetup(), state = runState.readState(f.repo, RUN);
  delete state.awaitingBudget;
  Object.assign(state, { status: 'awaiting-exception', awaitingException: { inputSha256: f.digest },
    planOutcomes: [{ verdict: 'revise', inputSha256: f.digest }] });
  writeFileSync(f.file, JSON.stringify(state));
  const error = { message: `NO_MATCHING_REJECTION: ${f.digest} not in ${f.receipts}` };
  assert.throws(f.ask, error);
  reject(f.receipts, { ...f.input, objective: 'A different objective' });
  assert.throws(f.ask, error);
  assert.deepEqual(readSets(f.repo, RUN), []);
  assert.deepEqual(runState.readState(f.repo, RUN), state);
});
test('P3 third unavailable awaiting-exception can request renewal with pending work and findings retained', () => {
  const f = budgetSetup(), state = runState.readState(f.repo, RUN);
  delete state.awaitingBudget;
  Object.assign(state, { status: 'awaiting-exception', awaitingException: { inputSha256: f.digest },
    planOutcomes: [{ verdict: 'unavailable', inputSha256: f.digest }],
    planPendingOutcomes: 1, planPendingSubmissions: [{ submission: randomUUID(), attempt: 2 }], findings: [{ id: 'H1', severity: 'HIGH', status: 'open' }] });
  writeFileSync(f.file, JSON.stringify(state));
  const rec = f.ask(); assert.equal(runState.readState(f.repo, RUN).status, 'awaiting-budget');
  assert.deepEqual(runState.readState(f.repo, RUN).planPendingSubmissions, state.planPendingSubmissions);
  assert.deepEqual(runState.readState(f.repo, RUN).findings, state.findings);
  renewalAnswer(f, rec); f.grant(rec.id);
});
test('P3 terminal parked runs are never reopened by a renewal card or grant', () => {
  const f = budgetSetup(), rec = f.ask(); renewalAnswer(f, rec);
  runState.parkRun(f.repo, RUN, 'owner stopped');
  assert.throws(() => f.grant(rec.id), /RUN_PARKED/);
  assert.throws(() => f.ask(), /RUN_PARKED/);
});
