import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs');
const run = args => spawnSync(process.execPath, [guard, ...args], { encoding: 'utf8' });

test('scan-before-send: the command runs only when every file is clean', () => {
  const d = mkdtempSync(join(tmpdir(), 'scan-'));
  const clean = join(d, 'clean.txt'), dirty = join(d, 'dirty.txt'), marker = join(d, 'sent');
  writeFileSync(clean, 'only key names here: APP_KEY at src/a.cs:12\n');
  writeFileSync(dirty, 'password = "Zx9!kQ2mPpL4vR8sTt"\n');
  const cmd = ['--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`];
  let r = run(['--scan', dirty, ...cmd]);
  assert.equal(r.status, 2); assert.ok(!existsSync(marker), 'a flagged packet must not be sent'); assert.match(r.stderr, /was NOT run/);
  r = run(['--scan', clean, dirty, ...cmd]);
  assert.equal(r.status, 2); assert.ok(!existsSync(marker), 'one dirty file among clean ones blocks it');
  assert.ok(!r.stdout.includes('Zx9'), 'the report never prints the value');
  r = run(['--scan', clean, ...cmd]);
  assert.equal(r.status, 0); assert.ok(existsSync(marker));
});

test('the command exit status is passed through; a missing command or file list is a usage error', () => {
  const d = mkdtempSync(join(tmpdir(), 'scan-'));
  const clean = join(d, 'c.txt'); writeFileSync(clean, 'ok\n');
  assert.equal(run(['--scan', clean, '--', process.execPath, '-e', 'process.exit(7)']).status, 7);
  assert.equal(run(['--scan', clean, '--']).status, 3);
  assert.equal(run(['--scan', '--', 'echo', 'x']).status, 3);
  assert.equal(run(['--scan', clean, '--', 'definitely-not-a-command-xyz']).status, 3);
});
