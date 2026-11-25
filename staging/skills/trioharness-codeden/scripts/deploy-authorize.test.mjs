import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { authorizeArgument, checkPreconditions, checkRollbackAuthorization, checkTrustedPlacement, revisionCleanupPhrase } from './deploy.mjs';

const sha = '123456789abc'.repeat(3) + '1234';
const base = { sha, shaOnRemote: true, shaOnDefault: true, sameShaOn: [], isTTY: true, env: { CLAUDECODE: '1' } };
const phrase = 'app-prd:123456789abc:cleanup-08b36957';

test('a supplied --authorize must equal the plan phrase in every deploy mode', () => {
  for (const [agentAllowed, env, isTTY] of [[true, { CLAUDECODE: '1' }, false], ['with-authorization', {}, true], ['with-authorization', { CLAUDECODE: '1' }, false]]) {
    const target = { app: 'app-prd', agentAllowed };
    const args = { ...base, target, targetName: 'prod', env, isTTY, phrase, cleanupNames: ['app-prd--old'] };
    assert.doesNotThrow(() => checkPreconditions({ ...args, authorization: phrase }), String(agentAllowed));
    for (const stale of ['app-prd:123456789abc:cleanup-08b36958', 'app-prd:123456789abc', 'app-prd:stage:123456789abc']) {
      assert.throws(() => checkPreconditions({ ...args, authorization: stale }), /AUTHORIZATION_MISMATCH|AUTHORIZATION_REQUIRED/, `${agentAllowed} ${stale}`);
    }
  }
  const target = { app: 'app-qa', agentAllowed: true };
  assert.doesNotThrow(() => checkPreconditions({ ...base, target, targetName: 'qa', env: { CLAUDECODE: '1' }, isTTY: false }));
});

test('the cleanup phrase binds the Azure placement, and a pinned app must use its trusted placement', () => {
  const sha = '123456789abc'.repeat(3) + '1234';
  const target = { app: 'app-prd', subscription: 's1', resourceGroup: 'rg1', revisionCleanup: { quietDays: 7 } };
  const phrase = revisionCleanupPhrase('prod', target, sha, ['app-prd--old']);
  assert.notEqual(phrase, revisionCleanupPhrase('prod', { ...target, subscription: 's2' }, sha, ['app-prd--old']));
  assert.notEqual(phrase, revisionCleanupPhrase('prod', { ...target, resourceGroup: 'rg2' }, sha, ['app-prd--old']));
  const file = join(mkdtempSync(join(tmpdir(), 'placement-')), 'azure-targets.json');
  writeFileSync(file, JSON.stringify({ prd: { apps: [{ name: 'app-prd', subscription: 's1', resourceGroup: 'rg1' }] } }));
  assert.doesNotThrow(() => checkTrustedPlacement(target, file));
  assert.throws(() => checkTrustedPlacement({ ...target, subscription: 's2' }, file), /PLACEMENT_MISMATCH/);
  assert.throws(() => checkTrustedPlacement({ ...target, resourceGroup: 'rg2' }, file), /PLACEMENT_MISMATCH/);
  assert.doesNotThrow(() => checkTrustedPlacement({ ...target, app: 'other' }, file));
});

test('a supplied rollback phrase must name this rollback in every mode', () => {
  for (const agentAllowed of [true, 'with-authorization']) {
    const target = { app: 'app-prd', agentAllowed };
    const args = { target, targetName: 'prod', revision: 'app-prd--r1', env: {}, isTTY: true };
    assert.doesNotThrow(() => checkRollbackAuthorization({ ...args, authorization: 'app-prd:rollback:app-prd--r1' }));
    assert.throws(() => checkRollbackAuthorization({ ...args, authorization: 'app-prd:rollback:app-prd--r2' }), /AUTHORIZATION_REQUIRED/);
  }
});

test('trusted placement fails closed for protected targets and incomplete pins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'placement-'));
  const protectedTarget = { app: 'app-prd', subscription: 's1', resourceGroup: 'rg1', agentAllowed: 'with-authorization' };
  const open = { ...protectedTarget, agentAllowed: true };
  const write = (name, text) => { const file = join(dir, name); writeFileSync(file, text); return file; };
  for (const file of [join(dir, 'missing.json'), write('bad.json', '{'), write('noapps.json', '{"prd":{}}')]) {
    assert.throws(() => checkTrustedPlacement(protectedTarget, file), /PLACEMENT_UNVERIFIED/, file);
    assert.doesNotThrow(() => checkTrustedPlacement(open, file), file);
  }
  for (const pin of [{ name: 'app-prd', subscription: 's1' }, { name: 'app-prd', resourceGroup: 'rg1' }]) {
    assert.throws(() => checkTrustedPlacement(open, write('partial.json', JSON.stringify({ prd: { apps: [pin] } }))), /PLACEMENT_UNVERIFIED/);
  }
});

test('deploy main() checks the trusted placement right after resolving the target, before rollback or any change', () => {
  const source = readFileSync(new URL('./deploy.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(!target\) throw new Refusal\(`UNKNOWN_TARGET:[^\n]*\n  checkTrustedPlacement\(target\);\n/);
  assert.ok(source.indexOf('checkTrustedPlacement(target);') < source.indexOf("argv.includes('--rollback')"));
});

test('a supplied --authorize keeps its presence; an empty value is refused', () => {
  assert.equal(authorizeArgument(['--target', 'prod']), null);
  assert.equal(authorizeArgument(['--authorize', 'app:1']), 'app:1');
  for (const argv of [['--authorize', ''], ['--authorize'], ['--authorize', '--dry-run']]) {
    assert.throws(() => authorizeArgument(argv), /AUTHORIZATION_REQUIRED/, JSON.stringify(argv));
  }
});
