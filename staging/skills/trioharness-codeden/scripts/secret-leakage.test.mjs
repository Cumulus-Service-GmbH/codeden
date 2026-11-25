import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecrets, isSecretFile, isContentGatedFile, redactText, redactDeep, scrubEnv } from './secret-patterns.mjs';
import { guard, scanFiles } from './guard.mjs';
import { runGate } from './jev.mjs';
import { runCommand, commandNote } from './run-lock.mjs';
import { validateConfig, Refusal } from './deploy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'templates', 'repo', 'pre-push');
const RUNLOCK = join(here, 'run-lock.mjs');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commitFile = (dir, name, content, msg) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); git(dir, 'add', '-f', name); git(dir, 'commit', '--quiet', '-m', msg); };
function repoOnRemote() {
  const bare = mkdtempSync(join(tmpdir(), 'thl-sbare-'));
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  const w = mkdtempSync(join(tmpdir(), 'thl-sw-'));
  git(w, 'init', '--quiet', '--initial-branch=main');
  git(w, 'config', 'user.email', 't@e.com'); git(w, 'config', 'user.name', 'T');
  commitFile(w, 'src/app.js', 'const a = 1;\n', 'base');
  git(w, 'remote', 'add', 'origin', bare); git(w, 'push', '--quiet', '-u', 'origin', 'main');
  return { bare, w, base: git(w, 'rev-parse', 'HEAD').trim() };
}
const SAMPLES = {
  dotenvKey: 'TYPESAFE_API_KEY=ts_live_8f7e6d5c4b3a29181716151413121110',
  dbUrl: 'DATABASE_URL=postgres://app:Sup3rS3cret@db.internal:5432/app',
  npmrc: '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789',
  accountKey: '"Storage": "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=' + 'abcdefghijklmnop' + 'qrstuvwxyz0123456789' + 'ABCDEFGHIJKLMNOP==;EndpointSuffix=core.windows.net"',
  sas: 'https://acct.blob.core.windows.net/c?sv=2022-11-02&sig=' + 'abcdefghijklmnop' + 'qrstuvwxyz0123456789ABCD%3D',
  jwt: 'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  pat: 'GITHUB_TOKEN=github_pat_' + '11ABCDEFG0123456789abcdefghijklmnopqrstuvwxyz',
  json: '"ConnectionStrings": { "Default": "Server=x;Database=y;User Id=z;Password=hunter2abc;" }',
  jsonClientSecret: '"ClientSecret": "Q~abcdefghijklmnopqrstuvwxyz0123456789"',
  yaml: 'password: hunter2abcdef',
  identifier: 'password = process.env.PW',
  placeholder: 'API_KEY=<fill me in>',
  interp: 'DB_PASSWORD=${DB_PASSWORD}',
  code: 'const token = await getToken(scope);'
};

test('shared value patterns catch the real-world forms and leave identifiers and placeholders alone', () => {
  for (const k of ['dotenvKey', 'dbUrl', 'npmrc', 'accountKey', 'sas', 'jwt', 'pat', 'json', 'jsonClientSecret', 'yaml'])
    assert.ok(findSecrets(SAMPLES[k]).length, `should hit: ${k}`);
  for (const k of ['identifier', 'placeholder', 'interp', 'code'])
    assert.equal(findSecrets(SAMPLES[k]).length, 0, `false positive: ${k}`);
  for (const f of ['.env', 'config/.env.production', '.npmrc', 'certs/a.pfx', 'id_rsa', 'secrets.json', 'local.settings.json', 'infra/terraform.tfstate', '.aws/credentials', '.kube/config'])
    assert.ok(isSecretFile(f), f);
  for (const f of ['appsettings.json', 'src/env.ts', 'README.md', 'keys.ts', 'environment.ts', '.env.example', '.env.sample', '.env.template', 'appsettings.Development.json', '.azure/pipelines.yml']) assert.equal(isSecretFile(f), null, f);
  assert.equal(isContentGatedFile('appsettings.Development.json'), 'appsettings-env');
  assert.equal(findSecrets('PASSWORD=<your-password>').length, 0);
  assert.ok(findSecrets('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY').length);
});

test('redaction works on string values before JSON encoding, so JSON-escaped excerpts cannot leak', () => {
  const VALUES = { dotenvKey: 'ts_live_8f7e', dbUrl: 'Sup3rS3cret', npmrc: 'npm_abcdefghij', accountKey: ['abcdefghijklmnop', 'qrstuvwxyz0123456789', 'ABCDEFGHIJKLMNOP'].join(''), sas: ['abcdefghijklmnop', 'qrstuvwxyz0123456789', 'ABCD'].join(''), jwt: 'SflKxwRJ', pat: 'github_pat_11ABC', json: 'hunter2abc', jsonClientSecret: 'Q~abcdefghij', yaml: 'hunter2abcdef' };
  for (const [k, v] of Object.entries(VALUES)) {
    const out = redactText(SAMPLES[k]);
    assert.equal(out.includes(v), false, `value survives redaction: ${k} → ${out}`);
    assert.match(out, /REDACTED/, k);
  }
  const deep = redactDeep({ evidence: [SAMPLES.json, { nested: SAMPLES.jwt }], n: 1 });
  const text = JSON.stringify(deep);
  assert.doesNotMatch(text, /hunter2abc|SflKxwRJ/);
  assert.equal(deep.n, 1);
  assert.doesNotThrow(() => JSON.parse(text));
});

test('guard: credential files are rejected by name (even with --allow-binary) and secrets in intermediate commits are caught', () => {
  const { w, base } = repoOnRemote();
  git(w, 'checkout', '--quiet', '-b', 'bambooed/r');
  commitFile(w, 'src/.env', SAMPLES.dotenvKey + '\n', 'adds env');
  commitFile(w, 'certs/client.pfx', Buffer.from([0x30, 0x82, 0x00, 0x01, 0x00]).toString('binary'), 'pfx');
  commitFile(w, 'src/appsettings.Production.json', '{ ' + SAMPLES.accountKey + ' }\n', 'settings');
  let r = guard({ repo: w, base, owned: ['src/', 'certs/'], tier: 'standard', allowBinary: true, allowMainWorktree: true });
  const rules = r.violations.map(v => v.rule);
  assert.ok(rules.includes('secret:file-dotenv') && rules.includes('secret:file-key-material'), rules.join(','));
  assert.ok(r.violations.some(v => v.rule === 'secret:azure-account-key' && v.path === 'src/appsettings.Production.json' && /content-gated/.test(v.file || '')), JSON.stringify(r.violations));
  assert.doesNotMatch(JSON.stringify(r), /ts_live_8f7e|abcdefghijklmnop.?qrstuvwxyz0123456789/, 'no value in the report');

  // History: secret added in one commit, removed in the next — tree is clean, push is not.
  const { w: w2, base: base2 } = repoOnRemote();
  git(w2, 'checkout', '--quiet', '-b', 'bambooed/h');
  commitFile(w2, 'src/db.js', 'const cs = "Server=x;Password=hunter2abc;";\n', 'adds secret');
  commitFile(w2, 'src/db.js', 'const cs = process.env.CS;\n', 'removes secret');
  r = guard({ repo: w2, base: base2, owned: ['src/'], tier: 'lean', allowMainWorktree: true });
  assert.ok(r.violations.some(v => v.rule === 'secret:conn-string-password-in-history' && v.path === 'src/db.js' && v.commit), JSON.stringify(r.violations));
  assert.doesNotMatch(JSON.stringify(r), /hunter2abc/);
  // Binary credential file added then deleted; a token in a commit message; a rename into .env.
  const { w: w3, base: base3 } = repoOnRemote();
  git(w3, 'checkout', '--quiet', '-b', 'bambooed/b');
  commitFile(w3, 'certs/x.pfx', Buffer.from([0x30, 0x82, 0, 1, 0]).toString('binary'), 'pfx');
  git(w3, 'rm', '--quiet', 'certs/x.pfx'); git(w3, 'commit', '--quiet', '-m', 'rm pfx, token ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCD');
  commitFile(w3, 'src/cfg.txt', 'DB_PASSWORD=supersecretpass123\n', 'cfg'); git(w3, 'mv', 'src/cfg.txt', 'src/.env'); git(w3, 'commit', '--quiet', '-m', 'mv');
  r = guard({ repo: w3, base: base3, owned: ['src/', 'certs/'], tier: 'standard', allowMainWorktree: true });
  const hr = r.violations.map(v => v.rule);
  assert.ok(hr.includes('secret:file-key-material-in-history'), hr.join(','));
  assert.ok(hr.includes('secret:github-token-in-commit-message'), hr.join(','));
  assert.ok(hr.includes('secret:file-dotenv-in-history') && hr.includes('secret:file-dotenv'), hr.join(','));
});

test('pre-push hook blocks credential files and secret-shaped lines anywhere in the pushed range, for everyone', () => {
  if (process.platform === 'win32') return;
  const { w } = repoOnRemote();
  copyFileSync(HOOK, join(w, '.git', 'hooks', 'pre-push')); chmodSync(join(w, '.git', 'hooks', 'pre-push'), 0o755);
  const push = (branch, env = {}) => spawnSync('git', ['-C', w, 'push', 'origin', branch], { encoding: 'utf8', env: { ...process.env, ...env } });
  git(w, 'checkout', '--quiet', '-b', 'bambooed/env');
  commitFile(w, '.env', SAMPLES.dotenvKey + '\n', 'env'); git(w, 'rm', '--quiet', '--cached', '.env'); git(w, 'commit', '--quiet', '-m', 'untrack');
  let r = push('bambooed/env');
  assert.notEqual(r.status, 0); assert.match(r.stderr, /credential file/); assert.doesNotMatch(r.stderr, /ts_live/);
  git(w, 'checkout', '--quiet', 'main'); git(w, 'checkout', '--quiet', '-b', 'bambooed/line');
  commitFile(w, 'src/x.js', 'const s = "' + SAMPLES.json.replace(/"/g, '\\"') + '";\n', 'secret line');
  r = push('bambooed/line');
  assert.notEqual(r.status, 0); assert.match(r.stderr, /secret-shaped line/); assert.doesNotMatch(r.stderr, /hunter2abc/);
  git(w, 'checkout', '--quiet', 'main'); git(w, 'checkout', '--quiet', '-b', 'bambooed/clean');
  commitFile(w, 'src/y.js', SAMPLES.identifier + '\n' + SAMPLES.interp + '\n', 'clean');
  commitFile(w, 'appsettings.Development.json', '{ "Logging": { "LogLevel": "Debug" } }\n', 'dev settings without secrets');
  commitFile(w, '.env.example', 'API_KEY=\nDB_PASSWORD=<fill>\n', 'example env');
  r = push('bambooed/clean', { CLAUDECODE: '1' });
  assert.equal(r.status, 0, r.stderr);
  // Rename into .env and an evil merge are both caught.
  git(w, 'checkout', '--quiet', 'main'); git(w, 'checkout', '--quiet', '-b', 'bambooed/mv');
  rmSync(join(w, '.env'), { force: true }); commitFile(w, 'cfg.txt', SAMPLES.dotenvKey + '\n', 'cfg'); git(w, 'mv', 'cfg.txt', '.env'); git(w, 'commit', '--quiet', '-m', 'mv');
  r = push('bambooed/mv'); assert.notEqual(r.status, 0); assert.match(r.stderr, /credential file/);
  git(w, 'checkout', '--quiet', 'main'); git(w, 'checkout', '--quiet', '-b', 'side'); commitFile(w, 'side.txt', 's', 'side');
  git(w, 'checkout', '--quiet', 'main'); git(w, 'checkout', '--quiet', '-b', 'bambooed/evil'); commitFile(w, 'e.txt', 'e', 'e');
  git(w, 'merge', '--quiet', '--no-ff', '--no-edit', 'side');
  writeFileSync(join(w, 'evil.js'), 'const k = "AKIA' + 'ABCDEFGHIJKLMNOP";\n'); git(w, 'add', 'evil.js'); git(w, 'commit', '--quiet', '--amend', '--no-edit');
  r = push('bambooed/evil'); assert.notEqual(r.status, 0); assert.match(r.stderr, /secret-shaped line/);
  git(w, 'checkout', '--quiet', 'main'); git(w, 'checkout', '--quiet', '-b', 'bambooed/msg'); commitFile(w, 'm.txt', 'm', 'leak ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCD');
  r = push('bambooed/msg'); assert.notEqual(r.status, 0); assert.match(r.stderr, /commit message/);
});

test('jev: a JSON-escaped password in evidence never reaches the request; dry-run prints a hash, not the state', async () => {
  const input = { objective: 'x', criteria: ['y'], evidence: [`src/appsettings.json:3 ${SAMPLES.json}`, SAMPLES.jwt] };
  const r = await runGate('done', input, { dryRun: true, showState: true, key: 'k' });
  const wire = JSON.stringify(r.request);
  assert.doesNotMatch(wire, /hunter2abc|SflKxwRJ/);
  assert.match(wire, /\[REDACTED\]/);
  const r2 = await runGate('done', input, { dryRun: true, key: 'k' });
  assert.ok(r2.request.stateSha256 && !r2.request.state, 'dry-run without --show-state carries no state');
});

test('run-lock and lane children never inherit secret-shaped environment variables; lock notes carry no arguments', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TYPESAFE_API_KEY: 'ts_live_x', JEV_API_KEY: 'j', AZURE_CLIENT_SECRET: 'q', DB_PASSWORD: 'p', GH_TOKEN: 't', PLAIN: 'ok', HEADROOM_BEACON: 'off' };
  const { env: child, stripped } = scrubEnv(env);
  assert.deepEqual(stripped, ['AZURE_CLIENT_SECRET', 'DB_PASSWORD', 'GH_TOKEN', 'JEV_API_KEY', 'TYPESAFE_API_KEY']);
  assert.equal(child.PLAIN, 'ok'); assert.equal(child.HEADROOM_BEACON, 'off');
  const more = scrubEnv({ ConnectionStrings__Default: 'Server=x;Password=hunter2abc;', DATABASE_URL: 'postgres://u:Sup3rS3cret@h/d', AZURE_STORAGE_KEY: 'k', GITHUB_PAT: 'p', DB_PASS: 'x', OPENAI_BASE_URL: 'http://127.0.0.1:8787', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787', SAFE_URL: 'https://example.com/x' });
  assert.deepEqual(more.stripped, ['AZURE_STORAGE_KEY', 'ConnectionStrings__Default', 'DB_PASS', 'GITHUB_PAT']);
  assert.deepEqual(more.strippedByValue, ['DATABASE_URL']);
  assert.equal(more.env.OPENAI_BASE_URL, 'http://127.0.0.1:8787', 'proxy routing is kept'); assert.equal(more.env.SAFE_URL, 'https://example.com/x');
  const r = spawnSync(process.execPath, [RUNLOCK, 'run', '--name', `t${process.pid}`, '--', process.execPath, '-e', 'process.stdout.write(["TYPESAFE_API_KEY","JEV_API_KEY","AZURE_CLIENT_SECRET","DB_PASSWORD","GH_TOKEN","PLAIN"].filter(k=>process.env[k]!==undefined).join(","))'], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'PLAIN', `child saw: ${r.stdout}`);
  assert.doesNotMatch(commandNote(['dotnet', 'test', '-e', 'ConnectionStrings__Default=Server=x;Password=hunter2abc']), /hunter2abc|Password/);
});

test('deploy: a secret-named app variable is refused as a build-arg source', () => {
  const cfg = { schema: 1, targets: { qa: { type: 'containerapp', subscription: 's', resourceGroup: 'g', app: 'a', registry: 'r', image: 'i', health: { url: 'https://x/health', shaField: 'sha' }, build: { dockerfile: 'Dockerfile', buildArgsFromApp: { ENTRA_ID: 'AZURE_CLIENT_SECRET' } } } } };
  assert.throws(() => validateConfig(cfg), e => e instanceof Refusal && /BUILD_ARG_IS_SECRET/.test(e.message));
});

test('guard --scan flags secret-shaped lines in packets and worker files without printing them', () => {
  const d = mkdtempSync(join(tmpdir(), 'thl-scan-'));
  writeFileSync(join(d, 'writer-1.md'), '# result\nfixed it\n' + SAMPLES.dbUrl + '\n');
  writeFileSync(join(d, 'clean.md'), '# result\nall good\n');
  const hits = scanFiles([join(d, 'writer-1.md'), join(d, 'clean.md')]);
  assert.equal(hits.length, 1); assert.equal(hits[0].line, 3); assert.equal(hits[0].rule, 'url-credentials');
  assert.doesNotMatch(JSON.stringify(hits), /Sup3rS3cret/);
});
