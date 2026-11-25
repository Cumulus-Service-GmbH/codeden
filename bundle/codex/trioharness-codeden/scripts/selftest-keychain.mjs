import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const password = `selftest-${process.pid}`;

function prepareHelper(directory, run, opts) {
  const selected = run('/usr/bin/xcode-select', ['-p'], opts);
  const developer = selected.stdout?.trim();
  if (selected.status !== 0 || !developer || !isAbsolute(developer)) return null;
  const xcode = join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang');
  const clang = existsSync(xcode) ? xcode : join(developer, 'usr/bin/clang');
  const sdk = existsSync(xcode) ? join(developer, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk')
    : join(developer, 'SDKs/MacOSX.sdk');
  if (!existsSync(clang) || !existsSync(sdk)) return null;
  const source = fileURLToPath(new URL('./selftest-keychain.c', import.meta.url));
  const helper = join(directory, 'keychain-test');
  const result = run(clang, ['-isysroot', sdk, '-Wno-deprecated-declarations', source,
    '-framework', 'Security', '-framework', 'CoreFoundation', '-o', helper], opts);
  return result.status === 0 ? helper : null;
}

export function withSelftestKeychain({
  platform = process.platform, home = process.env.HOME, accountHome = userInfo().homedir,
  run = spawnSync, prepare = prepareHelper
}, exercise) {
  if (platform !== 'darwin') return { skip: 'requires macOS' };
  if (!home || !accountHome || resolve(home) !== resolve(accountHome)) return { skip: 'HOME is missing or redirected' };

  let directory;
  try { directory = mkdtempSync(join(realpathSync(tmpdir()), 'trioharness-selftest-keychain-')); }
  catch { return { skip: 'could not create a private temporary directory' }; }

  const keychain = join(directory, 'selftest.keychain-db');
  const owner = lstatSync(directory).uid;
  const opts = { encoding: 'utf8', timeout: 30000, env: { HOME: home, TMPDIR: directory, PATH: '/usr/bin:/bin' } };
  const runSecurity = (operation, args = []) => run('/usr/bin/security', [operation, ...args, keychain], opts);
  const file = () => {
    const stat = lstatSync(keychain, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner || realpathSync(keychain) !== keychain) {
      throw new Error('temporary Keychain path is no longer a private regular file');
    }
    return stat;
  };

  let created;
  const sameFile = current => current && created && current.dev === created.dev && current.ino === created.ino;
  try {
    const helper = prepare(directory, run, opts);
    if (!helper) return { skip: 'could not build the no-UI Keychain helper' };
    if (run(helper, ['check-home'], opts).status !== 0) return { skip: 'HOME differs from the macOS account home' };
    if (file()) throw new Error('temporary Keychain path already exists');
    const creation = runSecurity('create-keychain', ['-p', password]);
    created = file();
    if (creation.status !== 0) return { skip: 'could not create the temporary Keychain' };
    if (!created) return { skip: 'security did not create the explicit temporary Keychain' };

    const call = (operation, service, account, input) => {
      if (!sameFile(file())) {
        throw new Error('temporary Keychain is missing or was replaced');
      }
      const result = run(helper, [operation, keychain, password, service, account], { ...opts, input });
      if (result.status === 44) return null;
      if (result.status !== 0) throw new Error(`temporary Keychain ${operation} failed (exit ${result.status ?? 'unknown'})`);
      return result.stdout ?? '';
    };
    exercise({
      available: () => true,
      get: (service, account) => call('get', service, account),
      info: (service, account) => ({ exists: call('info', service, account) !== null, modified: null }),
      set: (service, account, value) => {
        if (call('set', service, account, value) === null) throw new Error('temporary Keychain write did not create an item');
        if (call('get', service, account) !== value) throw new Error('temporary Keychain read-back did not match');
      },
      delete: (service, account) => call('delete', service, account) !== null
    });
    return {};
  } finally {
    try {
      if (created && !sameFile(file())) throw new Error('temporary Keychain changed before cleanup');
      if (created && runSecurity('delete-keychain').status !== 0) throw new Error('temporary Keychain cleanup failed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
