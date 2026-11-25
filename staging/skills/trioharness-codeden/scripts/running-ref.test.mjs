import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRunningRef, classifyRunning, buildCard, loadEnvironments, recordRunningRef, resolveRunningRef, runningRefReason, environmentsConfigured, gitIn, readVerifiedRecord } from './running-ref.mjs';
import { askCard, answerCard, validateCard } from './questions.mjs';
import { setGate } from './run-state.mjs';
import { overwriteRefusal } from './deploy.mjs';
import { mkRepo, fakeRead, envFile, H, publish, targetRepo, azureFile, checkCli } from './running-ref-fixture.mjs';

for (const [label, args, envTargets, expected] of [
  ['repeatable flags', ['--target', 'qa', '--target', 'test'], undefined, ['test', 'qa']],
  ['comma-separated flag', ['--target', ' test, qa '], undefined, ['test', 'qa']],
  ['equals flag overrides the environment variable', ['--target=qa,test'], 'prd', ['test', 'qa']],
  ['comma-separated equals flag', ['--target=test,qa'], undefined, ['test', 'qa']],
  ['combined flags and commas', ['--target', 'test,qa', '--target', 'qa'], undefined, ['test', 'qa']],
  ['environment variable', [], 'test, qa', ['test', 'qa']],
  ['CLI wins over the environment variable', ['--target', 'qa,test'], 'prd,unknown', ['test', 'qa']]
]) {
  test(`check selector via ${label}`, async () => {
    const r = targetRepo();
    const result = await checkCli(r, args, envTargets);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.probes, expected.map(name => H(name).url));
    const record = JSON.parse(result.stdout);
    assert.equal(record.selected, true);
    assert.deepEqual(record.targets, expected);
    assert.deepEqual(record.envs.map(e => e.name), expected);
    assert.deepEqual(JSON.parse(readFileSync(join(r.work, '.trioharness-direct', 'runs', 'selected', 'running-ref.json'), 'utf8')), record);
  });
}

test('unknown targets reject the entire selection before reading any SHA', async () => {
  const r = targetRepo();
  const calls = [];
  await assert.rejects(checkRunningRef(r.work, {
    ...r, targets: ['qa', 'missing', 'also-missing'], azureTargetsFile: azureFile({ prd: {} }),
    readSha: health => calls.push(health)
  }), { message: 'RUNNING_REF_UNKNOWN_TARGET: missing, also-missing; known targets: test, qa, prd' });
  assert.deepEqual(calls, []); // nothing probed (the target set itself comes from the fetched remote default branch)
});

for (const [label, args, envTargets, invalid] of [
  ['unknown target', ['--target', 'qa,missing'], undefined, 'missing'],
  ['empty flag selection', ['--target', ','], 'qa', '(empty)'],
  ['missing trailing flag value', ['--target', 'qa', '--target'], undefined, '(empty)'],
  ['missing flag value before another option', ['--target', 'qa', '--target', '--json'], undefined, '(empty)'],
  ['empty flag value', ['--target', ''], undefined, '(empty)'],
  ['empty repeated flag value', ['--target', 'qa', '--target', ''], undefined, '(empty)'],
  ['empty equals flag value', ['--target='], 'qa', '(empty)'],
  ['empty item in a flag', ['--target=qa,'], undefined, '(empty)'],
  ['empty item in an environment selection', [], 'qa,,test', '(empty)'],
  ['empty environment selection', [], ' ', '(empty)']
]) {
  test(`check exits 3 for ${label}`, async () => {
    const result = await checkCli(targetRepo(), args, envTargets);
    assert.equal(result.status, 3, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(result.probes, []);
    assert.equal(result.stderr, `RUNNING-REF: RUNNING_REF_UNKNOWN_TARGET: ${invalid}; known targets: test, qa, prd\n`);
  });
}

test('classify: same, behind, unmerged, unknown, unverified', () => {
  const r = mkRepo(); const git = gitIn(r.work);
  assert.equal(classifyRunning(r.c3, r.c3, git).status, 'same');
  const b = classifyRunning(r.c2.slice(0, 10), r.c3, git); assert.equal(b.status, 'behind'); assert.equal(b.behindBy, 1);
  const u = classifyRunning(r.f1, r.c3, git); assert.equal(u.status, 'unmerged'); assert.equal(u.onlyHere, 1); assert.deepEqual(u.subjects, ['f1']);
  assert.equal(classifyRunning('deadbeefdeadbeef', r.c3, git).status, 'unknown-commit');
  assert.equal(classifyRunning(undefined, r.c3, git).status, 'unverified');
  assert.equal(classifyRunning('not-a-sha', r.c3, git).status, 'unverified');
});

test('not configured: nothing enforced', async () => {
  const r = mkRepo();
  assert.equal(environmentsConfigured(r.work), false);
  assert.equal((await checkRunningRef(r.work, {
    ...r, azureTargetsFile: `${r.azureTargetsFile}.missing`,
    readSha: () => assert.fail('unexpected health probe')
  })).verdict, 'not-configured');
  assert.equal(runningRefReason(r.work, 'r1', r), null);
  assert.equal(setGate(r.work, 'r1', { gate: 'base', status: 'passed', task: 't' }).gates.base.status, 'passed');
});

test('check across four environments, card, answer, resolve, base gate', async () => {
  const r = mkRepo();
  envFile(r.work, { schema: 1, environments: { qa: { health: H('qa') }, prd: { health: H('prd') }, odd: { health: H('odd') }, down: { health: H('down') } } });
  publish(r);
  const read = fakeRead({ 'https://qa/health': { ok: true, sha: r.c2 }, 'https://prd/health': { ok: true, sha: r.f1 }, 'https://odd/health': { ok: true, sha: 'deadbeefdeadbeef' } });
  const res = await checkRunningRef(r.work, { ...r, readSha: read });
  const by = n => res.envs.find(e => e.name === n);
  assert.equal(by('qa').status, 'behind'); assert.equal(by('prd').status, 'unmerged'); assert.equal(by('odd').status, 'unknown-commit'); assert.equal(by('down').status, 'unverified');
  assert.equal(res.blocking, true); assert.equal(res.verdict, 'blocking-drift');

  // base gate refuses: not checked, then unresolved
  assert.match(runningRefReason(r.work, 'r1', r), /running-ref\.mjs check/);
  assert.throws(() => setGate(r.work, 'r1', { gate: 'base', status: 'passed', task: 't' }), /RUNNING_REF_UNRESOLVED/);
  recordRunningRef(r.work, 'r1', res, r);
  assert.match(runningRefReason(r.work, 'r1', r), /ask the card/);

  const card = buildCard(res); validateCard(card);
  assert.equal(card.questions.length, 1); assert.equal(card.questions[0].options.length, 3); assert.equal(card.questions[0].recommended, 'a');
  assert.ok(!JSON.stringify(card).includes('https://'), 'no URLs in the card');
  const asked = askCard(r.work, 'r1', card);
  assert.throws(() => resolveRunningRef(r.work, 'r1', asked.id, r), /SET_NOT_ANSWERED/);
  answerCard(r.work, 'r1', asked.id, { runningref: 'a' }, { via: 'card', quote: 'Base on main' });
  const resolved = resolveRunningRef(r.work, 'r1', asked.id, r);
  assert.equal(resolved.choice, 'main-only'); assert.deepEqual(resolved.envs.sort(), ['odd', 'prd']);
  assert.equal(runningRefReason(r.work, 'r1', r), null);
  assert.ok(readVerifiedRecord(r.work, 'r1', r));
});

test('answer "stop" keeps the base gate closed; a wrong card is refused', async () => {
  const r = mkRepo();
  envFile(r.work, { schema: 1, environments: { prd: { health: H('prd') } } });
  publish(r);
  const res = recordRunningRef(r.work, 'r2', await checkRunningRef(r.work, { ...r, readSha: fakeRead({ 'https://prd/health': { ok: true, sha: r.f1 } }) }), r);
  const other = askCard(r.work, 'r2', { questions: [{ id: 'x', header: 'Other', question: 'Pick one?', options: [{ id: 'a', label: 'A', description: 'option a' }, { id: 'b', label: 'B', description: 'option b' }], recommended: 'a', why: 'because of this' }] });
  answerCard(r.work, 'r2', other.id, { x: 'a' }, { via: 'card', quote: 'A' });
  assert.throws(() => resolveRunningRef(r.work, 'r2', other.id, r), /SET_NOT_RUNNING_REF/);
  const asked = askCard(r.work, 'r2', buildCard(res));
  answerCard(r.work, 'r2', asked.id, { runningref: 'b' }, { via: 'card', quote: 'Stop' });
  assert.equal(resolveRunningRef(r.work, 'r2', asked.id, r).choice, 'stop');
  assert.match(runningRefReason(r.work, 'r2', r), /chose to stop/);
});

test('the running-code question may sit in a multi-question card (the app merges cards)', async () => {
  const r = mkRepo();
  envFile(r.work, { schema: 1, environments: { prd: { health: H('prd') } } });
  publish(r);
  const res = recordRunningRef(r.work, 'r3', await checkRunningRef(r.work, { ...r, readSha: fakeRead({ 'https://prd/health': { ok: true, sha: r.f1 } }) }), r);
  const card = buildCard(res);
  card.questions.push({ id: 'extra', header: 'Extra', question: 'Second question?', options: [{ id: 'a', label: 'Yes', description: 'option a here' }, { id: 'b', label: 'No', description: 'option b here' }], recommended: 'a', why: 'because of this' });
  validateCard(card);
  const asked = askCard(r.work, 'r3', card);
  answerCard(r.work, 'r3', asked.id, { runningref: 'a', extra: 'b' }, { via: 'card', quote: 'Base on main' });
  assert.equal(resolveRunningRef(r.work, 'r3', asked.id, r).choice, 'main-only');
});

test('environments.json refuses secrets and credentialed URLs; deploy.json health is read', () => {
  const r = mkRepo();
  envFile(r.work, { schema: 1, environments: { qa: { health: { url: 'https://u:p@qa/health', shaField: 'commit' } } } });
  assert.throws(() => loadEnvironments(r.work), /credentials/);
  envFile(r.work, { schema: 1, environments: { qa: { health: H('qa'), apiKey: 'x' } } });
  assert.throws(() => loadEnvironments(r.work), /SECRET_FIELD/);
  envFile(r.work, { schema: 1, environments: { qa: { health: H('qa') } } });
  mkdirSync(join(r.work, '.trioharness'), { recursive: true });
  writeFileSync(join(r.work, '.trioharness', 'deploy.json'), JSON.stringify({ schema: 1, targets: { prod: { health: { url: 'https://prd/health', shaField: '.' } } } }));
  assert.deepEqual(Object.keys(loadEnvironments(r.work)).sort(), ['prod', 'qa']);
  envFile(r.work, { schema: 2 });
  assert.throws(() => loadEnvironments(r.work), /ENVIRONMENTS_INVALID/);
  assert.equal(environmentsConfigured(r.work), true, 'a broken declaration still requires the check');
});

test('deploy guard: never silently replace unmerged running code', () => {
  const r = mkRepo(); const git = gitIn(r.work);
  const base = { targetName: 'qa', sha: r.c3, git };
  assert.equal(overwriteRefusal({ ...base, liveSha: r.c2 }), null, 'running code is an ancestor: fine');
  assert.equal(overwriteRefusal({ ...base, liveSha: r.c3 }), null);
  assert.equal(overwriteRefusal({ ...base, liveSha: undefined }), null);
  assert.match(overwriteRefusal({ ...base, liveSha: r.f1 }), /WOULD_OVERWRITE_UNMERGED/);
  assert.match(overwriteRefusal({ ...base, liveSha: 'deadbeefdeadbeef' }), /found in no branch/);
  assert.match(overwriteRefusal({ ...base, liveSha: r.f1, allow: 'wrong' }), /WOULD_OVERWRITE_UNMERGED/);
  assert.equal(overwriteRefusal({ ...base, liveSha: r.f1, allow: r.f1.slice(0, 12) }), null, 'a person with the exact override');
  const agent = { ...base, liveSha: r.f1, allow: r.f1.slice(0, 12), agent: true };
  assert.match(overwriteRefusal(agent), /OVERWRITE_NOT_AUTHORIZED/);
  assert.match(overwriteRefusal({ ...agent, resolution: { choice: 'main-only', envs: ['qa'], shas: { qa: r.f1.slice(0, 12) } } }), /OVERWRITE_NOT_AUTHORIZED/);
  assert.match(overwriteRefusal({ ...agent, resolution: { choice: 'overwrite-ok', envs: ['prd'], shas: { prd: r.f1.slice(0, 12) } } }), /OVERWRITE_NOT_AUTHORIZED/);
  assert.match(overwriteRefusal({ ...agent, resolution: { choice: 'overwrite-ok', envs: ['qa'], shas: { qa: 'aaaaaaaaaaaa' } } }), /OVERWRITE_NOT_AUTHORIZED/);
  assert.equal(overwriteRefusal({ ...agent, resolution: { choice: 'overwrite-ok', envs: ['qa'], shas: { qa: r.f1.slice(0, 12) } } }), null);
});
