// S6-C0 proof (a): the confined test runner. Every test creates files ONLY inside test-made roots under os.tmpdir()
// (makeTestRoot) and never deletes anything: leftovers stay. Secret-shaped strings are built at runtime from fragments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawnSync as spawnReal } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  EXIT_CONFINEMENT_FAILED, FINGERPRINT_GIT, confinedEnv, executeTests, fingerprint, makeFixtureRepo, makeTestRoot,
  planRun, runCli, sameFingerprint, stepA, stepB, validatePaths
} from './test-root.mjs';

const SCRIPT = fileURLToPath(new URL('./test-root.mjs', import.meta.url));
const PATH_KEYS = ['HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TRIOHARNESS_HOME', 'THL_SLOT_DIR', 'GH_CONFIG_DIR', 'npm_config_cache', 'GIT_CONFIG_GLOBAL'];
const OTHER_KEYS = ['PATH', 'LANG', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

// Real path of the deepest existing ancestor plus the remainder (a path that does not exist yet still compares).
const realOr = p => {
  let cur = resolve(p); const rest = [];
  for (;;) {
    try { return [realpathSync(cur), ...rest].reduce((a, b) => join(a, b)); } catch { /* climb */ }
    const up = dirname(cur); if (up === cur) return resolve(p);
    rest.unshift(basename(cur)); cur = up;
  }
};
const inside = (root, p) => typeof p === 'string' && p !== '' && (realOr(p) === realpathSync(root) || realOr(p).startsWith(realpathSync(root) + sep));
const validRoot = root => typeof root === 'string' && isAbsolute(root) && existsSync(root);
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// runCli dependency set built from spies; each dependency records its name in `calls`.
function spyDeps(root, over = {}) {
  const calls = [];
  const wrap = (name, fn) => (...a) => { calls.push(name); return fn(...a); };
  const base = {
    makeRoot: () => root,
    fingerprint: () => ({ fixed: true }),
    stepA: () => ({ ok: true }),
    makeFixture: () => ({ repo: join(root, 'fixture') }),
    stepB: () => ({ ok: true }),
    spawnCommand: () => ({ status: 0 }),
    stdout: () => {}, stderr: () => {},
    repo: root, home: join(root, 'fphome')
  };
  const deps = {};
  for (const [k, v] of Object.entries({ ...base, ...over })) deps[k] = typeof v === 'function' && !['stdout', 'stderr'].includes(k) ? wrap(k, v) : v;
  return { deps, calls };
}

test('hf5b1e-s6-d-root-01: the confined environment maps every home-like variable into one fresh root under os.tmpdir() and carries no credential', () => {
  const root = makeTestRoot();
  assert.ok(validRoot(root), 'makeTestRoot returns an existing absolute directory');
  const real = realpathSync(root);
  assert.ok(real.startsWith(realpathSync(tmpdir()) + sep), 'the root is under os.tmpdir()');
  assert.match(basename(real), /^hf5b1e-root-/);
  assert.notEqual(realpathSync(makeTestRoot()), real, 'each call makes a fresh root');

  const ghFragment = ['gh', 'p_'].join('') + 'a'.repeat(36);
  const base = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/real/home', GH_TOKEN: ghFragment, GITHUB_TOKEN: ghFragment, NPM_TOKEN: ['npm', '_'].join('') + 'b'.repeat(36), OPENAI_API_KEY: ['sk', '-'].join('') + 'c'.repeat(40), TRIOHARNESS_HOME: '/real/tho' };
  const snapshot = JSON.stringify(base);
  const processEnv = JSON.stringify(process.env);
  const env = confinedEnv(root, base);
  assert.equal(JSON.stringify(base), snapshot, 'the input environment is not modified');
  assert.equal(JSON.stringify(process.env), processEnv, 'process.env is not modified');
  for (const k of PATH_KEYS) {
    assert.ok(env[k], `${k} is set`);
    assert.ok(inside(root, env[k]), `${k}=${env[k]} is inside the root`);
  }
  assert.equal(new Set(PATH_KEYS.filter(k => k !== 'GIT_CONFIG_GLOBAL').map(k => env[k])).size >= 9, true, 'distinct subdirectories, not one shared directory');
  for (const k of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TRIOHARNESS_HOME', 'THL_SLOT_DIR', 'GH_CONFIG_DIR']) assert.ok(statSync(env[k]).isDirectory(), `${k} directory exists`);
  assert.ok(!('GH_TOKEN' in env) && !('GITHUB_TOKEN' in env) && !('NPM_TOKEN' in env) && !('OPENAI_API_KEY' in env), 'no credential variable');
  assert.ok(!Object.values(env).some(v => String(v).includes(ghFragment) || String(v).includes('/real/')), 'no real value is carried');
  assert.equal(env.PATH, base.PATH);
  assert.equal(env.LANG, base.LANG);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(env.GIT_AUTHOR_NAME && env.GIT_AUTHOR_EMAIL && env.GIT_COMMITTER_NAME && env.GIT_COMMITTER_EMAIL, 'fixed git identity');
  const allowed = new Set([...PATH_KEYS, ...OTHER_KEYS]);
  assert.deepEqual(Object.keys(env).filter(k => !allowed.has(k)), [], 'built from scratch: no inherited key');
});

test('hf5b1e-s6-d-root-02: the launcher imports only node built-ins, runs product imports in a child with another pid and leaves process.env unchanged', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm), ...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.ok(specs.length > 0, 'the launcher has static imports');
  assert.deepEqual(specs.filter(s => !s.startsWith('node:')), [], 'every static import is a node: built-in');
  assert.equal(/\bfrom\s*['"](?!node:)/.test(src), false, 'no from-clause naming a non-built-in');
  assert.equal(/\bimport\s*\(\s*['"]/.test(src), false, 'no dynamic import with a literal specifier');
  assert.equal(/\brequire\s*\(/.test(src), false, 'no require');
  assert.equal(/\b(rmSync|unlinkSync|rmdirSync|renameSync|truncateSync)\b|rm -rf|fs\/promises/.test(src), false, 'the launcher has no delete or replace call');

  const root = makeTestRoot();
  assert.ok(validRoot(root), 'a test-made root');
  const envBefore = JSON.stringify(process.env); const cwdBefore = process.cwd();
  const a = stepA(root);
  assert.equal(a.ok, true, `step A passes: ${JSON.stringify(a)}`);
  assert.equal(typeof a.pid, 'number');
  assert.notEqual(a.pid, process.pid, 'step A product imports happen in another process');
  const fx = makeFixtureRepo(root);
  const b = stepB(root, { repo: fx.repo });
  assert.equal(b.ok, true, `step B passes: ${JSON.stringify(b)}`);
  assert.equal(typeof b.pid, 'number');
  assert.notEqual(b.pid, process.pid, 'step B product imports happen in another process');
  assert.notEqual(b.pid, a.pid, 'each step is its own child');
  assert.equal(JSON.stringify(process.env), envBefore, 'the launcher process.env is unchanged');
  assert.equal(process.cwd(), cwdBefore);
});

test('hf5b1e-s6-d-root-03: step A prints the lock dir, slot dir, standing-orders file, deploy artifact root, homedir and tmpdir inside the root; an outside path exits 4 before step B or the command', () => {
  const root = makeTestRoot();
  assert.ok(validRoot(root), 'a test-made root');
  const r = realpathSync(root);
  const a = stepA(root);
  assert.equal(a.ok, true, `step A passes: ${JSON.stringify(a)}`);
  assert.deepEqual(a.outside, []);
  const p = a.paths;
  assert.equal(p.homedir, join(r, 'home'));
  assert.equal(p.tmpdir, join(r, 'tmp'));
  assert.equal(p.lockDir, join(r, 'home', '.trioharness-lean', 'locks'), 'LOCK_DIR of run-lock.mjs');
  assert.equal(p.slotDir, join(r, 'slots'), 'slotDir() of jobs.mjs');
  assert.equal(p.standingOrders, join(r, 'tho', 'standing-orders.json'), 'userFile() of standing-orders.mjs');
  assert.equal(p.deployArtifacts, join(r, 'home', '.trioharness-lean', 'artifacts'), 'deploy artifact root');
  for (const [k, v] of Object.entries(p)) assert.ok(inside(root, v), `${k}=${v} is inside the root`);
  assert.equal(existsSync(join(r, 'home', '.trioharness-lean')), false, 'step A wrote nothing under the home');
  assert.equal(existsSync(join(r, 'slots', 'slot-0.lock')), false, 'step A took no slot');

  const other = makeTestRoot();
  assert.ok(validRoot(other), 'a second test-made root');
  mkdirSync(join(root, 'linkdir'), { recursive: true });
  symlinkSync(realpathSync(other), join(root, 'linkdir', 'escape'));
  const v = validatePaths(root, { fine: join(root, 'a', 'b'), abs: '/etc/passwd', dots: join(root, '..', 'escape'), link: join(root, 'linkdir', 'escape', 'z'), empty: '' });
  assert.equal(v.ok, false);
  assert.deepEqual([...v.outside].sort(), ['abs', 'dots', 'empty', 'link']);
  assert.equal(validatePaths(root, { fine: join(root, 'a', 'b') }).ok, true);

  // End to end: a child whose home and slot dir point at ANOTHER root is detected by the real step A.
  const bad = { ...confinedEnv(root), HOME: join(realpathSync(other), 'home'), THL_SLOT_DIR: join(realpathSync(other), 'slots') };
  const bad1 = stepA(root, { env: bad });
  assert.equal(bad1.ok, false);
  for (const k of ['homedir', 'lockDir', 'slotDir']) assert.ok(bad1.outside.includes(k), `${k} reported outside`);
  assert.ok(!bad1.outside.includes('tmpdir'));
  const { deps, calls } = spyDeps(root, { stepA: r => stepA(r, { env: bad }) });
  const code = runCli(['run', '--', 'node', '-e', '0'], deps);
  assert.equal(code, 4);
  assert.equal(EXIT_CONFINEMENT_FAILED, 4);
  assert.deepEqual(calls, ['makeRoot', 'fingerprint', 'stepA'], 'step B, the fixture and the command never start');
});

test('hf5b1e-s6-d-root-04: step B (reclaim audit, apply false) over a fixture repo reports its lock, worktrees and candidate paths inside the root and does not run after a failed step A', () => {
  const root = makeTestRoot();
  assert.ok(validRoot(root), 'a test-made root');
  const r = realpathSync(root);
  const a = stepA(root);
  assert.equal(a.ok, true, `step A passes: ${JSON.stringify(a)}`);
  const fx = makeFixtureRepo(root);
  assert.ok(inside(root, fx.repo) && inside(root, fx.worktree), 'the fixture repo and worktree are inside the root');
  assert.ok(existsSync(join(fx.repo, '.git')) && existsSync(join(fx.worktree, '.git')));
  const b = stepB(root, { repo: fx.repo });
  assert.equal(b.ok, true, `step B passes: ${JSON.stringify(b)}`);
  assert.equal(b.apply, false, 'audit only');
  assert.notEqual(b.pid, process.pid);
  assert.ok(b.lockPaths.length >= 1, 'a run-lock path is reported');
  assert.ok(b.lockPaths.every(f => inside(root, f) && f.startsWith(join(r, 'home', '.trioharness-lean', 'locks') + sep) && f.endsWith('.lock')), `lock paths: ${b.lockPaths}`);
  assert.ok(b.worktrees.map(realOr).includes(realOr(fx.worktree)) && b.worktrees.map(realOr).includes(realOr(fx.repo)), `worktrees: ${b.worktrees}`);
  assert.ok(b.worktrees.every(w => inside(root, w)));
  assert.ok(b.candidates.map(realOr).includes(realOr(join(fx.worktree, 'node_modules'))), `candidates: ${b.candidates}`);
  assert.ok(b.candidates.every(c => inside(root, c)));
  assert.equal(b.lockDirExists, true, 'the lock was created under the lock dir inside the root');
  assert.equal(b.candidatesStillExist, true, 'apply false removed nothing');
  assert.ok(existsSync(join(fx.worktree, 'node_modules', 'pkg', 'index.js')));
  assert.deepEqual(readdirSync(join(r, 'home', '.trioharness-lean', 'locks')).filter(f => f.endsWith('.lock')), [], 'the lock was released again');

  const outsideRepo = makeTestRoot();
  assert.ok(validRoot(outsideRepo));
  const refused = stepB(root, { repo: outsideRepo });
  assert.equal(refused.ok, false, 'a repo outside the root is refused');
  assert.equal(refused.pid, null, 'and no child was started');

  const { deps, calls } = spyDeps(root, { stepA: () => ({ ok: false, outside: ['homedir'] }) });
  assert.equal(runCli(['run', '--', 'node', '-e', '0'], deps), 4);
  assert.ok(!calls.includes('stepB') && !calls.includes('makeFixture') && !calls.includes('spawnCommand'), `after a failed step A: ${calls}`);
  const second = spyDeps(root, { stepB: () => ({ ok: false }) });
  assert.equal(runCli(['run', '--', 'node', '-e', '0'], second.deps), 4);
  assert.deepEqual(second.calls, ['makeRoot', 'fingerprint', 'stepA', 'makeFixture', 'stepB'], 'a failed step B stops before the command');
});

test('hf5b1e-s6-d-root-05: the fingerprint uses exactly the three non-mutating git commands plus read-only reads, keeps .git/index untouched and a change exits 4', () => {
  const root = makeTestRoot();
  assert.ok(validRoot(root), 'a test-made root');
  assert.deepEqual(FINGERPRINT_GIT, [['--no-optional-locks', 'status', '--porcelain'], ['rev-parse', 'HEAD'], ['stash', 'list']]);
  const fx = makeFixtureRepo(root);
  const home = join(root, 'fphome');
  mkdirSync(join(home, '.trioharness-lean', 'locks'), { recursive: true });
  mkdirSync(join(home, '.config', 'trioharness'), { recursive: true });
  const lock = join(home, '.trioharness-lean', 'locks', 'a.lock');
  writeFileSync(lock, '{"pid":1}\n');
  writeFileSync(join(home, '.config', 'trioharness', 'standing-orders.json'), '{"version":1,"orders":[]}\n');
  // Make the index stat-dirty (same content, other mtime): a refreshing status would rewrite it.
  const tracked = join(fx.repo, 'README.md');
  const old = (Date.now() - 3600 * 1000) / 1000;
  writeFileSync(tracked, readFileSync(tracked)); utimesSync(tracked, old, old);
  const index = join(fx.repo, '.git', 'index');
  const bytes = readFileSync(index); const mtime = statSync(index).mtimeMs;

  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return spawnReal(cmd, args, opts); };
  const fp1 = fingerprint({ repo: fx.repo, home, spawn });
  assert.deepEqual(calls.map(c => [c.cmd, c.args]), FINGERPRINT_GIT.map(a => ['git', a]), 'exact git argument lists');
  assert.ok(calls.every(c => c.opts.cwd === fx.repo && c.opts.env && c.opts.env.GIT_OPTIONAL_LOCKS === '0'), 'GIT_OPTIONAL_LOCKS=0 in the repo');
  assert.ok(readFileSync(index).equals(bytes), '.git/index bytes unchanged');
  assert.equal(statSync(index).mtimeMs, mtime, '.git/index mtime unchanged');
  assert.ok(JSON.stringify(fp1).includes(sha(lock)), 'sha256 of the lock file read from the home');
  const fp2 = fingerprint({ repo: fx.repo, home });
  assert.equal(sameFingerprint(fp1, fp2), true, 'no change, same fingerprint');
  writeFileSync(join(fx.repo, 'untracked.txt'), 'x\n');
  assert.equal(sameFingerprint(fp1, fingerprint({ repo: fx.repo, home })), false, 'a changed git status is detected');
  writeFileSync(join(home, '.trioharness-lean', 'locks', 'b.lock'), '{"pid":2}\n');
  assert.equal(sameFingerprint(fp2, fingerprint({ repo: fx.repo, home })), false, 'a new lock file in the home is detected');

  const stable = spyDeps(root, { fingerprint, repo: fx.repo, home, spawnCommand: () => ({ status: 7 }) });
  assert.equal(runCli(['run', '--', 'x'], stable.deps), 7, 'an unchanged fingerprint passes the command exit code through');
  const mutate = spyDeps(root, { fingerprint, repo: fx.repo, home, spawnCommand: () => { writeFileSync(join(home, '.trioharness-lean', 'locks', 'c.lock'), '{"pid":3}\n'); return { status: 0 }; } });
  assert.equal(runCli(['run', '--', 'x'], mutate.deps), 4, 'a change between the two fingerprints exits 4');
  assert.deepEqual(mutate.calls, ['makeRoot', 'fingerprint', 'stepA', 'makeFixture', 'stepB', 'spawnCommand', 'fingerprint']);
});

test('hf5b1e-s6-d-root-06: a test whose effects cannot be confined is reported NOT VERIFIED and is not run', () => {
  const root = makeTestRoot();
  assert.ok(validRoot(root), 'a test-made root');
  const tests = [
    { name: 'in-root', effects: [{ kind: 'path', path: join(root, 'a', 'b') }] },
    { name: 'plain', effects: [] },
    { name: 'abs-real', effects: [{ kind: 'path', path: '/Users/someone/real-file' }] },
    { name: 'dotdot', effects: [{ kind: 'path', path: join(root, '..', 'elsewhere') }] },
    { name: 'net', effects: [{ kind: 'network', host: 'example.invalid' }] },
    { name: 'cred', effects: [{ kind: 'credential', name: ['GH', 'TOKEN'].join('_') }] }
  ];
  const plan = planRun(root, tests);
  assert.deepEqual(plan.run.map(t => t.name), ['in-root', 'plain']);
  assert.deepEqual(plan.notVerified.map(t => t.name), ['abs-real', 'dotdot', 'net', 'cred']);
  assert.ok(plan.notVerified.every(t => /^NOT VERIFIED/.test(t.reason)), 'each reason starts with NOT VERIFIED');

  const seen = [];
  const res = executeTests(root, tests, t => { seen.push(t.name); return { status: 0 }; }, { stepsOk: true });
  assert.deepEqual(seen, ['in-root', 'plain'], 'only confinable tests run');
  assert.deepEqual(res.ran, ['in-root', 'plain']);
  assert.deepEqual(res.notVerified.map(t => t.name), ['abs-real', 'dotdot', 'net', 'cred']);
  assert.equal(res.verified, false, 'a slice with a NOT VERIFIED test cannot be reported verified');
  for (const n of ['abs-real', 'dotdot', 'net', 'cred']) assert.ok(res.lines.some(l => l.startsWith(`NOT VERIFIED ${n}`)), `reported, not skipped silently: ${n}`);

  const allOk = executeTests(root, tests.slice(0, 2), () => ({ status: 0 }), { stepsOk: true });
  assert.equal(allOk.verified, true);
  assert.deepEqual(allOk.notVerified, []);

  const never = [];
  const failedSteps = executeTests(root, tests.slice(0, 2), t => { never.push(t.name); return { status: 0 }; }, { stepsOk: false });
  assert.deepEqual(never, [], 'after a failed confinement step nothing runs');
  assert.deepEqual(failedSteps.notVerified.map(t => t.name), ['in-root', 'plain']);
  assert.equal(failedSteps.verified, false);
  assert.ok(failedSteps.notVerified.every(t => /^NOT VERIFIED/.test(t.reason) && /step/i.test(t.reason)));
});
