import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, classifyNeeds, mask, seed, check, ensureSafeFile } from './secrets.mjs';

const SECRETS = join(dirname(fileURLToPath(import.meta.url)), 'secrets.mjs');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'thl-sec-'));
  git(d, 'init', '--quiet', '--initial-branch=main');
  git(d, 'config', 'user.email', 't@e.com'); git(d, 'config', 'user.name', 'T');
  writeFileSync(join(d, 'a.txt'), 'x'); git(d, 'add', 'a.txt'); git(d, 'commit', '--quiet', '-m', 'init');
  return d;
}
const run = (d, args, env = {}) => spawnSync(process.execPath, [SECRETS, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: d, env: { ...process.env, ...env } });

test('parseEnv handles quotes, comments, export and empty placeholders', () => {
  const v = parseEnv('# c\nexport A=1\nB="two words"\nC=\'x\'\nD=val # trailing\nE=\n');
  assert.equal(v.get('A'), '1'); assert.equal(v.get('B'), 'two words'); assert.equal(v.get('C'), 'x'); assert.equal(v.get('D'), 'val'); assert.equal(v.get('E'), '');
});

test('classifyNeeds: env wins, empty file value is missing, bad names are invalid', () => {
  const c = classifyNeeds(['A', 'B', 'C', 'bad-name'], parseEnv('A=\nB=set\n'), { A: 'fromenv' });
  assert.deepEqual(c.present.sort(), ['A', 'B']); assert.deepEqual(c.absent, ['C']); assert.deepEqual(c.empty, []); assert.deepEqual(c.invalid, ['bad-name']);
  assert.deepEqual(classifyNeeds(['A'], parseEnv('A=\n'), {}).empty, ['A']);
});

test('a missing secret is seeded by NAME only, the run stops, and it is never asked again once filled', () => {
  const d = repo();
  let r = run(d, ['check', '--repo', d, '--need', 'JEV_API_KEY,AZ_ACR_TOKEN']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /SECRETS_MISSING: fill JEV_API_KEY, AZ_ACR_TOKEN in \.env/);
  const envFile = join(d, '.env');
  const text = readFileSync(envFile, 'utf8');
  assert.match(text, /^JEV_API_KEY=$/m); assert.match(text, /^AZ_ACR_TOKEN=$/m);
  if (process.platform !== 'win32') assert.equal(statSync(envFile).mode & 0o777, 0o600);
  // .env is now git-ignored (via info/exclude) even though the repo had no .gitignore.
  assert.equal(git(d, 'status', '--porcelain').includes('.env'), false, '.env never shows up as untracked');
  // Second run: still empty → still blocked, names NOT duplicated.
  r = run(d, ['check', '--repo', d, '--need', 'JEV_API_KEY,AZ_ACR_TOKEN']);
  assert.equal(r.status, 2);
  assert.equal((readFileSync(envFile, 'utf8').match(/^JEV_API_KEY=/gm) || []).length, 1);
  // The user fills the values: never asked again.
  writeFileSync(envFile, 'JEV_API_KEY=sk-TESTVALUE1234567890\nAZ_ACR_TOKEN=tok-9876543210abcdef\n');
  r = run(d, ['check', '--repo', d, '--need', 'JEV_API_KEY,AZ_ACR_TOKEN']);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /TESTVALUE|9876543210/, 'values never printed');
});

test('require hands the values to ONE child command only and masks them in its output', () => {
  const d = repo();
  writeFileSync(join(d, '.env'), 'MY_TOKEN=supersecretvalue42\n');
  const r = run(d, ['require', '--repo', d, '--need', 'MY_TOKEN', '--', process.execPath, '-e', 'process.stdout.write("got " + process.env.MY_TOKEN + " len=" + process.env.MY_TOKEN.length)']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /got <secret> len=18/);
  assert.doesNotMatch(r.stdout, /supersecretvalue42/);
  // A sibling process does not see it.
  const r2 = run(d, ['list', '--repo', d]);
  assert.match(r2.stdout, /MY_TOKEN: set/); assert.doesNotMatch(r2.stdout, /supersecret/);
  assert.equal(process.env.MY_TOKEN, undefined);
});

test('a tracked secrets file is refused; mask never leaks', () => {
  const d = repo();
  writeFileSync(join(d, '.env'), 'X=1\n'); git(d, 'add', '-f', '.env'); git(d, 'commit', '--quiet', '-m', 'oops');
  assert.throws(() => ensureSafeFile(d, join(d, '.env')), /SECRETS_FILE_TRACKED/);
  const r = run(d, ['check', '--repo', d, '--need', 'X']);
  assert.equal(r.status, 3); assert.match(r.stderr, /SECRETS_FILE_TRACKED/);
  assert.equal(mask('token abcd1234 and abcd1234 again', ['abcd1234']), 'token <secret> and <secret> again');
  assert.equal(mask('short', ['ab']), 'short');
});

test('seed creates the file with a header once and appends only new names', () => {
  const d = repo();
  const f = join(d, '.env');
  assert.deepEqual(seed(f, ['A', 'B']), ['A', 'B']);
  assert.deepEqual(seed(f, ['B', 'C']), ['C']);
  const t = readFileSync(f, 'utf8');
  assert.equal((t.match(/TrioHarness Lean secrets/g) || []).length, 1);
  assert.deepEqual([...parseEnv(t).keys()], ['A', 'B', 'C']);
  const c = check(d, ['A', 'C'], { env: {} });
  assert.deepEqual(c.missing, ['A', 'C']); assert.equal(c.ok, false);
});


test('require scrubs the inherited environment and keeps only the names asked for; the run-lock chain order works', () => {
  const d = repo();
  writeFileSync(join(d, '.env'), 'MY_TOKEN=supersecretvalue42\n');
  const RUNLOCK = join(dirname(SECRETS), 'run-lock.mjs');
  const probe = [process.execPath, '-e', 'process.stdout.write(["MY_TOKEN","SHELL_SECRET_TOKEN","PLAIN"].map(k=>k+"="+(process.env[k]===undefined?"absent":"present")).join(","))'];
  let r = run(d, ['require', '--repo', d, '--need', 'MY_TOKEN', '--', ...probe], { SHELL_SECRET_TOKEN: 'parentsecret9999', PLAIN: 'ok' });
  assert.equal(r.stdout.trim(), 'MY_TOKEN=present,SHELL_SECRET_TOKEN=absent,PLAIN=present', r.stdout + r.stderr);
  r = spawnSync(process.execPath, [RUNLOCK, 'run', '--name', `s${process.pid}`, '--', process.execPath, SECRETS, 'require', '--repo', d, '--need', 'MY_TOKEN', '--', ...probe], { encoding: 'utf8', cwd: d, env: { ...process.env, SHELL_SECRET_TOKEN: 'parentsecret9999', PLAIN: 'ok' } });
  assert.equal(r.stdout.trim(), 'MY_TOKEN=present,SHELL_SECRET_TOKEN=absent,PLAIN=present', 'run-lock outside, require inside: ' + r.stdout + r.stderr);
  // Large output is not truncated.
  r = run(d, ['require', '--repo', d, '--need', 'MY_TOKEN', '--', process.execPath, '-e', 'process.stdout.write("x".repeat(2*1024*1024))']);
  assert.equal(r.stdout.length, 2 * 1024 * 1024);
});
