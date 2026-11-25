import test from 'node:test';
import assert from 'node:assert/strict';
import { localRepo } from './test-local-repo.mjs';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, symlinkSync, statSync, utimesSync, copyFileSync, linkSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ask as askException, grant, TOPIC } from './gate-exception.mjs';
import * as state from './run-state.mjs';
import { askCard, answerCard } from './questions.mjs';
import { inputDigest } from './jev.mjs';
import { activeRegistered, closeAll } from './closeout.mjs';
import { saveBoundary } from './boundary.mjs';
import { lockNameFor, tryAcquire, release as unlock } from './run-lock.mjs';

process.env.TRIOHARNESS_HOME = process.env.TRIOHARNESS_HOME_FOR_TESTS || '/nonexistent-trioharness-home';

const script = name => join(import.meta.dirname, name);
const card = { questions: [{ id: 'q', header: 'Scope', question: 'Which scope?', why: 'Choose scope', options: [{ id: 'a', label: 'Small', description: 'Small scope' }, { id: 'b', label: 'Large', description: 'Large scope' }], recommended: 'a' }] };
const plan = { objective: 'Return a count', criteria: ['The count is persisted'], changes: [{ file: 'a.mjs', change: 'Persist the count' }], proof: ['node --test'], owned_paths: ['a.mjs'], evidence: ['a.mjs:1: return 1;'] };
function fixture(t) {
  const repo = localRepo('thl-state-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  state.setGate(repo, 'r1', { gate: 'base', status: 'passed', task: 'count' });
  const file = join(repo, '.trioharness-direct/runs/r1/state.json');
  return { repo, file, read: () => state.readState(repo, 'r1') };
}
const cli = (name, args, opts = {}) => spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8', ...opts });
const attemptArgs = repo => ['attempt', '--repo', repo, '--run', 'r1', '--gate', 'plan'];

test('base gate refuses a declared environment without a running-ref record', t => {
  const repo = localRepo('thl-running-ref-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, '.trioharness'));
  writeFileSync(join(repo, '.trioharness', 'environments.json'), JSON.stringify({
    schema: 1, environments: { qa: { health: { url: 'https://qa.invalid/health', shaField: 'commit' } } }
  }));
  assert.throws(() => state.setGate(repo, 'r1', { gate: 'base', status: 'passed' }),
    /RUNNING_REF_UNRESOLVED: running-ref\.json is missing or not signed/);
});

test('base gate refuses a hand-written running-ref record without a signature', t => {
  const repo = localRepo('thl-running-ref-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, '.trioharness'));
  writeFileSync(join(repo, '.trioharness', 'environments.json'), JSON.stringify({
    schema: 1, environments: { qa: { health: { url: 'https://qa.invalid/health', shaField: 'commit' } } }
  }));
  const dir = join(repo, '.trioharness-direct', 'runs', 'r1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'running-ref.json'), JSON.stringify({ configured: false, envs: [] }));
  assert.throws(() => state.setGate(repo, 'r1', { gate: 'base', status: 'passed' }),
    /RUNNING_REF_UNRESOLVED: running-ref\.json is missing or not signed/);
});

test('base gate refuses a directory outside Git', t => {
  const repo = mkdtempSync(join(tmpdir(), 'thl-not-git-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.throws(() => state.setGate(repo, 'r1', { gate: 'base', status: 'passed' }),
    /RUNNING_REF_UNRESOLVED: RUNNING_REF_REMOTE_UNREADABLE/);
});

test('shape is the initial checkpoint; audit reports its absence', t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ run: 'r1', task: 'count', gates: {}, history: [] }));
  assert.equal(state.GATES[0], 'shape');
  assert.equal(state.resumePoint(null).resumeAt, 'shape');
  assert.equal(state.resumePoint(f.read()).resumeAt, 'shape');
  assert.ok(state.auditRun(f.repo, 'r1').problems.includes('gate never recorded: shape'));
  state.setGate(f.repo, 'r1', { gate: 'shape', status: 'passed' });
  assert.ok(!state.auditRun(f.repo, 'r1').problems.includes('gate never recorded: shape'));
});
test('legacy runs with later checkpoints skip missing shape for resume and audit', t => {
  const f = fixture(t);
  assert.equal(state.resumePoint(f.read()).resumeAt, 'route');
  assert.ok(!state.auditRun(f.repo, 'r1').problems.includes('gate never recorded: shape'));
  for (const gate of ['route', 'task-card', 'guard-proof', 'done-jev']) state.setGate(f.repo, 'r1', { gate, status: 'passed' });
  assert.equal(state.resumePoint(f.read()).resumeAt, 'plan-review');
  assert.equal(state.auditRun(f.repo, 'r1').ok, true);
  state.setGate(f.repo, 'r1', { gate: 'route', status: 'blocked' });
  assert.equal(state.resumePoint(f.read()).resumeAt, 'route');
  assert.ok(!state.auditRun(f.repo, 'r1').problems.includes('gate never recorded: shape'));
});
test('shape records failed and blocked states, respects cards, and does not enforce ordering', t => {
  const f = fixture(t);
  for (const status of ['failed', 'blocked']) {
    assert.equal(state.setGate(f.repo, 'r1', { gate: 'shape', status }).gates.shape.status, status);
    assert.equal(state.resumePoint(f.read()).resumeAt, 'shape');
  }
  askCard(f.repo, 'r1', card);
  for (const status of ['in_progress', 'passed']) assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'shape', status }), /QUESTIONS_OPEN/);
  assert.equal(state.setGate(f.repo, 'r1', { gate: 'shape', status: 'blocked' }).gates.shape.status, 'blocked');
});
test('explicit finish retains acceptance requirement and does not newly require shape', t => {
  const f = fixture(t);
  let r = cli('run-state.mjs', ['finish', '--repo', f.repo, '--run', 'r1']);
  assert.equal(r.status, 3); assert.match(r.stderr, /RUN_NOT_ACCEPTED/);
  auditEvidence(f);
  state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
  r = cli('run-state.mjs', ['finish', '--repo', f.repo, '--run', 'r1']);
  assert.equal(r.status, 0, r.stderr); assert.equal(f.read().finished, true);
});
test('attempt CLI increments only plan, preserves all other state, and prints an integer', t => {
  const f = fixture(t), before = f.read();
  writeFileSync(f.file, JSON.stringify({ ...before, attempts: { other: 8 } }));
  for (const n of [1, 2]) {
    const r = cli('run-state.mjs', attemptArgs(f.repo));
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, `${n}\n`);
  }
  const after = f.read();
  assert.deepEqual(after.attempts, { other: 8, plan: 2 });
  for (const key of Object.keys(before).filter(k => k !== 'updatedAt')) assert.deepEqual(after[key], before[key]);
});
test('attempt refuses invalid counters, gate, unknown run and open card without changing state', t => {
  const f = fixture(t);
  for (const bad of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER]) {
    writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: bad } }));
    const before = readFileSync(f.file, 'utf8'), r = cli('run-state.mjs', attemptArgs(f.repo));
    assert.equal(r.status, 3); assert.match(r.stderr, /ATTEMPT_INVALID/); assert.equal(readFileSync(f.file, 'utf8'), before);
  }
  deleteCounter(f);
  let r = cli('run-state.mjs', [...attemptArgs(f.repo).slice(0, -1), 'route']);
  assert.equal(r.status, 3); assert.match(r.stderr, /ATTEMPT_GATE/);
  r = cli('run-state.mjs', ['attempt', '--repo', f.repo, '--run', 'missing', '--gate', 'plan']);
  assert.equal(r.status, 3); assert.match(r.stderr, /RUN_UNKNOWN/);
  askCard(f.repo, 'r1', card);
  const before = readFileSync(f.file, 'utf8'); r = cli('run-state.mjs', attemptArgs(f.repo));
  assert.equal(r.status, 3); assert.match(r.stderr, /QUESTIONS_OPEN/); assert.equal(readFileSync(f.file, 'utf8'), before);
});
function deleteCounter(f) { const s = f.read(); delete s.attempts; writeFileSync(f.file, JSON.stringify(s)); }
test('twelve concurrent reservations admit exactly three and lose no increments', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script('run-state.mjs'), ...attemptArgs(f.repo)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
  })));
  assert.deepEqual(results.filter(r => r.code === 0).map(r => Number(r.out)).sort((a, b) => a - b), [1, 2, 3]);
  const refused = results.filter(r => r.code !== 0);
  assert.equal(refused.length, 9);
  for (const r of refused) { assert.equal(r.code, 2, r.err); assert.match(r.err, /LOOP_CAP:jev-plan|RUN_PARKED/); }
  assert.equal(f.read().attempts.plan, 3);
  assert.equal(f.read().loops['jev-plan'], 3);
  assert.match(f.read().status, /^parked:/);
});

function jevFixture(t) {
  const f = fixture(t), input = join(f.repo, 'input.json'), log = join(f.repo, 'receipts.jsonl'), calls = join(f.repo, 'calls.jsonl');
  const preload = join(f.repo, 'fetch fixture.mjs');
  writeFileSync(preload, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
let count = 0;
globalThis.fetch = async (url, options) => {
  if (existsSync(${JSON.stringify(join(f.repo, '.trioharness-direct/runs/r1/state.lock'))})) throw new Error('network under lock');
  appendFileSync(${JSON.stringify(calls)}, options.body + '\\n'); count++;
  const questions = JSON.parse(options.body).questions;
  if (process.env.TEST_RESPONSE === 'killed') process.kill(process.pid, 'SIGKILL');
  if (process.env.TEST_RESPONSE === 'never-settles') return new Promise(() => {});
  if (process.env.TEST_RESPONSE === 'outcome-failure') {
    const fs = await import('node:fs');
    const original = fs.default.renameSync;
    const append = fs.default.appendFileSync;
    fs.default.appendFileSync = (...args) => {
      const result = append(...args);
      if (args[0] === ${JSON.stringify(log)}) {
        fs.default.renameSync = (...values) => { fs.default.renameSync = original; syncBuiltinESMExports(); throw new Error('fixture outcome persistence failure'); };
        syncBuiltinESMExports();
      }
      return result;
    };
    const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
  }
  if (process.env.TEST_RESPONSE === 'reset-failure') {
    const file = ${JSON.stringify(f.file)}, state = JSON.parse(readFileSync(file, 'utf8'));
    state.attempts.plan = -1; writeFileSync(file, JSON.stringify(state));
  }
  if (process.env.TEST_RESPONSE === 'unavailable') return { ok: false, status: 503 };
  if (process.env.TEST_RESPONSE.startsWith('retry') && count === 1) return { ok: false, status: 429 };
  return { ok: true, json: async () => ({ model: 'fixture', answers: Object.fromEntries(Object.keys(questions).map(k => [k, { type: 'noul', noul: k === 'weakens' ? 0 : k === 'proof' && process.env.TEST_RESPONSE.includes('revise') ? 0 : 1 }])) }) };
};`);
  const env = { ...process.env, JEV_KEY_FILE: join(f.repo, 'absent'), TYPESAFE_API_KEY: randomUUID() };
  delete env.JEV_API_KEY;
  const run = (data = plan, flags = [], mode = '', gate = 'plan', tracked = true) => {
    writeFileSync(input, JSON.stringify(data));
    return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script('jev.mjs'), gate, input, '--log', log, ...(tracked ? ['--attempt-repo', f.repo, '--attempt-run', 'r1'] : []), ...flags], { encoding: 'utf8', env: { ...env, TEST_RESPONSE: mode } });
  };
  return { ...f, run, log, calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0, receipts: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
test('Jev tracked submissions ignore caller attempt, count network failures/retries, and record attempt/after', t => {
  const f = jevFixture(t);
  let r = f.run({ ...plan, attempt: 99 }, [], 'revise'); assert.equal(r.status, 2, r.stderr); assert.equal(f.read().attempts.plan, 1);
  r = f.run(plan, [], 'unavailable'); assert.equal(r.status, 3); assert.equal(f.read().attempts.plan, 2);
  r = f.run({ ...plan, after: 'scope-cut' }, [], 'retry-revise'); assert.equal(r.status, 2, r.stderr); assert.equal(f.read().attempts.plan, 3);
  assert.equal(f.calls(), 4);
  assert.deepEqual(f.receipts().map(x => x.attempt), [1, 2, 3]);
  assert.equal(f.receipts().at(-1).after, 'scope-cut');
});
test('Jev dry-run, invalid input, unmatched flags, wrong gate, unknown run and open card do not count or call network', t => {
  const f = jevFixture(t);
  let r = f.run(plan, ['--dry-run']); assert.equal(r.status, 0, r.stderr);
  r = f.run({ ...plan, objective: '' }); assert.equal(r.status, 3); assert.match(r.stderr, /INPUT_MISSING/);
  r = f.run(plan, ['--attempt-repo', f.repo], '', 'plan', false); assert.equal(r.status, 3); assert.match(r.stderr, /ATTEMPT_FLAGS/);
  r = f.run(plan, ['--attempt-run'], '', 'plan', false); assert.equal(r.status, 3); assert.match(r.stderr, /ATTEMPT_FLAGS/);
  r = f.run({ task: 'route' }, [], '', 'route'); assert.equal(r.status, 3); assert.match(r.stderr, /ATTEMPT_FLAGS/);
  r = f.run(plan, ['--attempt-repo', f.repo, '--attempt-run', 'missing'], '', 'plan', false); assert.equal(r.status, 3); assert.match(r.stderr, /RUN_UNKNOWN/);
  askCard(f.repo, 'r1', card); r = f.run(); assert.equal(r.status, 3); assert.match(r.stderr, /QUESTIONS_OPEN/);
  assert.equal(f.calls(), 0); assert.equal(f.read().attempts, undefined);
});
test('Jev plan limits use persisted attempts, local churn refusals do not consume them', t => {
  const f = jevFixture(t);
  for (let i = 0; i < 2; i++) assert.equal(f.run(plan, [], 'revise').status, 2);
  let r = f.run(); assert.equal(r.status, 3); assert.match(r.stderr, /PLAN_CHURN/); assert.equal(f.read().attempts.plan, 2);
  r = f.run({ ...plan, after: 'scope-cut' }, [], 'revise'); assert.equal(r.status, 2, r.stderr);
  assert.equal(f.read().status, 'awaiting-exception');
  r = f.run({ ...plan, after: 'scope-cut' }); assert.equal(r.status, 3); assert.match(r.stderr, /RUN_PARKED: EXCEPTION_NOT_GRANTED/);
  assert.equal(f.read().attempts.plan, 3); assert.equal(f.calls(), 3);
  assert.match(f.read().status, /^parked:/);
});
test('Jev without attempt flags preserves caller attempt and does not change state', t => {
  const f = jevFixture(t);
  const r = f.run({ ...plan, attempt: 3 }, [], '', 'plan', false);
  assert.equal(r.status, 3); assert.match(r.stderr, /PLAN_CHURN/); assert.equal(f.read().attempts, undefined); assert.equal(f.calls(), 0);
});

test('Jev redacts caller route metadata in receipts', t => {
  const f = jevFixture(t), value = randomUUID();
  const r = f.run({ ...plan, after: `API_KEY=${value}` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!JSON.stringify(f.receipts()).includes(value));
  assert.equal(f.read().attempts.plan, 0);
  assert.equal(f.receipts().at(-1).attempt, 1);
});

test('resetAttempt resets only plan under the state lock and retains other state', t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: 3, other: 8 } }));
  const before = f.read();
  assert.equal(state.resetAttempt(f.repo, 'r1', 'plan'), 0);
  assert.deepEqual(f.read().attempts, { plan: 0, other: 8 });
  for (const key of Object.keys(before).filter(k => !['updatedAt', 'attempts'].includes(k))) assert.deepEqual(f.read()[key], before[key]);
  assert.equal(state.reserveAttempt(f.repo, 'r1', 'plan'), 1);
});
test('resetAttempt preserves unknown-run, gate, counter and open-card refusals', t => {
  const f = fixture(t);
  assert.throws(() => state.resetAttempt(f.repo, 'r1', 'route'), /ATTEMPT_GATE/);
  assert.throws(() => state.resetAttempt(f.repo, 'missing', 'plan'), /RUN_UNKNOWN/);
  assert.throws(() => state.resetAttempt(f.repo, '../bad', 'plan'), /RUN_ID_INVALID/);
  for (const bad of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER]) {
    writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: bad } }));
    const before = readFileSync(f.file, 'utf8');
    assert.throws(() => state.resetAttempt(f.repo, 'r1', 'plan'), /ATTEMPT_INVALID/);
    assert.equal(readFileSync(f.file, 'utf8'), before);
  }
  deleteCounter(f);
  askCard(f.repo, 'r1', card);
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => state.resetAttempt(f.repo, 'r1', 'plan'), /QUESTIONS_OPEN/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});
test('passing tracked submissions reset consecutive attempts, while revise and unavailable retain them', t => {
  const f = jevFixture(t);
  assert.equal(f.run(plan, [], 'revise').status, 2); assert.equal(f.read().attempts.plan, 1);
  assert.equal(f.run(plan, [], 'unavailable').status, 3); assert.equal(f.read().attempts.plan, 2);
  let r = f.run({ ...plan, after: 'scope-cut' }, [], 'retry');
  assert.equal(r.status, 0, r.stderr); assert.equal(f.read().attempts.plan, 0);
  assert.equal(f.read().loops['jev-plan'], 3);
  r = f.run(); assert.equal(r.status, 3, r.stderr); assert.match(r.stderr, /LOOP_CAP/);
  assert.equal(f.read().attempts.plan, 0);
  assert.deepEqual(f.receipts().slice(0, 3).map(x => x.attempt), [1, 2, 3]);
  assert.equal(f.calls(), 4, 'a network retry retains one reserved submission; no fourth submission');
});
test('an accepted exception resets a tracked plan counter after the verdict is waived', t => {
  const f = jevFixture(t);
  assert.equal(f.run(plan, [], 'revise').status, 2);
  const rec = askException({ repo: f.repo, run: 'r1', input: plan, item: 'count fixture', receipts: f.log });
  answerCard(f.repo, 'r1', rec.id, { [TOPIC]: 'proceed' }, { via: 'card', quote: 'Proceed with this fixture exception' });
  grant({ repo: f.repo, run: 'r1', set: rec.id, input: plan });
  const r = f.run(plan, ['--exception-repo', f.repo, '--exception-run', 'r1'], 'revise');
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).verdict, 'accepted-exception');
  assert.equal(f.read().attempts.plan, 0); assert.deepEqual(f.receipts().map(x => x.attempt), [1, 2]);
});
test('the documented exception-only route resets a plan counter exhausted at four', t => {
  const f = jevFixture(t);
  assert.equal(f.run(plan, [], 'revise').status, 2);
  const rec = askException({ repo: f.repo, run: 'r1', input: plan, item: 'count fixture', receipts: f.log });
  answerCard(f.repo, 'r1', rec.id, { [TOPIC]: 'proceed' }, { via: 'card', quote: 'Proceed with this fixture exception' });
  grant({ repo: f.repo, run: 'r1', set: rec.id, input: plan });
  writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: 4 } }));
  const r = f.run(plan, ['--exception-repo', f.repo, '--exception-run', 'r1'], 'revise', 'plan', false);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).verdict, 'accepted-exception');
  assert.equal(f.read().attempts.plan, 0);
  assert.equal(f.receipts().at(-1).pass, true);
});
test('a plain proceed with only exception flags resets a plan counter exhausted at four', t => {
  const f = jevFixture(t);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: 4 } }));
  const r = f.run(plan, ['--exception-repo', f.repo, '--exception-run', 'r1'], '', 'plan', false);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pass, true); assert.equal(out.verdict, 'proceed');
  assert.equal(f.read().attempts.plan, 0);
  assert.equal(f.receipts().at(-1).verdict, 'proceed');
  assert.equal(f.read().gates['plan-jev'], undefined, 'detached verdict has no tracked acceptance provenance');
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }), /PLAN_PROVENANCE/);
});
test('a preload whose fetch never settles makes the CLI exit 3', t => {
  const f = jevFixture(t);
  const r = f.run(plan, [], 'never-settles');
  assert.equal(r.error, undefined); assert.equal(r.signal, null);
  assert.equal(r.status, 3, r.stderr);
  assert.equal(f.calls(), 1, 'the preload received the request');
  assert.equal(r.stdout, '', 'an unsettled request emits no verdict');
  assert.deepEqual(f.receipts(), []);
  assert.equal(f.read().attempts.plan, 1);
});
test('a tracked reset failure preserves the passing verdict, receipt and exit code', t => {
  const f = jevFixture(t);
  const r = f.run(plan, [], 'reset-failure');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pass, true); assert.equal(out.verdict, 'proceed');
  assert.equal(f.receipts().at(-1).pass, true);
  assert.equal(f.receipts().at(-1).verdict, 'proceed');
  assert.match(r.stderr, /ATTEMPT_RESET[^\n]*ATTEMPT_INVALID/);
  assert.equal(f.read().attempts.plan, -1, 'failed reset retains the counter');
});
test('an exception reset failure preserves the accepted exception and exit code', t => {
  const f = jevFixture(t);
  assert.equal(f.run(plan, [], 'revise').status, 2);
  const rec = askException({ repo: f.repo, run: 'r1', input: plan, item: 'count fixture', receipts: f.log });
  answerCard(f.repo, 'r1', rec.id, { [TOPIC]: 'proceed' }, { via: 'card', quote: 'Proceed with this fixture exception' });
  grant({ repo: f.repo, run: 'r1', set: rec.id, input: plan });
  writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: -1 } }));
  const r = f.run(plan, ['--exception-repo', f.repo, '--exception-run', 'r1'], 'revise', 'plan', false);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).pass, true);
  assert.equal(JSON.parse(r.stdout).verdict, 'accepted-exception');
  assert.equal(f.receipts().at(-1).verdict, 'accepted-exception');
  assert.match(r.stderr, /ATTEMPT_RESET[^\n]*ATTEMPT_INVALID/);
  assert.equal(f.read().attempts.plan, -1);
});
test('attempt --reset clears the counter and the next reservation starts at one', t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: 4, other: 8 } }));
  const r = cli('run-state.mjs', [...attemptArgs(f.repo), '--reset']);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), '0');
  assert.deepEqual(f.read().attempts, { plan: 0, other: 8 });
  const next = cli('run-state.mjs', attemptArgs(f.repo));
  assert.equal(next.status, 0, next.stderr); assert.equal(next.stdout.trim(), '1');
});
test('untracked passes and tracked dry runs leave an existing counter unchanged', t => {
  const f = jevFixture(t);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: 2 } }));
  let r = f.run(plan, [], '', 'plan', false); assert.equal(r.status, 0, r.stderr); assert.equal(f.read().attempts.plan, 2);
  r = f.run(plan, ['--dry-run']); assert.equal(r.status, 0, r.stderr); assert.equal(f.read().attempts.plan, 2);
});

// Lifetime convergence counters are separate from Jev's consecutive attempt rules.
for (const [kind, cap] of Object.entries({ 'plan-review': 1, 'jev-plan': 3, 'code-review': 2, 'fix-batch': 2, replan: 1, 'base-drift': 2, 'need-context': 2 })) {
  test(`loop ${kind} parks at ${cap} and survives a fresh CLI resume`, t => {
    const f = fixture(t);
    for (let n = 1; n <= cap; n++) {
      const r = cli('run-state.mjs', ['loop', '--repo', f.repo, '--run', 'r1', '--kind', kind]);
      assert.equal(r.status, n === cap ? 2 : 0, r.stderr);
      assert.equal(f.read().loops[kind], n);
      if (n === cap) assert.match(r.stderr, new RegExp(`LOOP_CAP:${kind}`));
    }
    assert.equal(f.read().status, `parked:LOOP_CAP:${kind}`);
    assert.equal(state.resumePoint(f.read()).resumeAt, 'parked');
    const r = cli('run-state.mjs', ['loop', '--repo', f.repo, '--run', 'r1', '--kind', kind]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(f.read().loops[kind], cap);
    assert.ok(existsSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md')));
  });
}
test('a cap preserves open HIGH, failed gates and unmet criteria; acceptance and delivery stay refused', t => {
  const f = fixture(t);
  const finding = { id: 'R1', severity: 'HIGH', confidence: 'confirmed', status: 'open', evidence: 'src/auth.mjs:4 missing authorization' };
  const criterion = { id: 'C1', status: 'unmet', evidence: 'proof/test.txt:2 expected 403' };
  writeFileSync(f.file, JSON.stringify({ ...f.read(), findings: [finding], criteria: [criterion], gates: { review: { status: 'failed', evidence: 'workers/review.md:R1' }, 'done-jev': { status: 'passed' } } }));
  const r = cli('run-state.mjs', ['loop', '--repo', f.repo, '--run', 'r1', '--kind', 'plan-review']);
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(f.read().findings, [finding]);
  assert.equal(f.read().finished, false);
  const report = readFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), 'utf8');
  for (const s of ['R1', 'HIGH', finding.evidence, 'C1', criterion.evidence, 'workers/review.md:R1']) assert.ok(report.includes(s), s);
  for (const gate of ['done-jev', 'commit-push', 'deploy-qa', 'learnings']) assert.throws(() => state.setGate(f.repo, 'r1', { gate, status: 'passed' }), /RUN_PARKED/);
  assert.throws(() => state.countDispatch(f.repo, 'r1', 'writer'), /RUN_PARKED/);
  assert.equal(cli('run-state.mjs', ['finish', '--repo', f.repo, '--run', 'r1']).status, 2);
});
test('explicit park is terminal, keeps prior handover and does not reset attempts or loops', t => {
  const f = fixture(t), dir = join(f.repo, '.trioharness-direct/runs/r1');
  writeFileSync(join(dir, 'HANDOVER-NEXT.md'), 'Existing handover evidence');
  writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: 2 }, loops: { 'jev-plan': 2 } }));
  const r = cli('run-state.mjs', ['park', '--repo', f.repo, '--run', 'r1', '--reason', 'DOCS_UNAVAILABLE']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read().status, 'parked:DOCS_UNAVAILABLE');
  assert.equal(f.read().attempts.plan, 2);
  assert.equal(f.read().loops['jev-plan'], 2);
  assert.match(readFileSync(join(dir, 'HANDOVER-NEXT.md'), 'utf8'), /Existing handover evidence/);
  assert.throws(() => state.reserveAttempt(f.repo, 'r1', 'plan'), /RUN_PARKED/);
  assert.throws(() => state.resetAttempt(f.repo, 'r1', 'plan'), /RUN_PARKED/);
});

test('open HIGH refuses acceptance/delivery before cap without hiding findings', t => {
  const f = fixture(t);
  const finding = { id: 'R2', severity: 'HIGH', confidence: 'probable', status: 'open', evidence: 'src/api.mjs:8 missing tenant filter' };
  writeFileSync(f.file, JSON.stringify({ ...f.read(), findings: [finding] }));
  for (const gate of ['done-jev', 'commit-push', 'deploy-qa']) assert.throws(() => state.setGate(f.repo, 'r1', { gate, status: 'passed' }), /RUN_UNRESOLVED/);
  assert.deepEqual(f.read().findings, [finding]);
});

// Fix1: actual gate/dispatch/CLI paths, not optional bookkeeping.
for (const gate of ['review', 'guard-proof', 'plan-review', 'browser-test']) for (const status of ['failed', 'blocked']) test(`fix1 M1 ${gate} ${status} refuses acceptance and delivery`, t => {
  const f = fixture(t);
  state.setGate(f.repo, 'r1', { gate, status });
  for (const target of ['done-jev', 'commit-push', 'deploy-qa']) for (const nextStatus of ['in_progress', 'passed']) assert.throws(() => state.setGate(f.repo, 'r1', { gate: target, status: nextStatus }), /RUN_UNRESOLVED/);
  assert.equal(cli('run-state.mjs', ['finish', '--repo', f.repo, '--run', 'r1']).status, 2);
});
const stateCli = (f, ...args) => cli('run-state.mjs', [...args, '--repo', f.repo, '--run', 'r1']);
test('fix1 M2 findings must sync for current round, cannot disappear, criteria block and park lists evidence', t => {
  const f = fixture(t);
  state.setGate(f.repo, 'r1', { gate: 'review', status: 'in_progress' });
  state.setGate(f.repo, 'r1', { gate: 'review', status: 'passed' });
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' }), /FINDINGS_NOT_SYNCED/);
  const empty = join(f.repo, 'empty.json'); writeFileSync(empty, '[]');
  let r = stateCli(f, 'findings', 'add', '--id', 'H1', '--severity', 'HIGH', '--evidence', 'auth.mjs:3 no tenant filter');
  assert.equal(r.status, 0, r.stderr);
  r = stateCli(f, 'findings', 'sync', '--round', String(f.read().reviewRound), '--file', empty); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read().findings[0].id, 'H1');
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' }), /RUN_UNRESOLVED/);
  r = stateCli(f, 'findings', 'resolve', '--id', 'H1', '--evidence', 'proof/security.txt:8 403 verified'); assert.equal(r.status, 0, r.stderr);
  r = stateCli(f, 'findings', 'sync', '--round', String(f.read().reviewRound), '--file', empty); assert.equal(r.status, 0, r.stderr);
  r = stateCli(f, 'criteria', 'set', '--id', 'C1', '--status', 'unmet', '--evidence', 'proof/ui.txt:2 clipped'); assert.equal(r.status, 0, r.stderr);
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' }), /RUN_UNRESOLVED/);
  state.setGate(f.repo, 'r1', { gate: 'review', status: 'in_progress' });
  assert.equal(stateCli(f, 'findings', 'sync', '--round', '1', '--file', empty).status, 2);
  state.parkRun(f.repo, 'r1', 'criteria remain');
  assert.match(readFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), 'utf8'), /C1[\s\S]*clipped/);
});
for (const [role, cap, kind] of [['plan-reviewer', 1, 'plan-review'], ['code-reviewer', 2, 'code-review']]) test(`fix1 M3 ${role} real dispatch caps survive resume`, t => {
  const f = fixture(t);
  for (let n = 1; n <= cap; n++) { const r = stateCli(f, 'dispatch', '--role', role); assert.equal(r.status, 0, r.stderr); assert.equal(f.read().loops[kind], n); }
  const r = stateCli(f, 'dispatch', '--role', role, '--worker', 'over-cap'); assert.equal(r.status, 2, r.stderr);
  assert.equal(f.read().dispatches[role], cap);
  assert.equal(f.read().workers?.['over-cap'], undefined);
  assert.match(f.read().status, /^parked:/);
});
test('fix1 M3 attempt reset cannot replenish lifetime budget', t => {
  const f = fixture(t);
  state.reserveAttempt(f.repo, 'r1', 'plan'); state.resetAttempt(f.repo, 'r1', 'plan');
  assert.equal(f.read().loops['jev-plan'], 1);
  state.reserveAttempt(f.repo, 'r1', 'plan'); assert.equal(f.read().loops['jev-plan'], 2);
});
for (const answer of ['park', 'no-grant', 'proceed']) test(`fix1 M5 real third rejection then ${answer}`, t => {
  const f = jevFixture(t), data = { ...plan, after: 'scope-cut' };
  for (let n = 0; n < 3; n++) assert.equal(f.run(data, [], 'revise').status, 2);
  assert.equal(f.read().status, 'awaiting-exception');
  assert.equal(f.read().planFailedSubmissions, 3);
  assert.equal(f.read().loops['jev-plan'], 3);
  assert.equal(stateCli(f, 'attempt', '--gate', 'plan', '--reset').status, 2);
  const rec = askException({ repo: f.repo, run: 'r1', input: data, item: 'quantity fixture', receipts: f.log });
  answerCard(f.repo, 'r1', rec.id, { [TOPIC]: answer === 'park' ? 'park' : 'proceed' }, { via: 'card', quote: answer });
  if (answer === 'proceed') {
    grant({ repo: f.repo, run: 'r1', set: rec.id, input: data });
    const r = f.run(data, ['--exception-repo', f.repo, '--exception-run', 'r1'], 'revise', 'plan', false);
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).verdict, 'accepted-exception');
    assert.equal(f.read().status, 'active'); assert.equal(f.read().loops['jev-plan'], 3);
  } else {
    assert.equal(stateCli(f, 'set', '--gate', 'plan-jev', '--status', 'passed').status, 2);
    assert.match(f.read().status, /^parked:/);
  }
});
test('fix1 M5 third successful outcome is active and unavailable counts as real outcome', t => {
  const f = jevFixture(t);
  assert.equal(f.run(plan, [], 'revise').status, 2);
  assert.equal(f.run(plan, [], 'unavailable').status, 3);
  assert.equal(f.read().planFailedSubmissions, 2);
  assert.equal(f.run({ ...plan, after: 'scope-cut' }).status, 0);
  assert.notEqual(f.read().status, 'awaiting-exception');
  assert.equal(f.read().loops['jev-plan'], 3);
});

test('fix1 M2 empty current-round sync permits completion; downgrade sync cannot erase HIGH', t => {
  const f = fixture(t); auditEvidence(f, true);
  const empty = join(f.repo, 'empty.json'); writeFileSync(empty, '[]');
  state.setGate(f.repo, 'r1', { gate: 'review', status: 'passed' });
  assert.equal(stateCli(f, 'criteria', 'set', '--id', 'C1', '--status', 'met', '--evidence', 'proof/test.txt:1 PASS').status, 0);
  assert.equal(stateCli(f, 'findings', 'sync', '--round', String(f.read().reviewRound), '--file', empty).status, 0);
  state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
  assert.equal(stateCli(f, 'finish').status, 0);
  assert.equal(stateCli(f, 'findings', 'add', '--id', 'R1', '--severity', 'HIGH', '--evidence', 'auth:8 missing check').status, 0);
  writeFileSync(empty, JSON.stringify([{ id: 'R1', severity: 'LOW', status: 'closed', evidence: 'not a verified fix' }]));
  assert.notEqual(stateCli(f, 'findings', 'sync', '--round', String(f.read().reviewRound), '--file', empty).status, 0);
  assert.equal(f.read().findings[0].severity, 'HIGH');
  assert.equal(f.read().findings[0].status, 'open');
  assert.equal(stateCli(f, 'finish').status, 2);
});
test('fix1 M2 in-progress review cannot accept even after sync', t => {
  const f = fixture(t), empty = join(f.repo, 'empty.json'); writeFileSync(empty, '[]');
  state.setGate(f.repo, 'r1', { gate: 'review', status: 'in_progress' });
  assert.equal(stateCli(f, 'findings', 'sync', '--round', String(f.read().reviewRound), '--file', empty).status, 0);
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' }), /RUN_UNRESOLVED/);
});
test('fix1 M5 advancing without an exception card/grant parks the rejected input', t => {
  const f = jevFixture(t), data = { ...plan, after: 'scope-cut' };
  for (let n = 0; n < 3; n++) assert.equal(f.run(data, [], 'revise').status, 2);
  assert.equal(stateCli(f, 'finish').status, 2);
  assert.match(f.read().status, /^parked:/);
  const report = readFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), 'utf8');
  assert.match(report, /plan-jev/);
});

test('fix1 M2 starting acceptance also needs current-round findings sync', t => {
  const f = fixture(t); state.setGate(f.repo, 'r1', { gate: 'review', status: 'passed' });
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'in_progress' }), /FINDINGS_NOT_SYNCED/);
});

// Fix3: settlement and granted fresh-success regressions.
test('fix3 H1 manual reservation and untracked success can complete without an orphan outcome', t => {
  const f = jevFixture(t); auditEvidence(f);
  const reservation = cli('run-state.mjs', attemptArgs(f.repo));
  assert.equal(reservation.status, 0, reservation.stderr);
  const r = f.run({ ...plan, attempt: Number(reservation.stdout) }, [], '', 'plan', false);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read().planPendingOutcomes || 0, 0);
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' });
  assert.equal(stateCli(f, 'attempt', '--gate', 'plan', '--reset').status, 0);
  state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
  assert.equal(stateCli(f, 'finish').status, 0);
  assert.equal(f.read().loops['jev-plan'], 1);
});
test('fix3 H1 abandoned tracked call recovers observably, retains findings and lifetime cap', t => {
  const f = jevFixture(t);
  state.updateFindings(f.repo, 'r1', 'add', { id: 'H1', severity: 'HIGH', evidence: 'auth.mjs:4 missing fence' });
  assert.equal(f.run(plan, [], 'never-settles').status, 3);
  assert.equal(f.read().planPendingOutcomes, 1);
  assert.equal(stateCli(f, 'attempt', '--gate', 'plan', '--reset').status, 0);
  assert.equal(f.read().planPendingOutcomes, 1, 'plain reset cannot hide an unknown outcome');
  assert.equal(stateCli(f, 'attempt', '--gate', 'plan', '--reset', '--recover').status, 3);
  const r = stateCli(f, 'attempt', '--gate', 'plan', '--reset', '--recover', '--reason', 'supervisor exited without an outcome');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read().planPendingOutcomes, 0);
  assert.equal(f.read().planRecoveries[0].reason, 'supervisor exited without an outcome');
  assert.equal(f.read().planRecoveries[0].pending, 1);
  assert.equal(f.read().gates['plan-jev'].status, 'failed');
  assert.equal(f.read().findings[0].status, 'open');
  assert.equal(f.read().loops['jev-plan'], 1);
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' }), /RUN_UNRESOLVED/);
  assert.equal(f.run(plan).status, 0);
  assert.equal(f.read().loops['jev-plan'], 2);
  assert.equal(f.run(plan, [], 'never-settles').status, 3);
  const capped = stateCli(f, 'attempt', '--gate', 'plan', '--reset', '--recover', '--reason', 'third submission interrupted');
  assert.equal(capped.status, 0, capped.stderr);
  assert.equal(f.read().planPendingOutcomes, 0);
  assert.equal(f.read().loops['jev-plan'], 3);
  assert.match(f.read().status, /^parked:/);
  assert.equal(f.run(plan).status, 3);
  assert.equal(f.calls(), 3);
  assert.match(readFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), 'utf8'), /H1[\s\S]*missing fence/);
});
test('fix3 H1 failed outcome persistence recovers without clearing later pending submissions', t => {
  const f = jevFixture(t);
  // Simulate outcome persistence failure after a successful network response.
  const r = f.run(plan, [], 'outcome-failure');
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /PLAN_OUTCOME/);
  assert.equal(f.read().planPendingOutcomes, 1);
  const old = f.receipts().at(-1);
  const recovered = stateCli(f, 'attempt', '--gate', 'plan', '--reset', '--recover', '--reason', 'outcome write failed; receipt retained');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(f.read().planRecoveries[0].pending, 1);
  assert.equal(f.run(plan, [], 'never-settles').status, 3);
  assert.throws(() => state.recordPlanOutcome(f.repo, 'r1', old), /PLAN_SUBMISSION_UNKNOWN/);
  assert.equal(f.read().planPendingOutcomes, 1);
  assert.equal(f.read().loops['jev-plan'], 2);
});
for (const response of ['', 'revise']) test(`fix3 M5 granted third rejection with fresh ${response || 'proceed'} agrees with state and has no reset warning`, t => {
  const f = jevFixture(t), data = { ...plan, after: 'scope-cut' };
  for (let n = 0; n < 3; n++) assert.equal(f.run(data, [], 'revise').status, 2);
  const rec = askException({ repo: f.repo, run: 'r1', input: data, item: 'quantity fixture', receipts: f.log });
  answerCard(f.repo, 'r1', rec.id, { [TOPIC]: 'proceed' }, { via: 'card', quote: 'Proceed' });
  grant({ repo: f.repo, run: 'r1', set: rec.id, input: data });
  const r = f.run(data, ['--exception-repo', f.repo, '--exception-run', 'r1'], response, 'plan', false);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ATTEMPT_RESET|PLAN_OUTCOME/);
  assert.equal(f.read().status, 'active');
  assert.equal(f.read().gates['plan-jev'].status, 'passed');
  assert.equal(f.read().attempts.plan, 0);
  assert.equal(f.read().loops['jev-plan'], 3);
});

test('fix3 H1 SIGKILL between reservation and outcome uses the same run-bound recovery', t => {
  const f = jevFixture(t);
  const killed = f.run(plan, [], 'killed');
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(f.read().planPendingOutcomes, 1);
  const before = readFileSync(f.file, 'utf8');
  assert.equal(cli('run-state.mjs', ['attempt', '--repo', f.repo, '--run', 'another-run', '--gate', 'plan', '--reset', '--recover', '--reason', 'killed']).status, 3);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(stateCli(f, 'attempt', '--gate', 'plan', '--recover', '--reason', 'killed').status, 3);
  assert.equal(stateCli(f, 'attempt', '--gate', 'plan', '--reset', '--recover', '--reason', 'SIGKILL after reservation').status, 0);
  assert.equal(f.read().planPendingOutcomes, 0);
  assert.equal(f.read().loops['jev-plan'], 1);
  assert.equal(f.read().gates['plan-jev'].status, 'failed');
  assert.equal(stateCli(f, 'attempt', '--gate', 'plan', '--reset', '--recover', '--reason', 'repeat').status, 3);
  assert.equal(f.read().planRecoveries.length, 1);
  assert.equal(f.run(plan).status, 0);
  state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
});
test('fix3 H1 legacy counter-only pending outcomes can be abandoned without losing evidence', t => {
  const f = fixture(t), previousGate = { status: 'failed', evidence: 'previous rejection receipt' };
  writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: 1 }, loops: { 'jev-plan': 1 }, planPendingOutcomes: 1, gates: { 'plan-jev': previousGate } }));
  assert.equal(stateCli(f, 'attempt', '--gate', 'plan', '--reset', '--recover', '--reason', 'legacy missing outcome').status, 0);
  assert.equal(f.read().planPendingOutcomes, 0);
  assert.equal(f.read().loops['jev-plan'], 1);
  assert.deepEqual(f.read().planRecoveries[0].previousGate, previousGate);
  assert.equal(f.read().gates['plan-jev'].status, 'failed');
});

function auditEvidence(f, review = false) {
  for (const gate of ['route', 'task-card', 'guard-proof']) state.setGate(f.repo, 'r1', { gate, status: 'passed' });
  if (review) writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/CODE_REVIEW_ROUNDS.jsonl'), '{}\n');
}
function resultFiles(f, n) {
  const dir = join(f.repo, '.trioharness-direct/runs/r1/workers'); mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `report-${i}.md`), 'worker result');
}
for (const files of [0, 1, 3]) test(`audit rejects exact dispatch mismatch with ${files} results`, t => {
  const f = fixture(t); auditEvidence(f); state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
  state.countDispatch(f.repo, 'r1', 'writer'); state.countDispatch(f.repo, 'r1', 'writer'); resultFiles(f, files);
  assert.ok(state.auditRun(f.repo, 'r1').problems.some(p => /dispatch count 2/.test(p)));
  assert.notEqual(stateCli(f, 'finish').status, 0);
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }), /AUDIT/);
});
for (const status of ['running', 'unknown', 'done', 'failed', 'stopped']) test(`closure checks ${status} workers without filename identity`, t => {
  const f = fixture(t); auditEvidence(f); state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
  state.countDispatch(f.repo, 'r1', 'writer'); resultFiles(f, 1);
  state.registerWorker(f.repo, 'r1', { id: 'unrelated-id', role: 'writer' });
  if (status === 'unknown') { const data = f.read(); data.workers['unrelated-id'].status = status; writeFileSync(f.file, JSON.stringify(data)); }
  else if (status !== 'running') finishAttempt(f, 'unrelated-id', status);
  if (['running', 'unknown'].includes(status)) {
    assert.notEqual(stateCli(f, 'finish').status, 0);
    assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }), /WORKERS|AUDIT/);
  } else {
    assert.equal(state.auditRun(f.repo, 'r1').ok, true);
    assert.equal(stateCli(f, 'finish').status, 0);
    assert.equal(state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }).finished, true);
  }
});
test('audit diagnoses malformed legacy worker records without crashing', t => {
  const f = fixture(t); auditEvidence(f); state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
  const data = f.read(); data.workers = { legacy: null }; writeFileSync(f.file, JSON.stringify(data));
  assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  assert.notEqual(stateCli(f, 'finish').status, 0);
});
test('anonymous dispatch needs explicit disposition to bind result evidence', t => {
  const f = fixture(t); auditEvidence(f); state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
  assert.equal(stateCli(f, 'dispatch', '--role', 'writer').status, 0); resultFiles(f, 1);
  assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  state.registerWorker(f.repo, 'r1', { id: 'writer', role: 'writer' }); finishAttempt(f, 'writer');
  assert.equal(state.auditRun(f.repo, 'r1').ok, true);
  assert.equal(stateCli(f, 'finish').status, 0);
});

test('shared review reservation consumes dispatch credit once in either order', t => {
  const f = fixture(t);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  assert.equal(state.reserveReviewLaunch(f.repo, 'r1'), 1);
  assert.equal(f.read().loops['code-review'], 1);
  assert.equal(state.reserveReviewLaunch(f.repo, 'r1'), 2);
  assert.equal(f.read().loops['code-review'], 2);
  assert.throws(() => state.reserveReviewLaunch(f.repo, 'r1'), /LOOP_CAP:code-review/);
});
test('direct launch followed by dispatch shares the remaining reservation', t => {
  const f = fixture(t);
  assert.equal(state.reserveReviewLaunch(f.repo, 'r1'), 1);
  state.countDispatch(f.repo, 'r1', 'reviewer-opus');
  assert.equal(state.reserveReviewLaunch(f.repo, 'r1'), 2);
  assert.equal(f.read().loops['code-review'], 2);
});

test('plan pass refuses zero and consumed provenance while retaining reset compatibility', t => {
  const f = fixture(t);
  const pass = () => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' });
  assert.throws(pass, /PLAN_PROVENANCE/);
  state.reserveAttempt(f.repo, 'r1', 'plan');
  assert.equal(pass().gates['plan-jev'].status, 'passed');
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'failed' });
  assert.throws(pass, /PLAN_PROVENANCE/);
  state.reserveAttempt(f.repo, 'r1', 'plan'); state.resetAttempt(f.repo, 'r1', 'plan');
  assert.equal(pass().gates['plan-jev'].status, 'passed');
});
test('plan pass cannot consume an automatic pending or recovered submission manually', t => {
  const f = fixture(t), submission = randomUUID();
  state.reserveAttempt(f.repo, 'r1', 'plan', () => {}, submission);
  const pass = () => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' });
  assert.throws(pass, /PLAN_PROVENANCE/);
  state.resetAttempt(f.repo, 'r1', 'plan', { recover: true, reason: 'supervisor stopped' });
  assert.throws(pass, /PLAN_PROVENANCE/);
});
test('reported plan success requires live submission or an unconsumed exact-input grant', t => {
  const f = fixture(t), outcome = { verdict: 'proceed', inputSha256: '0123456789abcdef', at: new Date().toISOString() };
  assert.throws(() => state.recordPlanOutcome(f.repo, 'r1', outcome), /PLAN_PROVENANCE/);
  const submission = randomUUID(), attempt = state.reserveAttempt(f.repo, 'r1', 'plan', () => {}, submission);
  state.recordPlanOutcome(f.repo, 'r1', { ...outcome, attempt, submission });
  assert.equal(f.read().gates['plan-jev'].status, 'passed');
  assert.throws(() => state.recordPlanOutcome(f.repo, 'r1', { ...outcome, attempt, submission }), /PLAN_SUBMISSION_UNKNOWN/);
  assert.equal(state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }).gates['plan-jev'].status, 'passed');
});
test('a new manual reservation invalidates stale provenance without changing detached defaults', t => {
  const f = jevFixture(t);
  const detached = f.run(plan, [], '', 'plan', false);
  assert.equal(detached.status, 0, detached.stderr);
  assert.equal(f.read().loops, undefined);
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }), /PLAN_PROVENANCE/);
  state.reserveAttempt(f.repo, 'r1', 'plan');
  const attempt = state.reserveAttempt(f.repo, 'r1', 'plan', () => {}, randomUUID());
  assert.equal(attempt, 2);
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }), /PLAN_PROVENANCE/);
});

test('fix2 H1-a mixed dispatches close only through explicit report dispositions', t => {
  const f = fixture(t); auditEvidence(f); state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
  assert.equal(stateCli(f, 'dispatch', '--role', 'writer', '--worker', 'named').status, 0);
  assert.equal(stateCli(f, 'dispatch', '--role', 'writer').status, 0);
  finishAttempt(f, 'named'); resultFiles(f, 2);
  assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  state.registerWorker(f.repo, 'r1', { id: 'anonymous', role: 'writer' }); finishAttempt(f, 'anonymous');
  assert.equal(state.auditRun(f.repo, 'r1').ok, true);
  assert.equal(state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }).finished, true);
  assert.equal(stateCli(f, 'finish').status, 0);
});
for (const status of ['failed', 'stopped']) test(`fix2 H1-b ${status} without report refuses same-id dispatch and fresh-id retry closes`, t => {
  const f = fixture(t); auditEvidence(f); state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
  assert.equal(stateCli(f, 'dispatch', '--role', 'writer', '--worker', 'writer-1').status, 0);
  finishAttempt(f, 'writer-1', status);
  assert.equal(state.auditRun(f.repo, 'r1').ok, true, 'terminal failure needs no report');
  const before = readFileSync(f.file), repeated = stateCli(f, 'dispatch', '--role', 'writer', '--worker', 'writer-1');
  assert.equal(repeated.status, 3); assert.match(repeated.stderr, /DISPATCH_ALREADY_RECORDED/);
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(stateCli(f, 'dispatch', '--role', 'writer', '--worker', 'writer-2').status, 0);
  finishAttempt(f, 'writer-2', 'done'); resultFiles(f, 1);
  assert.equal(state.auditRun(f.repo, 'r1').ok, true);
  assert.equal(state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }).finished, true);
  assert.equal(stateCli(f, 'finish').status, 0);
});
test('fix2 H1-c only explicit report bindings count; directory contents are ignored', t => {
  const f = fixture(t); auditEvidence(f); state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
  state.countDispatch(f.repo, 'r1', 'writer'); resultFiles(f, 1);
  const dir = join(f.repo, '.trioharness-direct/runs/r1/workers');
  writeFileSync(join(dir, '.DS_Store'), 'metadata'); writeFileSync(join(dir, 'report-0.md.json'), '{}'); mkdirSync(join(dir, 'folder.md'));
  assert.equal(state.auditRun(f.repo, 'r1').workerFiles, 0);
  assert.notEqual(stateCli(f, 'finish').status, 0);
  state.registerWorker(f.repo, 'r1', { id: 'w', role: 'writer' });
  assert.equal(reportDone(f, 'w', join(dir, 'report-0.md')).status, 0);
  assert.equal(state.auditRun(f.repo, 'r1').workerFiles, 1);
  assert.equal(stateCli(f, 'finish').status, 0);
});
test('fix2 H1-d legacy acceptance-only finish retains exit zero but running workers refuse', t => {
  const f = fixture(t); writeFileSync(f.file, JSON.stringify({ run: 'r1', gates: { 'done-jev': { status: 'passed' } }, history: [] }));
  assert.equal(stateCli(f, 'finish').status, 0);
  state.registerWorker(f.repo, 'r1', { id: 'running' });
  assert.notEqual(stateCli(f, 'finish').status, 0);
});

test('fix2 M4-a tracked success accepts checkpoint start/end and reset', t => {
  const f = jevFixture(t); assert.equal(f.run(plan).status, 0);
  for (let i = 0; i < 2; i++) {
    state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'in_progress' });
    assert.equal(state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }).gates['plan-jev'].status, 'passed');
    state.resetAttempt(f.repo, 'r1', 'plan');
  }
});
test('fix2 M4-a reset retains manual provenance and pre-marker reservations work', t => {
  const f = fixture(t); state.reserveAttempt(f.repo, 'r1', 'plan'); state.resetAttempt(f.repo, 'r1', 'plan');
  assert.equal(f.read().loops['jev-plan-manual'], 1);
  assert.equal(state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }).gates['plan-jev'].status, 'passed');
  const data = f.read(); data.legacyPlanReservation = true; data.attempts.plan = 1; data.loops = { 'jev-plan': 2 }; data.gates['plan-jev'] = { status: 'in_progress' }; data.history = []; writeFileSync(f.file, JSON.stringify(data));
  assert.equal(state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }).gates['plan-jev'].status, 'passed');
});
test('fix2 M4-b ungranted success while awaiting exception parks before provenance refusal', t => {
  const f = fixture(t), digest = '0123456789abcdef';
  writeFileSync(f.file, JSON.stringify({ ...f.read(), status: 'awaiting-exception', awaitingException: { inputSha256: digest } }));
  assert.throws(() => state.recordPlanOutcome(f.repo, 'r1', { verdict: 'proceed', inputSha256: digest, at: new Date().toISOString() }), /EXCEPTION_NOT_GRANTED/);
  assert.match(f.read().status, /^parked:EXCEPTION_NOT_GRANTED/);
});
test('fix2 M4-c detached exception-only proceed reports outcome not recorded', t => {
  const f = jevFixture(t); const r = f.run(plan, ['--exception-repo', f.repo, '--exception-run', 'r1'], '', 'plan', false);
  assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).outcomeRecorded, false);
  assert.notEqual(f.read().gates['plan-jev']?.status, 'passed');
});

test('fix2 M2-c legacy completed reviews cannot become unused dispatch credit', t => {
  const f = fixture(t); state.countDispatch(f.repo, 'r1', 'code-reviewer'); state.countDispatch(f.repo, 'r1', 'code-reviewer');
  writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/CODE_REVIEW_ROUNDS.jsonl'), [0,1].map(round=>JSON.stringify({ status:'completed',round })).join('\n')+'\n');
  assert.throws(()=>state.reserveReviewLaunch(f.repo,'r1'), /LOOP_CAP:code-review/);
});

// Run discipline: exercise real commands and persisted records, including both close paths.
const disciplineCli = (f, kind, action, data) => {
  const file = join(f.repo, 'record.json'); writeFileSync(file, JSON.stringify(data));
  return stateCli(f, kind, ...(action ? [action] : []), '--file', file);
};
const owedItem = { id: 'I1', item: 'Implement the approved slice', owner: 'writer', status: 'open', blocker: '', next: 'Run RED proof' };
const handoffRecord = (f, kind = 'cross-repo') => {
  mkdirSync(join(f.repo, 'other'), { recursive: true });
  if (!f.read().items?.some(i => i.id === 'HI1')) state.updateDiscipline(f.repo, 'r1', 'item', 'add', { ...owedItem, id: 'HI1', status: 'done' });
  return { id: 'H1', kind, itemId: 'HI1',
  source: { repo: f.repo, run: 'r1', task: 'predecessor' },
  target: { repo: kind === 'same-repo' ? f.repo : join(f.repo, 'other'), run: kind === 'same-repo' ? 'r1' : 'r2', task: 'successor' }, state: 'sent' };
};
const acceptedFixture = t => { const f = fixture(t); for (const gate of ['route', 'task-card', 'guard-proof', 'done-jev']) state.setGate(f.repo, 'r1', { gate, status: 'passed' }); return f; };

test('run discipline scope is validated and immutable; deferrals append without losing earlier records', t => {
  const f = fixture(t), scope = { outcome: 'A bounded change', nonGoals: ['No app changes'], files: ['src/a.mjs'] };
  assert.equal(disciplineCli(f, 'scope', null, { ...scope, files: 'src/a.mjs' }).status, 3);
  assert.equal(disciplineCli(f, 'scope', null, scope).status, 0);
  assert.deepEqual(f.read().scope, scope);
  const before = readFileSync(f.file, 'utf8');
  assert.equal(disciplineCli(f, 'scope', null, { ...scope, files: ['src/b.mjs'] }).status, 3);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  for (const id of ['D1', 'D2']) assert.equal(disciplineCli(f, 'defer', null, { id, item: 'Future polish', reason: 'Outside approved files' }).status, 0);
  assert.equal(disciplineCli(f, 'defer', null, { id: 'D1', item: 'Replace old text', reason: 'No' }).status, 3);
  assert.deepEqual(f.read().deferrals.map(d => d.id), ['D1', 'D2']);
  assert.deepEqual(f.read().scope, scope);
});

test('run discipline item validation, partial updates and explicit parking preserve identity and obligations', t => {
  const f = acceptedFixture(t);
  for (const patch of [{ owner: '' }, { next: '' }, { status: 'unknown' }, { id: '../bad' }, { status: 'parked' }]) assert.equal(disciplineCli(f, 'item', 'add', { ...owedItem, ...patch }).status, 3);
  assert.equal(disciplineCli(f, 'item', 'add', owedItem).status, 0);
  assert.equal(disciplineCli(f, 'item', 'add', owedItem).status, 3);
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'missing', status: 'done' }).status, 3);
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'I1', status: 'blocked', blocker: 'Needs proof' }).status, 0);
  assert.equal(f.read().items[0].owner, 'writer');
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'I1', status: 'parked', reason: 'Separate approved objective', owner: '' }).status, 3);
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'I1', status: 'parked', reason: 'Separate approved objective', owner: 'next-owner', next: 'Open follow-up' }).status, 0);
  const table = stateCli(f, 'status'); assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /I1.*parked.*next-owner.*Separate approved objective/);
  assert.equal(stateCli(f, 'finish').status, 0);
  state.setGate(f.repo, 'r1', { gate: 'guard-proof', status: 'failed' });
  const gates = f.read().gates;
  assert.equal(stateCli(f, 'finish').status, 2);
  assert.deepEqual(f.read().gates, gates);
});

for (const status of ['open', 'blocked']) test(`run discipline ${status} item refuses finish and learnings without changing gates`, t => {
  const f = acceptedFixture(t);
  assert.equal(disciplineCli(f, 'item', 'add', { ...owedItem, status, blocker: status === 'blocked' ? 'Waiting' : '' }).status, 0);
  const gates = f.read().gates;
  for (const args of [['finish'], ['set', '--gate', 'learnings', '--status', 'passed']]) {
    const r = stateCli(f, ...args); assert.equal(r.status, 3, r.stderr); assert.match(r.stderr, /RUN_OWES_WORK/);
    assert.deepEqual(f.read().gates, gates); assert.notEqual(f.read().finished, true);
  }
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'I1', status: 'done' }).status, 0);
  assert.equal(stateCli(f, 'set', '--gate', 'learnings', '--status', 'passed').status, 0);
  assert.equal(f.read().finished, true);
});

for (const status of ['sent', 'running', 'failed']) test(`run discipline ${status} handoff stays owed for audit and both finish paths`, t => {
  const f = acceptedFixture(t), h = handoffRecord(f);
  assert.equal(disciplineCli(f, 'handoff', 'add', h).status, 0);
  if (status !== 'sent') assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', state: status }).status, 0);
  const gates = f.read().gates;
  const audit = stateCli(f, 'audit'); assert.equal(audit.status, 1, audit.stderr); assert.match(audit.stdout, /H1/);
  for (const args of [['finish'], ['set', '--gate', 'learnings', '--status', 'passed']]) {
    const r = stateCli(f, ...args); assert.equal(r.status, 3, r.stderr); assert.match(r.stderr, /RUN_OWES_WORK/);
  }
  assert.deepEqual(f.read().gates, gates);
});

test('run discipline handoff identities are immutable and cross-repo done requires result and verification', t => {
  const f = acceptedFixture(t), h = handoffRecord(f);
  for (const patch of [{ kind: 'other' }, { target: { ...h.target, task: '' } }, { target: h.source }, { source: { ...h.source, run: 'other-run' } }, { state: 'done' }]) assert.equal(disciplineCli(f, 'handoff', 'add', { ...h, ...patch }).status, 3);
  assert.equal(disciplineCli(f, 'handoff', 'add', h).status, 0);
  assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', target: { ...h.target, task: 'someone-else' } }).status, 3);
  for (const patch of [{}, { result: 'result.md' }, { verification: 'proof.md' }]) assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', state: 'done', ...patch }).status, 3);
  assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', state: 'done', result: 'result.md', verification: 'proof.md' }).status, 0);
  assert.equal(stateCli(f, 'audit').status, 0);
  assert.equal(stateCli(f, 'finish').status, 0);
});

test('run discipline failed handoffs retain history when replaced or their linked item is parked', t => {
  const f = acceptedFixture(t), h = handoffRecord(f);
  assert.equal(disciplineCli(f, 'item', 'add', owedItem).status, 0);
  assert.equal(disciplineCli(f, 'handoff', 'add', { ...h, itemId: 'I1' }).status, 0);
  assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', state: 'failed', result: 'partial.md' }).status, 0);
  assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', state: 'done', result: 'partial.md', verification: 'proof.md' }).status, 3);
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'I1', status: 'parked', reason: 'Owner moves this work', owner: 'follow-up', next: 'New run' }).status, 0);
  // Continue the replacement path before finishing; finished runs are immutable.
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'I1', status: 'done' }).status, 0);
  assert.equal(stateCli(f, 'finish').status, 3);
  assert.equal(disciplineCli(f, 'handoff', 'add', { ...h, id: 'H2', replaces: 'H1' }).status, 3);
  assert.equal(disciplineCli(f, 'handoff', 'add', { ...h, id: 'H2', itemId: 'I1', replaces: 'H1' }).status, 0);
  assert.equal(stateCli(f, 'finish').status, 3);
  assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H2', state: 'done', result: 'complete.md', verification: 'checked.md' }).status, 0);
  assert.equal(stateCli(f, 'finish').status, 0);
  assert.deepEqual(f.read().handoffs.map(h => h.state), ['failed', 'done']);
});

test('run discipline consuming NEXT completes only the matching same-repo handoff; keep does not', t => {
  const f = fixture(t), h = handoffRecord(f, 'same-repo'), dir = join(f.repo, '.trioharness-direct/runs/r1');
  assert.equal(disciplineCli(f, 'item', 'add', owedItem).status, 0);
  assert.equal(disciplineCli(f, 'handoff', 'add', h).status, 0);
  assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', state: 'done', result: 'fake.md' }).status, 3);
  writeFileSync(join(dir, 'HANDOVER-NEXT.md'), 'Carry I1 to successor');
  state.handoverTaken(f.repo, 'r1', { by: 'successor', keep: true, handoff: 'H1' });
  assert.equal(f.read().handoffs[0].state, 'sent');
  assert.throws(() => state.handoverTaken(f.repo, 'r1', { by: 'other-task' }), /HANDOFF_PICKUP_REQUIRED/);
  assert.equal(f.read().handoffs[0].state, 'sent');
  writeFileSync(join(dir, 'HANDOVER-NEXT.md'), 'Carry I1 to successor');
  const pickup = state.handoverTaken(f.repo, 'r1', { by: 'successor', handoff: 'H1' });
  assert.equal(f.read().handoffs[0].state, 'done'); assert.equal(f.read().handoffs[0].result, pickup.file);
  assert.equal(f.read().items.find(i => i.id === 'I1').status, 'open');
  const before = readFileSync(f.file, 'utf8');
  state.handoverTaken(f.repo, 'r1', { by: 'successor', handoff: 'H1' }); assert.equal(readFileSync(f.file, 'utf8'), before);
});

const malformedDiscipline = f => [{ scope: null }, { scope: { outcome: '', nonGoals: [], files: [] } }, { deferrals: {} }, { deferrals: [{ id: 'D1', item: 'Later', reason: '' }] }, { items: [owedItem, owedItem] }, { items: [{ ...owedItem, owner: '' }] }, { items: [{ ...owedItem, next: '' }] }, { items: [{ ...owedItem, status: 'parked', reason: '' }] }, { handoffs: null }, { handoffs: [{ ...handoffRecord(f), state: 'done', result: 'result.md' }] }, { scope: { outcome: 'Broken', files: {}, nonGoals: null } }, { items: {} }, { items: [null, 1, []] }, { handoffs: {} }, { handoffs: [null, 1, []] }, { handoffs: [{ id: 'Hbad', state: 'sent' }] }, { handoffs: [{ id: 'Hbad', state: 'failed' }], items: [null] }, { deferrals: [null, 1, []] }];

test('run discipline audit CLI has clean 0, not-ok 1, error 3 and validates malformed optional records', t => {
  const f = acceptedFixture(t), legacy = f.read();
  assert.equal(stateCli(f, 'audit').status, 0);
  for (const patch of malformedDiscipline(f)) {
    writeFileSync(f.file, JSON.stringify({ ...legacy, ...patch }));
    assert.equal(stateCli(f, 'audit').status, 1, JSON.stringify(patch));
  }
  writeFileSync(f.file, '{broken'); assert.equal(stateCli(f, 'audit').status, 3);
  writeFileSync(f.file, JSON.stringify(legacy)); assert.equal(stateCli(f, 'audit').status, 0);
  state.setGate(f.repo, 'r1', { gate: 'build', status: 'in_progress' }); assert.equal(stateCli(f, 'audit').status, 1);
});

test('run discipline status is one read-only escaped table with gates, caps, items, handoffs and deferrals', t => {
  const f = acceptedFixture(t);
  assert.equal(disciplineCli(f, 'item', 'add', { ...owedItem, item: 'Fix | row\nnext line' }).status, 0);
  assert.equal(disciplineCli(f, 'handoff', 'add', handoffRecord(f)).status, 0);
  assert.equal(disciplineCli(f, 'defer', null, { id: 'D1', item: 'Later', reason: 'Outside scope' }).status, 0);
  const before = readFileSync(f.file, 'utf8'), r = stateCli(f, 'status'); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\| Kind \| ID \|/);
  for (const text of ['I1', 'writer', 'Run RED proof', 'H1', 'successor', 'done-jev', 'code-review', '0\/2', 'D1', 'Outside scope']) assert.ok(r.stdout.includes(text), text);
  assert.ok(r.stdout.includes('Fix &#124; row<br>next line'));
  assert.equal(r.stdout.split('\n').filter(l => l.startsWith('| Kind |')).length, 1);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(state.LOOP_CAPS, { 'plan-review': 1, 'jev-plan': 3, 'audit-check': 3, 'code-review': 2, 'fix-batch': 2, replan: 1, 'base-drift': 2, 'need-context': 2 });
});


test('run discipline concurrent item registrations lose no records or gate/cap state', async t => {
  const f = acceptedFixture(t), before = f.read();
  const results = await Promise.all(Array.from({ length: 12 }, (_, n) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script('run-state.mjs'), 'item', 'add', '--repo', f.repo, '--run', 'r1', '--id', `I${n}`, '--item', 'Bounded work', '--owner', 'writer', '--status', 'open', '--next', 'Run proof'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', x => err += x); child.on('error', reject); child.on('close', code => resolve({ code, err }));
  })));
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(f.read().items.length, 12); assert.equal(new Set(f.read().items.map(i => i.id)).size, 12);
  assert.deepEqual(f.read().gates, before.gates); assert.deepEqual(f.read().loops, before.loops);
});

test('run discipline malformed records refuse both close paths; audit cannot pass a missing or failed gate', t => {
  const f = acceptedFixture(t), before = f.read();
  writeFileSync(f.file, JSON.stringify({ ...before, items: [{ ...owedItem, owner: '' }] }));
  for (const args of [['finish'], ['set', '--gate', 'learnings', '--status', 'passed']]) {
    const r = stateCli(f, ...args); assert.equal(r.status, 3, r.stderr); assert.match(r.stderr, /RUN_OWES_WORK/);
    assert.deepEqual(f.read().gates, before.gates);
  }
  const gates = { ...before.gates, 'guard-proof': { status: 'failed' } }; delete gates['done-jev'];
  writeFileSync(f.file, JSON.stringify({ ...before, gates }));
  assert.equal(stateCli(f, 'audit').status, 1); assert.deepEqual(f.read().gates, gates);
  assert.equal(stateCli(f, 'finish').status, 2); assert.deepEqual(f.read().gates, gates);
});

const batchHandoff = (f, kind = 'cross-repo') => {
  const h = { ...handoffRecord(f, kind), itemId: 'B1' };
  mkdirSync(h.target.repo, { recursive: true });
  state.updateDiscipline(f.repo, 'r1', 'item', 'add', { ...owedItem, id: 'B1', status: 'done' });
  return h;
};

test('fix batch H1 pickup by handoff ID completes despite a different successor label and permits finish', t => {
  const f = acceptedFixture(t), h = batchHandoff(f, 'same-repo');
  assert.equal(disciplineCli(f, 'handoff', 'add', h).status, 0);
  writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), 'Carry B1');
  for (const handoff of ['missing', '']) {
    const r = stateCli(f, 'handover-taken', '--by', 'actual-task:42', '--handoff', handoff);
    assert.equal(r.status, 3); assert.equal(f.read().handoffs[0].state, 'sent');
  }
  const r = stateCli(f, 'handover-taken', '--by', 'actual-task:42', '--handoff', 'H1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read().handoffs[0].state, 'done');
  assert.equal(f.read().handoff.takenBy, 'actual-task:42');
  const before = readFileSync(f.file, 'utf8');
  assert.equal(stateCli(f, 'handover-taken', '--by', 'actual-task:42', '--handoff', 'H1').status, 0);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(stateCli(f, 'handover-taken', '--by', 'actual-task:42', '--handoff', 'missing').status, 3);
  assert.equal(stateCli(f, 'finish').status, 0);
});

for (const variant of ['cross-repo', 'failed', 'done']) test(`fix batch H1 pickup rejects ${variant} handoff before consuming NEXT`, t => {
  const f = acceptedFixture(t), h = batchHandoff(f, variant === 'cross-repo' ? variant : 'same-repo');
  if (variant !== 'cross-repo') { h.state = variant; if (variant === 'done') h.result = 'old.md'; }
  writeFileSync(f.file, JSON.stringify({ ...f.read(), handoffs: [h] }));
  const next = join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'); writeFileSync(next, 'Pending');
  assert.throws(() => state.handoverTaken(f.repo, 'r1', { by: 'actual', handoff: 'H1' }), /HANDOFF_PICKUP_INVALID/);
  assert.equal(existsSync(next), true);
});

test('fix batch M1 registration canonicalizes relative and symlink repo identities once', t => {
  const f = acceptedFixture(t), h = batchHandoff(f, 'same-repo');
  const alias = join(f.repo, 'alias'); symlinkSync(f.repo, alias, 'dir');
  h.source.repo = alias; h.target.repo = relative(process.cwd(), f.repo);
  assert.equal(disciplineCli(f, 'handoff', 'add', h).status, 0);
  assert.equal(f.read().handoffs[0].source.repo, realpathSync(f.repo));
  assert.equal(f.read().handoffs[0].target.repo, realpathSync(f.repo));
});

test('fix batch M1 registration rejects nonexistent identities and aliased cross-repo mismatches', t => {
  const f = acceptedFixture(t), h = batchHandoff(f);
  for (const repo of [join(f.repo, 'missing'), './missing-unresolvable-repo']) {
    const r = disciplineCli(f, 'handoff', 'add', { ...h, target: { ...h.target, repo } });
    assert.equal(r.status, 3); assert.match(r.stderr, /HANDOFF_REPO_INVALID/);
  }
  const alias = join(f.repo, 'alias'); symlinkSync(f.repo, alias, 'dir');
  assert.equal(disciplineCli(f, 'handoff', 'add', { ...h, target: { ...h.target, repo: alias } }).status, 3);
});

test('fix batch M1 reads use persisted repos after target disappears; mismatches remain readable and audited', t => {
  const f = acceptedFixture(t), h = batchHandoff(f);
  assert.equal(disciplineCli(f, 'handoff', 'add', h).status, 0);
  rmSync(h.target.repo, { recursive: true });
  const persisted = f.read();
  assert.equal(stateCli(f, 'status').status, 0);
  assert.ok(!state.auditRun(f.repo, 'r1').problems.some(p => /INVALID/.test(p)));
  persisted.handoffs[0].target.repo = persisted.handoffs[0].source.repo;
  writeFileSync(f.file, JSON.stringify(persisted));
  const before = readFileSync(f.file, 'utf8'), r = stateCli(f, 'status');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /HANDOFF_INVALID/);
  assert.equal(stateCli(f, 'audit').status, 1);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('fix batch M2 task labels and pickup share the bounded identity validator; target label is optional', t => {
  const f = acceptedFixture(t), h = batchHandoff(f, 'same-repo');
  for (const task of ['bad label', 'a'.repeat(81), '', '!image']) {
    assert.equal(disciplineCli(f, 'handoff', 'add', { ...h, target: { ...h.target, task } }).status, 3);
    assert.equal(disciplineCli(f, 'handoff', 'add', { ...h, source: { ...h.source, task } }).status, 3);
    assert.throws(() => state.handoverTaken(f.repo, 'r1', { by: task }), /HANDOVER_BY_INVALID/);
  }
  const { task, ...target } = h.target;
  assert.equal(disciplineCli(f, 'handoff', 'add', { ...h, target }).status, 0);
  writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), 'Carry B1');
  state.handoverTaken(f.repo, 'r1', { by: 'a'.repeat(80), handoff: 'H1' });
  assert.equal(f.read().handoffs[0].state, 'done');
});

test('fix batch M3 handoff add requires a known item so failed work can be disposed', t => {
  const f = acceptedFixture(t), h = batchHandoff(f), { itemId, ...withoutItem } = h;
  assert.equal(disciplineCli(f, 'handoff', 'add', withoutItem).status, 3);
  assert.equal(disciplineCli(f, 'handoff', 'add', { ...h, itemId: 'missing' }).status, 3);
  assert.equal(disciplineCli(f, 'handoff', 'add', h).status, 0);
  assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', state: 'failed' }).status, 0);
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'B1', status: 'parked', reason: 'Owner moves work', owner: 'next-owner', next: 'New run' }).status, 0);
  assert.equal(stateCli(f, 'finish').status, 0);
});

test('fix batch M4 finished runs refuse every discipline mutation with RUN_FINISHED', t => {
  const f = acceptedFixture(t), h = batchHandoff(f);
  assert.equal(disciplineCli(f, 'handoff', 'add', h).status, 0);
  assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', state: 'done', result: 'result.md', verification: 'proof.md' }).status, 0);
  assert.equal(stateCli(f, 'finish').status, 0);
  const before = readFileSync(f.file, 'utf8');
  for (const [kind, action, data] of [
    ['scope', null, { outcome: 'Late', nonGoals: [], files: [] }], ['defer', null, { id: 'D1', item: 'Late', reason: 'Late' }],
    ['item', 'add', owedItem], ['item', 'set', { id: 'B1', status: 'open', next: 'Late' }],
    ['handoff', 'add', { ...h, id: 'H2' }], ['handoff', 'set', { id: 'H1', result: 'late.md' }]
  ]) {
    const r = disciplineCli(f, kind, action, data); assert.equal(r.status, 3); assert.match(r.stderr, /RUN_FINISHED/);
    assert.equal(readFileSync(f.file, 'utf8'), before);
  }
});

test('fix batch M5 status neutralizes markdown constructs and every newline form', t => {
  const f = acceptedFixture(t), item = 'slash\\|pipe\rCR\r\nCRLF\nLF ![img](https://x) [link](https://x) `code` <b>&';
  state.updateDiscipline(f.repo, 'r1', 'item', 'add', { ...owedItem, item });
  const table = state.statusTable(f.repo, 'r1');
  assert.ok(table.includes('slash&#92;&#124;pipe<br>CR<br>CRLF<br>LF &#33;&#91;img&#93;(https://x) &#91;link&#93;(https://x) &#96;code&#96; &lt;b&gt;&amp;'), table);
  assert.equal(table.includes('\r'), false);
});

test('fix batch M6 park report carries open and blocked items and all owed handoff states', t => {
  const f = acceptedFixture(t), h = batchHandoff(f);
  for (const status of ['open', 'blocked']) state.updateDiscipline(f.repo, 'r1', 'item', 'add', { ...owedItem, id: status, status, blocker: 'Needs owner' });
  for (const [id, status] of [['sent', 'sent'], ['running', 'running'], ['failed', 'failed'], ['complete', 'done']]) {
    state.updateDiscipline(f.repo, 'r1', 'handoff', 'add', { ...h, id });
    if (status !== 'sent') state.updateDiscipline(f.repo, 'r1', 'handoff', 'set', { id, state: status, ...(status === 'done' ? { result: 'result.md', verification: 'proof.md' } : {}) });
  }
  const parked = state.parkRun(f.repo, 'r1', 'Owner disposition');
  const ids = parked.parked.outstanding.map(x => x.id);
  for (const id of ['open', 'blocked', 'sent', 'running', 'failed']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('complete'));
  const report = readFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), 'utf8');
  for (const id of ['open', 'blocked', 'sent', 'running', 'failed']) assert.ok(report.includes(`"id": "${id}"`), id);
});

test('fix batch LOW blocked needs blocker and parking explicitly names the next owner', t => {
  const f = acceptedFixture(t);
  assert.equal(disciplineCli(f, 'item', 'add', { ...owedItem, status: 'blocked' }).status, 3);
  assert.equal(disciplineCli(f, 'item', 'add', owedItem).status, 0);
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'I1', status: 'blocked', blocker: ' ' }).status, 3);
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'I1', status: 'parked', reason: 'Later' }).status, 3);
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'I1', status: 'parked', owner: 'next-owner' }).status, 3);
  assert.equal(disciplineCli(f, 'item', 'set', { id: 'I1', status: 'parked', owner: 'next-owner', reason: 'Later' }).status, 0);
});

for (const terminal of ['done', 'failed']) test(`fix batch LOW ${terminal} handoff evidence is immutable once set`, t => {
  const f = acceptedFixture(t), h = batchHandoff(f);
  assert.equal(disciplineCli(f, 'handoff', 'add', h).status, 0);
  assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', state: terminal, result: 'result.md', verification: 'proof.md' }).status, 0);
  const before = readFileSync(f.file, 'utf8');
  for (const patch of [{ result: 'changed.md' }, { verification: 'changed.md' }]) {
    const r = disciplineCli(f, 'handoff', 'set', { id: 'H1', ...patch });
    assert.equal(r.status, 3); assert.match(r.stderr, /HANDOFF_EVIDENCE_IMMUTABLE/);
    assert.equal(readFileSync(f.file, 'utf8'), before);
  }
  assert.equal(disciplineCli(f, 'handoff', 'set', { id: 'H1', result: 'result.md', verification: 'proof.md' }).status, 0);
});

test('fix batch LOW status validates run ID and gives finished precedence', t => {
  const f = acceptedFixture(t);
  assert.throws(() => state.statusTable(f.repo, '../escape'), /RUN_ID_INVALID/);
  const r = cli('run-state.mjs', ['status', '--repo', f.repo, '--run', '../escape']); assert.equal(r.status, 3); assert.match(r.stderr, /RUN_ID_INVALID/);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), finished: true, status: 'active' }));
  assert.match(state.statusTable(f.repo, 'r1'), /\| run \| r1 \| finished \|/);
});

for (const pendingState of ['sent', 'running']) for (const keep of [false, true]) test(`batch 2 F1 ${pendingState} pickup without handoff ID refuses before consuming NEXT (keep=${keep})`, t => {
  const f = fixture(t), h = handoffRecord(f, 'same-repo');
  state.updateDiscipline(f.repo, 'r1', 'handoff', 'add', h);
  if (pendingState === 'running') state.updateDiscipline(f.repo, 'r1', 'handoff', 'set', { id: h.id, state: pendingState });
  const next = join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md');
  writeFileSync(next, 'Carry the pending handoff');
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => state.handoverTaken(f.repo, 'r1', { by: 'successor', keep }), /HANDOFF_PICKUP_REQUIRED/);
  assert.equal(readFileSync(next, 'utf8'), 'Carry the pending handoff');
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('batch 2 F2 status renders problem rows for malformed discipline records without writes', t => {
  const f = fixture(t), legacy = f.read(), patches = malformedDiscipline(f);
  for (const patch of patches) {
    writeFileSync(f.file, JSON.stringify({ ...legacy, ...patch }));
    const before = readFileSync(f.file, 'utf8');
    const table = state.statusTable(f.repo, 'r1');
    assert.match(table, /\| problem \|.*invalid.*_INVALID/);
    assert.equal(readFileSync(f.file, 'utf8'), before);
  }
});

for (const mode of ['park', 'loop-cap', 'exception', 'plan-recovery']) test(`batch 2 F2 ${mode} completes with malformed discipline records`, t => {
  const f = fixture(t), legacy = f.read(), patches = malformedDiscipline(f);
  for (const patch of patches) {
    const extra = mode === 'exception' ? { status: 'awaiting-exception', awaitingException: { inputSha256: 'a'.repeat(16) } }
      : mode === 'plan-recovery' ? { loops: { 'jev-plan': 3 }, planPendingOutcomes: 1 } : {};
    writeFileSync(f.file, JSON.stringify({ ...legacy, ...patch, ...extra }));
    if (mode === 'park') state.parkRun(f.repo, 'r1', 'MALFORMED_RECORDS');
    if (mode === 'loop-cap') assert.throws(() => state.countLoop(f.repo, 'r1', 'plan-review'), /LOOP_CAP:plan-review/);
    if (mode === 'exception') assert.throws(() => state.countLoop(f.repo, 'r1', 'plan-review'), /RUN_PARKED: EXCEPTION_NOT_GRANTED/);
    if (mode === 'plan-recovery') state.resetAttempt(f.repo, 'r1', 'plan', { recover: true, reason: 'Lost outcome' });
    assert.match(f.read().status, /^parked:/, JSON.stringify(patch));
    assert.equal(f.read().finished, false);
    assert.ok(existsSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md')));
    for (const field of ['items', 'handoffs', 'deferrals', 'scope']) if (Object.hasOwn(patch, field)) assert.deepEqual(f.read()[field], patch[field]);
  }
});

// Batch 2: regressions for the current candidate.
test('batch2 F1 fresh start is not plan acceptance provenance', t => {
  const f = fixture(t);
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'in_progress' });
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }), /PLAN_PROVENANCE/);
});
for (const verdict of ['revise', 'unavailable']) test(`batch2 F1 ${verdict} cannot be manually passed`, t => {
  const f = fixture(t), submission = randomUUID();
  const attempt = state.reserveAttempt(f.repo, 'r1', 'plan', () => {}, submission);
  state.recordPlanOutcome(f.repo, 'r1', { verdict, submission, attempt, inputSha256: '0123456789abcdef', at: new Date().toISOString() });
  const pass = () => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' });
  assert.throws(pass, /PLAN_PROVENANCE/);
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'in_progress' });
  assert.throws(pass, /PLAN_PROVENANCE/);
});
test('batch2 F1 accepted outcome cannot revive an explicitly failed checkpoint', t => {
  const f = fixture(t), submission = randomUUID();
  const attempt = state.reserveAttempt(f.repo, 'r1', 'plan', () => {}, submission);
  const outcome = { verdict: 'proceed', submission, attempt, inputSha256: '0123456789abcdef', at: new Date().toISOString() };
  state.recordPlanOutcome(f.repo, 'r1', outcome);
  assert.equal(state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }).gates['plan-jev'].status, 'passed');
  assert.throws(() => state.recordPlanOutcome(f.repo, 'r1', outcome), /PLAN_SUBMISSION_UNKNOWN/);
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'failed' });
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }), /PLAN_PROVENANCE/);
});
test('batch2 F1 only explicitly identified legacy reservations pass', t => {
  const f = fixture(t), old = { ...f.read(), attempts: { plan: 1 }, loops: { 'jev-plan': 1 }, history: [], gates: {} };
  writeFileSync(f.file, JSON.stringify(old));
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }), /PLAN_PROVENANCE/);
  writeFileSync(f.file, JSON.stringify({ ...old, legacyPlanReservation: true }));
  assert.equal(state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }).gates['plan-jev'].status, 'passed');
});
test('batch2 F3 dispatch-backed pre-model refunds restore retry credit', t => {
  const f = fixture(t);
  for (let n = 0; n < 4; n++) {
    state.countDispatch(f.repo, 'r1', 'code-reviewer');
    const reservation = randomUUID();
    assert.equal(state.reserveReviewLaunch(f.repo, 'r1', { reservation }), 1);
    assert.equal(state.releaseReviewLaunch(f.repo, 'r1', reservation), true);
    assert.equal(state.releaseReviewLaunch(f.repo, 'r1', reservation), false);
    assert.equal(f.read().loops['code-review-launch'], 0);
    assert.equal(f.read().loops['code-review'], 0);
    assert.doesNotMatch(f.read().status || '', /^parked:/);
  }
});
function batch2Closure(f) {
  auditEvidence(f, true);
  state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
}
function batch2AssertCloses(f) {
  if (f.read().reviewRound) {
    const file = join(f.repo, 'empty-findings.json'); writeFileSync(file, '[]');
    state.updateFindings(f.repo, 'r1', 'sync', { file, round: f.read().reviewRound });
  }
  assert.deepEqual(state.auditRun(f.repo, 'r1').problems, []);
  const finished = stateCli(f, 'finish'); assert.equal(finished.status, 0, finished.stderr);
  assert.equal(state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }).finished, true);
}
test('batch2 F4 anonymous failed dispatch has a bounded recorded disposition', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'writer');
  assert.throws(() => state.finishWorker(f.repo, 'r1', 'anonymous-failure', 'done'), /WORKER_UNKNOWN/);
  state.finishWorker(f.repo, 'r1', 'anonymous-failure', 'failed');
  assert.throws(() => state.finishWorker(f.repo, 'r1', 'extra-failure', 'failed'), /WORKER_UNKNOWN/);
  batch2AssertCloses(f);
});
test('batch2 F4 direct review launches with markdown reports close without dispatches', t => {
  const f = fixture(t); batch2Closure(f);
  const output = join(f.repo, '.trioharness-direct/runs/r1/workers/report-0.md');
  state.reserveReviewLaunch(f.repo, 'r1', { output, reservation: 'direct' }); resultFiles(f, 1);
  assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  assert.equal(stateCli(f, 'worker-done', '--review-reservation', 'direct', '--status', 'done', '--report', output).status, 0);
  batch2AssertCloses(f);
});
test('batch2 F4 dispatched lane review with non-markdown output closes', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  const reservation = randomUUID(); state.reserveReviewLaunch(f.repo, 'r1', { reservation });
  const dir = join(f.repo, '.trioharness-direct/runs/r1');
  writeFileSync(join(dir, 'review.json'), '{}');
  writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({ status: 'completed', reservation, output: join(dir, 'review.json') }) + '\n');
  batch2AssertCloses(f);
});
test('batch2 F4 terminal worker may produce a second markdown report', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'writer');
  state.registerWorker(f.repo, 'r1', { id: 'writer', role: 'writer' });
  finishAttempt(f, 'writer', 'done'); resultFiles(f, 2);
  batch2AssertCloses(f);
});
test('batch2 F5 alternate review receipt layout satisfies closure', t => {
  const f = fixture(t); batch2Closure(f);
  const canonical = join(f.repo, '.trioharness-direct/runs/r1/CODE_REVIEW_ROUNDS.jsonl'); rmSync(canonical);
  const alt = join(f.repo, 'trioharness-direct-runs/r1'); mkdirSync(alt, { recursive: true });
  writeFileSync(join(alt, 'CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({ status: 'completed', output: join(alt, 'review.json') }) + '\n');
  state.setGate(f.repo, 'r1', { gate: 'review', status: 'passed' });
  batch2AssertCloses(f);
});

test('batch2 F2 state reservations share both layouts with coordinator dispatches', t => {
  const f = fixture(t), alt = join(f.repo, 'trioharness-direct-runs/r1');
  mkdirSync(alt, { recursive: true });
  const data = f.read(); rmSync(f.file); writeFileSync(join(alt, 'state.json'), JSON.stringify(data));
  state.reserveReviewLaunch(f.repo, 'r1', { directory: alt });
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  assert.equal(state.reserveReviewLaunch(f.repo, 'r1', { directory: alt }), 2);
  assert.throws(() => state.reserveReviewLaunch(f.repo, 'r1'), /LOOP_CAP:code-review/);
});

function batch3PlanOutcome(f, verdict = 'proceed') {
  const submission = randomUUID(), attempt = state.reserveAttempt(f.repo, 'r1', 'plan', () => {}, submission);
  state.recordPlanOutcome(f.repo, 'r1', { verdict, submission, attempt, inputSha256: '0123456789abcdef', at: new Date().toISOString() });
}
function batch3Invalidate(f, reason) {
  if (reason === 'recovery') {
    state.reserveAttempt(f.repo, 'r1', 'plan', () => {}, randomUUID());
    state.resetAttempt(f.repo, 'r1', 'plan', { recover: true, reason: 'Stopped submission lost its outcome' });
  } else state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: reason });
}
test('batch3 G1 invalidated legacy reservation cannot revive after history rollover', t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), legacyPlanReservation: true, attempts: { plan: 1 }, loops: { 'jev-plan': 1 } }));
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' });
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'failed' });
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'in_progress' });
  for (let i = 0; i < 100; i++) state.setGate(f.repo, 'r1', { gate: 'build', status: 'passed' });
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }), /PLAN_PROVENANCE/);
});
for (const reason of ['failed', 'blocked', 'recovery']) test(`batch3 G1 ${reason} cannot reuse acceptance after restarting`, t => {
  const f = fixture(t); batch3PlanOutcome(f); batch3Invalidate(f, reason);
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'in_progress' });
  // Invalidation must survive the bounded checkpoint history, without timestamp ordering.
  for (let i = 0; i < 100; i++) state.setGate(f.repo, 'r1', { gate: 'build', status: 'passed' });
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }), /PLAN_PROVENANCE/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});
for (const reason of ['failed', 'blocked', 'recovery']) for (const fresh of ['manual', 'automated']) test(`batch3 G1 ${reason} permits fresh ${fresh} provenance`, t => {
  const f = fixture(t); batch3PlanOutcome(f); batch3Invalidate(f, reason);
  if (fresh === 'manual') state.reserveAttempt(f.repo, 'r1', 'plan');
  else batch3PlanOutcome(f);
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'in_progress' });
  assert.equal(state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }).gates['plan-jev'].status, 'passed');
});
for (const verdict of ['revise', 'unavailable']) test(`batch3 G2 fresh manual reservation after ${verdict} can pass`, t => {
  const f = fixture(t); batch3PlanOutcome(f, verdict);
  const pass = () => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' });
  assert.throws(pass, /PLAN_PROVENANCE/);
  state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'in_progress' });
  assert.throws(pass, /PLAN_PROVENANCE/);
  state.reserveAttempt(f.repo, 'r1', 'plan');
  assert.equal(pass().gates['plan-jev'].status, 'passed');
});
for (const scenario of ['missing writer', 'reported review missing writer', 'uncompleted review']) {
  for (const closure of ['audit', 'learnings', 'finish']) test(`batch3 G3 ${scenario} refuses ${closure}`, t => {
    const f = fixture(t); batch2Closure(f);
    if (scenario !== 'uncompleted review') state.countDispatch(f.repo, 'r1', 'writer');
    state.countDispatch(f.repo, 'r1', 'code-reviewer'); state.reserveReviewLaunch(f.repo, 'r1');
    if (scenario !== 'uncompleted review') {
      const dir = join(f.repo, '.trioharness-direct/runs/r1/workers'); mkdirSync(dir);
      const output = join(dir, 'review.md'); writeFileSync(output, 'review result');
      if (scenario === 'reported review missing writer') writeFileSync(join(dir, '../CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({ status: 'completed', output }) + '\n');
    }
    const file = join(f.repo, 'empty-findings.json'); writeFileSync(file, '[]');
    state.updateFindings(f.repo, 'r1', 'sync', { file, round: f.read().reviewRound });
    if (closure === 'audit') assert.ok(state.auditRun(f.repo, 'r1').problems.some(p => /dispatch count/.test(p)));
    else if (closure === 'learnings') assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }), /RUN_AUDIT_UNCLEAN.*dispatch count/);
    else { const r = stateCli(f, 'finish'); assert.notEqual(r.status, 0); assert.match(r.stderr, /RUN_AUDIT_UNCLEAN.*dispatch count/); }
  });
}
for (const status of ['failed', 'stopped']) test(`batch3 G3 abandoned dispatched review closes with ${status} disposition`, t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer'); state.reserveReviewLaunch(f.repo, 'r1');
  finishAttempt(f, 'review-abandoned', status);
  batch2AssertCloses(f);
});


const closureObligationCases = [
  'direct reservation without evidence',
  'writer and direct review share one receipt report',
  'missing writer masked by second external review receipt',
  'writer masked by direct review report',
  'missing writer masked by reviewer failed and receipt',
  'missing writer masked by reviewer stopped and receipt',
  'earlier missing writer with review report',
  'earlier dispatched review reservation without evidence'
];
for (const scenario of closureObligationCases) for (const closure of ['audit', 'learnings', 'finish']) {
  test(`closure obligations ${scenario} refuses ${closure}`, t => {
    const f = fixture(t); batch2Closure(f);
    const dir = join(f.repo, '.trioharness-direct/runs/r1');
    const receipts = [];
    const launch = output => {
      const reservation = randomUUID();
      state.reserveReviewLaunch(f.repo, 'r1', { reservation });
      if (output) {
        mkdirSync(join(dir, 'workers'), { recursive: true });
        const file = join(dir, output); writeFileSync(file, 'review result');
        receipts.push({ status: 'completed', output: file });
        writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), receipts.map(r => JSON.stringify(r)).join('\n') + '\n');
      }
    };
    if (!scenario.includes('without evidence')) state.countDispatch(f.repo, 'r1', 'writer');
    if (scenario.includes('second external') || scenario.includes('reviewer failed') || scenario.includes('reviewer stopped') || scenario.startsWith('earlier')) {
      state.countDispatch(f.repo, 'r1', 'code-reviewer');
    }
    if (scenario.includes('reviewer failed') || scenario.includes('reviewer stopped')) {
      state.registerWorker(f.repo, 'r1', { id: 'reviewer-1', role: 'code-reviewer' });
      launch('review.json');
      state.finishWorker(f.repo, 'r1', 'reviewer-1', scenario.includes('failed') ? 'failed' : 'stopped');
    } else if (scenario.includes('without evidence')) launch();
    else {
      launch('workers/review.md');
      if (scenario.includes('second external')) launch('second-review.json');
      if (scenario === 'earlier missing writer with review report') writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), '{}\n');
    }
    state.setGate(f.repo, 'r1', { gate: 'review', status: 'passed' });
    const file = join(f.repo, 'empty-findings.json'); writeFileSync(file, '[]');
    state.updateFindings(f.repo, 'r1', 'sync', { file, round: f.read().reviewRound });
    if (closure === 'audit') assert.ok(state.auditRun(f.repo, 'r1').problems.some(p => /dispatch count/.test(p)));
    else if (closure === 'learnings') assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }), /RUN_AUDIT_UNCLEAN.*dispatch count/);
    else {
      const r = stateCli(f, 'finish'); assert.notEqual(r.status, 0);
      assert.match(r.stderr, /RUN_AUDIT_UNCLEAN.*dispatch count/);
    }
  });
}
for (const status of ['failed', 'stopped']) test(`closure obligations two reviewers with ${status} attempt and external retry receipt close`, t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.registerWorker(f.repo, 'r1', { id: 'reviewer-1', role: 'code-reviewer' });
  state.reserveReviewLaunch(f.repo, 'r1');
  finishAttempt(f, 'reviewer-1', status);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.registerWorker(f.repo, 'r1', { id: 'reviewer-2', role: 'code-reviewer' });
  const reservation = randomUUID(); state.reserveReviewLaunch(f.repo, 'r1', { reservation });
  const dir = join(f.repo, '.trioharness-direct/runs/r1');
  writeFileSync(join(dir, 'review.json'), '{}');
  writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({ status: 'completed', reservation, output: join(dir, 'review.json') }) + '\n');
  finishAttempt(f, 'reviewer-2', 'done');
  batch2AssertCloses(f);
});
test('closure obligations direct completed receipt and its markdown report count once', t => {
  const f = fixture(t); batch2Closure(f);
  const reservation = randomUUID(); state.reserveReviewLaunch(f.repo, 'r1', { reservation });
  const dir = join(f.repo, '.trioharness-direct/runs/r1'); resultFiles(f, 1);
  writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({ status: 'completed', reservation, output: join(dir, 'workers/report-0.md') }) + '\n');
  batch2AssertCloses(f);
});

for (const closure of ['audit', 'learnings', 'finish']) test(`closure obligations receipt belongs to its completed launch only refuses ${closure}`, t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.registerWorker(f.repo, 'r1', { id: 'reviewer-1', role: 'code-reviewer' });
  const reservation = randomUUID(); state.reserveReviewLaunch(f.repo, 'r1', { reservation });
  const dir = join(f.repo, '.trioharness-direct/runs/r1');
  writeFileSync(join(dir, 'review.json'), '{}');
  writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({ status: 'completed', reservation, output: join(dir, 'review.json') }) + '\n');
  state.finishWorker(f.repo, 'r1', 'reviewer-1', 'failed');
  state.reserveReviewLaunch(f.repo, 'r1');
  const file = join(f.repo, 'empty-findings.json'); writeFileSync(file, '[]');
  state.updateFindings(f.repo, 'r1', 'sync', { file, round: f.read().reviewRound });
  if (closure === 'audit') assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  else if (closure === 'learnings') assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }), /RUN_AUDIT_UNCLEAN/);
  else assert.notEqual(stateCli(f, 'finish').status, 0);
});
test('closure obligations completed direct reservation retains its exact identity', t => {
  const f = fixture(t); batch2Closure(f);
  const reservation = randomUUID(); state.reserveReviewLaunch(f.repo, 'r1', { reservation });
  const dir = join(f.repo, '.trioharness-direct/runs/r1'); resultFiles(f, 1);
  writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({ status: 'completed', reservation, output: join(dir, 'workers/report-0.md') }) + '\n');
  batch2AssertCloses(f);
});
test('closure obligations named plan reviewer report retains its dispatch role', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'plan-reviewer'); resultFiles(f, 0);
  const output = reportFile(f, 'plan-reviewer.md', 'plan review');
  assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  state.registerWorker(f.repo, 'r1', { id: 'plan-reviewer', role: 'plan-reviewer' });
  assert.equal(reportDone(f, 'plan-reviewer', output).status, 0); batch2AssertCloses(f);
});

for (const status of ['failed', 'stopped']) test(`closure obligations direct reservation with its ${status} disposition closes`, t => {
  const f = fixture(t); batch2Closure(f);
  const reservation = randomUUID(); state.reserveReviewLaunch(f.repo, 'r1', { reservation });
  state.registerWorker(f.repo, 'r1', { id: reservation, role: 'code-reviewer' });
  finishAttempt(f, reservation, status);
  batch2AssertCloses(f);
});

for (const closure of ['audit', 'learnings', 'finish']) test(`closure obligations one direct disposition cannot also settle a dispatch refuses ${closure}`, t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.reserveReviewLaunch(f.repo, 'r1');
  const reservation = randomUUID(); state.reserveReviewLaunch(f.repo, 'r1', { reservation });
  state.registerWorker(f.repo, 'r1', { id: reservation, role: 'code-reviewer' });
  state.finishWorker(f.repo, 'r1', reservation, 'failed');
  const file = join(f.repo, 'empty-findings.json'); writeFileSync(file, '[]');
  state.updateFindings(f.repo, 'r1', 'sync', { file, round: f.read().reviewRound });
  if (closure === 'audit') assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  else if (closure === 'learnings') assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }), /RUN_AUDIT_UNCLEAN/);
  else assert.notEqual(stateCli(f, 'finish').status, 0);
});

for (const status of ['failed', 'stopped']) test(`closure obligations same-id ${status} reviewer retry matches its reserved external receipt`, t => {
  const f = fixture(t); batch2Closure(f);
  const dir = join(f.repo, '.trioharness-direct/runs/r1');
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.registerWorker(f.repo, 'r1', { id: 'reviewer-1', role: 'code-reviewer' }, '2026-11-08T10:00:00.000Z');
  state.reserveReviewLaunch(f.repo, 'r1');
  finishAttempt(f, 'reviewer-1', status);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.registerWorker(f.repo, 'r1', { id: 'reviewer-1', role: 'code-reviewer' }, '2026-11-08T10:01:00.000Z');
  const reservation = randomUUID(); state.reserveReviewLaunch(f.repo, 'r1', { reservation });
  writeFileSync(join(dir, 'review.json'), '{}');
  writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({ status: 'completed', reservation, output: join(dir, 'review.json') }) + '\n');
  finishAttempt(f, 'reviewer-1', 'done');
  batch2AssertCloses(f);
});

function closureReceipt(f, reservation, name = 'review.json') {
  const dir = join(f.repo, '.trioharness-direct/runs/r1');
  writeFileSync(join(dir, name), '{}');
  writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), JSON.stringify({ status: 'completed', ...(reservation ? { reservation } : {}), output: join(dir, name) }) + '\n');
}
function closureFindings(f) {
  const file = join(f.repo, 'empty-findings.json'); writeFileSync(file, '[]');
  state.updateFindings(f.repo, 'r1', 'sync', { file, round: f.read().reviewRound });
}
test('closure root regression 1 legacy receipt cannot cover a missing identified retry', t => {
  for (const status of ['failed', 'stopped']) {
    const f = fixture(t); batch2Closure(f);
    state.countDispatch(f.repo, 'r1', 'code-reviewer');
    state.registerWorker(f.repo, 'r1', { id: 'reviewer-1', role: 'code-reviewer' });
    state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'launch-1' });
    finishAttempt(f, 'reviewer-1', status);
    state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'launch-2' });
    closureReceipt(f); closureFindings(f);
    assert.equal(state.auditRun(f.repo, 'r1').ok, false, `${status} and an unbound legacy receipt leave launch-2 open`);
    closureReceipt(f, 'launch-2'); batch2AssertCloses(f);
  }
});
test('closure root regression 2 dispatch refund closes its obligation before a direct retry', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'refunded' });
  assert.equal(state.releaseReviewLaunch(f.repo, 'r1', 'refunded'), true);
  closureFindings(f);
  assert.equal(state.auditRun(f.repo, 'r1').ok, true, 'the refunded dispatch has no outstanding evidence obligation');
  state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'retry' });
  closureReceipt(f, 'retry'); batch2AssertCloses(f);
  assert.equal(f.read().loops['code-review'], 1);
  assert.equal(f.read().loops['code-review-launch'], 1);
});
test('closure root regression 3 reverse registration preserves explicit launch ownership', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'launch-a' });
  state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'launch-b' });
  state.registerWorker(f.repo, 'r1', { id: 'worker-b', role: 'code-reviewer', reviewReservation: 'launch-b' });
  state.finishWorker(f.repo, 'r1', 'worker-b', 'stopped');
  state.registerWorker(f.repo, 'r1', { id: 'worker-a', role: 'code-reviewer', reviewReservation: 'launch-a' });
  const data = f.read(); data.workers['worker-a'].status = 'done'; writeFileSync(f.file, JSON.stringify(data));
  closureReceipt(f, 'launch-a'); closureFindings(f);
  assert.equal(state.auditRun(f.repo, 'r1').ok, true, 'launch-a receipt and launch-b disposition cover their own obligations');
  closureReceipt(f, 'launch-b');
  assert.equal(state.auditRun(f.repo, 'r1').ok, false, 'launch-b receipt cannot also close launch-a');
  closureReceipt(f, 'launch-a'); batch2AssertCloses(f);
});
test('closure root regression 4 open reservation survives bounded history rollover', t => {
  const f = fixture(t); batch2Closure(f);
  state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'durable-launch' });
  for (let i = 0; i < 110; i++) state.setGate(f.repo, 'r1', { gate: 'build', status: 'passed' });
  assert.equal(f.read().history.length, 100);
  assert.equal(f.read().history.some(h => h.reviewLaunch), false);
  closureReceipt(f, 'durable-launch'); batch2AssertCloses(f);
});

test('closure root legacy receipts match only legacy obligations one-to-one', t => {
  const f = fixture(t); batch2Closure(f);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), dispatches: { 'code-reviewer': 2 }, loops: { 'code-review-launch': 2 } }));
  closureReceipt(f);
  assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  const dir = join(f.repo, '.trioharness-direct/runs/r1');
  writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), ['one', 'two'].map(name => JSON.stringify({ status: 'completed', output: join(dir, `${name}.json`) })).join('\n') + '\n');
  batch2AssertCloses(f);
  const modern = fixture(t); batch2Closure(modern);
  state.countDispatch(modern.repo, 'r1', 'code-reviewer');
  closureReceipt(modern); closureFindings(modern);
  assert.equal(state.auditRun(modern.repo, 'r1').ok, false, 'a new dispatch has an identity before launch');
});
for (const count of [1, 2]) test(`duplicate named dispatch refuses without changing state at code-review count ${count}`, t => {
  const f = fixture(t);
  for (const worker of ['worker-a', 'worker-b'].slice(0, count)) {
    const result = stateCli(f, 'dispatch', '--role', 'code-reviewer', '--worker', worker);
    assert.equal(result.status, 0, result.stderr);
  }
  const before = readFileSync(f.file);
  const result = stateCli(f, 'dispatch', '--role', 'code-reviewer', '--worker', 'worker-a');
  assert.equal(result.status, 3);
  assert.match(result.stderr, /DISPATCH_ALREADY_RECORDED/);
  assert.match(result.stderr, /fresh worker id/i);
  assert.deepEqual(readFileSync(f.file), before);
  assert.notEqual(f.read().status?.startsWith('parked:'), true);
});
for (const named of [true, false]) test(`code-review dispatch still counts and parks at cap, named=${named}`, t => {
  const f = fixture(t);
  for (const worker of ['worker-a', 'worker-b']) {
    const result = stateCli(f, 'dispatch', '--role', 'code-reviewer', ...(named ? ['--worker', worker] : []));
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(f.read().loops['code-review'], 2);
  assert.equal(f.read().dispatches['code-reviewer'], 2);
  const result = stateCli(f, 'dispatch', '--role', 'code-reviewer', ...(named ? ['--worker', 'worker-c'] : []));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /LOOP_CAP:code-review/);
  assert.equal(f.read().status, 'parked:LOOP_CAP:code-review');
  assert.equal(f.read().loops['code-review'], 2);
  assert.equal(f.read().dispatches['code-reviewer'], 2);
  assert.equal(Object.hasOwn(f.read().workers || {}, 'worker-c'), false);
});
test('closure root named dispatches launch in reverse order with durable worker bindings', t => {
  const f = fixture(t); batch2Closure(f);
  for (const worker of ['worker-a', 'worker-b']) assert.equal(stateCli(f, 'dispatch', '--role', 'code-reviewer', '--worker', worker).status, 0);
  const dispatchIds = f.read().closureObligations.map(o => o.id);
  assert.equal(new Set(dispatchIds).size, 2);
  assert.throws(() => state.reserveReviewLaunch(f.repo, 'r1'), /REVIEW_WORKER_REQUIRED/);
  state.reserveReviewLaunch(f.repo, 'r1', { worker: 'worker-b', reservation: 'launch-b' });
  state.reserveReviewLaunch(f.repo, 'r1', { worker: 'worker-a', reservation: 'launch-a' });
  assert.deepEqual(f.read().closureObligations.map(o => o.id), dispatchIds);
  state.finishWorker(f.repo, 'r1', 'worker-b', 'failed');
  finishAttempt(f, 'worker-a', 'done');
  closureReceipt(f, 'launch-a'); batch2AssertCloses(f);
});
test('closure root explicit dispatch reservation is reused and cannot be duplicated', t => {
  const f = fixture(t); batch2Closure(f);
  assert.equal(stateCli(f, 'dispatch', '--role', 'code-reviewer', '--worker', 'reviewer', '--review-reservation', 'reserved').status, 0);
  const before = f.read();
  assert.notEqual(stateCli(f, 'dispatch', '--role', 'code-reviewer', '--review-reservation', 'reserved').status, 0);
  assert.deepEqual(f.read(), before);
  state.reserveReviewLaunch(f.repo, 'r1', { worker: 'reviewer', reservation: 'reserved' });
  assert.equal(f.read().closureObligations.length, 1);
  assert.equal(f.read().closureObligations[0].id, 'reserved');
  assert.throws(() => state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'reserved' }), /REVIEW_RESERVATION_USED/);
  finishAttempt(f, 'reviewer', 'done');
  closureReceipt(f, 'reserved'); batch2AssertCloses(f);
});
test('closure root legacy launch identity is retained before trimming and can be refunded', t => {
  const f = fixture(t); batch2Closure(f);
  state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'legacy-ticket' });
  const old = f.read(); delete old.closureObligations; writeFileSync(f.file, JSON.stringify(old));
  for (let i = 0; i < 105; i++) state.recordCloseout(f.repo, 'r1');
  assert.equal(f.read().history.some(h => h.reviewLaunch), false);
  assert.equal(state.releaseReviewLaunch(f.repo, 'r1', 'legacy-ticket'), true);
  assert.equal(state.releaseReviewLaunch(f.repo, 'r1', 'legacy-ticket'), false);
  batch2AssertCloses(f);
});

test('closure root worker named at launch can register after anonymous dispatch', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.reserveReviewLaunch(f.repo, 'r1', { worker: 'late-worker', reservation: 'late-launch' });
  state.registerWorker(f.repo, 'r1', { id: 'late-worker', role: 'code-reviewer', reviewReservation: 'late-launch' });
  finishAttempt(f, 'late-worker', 'done');
  closureReceipt(f, 'late-launch'); batch2AssertCloses(f);
  assert.equal(f.read().closureObligations.length, 1, 'launch and dispatch retain one shared obligation');
});

test('closure AMEND F1 retry never inherits its workers stale terminal disposition', t => {
  for (const status of ['failed', 'stopped', 'done']) {
    const f = fixture(t); batch2Closure(f);
    state.countDispatch(f.repo, 'r1', 'code-reviewer');
    state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer' });
    state.reserveReviewLaunch(f.repo, 'r1', { worker: 'w', reservation: 'old' });
    finishAttempt(f, 'w', status);
    closureReceipt(f, 'old');
    state.reserveReviewLaunch(f.repo, 'r1', { worker: 'w', reservation: 'retry' });
    closureFindings(f);
    assert.equal(state.auditRun(f.repo, 'r1').ok, false, `${status} belongs to old, not retry`);
    assert.notEqual(stateCli(f, 'finish').status, 0);
    assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' }), /RUN_AUDIT_UNCLEAN/);
    assert.equal(f.read().workers.w.reviewReservation, 'old');
    const dir = join(f.repo, '.trioharness-direct/runs/r1');
    const receipts = ['old', 'retry'].map(reservation => ({ status: 'completed', reservation, output: join(dir, `${reservation}.json`) }));
    writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), receipts.map(r => JSON.stringify(r)).join('\n') + '\n');
    batch2AssertCloses(f);
  }
  const f = fixture(t); batch2Closure(f);
  assert.equal(stateCli(f, 'dispatch', '--role', 'code-reviewer', '--worker', 'w', '--review-reservation', 'closed-before-launch').status, 0);
  state.finishWorker(f.repo, 'r1', 'w', 'failed');
  assert.throws(() => state.reserveReviewLaunch(f.repo, 'r1', { worker: 'w', reservation: 'closed-before-launch' }), /REVIEW_RESERVATION_USED/);
});
test('closure AMEND F2 late retry registration archives only the prior obligation', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer' });
  state.reserveReviewLaunch(f.repo, 'r1', { worker: 'w', reservation: 'old' });
  state.finishWorker(f.repo, 'r1', 'w', 'failed');
  state.reserveReviewLaunch(f.repo, 'r1', { worker: 'w', reservation: 'new' });
  assert.doesNotThrow(() => state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer', reviewReservation: 'new' }));
  const obligations = f.read().closureObligations;
  assert.equal(obligations.find(o => o.reservation === 'old').worker, 'w.attempt-1');
  assert.equal(obligations.find(o => o.reservation === 'new').worker, 'w');
  assert.equal(f.read().workers['w.attempt-1'].reviewReservation, 'old');
  finishAttempt(f, 'w', 'done');
  closureReceipt(f, 'new'); batch2AssertCloses(f);
});
test('closure AMEND F4 parent state migrates a sole reserved legacy worker', t => {
  for (const status of ['failed', 'stopped']) {
    const f = fixture(t); batch2Closure(f);
    const old = { ...f.read(), dispatches: { 'code-reviewer': 1 }, loops: { 'code-review': 1, 'code-review-launch': 1 },
      workers: { w: { role: 'code-reviewer', status, at: '2026-11-08T10:00:00.000Z', endedAt: '2026-11-08T10:01:00.000Z' } },
      history: [...f.read().history, { at: '2026-11-08T10:00:30.000Z', reviewLaunch: { id: 'parent-reservation', charged: false, refunded: false } }] };
    writeFileSync(f.file, JSON.stringify(old));
    assert.equal(state.auditRun(f.repo, 'r1').ok, true, '8d417cd state has no worker.reviewReservation');
    batch2AssertCloses(f);
  }
  const f = fixture(t); batch2Closure(f);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), dispatches: { 'code-reviewer': 2 }, loops: { 'code-review': 2, 'code-review-launch': 1 },
    workers: { w: { role: 'code-reviewer', status: 'failed' } },
    history: [...f.read().history, { reviewLaunch: { id: 'parent-reservation', charged: false, refunded: false } }] }));
  closureReceipt(f, 'parent-reservation');
  assert.equal(state.auditRun(f.repo, 'r1').ok, false, 'ambiguous legacy ownership cannot spend an old disposition on another dispatch');
});
test('closure AMEND F5 CLI dispositions an unregistered launch by reservation only', t => {
  for (const dispatched of [false, true]) for (const status of ['failed', 'stopped']) {
    const f = fixture(t); batch2Closure(f);
    if (dispatched) state.countDispatch(f.repo, 'r1', 'code-reviewer');
    state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'abandoned' });
    const done = stateCli(f, 'worker-done', '--review-reservation', 'abandoned', '--status', status);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(f.read().workers || {}, {}, 'a disposition does not invent a worker');
    const before = f.read();
    assert.notEqual(stateCli(f, 'worker-done', '--review-reservation', 'missing', '--status', status).status, 0);
    assert.notEqual(stateCli(f, 'worker-done', '--review-reservation', 'abandoned', '--status', 'done').status, 0);
    assert.deepEqual(f.read(), before);
    state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'sibling' }); closureFindings(f);
    assert.equal(state.auditRun(f.repo, 'r1').ok, false, 'abandoned cannot also dispose sibling');
    assert.equal(stateCli(f, 'worker-done', '--review-reservation', 'sibling', '--status', status).status, 0);
    batch2AssertCloses(f);
  }
});
test('closure AMEND F6 role-named reports cannot cover a sibling reserved launch', t => {
  for (const name of ['final-review.md', 'code-reviewer-summary.md']) {
    const f = fixture(t); batch2Closure(f);
    for (const worker of ['worker-a', 'worker-b']) {
      state.countDispatch(f.repo, 'r1', 'code-reviewer');
      state.registerWorker(f.repo, 'r1', { id: worker, role: 'code-reviewer' });
      state.reserveReviewLaunch(f.repo, 'r1', { worker, reservation: worker });
      const data = f.read(); data.workers[worker].status = 'done'; writeFileSync(f.file, JSON.stringify(data));
    }
    closureReceipt(f, 'worker-a'); closureFindings(f);
    const dir = join(f.repo, '.trioharness-direct/runs/r1/workers'); mkdirSync(dir);
    writeFileSync(join(dir, name), 'generic role report');
    assert.equal(state.auditRun(f.repo, 'r1').ok, false, name);
    assert.notEqual(stateCli(f, 'finish').status, 0);
    rmSync(join(dir, name)); const output = reportFile(f, 'worker-b.md', 'named worker report');
    assert.equal(reportDone(f, 'worker-b', output).status, 0); batch2AssertCloses(f);
  }
});

test('closure AMEND G3 refund unbinds the worker before relaunch', t => {
  for (const status of ['failed', 'stopped']) {
    const f = fixture(t); batch2Closure(f);
    state.countDispatch(f.repo, 'r1', 'code-reviewer');
    state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer' });
    state.reserveReviewLaunch(f.repo, 'r1', { worker: 'w', reservation: 'r-1' });
    assert.equal(state.releaseReviewLaunch(f.repo, 'r1', 'r-1'), true);
    state.reserveReviewLaunch(f.repo, 'r1', { worker: 'w', reservation: 'r-2' });
    assert.equal(f.read().workers.w.reviewReservation, 'r-2');
    assert.equal(f.read().closureObligations.find(o => o.reservation === 'r-1').refunded, true);
    assert.equal(f.read().loops['code-review'], 1);
    assert.equal(f.read().loops['code-review-launch'], 1);
    finishAttempt(f, 'w', status);
    batch2AssertCloses(f);
  }
});
test('closure AMEND G4 a worker id is not evidence for a reservation after pre-launch failure', t => {
  for (const status of ['failed', 'stopped']) for (const legacy of [false, true]) {
    const f = fixture(t); batch2Closure(f);
    state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer' });
    finishAttempt(f, 'w', status);
    state.reserveReviewLaunch(f.repo, 'r1', { worker: 'w', reservation: 'w' });
    if (legacy) {
      const old = f.read(); delete old.closureObligations;
      old.workers.w.at = '2026-01-01T00:00:00.000Z';
      old.workers.w.endedAt = '2026-01-02T00:00:00.000Z';
      writeFileSync(f.file, JSON.stringify(old));
    }
    closureFindings(f);
    assert.equal(state.auditRun(f.repo, 'r1').ok, false, 'pre-launch terminal status has no reviewReservation binding');
    assert.notEqual(stateCli(f, 'finish').status, 0);
    if (status === 'failed') assert.equal(stateCli(f, 'worker-done', '--review-reservation', 'w', '--status', 'failed').status, 0);
    else {
      assert.doesNotThrow(() => state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer', reviewReservation: 'w' }));
      state.finishWorker(f.repo, 'r1', 'w', 'stopped');
    }
    batch2AssertCloses(f);
  }
});


test('closure binding R2 legacy terminal binding uses identities and cardinality, never clocks', t => {
  for (const ambiguous of [false, true]) {
    const f = fixture(t); batch2Closure(f);
    const old = { ...f.read(), reviewRound: 1, dispatches: { 'code-reviewer': ambiguous ? 2 : 1 }, loops: { 'code-review': 1, 'code-review-launch': 1 },
      workers: { w: { role: 'code-reviewer', status: 'failed', endedAt: '1900-01-01T00:00:00.000Z' } },
      history: [...f.read().history, { at: '2099-01-01T00:00:00.000Z', reviewLaunch: { id: 'legacy', charged: false } }] };
    if (ambiguous) {
      old.dispatches = { 'code-reviewer': 1 };
      old.reviewRound = 2;
      old.loops = { 'code-review': 2, 'code-review-launch': 2 };
      old.history.push({ at: '1800-01-01T00:00:00.000Z', reviewLaunch: { id: 'extra', charged: true } });
    }
    writeFileSync(f.file, JSON.stringify(old));
    if (!ambiguous) batch2AssertCloses(f);
    else {
      closureReceipt(f, 'extra'); closureFindings(f);
      assert.equal(state.auditRun(f.repo, 'r1').ok, false);
      assert.equal(stateCli(f, 'worker-done', '--review-reservation', 'legacy', '--status', 'failed').status, 0);
      batch2AssertCloses(f);
    }
  }
});

// Dispositions bind bytes to an obligation. Filenames and filesystem clocks do not.
function reportFile(f, name = 'w.md', content = 'report') {
  const dir = join(f.repo, '.trioharness-direct/runs/r1/workers'); mkdirSync(dir, { recursive: true });
  const file = join(dir, name); writeFileSync(file, content); return file;
}
function finishAttempt(f, worker, status = 'done') {
  return state.finishWorker(f.repo, 'r1', worker, status, undefined, status === 'done'
    ? { report: reportFile(f, `${worker}-${randomUUID()}.md`, `completed attempt report ${randomUUID()}`) } : {});
}
function reportDone(f, worker, file, status = 'done') {
  return stateCli(f, 'worker-done', '--worker', worker, '--status', status, '--report', file);
}
for (const name of ['W.md', 'report-1.md', 'code-reviewer-1.md']) test(`explicit binding D1 never infers ${name}`, t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer');
  state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer' });
  const output = reportFile(f, name);
  const data = f.read(); data.workers.w.status = 'done'; writeFileSync(f.file, JSON.stringify(data)); closureFindings(f);
  assert.equal(state.auditRun(f.repo, 'r1').ok, false, 'an unbound file supplies no evidence');
  const result = reportDone(f, 'w', output); assert.equal(result.status, 0, result.stderr);
  const obligation = f.read().closureObligations[0];
  assert.equal(obligation.reportPath, output);
  assert.equal(obligation.size, Buffer.byteLength('report'));
  assert.match(obligation.sha256, /^[a-f0-9]{64}$/);
  batch2AssertCloses(f);
});
test('explicit binding D1 sibling reports require two independent dispositions', t => {
  const f = fixture(t); batch2Closure(f);
  for (const worker of ['writer-1', 'writer-2']) {
    state.countDispatch(f.repo, 'r1', 'writer'); state.registerWorker(f.repo, 'r1', { id: worker, role: 'writer' });
    reportFile(f, `${worker}.md`);
  }
  const data = f.read(); for (const worker of Object.values(data.workers)) worker.status = 'done'; writeFileSync(f.file, JSON.stringify(data));
  assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  assert.equal(reportDone(f, 'writer-1', reportFile(f, 'writer-1.md', 'writer-1 evidence')).status, 0);
  assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  assert.equal(reportDone(f, 'writer-2', reportFile(f, 'writer-2.md', 'writer-2 evidence')).status, 0);
  batch2AssertCloses(f);
});
for (const mutation of ['rewrite', 'delete', 'whitespace']) test(`explicit binding D1 audit rejects ${mutation} of bound bytes`, t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'writer'); state.registerWorker(f.repo, 'r1', { id: 'w', role: 'writer' });
  const output = reportFile(f); assert.equal(reportDone(f, 'w', output).status, 0);
  batch2AssertCloses(f);
  if (mutation === 'delete') rmSync(output); else writeFileSync(output, mutation === 'rewrite' ? 'mutant' : ' \t\n');
  assert.equal(state.auditRun(f.repo, 'r1').ok, false, 'audit rechecks path, size, nonempty bytes and digest');
});
for (const content of ['', ' \t\n']) test(`explicit binding D1 done rejects empty report ${JSON.stringify(content)} atomically`, t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'writer'); state.registerWorker(f.repo, 'r1', { id: 'w', role: 'writer' });
  const output = reportFile(f, 'w.md', content), before = f.read();
  assert.notEqual(reportDone(f, 'w', output).status, 0);
  assert.deepEqual(f.read(), before);
});
test('explicit binding D1 missing report and absent report argument refuse modern done', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'writer'); state.registerWorker(f.repo, 'r1', { id: 'w', role: 'writer' });
  const before = f.read();
  assert.notEqual(reportDone(f, 'w', join(f.repo, 'absent.md')).status, 0);
  reportFile(f);
  assert.notEqual(stateCli(f, 'worker-done', '--worker', 'w', '--status', 'done').status, 0, 'new attempts require an explicit report argument');
  assert.deepEqual(f.read(), before);
});
for (const worker of [false, true]) test(`explicit binding D1 reserved dispatch closes with report, worker=${worker}`, t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer', undefined, { reservation: 'reserved' });
  if (worker) state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer', reviewReservation: 'reserved' });
  const output = reportFile(f, 'arbitrary.txt');
  const result = stateCli(f, 'worker-done', worker ? '--worker' : '--review-reservation', worker ? 'w' : 'reserved', '--status', 'done', '--report', output);
  assert.equal(result.status, 0, result.stderr); batch2AssertCloses(f);
});
for (const change of ['stale', 'touch', 'copy', 'later attempt']) test(`explicit binding D3 retry cannot inherit ${change} bytes`, t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'writer'); state.registerWorker(f.repo, 'r1', { id: 'w', role: 'writer' });
  const original = reportFile(f, 'old.md', 'prior report'); assert.equal(reportDone(f, 'w', original).status, 0);
  state.countDispatch(f.repo, 'r1', 'writer'); state.registerWorker(f.repo, 'r1', { id: 'w', role: 'writer' });
  const output = reportFile(f, 'w.md', 'new attempt report');
  if (change === 'touch') utimesSync(original, new Date('2099-01-01'), new Date('2099-01-01'));
  if (change === 'copy') copyFileSync(original, output);
  if (change === 'later attempt') {
    const data = f.read(); data.workers.w.status = 'done'; writeFileSync(f.file, JSON.stringify(data));
  }
  assert.equal(state.auditRun(f.repo, 'r1').ok, false);
  const before = f.read();
  assert.notEqual(stateCli(f, 'worker-done', '--worker', 'w', '--status', 'done').status, 0);
  assert.deepEqual(f.read(), before);
  if (change === 'copy') {
    assert.notEqual(reportDone(f, 'w', output).status, 0);
    assert.deepEqual(f.read(), before);
    writeFileSync(output, 'new attempt report');
  }
  assert.equal(reportDone(f, 'w', output).status, 0);
  assert.equal(readFileSync(original, 'utf8'), 'prior report'); batch2AssertCloses(f);
});
test('explicit binding D5 late registration never moves new reports or sidecars', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'code-reviewer'); state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer' });
  state.reserveReviewLaunch(f.repo, 'r1', { worker: 'w', reservation: 'old' }); state.finishWorker(f.repo, 'r1', 'w', 'failed');
  state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'new' });
  const output = reportFile(f), context = reportFile(f, 'w.md.review-context.json', '{}');
  state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer', reviewReservation: 'new' });
  assert.equal(readFileSync(output, 'utf8'), 'report'); assert.equal(readFileSync(context, 'utf8'), '{}');
  assert.equal(reportDone(f, 'w', output).status, 0); batch2AssertCloses(f);
});
test('explicit binding D5 registration never renames reports even when a second rename would fail', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'writer'); state.registerWorker(f.repo, 'r1', { id: 'w', role: 'writer' });
  state.finishWorker(f.repo, 'r1', 'w', 'failed');
  const output = reportFile(f), sidecar = reportFile(f, 'w.json', '{}');
  const preload = join(f.repo, 'no-report-renames.mjs');
  writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.renameSync;fs.renameSync=(a,b)=>{if(String(a).includes('/workers/'))throw new Error('REPORT_RENAME_FORBIDDEN');return original(a,b)};syncBuiltinESMExports();`);
  state.countDispatch(f.repo, 'r1', 'writer');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `import { registerWorker } from ${JSON.stringify(pathToFileURL(script('run-state.mjs')).href)}; registerWorker(${JSON.stringify(f.repo)}, 'r1', { id: 'w', role: 'writer' });`],
  { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read().workers['w.attempt-1'].status, 'failed'); assert.equal(f.read().workers.w.status, 'running');
  assert.equal(readFileSync(output, 'utf8'), 'report'); assert.equal(readFileSync(sidecar, 'utf8'), '{}');
});
for (const name of ['w.md', 'W.md']) test(`explicit binding D1 legacy fallback requires exact case ${name}`, t => {
  const f = fixture(t); batch2Closure(f);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), dispatches: { writer: 1 }, workers: { w: { role: 'writer', status: 'running' } } }));
  const output = reportFile(f, name);
  const result = stateCli(f, 'worker-done', '--worker', 'w', '--status', 'done');
  if (name === 'W.md') assert.notEqual(result.status, 0);
  else { assert.equal(result.status, 0, result.stderr); assert.equal(f.read().closureObligations[0].reportPath, output); batch2AssertCloses(f); }
});


test('explicit binding D2 a code-review receipt never closes a writer obligation', t => {
  const f = fixture(t); batch2Closure(f);
  state.countDispatch(f.repo, 'r1', 'writer');
  closureReceipt(f, f.read().closureObligations[0].id);
  assert.equal(state.auditRun(f.repo, 'r1').ok, false);
});

for (const target of ['worker', 'reservation', 'alias']) test(`closure final reused evidence rejects ${target} disposition atomically`, t => {
  const f = fixture(t);
  state.countDispatch(f.repo, 'r1', 'writer'); state.registerWorker(f.repo, 'r1', { id: 'w', role: 'writer' });
  state.countDispatch(f.repo, 'r1', 'code-reviewer', undefined, { reservation: 'second' });
  state.registerWorker(f.repo, 'r1', { id: 'reviewer', role: 'code-reviewer', reviewReservation: 'second' });
  const output = reportFile(f);
  assert.equal(reportDone(f, 'w', output).status, 0);
  assert.equal(reportDone(f, 'w', output).status, 0);
  let reused = output;
  if (target === 'alias') { reused = join(output, '../alias.md'); symlinkSync(output, reused); }
  const before = f.read();
  const result = target === 'reservation'
    ? stateCli(f, 'worker-done', '--review-reservation', 'second', '--status', 'done', '--report', reused)
    : reportDone(f, 'reviewer', reused);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REPORT_ALREADY_BOUND/);
  assert.deepEqual(f.read(), before);
});

for (const target of ['worker', 'reservation', 'symlink', 'sibling prefix']) test(`closure final report scope rejects ${target} escape atomically`, t => {
  const f = fixture(t);
  state.countDispatch(f.repo, 'r1', 'code-reviewer', undefined, { reservation: 'reserved' });
  state.registerWorker(f.repo, 'r1', { id: 'w', role: 'code-reviewer', reviewReservation: 'reserved' });
  const outside = join(f.repo, '.trioharness-direct/runs', target === 'sibling prefix' ? 'r1-extra' : 'r2');
  mkdirSync(outside, { recursive: true });
  let output = join(outside, 'w.md'); writeFileSync(output, 'outside report');
  if (target === 'symlink') { const link = reportFile(f); rmSync(link); symlinkSync(output, link); output = link; }
  const before = f.read();
  const result = target === 'reservation'
    ? stateCli(f, 'worker-done', '--review-reservation', 'reserved', '--status', 'done', '--report', output)
    : reportDone(f, 'w', output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REPORT_OUTSIDE_RUN/);
  assert.deepEqual(f.read(), before);
});

for (const target of ['inside', 'outside', 'parent']) test(`closure final report scope rejects legacy ${target} symlink atomically`, t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), dispatches: { writer: 1 }, workers: { w: { role: 'writer', status: 'running' } } }));
  const dir = join(f.repo, '.trioharness-direct/runs/r1');
  const destination = target === 'inside' ? join(dir, 'other') : join(f.repo, 'outside');
  mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, 'w.md'), 'report');
  if (target === 'parent') symlinkSync(destination, join(dir, 'workers'), 'dir');
  else { mkdirSync(join(dir, 'workers')); symlinkSync(join(destination, 'w.md'), join(dir, 'workers/w.md')); }
  const before = f.read();
  const result = stateCli(f, 'worker-done', '--worker', 'w', '--status', 'done');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REPORT_(SYMLINK|OUTSIDE_RUN)/);
  assert.deepEqual(f.read(), before);
});

for (const target of ['copy', 'hardlink', 'move']) for (const reservation of [false, true]) {
  test(`closure hash disposition rejects ${target} evidence, reservation=${reservation}`, t => {
    const f = fixture(t);
    state.countDispatch(f.repo, 'r1', 'writer'); state.registerWorker(f.repo, 'r1', { id: 'w', role: 'writer' });
    state.countDispatch(f.repo, 'r1', 'code-reviewer', undefined, { reservation: 'second' });
    state.registerWorker(f.repo, 'r1', { id: 'reviewer', role: 'code-reviewer', reviewReservation: 'second' });
    const original = reportFile(f, 'a.md'), reused = join(original, '../b.md');
    assert.equal(reportDone(f, 'w', original).status, 0);
    if (target === 'copy') copyFileSync(original, reused);
    else if (target === 'hardlink') linkSync(original, reused);
    else renameSync(original, reused);
    const before = f.read();
    const reject = () => {
      const result = reservation
        ? stateCli(f, 'worker-done', '--review-reservation', 'second', '--status', 'done', '--report', reused)
        : reportDone(f, 'reviewer', reused);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /REPORT_ALREADY_BOUND/);
      assert.deepEqual(f.read(), before);
    };
    reject();
    if (target === 'move') { symlinkSync(reused, original); reject(); }
  });
}

for (const status of ['done', 'failed']) test(`closure hash audit rejects duplicate bound hashes with ${status} disposition`, t => {
  const f = fixture(t); batch2Closure(f);
  for (const worker of ['first', 'second']) {
    state.countDispatch(f.repo, 'r1', 'writer'); state.registerWorker(f.repo, 'r1', { id: worker, role: 'writer' });
    assert.equal(reportDone(f, worker, reportFile(f, `${worker}.md`, `${worker} evidence`)).status, 0);
  }
  batch2AssertCloses(f);
  const data = f.read(), [first, second] = data.closureObligations;
  copyFileSync(first.reportPath, second.reportPath);
  Object.assign(second, { sha256: first.sha256, size: first.size, disposition: { ...second.disposition, status } });
  writeFileSync(f.file, JSON.stringify(data));
  const before = f.read(), audit = state.auditRun(f.repo, 'r1');
  assert.equal(audit.ok, false);
  assert.equal(audit.workerFiles, 1);
  assert.ok(audit.problems.some(p => /REPORT_ALREADY_BOUND/.test(p)));
  assert.deepEqual(f.read(), before);
});


// Plan pins: real owner cards, snapshot bytes and pre-mutation launch fences.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pinCli = (f, action, ...args) => cli('run-state.mjs', ['plan', action, '--repo', f.repo, '--run', 'r1', ...args]);
function planSource(f, path = 'design/plan.md', bytes = '# Approved plan\n') {
  const file = join(f.repo, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, bytes);
  return { path, file, bytes, digest: sha(bytes) };
}
function approval(f, p, { question = `Approve ${p.path} sha256 ${p.digest}?`, answer = 'approve', via = 'card', status } = {}) {
  const rec = askCard(f.repo, 'r1', { questions: [{ ...card.questions[0], question,
    options: [{ id: 'approve', label: 'Approve this plan', description: 'Use these exact bytes' }, { id: 'reject', label: 'Reject this plan', description: 'Do not use it' }], recommended: 'approve' }] });
  if (status !== 'open') answerCard(f.repo, 'r1', rec.id, { q: answer }, { via, quote: answer === 'approve' ? 'Approve this plan' : 'Reject this plan' });
  if (status === 'assumed') {
    const file = join(f.repo, '.trioharness-direct/runs/r1/questions', `${rec.id}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8')); writeFileSync(file, JSON.stringify({ ...record, status: 'assumed', answeredVia: 'autopilot' }));
  }
  return rec.id;
}
function pin(f, p, options) {
  const id = approval(f, p, options), r = pinCli(f, 'pin', '--path', p.path, '--card', id);
  assert.equal(r.status, 0, r.stderr); return f.read().plans.at(-1);
}
function pickupPlan(f, by = 'successor', handoff) {
  writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), '# Continue\n');
  const r = cli('run-state.mjs', ['handover-taken', '--repo', f.repo, '--run', 'r1', '--by', by, ...(handoff ? ['--handoff', handoff] : [])]);
  assert.equal(r.status, 0, r.stderr); return r;
}
const manifestDigest = (...pins) => sha(pins.map(p => p.sha256).sort().join('\n'));
function ackPlan(f, ...pins) {
  const r = pinCli(f, 'ack', '--digest', manifestDigest(...pins)); assert.equal(r.status, 0, r.stderr); return r;
}
function assertLaunchesBlocked(f) {
  const before = readFileSync(f.file, 'utf8');
  for (const launch of [() => state.countDispatch(f.repo, 'r1', 'writer'), () => state.reserveReviewLaunch(f.repo, 'r1'), () => state.registerWorker(f.repo, 'r1', { id: 'w1', role: 'writer' })]) {
    assert.throws(launch, /PLAN_ACK_REQUIRED/); assert.equal(readFileSync(f.file, 'utf8'), before);
  }
}

function acceptReportException(f, data) {
  const rec = askException({ repo: f.repo, run: 'r1', input: data, item: 'report provenance fixture', receipts: f.log });
  answerCard(f.repo, 'r1', rec.id, { [TOPIC]: 'proceed' }, { via: 'card', quote: 'proceed' });
  grant({ repo: f.repo, run: 'r1', set: rec.id, input: data });
  const result = f.run(data, ['--exception-repo', f.repo, '--exception-run', 'r1'], 'revise', 'plan', false);
  assert.equal(result.status, 0, result.stderr); assert.equal(f.read().status, 'active');
}
function generatedReport(f) {
  const data = { ...plan, after: 'scope-cut' };
  for (let n = 0; n < 3; n++) assert.equal(f.run(data, [], 'revise').status, 2);
  assert.equal(f.read().status, 'awaiting-exception');
  acceptReportException(f, data);
  return join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md');
}
function assertOwnNextAckRefused(f, entry) {
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => state.planCommand(f.repo, 'r1', 'ack', { digest: manifestDigest(entry) }), /PLAN_ACK_REQUIRED:.*hand off/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  const result = pinCli(f, 'ack', '--digest', manifestDigest(entry));
  assert.equal(result.status, 3); assert.match(result.stderr, /PLAN_ACK_REQUIRED:.*hand off/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
}

for (const layout of ['canonical', 'alternate']) test(`plan gaps A2: saved NEXT creation then deletion permanently invalidates an absent ack (${layout})`, t => {
  const f = fixture(t), directory = join(f.repo, layout === 'canonical' ? '.trioharness-direct/runs/r1' : 'trioharness-direct-runs/r1');
  if (layout === 'alternate') { mkdirSync(directory, { recursive: true }); renameSync(f.file, join(directory, 'state.json')); f.file = join(directory, 'state.json'); }
  const entry = pin(f, planSource(f)); ackPlan(f, entry);
  const next = join(directory, 'HANDOVER-NEXT.md'); writeFileSync(next, '# Handoff\n');
  const result = stateCli(f, 'set', '--gate', 'build', '--status', 'in_progress');
  assert.equal(result.status, 0, result.stderr); rmSync(next);
  assertLaunchesBlocked(f); assert.equal(f.read().planAck, null);
  ackPlan(f, entry); state.countDispatch(f.repo, 'r1', 'writer');
});

for (const change of ['modify', 'remove']) test(`plan gaps A2: saved NEXT ${change} then restoration cannot revive a report ack`, t => {
  const f = jevFixture(t), next = generatedReport(f), bytes = readFileSync(next);
  const entry = pin(f, planSource(f)); ackPlan(f, entry);
  if (change === 'remove') rmSync(next); else writeFileSync(next, '# Changed\n', { flag: 'a' });
  state.setGate(f.repo, 'r1', { gate: 'build', status: 'in_progress' }); writeFileSync(next, bytes);
  assertLaunchesBlocked(f); assert.equal(f.read().planAck, null);
  ackPlan(f, entry); state.countDispatch(f.repo, 'r1', 'writer');
});

test('plan gaps A2: successful save with unreadable NEXT invalidates ack without throwing', t => {
  const f = fixture(t), entry = pin(f, planSource(f)); ackPlan(f, entry);
  const next = join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'); mkdirSync(next);
  assert.doesNotThrow(() => state.setGate(f.repo, 'r1', { gate: 'build', status: 'in_progress' })); rmSync(next, { recursive: true });
  assertLaunchesBlocked(f); assert.equal(f.read().planAck, null); ackPlan(f, entry);
});

test('plan gaps A1: own NEXT ack is refused unchanged until consuming pickup', t => {
  const f = fixture(t), entry = pin(f, planSource(f));
  const next = join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'); writeFileSync(next, '# Agent handoff\n');
  assertOwnNextAckRefused(f, entry);
  state.handoverTaken(f.repo, 'r1', { by: 'successor' }); ackPlan(f, entry);
  state.countDispatch(f.repo, 'r1', 'writer');
});

test('plan gaps A1: appending an exception report to own NEXT does not authorize ack after grant', t => {
  const f = jevFixture(t), next = join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md');
  writeFileSync(next, '# Agent handoff\n'); generatedReport(f);
  assert.match(readFileSync(next, 'utf8'), /^# Agent handoff[\s\S]*Awaiting exact-input exception/);
  const entry = pin(f, planSource(f)); assertOwnNextAckRefused(f, entry);
  state.handoverTaken(f.repo, 'r1', { by: 'successor' }); ackPlan(f, entry);
});

test('plan gaps A1: another report write cannot authorize a modified generated report', t => {
  const f = jevFixture(t), next = generatedReport(f);
  writeFileSync(next, '# Agent addition\n', { flag: 'a' });
  const data = { ...plan, after: 'scope-cut', objective: 'Second report input' };
  assert.equal(f.run(data, [], 'revise', 'plan', false).status, 2);
  state.recordPlanOutcome(f.repo, 'r1', { verdict: 'revise', inputSha256: f.receipts().at(-1).inputSha256, at: new Date().toISOString() });
  assert.equal(f.read().status, 'awaiting-exception'); acceptReportException(f, data);
  assert.match(readFileSync(next, 'utf8'), /# Agent addition[\s\S]*Awaiting exact-input exception/);
  const entry = pin(f, planSource(f)); assertOwnNextAckRefused(f, entry);
});

test('plan gaps A1: consuming a generated report clears eligibility for restored old bytes', t => {
  const f = jevFixture(t), next = generatedReport(f), bytes = readFileSync(next);
  const entry = pin(f, planSource(f)); state.handoverTaken(f.repo, 'r1', { by: 'successor' });
  writeFileSync(next, bytes); assertOwnNextAckRefused(f, entry);
  assert.equal(f.read().reportNext, undefined);
});

test('plan gaps residual c: same-bytes report recreation retains acknowledgement', t => {
  const f = jevFixture(t), next = generatedReport(f), bytes = readFileSync(next);
  const entry = pin(f, planSource(f)); ackPlan(f, entry); const ack = f.read().planAck;
  rmSync(next); writeFileSync(next, bytes);
  state.setGate(f.repo, 'r1', { gate: 'build', status: 'in_progress' });
  state.countDispatch(f.repo, 'r1', 'writer'); assert.deepEqual(f.read().planAck, ack);
});

for (const rejectedLaunch of [false, true]) test(`plan gaps residual: create-delete without successful save preserves ack (rejected launch=${rejectedLaunch})`, t => {
  const f = fixture(t), entry = pin(f, planSource(f)); ackPlan(f, entry); const ack = f.read().planAck;
  const next = join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'); writeFileSync(next, '# Transient handoff\n');
  if (rejectedLaunch) assertLaunchesBlocked(f);
  rmSync(next); state.countDispatch(f.repo, 'r1', 'writer'); assert.deepEqual(f.read().planAck, ack);
});

test('plan pin requires exact affirmative owner approval, not refusal, basename, prefix, stale bytes or assumed answer', t => {
  for (const options of [{ answer: 'reject' }, { question: 'Approve plan.md?' }, { question: p => `Approve ${p.path} sha256 ${p.digest.slice(0, 12)}?` },
    { question: p => `Approve other/${p.path} sha256 ${p.digest}?` }, { question: p => `Approve ${p.path} sha256 ${'0'.repeat(64)}?` },
    { status: 'assumed' }, { status: 'open' }]) {
    const f = fixture(t), p = planSource(f), opts = { ...options, ...(typeof options.question === 'function' ? { question: options.question(p) } : {}) };
    const id = approval(f, p, opts), before = readFileSync(f.file, 'utf8');
    const r = pinCli(f, 'pin', '--path', p.path, '--card', id);
    assert.equal(r.status, 3); assert.match(r.stderr, /PLAN_APPROVAL_REQUIRED/); assert.equal(readFileSync(f.file, 'utf8'), before);
  }
});

test('plan pin bounds input, rejects path escape including symlinks and empty files without state mutation', t => {
  const f = fixture(t), p = planSource(f), id = approval(f, p), before = readFileSync(f.file, 'utf8');
  const outside = mkdtempSync(join(tmpdir(), 'thl-plan-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'plan.md'), p.bytes); symlinkSync(outside, join(f.repo, 'escape'));
  for (const path of ['../plan.md', join(outside, 'plan.md'), 'escape/plan.md']) {
    const r = pinCli(f, 'pin', '--path', path, '--card', id); assert.equal(r.status, 3); assert.match(r.stderr, /PLAN_PATH_INVALID/);
  }
  for (const bytes of ['', 'x'.repeat(256 * 1024 + 1)]) {
    writeFileSync(p.file, bytes); const r = pinCli(f, 'pin', '--path', p.path, '--card', id);
    assert.equal(r.status, 3); assert.match(r.stderr, /PLAN_SIZE_INVALID/);
  }
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('plan pin snapshots approved bytes, appends same-path revisions and keeps same-basename paths distinct', t => {
  const f = fixture(t), p = planSource(f), first = pin(f, p);
  assert.equal(first.path, p.path); assert.equal(first.sha256, p.digest); assert.equal(first.approvedBy, 'Q-1');
  const dir = join(f.repo, '.trioharness-direct/runs/r1/plans');
  assert.equal(readFileSync(join(dir, `${first.sha256}.md`), 'utf8'), p.bytes);
  const changed = planSource(f, p.path, '# Revision two\n'), second = pin(f, changed);
  assert.equal(second.supersedes, first.sha256); assert.deepEqual(f.read().plans[0], first);
  const other = planSource(f, 'other/plan.md', '# Other plan\n'), third = pin(f, other);
  assert.equal(f.read().plans.length, 3); assert.equal(third.path, 'other/plan.md');
  pickupPlan(f); ackPlan(f, second, third); // Superseded H1 is history, not part of the active manifest.
  assert.equal(readFileSync(join(dir, `${first.sha256}.md`), 'utf8'), p.bytes);
  assert.equal(readFileSync(join(dir, `${second.sha256}.md`), 'utf8'), changed.bytes);
  state.countDispatch(f.repo, 'r1', 'writer');
});

test('plan list reports live drift independently and acknowledgement reads immutable snapshots', t => {
  const f = fixture(t), p = planSource(f), entry = pin(f, p);
  for (const expected of ['ok', 'changed', 'missing']) {
    if (expected === 'changed') writeFileSync(p.file, 'Unapproved edit');
    if (expected === 'missing') rmSync(p.file);
    const before = readFileSync(f.file, 'utf8'), r = pinCli(f, 'list'); assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout); assert.equal(result.plans[0].live, expected); assert.equal(result.plans[0].sha256, p.digest);
    assert.equal(result.digest, manifestDigest(entry)); assert.equal(readFileSync(f.file, 'utf8'), before);
  }
  pickupPlan(f); ackPlan(f, entry); state.registerWorker(f.repo, 'r1', { id: 'approved-worker' });
  const snapshot = join(f.repo, '.trioharness-direct/runs/r1/plans', `${p.digest}.md`); writeFileSync(snapshot, 'tampered');
  const before = readFileSync(f.file, 'utf8'), r = pinCli(f, 'ack', '--digest', manifestDigest(entry));
  assert.equal(r.status, 3); assert.match(r.stderr, /PLAN_SNAPSHOT_INVALID/); assert.equal(readFileSync(f.file, 'utf8'), before);
  rmSync(snapshot); assert.match(pinCli(f, 'ack', '--digest', manifestDigest(entry)).stderr, /PLAN_SNAPSHOT_INVALID/);
});

test('plan H1: original Architect acknowledges generation none; pickup then requires a fresh ack', t => {
  const f = fixture(t), p = planSource(f), entry = pin(f, p); assertLaunchesBlocked(f);
  ackPlan(f, entry); assert.equal(f.read().planAck.pickup, 'none');
  assert.equal(f.read().handoff, undefined); state.countDispatch(f.repo, 'r1', 'writer');
  const pickup = pickupPlan(f); assert.match(pickup.stdout, /## Pinned plans/); assert.ok(pickup.stdout.includes(p.path) && pickup.stdout.includes(p.digest));
  assert.equal(f.read().planAck, null); assertLaunchesBlocked(f);
  const before = readFileSync(f.file, 'utf8'), wrong = pinCli(f, 'ack', '--digest', '0'.repeat(64));
  assert.equal(wrong.status, 3); assert.match(wrong.stderr, /PLAN_DIGEST_MISMATCH/); assert.equal(readFileSync(f.file, 'utf8'), before);
  ackPlan(f, entry); assert.equal(f.read().planAck.pickup, f.read().handoff.file);
  const acknowledged = readFileSync(f.file, 'utf8'); state.handoverTaken(f.repo, 'r1', { by: 'successor' }); assert.equal(readFileSync(f.file, 'utf8'), acknowledged);
  state.countDispatch(f.repo, 'r1', 'writer'); state.reserveReviewLaunch(f.repo, 'r1'); state.registerWorker(f.repo, 'r1', { id: 'w1', role: 'writer' });
  assert.equal(f.read().dispatches.writer, 2); assert.equal(f.read().workers.w1.status, 'running');
});

test('plan pins invalidate ack on repin, pending handoff and later pickup; stale generation cannot dispatch', t => {
  const f = fixture(t), p = planSource(f), first = pin(f, p); pickupPlan(f); ackPlan(f, first);
  const oldAck = f.read().planAck, h = handoffRecord(f, 'same-repo'); state.updateDiscipline(f.repo, 'r1', 'handoff', 'add', h);
  assertLaunchesBlocked(f);
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => state.updateDiscipline(f.repo, 'r1', 'handoff', 'set', { id: 'H1', state: 'running' }), /PLAN_ACK_REQUIRED/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  pickupPlan(f, 'later-successor', 'H1'); assert.equal(f.read().planAck, null); assertLaunchesBlocked(f);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), planAck: oldAck })); assertLaunchesBlocked(f); ackPlan(f, first);
  const revised = planSource(f, p.path, '# New approved content\n'), second = pin(f, revised);
  assert.equal(f.read().planAck, null); assertLaunchesBlocked(f); ackPlan(f, second); state.countDispatch(f.repo, 'r1', 'writer');
});

test('plan render and park NEXT share all active pins; malformed plan records refuse launches', t => {
  const f = fixture(t), first = pin(f, planSource(f)), second = pin(f, planSource(f, 'other/plan.md', '# Second\n'));
  const r = pinCli(f, 'render'); assert.equal(r.status, 0, r.stderr);
  for (const entry of [first, second]) for (const value of [entry.path, entry.sha256, entry.approvedBy]) assert.ok(r.stdout.includes(value), value);
  state.parkRun(f.repo, 'r1', 'TEST'); const next = readFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), 'utf8');
  assert.ok(next.includes(r.stdout.trim()));
  const g = fixture(t), original = g.read();
  for (const plans of [null, {}, [null], [{ path: '../escape.md', sha256: first.sha256, approvedBy: 'Q-1', at: first.at }],
    [{ ...first, sha256: 'bad' }], [{ ...first, approvedBy: 'assumed' }], [{ ...first, unexpected: true }], [{ ...first, supersedes: first.sha256 }]]) {
    writeFileSync(g.file, JSON.stringify({ ...original, plans })); const before = readFileSync(g.file, 'utf8');
    assert.throws(() => state.countDispatch(g.repo, 'r1', 'writer'), /PLANS_INVALID/); assert.equal(readFileSync(g.file, 'utf8'), before);
    assert.equal(pinCli(g, 'list').status, 3); assert.equal(stateCli(g, 'audit').status, 1);
  }
});

test('runs without pins keep legacy dispatch, review, registration and read-only pickup behavior', t => {
  const f = fixture(t); state.countDispatch(f.repo, 'r1', 'writer'); state.reserveReviewLaunch(f.repo, 'r1'); state.registerWorker(f.repo, 'r1', { id: 'legacy' });
  pickupPlan(f); const before = readFileSync(f.file, 'utf8'); state.handoverTaken(f.repo, 'r1', { by: 'successor' });
  assert.equal(readFileSync(f.file, 'utf8'), before); assert.equal(Object.hasOwn(f.read(), 'plans'), false); assert.equal(Object.hasOwn(f.read(), 'planAck'), false);
  const r = pinCli(f, 'render'); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '');
});


test('plan M1: granted exception report NEXT does not demand a pickup without a recorded handoff', t => {
  const f = jevFixture(t), data = { ...plan, after: 'scope-cut' };
  for (let n = 0; n < 3; n++) assert.equal(f.run(data, [], 'revise').status, 2);
  assert.equal(f.read().status, 'awaiting-exception');
  const rec = askException({ repo: f.repo, run: 'r1', input: data, item: 'quantity fixture', receipts: f.log });
  answerCard(f.repo, 'r1', rec.id, { [TOPIC]: 'proceed' }, { via: 'card', quote: 'proceed' });
  grant({ repo: f.repo, run: 'r1', set: rec.id, input: data });
  const result = f.run(data, ['--exception-repo', f.repo, '--exception-run', 'r1'], 'revise', 'plan', false);
  assert.equal(result.status, 0, result.stderr); assert.equal(f.read().status, 'active');
  const next = join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md');
  assert.ok(existsSync(next)); assert.equal(f.read().handoff, undefined);
  const entry = pin(f, planSource(f)); ackPlan(f, entry);
  assert.equal(f.read().planAck.pickup, 'none'); state.countDispatch(f.repo, 'r1', 'writer');
  state.reserveReviewLaunch(f.repo, 'r1'); state.registerWorker(f.repo, 'r1', { id: 'after-exception' });
  assert.ok(existsSync(next), 'the exception report remains available');
  writeFileSync(f.file, JSON.stringify({ ...f.read(), handoff: { intent: 'next-successor' } }));
  assertLaunchesBlocked(f); // An actual handoff intent must still demand pickup.
});

test('plan L1: each card question binds exactly one path/hash pair in a two-plan card', t => {
  const f = fixture(t), a = planSource(f, 'a.md', '# Plan A\n'), b = planSource(f, 'b.md', '# Plan B\n');
  const question = `Approve ${a.path} sha256 ${a.digest} and ${b.path} sha256 ${b.digest}?`;
  const id = approval(f, a, { question }); writeFileSync(a.file, b.bytes);
  const before = readFileSync(f.file, 'utf8'), bad = pinCli(f, 'pin', '--path', a.path, '--card', id);
  assert.equal(bad.status, 3); assert.match(bad.stderr, /PLAN_APPROVAL_REQUIRED/); assert.equal(readFileSync(f.file, 'utf8'), before);
  // Two plans are fine when each approval question carries its own unambiguous pair.
  writeFileSync(a.file, a.bytes);
  const q = p => ({ ...card.questions[0], id: p.path.replace('.md', ''), question: `Approve ${p.path} sha256 ${p.digest}?`,
    options: [{ id: 'approve', label: 'Approve this plan', description: 'Use these bytes' }, { id: 'reject', label: 'Reject this plan', description: 'Do not use' }], recommended: 'approve' });
  const rec = askCard(f.repo, 'r1', { questions: [q(a), q(b)] });
  answerCard(f.repo, 'r1', rec.id, { a: 'approve', b: 'approve' }, { via: 'card', quote: 'Approve both plans' });
  for (const p of [a, b]) assert.equal(pinCli(f, 'pin', '--path', p.path, '--card', rec.id).status, 0);
  assert.equal(f.read().plans.length, 2);
});

test('plan L2: interrupted snapshot publication leaves no partial final and identical snapshots are reused', t => {
  const f = fixture(t), p = planSource(f), id = approval(f, p), directory = join(f.repo, '.trioharness-direct/runs/r1/plans');
  const snapshot = join(directory, `${p.digest}.md`), preload = join(f.repo, 'interrupt-snapshot.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original = fs.writeFileSync;
fs.writeFileSync = (file, bytes, ...args) => {
  if (String(file).includes('/plans/')) { original(file, String(bytes).slice(0, 4), ...args); throw new Error('SIMULATED_SNAPSHOT_INTERRUPTION'); }
  return original(file, bytes, ...args);
}; syncBuiltinESMExports();`);
  const args = ['plan', 'pin', '--repo', f.repo, '--run', 'r1', '--path', p.path, '--card', id];
  const interrupted = cli('run-state.mjs', args, { env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  assert.equal(interrupted.status, 3); assert.match(interrupted.stderr, /SIMULATED_SNAPSHOT_INTERRUPTION/);
  assert.equal(existsSync(snapshot), false, 'partial bytes must never be published under the final hash');
  assert.deepEqual(readdirSync(directory), []); assert.equal(f.read().plans, undefined);
  assert.equal(cli('run-state.mjs', args).status, 0); const inode = statSync(snapshot).ino;
  assert.equal(cli('run-state.mjs', args).status, 0); assert.equal(statSync(snapshot).ino, inode);
  assert.equal(readFileSync(snapshot, 'utf8'), p.bytes); assert.deepEqual(readdirSync(directory), [`${p.digest}.md`]);
});

test('plan L3: case aliases on an insensitive volume share the canonical path and active pin', t => {
  const f = fixture(t), p = planSource(f, 'design/Plan.md'), alias = 'design/plan.md';
  const aliasExists = existsSync(join(f.repo, alias)), id = approval(f, p);
  const original = pinCli(f, 'pin', '--path', p.path, '--card', id); assert.equal(original.status, 0, original.stderr);
  const before = readFileSync(f.file, 'utf8'), result = pinCli(f, 'pin', '--path', alias, '--card', id);
  if (aliasExists) {
    assert.equal(result.status, 0, result.stderr);
    const pins = f.read().plans; assert.equal(pins.length, 2); assert.equal(pins[0].path, 'design/Plan.md'); assert.equal(pins[1].path, pins[0].path);
  } else {
    assert.equal(result.status, 3); assert.match(result.stderr, /PLAN_PATH_INVALID/);
    assert.equal(readFileSync(f.file, 'utf8'), before); assert.equal(f.read().plans.length, 1);
    assert.equal(f.read().plans[0].path, 'design/Plan.md');
  }
  assert.equal(JSON.parse(pinCli(f, 'list').stdout).plans.length, 1);
});

test('plan L4: malformed pin records remain outstanding without breaking park or awaiting-exception', t => {
  for (const mode of ['park', 'awaiting-exception']) {
    const f = fixture(t), malformed = [{ path: '../invalid.md', sha256: 'bad' }];
    writeFileSync(f.file, JSON.stringify({ ...f.read(), plans: malformed, ...(mode === 'awaiting-exception' ? { loops: { 'jev-plan': 3 } } : {}) }));
    if (mode === 'park') assert.doesNotThrow(() => state.parkRun(f.repo, 'r1', 'PRESERVE_INVALID_PINS'));
    else assert.doesNotThrow(() => state.recordPlanOutcome(f.repo, 'r1', { verdict: 'revise', inputSha256: 'a'.repeat(16), at: new Date().toISOString() }));
    assert.equal(f.read().status, mode === 'park' ? 'parked:PRESERVE_INVALID_PINS' : 'awaiting-exception');
    assert.deepEqual(f.read().plans, malformed);
    const next = readFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), 'utf8');
    assert.match(next, /PIN_RECORDS_INVALID/); assert.match(next, /PLANS_INVALID/); assert.ok(next.includes('../invalid.md'));
  }
});

test('plan L5: pin and ack preserve alternate-layout state and snapshots without a split ledger', t => {
  const f = fixture(t), p = planSource(f), id = approval(f, p);
  const directory = join(f.repo, 'trioharness-direct-runs/r1'); mkdirSync(directory, { recursive: true });
  const alternate = join(directory, 'state.json'); renameSync(f.file, alternate);
  const r = pinCli(f, 'pin', '--path', p.path, '--card', id); assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(f.file), false, 'pin must update the ledger it read, not create a canonical duplicate');
  const entry = JSON.parse(readFileSync(alternate, 'utf8')).plans[0]; assert.equal(entry.sha256, p.digest);
  assert.equal(readFileSync(join(directory, 'plans', `${p.digest}.md`), 'utf8'), p.bytes);
  ackPlan(f, entry); assert.equal(existsSync(f.file), false);
  assert.equal(JSON.parse(readFileSync(alternate, 'utf8')).planAck.pickup, 'none');
  assert.equal(JSON.parse(pinCli(f, 'list').stdout).plans.length, 1);
});


for (const change of ['create', 'append']) test(`plan N-M1 C1: ${change} NEXT after a none ack blocks all launches until fresh ack`, t => {
  const f = jevFixture(t), entry = pin(f, planSource(f));
  const next = join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md');
  if (change === 'append') generatedReport(f);
  ackPlan(f, entry); assert.equal(f.read().planAck.pickup, 'none');
  writeFileSync(next, '# Successor handover\n', { flag: change === 'append' ? 'a' : 'w' });
  assert.equal(f.read().handoff, undefined); assertLaunchesBlocked(f);
  assertOwnNextAckRefused(f, entry);
  state.handoverTaken(f.repo, 'r1', { by: 'fresh-successor' });
  ackPlan(f, entry);
  state.countDispatch(f.repo, 'r1', 'writer'); state.reserveReviewLaunch(f.repo, 'r1');
  state.registerWorker(f.repo, 'r1', { id: 'fresh-successor', role: 'writer' });
  assert.equal(f.read().dispatches.writer, 1); assert.equal(f.read().workers['fresh-successor'].status, 'running');
});

test('plan N-M1 C2: unchanged report NEXT predating a none ack permits all launches', t => {
  const f = jevFixture(t), entry = pin(f, planSource(f));
  const next = generatedReport(f), bytes = readFileSync(next, 'utf8');
  assert.equal(f.read().reportNext, sha(bytes));
  ackPlan(f, entry); assert.equal(f.read().planAck.pickup, 'none');
  state.countDispatch(f.repo, 'r1', 'writer'); state.reserveReviewLaunch(f.repo, 'r1');
  state.registerWorker(f.repo, 'r1', { id: 'after-report', role: 'writer' });
  assert.equal(readFileSync(next, 'utf8'), bytes);
  assert.equal(f.read().dispatches.writer, 1); assert.equal(f.read().workers['after-report'].status, 'running');
});

test('plan N-L1 C3: alternate-layout pickup preserves its ledger and snapshots for successor ack', t => {
  const f = fixture(t), p = planSource(f), id = approval(f, p);
  const directory = join(f.repo, 'trioharness-direct-runs/r1'); mkdirSync(directory, { recursive: true });
  const alternate = join(directory, 'state.json'); renameSync(f.file, alternate);
  const pinned = pinCli(f, 'pin', '--path', p.path, '--card', id); assert.equal(pinned.status, 0, pinned.stderr);
  const entry = JSON.parse(pinned.stdout); ackPlan(f, entry);
  const next = join(directory, 'HANDOVER-NEXT.md'); writeFileSync(next, '# Alternate successor\n');
  const pickup = state.handoverTaken(f.repo, 'r1', { by: 'alternate-successor' });
  assert.equal(existsSync(next), false); assert.equal(existsSync(f.file), false);
  assert.equal(readFileSync(join(directory, pickup.file), 'utf8'), '# Alternate successor\n');
  assert.equal(JSON.parse(readFileSync(alternate, 'utf8')).planAck, null);
  ackPlan(f, entry);
  assert.equal(existsSync(f.file), false);
  assert.equal(JSON.parse(readFileSync(alternate, 'utf8')).planAck.pickup, pickup.file);
  assert.equal(readFileSync(join(directory, 'plans', `${p.digest}.md`), 'utf8'), p.bytes);
});


test('plan correction M-1: NEXT after a TAKEN ack blocks every launch without ledger changes; pickup and fresh ack recover', t => {
  const f = fixture(t), entry = pin(f, planSource(f)); pickupPlan(f, 'B'); ackPlan(f, entry);
  writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), '# B to C\n');
  assert.equal(f.read().handoffs, undefined); assertLaunchesBlocked(f);
  assertOwnNextAckRefused(f, entry);
  state.handoverTaken(f.repo, 'r1', { by: 'C' });
  ackPlan(f, entry);
  state.countDispatch(f.repo, 'r1', 'writer'); state.reserveReviewLaunch(f.repo, 'r1');
  state.registerWorker(f.repo, 'r1', { id: 'fresh-C', role: 'writer' });
  assert.equal(f.read().workers['fresh-C'].status, 'running');
});

test('plan correction M-1: legacy ack needs fresh acknowledgement and NEXT identity rejects malformed types', t => {
  const f = fixture(t), entry = pin(f, planSource(f)); pickupPlan(f); ackPlan(f, entry);
  const legacy = f.read(); delete legacy.planAck.next; writeFileSync(f.file, JSON.stringify(legacy));
  assertLaunchesBlocked(f); ackPlan(f, entry);
  const current = f.read();
  for (const next of [null, [], ['absent'], {}, 123, 'invalid']) {
    writeFileSync(f.file, JSON.stringify({ ...current, planAck: { ...current.planAck, next } }));
    const before = readFileSync(f.file, 'utf8');
    assert.throws(() => state.countDispatch(f.repo, 'r1', 'writer'), /PLANS_INVALID/);
    assert.equal(readFileSync(f.file, 'utf8'), before);
  }
});

test('plan correction L-1: removing NEXT present at a TAKEN ack invalidates every launch until fresh ack', t => {
  const f = jevFixture(t), entry = pin(f, planSource(f)); pickupPlan(f);
  const next = generatedReport(f); ackPlan(f, entry); rmSync(next);
  assertLaunchesBlocked(f); ackPlan(f, entry); state.countDispatch(f.repo, 'r1', 'writer');
});

for (const mode of ['API', 'CLI']) test(`plan correction L-2: alternate pickup ack and repeated ${mode} dispatch/registration never split the ledger`, t => {
  const f = fixture(t), p = planSource(f), id = approval(f, p);
  const directory = join(f.repo, 'trioharness-direct-runs/r1'); mkdirSync(directory, { recursive: true });
  const alternate = join(directory, 'state.json'); renameSync(f.file, alternate);
  const pinned = pinCli(f, 'pin', '--path', p.path, '--card', id); assert.equal(pinned.status, 0, pinned.stderr);
  const entry = JSON.parse(pinned.stdout);
  writeFileSync(join(directory, 'HANDOVER-NEXT.md'), '# Alternate pickup\n');
  state.handoverTaken(f.repo, 'r1', { by: 'alternate-B' }); ackPlan(f, entry);
  for (const worker of ['first', 'second']) {
    if (mode === 'API') {
      state.countDispatch(f.repo, 'r1', 'writer');
      state.registerWorker(f.repo, 'r1', { id: worker, role: 'writer' });
    } else {
      const result = stateCli(f, 'dispatch', '--role', 'writer', '--worker', worker);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(existsSync(f.file), false);
  }
  const ledger = JSON.parse(readFileSync(alternate, 'utf8'));
  assert.equal(ledger.dispatches.writer, 2);
  assert.equal(ledger.workers.first.status, 'running'); assert.equal(ledger.workers.second.status, 'running');
  assert.equal(pinCli(f, 'list').status, 0);
});

test('plan correction L-3: directory NEXT refuses launch and ack with PLAN_ACK_REQUIRED and unchanged ledger', t => {
  const f = fixture(t), entry = pin(f, planSource(f)); ackPlan(f, entry);
  mkdirSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'));
  assertLaunchesBlocked(f);
  const before = readFileSync(f.file, 'utf8'), result = pinCli(f, 'ack', '--digest', manifestDigest(entry));
  assert.equal(result.status, 3); assert.match(result.stderr, /PLAN_ACK_REQUIRED/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});


test('plan final LOW: canonical and alternate lifecycles keep one complete ledger and share its lock', t => {
  for (const layout of ['canonical', 'alternate']) {
    const f = fixture(t), canonical = join(f.repo, '.trioharness-direct/runs/r1');
    const alternate = join(f.repo, 'trioharness-direct-runs/r1');
    const directory = layout === 'alternate' ? alternate : canonical;
    if (layout === 'alternate') { mkdirSync(alternate, { recursive: true }); renameSync(f.file, join(alternate, 'state.json')); }
    const ledger = join(directory, 'state.json'), other = directory === alternate ? canonical : alternate;
    const assertSingleLedger = () => {
      assert.equal(existsSync(ledger), true, layout);
      assert.equal(existsSync(join(other, 'state.json')), false, layout);
    };
    state.countDispatch(f.repo, 'r1', 'writer'); assertSingleLedger();
    state.registerWorker(f.repo, 'r1', { id: 'worker', role: 'writer' }); assertSingleLedger();
    const report = join(directory, 'workers', 'worker.md'); mkdirSync(join(report, '..'), { recursive: true });
    writeFileSync(report, '# Worker evidence\n');
    state.finishWorker(f.repo, 'r1', 'worker', 'done', undefined, { report }); assertSingleLedger();
    state.reserveReviewLaunch(f.repo, 'r1', { reservation: 'review' }); assertSingleLedger();
    const reviewReport = join(directory, 'workers', 'review.md'); writeFileSync(reviewReport, '# Review evidence\n');
    const finished = stateCli(f, 'worker-done', '--review-reservation', 'review', '--status', 'done', '--report', reviewReport);
    assert.equal(finished.status, 0, finished.stderr); assertSingleLedger();
    state.setGate(f.repo, 'r1', { gate: 'build', status: 'in_progress' }); assertSingleLedger();
    assert.equal(state.countLoop(f.repo, 'r1', 'fix-batch'), 1); assertSingleLedger();
    const worktree = join(f.repo, 'task-worktree');
    state.registerWorktree(f.repo, 'r1', { path: worktree, branch: 'task', role: 'writer' }); assertSingleLedger();
    const beforePark = readFileSync(ledger, 'utf8');
    assert.throws(() => state.parkRun(f.repo, 'r1', 'TEST_LAYOUT'), /BOUNDARY_REFUSED/); assertSingleLedger();
    assert.equal(readFileSync(ledger, 'utf8'), beforePark);
    const saved = JSON.parse(readFileSync(ledger, 'utf8'));
    assert.equal(saved.dispatches.writer, 1); assert.equal(saved.workers.worker.status, 'done');
    assert.equal(saved.closureObligations.length, 2);
    assert.ok(saved.closureObligations.every(o => o.disposition?.status === 'done'));
    assert.equal(saved.gates.base.status, 'passed'); assert.equal(saved.gates.build.status, 'in_progress');
    assert.equal(saved.loops['fix-batch'], 1); assert.equal(saved.worktrees[0].path, worktree);
    assert.equal(saved.status, undefined); assert.equal(existsSync(join(directory, 'HANDOVER-NEXT.md')), false);
    state.withStateLock(f.repo, 'r1', () => {
      assert.equal(existsSync(join(directory, 'state.lock')), true, layout);
      assert.equal(existsSync(join(other, 'state.lock')), false, layout);
    });
  }
});

// P3: capped automatic plan submissions can request one digest-bound owner renewal.
function budgetFixture(t) {
  const f = fixture(t), digest = inputDigest('plan', plan);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), attempts: { plan: 0 }, loops: { 'jev-plan': 3 },
    findings: [{ id: 'H-budget', severity: 'HIGH', status: 'open', evidence: 'a.mjs:1 missing fence' }],
    planPendingOutcomes: 1, planPendingSubmissions: [{ submission: randomUUID(), attempt: 1 }] }));
  return { ...f, digest, reserve: (d = digest) => state.reserveAttempt(f.repo, 'r1', 'plan', () => {}, randomUUID(), d) };
}
function renewBudget(f) {
  const rec = askException({ repo: f.repo, run: 'r1', input: plan, item: 'one more judgement', receipts: join(f.repo, 'absent') });
  answerCard(f.repo, 'r1', rec.id, { [TOPIC]: 'renew' }, { via: 'ui', quote: 'Renew one submission' });
  return grant({ repo: f.repo, run: 'r1', set: rec.id, input: plan });
}
test('P3 capped reservation waits for a digest-bound budget card without parking or hiding pending work', t => {
  const f = budgetFixture(t), before = f.read();
  assert.throws(() => f.reserve(), /LOOP_CAP:jev-plan/);
  assert.equal(f.read().status, 'awaiting-budget');
  assert.equal(f.read().awaitingBudget.inputSha256, f.digest);
  assert.match(f.read().awaitingBudget.reason, /LOOP_CAP:jev-plan/);
  assert.deepEqual(f.read().findings, before.findings);
  assert.deepEqual(f.read().planPendingSubmissions, before.planPendingSubmissions);
  assert.equal(f.read().loops['jev-plan'], 3);
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' }), /AWAITING_BUDGET/);
  assert.throws(() => state.countDispatch(f.repo, 'r1', 'writer'), /AWAITING_BUDGET/);
  assert.throws(() => f.reserve(), /LOOP_CAP:jev-plan/);
  assert.equal(f.read().status, 'awaiting-budget');
});
test('P3 renewal consumes once for exactly one digest, preserves counts/findings/pending, and cannot be renewed again', t => {
  const f = budgetFixture(t), before = f.read();
  assert.throws(() => f.reserve(), /LOOP_CAP/);
  renewBudget(f);
  assert.throws(() => f.reserve('1111111111111111'), /BUDGET_RENEWAL_INPUT/);
  assert.equal(f.read().loops['jev-plan'], 3);
  assert.equal(f.reserve(), 1);
  assert.equal(f.read().loops['jev-plan'], 4);
  assert.equal(f.read().planPendingOutcomes, 2);
  assert.deepEqual(f.read().planPendingSubmissions[0], before.planPendingSubmissions[0]);
  assert.deepEqual(f.read().findings, before.findings);
  assert.ok(f.read().planBudgetRenewal.consumedAt);
  assert.throws(() => askException({ repo: f.repo, run: 'r1', input: plan, item: 'again' }), /BUDGET_RENEWAL_USED/);
  assert.throws(() => f.reserve(), /LOOP_CAP/);
  assert.match(f.read().status, /^parked:/);
});
test('P3 concurrent reservations consume a granted renewal exactly once under the state lock', async t => {
  const f = budgetFixture(t);
  assert.throws(() => f.reserve(), /LOOP_CAP/); renewBudget(f);
  const code = `import { reserveAttempt } from ${JSON.stringify(pathToFileURL(script('run-state.mjs')).href)};
    try { reserveAttempt(process.argv[1], 'r1', 'plan', () => {}, process.argv[2], process.argv[3]); }
    catch (e) { process.stderr.write(e.message); process.exitCode = 2; }`;
  const results = await Promise.all([1, 2].map(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.repo, randomUUID(), f.digest]);
    let stderr = ''; child.stderr.on('data', b => { stderr += b; }); child.on('error', reject);
    child.on('close', status => resolve({ status, stderr }));
  })));
  assert.deepEqual(results.map(r => r.status).sort(), [0, 2], JSON.stringify(results));
  assert.equal(f.read().loops['jev-plan'], 4);
  assert.equal(f.read().planPendingOutcomes, 2);
});

test('P3 a parked budget-card answer is terminal on an attempted advance', t => {
  const f = budgetFixture(t);
  assert.throws(() => f.reserve(), /LOOP_CAP/);
  const rec = askException({ repo: f.repo, run: 'r1', input: plan, item: 'one more judgement', receipts: join(f.repo, 'absent') });
  answerCard(f.repo, 'r1', rec.id, { [TOPIC]: 'park' }, { via: 'ui', quote: 'Park it' });
  assert.throws(() => f.reserve(), /RUN_PARKED/);
  assert.match(f.read().status, /^parked:/);
  assert.equal(f.read().loops['jev-plan'], 3);
  assert.equal(f.read().planPendingOutcomes, 1);
});

test('P3 renewal cannot become manual acceptance credit without a tracked Jev submission', t => {
  const f = budgetFixture(t);
  assert.throws(() => f.reserve(), /LOOP_CAP/); renewBudget(f);
  assert.throws(() => state.reserveAttempt(f.repo, 'r1', 'plan', () => {}, undefined, f.digest), /BUDGET_RENEWAL_TRACKED_REQUIRED/);
  assert.equal(f.read().loops['jev-plan'], 3);
  assert.equal(f.read().planBudgetRenewal.consumedAt, undefined);
  assert.equal(f.read().planPendingOutcomes, 1);
  assert.equal(f.reserve(), 1, 'refusing manual acceptance leaves credit for the real submission');
});


// P4: removing any clean-tree/identity/provenance check must reopen acceptance.
function auditFixture(t, run = 'audit1') {
  const repo = localRepo('thl-audit-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'source.txt'), 'observed source\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const dir = join(repo, '.trioharness-direct/runs', run); mkdirSync(dir, { recursive: true });
  const contract = join(dir, 'audit.json');
  const input = { context: 'Read-only source audit', questions: [{ ask: 'Is the source present?', expect: 'yes' }],
    sources: ['source.txt'], coverage: 'Read the source and answer the question', evidence: ['source.txt:1 observed source'] };
  writeFileSync(contract, JSON.stringify(input));
  const mode = () => cli('run-state.mjs', ['mode', '--repo', repo, '--run', run, '--mode', 'audit', '--base', base, '--contract', contract]);
  const finish = () => cli('run-state.mjs', ['finish', '--repo', repo, '--run', run]);
  const read = () => state.readState(repo, run);
  const check = (extra = [], response = 'confirmed') => {
    const preload = join(dir, 'fetch.mjs');
    writeFileSync(preload, `globalThis.fetch = async () => ({ok:true,status:200,json:async()=>({model:'jev-test', answers:{q_0:{type:'noul',noul:${response === 'confirmed' ? '0.95' : '0.1'}}}, usage:{}})});`);
    return cli('jev.mjs', ['check', contract, '--audit-repo', repo, '--audit-run', run, '--log', join(dir, 'jev.jsonl'), ...extra],
      { env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload)}`, TYPESAFE_API_KEY: randomUUID() } });
  };
  return { repo, run, dir, contract, input, git, base, mode, read, check, finish };
}
function auditPassOtherGates(f) {
  for (const gate of ['base', 'route', 'task-card', 'guard-proof', 'done-jev']) state.setGate(f.repo, f.run, { gate, status: 'passed' });
}
test('audit: clean read-only run accepts a real matching confirmed check instead of plan', t => {
  const f = auditFixture(t); let r = f.mode(); assert.equal(r.status, 0, r.stderr);
  r = f.check(); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read().gates['audit-check'].status, 'passed');
  assert.equal(f.read().auditOutcome.audit.contractSha256, createHash('sha256').update(readFileSync(f.contract)).digest('hex'));
  auditPassOtherGates(f);
  assert.equal(state.auditRun(f.repo, f.run).ok, true);
  assert.equal(state.resumePoint(f.read()).resumeAt, 'plan-review');
  r = f.finish(); assert.equal(r.status, 0, r.stderr); assert.equal(f.read().finished, true);
});
for (const kind of ['committed', 'staged', 'unstaged', 'binary', 'untracked', 'other-run-output', 'ignored', 'cancelled-index-diff']) {
  test(`audit: mode selection refuses ${kind} differences`, t => {
    const f = auditFixture(t);
    if (kind === 'other-run-output') { mkdirSync(join(f.repo, '.trioharness-direct/runs/other'), { recursive: true }); writeFileSync(join(f.repo, '.trioharness-direct/runs/other/report'), 'x'); }
    else if (kind === 'ignored') { f.git('config', 'core.excludesFile', '/dev/null'); writeFileSync(join(f.repo, '.git/info/exclude'), 'ignored.txt\n'); writeFileSync(join(f.repo, 'ignored.txt'), 'x'); f.git('add', '-f', 'ignored.txt'); }
    else if (kind === 'untracked') writeFileSync(join(f.repo, 'new.txt'), 'x');
    else { writeFileSync(join(f.repo, 'source.txt'), kind === 'binary' ? Buffer.from([0, 1, 2]) : 'changed\n');
      if (['committed', 'staged', 'cancelled-index-diff'].includes(kind)) f.git('add', 'source.txt');
      if (kind === 'committed') f.git('commit', '-qm', 'change');
      if (kind === 'cancelled-index-diff') writeFileSync(join(f.repo, 'source.txt'), 'observed source\n');
    }
    const r = f.mode(); assert.equal(r.status, 3, r.stderr); assert.match(r.stderr, /AUDIT_DIFF/);
  });
}
test('audit: main checkout and registered worktrees must both be clean at selection and registration', t => {
  const f = auditFixture(t), tree = join(tmpdir(), `thl-audit-wt-${randomUUID()}`);
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  f.git('worktree', 'add', '-q', '--detach', tree, f.base);
  state.registerWorktree(f.repo, f.run, { path: tree, role: 'scratch' });
  writeFileSync(join(tree, 'source.txt'), 'changed\n');
  let r = f.mode(); assert.equal(r.status, 3); assert.match(r.stderr, /AUDIT_DIFF/);
  writeFileSync(join(tree, 'source.txt'), 'observed source\n');
  // A mode is start-only, even on a clean pre-existing run.
  r = f.mode(); assert.equal(r.status, 3); assert.match(r.stderr, /MODE_START_ONLY/);
  const g = auditFixture(t, 'audit2'); r = g.mode(); assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(tree, 'source.txt'), 'changed\n');
  assert.throws(() => state.registerWorktree(g.repo, g.run, { path: tree, role: 'scratch' }), /WORKTREE_ALREADY_REGISTERED/);
  const unregistered = join(tmpdir(), `thl-audit-wt-${randomUUID()}`);
  t.after(() => rmSync(unregistered, { recursive: true, force: true }));
  g.git('worktree', 'add', '-q', '--detach', unregistered, g.base);
  writeFileSync(join(unregistered, 'source.txt'), 'changed\n');
  assert.throws(() => state.registerWorktree(g.repo, g.run, { path: unregistered, role: 'scratch' }), /AUDIT_DIFF|AUDIT_REPOSITORY/);
});
test('audit: immutable mode rejects changes, removal, forged state, and late selection', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0);
  assert.equal(f.mode().status, 3);
  let r = cli('run-state.mjs', ['mode', '--repo', f.repo, '--run', f.run, '--mode', 'normal']);
  assert.equal(r.status, 3); assert.match(r.stderr, /MODE_IMMUTABLE/);
  const file = join(f.dir, 'state.json'), original = readFileSync(file, 'utf8');
  for (const mode of [undefined, 'normal']) {
    const s = JSON.parse(original); if (mode === undefined) delete s.mode; else s.mode = mode;
    writeFileSync(file, JSON.stringify(s)); assert.throws(f.read, /MODE_IMMUTABLE/);
  }
  const g = auditFixture(t); state.setGate(g.repo, g.run, { gate: 'base', status: 'passed' });
  assert.match(g.mode().stderr, /MODE_START_ONLY/);
  const s = state.readState(g.repo, g.run); s.mode = 'audit'; writeFileSync(join(g.dir, 'state.json'), JSON.stringify(s));
  assert.throws(g.read, /MODE_IMMUTABLE/);
});
test('audit: no manual pass, dry-run, unavailable or negative check can authorize acceptance', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0);
  assert.throws(() => state.setGate(f.repo, f.run, { gate: 'audit-check', status: 'passed' }), /AUDIT_PROVENANCE/);
  assert.equal(f.check(['--dry-run']).status, 0); assert.equal(f.read().auditOutcome, undefined);
  assert.throws(() => state.setGate(f.repo, f.run, { gate: 'done-jev', status: 'passed' }), /AUDIT_CHECK_REQUIRED/);
  let r = f.check([], 'negative'); assert.equal(r.status, 2); assert.equal(f.read().gates['audit-check'].status, 'failed');
  r = cli('jev.mjs', ['check', f.contract, '--audit-repo', f.repo, '--audit-run', f.run, '--log', join(f.dir, 'jev.jsonl')],
    { env: { ...process.env, TYPESAFE_API_KEY: '', JEV_API_KEY: '', JEV_KEY_FILE: join(f.dir, 'missing-key') } });
  assert.equal(r.status, 3); assert.notEqual(f.read().gates['audit-check'].status, 'passed');
});
test('audit: another run receipt and stale contract/questions/expectations/coverage never authorize acceptance', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0); assert.equal(f.check().status, 0);
  const outcome = f.read().auditOutcome;
  const g = auditFixture(t, 'audit2'); assert.equal(g.mode().status, 0);
  assert.throws(() => state.recordAuditOutcome(g.repo, g.run, outcome), /AUDIT_RECEIPT/);
  for (const changed of [{ questions: [{ ask: 'Different?', expect: 'yes' }] }, { questions: [{ ask: 'Is the source present?', expect: 'no' }] }, { coverage: 'Different coverage' }, { sources: ['missing.txt'] }]) {
    writeFileSync(f.contract, JSON.stringify({ ...f.input, ...changed }));
    assert.throws(() => state.setGate(f.repo, f.run, { gate: 'done-jev', status: 'passed' }), /AUDIT_/);
    assert.match(f.finish().stderr, /AUDIT_/);
  }
});
test('audit: post-check mutation invalidates acceptance at a transition and at finish', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0); assert.equal(f.check().status, 0); auditPassOtherGates(f);
  writeFileSync(join(f.repo, 'source.txt'), 'changed after check\n');
  assert.throws(() => state.setGate(f.repo, f.run, { gate: 'route', status: 'in_progress' }), /AUDIT_DIFF/);
  assert.match(f.finish().stderr, /AUDIT_DIFF/); assert.notEqual(f.read().finished, true);
  assert.ok(state.requiredGates(f.read()).includes('plan-jev'));
});
test('audit: normal run keeps plan requirement and empty changes rejection', t => {
  const f = fixture(t);
  assert.ok(state.requiredGates(f.read()).includes('plan-jev'));
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'plan-jev', status: 'passed' }), /PLAN_PROVENANCE_REQUIRED/);
  const input = join(f.repo, 'empty-plan.json'); writeFileSync(input, JSON.stringify({ ...plan, changes: [] }));
  const r = cli('jev.mjs', ['plan', input, '--dry-run']); assert.equal(r.status, 3); assert.match(r.stderr, /INPUT_MISSING:changes/);
});

test('audit: a linked checkout cannot hide a dirty main checkout', t => {
  const f = auditFixture(t), tree = join(tmpdir(), `thl-audit-main-${randomUUID()}`);
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  f.git('worktree', 'add', '-q', '--detach', tree, f.base);
  writeFileSync(join(f.repo, 'source.txt'), 'main changed\n');
  const r = cli('run-state.mjs', ['mode', '--repo', tree, '--run', f.run, '--mode', 'audit', '--base', f.base, '--contract', f.contract]);
  assert.equal(r.status, 3); assert.match(r.stderr, /AUDIT_DIFF.*source.txt/);
});
test('audit: registered tree mutation and restored dirt permanently refuse finish', t => {
  const f = auditFixture(t), tree = join(tmpdir(), `thl-audit-late-${randomUUID()}`);
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  assert.equal(f.mode().status, 0);
  f.git('worktree', 'add', '-q', '--detach', tree, f.base);
  state.registerWorktree(f.repo, f.run, { path: tree, role: 'scratch' });
  assert.equal(f.check().status, 0); auditPassOtherGates(f);
  writeFileSync(join(tree, 'source.txt'), 'changed\n');
  assert.match(f.finish().stderr, /AUDIT_DIFF/);
  writeFileSync(join(tree, 'source.txt'), 'observed source\n');
  assert.match(f.finish().stderr, /AUDIT_DIFF/);
});
test('audit: exempt source content changes invalidate the source hash even without a product diff', t => {
  const f = auditFixture(t), source = join(f.dir, 'source-evidence.txt');
  writeFileSync(source, 'original evidence');
  writeFileSync(f.contract, JSON.stringify({ ...f.input, sources: [relative(f.repo, source)] }));
  assert.equal(f.mode().status, 0); assert.equal(f.check().status, 0);
  writeFileSync(source, 'different evidence');
  assert.throws(() => state.setGate(f.repo, f.run, { gate: 'done-jev', status: 'passed' }), /AUDIT_RECEIPT/);
  assert.match(f.finish().stderr, /AUDIT_RECEIPT/);
});
test('audit: a confirmed check followed by unavailable cannot keep the old pass', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0); assert.equal(f.check().status, 0);
  const r = cli('jev.mjs', ['check', f.contract, '--audit-repo', f.repo, '--audit-run', f.run, '--log', join(f.dir, 'jev.jsonl')],
    { env: { ...process.env, TYPESAFE_API_KEY: '', JEV_API_KEY: '', JEV_KEY_FILE: join(f.dir, 'missing-key') } });
  assert.equal(r.status, 3); assert.equal(f.read().gates['audit-check'].status, 'failed');
  assert.throws(() => state.setGate(f.repo, f.run, { gate: 'done-jev', status: 'passed' }), /AUDIT_CHECK_REQUIRED/);
});
test('audit: check selection requires a complete contract, no implicit expectations', t => {
  for (const changed of [{ questions: [{ ask: 'Missing expect' }] }, { questions: [] }, { sources: [] }, { coverage: '' }]) {
    const f = auditFixture(t); writeFileSync(f.contract, JSON.stringify({ ...f.input, ...changed }));
    const r = f.mode(); assert.equal(r.status, 3); assert.match(r.stderr, /AUDIT_CONTRACT/);
  }
});

// Review regressions: realistic ignored ledgers and fail-closed audit transitions.
test('R1 ignored prior runs and build output never dirty or invalidate an audit', t => {
  const f = auditFixture(t);
  writeFileSync(join(f.repo, '.git/info/exclude'), '.trioharness-direct/\nnode_modules/\n.DS_Store\n');
  const other = join(f.repo, '.trioharness-direct/runs/older'); mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'state.json'), JSON.stringify({ run: 'older', gates: {} }));
  mkdirSync(join(f.repo, 'node_modules'), { recursive: true }); writeFileSync(join(f.repo, 'node_modules/cache'), 'build output');
  writeFileSync(join(f.repo, '.DS_Store'), 'OS litter');
  const r = f.mode(); assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(other, 'state.json'), JSON.stringify({ run: 'older', gates: { base: { status: 'passed' } } }));
  state.setGate(f.repo, f.run, { gate: 'base', status: 'passed' });
  assert.equal(f.read().auditInvalidated, undefined);
  assert.equal(existsSync(join(f.dir, 'audit-invalidated.json')), false);
});
for (const operation of ['park', 'blocked', 'failed', 'closeout']) test(`R3 invalidated audit records ${operation} durably`, t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0);
  writeFileSync(join(f.repo, 'source.txt'), 'changed\n');
  assert.throws(() => state.setGate(f.repo, f.run, { gate: 'base', status: 'passed' }), /AUDIT_DIFF/);
  if (operation === 'park') {
    state.parkRun(f.repo, f.run, 'AUDIT_CHANGED');
    assert.equal(f.read().status, 'parked:AUDIT_CHANGED');
    assert.equal(existsSync(join(f.dir, 'HANDOVER-NEXT.md')), true);
  } else if (operation === 'closeout') {
    state.recordCloseout(f.repo, f.run, { closed: 0, open: 0 });
    assert.equal(f.read().closeout.open, 0);
    assert.equal(f.read().gates.closeout.status, 'passed');
  } else {
    state.setGate(f.repo, f.run, { gate: 'base', status: operation });
    assert.equal(f.read().gates.base.status, operation);
  }
  assert.notEqual(f.read().finished, true);
  assert.throws(() => state.setGate(f.repo, f.run, { gate: 'route', status: 'in_progress' }), /AUDIT_DIFF/);
  assert.match(f.finish().stderr, /AUDIT_DIFF/);
});
test('R3 readState and closeout scans detect audit dirt without writing invalidation markers', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0);
  const before = readFileSync(join(f.dir, 'state.json'), 'utf8');
  const files = readdirSync(f.dir).sort();
  writeFileSync(join(f.repo, 'source.txt'), 'changed\n');
  assert.match(f.read().auditInvalidated, /AUDIT_DIFF/);
  activeRegistered(f.repo);
  assert.deepEqual(readdirSync(f.dir).sort(), files);
  assert.equal(readFileSync(join(f.dir, 'state.json'), 'utf8'), before);
});
test('R4 renewed revise waits on the new exception card instead of the answered renewal', t => {
  const f = budgetFixture(t); assert.throws(() => f.reserve(), /LOOP_CAP/); renewBudget(f);
  const submission = randomUUID();
  const attempt = state.reserveAttempt(f.repo, 'r1', 'plan', () => {}, submission, f.digest);
  const at = new Date().toISOString();
  state.recordPlanOutcome(f.repo, 'r1', { verdict: 'revise', inputSha256: f.digest, attempt, submission, at });
  const log = join(f.repo, 'jev-rejections.jsonl');
  writeFileSync(log, JSON.stringify({ gate: 'plan', verdict: 'revise', inputSha256: f.digest, reasons: ['needs a fix'], at }) + '\n');
  const rec = askException({ repo: f.repo, run: 'r1', input: plan, item: 'renewed plan', receipts: log });
  assert.ok(rec.card.questions[0].options.some(o => o.id === 'proceed'));
  const r = cli('run-state.mjs', ['findings', 'add', '--repo', f.repo, '--run', 'r1', '--id', 'M-later', '--severity', 'MEDIUM', '--evidence', 'a.mjs:2 follow-up']);
  assert.match(r.stderr, /AWAITING_EXCEPTION/);
  assert.equal(f.read().status, 'awaiting-exception');
  answerCard(f.repo, 'r1', rec.id, { [TOPIC]: 'proceed' }, { via: 'ui', quote: 'Proceed' });
  grant({ repo: f.repo, run: 'r1', set: rec.id, input: plan });
  state.recordPlanOutcome(f.repo, 'r1', { verdict: 'accepted-exception', inputSha256: f.digest, at });
  assert.equal(f.read().status, 'active');
});
test('R5 caller-computed audit outcomes without a receipt log cannot pass', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0);
  const input = state.prepareAuditCheck(f.repo, f.run, f.contract);
  const outcome = { gate: 'check', mode: 'audit', audit: input.audit, inputSha256: inputDigest('check', input),
    pass: true, verdict: 'confirmed', jev: { model: 'caller-computed', answers: { q_0: { type: 'noul', noul: 0.95 } } } };
  assert.throws(() => state.recordAuditOutcome(f.repo, f.run, outcome), /AUDIT_RECEIPT/);
  assert.notEqual(f.read().gates['audit-check']?.status, 'passed');
});
test('R5 audit submissions have three lifetime attempts across changed contracts and failures', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0);
  for (let n = 0; n < 3; n++) {
    writeFileSync(f.contract, JSON.stringify({ ...f.input, coverage: `Coverage revision ${n}` }));
    const r = f.check([], 'negative'); assert.equal(r.status, 2, r.stderr);
  }
  const r = f.check(); assert.equal(r.status, 3, r.stderr); assert.match(r.stderr, /LOOP_CAP:audit-check/);
  assert.equal(f.read().loops['audit-check'], 3);
  assert.match(f.read().status, /^parked:/);
  assert.notEqual(f.read().gates['audit-check'].status, 'passed');
});
test('N1 missing credentials do not consume audit submissions', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0);
  for (let n = 0; n < 3; n++) {
    const r = cli('jev.mjs', ['check', f.contract, '--audit-repo', f.repo, '--audit-run', f.run, '--log', join(f.dir, 'jev.jsonl')],
      { env: { ...process.env, TYPESAFE_API_KEY: '', JEV_API_KEY: '', JEV_KEY_FILE: join(f.dir, 'missing-key') } });
    assert.equal(r.status, 3); assert.match(r.stderr, /JEV_KEY_MISSING/);
    assert.equal(f.read().loops?.['audit-check'] ?? 0, 0);
    assert.deepEqual(f.read().auditSubmissions ?? [], []);
  }
  assert.equal(f.check().status, 0);
  assert.equal(f.read().loops['audit-check'], 1);
});
test('N1 invalid request size does not consume audit submissions', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0);
  writeFileSync(f.contract, JSON.stringify({ ...f.input, context: 'x'.repeat(41000) }));
  for (let n = 0; n < 3; n++) {
    const r = f.check();
    assert.equal(r.status, 3); assert.match(r.stderr, /STATE_TOO_LARGE/);
    assert.equal(f.read().loops?.['audit-check'] ?? 0, 0);
    assert.deepEqual(f.read().auditSubmissions ?? [], []);
  }
  writeFileSync(f.contract, JSON.stringify(f.input));
  assert.equal(f.check().status, 0);
  assert.equal(f.read().loops['audit-check'], 1);
});
test('R5 accepting audit verifies the exact persisted receipt bytes', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0); assert.equal(f.check().status, 0);
  const log = join(f.dir, 'jev.jsonl'), bytes = readFileSync(log, 'utf8');
  const outcome = f.read().auditOutcome;
  assert.equal(outcome.receipt.sha256, createHash('sha256').update(bytes.trimEnd()).digest('hex'));
  writeFileSync(log, bytes.replace('jev-test', 'forged-model'));
  assert.throws(() => state.setGate(f.repo, f.run, { gate: 'done-jev', status: 'passed' }), /AUDIT_RECEIPT/);
});


test('R5 third audit success can finish, while dry-run and receipt replay grant no attempts', t => {
  const f = auditFixture(t); assert.equal(f.mode().status, 0);
  assert.equal(f.check(['--dry-run']).status, 0); assert.equal(f.read().loops?.['audit-check'], undefined);
  for (let n = 0; n < 2; n++) assert.equal(f.check([], 'negative').status, 2);
  assert.equal(f.check().status, 0); assert.equal(f.read().loops['audit-check'], 3);
  assert.throws(() => state.recordAuditOutcome(f.repo, f.run, f.read().auditOutcome), /AUDIT_RECEIPT_REPLAY/);
  auditPassOtherGates(f);
  const r = f.finish(); assert.equal(r.status, 0, r.stderr); assert.equal(f.read().finished, true);
});


// Terminal cleanup uses only private repositories and a private HOME.
function terminalFixture(t) {
  const f = fixture(t), home = join(f.repo, 'home'), bare = join(f.repo, 'remote.git');
  mkdirSync(home); const previousHome = process.env.HOME; process.env.HOME = home;
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  const git = (dir, ...args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(f.repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(f.repo, 'config', 'user.name', 'Test'); git(f.repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(f.repo, 'a.txt'), 'original');
  git(f.repo, 'add', 'a.txt'); git(f.repo, 'commit', '--quiet', '-m', 'initial');
  git(f.repo, 'init', '--quiet', '--bare', bare); git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(f.repo, 'remote', 'add', 'origin', bare); git(f.repo, 'push', '--quiet', 'origin', 'main');
  const tree = join(f.repo, 'tree');
  git(f.repo, 'worktree', 'add', '--quiet', '-b', 'trio/terminal', tree);
  state.registerWorktree(f.repo, 'r1', { path: tree, branch: 'trio/terminal' });
  return { ...f, tree, git };
}

test('HD-1 refuses registration to a second unfinished run and names its owner', t => {
  const f = terminalFixture(t);
  const attempt = () => state.registerWorktree(f.repo, 'r2', { path: f.tree, branch: 'trio/terminal' });
  assert.throws(attempt, /WORKTREE_ALREADY_REGISTERED.*r1/);
  assert.equal(state.readState(f.repo, 'r2'), null);
  assert.equal(f.read().worktrees.length, 1);
  writeFileSync(f.file, JSON.stringify({ ...f.read(), finished: true }));
  assert.equal(attempt()[0].path, f.tree);
});

const releaseTreeCli = (f, run, path, id) => cli('run-state.mjs', [
  'worktree', '--release', '--repo', f.repo, '--run', run,
  ...(path ? ['--path', path] : []), ...(id ? ['--card', id] : [])
]);
function releaseCard(f, run, { answered = true, path = f.tree, answer = 'release' } = {}) {
  const rec = askCard(f.repo, run, { questions: [{ id: 'release', header: 'Worktree',
    question: `Release the missing worktree registration at \`${path}\`?`, why: 'The Git worktree was removed.',
    options: [{ id: 'release', label: 'Release', description: 'Release this registration' },
      { id: 'keep', label: 'Keep', description: 'Keep this registration' }], recommended: 'keep' }] }, { standing: { skip: true } });
  if (answered) answerCard(f.repo, run, rec.id, { release: answer }, { via: 'card', quote: answer });
  return rec.id;
}

for (const [reason, setup] of [
  ['WORKTREE_PATH_REQUIRED', (f, id) => [null, id]],
  ['WORKTREE_NOT_REGISTERED', (f, id) => [join(f.repo, 'unregistered'), id]],
  ['WORKTREE_PATH_EXISTS', (f, id) => [f.tree, id]],
  ['WORKTREE_PATH_EXISTS', (f, id) => {
    f.git(f.repo, 'worktree', 'remove', f.tree);
    if (process.platform === 'win32') writeFileSync(f.tree, 'a stray file');
    else symlinkSync(join(f.repo, 'absent-target'), f.tree);
    return [f.tree, id];
  }],
  ['WORKTREE_GIT_LISTED', (f, id) => {
    rmSync(f.tree, { recursive: true }); // Git metadata remains, even though the directory is gone.
    return [f.tree, id];
  }],
  ['WORKTREE_CARD_REQUIRED', f => [f.tree, null]],
  ['WORKTREE_CARD_NOT_ANSWERED', f => [f.tree, releaseCard(f, 'r1', { answered: false })]],
  ['WORKTREE_CARD_NOT_ANSWERED', f => [f.tree, releaseCard(f, 'r2')]]
]) test(`HD-1 refuses release with ${reason} and keeps the ledger unchanged`, t => {
  const f = terminalFixture(t);
  if (reason.startsWith('WORKTREE_CARD')) f.git(f.repo, 'worktree', 'remove', f.tree);
  const id = reason.startsWith('WORKTREE_CARD') ? null : releaseCard(f, 'r1');
  const [path, cardId] = setup(f, id);
  const frozen = readFileSync(f.file, 'utf8');
  const result = releaseTreeCli(f, 'r1', path, cardId);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(reason));
  assert.equal(readFileSync(f.file, 'utf8'), frozen);
});

function assertReleaseRefused(f, path, id, reason) {
  const before = readFileSync(f.file, 'utf8');
  const release = releaseTreeCli(f, 'r1', path, id);
  assert.equal(release.status, 3, release.stderr || release.stdout);
  assert.match(release.stderr, reason);
  assert.equal(readFileSync(f.file, 'utf8'), before);
}

for (const [label, issue] of [
  ['keep answer', f => releaseCard(f, 'r1', { answer: 'keep' })],
  ['unrelated card', f => {
    const { id } = askCard(f.repo, 'r1', card, { standing: { skip: true } });
    answerCard(f.repo, 'r1', id, { q: 'a' }, { via: 'card', quote: 'Small' });
    return id;
  }],
  ['path with a suffix', f => releaseCard(f, 'r1', { path: `${f.tree}-other` })],
  ['standing-order answer', f => {
    const id = releaseCard(f, 'r1');
    const file = join(f.repo, '.trioharness-direct/runs/r1/questions', `${id}.json`);
    const set = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...set, answeredVia: 'standing-order' }));
    return id;
  }]
]) test(`HD-1 H1 refuses ${label}`, t => {
  const f = terminalFixture(t);
  f.git(f.repo, 'worktree', 'remove', f.tree);
  assertReleaseRefused(f, f.tree, issue(f), /WORKTREE_CARD_NOT_AUTHORIZED/);
});

test('HD-1 H1 refuses a quoted longer path containing a space', t => {
  const f = terminalFixture(t);
  f.git(f.repo, 'worktree', 'remove', f.tree);
  assertReleaseRefused(f, f.tree, releaseCard(f, 'r1', { path: `${f.tree} other` }), /WORKTREE_CARD_NOT_AUTHORIZED/);
});

for (const rolled of [false, true]) test(`HD-1 H1 refuses card reuse with history rollover=${rolled}`, t => {
  const f = terminalFixture(t);
  f.git(f.repo, 'worktree', 'remove', f.tree);
  const id = releaseCard(f, 'r1');
  const release = releaseTreeCli(f, 'r1', f.tree, id);
  assert.equal(release.status, 0, release.stderr);
  state.registerWorktree(f.repo, 'r1', { path: f.tree, branch: 'trio/terminal' });
  if (rolled) {
    const rec = f.read();
    rec.history.push(...Array.from({ length: 100 }, () => ({ gate: 'base', status: 'passed' })));
    writeFileSync(f.file, JSON.stringify(rec));
    state.setGate(f.repo, 'r1', { gate: 'route', status: 'passed' });
  }
  assertReleaseRefused(f, f.tree, id, /WORKTREE_CARD_ALREADY_USED/);
});

test('HD-1 M2 refuses a registration attributed to a foreign repository', t => {
  const f = terminalFixture(t);
  const foreign = join(f.repo, 'foreign'), tree = join(f.repo, 'foreign-tree');
  f.git(f.repo, 'clone', '--quiet', f.repo, foreign);
  f.git(foreign, 'worktree', 'add', '--quiet', '-b', 'trio/foreign', tree);
  state.registerWorktree(f.repo, 'r1', { path: tree, branch: 'trio/foreign' });
  rmSync(tree, { recursive: true });
  assert.match(f.git(foreign, 'worktree', 'list', '--porcelain'), /foreign-tree/);
  assertReleaseRefused(f, tree, releaseCard(f, 'r1', { path: tree }), /WORKTREE_REPO_UNATTRIBUTED/);
});

test('HD-1 L1 register and release honor the boundary lock spelling for an absent path', t => {
  const f = terminalFixture(t);
  f.git(f.repo, 'worktree', 'remove', f.tree);
  const alias = join(f.repo, 'alias');
  symlinkSync(f.repo, alias, 'junction');
  const path = join(alias, 'tree');
  assert.notEqual(lockNameFor(path), lockNameFor(f.tree));
  const id = releaseCard(f, 'r1');
  const lock = tryAcquire(`boundary-${lockNameFor(path)}`, { dir: join(homedir(), '.trioharness-lean', 'locks') });
  assert.equal(lock.acquired, true);
  try {
    assertReleaseRefused(f, path, id, /STATE_CHANGED/);
    const register = stateCli(f, 'worktree', '--path', path);
    assert.equal(register.status, 3, register.stdout + register.stderr);
    assert.match(register.stderr, /STATE_CHANGED/);
  } finally { unlock(lock.file); }
});

test('HD-1 L2 release refuses finished state and allows parked state', t => {
  const f = terminalFixture(t);
  f.git(f.repo, 'worktree', 'remove', f.tree);
  const id = releaseCard(f, 'r1');
  const before = f.read();
  writeFileSync(f.file, JSON.stringify({ ...before, finished: true }));
  assertReleaseRefused(f, f.tree, id, /RUN_FINISHED/);
  writeFileSync(f.file, JSON.stringify({ ...before, status: 'parked:legacy-worktree' }));
  const release = releaseTreeCli(f, 'r1', f.tree, id);
  assert.equal(release.status, 0, release.stderr);
  assert.equal(f.read().status, 'parked:legacy-worktree');
});

test('HD-1 L2 release refuses audit mode', t => {
  const f = auditFixture(t, 'r1');
  assert.equal(f.mode().status, 0);
  f.file = join(f.dir, 'state.json');
  const path = join(f.repo, 'absent');
  writeFileSync(f.file, JSON.stringify({ ...f.read(), worktrees: [{ path, branch: 'trio/audit' }] }));
  assertReleaseRefused(f, path, releaseCard(f, 'r1', { path }), /WORKTREE_RELEASE_AUDIT_MODE/);
});

test('HD-1 L3 registration refusal names the run with unreadable state', t => {
  const f = terminalFixture(t);
  const dir = join(f.repo, '.trioharness-direct/runs/broken-owner');
  mkdirSync(dir);
  writeFileSync(join(dir, 'state.json'), '{invalid');
  assert.throws(() => state.registerWorktree(f.repo, 'r2', { path: join(f.repo, 'new-tree') }),
    /WORKTREE_REGISTRATION_UNKNOWN.*broken-owner/);
  assert.throws(() => state.registerWorktree(f.repo, 'broken-owner', { path: join(f.repo, 'new-tree') }),
    /WORKTREE_REGISTRATION_UNKNOWN.*broken-owner/);
});

test('HD-1 releases a legacy shared path per run, then both clean-state and finish CLIs succeed', t => {
  const f = terminalFixture(t);
  const first = f.read();
  const otherFile = join(f.repo, '.trioharness-direct/runs/r2/state.json');
  mkdirSync(join(f.repo, '.trioharness-direct/runs/r2'));
  writeFileSync(otherFile, JSON.stringify({ ...first, run: 'r2' }));
  f.git(f.repo, 'worktree', 'remove', f.tree);

  // Keep another, genuinely closed registration in r2 to exercise Git branch checks after release.
  const otherTree = join(f.repo, 'other-tree'), branch = 'bambooed/r2';
  f.git(f.repo, 'worktree', 'add', '--quiet', '-b', branch, otherTree);
  state.registerWorktree(f.repo, 'r2', { path: otherTree, branch });
  assert.equal(closeAll({ repo: f.repo, run: 'r2', apply: true }).closed, 1);
  const retained = state.readState(f.repo, 'r2').worktrees[1];
  const otherBefore = readFileSync(otherFile, 'utf8');

  for (const run of ['r1', 'r2']) {
    const id = releaseCard(f, run);
    const release = releaseTreeCli(f, run, f.tree, id);
    assert.equal(release.status, 0, release.stderr);
    const after = state.readState(f.repo, run);
    assert.deepEqual(after.worktrees, run === 'r1' ? [] : [retained]);
    const { event, path, branch: releasedBranch, card: recordedCard, evidence } = after.history.at(-1);
    assert.deepEqual({ event, path, branch: releasedBranch, card: recordedCard, evidence }, {
      event: 'worktree-release', path: first.worktrees[0].path, branch: first.worktrees[0].branch, card: id,
      evidence: { absent: true, gitListed: false, repo: realpathSync(f.repo) }
    });
    if (run === 'r1') assert.equal(readFileSync(otherFile, 'utf8'), otherBefore);

    state.setGate(f.repo, run, { gate: 'done-jev', status: 'passed' });
    const args = ['--repo', f.repo, '--run', run];
    const clean = cli('clean-state.mjs', ['check', ...args]);
    assert.equal(clean.status, 0, clean.stderr);
    const proof = JSON.parse(clean.stdout);
    assert.equal(proof.ok, true);
    if (run === 'r2') assert.equal(proof.branches.find(b => b.branch === branch)?.state, 'no-changes');
    const finish = cli('run-state.mjs', ['finish', ...args]);
    assert.equal(finish.status, 0, finish.stderr);
    assert.equal(state.readState(f.repo, run).finished, true);
  }
});

test('HD-2 boundary authority ignores ordinary files beside local run directories', t => {
  const f = terminalFixture(t);
  f.git(f.tree, 'push', 'origin', 'trio/terminal');
  const runs = join(f.tree, '.trioharness-direct/runs');
  mkdirSync(runs, { recursive: true });
  for (const file of ['.DS_Store', '.current-x']) writeFileSync(join(runs, file), 'litter');
  const saved = saveBoundary({ repo: f.repo, run: 'r1' });
  try { assert.equal(saved.output.ok, true, JSON.stringify(saved.output)); }
  finally { saved.release(); }
});

for (const location of ['ledger', 'checkout']) test(`HD-2 M1 follows a symlinked unfinished owner in the ${location}`, t => {
  const f = terminalFixture(t);
  f.git(f.tree, 'push', 'origin', 'trio/terminal');
  const runs = join(location === 'ledger' ? f.repo : f.tree, '.trioharness-direct/runs');
  mkdirSync(runs, { recursive: true });
  const target = join(f.repo, 'owner-state');
  mkdirSync(target);
  writeFileSync(join(target, 'state.json'), JSON.stringify({ ...f.read(), run: 'r2', finished: false }));
  symlinkSync(target, join(runs, 'r2'), 'junction');
  if (location === 'ledger') {
    const registrations = [...activeRegistered(f.repo).registrations.values()];
    assert.ok(registrations.some(owners => owners.get('r2') === 'active'));
  } else {
    const saved = saveBoundary({ repo: f.repo, run: 'r1' });
    try {
      assert.equal(saved.output.ok, false, JSON.stringify(saved.output));
      assert.equal(saved.output.checkouts[0].reason, 'NOT_OWNED');
    } finally { saved.release(); }
  }
});

test('HD-2 M1 a dangling ledger run link leaves ownership unknown', t => {
  const f = terminalFixture(t);
  symlinkSync(join(f.repo, 'missing'), join(f.repo, '.trioharness-direct/runs/dangling'), 'junction');
  assert.equal(activeRegistered(f.repo).unknown, true);
});

for (const dirty of [false, true]) test(`terminal closeout: park ${dirty ? 'saves dirty then closes' : 'closes clean pushed'} tree and retains acceptance refusal`, t => {
  const f = terminalFixture(t);
  if (dirty) writeFileSync(join(f.tree, 'a.txt'), 'keep these edits');
  state.parkRun(f.repo, 'r1', 'TEST_TERMINAL');
  assert.equal(existsSync(f.tree), false);
  const after = f.read();
  assert.equal(after.finished, false); assert.equal(after.status, 'parked:TEST_TERMINAL');
  assert.match(after.closeout.note, /^closeout: closed/);
  assert.throws(() => state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' }), /RUN_PARKED/);
  assert.equal(existsSync(join(f.repo, '.trioharness-direct/runs/r1/state.lock')), false);
  if (dirty) { assert.equal(f.git(f.repo, 'show', 'trio/terminal:a.txt'), 'keep these edits'); assert.equal(f.git(join(f.repo, 'remote.git'), 'rev-parse', 'trio/terminal'), f.git(f.repo, 'rev-parse', 'trio/terminal')); }
});
test('terminal closeout: implicit loop-cap parking also closes after unlocking', t => {
  const f = terminalFixture(t);
  const before = f.read();
  // Use the existing first loop kind, rather than inventing a counter.
  const kind = Object.keys(state.LOOP_CAPS)[0]; before.loops = { [kind]: state.LOOP_CAPS[kind] - 1 };
  writeFileSync(f.file, JSON.stringify(before));
  assert.throws(() => state.countLoop(f.repo, 'r1', kind), /LOOP_CAP/);
  assert.equal(existsSync(f.tree), false); assert.equal(f.read().finished, false);
  assert.match(f.read().closeout.note, /^closeout: closed/);
});
test('terminal closeout: failed finish with owed work never attempts cleanup', t => {
  const f = terminalFixture(t), before = f.read();
  before.gates['done-jev'] = { status: 'passed' }; before.items = [owedItem];
  writeFileSync(f.file, JSON.stringify(before));
  const r = cli('run-state.mjs', ['finish', '--repo', f.repo, '--run', 'r1']);
  assert.equal(r.status, 3); assert.match(r.stderr, /RUN_OWES_WORK/);
  assert.equal(existsSync(f.tree), true); assert.equal(f.read().closeout, undefined);
});
test('terminal closeout: successful finish records cleanup only after finish succeeds', t => {
  const repo = mkdtempSync(join(tmpdir(), 'thl-closeout-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dir = join(repo, '.trioharness-direct', 'runs', 'r1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ run: 'r1', gates: { 'done-jev': { status: 'passed' } }, history: [] }));
  const r = cli('run-state.mjs', ['finish', '--repo', repo, '--run', 'r1'], { env: process.env });
  const record = state.readState(repo, 'r1');
  assert.equal(r.status, 0, r.stderr); assert.equal(record.finished, true);
  assert.match(record.closeout.note, /^closeout: refused /, 'non-git fixture preserves successful finish and records closeout failure');
});


test('terminal closeout: caller inside a registered tree retains the tree', t => {
  const f = terminalFixture(t), previous = process.cwd();
  const before = readFileSync(f.file, 'utf8');
  try { process.chdir(f.tree); assert.throws(() => state.parkRun(f.repo, 'r1', 'CALLER_CWD'), /BOUNDARY_REFUSED.*CALLER_IN_WORKTREE/); }
  finally { process.chdir(previous); }
  assert.equal(existsSync(f.tree), true);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(existsSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md')), false);
});
test('terminal closeout: exact owner-hold refuses park before publication', t => {
  const f = terminalFixture(t);
  state.setGate(f.repo, 'r1', { gate: 'closeout', status: 'blocked', note: 'owner-hold: retain this tree, owner, 2026-11-16' });
  const hold = f.read().gates.closeout;
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => state.parkRun(f.repo, 'r1', 'OWNER_HOLD'), /BOUNDARY_REFUSED.*owner-hold/);
  assert.equal(existsSync(f.tree), true);
  assert.deepEqual(f.read().gates.closeout, hold);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(existsSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md')), false);
});


for (const busy of ['workers', 'jobs', 'not idle']) test(`fix batch implicit park refuses while ${busy}`, t => {
  const f = terminalFixture(t), before = f.read();
  const kind = Object.keys(state.LOOP_CAPS)[0]; before.loops = { [kind]: state.LOOP_CAPS[kind] - 1 };
  if (busy === 'workers') before.workers = { writer: { status: 'running' } };
  if (busy === 'jobs') {
    const dir = join(f.repo, '.trioharness-direct/runs/r1/jobs'); mkdirSync(dir);
    writeFileSync(join(dir, 'queued.json'), JSON.stringify({ name: 'queued', status: 'queued' }));
  }
  if (busy === 'not idle') {
    const dir = join(f.tree, '.trioharness-direct/runs/active'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ run: 'active', finished: false, gates: {} }));
  }
  writeFileSync(f.file, JSON.stringify(before));
  const frozen = readFileSync(f.file, 'utf8');
  assert.throws(() => state.countLoop(f.repo, 'r1', kind), /BOUNDARY_REFUSED/);
  assert.equal(readFileSync(f.file, 'utf8'), frozen);
  assert.equal(existsSync(f.tree), true);
  assert.equal(existsSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md')), false);
  assert.equal(f.read().closeout, undefined);
});
for (const busy of ['workers', 'jobs', 'not idle']) test(`final batch explicit park refuses while ${busy}`, t => {
  const f = terminalFixture(t), before = f.read();
  if (busy === 'workers') before.workers = { writer: { status: 'running' } };
  if (busy === 'jobs') {
    const jobs = join(f.repo, '.trioharness-direct/runs/r1/jobs'); mkdirSync(jobs);
    writeFileSync(join(jobs, 'queued.json'), JSON.stringify({ name: 'queued', status: 'queued' }));
  }
  if (busy === 'not idle') {
    const dir = join(f.tree, '.trioharness-direct/runs/active'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ run: 'active', finished: false, gates: {} }));
  }
  writeFileSync(f.file, JSON.stringify(before));
  const frozen = readFileSync(f.file, 'utf8');
  assert.throws(() => state.parkRun(f.repo, 'r1', 'EXPLICIT'), /BOUNDARY_REFUSED/);
  assert.equal(readFileSync(f.file, 'utf8'), frozen);
  assert.equal(existsSync(f.tree), true);
  assert.equal(existsSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md')), false);
  assert.equal(f.read().status, undefined);
  assert.equal(f.read().closeout, undefined);
});

for (const explicit of [false, true]) for (const unreadable of ['jobs directory', 'job record']) test(`final batch ${explicit ? 'explicit' : 'implicit'} park refuses unreadable ${unreadable}`, t => {
  const f = terminalFixture(t), jobs = join(f.repo, '.trioharness-direct/runs/r1/jobs');
  // Use deterministic filesystem read failures, including when chmod would be ineffective.
  if (unreadable === 'jobs directory') writeFileSync(jobs, 'not a directory');
  else { mkdirSync(jobs); mkdirSync(join(jobs, 'unreadable.json')); }
  if (explicit) { const frozen = readFileSync(f.file, 'utf8'); assert.throws(() => state.parkRun(f.repo, 'r1', 'UNREADABLE_JOBS'), /BOUNDARY_REFUSED/); assert.equal(readFileSync(f.file, 'utf8'), frozen); }
  else {
    const before = f.read(), kind = Object.keys(state.LOOP_CAPS)[0];
    before.loops = { [kind]: state.LOOP_CAPS[kind] - 1 }; writeFileSync(f.file, JSON.stringify(before));
    const frozen = readFileSync(f.file, 'utf8');
    assert.throws(() => state.countLoop(f.repo, 'r1', kind), /BOUNDARY_REFUSED/);
    assert.equal(readFileSync(f.file, 'utf8'), frozen);
  }
  assert.equal(existsSync(f.tree), true);
  assert.equal(existsSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md')), false);
  assert.equal(f.read().status, undefined);
  assert.equal(f.read().closeout, undefined);
});

for (const transition of ['park', 'finish', 'learnings', 'handoff', 'pickup', 'loop-cap', 'exception']) test(`M1 owner hold with no trees permits ${transition}`, t => {
  const f = fixture(t); auditEvidence(f);
  const hold = { note: 'owner-hold: retain resources', closed: 0, open: 0 };
  const record = f.read(); record.closeout = hold; record.worktrees = []; record.gates['done-jev'] = { status: 'passed' };
  if (transition === 'loop-cap') record.loops = { 'fix-batch': state.LOOP_CAPS['fix-batch'] - 1 };
  writeFileSync(f.file, JSON.stringify(record));
  if (transition === 'park') state.parkRun(f.repo, 'r1', 'hold');
  else if (transition === 'finish') { const out = stateCli(f, 'finish'); assert.equal(out.status, 0, out.stderr); }
  else if (transition === 'learnings') state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' });
  else if (transition === 'handoff') { state.updateDiscipline(f.repo, 'r1', 'item', 'add', owedItem); state.updateDiscipline(f.repo, 'r1', 'handoff', 'add', handoffRecord(f)); }
  else if (transition === 'pickup') { writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), 'next'); state.handoverTaken(f.repo, 'r1', { by: 'successor' }); }
  else if (transition === 'loop-cap') assert.throws(() => state.countLoop(f.repo, 'r1', 'fix-batch'), /LOOP_CAP/);
  else { const r = f.read(); r.status = 'awaiting-exception'; r.awaitingException = { inputSha256: '0123456789abcdef' }; writeFileSync(f.file, JSON.stringify(r)); assert.throws(() => state.recordPlanOutcome(f.repo, 'r1', { verdict: 'proceed', inputSha256: '0123456789abcdef', at: new Date().toISOString() }), /EXCEPTION_NOT_GRANTED/); }
  assert.deepEqual(f.read().closeout, hold);
  if (['loop-cap', 'exception'].includes(transition)) assert.match(f.read().status, /^parked:/);
});


for (const transition of ['finish', 'learnings', 'park', 'handoff', 'pickup', 'park-pickup']) test(`A2 real closeAll then ${transition} preserves closed identities`, t => {
  const f = terminalFixture(t); f.git(f.tree, 'push', 'origin', 'trio/terminal');
  const head = f.git(f.tree, 'rev-parse', 'HEAD'), path = realpathSync(f.tree);
  assert.equal(closeAll({ repo: f.repo, run: 'r1', apply: true }).closed, 1);
  if (['finish', 'learnings'].includes(transition)) {
    writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/clean-state.json'), JSON.stringify({ at: new Date(Date.now() + 5000).toISOString(), ok: true }));
    state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' });
    if (transition === 'finish') { const r = stateCli(f, 'finish'); assert.equal(r.status, 0, r.stderr); }
    else state.setGate(f.repo, 'r1', { gate: 'learnings', status: 'passed' });
    assert.equal(f.read().finished, true);
  } else if (transition === 'handoff') state.updateDiscipline(f.repo, 'r1', 'handoff', 'add', handoffRecord(f, 'same-repo'));
  else {
    if (transition.startsWith('park')) state.parkRun(f.repo, 'r1', 'A2');
    if (transition.includes('pickup')) {
      if (transition === 'pickup') writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), '# Next');
      const result = state.handoverTaken(f.repo, 'r1', { by: 'successor' }); assert.ok(result.file.startsWith('HANDOVER-TAKEN-'));
    }
  }
  const detail = f.read().closeout.details.find(d => d.path === path);
  assert.equal(detail?.branch, 'trio/terminal'); assert.equal(detail?.head, head); assert.equal(detail?.status, 'closed');
});
test('A2 repeat explicit and implicit park returns unchanged state with zero Git save observations', async t => {
  const f = terminalFixture(t); state.parkRun(f.repo, 'r1', 'FIRST');
  const bytes = readFileSync(f.file, 'utf8'), before = f.read();
  const cp = await import('node:child_process'), { syncBuiltinESMExports } = await import('node:module');
  const original = cp.default.execFileSync; let calls = 0;
  cp.default.execFileSync = (...args) => { if (args[0] === 'git') { calls++; throw new Error('repeat park attempted Git save'); } return original(...args); }; syncBuiltinESMExports();
  try {
    assert.deepEqual(state.parkRun(f.repo, 'r1', 'SECOND'), before);
    assert.throws(() => state.countLoop(f.repo, 'r1', 'fix-batch'), /RUN_PARKED/);
    assert.equal(calls, 0); assert.equal(readFileSync(f.file, 'utf8'), bytes);
  } finally { cp.default.execFileSync = original; syncBuiltinESMExports(); }
});


for (const role of ['writer', 'reviewer', 'slice']) for (const transition of ['finish', 'park', 'handoff', 'pickup']) test(`A2 delta H1 ${role} path close then full close permits ${transition}`, t => {
  const f = terminalFixture(t); state.registerWorktree(f.repo, 'r1', { path: f.tree, branch: 'trio/terminal', role }); f.git(f.tree, 'push', 'origin', 'trio/terminal'); const path = realpathSync(f.tree), head = f.git(f.tree, 'rev-parse', 'HEAD');
  assert.equal(closeAll({ repo: f.repo, run: 'r1', paths: [f.tree], apply: true }).closed, 1);
  const partial = f.read(); assert.equal(partial.closeout?.details?.find(d => d.path === path)?.head, head);
  assert.equal(partial.closeout.closed, undefined); assert.equal(partial.closeout.open, undefined); assert.equal(partial.gates.closeout, undefined);
  assert.ok(state.openWorktreeReason(partial), 'a path close does not authorize full closeout');
  closeAll({ repo: f.repo, run: 'r1', apply: true });
  if (transition === 'finish') {
    writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/clean-state.json'), JSON.stringify({ at: new Date(Date.now() + 5000).toISOString(), ok: true }));
    state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' }); const r = stateCli(f, 'finish'); assert.equal(r.status, 0, r.stderr); assert.equal(f.read().finished, true);
  } else if (transition === 'park') state.parkRun(f.repo, 'r1', 'DELTA');
  else if (transition === 'handoff') state.updateDiscipline(f.repo, 'r1', 'handoff', 'add', handoffRecord(f, 'same-repo'));
  else { writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/HANDOVER-NEXT.md'), '# Next'); assert.ok(state.handoverTaken(f.repo, 'r1', { by: 'successor' }).file); }
  assert.equal(f.read().closeout.details.find(d => d.path === path)?.head, head);
});
test('A2 delta M1 partial close then new registration retains proof through final finish', t => {
  const f = terminalFixture(t), second = join(f.repo, 'second'), third = join(f.repo, 'third'), path = realpathSync(f.tree);
  f.git(f.tree, 'push', 'origin', 'trio/terminal');
  f.git(f.repo, 'worktree', 'add', '-b', 'trio/second', second); f.git(second, 'push', 'origin', 'trio/second'); state.registerWorktree(f.repo, 'r1', { path: second, branch: 'trio/second' });
  writeFileSync(join(second, 'a.txt'), 'dirty'); assert.equal(closeAll({ repo: f.repo, run: 'r1', apply: true }).closed, 1);
  const head = f.read().closeout.details.find(d => d.path === path).head;
  f.git(f.repo, 'worktree', 'add', '-b', 'trio/third', third); f.git(third, 'push', 'origin', 'trio/third'); state.registerWorktree(f.repo, 'r1', { path: third, branch: 'trio/third' });
  assert.equal(f.read().closeout?.details?.find(d => d.path === path)?.head, head);
  assert.ok(state.openWorktreeReason(f.read())); assert.notEqual(f.read().gates.closeout?.status, 'passed');
  f.git(second, 'checkout', '--', 'a.txt'); closeAll({ repo: f.repo, run: 'r1', apply: true });
  writeFileSync(join(f.repo, '.trioharness-direct/runs/r1/clean-state.json'), JSON.stringify({ at: new Date(Date.now() + 5000).toISOString(), ok: true }));
  state.setGate(f.repo, 'r1', { gate: 'done-jev', status: 'passed' }); const r = stateCli(f, 'finish'); assert.equal(r.status, 0, r.stderr); assert.equal(f.read().finished, true);
  assert.equal(f.read().closeout.details.filter(d => d.status === 'closed').length, 3);
});
