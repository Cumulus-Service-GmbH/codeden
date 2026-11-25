import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
const jevPath = new URL('./claude/trioharness-codeden/scripts/jev.mjs', import.meta.url);
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== jevPath.href) return result;
    return { ...result, source: readFileSync(jevPath, 'utf8') + '\nexport { readKey, redactCredential };\n' };
  },
});
const { ask, readKey, redactCredential } = await import(jevPath.href);
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
    keyring: async (service, account) => {
      assert.equal(service, 'codeden');
      assert.equal(account, 'typesafe.apiKey');
      return present ? 'mock-keyring' : null;
    },
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
