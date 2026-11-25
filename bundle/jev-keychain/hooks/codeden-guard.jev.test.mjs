import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkCommand, loadAzureTargets } from './codeden-guard.mjs';

const targets = loadAzureTargets(new URL('./fixtures/azure-targets.json', import.meta.url));

test('Jev credentials are hard-denied for shell commands and scripts', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-jev-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const secretPath = '~/.config/trioharness/jev.env';
  const keychain = 'security find-generic-password -s codeden -a typesafe.apiKey';
  writeFileSync(join(cwd, 'read.sh'), 'cat ' + secretPath);
  writeFileSync(join(cwd, 'read.mjs'), 'readFileSync("' + secretPath + '")');
  for (const command of [
    '~/.config/trioharness/jev-keyring-runtime/bin/jev-keychain-reader read',
    'cat ' + secretPath, 'cat < "$HOME/.config/trioharness/jev.env"',
    'sh read.sh', 'node read.mjs',
    keychain, 'zsh -c ' + JSON.stringify(keychain),
    'node -e ' + JSON.stringify('new AsyncEntry("codeden", "typesafe.apiKey").getPassword()'),
  ]) assert.match(checkCommand(command, targets, 0, { cwd }), /credential file|Jev credential|keychain/i, command);
  assert.equal(checkCommand('cat ~/.config/trioharness/team.json', targets, 0, { cwd }), null);
});

test('Jev credential reads return hard-deny through the Claude and Codex hooks', () => {
  const hook = fileURLToPath(new URL('./codeden-guard.mjs', import.meta.url));
  const cwd = join(process.env.HOME, '.codeden', 'wt', 'guard-test');
  const commands = [
    'cat < ~/.config/trioharness/jev.env',
    'security find-generic-password -s codeden -a typesafe.apiKey',
  ];
  for (const args of [[], ['codex']]) {
    for (const permission_mode of ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan']) {
      for (const command of commands) {
        const result = spawnSync(process.execPath, [hook, ...args], {
          input: JSON.stringify({ cwd, permission_mode, tool_name: 'Bash', tool_input: { command } }),
          encoding: 'utf8',
        });
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, /credential|keychain/i);
      }
    }
  }
});

test('Jev path protection covers aliases, ancestor operands and globs with exact presence allowed',
  { skip: process.platform === 'win32' && 'requires POSIX symlinks' }, t => {
    const cwd = mkdtempSync(join(process.cwd(), '.guard-jev-reader-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const home = join(cwd, 'home');
    const reader = join(home, '.config/trioharness/jev-keyring-runtime/bin/jev-keychain-reader');
    mkdirSync(dirname(reader), { recursive: true });
    writeFileSync(reader, '#!/bin/sh\nexit 3\n', { mode: 0o500 });
    symlinkSync(reader, join(cwd, 'fixture-alias'));
    const fallback = join(home, '.config/trioharness/jev.env');
    writeFileSync(fallback, '# synthetic fixture only\n', { mode: 0o600 });
    symlinkSync(fallback, join(cwd, 'fixture-legacy-alias'));
    const childDir = join(home, '.config/trioharness/fixture-child');
    mkdirSync(childDir);

    const guard = new URL('./codeden-guard.mjs', import.meta.url).href;
    const secrets = new URL('./codeden-guard-secrets.mjs', import.meta.url).href;
    const azure = new URL('./fixtures/azure-targets.json', import.meta.url).href;
    const script = `
      import { checkCommand, loadAzureTargets } from ${JSON.stringify(guard)};
      import { checkExecution } from ${JSON.stringify(secrets)};
      const targets = loadAzureTargets(new URL(${JSON.stringify(azure)}));
      const check = (command, cwd = process.cwd()) => checkCommand(command, targets, 0, { cwd });
      for (const command of [
        './fixture-alias read',
        'cp ./fixture-alias ./fixture-copy',
        'cat < ./fixture-alias',
        'cp ~/.config/trioharness/jev-keyring-runtime/bin/* ./fixture-copy',
        'cp -R ~/.config/trioharness/jev-keyring-runtime/bin ./fixture-copy',
        'dd if=./fixture-alias of=./fixture-copy',
        'env -C "$HOME" cp .config/trioharness/jev-keyring-runtime/bin/* ./fixture-copy',
        'cp -R ~/.config/trioharness ./fixture-copy',
        'fixture-alias read',
        'cp ~/.config/trioharness/jev-keyring-runtim?/bin/* ./fixture-copy',
        'cp ~/.config/trioharnes[s]/jev-keyring-runtim?/bin/jev-keychain-reade? ./fixture-copy',
        'zip -r ./fixture-copy ./home/.config/trioharness',
        'bsdtar -cf ./fixture-copy -C./home/.config/trioharness config.json',
        'zip -r ./fixture-copy "$HOME"',
        'tar -cf ./fixture-copy ~',
        'dd if=./fixture-legacy-alias of=./fixture-copy'
      ]) {
        const denial = check(command);
        if (!denial) { console.error(command); process.exit(1); }
      }
      if (!/Jev credential/i.test(check('./fixture-alias present') || '')) process.exit(2);
      if (check(${JSON.stringify(JSON.stringify(reader) + ' present')})) process.exit(3);
      if (!check('zip -r ./fixture-copy ..', ${JSON.stringify(childDir)})) process.exit(4);
      if (!check('zip -r ./fixture-copy trioharness', ${JSON.stringify(dirname(dirname(childDir)))})) process.exit(5);
      if (check('ls "$HOME"') || check('printf "%s" "example?[text]"')) process.exit(6);
      for (const command of [
        'bsdtar -cf ./fixture-copy -C./home/.config/trioharness config.json',
        'cp ~/.config/trioharnes[s]/jev-keyring-runtim?/bin/jev-keychain-reade? ./fixture-copy',
        'dd if=./fixture-legacy-alias of=./fixture-copy'
      ]) {
        const [program, ...args] = command.split(' ').map(value => ({ value, syntax: value }));
        const denial = checkExecution(program, args, () => true, () => null, { cwd: process.cwd() });
        if (!/Jev credential/i.test(denial || '')) { console.error(command, denial); process.exit(7); }
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { env: { HOME: home, PATH: cwd + (process.env.PATH ? ':' + process.env.PATH : '') }, cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });


test('9.R3 and 10.R1: reader references in interpreter source are denied regardless of argument order', () => {
  const mode = 'fixture-operation';
  const program = 'm = ' + JSON.stringify(mode) +
    '; from subprocess import run; run(["/fixture/jev-keyring-runtime/bin/jev-keychain-reader", m])';
  assert.match(checkCommand('python3 -c ' + JSON.stringify(program), targets), /Jev credential/i);
});
