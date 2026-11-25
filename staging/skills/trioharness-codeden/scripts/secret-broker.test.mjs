import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { validateManifest, loadManifest, writeManifest, keychainBackend, hiddenPrompt, scrubOutput, scrubVariants, commandRefusal, auditAppend, auditTail, validateValue, serviceFor, slugFromRemote, MANIFEST_FILE } from './secret-store.mjs';
import { runCli, accessRefusal, namesFromAgents, secretCard } from './secrets.mjs';
import { lineFingerprint, parseAllow, isAllowedLine, ALLOW_FILE } from './secret-patterns.mjs';
import { guard } from './guard.mjs';
import * as Patterns from './secret-patterns.mjs';
import { validateCard } from './questions.mjs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'templates', 'repo', 'pre-push');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commitFile = (dir, name, content, msg) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); git(dir, 'add', '-f', name); git(dir, 'commit', '--quiet', '-m', msg); };
function repo(remote = 'https://github.com/Acme/Widgets.git') {
  const d = mkdtempSync(join(tmpdir(), 'thl-brk-'));
  git(d, 'init', '--quiet', '--initial-branch=main');
  git(d, 'config', 'user.email', 't@e.com'); git(d, 'config', 'user.name', 'T');
  writeFileSync(join(d, 'a.txt'), 'x'); git(d, 'add', 'a.txt'); git(d, 'commit', '--quiet', '-m', 'init');
  if (remote) git(d, 'remote', 'add', 'origin', remote);
  return d;
}
// A fake `security`: records every call (argv + stdin), keeps items in memory, understands the few verbs we use.
function fakeSecurity({ exitAfter = false } = {}) {
  const items = new Map(); const calls = [];
  const exec = (bin, args, opts = {}) => {
    calls.push({ bin, args: [...args], input: opts.input });
    const notFound = () => { const e = new Error('nf'); e.status = 44; throw e; };
    if (args[0] === '-i') {
      const m = String(opts.input).match(/add-generic-password -U -s "([^"]+)" -a "([^"]+)" -j "trioharness" -w "([^"]+)"/);
      if (m) items.set(`${m[1]}|${m[2]}`, { v: m[3], mdat: '20260101120000Z' });
      if (exitAfter) { const e = new Error('exit 1 after the last command'); e.status = 1; throw e; }
      return '';
    }
    const s = args[args.indexOf('-s') + 1], a = args[args.indexOf('-a') + 1], it = items.get(`${s}|${a}`);
    if (args[0] === 'find-generic-password') {
      if (!it) notFound();
      return args.includes('-w') ? `${it.v}\n` : `keychain: x\n    "mdat"<timedate>=0x00 "${it.mdat}\\000"\n`;
    }
    if (args[0] === 'delete-generic-password') { if (!it) notFound(); items.delete(`${s}|${a}`); return ''; }
    throw new Error('unexpected ' + args[0]);
  };
  return { exec, items, calls };
}
const SECRET = 'Zq9-sample-' + 'value-4821';
function cli(d, argv, { fake = fakeSecurity(), prompt, stdin = '', env = {}, platform = 'darwin', spawn } = {}) {
  let out = '', err = '';
  const kc = keychainBackend({ exec: fake.exec, platform });
  const code = runCli(argv, { stdout: t => { out += t; }, stderr: t => { err += t; }, stdin: () => stdin }, { kc, kv: { get: () => null }, platform, env: { PATH: process.env.PATH, ...env }, prompt, spawn });
  return { code, out, err, fake };
}
function declared(d, extra = {}) {
  const e = new Map([['DB_PASSWORD', { name: 'DB_PASSWORD', purpose: 'Orders DB login', env: 'dev', store: 'auto', keyvault: null, scopes: ['proof', 'e2e'], delegate: 'architect', required: true, ...extra }]]);
  writeManifest(d, e);
}

test('manifest: valid round trip; unknown fields, value-shaped text and prd+worker are refused', () => {
  const d = repo(); declared(d);
  assert.equal(loadManifest(d).secrets.get('DB_PASSWORD').scopes.join(), 'proof,e2e');
  const bad = e => validateManifest({ version: 1, secrets: [{ name: 'A_B', purpose: 'p', env: 'dev', store: 'auto', scopes: ['proof'], delegate: 'architect', required: true, ...e }] });
  assert.equal(bad({}).ok, true);
  assert.match(bad({ value: 'x' }).errors.join(), /unknown field/);
  assert.equal(bad({ purpose: 'key ' + 'AKIA' + 'ABCDEFGHIJKLMNOP' }).ok, false);
  assert.match(bad({ env: 'prd', delegate: 'worker' }).errors.join(), /production|worker/);
});

test('set --stdin: value reaches the Keychain through stdin as base64, never argv; read-back proves it; audit has no value', () => {
  const d = repo(); declared(d);
  const r = cli(d, ['set', '--repo', d, '--name', 'DB_PASSWORD', '--stdin'], { stdin: SECRET + '\n' });
  assert.equal(r.code, 0, r.err);
  const b64 = Buffer.from(SECRET).toString('base64');
  for (const c of r.fake.calls) assert.ok(!c.args.join(' ').includes(SECRET) && !c.args.join(' ').includes(b64), 'value never in argv');
  assert.ok(r.fake.calls.some(c => c.args[0] === '-i' && c.input.includes(b64)), 'base64 value is on stdin');
  assert.ok(r.fake.items.has(`${serviceFor('acme/widgets')}|DB_PASSWORD`) || [...r.fake.items.keys()].some(k => k.endsWith('|DB_PASSWORD')));
  assert.doesNotMatch(r.out + r.err, new RegExp(SECRET));
  const audit = readFileSync(join(d, '.trioharness-direct/secrets-audit.jsonl'), 'utf8');
  assert.doesNotMatch(audit, new RegExp(SECRET)); assert.match(audit, /"action":"set"/);
});

test('set works when security -i exits 1 after a successful write (seen on macOS); the read-back decides', () => {
  const d = repo(); declared(d);
  const r = cli(d, ['set', '--repo', d, '--name', 'DB_PASSWORD', '--stdin'], { stdin: SECRET, fake: fakeSecurity({ exitAfter: true }) });
  assert.equal(r.code, 0, r.err); assert.equal(r.fake.items.size, 1);
  assert.ok(r.fake.calls.every(c => !c.input || !String(c.input).includes('quit')), 'no quit command is sent');
});

test('set: cancelled dialog stores nothing; a failed read-back is an error; short values and undeclared names are refused', () => {
  const d = repo(); declared(d);
  let r = cli(d, ['set', '--repo', d, '--name', 'DB_PASSWORD'], { prompt: () => null });
  assert.equal(r.code, 2); assert.equal(r.fake.items.size, 0);
  const bad = { exec: (b, a, o = {}) => { if (a[0] === 'find-generic-password') { const e = new Error('x'); e.status = 44; throw e; } return ''; } };
  r = cli(d, ['set', '--repo', d, '--name', 'DB_PASSWORD', '--stdin'], { stdin: SECRET, fake: { ...bad, items: new Map(), calls: [] } });
  assert.equal(r.code, 3); assert.match(r.err, /KEYCHAIN_WRITE_FAILED/);
  r = cli(d, ['set', '--repo', d, '--name', 'DB_PASSWORD', '--stdin'], { stdin: 'abc' });
  assert.equal(r.code, 3); assert.match(r.err, /SECRET_TOO_SHORT/);
  r = cli(d, ['set', '--repo', d, '--name', 'NOPE', '--stdin'], { stdin: SECRET });
  assert.equal(r.code, 3); assert.match(r.err, /SECRET_NOT_DECLARED/);
  r = cli(d, ['set', '--repo', d, '--name', 'DB_PASSWORD', '--stdin'], { stdin: SECRET, platform: 'linux' });
  assert.equal(r.code, 3); assert.match(r.err, /KEYCHAIN_UNAVAILABLE/);
});

test('status shows state, never values; --strict fails when a required secret is not set', () => {
  const d = repo(); declared(d);
  const fake = fakeSecurity();
  let r = cli(d, ['status', '--repo', d, '--strict'], { fake });
  assert.equal(r.code, 2); assert.match(r.out, /DB_PASSWORD .*not set/);
  cli(d, ['set', '--repo', d, '--name', 'DB_PASSWORD', '--stdin'], { fake, stdin: SECRET });
  r = cli(d, ['status', '--repo', d, '--strict', '--json'], { fake });
  assert.equal(r.code, 0); assert.doesNotMatch(r.out, new RegExp(SECRET));
  assert.equal(JSON.parse(r.out)[0].source, 'keychain');
});

test('require: runs the command with the value in its env only, scrubs every output form, audits, refuses wrong scope/role/delegate', () => {
  const d = repo(); declared(d);
  const fake = fakeSecurity();
  cli(d, ['set', '--repo', d, '--name', 'DB_PASSWORD', '--stdin'], { fake, stdin: SECRET });
  const spawn = (cmd, args, o) => {
    assert.equal(o.env.DB_PASSWORD, SECRET); assert.equal(o.env.OTHER_TOKEN, undefined, 'other secret-shaped vars stripped');
    return { status: 0, stdout: `plain ${SECRET} b64 ${Buffer.from(SECRET).toString('base64')} url ${encodeURIComponent(SECRET)}\n`, stderr: `err ${SECRET}\n` };
  };
  let r = cli(d, ['require', '--repo', d, '--need', 'DB_PASSWORD', '--scope', 'e2e', '--run', 'r1', '--', 'dotnet', 'test'], { fake, spawn, env: { OTHER_TOKEN: 'leaky-token-123456' } });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out + r.err, new RegExp(SECRET.replace(/[-]/g, '\\-')));
  assert.doesNotMatch(r.out, new RegExp(Buffer.from(SECRET).toString('base64')));
  assert.match(r.out, /<secret>/);
  const lines = auditTail(d, 10); assert.equal(lines.at(-1).action, 'run'); assert.equal(lines.at(-1).run, 'r1'); assert.equal(lines.at(-1).command.bin, 'dotnet');
  // wrong scope, worker not allowed, prd-style delegate none
  r = cli(d, ['require', '--repo', d, '--need', 'DB_PASSWORD', '--scope', 'deploy', '--', 'x'], { fake, spawn }); assert.equal(r.code, 3); assert.match(r.err, /SECRET_SCOPE/);
  r = cli(d, ['require', '--repo', d, '--need', 'DB_PASSWORD', '--role', 'worker', '--', 'x'], { fake, spawn }); assert.equal(r.code, 3); assert.match(r.err, /SECRET_NOT_FOR_WORKERS/);
  declared(d, { delegate: 'none' });
  r = cli(d, ['require', '--repo', d, '--need', 'DB_PASSWORD', '--', 'x'], { fake, spawn }); assert.equal(r.code, 3); assert.match(r.err, /SECRET_NOT_DELEGABLE/);
  assert.ok(auditTail(d, 20).some(l => l.action === 'refused'));
  declared(d);
  r = cli(d, ['require', '--repo', d, '--need', 'DB_PASSWORD', '--', 'env'], { fake, spawn }); assert.equal(r.code, 3); assert.match(r.err, /SECRET_COMMAND_REFUSED/);
  r = cli(d, ['require', '--repo', d, '--need', 'UNDECLARED', '--', 'x'], { fake, spawn }); assert.equal(r.code, 3); assert.match(r.err, /SECRET_NOT_DECLARED/);
});

test('require: a missing secret stops the run (exit 2) and points to the card; no file is seeded for Keychain entries', () => {
  const d = repo(); declared(d, { store: 'keychain' });
  const r = cli(d, ['require', '--repo', d, '--need', 'DB_PASSWORD', '--', 'x']);
  assert.equal(r.code, 2); assert.match(r.err, /SECRETS_MISSING: DB_PASSWORD/); assert.match(r.err, /card/);
  assert.equal(existsSync(join(d, '.env')), false);
  assert.ok(auditTail(d, 5).some(l => l.action === 'missing'));
});

test('card validates as a question card; migrate moves file values into the Keychain and --clear blanks them; forget removes', () => {
  const d = repo(); declared(d);
  const c = cli(d, ['card', '--repo', d, '--need', 'DB_PASSWORD']);
  assert.equal(c.code, 0, c.err); const card = JSON.parse(c.out); validateCard(card);
  assert.equal(card.questions[0].id, 'secretneeded'); assert.equal(card.questions[0].recommended, 'a');
  assert.doesNotThrow(() => secretCard('acme/widgets', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));
  writeFileSync(join(d, '.env'), `DB_PASSWORD=${SECRET}\nKEEP=1\n`);
  const fake = fakeSecurity();
  let r = cli(d, ['migrate', '--repo', d, '--clear'], { fake });
  assert.equal(r.code, 0, r.err); assert.match(r.out, /moved 1/); assert.doesNotMatch(r.out + r.err, new RegExp(SECRET));
  const env = readFileSync(join(d, '.env'), 'utf8'); assert.match(env, /^DB_PASSWORD=$/m); assert.match(env, /^KEEP=1$/m);
  r = cli(d, ['status', '--repo', d], { fake }); assert.match(r.out, /DB_PASSWORD .*set \(keychain\)/);
  r = cli(d, ['forget', '--repo', d, '--name', 'DB_PASSWORD'], { fake }); assert.match(r.out, /removed from the Keychain/);
  assert.equal(fake.items.size, 0);
});

test('declare / import-names write only names and rules', () => {
  const d = repo();
  writeFileSync(join(d, 'AGENTS.md'), '# x\n\n## Secrets\n\n- `ORDERS_DB_PASSWORD` — Orders DB login\n- API_TOKEN: partner API\n\n## Other\n- NOT_ONE — nope\n');
  assert.deepEqual(namesFromAgents(readFileSync(join(d, 'AGENTS.md'), 'utf8')).map(x => x.name), ['ORDERS_DB_PASSWORD', 'API_TOKEN']);
  let r = cli(d, ['import-names', '--repo', d]); assert.equal(r.code, 0, r.err);
  r = cli(d, ['declare', '--repo', d, '--name', 'KV_ONE', '--purpose', 'from vault', '--keyvault', 'vlt/kv-one', '--env', 'qa']); assert.equal(r.code, 0, r.err);
  const m = loadManifest(d).secrets; assert.equal(m.size, 3); assert.equal(m.get('KV_ONE').keyvault.vault, 'vlt');
  assert.doesNotMatch(readFileSync(join(d, MANIFEST_FILE), 'utf8'), /password\s*[:=]/i);
});

test('scrub variants and command guard', () => {
  const v = 'pa ss/wor+d=1"x';
  const text = [v, Buffer.from(v).toString('base64'), encodeURIComponent(v), JSON.stringify(v).slice(1, -1)].join(' | ');
  assert.doesNotMatch(scrubOutput(text, [v]), /wor|d29y|%2B/);
  assert.equal(commandRefusal(['sh', '-c', 'set -e; dotnet test']), null);
  assert.ok(commandRefusal(['bash', '-c', 'printenv | head']));
  assert.ok(commandRefusal(['security', 'find-generic-password']));
  assert.ok(commandRefusal(['sh', '-c', 'echo $(security find-generic-password -w)']));
  assert.equal(commandRefusal(['dotnet', 'test']), null);
  assert.ok(validateValue('abc') && !validateValue('abcdef'));
  assert.equal(slugFromRemote('git@github.com:Acme/Widgets.git'), 'Acme/Widgets');
});

test('hiddenPrompt: cancel gives null, value comes back, not on a non-mac', () => {
  assert.equal(hiddenPrompt('Enter X', { platform: 'darwin', exec: () => { const e = new Error('execution error: User canceled. (-128)'); e.stderr = 'User canceled. (-128)'; throw e; } }), null);
  assert.equal(hiddenPrompt('Enter X', { platform: 'darwin', exec: () => 'hello-value\n' }), 'hello-value');
  assert.throws(() => hiddenPrompt('Enter X', { platform: 'linux' }), /PROMPT_UNAVAILABLE/);
});

// ------------------------------------------------------------------ exact-line allowlist

const LINE = 'const cs = "Server=x;Password=' + 'hunter2abc;";';
test('allowlist parsing: exact path + fingerprint only; fingerprint equals git hash-object', () => {
  const fp = lineFingerprint(LINE);
  assert.equal(fp, execFileSync('git', ['hash-object', '--stdin'], { input: LINE, encoding: 'utf8' }).trim());
  const a = parseAllow(`# c\nsrc/db.js ${fp} # reviewed false positive\n`);
  assert.equal(a.errors.length, 0); assert.ok(isAllowedLine(a, 'src/db.js', LINE)); assert.ok(!isAllowedLine(a, 'src/other.js', LINE)); assert.ok(!isAllowedLine(a, 'src/db.js', LINE + ' '));
  for (const bad of [`src/*.js ${fp}`, `../x ${fp}`, `/abs ${fp}`, 'src/db.js abc', `src/db.js ${fp} extra`]) assert.ok(parseAllow(bad).errors.length, bad);
});

test('guard: a line allowed on the BASE branch passes; the candidate cannot allow itself; invalid base entries are reported', () => {
  const d = repo(null);
  const fp = lineFingerprint(LINE);
  commitFile(d, ALLOW_FILE, `src/db.js ${fp} # reviewed\n`, 'allow');
  s4publishDefault(d);
  const base = git(d, 'rev-parse', 'HEAD').trim();
  git(d, 'checkout', '--quiet', '-b', 'trio/a');
  commitFile(d, 'src/db.js', LINE + '\n', 'add line');
  let r = guard({ remote: 'origin/main', repo: d, base, owned: ['src/'], tier: 'standard', allowMainWorktree: true });
  assert.equal(r.violations.filter(v => /secret/.test(v.rule)).length, 0, JSON.stringify(r.violations));
  assert.ok(r.allowedSecretLines?.length >= 1);
  // A different line in the same file is still caught.
  commitFile(d, 'src/db2.js', LINE + '\n', 'same line elsewhere');
  r = guard({ remote: 'origin/main', repo: d, base, owned: ['src/'], tier: 'standard', allowMainWorktree: true });
  assert.ok(r.violations.some(v => /secret/.test(v.rule) && v.path === 'src/db2.js'), JSON.stringify(r.violations));
  // Self-allow: the allow file arrives in the candidate, not the base.
  const d2 = repo(null); s4publishDefault(d2); const base2 = git(d2, 'rev-parse', 'HEAD').trim();
  git(d2, 'checkout', '--quiet', '-b', 'trio/b');
  commitFile(d2, 'src/db.js', LINE + '\n', 'line'); commitFile(d2, ALLOW_FILE, `src/db.js ${fp}\n`, 'self allow');
  r = guard({ remote: 'origin/main', repo: d2, base: base2, owned: ['src/', '.trioharness/'], tier: 'standard', allowMainWorktree: true });
  assert.ok(r.violations.some(v => /secret/.test(v.rule)), 'candidate cannot allow itself');
  // Invalid entries on the base.
  const d3 = repo(null); commitFile(d3, ALLOW_FILE, 'src/*.js nope\n', 'bad'); s4publishDefault(d3); const base3 = git(d3, 'rev-parse', 'HEAD').trim();
  git(d3, 'checkout', '--quiet', '-b', 'trio/c'); commitFile(d3, 'src/x.js', 'const a = 1;\n', 'x');
  r = guard({ remote: 'origin/main', repo: d3, base: base3, owned: ['src/'], tier: 'standard', allowMainWorktree: true });
  assert.ok(r.violations.some(v => v.rule === 'secret-allow-invalid'), JSON.stringify(r.violations));
});

test('pre-push hook: an exact allowed line passes, anything else still blocks, a self-added allow file does not count', () => {
  if (process.platform === 'win32') return;
  const bare = mkdtempSync(join(tmpdir(), 'thl-abare-')); execFileSync('git', ['init', '--quiet', '--bare', bare]); git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const w = mkdtempSync(join(tmpdir(), 'thl-aw-'));
  git(w, 'init', '--quiet', '--initial-branch=main'); git(w, 'config', 'user.email', 't@e.com'); git(w, 'config', 'user.name', 'T');
  const fp = lineFingerprint(LINE);
  commitFile(w, 'src/app.js', 'const a = 1;\n', 'base'); commitFile(w, ALLOW_FILE, `src/db.js ${fp} # reviewed\n`, 'allow');
  git(w, 'remote', 'add', 'origin', bare); git(w, 'push', '--quiet', '-u', 'origin', 'main'); git(w, 'fetch', '-q', 'origin');
  copyFileSync(HOOK, join(w, '.git', 'hooks', 'pre-push')); chmodSync(join(w, '.git', 'hooks', 'pre-push'), 0o755);
  const push = b => spawnSync('git', ['-C', w, 'push', 'origin', b], { encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1' } });
  git(w, 'checkout', '--quiet', '-b', 'trio/ok'); commitFile(w, 'src/db.js', 'x\n' + LINE + '\ny\n', 'allowed line');
  let r = push('trio/ok'); assert.equal(r.status, 0, r.stderr);
  git(w, 'checkout', '--quiet', 'main'); git(w, 'checkout', '--quiet', '-b', 'trio/other-path'); commitFile(w, 'src/other.js', LINE + '\n', 'wrong path');
  r = push('trio/other-path'); assert.notEqual(r.status, 0); assert.match(r.stderr, /secret-shaped line/); assert.doesNotMatch(r.stderr, /hunter2abc/);
  git(w, 'checkout', '--quiet', 'main'); git(w, 'checkout', '--quiet', '-b', 'trio/mixed'); commitFile(w, 'src/db.js', LINE + '\nconst t = "Server=x;Password=' + 'other99abc;";\n', 'allowed plus another');
  r = push('trio/mixed'); assert.notEqual(r.status, 0);
  // A content line that itself starts with "++" is content, not a header.
  git(w, 'checkout', '--quiet', 'main'); git(w, 'checkout', '--quiet', '-b', 'trio/pp'); commitFile(w, 'src/pp.js', '++ Password=' + 'hunter2abc; \n', 'plusplus');
  r = push('trio/pp'); assert.notEqual(r.status, 0);
  // Self-added allow file: not on origin/main, so no effect.
  const bare2 = mkdtempSync(join(tmpdir(), 'thl-abare2-')); execFileSync('git', ['init', '--quiet', '--bare', bare2]); git(bare2, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const w2 = mkdtempSync(join(tmpdir(), 'thl-aw2-'));
  git(w2, 'init', '--quiet', '--initial-branch=main'); git(w2, 'config', 'user.email', 't@e.com'); git(w2, 'config', 'user.name', 'T');
  commitFile(w2, 'src/app.js', 'const a = 1;\n', 'base'); git(w2, 'remote', 'add', 'origin', bare2); git(w2, 'push', '--quiet', '-u', 'origin', 'main'); git(w2, 'fetch', '-q', 'origin');
  copyFileSync(HOOK, join(w2, '.git', 'hooks', 'pre-push')); chmodSync(join(w2, '.git', 'hooks', 'pre-push'), 0o755);
  git(w2, 'checkout', '--quiet', '-b', 'trio/self'); commitFile(w2, 'src/db.js', LINE + '\n', 'line'); commitFile(w2, ALLOW_FILE, `src/db.js ${fp}\n`, 'self allow');
  r = spawnSync('git', ['-C', w2, 'push', 'origin', 'trio/self'], { encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1' } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /secret-shaped line/);
});

// S4 local bare origins. Hook runs as a process, without installing a host hook.
function s4origin(allow = '', branch = 'main') {
  const bare = mkdtempSync(join(tmpdir(), 's4-bare-')); git(bare, 'init', '-q', '--bare');
  git(bare, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  const d = repo(null); git(d, 'branch', '-m', branch);
  if (allow) commitFile(d, ALLOW_FILE, allow, 'reviewed allow');
  git(d, 'remote', 'add', 'origin', bare); git(d, 'push', '-q', 'origin', branch); git(d, 'fetch', '-q', 'origin');
  git(d, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`);
  const base = git(d, 'rev-parse', 'HEAD').trim(); git(d, 'checkout', '-q', '-b', 'trio/s4');
  return { d, bare, base, branch };
}
const s4allow = path => `${path} ${lineFingerprint(LINE)} # reviewed\n`;
const s4guard = (o, extra = {}) => guard({ repo: o.d, base: o.base, remote: `origin/${o.branch}`, owned: ['src/', '.trioharness/'], allowMainWorktree: true, ...extra });
const s4secret = r => r.violations.some(v => v.rule.startsWith('secret:'));
function s4hook(o, env = {}) {
  const sha = git(o.d, 'rev-parse', 'HEAD').trim();
  return spawnSync('sh', [HOOK, 'origin', o.bare], { cwd: o.d, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1', ...env }, input: `refs/heads/trio/s4 ${sha} refs/heads/trio/s4 ${o.remoteSha || '0'.repeat(40)}\n` });
}
test('hf5b1e-s4-d-allow: an arbitrary base cannot supply an allowlist', () => {
  const o = s4origin(); commitFile(o.d, ALLOW_FILE, s4allow('src/db.js'), 'candidate allow');
  const base = git(o.d, 'rev-parse', 'HEAD').trim(); commitFile(o.d, 'src/db.js', LINE + '\n', 'line');
  assert.equal(s4secret(s4guard(o, { base })), true);
});
test('hf5b1e-s4-d-allow: without remote nothing is allowed', () => {
  const o = s4origin(s4allow('src/db.js')); commitFile(o.d, 'src/db.js', LINE + '\n', 'line');
  const r = s4guard(o, { remote: undefined }); assert.equal(s4secret(r), true); assert.deepEqual(r.allowedSecretLines, []);
});
test('hf5b1e-s4-d-allow: an allowlist on a spoofed default name does not count', () => {
  const o = s4origin('', 'release'); commitFile(o.d, ALLOW_FILE, s4allow('src/db.js'), 'unreviewed allow');
  const base = git(o.d, 'rev-parse', 'HEAD').trim(); git(o.d, 'update-ref', 'refs/remotes/origin/main', base);
  commitFile(o.d, 'src/db.js', LINE + '\n', 'line');
  assert.throws(() => s4guard(o, { base, remote: 'origin/main' }), /REMOTE_NOT_DEFAULT/);
});
test('hf5b1e-s4-p-allow: verified default allows its exact line', () => {
  const o = s4origin(s4allow('src/db.js')); commitFile(o.d, 'src/db.js', LINE + '\n', 'line');
  const r = s4guard(o); assert.equal(s4secret(r), false); assert.ok(r.allowedSecretLines.length);
});
test('hf5b1e-s4-p-allow: same line on a second path is caught', () => {
  const o = s4origin(s4allow('src/db.js')); commitFile(o.d, 'src/other.js', LINE + '\n', 'line');
  assert.equal(s4secret(s4guard(o)), true);
});
test('hf5b1e-s4-p-allow: candidate cannot allow itself', () => {
  const o = s4origin(); commitFile(o.d, ALLOW_FILE, s4allow('src/db.js'), 'self allow'); commitFile(o.d, 'src/db.js', LINE + '\n', 'line');
  assert.equal(s4secret(s4guard(o)), true);
});
test('hf5b1e-s4-d-hook: forged origin/HEAD supplies no allowance', () => {
  const o = s4origin(); commitFile(o.d, ALLOW_FILE, s4allow('src/db.js'), 'poison');
  git(o.d, 'update-ref', 'refs/remotes/origin/trio/poison', git(o.d, 'rev-parse', 'HEAD').trim());
  git(o.d, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trio/poison');
  commitFile(o.d, 'src/db.js', LINE + '\n', 'line');
  const r = s4hook(o); assert.notEqual(r.status, 0); assert.match(r.stderr, /secret-shaped line/);
  // A malformed advertisement cannot use a cached allowlist or the existing-branch range.
  const malformed = s4origin(s4allow('src/db.js'));
  commitFile(malformed.d, 'src/db.js', LINE + '\n', 'prior line');
  malformed.remoteSha = git(malformed.d, 'rev-parse', 'HEAD').trim();
  commitFile(malformed.d, 'src/clean.js', 'clean\n', 'new clean commit');
  const shimDir = mkdtempSync(join(tmpdir(), 's4-malformed-shim-'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shim = `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nconst r=spawnSync(${JSON.stringify(realGit)},args,{encoding:'utf8',stdio:['inherit','pipe','pipe']});\nif(r.stdout)process.stdout.write(r.stdout+(args[0]==='ls-remote'?'\\n':''));if(r.stderr)process.stderr.write(r.stderr);\nprocess.exit(r.status??1);\n`;
  writeFileSync(join(shimDir, 'git'), shim); chmodSync(join(shimDir, 'git'), 0o755);
  const env = { PATH: `${shimDir}:${process.env.PATH}` };
  const bad = s4hook(malformed, env); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /secret-shaped line/);
  assert.equal(s4hook(s4origin(), env).status, 0, 'unverified but clean history still passes');
});
test('hf5b1e-s4-d-hook: ref movement between verification and use cannot change allowances or range', () => {
  for (const allowedOn of ['advertised', 'attacker']) {
    const o = s4origin(allowedOn === 'advertised' ? s4allow('src/db.js') : '# none\n');
    commitFile(o.d, ALLOW_FILE, allowedOn === 'attacker' ? s4allow('src/db.js') : '# none\n', 'attacker allow');
    const attacker = git(o.d, 'rev-parse', 'HEAD').trim();
    commitFile(o.d, 'src/db.js', LINE + '\n', 'line');
    // The attacker tip contains the secret too: using it as a range endpoint must not hide the line.
    const rangeAttacker = git(o.d, 'rev-parse', 'HEAD').trim();
    const shimDir = mkdtempSync(join(tmpdir(), 's4-git-shim-'));
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const marker = join(shimDir, 'moved');
    const shim = `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nconst real=${JSON.stringify(realGit)};\nconst r=spawnSync(real,args,{encoding:'utf8',stdio:['inherit','pipe','pipe']});\nif(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);\nif(r.status===0 && args[0]==='rev-parse' && args.some(a=>a.startsWith('refs/remotes/origin/main')) && !fs.existsSync(${JSON.stringify(marker)})){\nfs.writeFileSync(${JSON.stringify(marker)},'moved');\nspawnSync(real,['update-ref','refs/remotes/origin/main',${JSON.stringify(allowedOn === 'advertised' ? attacker : rangeAttacker)}]);\n}\nprocess.exit(r.status??1);\n`;
    writeFileSync(join(shimDir, 'git'), shim); chmodSync(join(shimDir, 'git'), 0o755);
    const r = s4hook(o, { PATH: `${shimDir}:${process.env.PATH}` });
    assert.equal(existsSync(marker), true, 'verification race was exercised');
    assert.equal(r.status === 0, allowedOn === 'advertised', `${allowedOn}: ${r.stderr}`);
  }
});
test('hf5b1e-s4-p-hook: advertised exact line passes and other secret-shaped lines block', () => {
  const o = s4origin(s4allow('src/db.js')); commitFile(o.d, 'src/db.js', LINE + '\n', 'allowed line');
  assert.equal(s4hook(o).status, 0);
  commitFile(o.d, 'src/other.js', LINE + '\n', 'wrong path');
  const r = s4hook(o); assert.notEqual(r.status, 0); assert.match(r.stderr, /secret-shaped line/);
});

function s4publishDefault(d) {
  const bare = mkdtempSync(join(tmpdir(), 's4-existing-bare-')); git(bare, 'init', '-q', '--bare');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(d, 'remote', 'add', 'origin', bare); git(d, 'push', '-q', 'origin', 'main'); git(d, 'fetch', '-q', 'origin');
}

function s4staleOrigin(withAllowance = true, importDefault = true) {
  const o = s4origin();
  const upstream = mkdtempSync(join(tmpdir(), 's4-staleref-upstream-'));
  git(upstream, 'clone', '-q', o.bare, '.');
  if (withAllowance) {
    commitFile(upstream, ALLOW_FILE, s4allow('src/db.js'), 'reviewed allowance');
    commitFile(upstream, 'src/db.js', LINE + '\n', 'allowed line on default');
  } else commitFile(upstream, 'src/clean.js', 'clean\n', 'clean default');
  git(upstream, 'push', '-q', 'origin', 'main');
  o.advertised = git(upstream, 'rev-parse', 'HEAD').trim();
  // Import the merged history without refreshing origin/main, as a stale task checkout can do.
  if (importDefault) {
    git(o.d, 'fetch', '-q', o.bare, 'main'); git(o.d, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  } else {
    assert.throws(() => git(o.d, 'cat-file', '-e', `${o.advertised}^{commit}`));
    commitFile(o.d, 'src/db.js', LINE + '\n', 'line allowed on default');
  }
  o.remoteSha = o.base;
  commitFile(o.d, 'src/task.js', 'clean task\n', 'clean task');
  assert.equal(git(o.d, 'rev-parse', 'refs/remotes/origin/main').trim(), o.base);
  return o;
}

test('hf5b1e-s4-d-staleref-fetch: merged allowed line passes after the hook fetches', () => {
  for (const scenario of ['new branch', 'existing branch', 'missing object']) {
    const o = s4staleOrigin(true, scenario !== 'missing object');
    if (scenario !== 'existing branch') delete o.remoteSha;
    const r = s4hook(o);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(o.d, 'rev-parse', 'refs/remotes/origin/main').trim(), o.advertised);
    // A successful refresh cannot authorize another path.
    commitFile(o.d, 'src/other.js', LINE + '\n', 'unallowed path');
    assert.notEqual(s4hook(o).status, 0);
  }
});

test('hf5b1e-s4-d-staleref-offline: failed fetch stays strict and gives the fetch remedy', () => {
  const o = s4staleOrigin();
  const shimDir = mkdtempSync(join(tmpdir(), 's4-staleref-shim-'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const marker = join(shimDir, 'fetch-attempted');
  const shim = `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nif(args[0]==='fetch'){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(args));process.exit(1);}\nconst r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});\nprocess.exit(r.status??1);\n`;
  writeFileSync(join(shimDir, 'git'), shim); chmodSync(join(shimDir, 'git'), 0o755);
  const r = s4hook(o, { PATH: `${shimDir}:${process.env.PATH}` });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /run `git fetch origin` and retry/);
  assert.match(r.stderr, /secret-shaped line/);
  assert.equal(existsSync(marker), true, 'the hook attempted its own fetch');
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), ['fetch', '--', 'origin', 'main']);
  assert.equal(git(o.d, 'rev-parse', 'refs/remotes/origin/main').trim(), o.base);
  git(o.d, 'remote', 'set-url', 'origin', join(shimDir, 'unreachable'));
  const offline = s4hook(o);
  assert.notEqual(offline.status, 0); assert.match(offline.stderr, /run `git fetch origin` and retry/);
});

test('hf5b1e-s4-d-staleref-clean: clean stale and offline histories still pass', () => {
  const o = s4staleOrigin(false);
  assert.equal(s4hook(o).status, 0);
  git(o.d, 'remote', 'set-url', 'origin', join(o.d, 'unreachable'));
  assert.equal(s4hook(o).status, 0);
});

test('hf5b1e-s4-d-pushurl-split: a second remote cannot supply allowances for a different push target', () => {
  const o = s4origin();
  const second = mkdtempSync(join(tmpdir(), 's4-pushurl-bare-')); git(second, 'init', '-q', '--bare');
  git(second, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  commitFile(o.d, ALLOW_FILE, s4allow('src/db.js'), 'allow on second remote only');
  git(o.d, 'push', '-q', second, 'HEAD:refs/heads/main');
  git(o.d, 'remote', 'add', 'second', second);
  git(o.d, 'remote', 'set-url', '--push', 'second', o.bare);
  assert.throws(() => git(o.d, 'rev-parse', '--verify', 'refs/remotes/second/main'));
  // A mismatched target still accepts clean history.
  const run = () => spawnSync('sh', [HOOK, 'second', o.bare], {
    cwd: o.d, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1' },
    input: `refs/heads/trio/s4 ${git(o.d, 'rev-parse', 'HEAD').trim()} refs/heads/trio/s4 ${'0'.repeat(40)}\n`
  });
  assert.equal(run().status, 0);
  commitFile(o.d, 'src/db.js', LINE + '\n', 'line allowed only on second remote');
  const r = run();
  assert.notEqual(r.status, 0, 'a mismatched push URL must not borrow the fetch remote allowance');
  assert.match(r.stderr, /secret-shaped line/);
  assert.throws(() => git(o.d, 'rev-parse', '--verify', 'refs/remotes/second/main'), 'the hook must not fetch the mismatched remote');
  // Cached tracking is no more trustworthy than a hook-initiated fetch.
  git(o.d, 'fetch', '-q', 'second');
  assert.notEqual(run().status, 0);
});

test('hf5b1e-s4-d-pushurl-rewrite: environment URL rewrites cannot supply a different default', () => {
  const o = s4origin(s4allow('src/db.js'));
  commitFile(o.d, 'src/db.js', LINE + '\n', 'allowed only at fetch destination');
  const fetchAlias = 'https://fetch.example.invalid/repo.git';
  const pushTarget = 'https://push.example.invalid/repo.git';
  git(o.d, 'remote', 'set-url', 'origin', fetchAlias);
  const sha = git(o.d, 'rev-parse', 'HEAD').trim();
  const r = spawnSync('sh', [HOOK, 'origin', pushTarget], {
    cwd: o.d, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1', GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `url.${o.bare}.insteadOf`, GIT_CONFIG_VALUE_0: fetchAlias,
      GIT_CONFIG_KEY_1: `url.${pushTarget}.pushInsteadOf`, GIT_CONFIG_VALUE_1: fetchAlias },
    input: `refs/heads/trio/s4 ${sha} refs/heads/trio/s4 ${'0'.repeat(40)}\n`
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /secret-shaped line/);
});

test('hf5b1e-s4-d-pushurl-stale: matching URLs still refresh stale tracking and allow the exact line', () => {
  const o = s4staleOrigin();
  assert.equal(s4hook(o).status, 0);
  assert.equal(git(o.d, 'rev-parse', 'refs/remotes/origin/main').trim(), o.advertised);
});

test('hf5b1e-s4-d-pushurl-message: a credentialed URL never appears in hook output or fetch advice', () => {
  const o = s4origin();
  commitFile(o.d, 'src/db.js', LINE + '\n', 'blocked line');
  const fake = 'gh' + 'p_' + 'Q'.repeat(36);
  const url = ['https://bot', fake].join(':') + '@example.invalid/repo.git';
  const sha = git(o.d, 'rev-parse', 'HEAD').trim();
  const r = spawnSync('sh', [HOOK, url, url], {
    cwd: o.d, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1' },
    input: `refs/heads/trio/s4 ${sha} refs/heads/trio/s4 ${'0'.repeat(40)}\n`
  });
  assert.notEqual(r.status, 0);
  assert.equal((r.stdout + r.stderr).includes(fake), false, 'hook output must not disclose URL credentials');
  assert.equal((r.stdout + r.stderr).includes(url), false, 'hook output must not disclose the raw URL');
  assert.doesNotMatch(r.stderr, /git fetch/);
  assert.match(r.stderr, /push URL cannot be verified.*push via a named remote/i);
});

test('hf5b1e-s4-d-hook: an unterminated third advertisement line is refused', () => {
  const o = s4origin(s4allow('src/db.js'));
  commitFile(o.d, 'src/db.js', LINE + '\n', 'allowed only after verification');
  const shimDir = mkdtempSync(join(tmpdir(), 's4-third-line-shim-'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shim = `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nconst r=spawnSync(${JSON.stringify(realGit)},args,{encoding:'utf8',stdio:['inherit','pipe','pipe']});\nif(r.stdout)process.stdout.write(r.stdout+(args[0]==='ls-remote'?'unexpected-third-line':''));if(r.stderr)process.stderr.write(r.stderr);\nprocess.exit(r.status??1);\n`;
  writeFileSync(join(shimDir, 'git'), shim); chmodSync(join(shimDir, 'git'), 0o755);
  const r = s4hook(o, { PATH: `${shimDir}:${process.env.PATH}` });
  assert.notEqual(r.status, 0, 'malformed advertisement cannot authorize the cached allowance');
  assert.match(r.stderr, /secret-shaped line/);
});


const V3_PATH = 'src/cloud_agents/credentials.rs';
const V3_ROWS = [
  [V3_PATH + ' name # reviewed source path', true, true],
  [V3_PATH + ' name', true, true],
  [V3_PATH + ' name\n' + V3_PATH + ' name # duplicate', true, true],
  [V3_PATH + ' name\n' + V3_PATH + ' ' + lineFingerprint(LINE), true, true],
  [V3_PATH.toUpperCase() + ' name', true, false],
  ['src/*/credentials.rs name', false, false],
  ['src/../credentials.rs name', false, false],
  ['/src/credentials.rs name', false, false],
  ['./' + V3_PATH + ' name', false, false],
  ['C:/' + V3_PATH + ' name', false, false],
  ['src\\credentials.rs name', false, false],
  ['café/.env name', false, false],
  ['src/cre"dentials.rs name', false, false],
  ['src/cre\x01dentials.rs name', false, false],
  ['src/cre\x7fdentials.rs name', false, false],
  [V3_PATH + ' name extra', false, false],
  [V3_PATH + ' NAME', false, false],
  ['src/cloud_\ragents/credentials.rs name', false, false],
  [V3_PATH + ' name\r', true, true],
  ['\ufeff' + V3_PATH + ' name', true, true],
  [' \t' + V3_PATH + '\t name \t# reviewed', true, true],
  [V3_PATH + '\vname', true, true],
  [V3_PATH + '\fname', true, true],
  [V3_PATH + '\r name', false, false],
  [V3_PATH + ' name\r # comment', false, false],
  [V3_PATH + ' name\r\r', false, false],
];

test('v3 parser separates exact names from fingerprints and rejects malformed rows', () => {
  assert.equal(typeof Patterns.isNameAllowed, 'function');
  for (const [row, valid, allowed] of V3_ROWS) {
    const a = parseAllow(row);
    assert.equal(a.errors.length === 0, valid, row);
    assert.equal(parseAllow(row + '\n').errors.length === 0, valid, row + ' with LF');
    assert.equal(Patterns.isNameAllowed(a, V3_PATH), allowed, row);
    if (allowed) assert.equal(isAllowedLine(a, V3_PATH, LINE), row.includes(lineFingerprint(LINE)), row);
  }
});

// Fresh default/candidate for each case, using the existing real-origin fixture helper.
function v3Attempt({ rows = V3_PATH + ' name # owner-reviewed', file = V3_PATH, content = 'pub fn credentials() {}\n', self = false, unverified = false, remove = false, attrs = null, removeAttrs = false, seed = false, allowBinary = false, hookEnv = {}, localSha = null, remoteSha = '0'.repeat(40) } = {}) {
  const d = repo(null);
  if (!self && rows) commitFile(d, ALLOW_FILE, rows + '\n', 'reviewed allowances');
  if (seed) commitFile(d, file, 'pub fn credentials() {}\n', 'upstream source');
  s4publishDefault(d);
  const base = git(d, 'rev-parse', 'HEAD').trim();
  const bare = git(d, 'remote', 'get-url', 'origin').trim();
  git(d, 'checkout', '--quiet', '-b', 'trio/name-allow');
  if (self && rows) commitFile(d, ALLOW_FILE, rows + '\n', 'candidate-only allowances');
  if (attrs) commitFile(d, '.gitattributes', `${file} ${attrs}\n`, 'attributes');
  commitFile(d, file, content, 'candidate');
  if (remove) { git(d, 'rm', '--quiet', file); git(d, 'commit', '--quiet', '-m', 'remove file'); }
  if (removeAttrs) { git(d, 'rm', '--quiet', '.gitattributes'); git(d, 'commit', '--quiet', '-m', 'remove attributes'); }
  const g = guard({ repo: d, base, ...(unverified ? {} : { remote: 'origin/main' }), owned: ['src/', 'other/', '.trioharness/', '.gitattributes', '.env', 'credentials.json'], tier: 'standard', allowMainWorktree: true, allowBinary });
  const sha = git(d, 'rev-parse', 'HEAD').trim();
  const h = spawnSync('sh', [HOOK, ...(unverified ? [] : ['origin', bare])], { cwd: d, encoding: 'utf8', timeout: 5000, env: { ...process.env, ...hookEnv },
    input: `refs/heads/trio/name-allow ${localSha || sha} refs/heads/trio/name-allow ${remoteSha}\n` });
  assert.equal(h.error, undefined, h.error?.message);
  return { g, h };
}

test('v3 parser and real hook share exact-path row validation', async t => {
  for (const [row, valid, allowed] of V3_ROWS) await t.test(row, () => {
    const { g, h } = v3Attempt({ rows: row });
    assert.equal(g.clean, valid && allowed, JSON.stringify(g.violations));
    assert.equal(h.status === 0, valid && allowed, h.stderr);
    if (valid && allowed) assert.deepEqual(g.allowedNamePaths, [V3_PATH]);
    if (!valid) {
      assert.ok(g.violations.some(v => v.rule === 'secret-allow-invalid'));
      assert.match(h.stderr, /secret-allow-invalid/);
    }
  });
  const mixedInvalid = V3_PATH + ' name\n' + V3_PATH + ' name extra';
  const { g, h } = v3Attempt({ rows: mixedInvalid });
  assert.equal(g.clean, false);
  assert.notEqual(h.status, 0, 'malformed rows must drop all allowances beside a valid name row');
  assert.match(h.stderr, /credential file/);
  const clean = v3Attempt({ rows: mixedInvalid, file: 'src/clean.rs', content: 'pub fn clean() {}\n' });
  assert.equal(clean.h.status, 0, clean.h.stderr);
  assert.match(clean.h.stderr, /secret-allow-invalid/);
});

test('v3 name allowances are default-only, exact, audited, and independent of line allows', async t => {
  const cases = [
    ['clean edit', { seed: true, content: 'pub fn credentials() { /* edit */ }\n' }, true],
    ['other basename location', { file: 'other/credentials.rs' }, false],
    ['not listed', { rows: '' }, false],
    ['candidate cannot self-allow', { self: true }, false],
    ['unverified default', { unverified: true }, false],
    ['fingerprint is not a name allowance', { rows: V3_PATH + ' ' + lineFingerprint(LINE) }, false],
    ['name is not a line allowance', { file: 'src/db.js', content: LINE + '\n' }, false],
    ['owner may list dotenv', { file: '.env', rows: '.env name', content: 'NON_SECRET_SETTING=1\n' }, true],
    ['owner may list json', { file: 'credentials.json', rows: 'credentials.json name', content: '{}\n' }, true],
    ['mixed name and fingerprint', { rows: V3_PATH + ' name\n' + V3_PATH + ' ' + lineFingerprint(LINE), content: LINE + '\n' }, true],
  ];
  for (const [label, options, clean] of cases) await t.test(label, () => {
    const { g, h } = v3Attempt(options);
    assert.equal(g.clean, clean, JSON.stringify(g.violations));
    assert.equal(h.status === 0, clean, h.stderr);
    if (clean) assert.ok(g.allowedNamePaths.includes(options.file || V3_PATH));
  });
});

test('v3 allowed names still scan content in the tree and every commit', async t => {
  for (const remove of [false, true]) await t.test(`remove=${remove}`, () => {
    const { g, h } = v3Attempt({ content: LINE + '\n', remove });
    assert.ok(g.violations.some(v => v.rule === 'secret:conn-string-password-in-history' && v.commit), JSON.stringify(g.violations));
    assert.ok(!g.violations.some(v => v.rule.startsWith('secret:file-')), JSON.stringify(g.violations));
    assert.notEqual(h.status, 0);
    assert.match(h.stderr, /secret-shaped line/);
    assert.doesNotMatch(JSON.stringify(g) + h.stderr, /hunter2abc/);
  });
});

test('v3 allowed names cannot conceal binary or attribute-suppressed history', async t => {
  for (const attrs of [null, '-diff', 'binary']) for (const remove of [false, true]) await t.test(`${attrs || 'NUL'} remove=${remove}`, () => {
    const { g, h } = v3Attempt({ content: (attrs ? '' : '\0') + 'clean text\n', attrs, remove, allowBinary: true });
    assert.equal(g.clean, false);
    assert.ok(g.violations.some(v => /binary/.test(v.rule) && v.commit), JSON.stringify(g.violations));
    assert.ok(!g.violations.some(v => v.rule.startsWith('secret:file-')));
    assert.notEqual(h.status, 0);
    assert.match(h.stderr, /binary|attribute/);
  });
  const { g, h } = v3Attempt({ attrs: '-diff', removeAttrs: true });
  assert.ok(g.violations.some(v => /binary/.test(v.rule) && v.commit), 'historical attributes must not depend on the final tree');
  assert.notEqual(h.status, 0);
});


test('F1: content resembling a deleted-file header cannot stop either added-line scan', async t => {
  for (const remove of [false, true]) await t.test(`remove=${remove}`, () => {
    const { g } = v3Attempt({ content: '++ /dev/null\nPassword=' + 'hunter2abc\n', remove });
    assert.ok(g.violations.some(v => v.rule === 'secret:conn-string-password-in-history'));
    if (!remove) assert.ok(g.violations.some(v => v.rule === 'secret:conn-string-password'));
  });
});

test('F2: real hook catches the existing unquoted YAML password pattern', () => {
  const { g, h } = v3Attempt({ content: 'password: ' + 'hunter2abc\n' });
  assert.ok(g.violations.some(v => v.rule === 'secret:yaml-password'));
  assert.notEqual(h.status, 0, h.stderr);
  assert.match(h.stderr, /secret-shaped line/);
});

test('F3: multiple allow rows cannot disable hook name or binary rejection', async t => {
  const names = V3_PATH + ' name\nsrc/other.rs name';
  const fps = `src/a.rs ${lineFingerprint(LINE)}\nsrc/b.rs ${lineFingerprint(LINE)}`;
  for (const [label, options, message] of [
    ['two names, unlisted credentials', { rows: names, file: 'other/credentials.rs' }, /credential file/],
    ['two fingerprints, dotenv', { rows: fps, file: '.env', content: 'clean\n' }, /credential file/],
    ['two names, binary', { rows: names, content: '\0clean\n' }, /binary|attribute/],
    ['two names, suppressed diff', { rows: names, attrs: '-diff' }, /binary|attribute/],
  ]) await t.test(label, () => {
    const { h } = v3Attempt(options);
    assert.notEqual(h.status, 0, h.stderr);
    assert.match(h.stderr, message);
  });
});

test('F4: forced-text attributes cannot conceal NUL bytes in allowed blobs', async t => {
  for (const remove of [false, true]) for (const scanner of ['guard', 'hook']) await t.test(`${scanner} remove=${remove}`, () => {
    const { g, h } = v3Attempt({ attrs: 'diff', content: 'clean\n' + 'x'.repeat(9000) + '\0tail\n', remove, allowBinary: true });
    if (scanner === 'guard') {
      assert.ok(g.violations.some(v => v.rule === 'binary-change-in-history'));
      if (!remove) assert.ok(g.violations.some(v => v.rule === 'binary-change'));
    } else {
      assert.notEqual(h.status, 0, h.stderr);
      assert.match(h.stderr, /binary|attribute/);
    }
  });
});

test('F5: legacy fingerprint path validation remains independent of name restrictions', async t => {
  for (const prefix of ['./', 'C:/', 'café/', 'quo"te/', 'ctrl\x01/', 'del\x7f/']) await t.test(prefix, () => {
    const row = `${prefix}src/db.js ${lineFingerprint(LINE)}`;
    const a = parseAllow(row);
    assert.deepEqual(a.errors, []);
    assert.ok(isAllowedLine(a, prefix + 'src/db.js', LINE));
    assert.ok(parseAllow(prefix + 'src/db.js name').errors.length);
    const { g, h } = v3Attempt({ rows: V3_PATH + ' name\n' + row });
    assert.equal(g.clean, true, JSON.stringify(g.violations));
    assert.equal(h.status, 0, h.stderr);
  });
});


// Fail only the selected hook operation; every other Git operation remains real.
function gHookEnv(command, predicate = 'true') {
  const shimDir = mkdtempSync(join(tmpdir(), 'thl-g-hook-'));
  if (command === 'mktemp') {
    writeFileSync(join(shimDir, command), '#!/bin/sh\nexit 1\n');
  } else {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shimDir, 'git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nif(args[0]===${JSON.stringify(command)} && (${predicate})) process.exit(128);\nconst r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});\nprocess.exit(r.status??1);\n`);
  }
  chmodSync(join(shimDir, command === 'mktemp' ? command : 'git'), 0o755);
  return { PATH: `${shimDir}:${process.env.PATH}` };
}

test('G1: real hook blocks plusplus content when scratch allocation fails', () => {
  const { h } = v3Attempt({ content: '++ Password=' + 'hunter2abc\n', hookEnv: gHookEnv('mktemp') });
  assert.notEqual(h.status, 0, h.stderr);
  assert.doesNotMatch(h.stderr, /hunter2abc/);
});

test('G2: real hook blocks invalid ranges with and without name allowances', async t => {
  for (const rows of ['', V3_PATH + ' name']) await t.test(rows || 'no allowances', () => {
    const { h } = v3Attempt({ rows, file: 'src/clean.rs', remoteSha: 'f'.repeat(40) });
    assert.notEqual(h.status, 0, h.stderr);
  });
});

test('G2: real hook blocks failed Git reads at each scan stage', async t => {
  for (const [label, command, predicate] of [
    ['name log', 'log', "args.includes('--name-only')"],
    ['commit enumeration', 'rev-list', 'true'],
    ['binary stats', 'show', "args.includes('--numstat')"],
    ['allowed changed names', 'show', "args.includes('--name-only')"],
    ['allowed blob', 'cat-file', "args[1]==='blob'"],
    ['patch log', 'log', "args.includes('-p')"],
    ['message log', 'log', "args.includes('--format=%B')"],
  ]) await t.test(label, () => {
    const { h } = v3Attempt({ hookEnv: gHookEnv(command, predicate) });
    assert.notEqual(h.status, 0, h.stderr);
    assert.match(h.stderr, /scanner failed/);
  });
});

test('G3: hook YAML additions apply only to name-allowed paths; guard keeps its rule', async t => {
  for (const content of ['password: hashedPassword,\n', 'token: accessToken,\n']) await t.test(content.trim(), () => {
    const { g, h } = v3Attempt({ file: 'src/ordinary.js', content });
    assert.equal(h.status, 0, h.stderr);
    assert.ok(g.violations.some(v => v.rule === 'secret:yaml-password'));
  });
  const { h } = v3Attempt({ content: 'password: ' + 'hunter2abc\n' });
  assert.notEqual(h.status, 0, h.stderr);
});

test('G3: real hook blocks Git-quoted paths with invalid name rows or no allowance', async t => {
  for (const file of ['café/.env', 'quo"te/.env', 'ctrl\x01/.env', 'del\x7f/.env']) {
    for (const rows of [file + ' name', '']) await t.test(`${JSON.stringify(file)} rows=${!!rows}`, () => {
      const { h } = v3Attempt({ file, rows, content: 'password: synthetic_value\n' });
      assert.notEqual(h.status, 0, h.stderr);
      assert.match(h.stderr, /credential file/);
      if (rows) assert.match(h.stderr, /secret-allow-invalid/);
    });
  }
});

test('G4: invalid row warns and drops both allowance kinds without blocking unrelated clean files', async t => {
  const rows = `${V3_PATH} name\nsrc/db.js ${lineFingerprint(LINE)}\ninvalid row extra`;
  for (const [file, content, blocked] of [
    [V3_PATH, 'pub fn credentials() {}\n', true],
    ['other/credentials.rs', 'pub fn credentials() {}\n', true],
    ['src/db.js', LINE + '\n', true],
    ['src/clean.rs', 'pub fn clean() {}\n', false],
  ]) await t.test(file, () => {
    const { h } = v3Attempt({ rows, file, content });
    assert.equal(h.status !== 0, blocked, h.stderr);
    assert.match(h.stderr, /secret-allow-invalid/);
  });
});

test('G5: shared whitespace fixtures retain binary checks and fingerprint matching', async t => {
  for (const separator of ['\t', '\v', '\f']) await t.test(JSON.stringify(separator), () => {
    const binary = v3Attempt({ rows: V3_PATH + separator + 'name', content: '\0clean\n' });
    assert.equal(binary.g.clean, false);
    assert.notEqual(binary.h.status, 0, binary.h.stderr);
    const fp = v3Attempt({ rows: `src/db.js${separator}${lineFingerprint(LINE)}`, file: 'src/db.js', content: LINE + '\n' });
    assert.equal(fp.g.clean, true, JSON.stringify(fp.g.violations));
    assert.equal(fp.h.status, 0, fp.h.stderr);
  });
});
