import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import test from 'node:test';
const jevPath = new URL('./claude/trioharness-codeden/scripts/jev.mjs', import.meta.url);
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== jevPath.href) return result;
    return { ...result, source: readFileSync(jevPath, 'utf8') + '\nexport { readKey, redactCredential, keychainPassword };\n' };
  },
});
const { ask, readKey, redactCredential, keychainPassword, runGate } = await import(jevPath.href);
hooks.deregister();

test('Jev copies match byte for byte', () => {
  const read = path => readFileSync(new URL(path, import.meta.url));
  const baseline = read('./claude/trioharness-codeden/scripts/jev.mjs');
  for (const path of ['./claude/trioharness-lean/scripts/jev.mjs', './codex/trioharness-codeden/scripts/jev.mjs']) {
    assert.ok(baseline.equals(read(path)), path);
  }
});

test('keyring, environment aliases, and file are tried in order', async () => {
  const env = Object.fromEntries([
    ['TYPESAFE_API_KEY', 'env-primary'],
    ['TYPE_SAFE_API_KEY', 'env-alias'],
    ['JEV_API_KEY', 'env-legacy'],
    ['JEV_KEY_FILE', '/fixture.env']
  ]);
  let present = true;
  let fileReads = 0;
  const sources = {
    keyring: async () => present ? 'mock-keyring' : null,
    readFile: file => {
      fileReads++;
      assert.equal(file, env.JEV_KEY_FILE);
      return 'TYPE_SAFE_API_KEY=file-key';
    },
  };
  assert.equal(await readKey(env, sources), 'mock-keyring');
  present = false;
  for (const name of ['TYPESAFE_API_KEY', 'TYPE_SAFE_API_KEY', 'JEV_API_KEY']) {
    assert.equal(await readKey(env, sources), env[name]);
    delete env[name];
  }
  assert.equal(fileReads, 0);
  assert.equal(await readKey(env, sources), 'file-key');
});

test('missing key fails closed and source or response errors omit credentials', async () => {
  const fixture = 'synthetic-credential';
  const key = await readKey({}, { keyring: () => null, readFile: () => { throw Object.assign(new Error(fixture), { code: 'ENOENT' }); } });
  await assert.rejects(ask({}, { key, fetchImpl: () => assert.fail('unexpected network request') }), /JEV_KEY_MISSING.*Keychain/);
  await assert.rejects(readKey({}, {
    keyring: () => { throw new Error(fixture); },
    readFile: () => assert.fail('Keychain refusal must not fall back to a file'),
  }), /^Error: JEV_KEYCHAIN_ACCESS_REQUIRED:/);
  await assert.rejects(readKey({}, {
    keyring: () => null,
    readFile: () => { throw new Error(fixture); },
  }), { message: 'JEV_KEY_FILE_UNREADABLE' });
  await assert.rejects(ask({}, {
    key: fixture, retries: 0,
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error(fixture); } }),
  }), { message: 'JEV_RESPONSE_INVALID' });
});

test('an echoed credential is redacted from nested response data', () => {
  const fixture = 'synthetic-credential';
  assert.deepEqual(redactCredential({ answer: [fixture], [fixture]: 'prefix ' + fixture }, fixture),
    { answer: ['[REDACTED]'], '[REDACTED]': 'prefix [REDACTED]' });
});

test('a skipped gate never opens a credential source', async () => {
  const result = await runGate('finding', { proposed: 'fix' }, {
    loadKey: () => assert.fail('unexpected Keychain access')
  });
  assert.equal(result.verdict, 'no-gate-needed');
});

test('metadata lookup is value-free and only a confirmed item leads to read', { skip: process.platform === 'win32' }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-security-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const security = join(directory, 'security');
  writeFileSync(security, '', { mode: 0o700 });
  const options = { platform: 'darwin', accountHome: directory, home: directory, security };
  const calls = [];
  const mock = (exe, [operation], opts) => {
    assert.equal(exe, security);
    assert.deepEqual(opts.env, {});
    assert.equal(opts.killSignal, 'SIGKILL');
    assert.equal(opts.timeout, 1500);
    calls.push(operation);
    return { status: 0, stdout: operation === 'present' ? '' : 'synthetic-opaque-value' };
  };
  assert.equal(keychainPassword({ ...options, run: mock }), 'synthetic-opaque-value');
  assert.deepEqual(calls, ['present', 'read']);
  assert.equal(keychainPassword({
    ...options, run: (_, args) => {
      assert.deepEqual(args, ['present']);
      return { status: 44, stdout: '' };
    }
  }), null);
  assert.throws(() => keychainPassword({
    ...options, run: (_, args) => {
      assert.deepEqual(args, ['present']);
      return { status: 0, stdout: 'unexpected-value' };
    }
  }), /^Error: JEV_KEYCHAIN_ACCESS_REQUIRED:/);
});

test('a blocking security stub is killed and an ACL denial fails closed', { skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-security-block-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const security = join(directory, 'security');
  writeFileSync(security, `#!/bin/sh
case "$1" in
  present) exit 0 ;;
  read) trap '' TERM; while :; do :; done ;;
  *) exit 3 ;;
esac
`, { mode: 0o700 });
  const options = { platform: 'darwin', accountHome: directory, home: directory, security, timeout: 300 };
  const results = [];
  await assert.rejects(readKey(Object.fromEntries([['TYPESAFE_API_KEY', 'synthetic-fallback']]), {
    keyring: () => keychainPassword({
      ...options, run: (...args) => {
        const result = spawnSync(...args);
        results.push({ mode: args[1][0], signal: result.signal, error: result.error?.code });
        return result;
      }
    }),
    readFile: () => assert.fail('refusal must not fall back')
  }), /^Error: JEV_KEYCHAIN_ACCESS_REQUIRED:/);
  assert.deepEqual(results, [
    { mode: 'present', signal: null, error: undefined },
    { mode: 'read', signal: 'SIGKILL', error: 'ETIMEDOUT' }
  ]);
  assert.throws(() => keychainPassword({
    ...options, run: (_, [mode]) => ({ status: mode === 'present' ? 0 : 3, stdout: '' })
  }), /^Error: JEV_KEYCHAIN_ACCESS_REQUIRED:/);
});
