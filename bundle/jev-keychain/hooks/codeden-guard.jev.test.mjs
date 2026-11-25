import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
