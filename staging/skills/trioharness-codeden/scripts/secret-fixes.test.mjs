import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, mkdirSync as fsMkdir, copyFileSync as fsCopy, chmodSync as fsChmod } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hiddenPrompt } from './secret-store.mjs';
import { promptLabel } from './secrets.mjs';
import { isSecretFile, findSecrets } from './secret-patterns.mjs';
import { isMain } from './is-main.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('the dialog label the broker builds is accepted by the dialog itself (it was rejected because of a comma)', () => {
  const label = promptLabel('E2E_PASSWORD', 'Cumulus-Service-GmbH/WebChatMobile');
  let script = '';
  const v = hiddenPrompt(label, { platform: 'darwin', exec: (_b, args) => { script = args[1]; return 'x-value\n'; } });
  assert.equal(v, 'x-value'); assert.ok(script.includes(label));
  assert.throws(() => hiddenPrompt('bad "quote', { platform: 'darwin', exec: () => '' }), /PROMPT_LABEL_INVALID/);
  assert.throws(() => hiddenPrompt('bad\nnewline', { platform: 'darwin', exec: () => '' }), /PROMPT_LABEL_INVALID/);
});

test('the secrets manifest (names only) may be committed; any other secrets file is still refused', () => {
  assert.equal(isSecretFile('.trioharness/secrets.json'), null);
  assert.equal(isSecretFile('app/.trioharness/secrets.json'), null);
  for (const f of ['secrets.json', 'config/secrets.json', '.trioharness/secrets.yaml', 'other/secrets.json', '.env']) assert.ok(isSecretFile(f), f);
  const manifest = JSON.stringify({ version: 1, secrets: [{ name: 'E2E_PASSWORD', purpose: 'test account password', env: 'QA', store: 'keychain', scopes: ['proof'], delegate: 'architect', required: true }] }, null, 2);
  assert.deepEqual(findSecrets(manifest), [], 'a manifest of names and rules is not secret-shaped');
  assert.ok(findSecrets('{ "password": "Zx9!kQ2mPpL4vR8sTt" }').length || findSecrets('password = "Zx9!kQ2mPpL4vR8sTt"').length, 'a real value in it would still be caught');
  assert.match(readFileSync(join(here, '..', 'templates', 'repo', 'pre-push'), 'utf8'), /grep -v -E -e '\(\^\|\/\)\\\.trioharness\/secrets\\\.json\$'/);
});

test('a script started through a symlinked folder still runs (it used to exit 0 silently)', () => {
  const d = mkdtempSync(join(tmpdir(), 'lnk-'));
  const link = join(d, 'scripts-link'); symlinkSync(here, link);
  const f = join(d, 'dirty.txt'); writeFileSync(f, 'password = "Zx9!kQ2mPpL4vR8sTt"\n');
  const r = spawnSync(process.execPath, [join(link, 'guard.mjs'), '--scan', f], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'the scan really ran and flagged the file'); assert.match(r.stdout, /"hits"/);
  const m = spawnSync(process.execPath, [join(link, 'standing-orders.mjs'), 'list', '--repo', d], { encoding: 'utf8', env: { ...process.env, TRIOHARNESS_HOME: d } });
  assert.match(m.stdout, /no standing orders/);
  assert.equal(isMain('file:///nope/x.mjs', '/nope/x.mjs'), false);
  assert.equal(isMain(import.meta.url, ''), false);
});

test('pre-push hook: a marked agent can push the secrets manifest on a task branch, but not another secrets.json', () => {
  const { mkdirSync, copyFileSync, chmodSync } = require_fs();
  const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  const bare = mkdtempSync(join(tmpdir(), 'bare-')); spawnSync('git', ['init', '--quiet', '--bare', bare]);
  const w = mkdtempSync(join(tmpdir(), 'w-')); git(w, 'init', '--quiet', '--initial-branch=main'); git(w, 'config', 'user.email', 't@example.com'); git(w, 'config', 'user.name', 'T');
  git(w, 'remote', 'add', 'origin', bare); writeFileSync(join(w, 'a.txt'), 'x'); git(w, 'add', '.'); git(w, 'commit', '--quiet', '-m', 'init'); git(w, 'push', '--quiet', 'origin', 'main');
  const hook = join(w, '.git', 'hooks', 'pre-push'); copyFileSync(join(here, '..', 'templates', 'repo', 'pre-push'), hook); chmodSync(hook, 0o755);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', TRIOHARNESS_AGENT: '1' };
  const push = br => spawnSync('git', ['-C', w, 'push', 'origin', br], { encoding: 'utf8', env });
  git(w, 'switch', '--quiet', '-c', 'bambooed/ok'); mkdirSync(join(w, '.trioharness'));
  writeFileSync(join(w, '.trioharness', 'secrets.json'), JSON.stringify({ version: 1, secrets: [{ name: 'E2E_PASSWORD', purpose: 'test account', env: 'QA', store: 'keychain', scopes: ['proof'], delegate: 'architect', required: true }] }, null, 2));
  git(w, 'add', '-f', '.'); git(w, 'commit', '--quiet', '-m', 'manifest');
  const ok = push('bambooed/ok'); assert.equal(ok.status, 0, ok.stderr);
  git(w, 'switch', '--quiet', '-c', 'bambooed/bad'); writeFileSync(join(w, 'secrets.json'), '{}'); git(w, 'add', '-f', '.'); git(w, 'commit', '--quiet', '-m', 'bad');
  const bad = push('bambooed/bad'); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /secrets?\.json|credential/i);
});
function require_fs() { return { mkdirSync: fsMkdir, copyFileSync: fsCopy, chmodSync: fsChmod }; }

test('a Key Vault declaration is written without a secret-shaped field, passes the scanners, and loads back', async () => {
  const { spawnSync: sp } = await import('node:child_process');
  const { loadManifest } = await import('./secret-store.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'kv-'));
  sp('git', ['init', '--quiet', repo]); sp('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git']);
  const r = sp(process.execPath, [join(here, 'secrets.mjs'), 'declare', '--repo', repo, '--name', 'ERPUREAI_CONNECTION', '--purpose', 'db connection', '--keyvault', 'kv-a3632d43/ERPureAI-ConnectionString', '--env', 'prd'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(join(repo, '.trioharness', 'secrets.json'), 'utf8');
  assert.ok(text.includes('ERPureAI-ConnectionString') && text.includes('"secretName"'));
  assert.deepEqual(findSecrets(text), [], 'the manifest line scan (guard and hook) finds nothing');
  const m = loadManifest(repo);
  assert.equal(m.exists, true);
  assert.equal([...m.secrets.values()][0].keyvault.secret, 'ERPureAI-ConnectionString');
});
