import test from 'node:test';
import assert from 'node:assert/strict';
import { localRepo } from './test-local-repo.mjs';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inputDigest } from './jev.mjs';
import { ask, grant, TOPIC } from './gate-exception.mjs';
import { setGate, readState } from './run-state.mjs';
import { answerCard } from './questions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const jev = join(here, 'jev.mjs');
const RUN = '20261102-exc-cli-test';
const input = {
  objective: 'Keep the selected quantity', criteria: ['The selected quantity is retained'],
  changes: [{ file: 'quantity.mjs', change: 'retain the quantity' }],
  proof: ['node --test quantity.test.mjs'], owned_paths: ['quantity.mjs'], evidence: ['quantity.mjs:1: quantity = 1']
};

function setup(t) {
  const repo = realpathSync(localRepo('jev-exc-cli-'));
  const home = process.env.TRIOHARNESS_HOME;
  process.env.TRIOHARNESS_HOME = join(repo, 'home');
  t.after(() => {
    if (home === undefined) delete process.env.TRIOHARNESS_HOME;
    else process.env.TRIOHARNESS_HOME = home;
    rmSync(repo, { recursive: true, force: true });
  });
  const receipts = join(repo, 'rejected.jsonl');
  writeFileSync(receipts, `${JSON.stringify({ gate: 'plan', verdict: 'revise', pass: false,
    reasons: ['weakens 0.9 > 0.2'], inputSha256: inputDigest('plan', input), at: new Date().toISOString() })}\n`);
  const card = ask({ repo, run: RUN, input, item: 'Retain quantity', receipts });
  answerCard(repo, RUN, card.id, { [TOPIC]: 'proceed' }, { via: 'ui', quote: 'Proceed' });
  const exception = grant({ repo, run: RUN, set: card.id, input });
  const preload = join(repo, 'fetch-mock.mjs');
  const fetchMarker = join(repo, 'fetch-called');
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
  globalThis.fetch = async (_url, options) => {
    writeFileSync(${JSON.stringify(fetchMarker)}, '');
    if (process.env.JEV_TEST_FETCH_FAIL === '1') throw new Error('offline');
    const { questions } = JSON.parse(options.body);
    const answers = Object.fromEntries(Object.keys(questions).map(id => [id, {
      type: 'noul', noul: id === 'weakens' || id === 'failing' ? 0.9 : id === 'unsupported' ? 0 : 0.95
    }]));
    return { ok: true, status: 200, json: async () => ({ answers, model: 'mock' }) };
  };\n`);
  setGate(repo, RUN, { gate: 'base', status: 'passed' });
  const log = join(repo, 'receipts.jsonl');
  const userHome = join(repo, 'user-home');
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'jev-exc-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const foreign = join(outside, 'foreign-cwd');
  mkdirSync(userHome); mkdirSync(foreign);
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, TYPESAFE_API_KEY: randomUUID() };
  function run(gate = 'plan', value = input, fail = false, { cwd = repo, repoFlag = 'exception', explicitLog = true, extraArgs = [] } = {}) {
    const path = join(repo, 'input.json');
    writeFileSync(path, JSON.stringify(value));
    const repoArgs = repoFlag ? [`--${repoFlag}-repo`, relative(cwd, repo) || '.', `--${repoFlag}-run`, RUN] : [];
    return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, jev, gate, path,
      ...repoArgs, ...extraArgs, ...(explicitLog ? ['--log', log] : [])], {
      cwd, encoding: 'utf8', timeout: 10000,
      env: { ...env, GIT_CEILING_DIRECTORIES: outside, JEV_TEST_FETCH_FAIL: fail ? '1' : '0' }
    });
  }
  return { repo, exception, log, userHome, foreign, env, fetchMarker, run };
}

function output(result, status) {
  assert.equal(result.status, status, `CLI exit ${result.status}; signal=${result.signal}; error=${result.error?.message}; stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('plan CLI accepts the granted exact input and writes its waived reasons to the receipt', t => {
  const fixture = setup(t);
  const out = output(fixture.run(), 0);
  assert.equal(out.pass, true);
  assert.equal(out.verdict, 'accepted-exception');
  assert.deepEqual(out.waived, ['weakens 0.9 > 0.2']);
  assert.deepEqual(out.exception, fixture.exception);
  assert.match(out.reasons[0], /waived by the user's exception/);
  const lines = readFileSync(fixture.log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), out);
});

test('HD-3 attempt receipts follow the target repo and feed the exception card from another cwd', t => {
  const fixture = setup(t);
  const value = { ...input, objective: 'Keep the entered quantity', after: 'scope-cut' };
  const options = { cwd: fixture.foreign, repoFlag: 'attempt', explicitLog: false };
  const outcomes = [1, 2, 3].map(attempt => {
    const out = output(fixture.run('plan', value, false, options), 2);
    assert.equal(out.attempt, attempt);
    return out;
  });
  assert.equal(readState(fixture.repo, RUN).status, 'awaiting-exception');
  const card = spawnSync(process.execPath, [join(here, 'gate-exception.mjs'), 'card', '--repo', relative(fixture.foreign, fixture.repo), '--run', RUN,
    '--input', join(fixture.repo, 'input.json'), '--item', 'Retain entered quantity'],
  { cwd: fixture.foreign, env: fixture.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(output(card, 0).status, 'open');
  const dir = join(fixture.userHome, '.trioharness-lean', 'receipts');
  const receipts = readFileSync(join(dir, `${basename(fixture.repo)}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(receipts, outcomes);
  assert.equal(existsSync(join(dir, 'foreign-cwd.jsonl')), false);
});

test('HD-3 exception receipts follow the target repo from another cwd', t => {
  const fixture = setup(t);
  const out = output(fixture.run('plan', input, false, { cwd: fixture.foreign, explicitLog: false }), 0);
  assert.equal(out.verdict, 'accepted-exception');
  const dir = join(fixture.userHome, '.trioharness-lean', 'receipts');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${basename(fixture.repo)}.jsonl`), 'utf8')), out);
  assert.equal(existsSync(join(dir, 'foreign-cwd.jsonl')), false);
});

test('plan CLI refuses conflicting repository flags before sending a request or reserving an attempt', t => {
  const fixture = setup(t);
  const before = readState(fixture.repo, RUN);
  const result = fixture.run('plan', input, false, {
    cwd: fixture.foreign, repoFlag: 'attempt',
    extraArgs: ['--exception-repo', '.', '--exception-run', RUN]
  });
  const out = output(result, 3);
  assert.equal(out.verdict, 'unavailable');
  assert.deepEqual(out.reasons, ['REPO_FLAGS_CONFLICT']);
  assert.equal(existsSync(fixture.fetchMarker), false);
  assert.deepEqual(readState(fixture.repo, RUN), before);
});

test('plan CLI permits both repository flags when they resolve to the same repo', t => {
  const fixture = setup(t);
  const out = output(fixture.run('plan', input, false, {
    cwd: fixture.foreign, repoFlag: 'attempt', explicitLog: false,
    extraArgs: ['--exception-repo', fixture.repo, '--exception-run', RUN]
  }), 0);
  assert.equal(out.verdict, 'accepted-exception');
  assert.deepEqual(out.exception, fixture.exception);
  const dir = join(fixture.userHome, '.trioharness-lean', 'receipts');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${basename(fixture.repo)}.jsonl`), 'utf8')), out);
});

test('plan CLI ignores an exception run value that is another flag', t => {
  const fixture = setup(t);
  const out = output(fixture.run('plan', input, false, {
    repoFlag: null, extraArgs: ['--exception-repo', '.', '--exception-run']
  }), 2);
  assert.equal(out.verdict, 'revise');
  assert.deepEqual(out.reasons, ['weakens 0.9 > 0.2']);
});

test('HD-3 receipts use cwd when no target repo is supplied', t => {
  const fixture = setup(t);
  const out = output(fixture.run('plan', input, false, { cwd: fixture.foreign, repoFlag: null, explicitLog: false }), 2);
  assert.equal(out.verdict, 'revise');
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.userHome, '.trioharness-lean', 'receipts', 'foreign-cwd.jsonl'), 'utf8')), out);
});

test('plan CLI rejects a different input despite the granted exception', t => {
  const fixture = setup(t);
  const out = output(fixture.run('plan', { ...input, objective: 'A different quantity' }), 2);
  assert.equal(out.pass, false);
  assert.equal(out.verdict, 'revise');
  assert.deepEqual(out.reasons, ['weakens 0.9 > 0.2']);
  assert.equal(out.waived, undefined);
});

test('done CLI never waives rejection with exception flags', t => {
  const fixture = setup(t);
  const out = output(fixture.run('done', { objective: input.objective, criteria: input.criteria, evidence: input.evidence }), 2);
  assert.equal(out.pass, false);
  assert.equal(out.verdict, 'revise');
  assert.deepEqual(out.reasons, ['failing 0.9 > 0.2']);
  assert.equal(out.waived, undefined);
  assert.equal(out.exception, undefined);
});

test('plan CLI keeps a fetch failure unavailable despite the granted exception', t => {
  const fixture = setup(t);
  const out = output(fixture.run('plan', input, true), 3);
  assert.equal(out.pass, false);
  assert.equal(out.verdict, 'unavailable');
  assert.deepEqual(out.reasons, ['JEV_UNREACHABLE']);
  assert.equal(out.waived, undefined);
});

test('the Jev dynamic-import closure has no static import path back to Jev', () => {
  const visited = new Set();
  function visit(file, chain) {
    assert.notEqual(file, jev, `dynamic import statically reaches Jev: ${chain.join(' -> ')}`);
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";]+?\s+from\s*)?['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), match[1]);
      visit(target, [...chain, target]);
    }
    for (const match of source.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = resolve(dirname(file), match[1]);
      visit(target, [...chain, target]);
    }
  }
  const source = readFileSync(jev, 'utf8');
  const imports = [...source.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)];
  assert.ok(imports.length > 0, 'Jev must have at least one literal dynamic import');
  for (const match of imports) {
    const target = resolve(here, match[1]);
    visit(target, [jev, target]);
  }
});

test('fix1 M5 outcome notifier preserves exact exception receipt and sends digest to run-state', t => {
  const fixture = setup(t), out = output(fixture.run(), 0);
  const state = readState(fixture.repo, RUN);
  assert.equal(state.planOutcomes.at(-1).verdict, 'accepted-exception');
  assert.equal(state.planOutcomes.at(-1).inputSha256, out.inputSha256);
  assert.deepEqual(JSON.parse(readFileSync(fixture.log, 'utf8').trim()), out);
});

import { reserveAttempt, recordPlanOutcome } from './run-state.mjs';

function budgetCliFixture(t, awaiting = false) {
  const repo = realpathSync(localRepo('jev-budget-cli-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const env = { ...process.env, TRIOHARNESS_HOME: join(repo, 'home'), JEV_KEY_FILE: join(repo, 'none'), TYPESAFE_API_KEY: randomUUID(), JEV_API_KEY: '' };
  setGate(repo, RUN, { gate: 'base', status: 'passed' });
  const digest = inputDigest('plan', input);
  for (let n = 1; n <= 3; n++) {
    const submission = randomUUID(); reserveAttempt(repo, RUN, 'plan', () => {}, submission, digest);
    recordPlanOutcome(repo, RUN, { verdict: awaiting === 'revise' ? 'revise' : awaiting ? 'unavailable' : 'proceed', inputSha256: digest, attempt: n, submission, at: new Date().toISOString() });
  }
  const path = join(repo, 'input.json'), log = join(repo, 'log.jsonl'), preload = join(repo, 'mock.mjs');
  const value = { ...input, after: 'scope-cut' }; writeFileSync(path, JSON.stringify(value));
  writeFileSync(preload, `globalThis.fetch = async (_url, opts) => ({ ok: true, json: async () => ({ model: 'mock',
    answers: Object.fromEntries(Object.keys(JSON.parse(opts.body).questions).map(id => [id, { type: 'noul', noul: id === 'weakens' ? 0 : process.env.BUDGET_TEST_REVISE === '1' ? 0 : 1 }])) }) });`);
  const call = (file, args) => spawnSync(process.execPath, [join(here, file), ...args], { env, encoding: 'utf8', cwd: repo });
  return { repo, path, log, value, digest, call,
    card: () => call('gate-exception.mjs', ['card', '--repo', repo, '--run', RUN, '--input', path, '--item', 'one more submission', '--receipts', join(repo, 'absent')]),
    grant: set => call('gate-exception.mjs', ['grant', '--repo', repo, '--run', RUN, '--input', path, '--set', set]),
    submit: (revise = false) => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, jev, 'plan', path,
      '--attempt-repo', repo, '--attempt-run', RUN, '--log', log], { env: { ...env, BUDGET_TEST_REVISE: revise ? '1' : '0' }, encoding: 'utf8', cwd: repo }) };
}
for (const awaiting of [false, true]) test(`P3 CLI renewal from ${awaiting ? 'third unavailable' : 'capped new entry'} submits once and still requires real Jev`, t => {
  const f = budgetCliFixture(t, awaiting);
  if (!awaiting) {
    const blocked = output(f.submit(), 3); assert.match(blocked.reasons.join(' '), /LOOP_CAP:jev-plan/);
    assert.equal(readState(f.repo, RUN).status, 'awaiting-budget');
  }
  const cardResult = f.card(); assert.equal(cardResult.status, 0, cardResult.stderr);
  const set = JSON.parse(cardResult.stdout).set;
  assert.equal(f.grant(set).status, 3, 'open card cannot grant');
  const answered = f.call('questions.mjs', ['answer', '--repo', f.repo, '--run', RUN, '--set', set,
    '--answers', JSON.stringify({ [TOPIC]: 'renew' }), '--via', 'ui', '--quote', 'Renew one submission']);
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(f.grant(set).status, 0);
  const out = output(f.submit(true), 2); assert.equal(out.verdict, 'revise'); assert.equal(out.exception, undefined);
  assert.equal(readState(f.repo, RUN).loops['jev-plan'], 4);
  assert.equal(readState(f.repo, RUN).planPendingOutcomes, 0);
  const missing = f.card();
  assert.equal(missing.status, 3, 'a second newly issued renewal card is refused');
  assert.equal(missing.stderr, `GATE_EXCEPTION: NO_MATCHING_REJECTION: ${out.inputSha256} not in ${join(f.repo, 'absent')}\n`);
  assert.equal(f.submit().status, 3);
  assert.match(readState(f.repo, RUN).status, /^parked:/);
});

test('r2 cap redemption routes to the CodeDen card and consumes the exact refusal without fetch', t => {
  const f = budgetCliFixture(t, 'revise');
  const refusal = readState(f.repo, RUN).awaitingException;
  writeFileSync(f.log, JSON.stringify({
    gate: 'plan', verdict: 'revise', pass: false, at: refusal.at,
    inputSha256: refusal.inputSha256, reasons: ['coverage loss 0.21 > 0.2']
  }) + '\n');
  const args = ['--repo', f.repo, '--run', RUN, '--input', f.path];
  const card = output(f.call('gate-exception.mjs', ['card', ...args, '--item', 'Retain the quantity', '--receipts', f.log]), 0);
  assert.deepEqual(card.codeDenCard.options.map(o => o.label), ['Park it (Recommended)', 'Proceed, record my exception']);
  assert.match(card.codeDenCard.question, new RegExp(refusal.inputSha256));
  assert.equal(f.grant(card.set).status, 3);
  answerCard(f.repo, RUN, card.set, { [TOPIC]: 'proceed' }, { via: 'ui', quote: 'Proceed, record my exception' });
  assert.equal(f.grant(card.set).status, 0);
  const submit = () => f.call('jev.mjs', ['plan', f.path, '--exception-repo', f.repo, '--exception-run', RUN, '--log', f.log]);
  const other = { ...f.value, objective: 'Different quantity' };
  writeFileSync(f.path, JSON.stringify(other));
  assert.match(output(submit(), 3).reasons[0], /JEV_OWNER_CARD_REQUIRED/);
  writeFileSync(f.path, JSON.stringify(f.value));
  const out = output(submit(), 0);
  assert.equal(out.redeemed, true);
  assert.equal(out.inputSha256, refusal.inputSha256);
  assert.equal(out.jev, undefined);
  assert.equal(readState(f.repo, RUN).loops['jev-plan'], 3);
  assert.match(output(submit(), 3).reasons[0], /JEV_EXCEPTION_CONSUMED/);
});
