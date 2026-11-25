import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { test } from 'node:test';

const source = name => readFileSync(new URL('./' + name, import.meta.url), 'utf8');
const selftest = source('selftest.mjs');

test('selftest routes Keychain operations through the temp-only backend', () => {
  const securityBinary = /['"](?:[^'"]*\/)?security['"]/g;
  assert.doesNotMatch(selftest, securityBinary);
  assert.doesNotMatch(selftest, /\b(?:add|find|delete)-generic-password\b/);
  assert.doesNotMatch(selftest, /sh\('secrets\.mjs'/);
  assert.match(selftest, /runCli\(args, io, \{ kc, platform, env \}\)/);
  assert.match(selftest, /withSelftestKeychain\(\{ platform \}, exercise\)/);

  const helper = source('selftest-keychain.mjs');
  assert.equal([...helper.matchAll(securityBinary)].length, 1);
  assert.doesNotMatch(helper, /\b(?:add|find|delete)-generic-password\b|\b(?:default|login)-keychain\b/);
  assert.match(helper, /run\('\/usr\/bin\/security', \[operation, \.\.\.args, keychain\], opts\)/);
  assert.deepEqual([...helper.matchAll(/runSecurity\('([^']+)'/g)].map(match => match[1]),
    ['create-keychain', 'delete-keychain']);
  assert.match(helper, /run\(helper, \[operation, keychain,/);

  const native = source('selftest-keychain.c');
  assert.match(native, /SecKeychainSetUserInteractionAllowed\(false\)[\s\S]*SecKeychainOpen\(path, &keychain\)/);
  assert.doesNotMatch(native, /SecKeychain(?:CopyDefault|CopySearchList|SetDefault|Login)/);
  for (const operation of ['Unlock', 'FindGenericPassword', 'AddGenericPassword']) {
    assert.match(native, new RegExp(`SecKeychain${operation}\\(keychain,`));
  }
});

test('missing or redirected HOME skips before starting any Keychain process', async () => {
  const { withSelftestKeychain } = await import('./selftest-keychain.mjs');
  for (const home of [null, '/redirected']) {
    const result = withSelftestKeychain({
      platform: 'darwin', home, accountHome: '/owner',
      run: () => assert.fail('started a Keychain process')
    }, () => assert.fail('entered Keychain test'));
    assert.match(result.skip, /HOME/);
  }
});

test('native HOME mismatch skips before consulting security', async () => {
  const { withSelftestKeychain } = await import('./selftest-keychain.mjs');
  const result = withSelftestKeychain({
    platform: 'darwin', home: '/owner', accountHome: '/owner',
    prepare: () => '/test-helper',
    run: (command, args) => {
      assert.equal(command, '/test-helper');
      assert.deepEqual(args, ['check-home']);
      return { status: 3 };
    }
  }, () => assert.fail('entered Keychain test'));
  assert.match(result.skip, /HOME/);
});

const options = run => ({
  platform: 'darwin', home: '/owner', accountHome: '/owner', prepare: () => '/test-helper', run
});

test('every operation targets the created file and cleanup runs on exercise failure', async () => {
  const { withSelftestKeychain } = await import('./selftest-keychain.mjs');
  const commands = [];
  let path;
  const run = (command, args, { input }) => {
    const [operation] = args;
    commands.push(operation);
    if (operation === 'check-home') return { status: 0 };
    if (operation === 'create-keychain') {
      assert.equal(command, '/usr/bin/security');
      assert.equal(args[1], '-p');
      path = args.at(-1);
      assert.ok(isAbsolute(path));
      assert.match(basename(dirname(path)), /^trioharness-selftest-keychain-/);
      assert.equal(basename(path), 'selftest.keychain-db');
      writeFileSync(path, '');
    } else if (operation === 'delete-keychain') {
      assert.equal(command, '/usr/bin/security');
      assert.deepEqual(args, [operation, path]);
      unlinkSync(path);
    } else {
      assert.equal(command, '/test-helper');
      assert.equal(args[1], path);
      if (operation === 'set') assert.equal(input, 'synthetic-value');
    }
    return { status: 0, stdout: 'synthetic-value' };
  };
  assert.throws(() => withSelftestKeychain(options(run), kc => {
    kc.set('service', 'account', 'synthetic-value');
    assert.equal(kc.get('service', 'account'), 'synthetic-value');
    assert.equal(kc.info('service', 'account').exists, true);
    assert.equal(kc.delete('service', 'account'), true);
    throw new Error('exercise failed');
  }), /exercise failed/);
  assert.deepEqual(commands, ['check-home', 'create-keychain', 'set', 'get', 'get', 'info', 'delete', 'delete-keychain']);
  assert.equal(existsSync(path), false);
});

test('failed creation skips and cleans up a partially created explicit path', async () => {
  const { withSelftestKeychain } = await import('./selftest-keychain.mjs');
  let path;
  let deleted = false;
  const result = withSelftestKeychain(options((command, args) => {
    if (args[0] === 'check-home') return { status: 0 };
    assert.equal(command, '/usr/bin/security');
    if (args[0] === 'create-keychain') {
      path = args.at(-1);
      writeFileSync(path, '');
      return { status: 3 };
    }
    assert.deepEqual(args, ['delete-keychain', path]);
    deleted = true;
    return { status: 0 };
  }), () => assert.fail('entered Keychain test'));
  assert.match(result.skip, /could not create/);
  assert.equal(deleted, true);
  assert.equal(existsSync(path), false);
});


test('a replaced Keychain cannot be used or passed to security for cleanup', async () => {
  const { withSelftestKeychain } = await import('./selftest-keychain.mjs');
  let path;
  const run = (command, args) => {
    if (args[0] === 'check-home') return { status: 0 };
    assert.equal(command, '/usr/bin/security');
    assert.equal(args[0], 'create-keychain');
    path = args.at(-1);
    writeFileSync(path, '');
    return { status: 0 };
  };
  assert.throws(() => withSelftestKeychain(options(run), kc => {
    renameSync(path, path + '.old');
    writeFileSync(path, '');
    assert.throws(() => kc.get('service', 'account'), /missing or was replaced/);
  }), /changed before cleanup/);
  assert.equal(existsSync(path), false);
});
