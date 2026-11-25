#!/usr/bin/env node
// TrioHarness Lean: confined test runner (S6-C0).
//
//   node skills/trioharness-lean/scripts/test-root.mjs run -- <command...>   run the command confined
//   node skills/trioharness-lean/scripts/test-root.mjs prove                  only prove the confinement
//
// Every run executes inside ONE fresh test-made root R (a create-only mkdtemp under os.tmpdir()) with an environment
// built from scratch: HOME, USERPROFILE, TMPDIR, TMP, TEMP, XDG_*, TRIOHARNESS_HOME, THL_SLOT_DIR, GH_CONFIG_DIR, the
// npm cache and GIT_CONFIG_GLOBAL all point into R, no credential variable is carried, only PATH and LANG are inherited.
//
// Boundaries (plan 0.2 (a)-(f)):
//   (a) This file imports ONLY node: built-ins. Product modules are imported only inside confined children (steps A, B).
//       Its only writes are the mkdtemp root, its subdirectories and the fixture repo inside R. It never removes anything.
//   (b) Step A (paths only): a confined child prints LOCK_DIR, slotDir(), the standing-orders file, the deploy artifact
//       root, homedir and tmpdir. Every path must resolve inside R, else exit 4.
//   (c) Step B (reclaim audit, apply false) runs only after step A passed, over a fixture repo inside R. The audit takes and
//       releases a run-lock per worktree, so the lock, every worktree and every candidate path must be inside R.
//   (d) Only then does the command run, in a confined child.
//   (e) Fingerprints are non-mutating reads of the real home locks / config and of the real repo, taken before and after.
//       A change exits 4. A fingerprint detects damage after the fact; it authorizes no write outside R.
//   (f) A test whose effects cannot be confined is NOT VERIFIED and is never run unconfined.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_CONFINEMENT_FAILED = 4;
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const SENTINEL = 'THL-TESTROOT ';
const SUBDIRS = ['home', 'tmp', 'xdg-config', 'xdg-state', 'xdg-cache', 'tho', 'slots', 'gh', join('home', '.npm')];

// ---- root and environment ------------------------------------------------------------------------------------------

// Create-only: a fresh directory under os.tmpdir() with the subdirectories the confined environment points at.
export function makeTestRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hf5b1e-root-')));
  for (const d of SUBDIRS) mkdirSync(join(root, d), { recursive: true });
  return root;
}

// The environment built from scratch. `base` is only read (PATH and LANG are the only inherited values).
export function confinedEnv(root, base = process.env) {
  const p = (...a) => join(root, ...a);
  const env = {
    PATH: base.PATH ?? '',
    HOME: p('home'), USERPROFILE: p('home'),
    TMPDIR: p('tmp'), TMP: p('tmp'), TEMP: p('tmp'),
    XDG_CONFIG_HOME: p('xdg-config'), XDG_STATE_HOME: p('xdg-state'), XDG_CACHE_HOME: p('xdg-cache'),
    TRIOHARNESS_HOME: p('tho'), THL_SLOT_DIR: p('slots'), GH_CONFIG_DIR: p('gh'),
    npm_config_cache: p('home', '.npm'), GIT_CONFIG_GLOBAL: p('gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'hf5b1e', GIT_AUTHOR_EMAIL: 'hf5b1e@example.invalid',
    GIT_COMMITTER_NAME: 'hf5b1e', GIT_COMMITTER_EMAIL: 'hf5b1e@example.invalid'
  };
  if (base.LANG !== undefined) env.LANG = base.LANG;
  return env;
}

// Real path of the deepest existing ancestor plus the remainder, so a path that does not exist yet still compares.
function resolveReal(p) {
  let cur = resolve(String(p)); const rest = [];
  for (;;) {
    try { return [realpathSync(cur), ...rest].reduce((a, b) => join(a, b)); } catch { /* climb */ }
    const up = dirname(cur);
    if (up === cur) return resolve(String(p));
    rest.unshift(basename(cur)); cur = up;
  }
}
export function isInside(root, p) {
  if (typeof p !== 'string' || p === '') return false;
  const r = realpathSync(root); const q = resolveReal(p);
  return q === r || q.startsWith(r + sep);
}

// { name: path } -> the names whose path does not resolve inside the root.
export function validatePaths(root, paths) {
  const outside = Object.entries(paths || {}).filter(([, v]) => !isInside(root, v)).map(([k]) => k);
  return { ok: outside.length === 0, outside };
}

// ---- confined children (steps A and B) ----------------------------------------------------------------------------

// Child code. Product modules are loaded by file name from the scripts folder, only inside the child process.
const CHILD_A = `
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { dir } = JSON.parse(process.argv.at(-1));
const load = f => import(pathToFileURL(join(dir, f)).href);
const lock = await load('run-lock.mjs');
const jobs = await load('jobs.mjs');
const orders = await load('standing-orders.mjs');
const out = {
  pid: process.pid, homedir: homedir(), tmpdir: tmpdir(), lockDir: lock.LOCK_DIR, slotDir: jobs.slotDir(),
  standingOrders: orders.userFile(), deployArtifacts: join(homedir(), '.trioharness-lean', 'artifacts')
};
process.stdout.write('${SENTINEL}' + JSON.stringify(out) + '\\n');
`;

const CHILD_B = `
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { dir, repo, phase } = JSON.parse(process.argv.at(-1));
const load = f => import(pathToFileURL(join(dir, f)).href);
const reclaim = await load('reclaim.mjs');
const lockMod = await load('run-lock.mjs');
const report = reclaim.run({ repo, phase, apply: false, now: Date.now() + 3 * 3600 * 1000 });
const trees = reclaim.listWorktrees(repo);
const candidates = [...report.reclaimed.map(x => x.path), ...report.keptBack.map(x => x.path)];
const out = {
  pid: process.pid, apply: report.apply, phase: report.phase, errors: report.errors, skipped: report.skippedWorktrees,
  worktrees: trees.map(t => t.path), lockDir: lockMod.LOCK_DIR,
  lockPaths: trees.filter(t => !t.isMain).map(t => join(lockMod.LOCK_DIR, lockMod.lockNameFor(t.path) + '.lock')),
  lockDirExists: existsSync(lockMod.LOCK_DIR), candidates, candidatesStillExist: candidates.every(c => existsSync(c)),
  archiveTargets: report.archived.map(a => a.to).filter(t => typeof t === 'string')
};
process.stdout.write('${SENTINEL}' + JSON.stringify(out) + '\\n');
`;

function runChild(root, code, arg, env) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(arg)], { env, cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  const line = String(r.stdout || '').split('\n').find(l => l.startsWith(SENTINEL));
  let data = null;
  if (line) { try { data = JSON.parse(line.slice(SENTINEL.length)); } catch { data = null; } }
  const failed = r.status !== 0 || !data;
  return { data: failed ? null : data, error: failed ? `child exit ${r.status}${r.signal ? ` signal ${r.signal}` : ''}: ${String(r.stderr || r.error || '').trim().slice(0, 600)}` : null };
}

const A_PATHS = ['homedir', 'tmpdir', 'lockDir', 'slotDir', 'standingOrders', 'deployArtifacts'];

// Step A: paths only. Calls nothing that writes.
export function stepA(root, { env } = {}) {
  const c = runChild(root, CHILD_A, { dir: SCRIPTS_DIR }, env || confinedEnv(root));
  if (!c.data) return { ok: false, pid: null, paths: {}, outside: [], error: c.error };
  const paths = Object.fromEntries(A_PATHS.map(k => [k, c.data[k]]));
  const v = validatePaths(root, paths);
  return { ok: v.ok, pid: c.data.pid, paths, outside: v.outside };
}

// Step B: reclaim audit (apply false) over a fixture repo inside the root.
export function stepB(root, { repo, env } = {}) {
  if (!isInside(root, repo)) return { ok: false, pid: null, apply: null, outside: ['repo'], error: 'the fixture repo is not inside the root' };
  const c = runChild(root, CHILD_B, { dir: SCRIPTS_DIR, repo, phase: 'pre-worktree' }, env || confinedEnv(root));
  if (!c.data) return { ok: false, pid: null, apply: null, outside: [], error: c.error };
  const d = c.data;
  const outside = [];
  const check = (name, list) => { for (const p of list) if (!isInside(root, p)) outside.push(`${name}:${p}`); };
  check('lockDir', [d.lockDir]); check('lockPaths', d.lockPaths); check('worktrees', d.worktrees);
  check('candidates', d.candidates); check('archiveTargets', d.archiveTargets);
  const ok = outside.length === 0 && d.apply === false && d.errors.length === 0;
  return { ok, outside, ...d, error: ok ? null : `step B problems: outside=${outside.length} apply=${d.apply} errors=${d.errors.join(' | ')}` };
}

// A fixture repo inside the root: one commit, a git-ignored node_modules, and a linked worktree under a .trioharness folder
// (the harness's own, so the reclaim audit considers it). Nothing outside the root is touched.
export function makeFixtureRepo(root) {
  const env = confinedEnv(root);
  const git = (cwd, ...a) => {
    const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`FIXTURE_GIT_FAILED: git ${a.join(' ')}: ${String(r.stderr || r.error).trim()}`);
  };
  const repo = join(root, 'fixture', 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  const worktree = join(repo, '.trioharness', 'wt-a');
  mkdirSync(dirname(worktree), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'fx-a', worktree);
  mkdirSync(join(worktree, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(worktree, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  return { repo: realpathSync(repo), worktree: realpathSync(worktree) };
}

// ---- fingerprints (strictly non-mutating reads) -------------------------------------------------------------------

export const FINGERPRINT_GIT = [['--no-optional-locks', 'status', '--porcelain'], ['rev-parse', 'HEAD'], ['stash', 'list']];

function walk(dir, max = 5000) {
  if (!existsSync(dir)) return [{ path: '.', absent: true }];
  const out = []; let seen = 0;
  const rec = (abs, rel) => {
    let entries = [];
    try { entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch (e) { out.push({ path: rel, error: e.code || 'ERR' }); return; }
    for (const e of entries) {
      if (++seen > max) { out.push({ path: rel, truncated: true }); return; }
      const f = join(abs, e.name); const r = join(rel, e.name);
      let st; try { st = lstatSync(f); } catch { out.push({ path: r, error: 'STAT' }); continue; }
      if (st.isDirectory()) { out.push({ path: r, type: 'dir', mtimeMs: st.mtimeMs }); rec(f, r); }
      else if (st.isFile()) {
        const item = { path: r, type: 'file', size: st.size, mtimeMs: st.mtimeMs };
        if (st.size <= 16 * 1024 * 1024) { try { item.sha256 = createHash('sha256').update(readFileSync(f)).digest('hex'); } catch { item.error = 'READ'; } }
        out.push(item);
      } else out.push({ path: r, type: 'other', mtimeMs: st.mtimeMs });
    }
  };
  out.push({ path: '.', type: 'dir', mtimeMs: lstatSync(dir).mtimeMs });
  rec(dir, '');
  return out;
}

export function fingerprint({ repo, home = homedir(), spawn = spawnSync } = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const git = FINGERPRINT_GIT.map(args => {
    const r = spawn('git', args, { cwd: repo, env, encoding: 'utf8' });
    return { args, status: r.status ?? null, out: String(r.stdout ?? '') };
  });
  return { git, home: { locks: walk(join(home, '.trioharness-lean', 'locks')), config: walk(join(home, '.config', 'trioharness')) } };
}
export const sameFingerprint = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- tests that cannot be confined --------------------------------------------------------------------------------

const NV = 'NOT VERIFIED';
export function planRun(root, tests) {
  const run = []; const notVerified = [];
  for (const t of tests || []) {
    let why = null;
    for (const e of t.effects || []) {
      if (e.kind === 'path') { if (!isInside(root, e.path)) why = `a path outside the test root (${e.path})`; }
      else if (e.kind === 'network') why = `the real network (${e.host || 'unspecified'})`;
      else if (e.kind === 'credential') why = `a real credential (${e.name || 'unspecified'})`;
      else why = `an unknown effect kind (${e.kind})`;
      if (why) break;
    }
    if (why) notVerified.push({ name: t.name, why, reason: `${NV}: ${why}` });
    else run.push(t);
  }
  return { run, notVerified };
}

// Runs only the confinable tests; with a failed confinement step nothing runs. Never silent: every test that did not
// run is listed as NOT VERIFIED, and `verified` is false while any exists.
export function executeTests(root, tests, runFn, { stepsOk = true } = {}) {
  let plan;
  if (stepsOk) plan = planRun(root, tests);
  else {
    const why = 'a confinement step failed, so no test was started';
    plan = { run: [], notVerified: (tests || []).map(t => ({ name: t.name, why, reason: `${NV}: ${why}` })) };
  }
  const results = plan.run.map(t => ({ name: t.name, ...(runFn(t) || {}) }));
  return {
    ran: plan.run.map(t => t.name), results, notVerified: plan.notVerified,
    verified: stepsOk && plan.notVerified.length === 0 && results.every(r => r.status === 0),
    lines: plan.notVerified.map(t => `${NV} ${t.name}: ${t.why}`)
  };
}

// ---- CLI ----------------------------------------------------------------------------------------------------------

export function runCli(argv, deps = {}) {
  const d = {
    makeRoot: makeTestRoot, fingerprint, stepA: r => stepA(r), makeFixture: makeFixtureRepo, stepB: (r, o) => stepB(r, o),
    spawnCommand: (cmd, o) => spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env: o.env, cwd: o.cwd }),
    stdout: s => process.stdout.write(s), stderr: s => process.stderr.write(s),
    repo: process.cwd(), home: homedir(), ...deps
  };
  const mode = argv[0];
  const sep2 = argv.indexOf('--');
  const command = sep2 >= 0 ? argv.slice(sep2 + 1) : [];
  if (!(mode === 'prove' || (mode === 'run' && sep2 === 1 && command.length > 0))) {
    d.stderr('usage: test-root.mjs run -- <command...> | prove\n');
    return 2;
  }
  const fail = why => { d.stderr(`CONFINEMENT_FAILED: ${why}\n${NV}: nothing further was run\n`); return EXIT_CONFINEMENT_FAILED; };
  const root = d.makeRoot();
  const before = d.fingerprint({ repo: d.repo, home: d.home });
  d.stderr(`CONFINED root=${root}\n`);
  const a = d.stepA(root);
  if (!a || !a.ok) return fail(`step A (paths): outside=${JSON.stringify(a && a.outside)} ${(a && a.error) || ''}`);
  const fx = d.makeFixture(root);
  const b = d.stepB(root, { repo: fx.repo });
  if (!b || !b.ok) return fail(`step B (reclaim audit): ${(b && b.error) || JSON.stringify(b && b.outside)}`);
  let status = 0;
  if (mode === 'run') {
    const r = d.spawnCommand(command, { env: confinedEnv(root), cwd: d.repo });
    status = r && typeof r.status === 'number' ? r.status : 1;
    if (r && r.error) d.stderr(`CONFINED: could not start ${command[0]}: ${r.error.message}\n`);
  }
  const after = d.fingerprint({ repo: d.repo, home: d.home });
  if (!sameFingerprint(before, after)) return fail('the real home locks/config or the real repo changed while the confined command ran (no repair attempted)');
  return status;
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = runCli(process.argv.slice(2));
} catch { /* imported, not run */ }
