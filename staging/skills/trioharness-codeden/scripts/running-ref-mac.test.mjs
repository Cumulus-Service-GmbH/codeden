import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readRunningRefResolution } from './deploy.mjs';
import { loadRunningRefKey, writeSignedRecord } from './running-ref-mac.mjs';
import { buildCard, checkRunningRef, main, readVerifiedRecord, recordRunningRef, resolveRunningRef, runningRefReason } from './running-ref.mjs';
import { answerCard, askCard } from './questions.mjs';
import { checkCli, g, mkRepo, targetRepo } from './running-ref-fixture.mjs';

const file = (r, id) => join(r.work, '.trioharness-direct', 'runs', id, 'running-ref.json');
function writeReceipt(r, id, data) {
  const path = file(r, id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

test('forged full and selected receipts and unsigned legacy receipts fail closed', async () => {
  const r = targetRepo();
  const check = await checkCli(r, ['--target=test,qa']);
  assert.equal(check.status, 0, check.stderr);
  const { mac, ...legacy } = JSON.parse(check.stdout);
  for (const forged of [
    { blocking: false },
    { configured: true, blocking: false, selected: true, targets: ['test'], envs: [{ name: 'test', status: 'same' }] },
    legacy,
    { blocking: true, resolved: { choice: 'overwrite-ok', envs: ['prd'], shas: { prd: r.f1.slice(0, 12) } } }
  ]) {
    writeReceipt(r, 'forged', forged);
    assert.match(runningRefReason(r.work, 'forged', r), /not signed by running-ref.mjs.*Run check again/);
    assert.equal(readRunningRefResolution(r.work, 'forged', r), null);
    assert.throws(() => resolveRunningRef(r.work, 'forged', 'Q-1', r), /not signed/);
    const messages = [];
    assert.equal(await main(['card', '--repo', r.work, '--run', 'forged'], {
      ...r, err: value => messages.push(value), out: value => messages.push(value)
    }), 3);
    assert.match(messages.join(''), /not signed/);
  }
});

test('a real receipt verifies after resolve, but not after an edit or copy to another run or repo', async () => {
  const r = targetRepo();
  const result = await checkRunningRef(r.work, { ...r, readSha: () => ({ ok: true, sha: r.f1 }) });
  const record = recordRunningRef(r.work, 'drift', result, r);
  const set = askCard(r.work, 'drift', buildCard(record));
  answerCard(r.work, 'drift', set.id, { runningref: 'a' }, { via: 'card', quote: 'Leave them alone' });
  const resolved = resolveRunningRef(r.work, 'drift', set.id, r);
  assert.equal(resolved.choice, 'main-only');
  assert.equal(runningRefReason(r.work, 'drift', r), null);
  assert.deepEqual(readRunningRefResolution(r.work, 'drift', r), resolved);
  const signed = readVerifiedRecord(r.work, 'drift', r);
  assert.notEqual(signed.mac.value, record.mac.value);
  assert.equal(signed.mac.v, 1);
  assert.equal(signed.mac.alg, 'hmac-sha256');
  writeReceipt(r, 'drift', { ...signed, resolved: { ...resolved, choice: 'overwrite-ok' } });
  assert.match(runningRefReason(r.work, 'drift', r), /not signed/);
  assert.equal(readRunningRefResolution(r.work, 'drift', r), null);
  writeReceipt(r, 'copy', signed);
  assert.match(runningRefReason(r.work, 'copy', r), /not signed/);
  const other = mkRepo();
  writeReceipt(other, 'drift', signed);
  assert.match(runningRefReason(other.work, 'drift', { keyFile: r.keyFile }), /not signed/);
});

test('deploy accepts a ledger in the same Git repository and refuses a separately signed ledger', () => {
  const r = mkRepo();
  const linked = join(dirname(r.work), 'linked');
  g(r.work, 'worktree', 'add', '--detach', linked);
  const resolved = { choice: 'overwrite-ok', envs: ['qa'], shas: { qa: r.f1.slice(0, 12) } };
  writeSignedRecord(r.work, 'drift', { resolved }, { ...r, create: true });
  assert.deepEqual(readRunningRefResolution(linked, 'drift', { ...r, ledgerDir: r.work }), resolved);
  writeSignedRecord(linked, 'drift', { resolved }, r);
  assert.deepEqual(readRunningRefResolution(r.work, 'drift', { ...r, ledgerDir: linked }), resolved);

  const other = mkRepo();
  writeSignedRecord(other.work, 'drift', { resolved }, r);
  assert.deepEqual(readVerifiedRecord(other.work, 'drift', r).resolved, resolved);
  assert.equal(readRunningRefResolution(r.work, 'drift', { ...r, ledgerDir: other.work }), null);
  assert.equal(readRunningRefResolution(r.work, 'drift', { ...r, ledgerDir: dirname(other.work) }), null);
});

test('a receipt fails verification when the checkout points to a different Git common directory', () => {
  const r = mkRepo();
  const other = mkRepo();
  recordRunningRef(r.work, 'drift', { blocking: false }, r);
  const gitPath = join(r.work, '.git');
  renameSync(gitPath, join(r.work, '.git-original'));
  writeFileSync(gitPath, `gitdir: ${join(other.work, '.git')}\n`);
  assert.throws(() => readVerifiedRecord(r.work, 'drift', r), /not signed/);
});

test('check creates a private key, and both modes reject missing-at-gate and insecure keys', async () => {
  const r = targetRepo();
  const secureFile = `${r.keyFile}.saved`;
  for (const args of [[], ['--target=test,qa']]) {
    const result = await checkCli(r, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(r.keyFile, 'utf8'), /^[0-9a-f]{64}$/);
    assert.equal(statSync(r.keyFile).mode & 0o777, 0o600);
    assert.equal(runningRefReason(r.work, 'selected', r), null);

    chmodSync(r.keyFile, 0o644);
    assert.match(runningRefReason(r.work, 'selected', r), /RUNNING_REF_KEY_INSECURE/);
    const denied = await checkCli(r, args);
    assert.equal(denied.status, 3);
    assert.match(denied.stderr, /RUNNING_REF_KEY_INSECURE/);
    assert.deepEqual(denied.probes, []);
    chmodSync(r.keyFile, 0o600);

    renameSync(r.keyFile, secureFile);
    assert.match(runningRefReason(r.work, 'selected', r), /RUNNING_REF_KEY_MISSING/);
    assert.equal(existsSync(r.keyFile), false);
    const symlink = `${secureFile}.link`;
    if (!existsSync(symlink)) symlinkSync(secureFile, symlink);
    assert.match(runningRefReason(r.work, 'selected', { keyFile: symlink }), /RUNNING_REF_KEY_INSECURE/);
    const badKey = `${secureFile}.bad`;
    writeFileSync(badKey, 'z'.repeat(64), { mode: 0o600 });
    assert.match(runningRefReason(r.work, 'selected', { keyFile: badKey }), /RUNNING_REF_KEY_INSECURE/);
    assert.match(runningRefReason(r.work, 'selected', { keyFile: dirname(badKey) }), /RUNNING_REF_KEY_INSECURE/);
    renameSync(secureFile, r.keyFile);
  }
});

test('Windows key loading skips Unix ownership and permissions but still validates the file and contents', () => {
  const { keyFile } = mkRepo();
  const options = { keyFile, platform: 'win32' };
  const hex = 'ab'.repeat(32);
  writeFileSync(keyFile, hex);
  chmodSync(keyFile, 0o644);
  assert.deepEqual(loadRunningRefKey(options), Buffer.from(hex, 'hex'));
  const symlink = `${keyFile}.link`;
  symlinkSync(keyFile, symlink);
  assert.throws(() => loadRunningRefKey({ ...options, keyFile: symlink }), /expected a regular file/);
  assert.throws(() => loadRunningRefKey({ ...options, keyFile: dirname(keyFile) }), /expected a regular file/);
  writeFileSync(keyFile, 'z'.repeat(64));
  assert.throws(() => loadRunningRefKey(options), /expected 64 hexadecimal characters/);
});
