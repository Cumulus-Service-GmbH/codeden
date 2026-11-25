import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import test from 'node:test';
const jevPath = new URL('./claude/trioharness-codeden/scripts/jev.mjs', import.meta.url);
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== jevPath.href) return result;
    return { ...result, source: readFileSync(jevPath, 'utf8') + '\nexport { loadJevSource, redactCredential, keychainTransport };\n' };
  },
});
const { ask, loadJevSource, redactCredential, keychainTransport, runGate } = await import(jevPath.href);
hooks.deregister();

const readerPath = home => join(home, '.config/trioharness/jev-keyring-runtime/bin/jev-keychain-reader');

test('9.R2: the JS preflight denies a reader reached through a symlinked parent before spawn', t => {
  const directory = realpathSync(mkdtempSync(join(process.cwd(), '.jev-security-alias-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  const alias = join(directory, 'alias');
  const security = readerPath(home);
  mkdirSync(dirname(security), { recursive: true });
  writeFileSync(security, '', { mode: 0o500 });
  symlinkSync(home, alias);
  assert.throws(() => keychainTransport({ platform: 'darwin', accountHome: alias, home: alias,
    run: () => assert.fail('spawned a reader through an alias') }),
  /^Error: JEV_KEYCHAIN_ACCESS_REQUIRED:/);
});

test('Jev copies match byte for byte', () => {
  const read = path => readFileSync(new URL(path, import.meta.url));
  const baseline = read('./claude/trioharness-codeden/scripts/jev.mjs');
  for (const path of ['./claude/trioharness-lean/scripts/jev.mjs', './codex/trioharness-codeden/scripts/jev.mjs']) {
    assert.ok(baseline.equals(read(path)), path);
  }
});

test('native transport, environment aliases, and file are tried in order', async () => {
  const env = Object.fromEntries([
    ['TYPESAFE_API_KEY', 'env-primary'],
    ['TYPE_SAFE_API_KEY', 'env-alias'],
    ['JEV_API_KEY', 'env-legacy'],
    ['JEV_KEY_FILE', '/fixture.env']
  ]);
  const transport = { send: () => assert.fail('unexpected network request') };
  let present = true;
  let fileReads = 0;
  const sources = {
    keychain: async () => present ? transport : null,
    readFile: file => {
      fileReads++;
      assert.equal(file, env.JEV_KEY_FILE);
      return 'TYPE_SAFE_API_KEY=file-key';
    },
  };
  assert.equal(await loadJevSource(env, sources), transport);
  present = false;
  for (const name of ['TYPESAFE_API_KEY', 'TYPE_SAFE_API_KEY', 'JEV_API_KEY']) {
    assert.equal((await loadJevSource(env, sources)).key, env[name]);
    delete env[name];
  }
  assert.equal(fileReads, 0);
  assert.equal((await loadJevSource(env, sources)).key, 'file-key');
});

test('missing key fails closed and source or response errors omit credentials', async () => {
  const fixture = 'synthetic-credential';
  const { key } = await loadJevSource({}, { keychain: () => null, readFile: () => { throw Object.assign(new Error(fixture), { code: 'ENOENT' }); } });
  await assert.rejects(ask({}, { key, fetchImpl: () => assert.fail('unexpected network request') }), /JEV_KEY_MISSING.*Keychain/);
  await assert.rejects(loadJevSource({}, {
    keychain: () => { throw new Error(fixture); },
    readFile: () => assert.fail('Keychain refusal must not fall back to a file'),
  }), /^Error: JEV_KEYCHAIN_ACCESS_REQUIRED:/);
  await assert.rejects(loadJevSource({}, {
    keychain: () => null,
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
    loadSource: () => assert.fail('unexpected Keychain access')
  });
  assert.equal(result.verdict, 'no-gate-needed');
});

test('9.R2: presence returns no value and request sends only JSON to the native transport', { skip: process.platform === 'win32' }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jev-security-fixture-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const security = readerPath(directory);
  mkdirSync(dirname(security), { recursive: true });
  writeFileSync(security, '', { mode: 0o700 });
  const options = { platform: 'darwin', accountHome: directory, home: directory };
  const request = { model: 'jev-latest', state: {}, questions: {} };
  const calls = [];
  const mock = (exe, [operation], opts) => {
    assert.equal(exe, security);
    assert.deepEqual(opts.env, {});
    assert.equal(opts.killSignal, 'SIGKILL');
    assert.equal(opts.timeout, operation === 'request' ? 22000 : 1500);
    assert.equal(opts.input, operation === 'request' ? JSON.stringify(request) : undefined);
    calls.push(operation);
    return { status: 0, stdout: operation === 'request' ? '200\n{"answers":{}}' : '' };
  };
  const transport = keychainTransport({ ...options, run: mock });
  transport.verify();
  assert.deepEqual(await ask(request, { ...transport, fetchImpl: () => assert.fail('used JS fetch') }), { answers: {} });
  assert.deepEqual(calls, ['present', 'ready', 'request']);
  assert.equal(keychainTransport({
    ...options, run: (_, args) => {
      assert.deepEqual(args, ['present']);
      return { status: 44, stdout: '' };
    }
  }), null);
  assert.throws(() => keychainTransport({
    ...options, run: (_, args) => {
      assert.deepEqual(args, ['present']);
      return { status: 0, stdout: 'unexpected-value' };
    }
  }), /^Error: JEV_KEYCHAIN_ACCESS_REQUIRED:/);
});

test('a blocking native preflight is killed and an ACL denial never uses a legacy source', { skip: process.platform === 'win32' }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jev-security-block-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const security = readerPath(directory);
  mkdirSync(dirname(security), { recursive: true });
  writeFileSync(security, `#!/bin/sh
case "$1" in
  present) exit 0 ;;
  ready) trap '' TERM; while :; do :; done ;;
  *) exit 3 ;;
esac
`, { mode: 0o700 });
  const options = { platform: 'darwin', accountHome: directory, home: directory, timeout: 300 };
  const results = [];
  const env = Object.fromEntries([['TYPESAFE_API_KEY', 'synthetic-fallback']]);
  const transport = await loadJevSource(env, {
    keychain: () => keychainTransport({
      ...options, run: (...args) => {
        const result = spawnSync(...args);
        results.push({ mode: args[1][0], signal: result.signal, error: result.error?.code });
        return result;
      }
    }),
    readFile: () => assert.fail('refusal must not fall back')
  });
  assert.throws(() => transport.verify(), /^Error: JEV_KEYCHAIN_ACCESS_REQUIRED:/);
  assert.deepEqual(results, [
    { mode: 'present', signal: null, error: undefined },
    { mode: 'ready', signal: 'SIGKILL', error: 'ETIMEDOUT' }
  ]);
  for (const failure of [{ status: 3 }, { status: null, signal: 'SIGALRM' }]) {
    const denied = keychainTransport({
      ...options, run: (_, [mode]) => ({ ...(mode === 'present' ? { status: 0 } : failure), stdout: '' })
    });
    await assert.rejects(ask({}, { ...denied, fetchImpl: () => assert.fail('used legacy fetch') }),
      /^Error: JEV_KEYCHAIN_ACCESS_REQUIRED:/);
  }
});
