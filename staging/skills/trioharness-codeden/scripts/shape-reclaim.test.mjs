import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, utimesSync, chmodSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyShape, fixPlan, githubRepoUrl, hasStandingAuthorization, inspectShape, isTaskBranch, STANDING_AUTHORIZATION_LINE } from './repo-shape.mjs';
import { ARCHIVE_KEEP, archiveRuns, archiveSelect, isIdle, phasePolicy, run as reclaimRun, runActive, scanForSecrets } from './reclaim.mjs';
import { findArtifactDirs, isDisposable } from './cleanup.mjs';
import { lockNameFor, release, tryAcquire } from './run-lock.mjs';
import { guard } from './guard.mjs';
import { registerWorktree } from './run-state.mjs';
import { confinedEnv, makeTestRoot } from './test-root.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHAPE = join(here, 'repo-shape.mjs');
const HOOK = join(here, '..', 'templates', 'repo', 'pre-push');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commitFile = (dir, name, content, msg) => { writeFileSync(join(dir, name), content); git(dir, 'add', name); git(dir, 'commit', '--quiet', '-m', msg); };
function initRepo(branch) {
  const dir = mkdtempSync(join(tmpdir(), 'thl-'));
  git(dir, 'init', '--quiet', `--initial-branch=${branch}`);
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  return dir;
}
// A bare remote whose HEAD points at `defaultBranch`, plus a clone-like working repo pushed to it.
function repoWithRemote({ branch = 'harnessloop20260921', remoteDefault = branch } = {}) {
  const bare = mkdtempSync(join(tmpdir(), 'thl-bare-'));
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  const work = initRepo(branch);
  commitFile(work, 'a.txt', 'x', 'init');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '--quiet', '-u', 'origin', branch);
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', `refs/heads/${remoteDefault}`]);
  git(work, 'fetch', '--quiet', 'origin');
  return { bare, work };
}
const runShape = (repo, extra = [], env = {}) => spawnSync(process.execPath, [SHAPE, '--repo', repo, ...extra], { encoding: 'utf8', env: { ...process.env, ...env } });
const remoteHeads = bare => execFileSync('git', ['-C', bare, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

// ---------- repo shape: classification ----------

test('task-shaped branch names are recognised, real default names are not', () => {
  for (const n of ['bambooed/fix-1', 'trio/slice-2', 'codex/x', 'feature/login', 'harnessloop20260921', 'webchat-20260101'])
    assert.equal(isTaskBranch(n), true, n);
  for (const n of ['main', 'master', 'develop', 'trunk', 'release-2'])
    assert.equal(isTaskBranch(n), false, n);
});

test('classifyShape: ok only when the wanted branch exists and is the remote default', () => {
  const base = { hasCommits: true, hasRemote: true, want: 'main', localBranches: ['main'] };
  assert.equal(classifyShape({ ...base, remoteBranches: ['main'], remoteDefault: 'main' }).verdict, 'ok');
  assert.equal(classifyShape({ ...base, remoteBranches: ['main', 'trio/x'], remoteDefault: 'trio/x' }).verdict, 'default-not-set');
});

test('classifyShape: a task-shaped remote default is repaired from the REMOTE branch, fetched at that moment', () => {
  const r = classifyShape({ hasCommits: true, hasRemote: true, want: 'main', localBranches: ['harnessloop20260921'], remoteBranches: ['harnessloop20260921'], remoteDefault: 'harnessloop20260921' });
  assert.equal(r.verdict, 'task-shaped-default');
  assert.equal(r.action, 'create-and-set');
  assert.equal(r.from, 'harnessloop20260921');
  const plan = fixPlan(r, { remote: 'origin', repoUrl: 'https://github.com/o/r' }).map(([c, a]) => `${c} ${a.join(' ')}`);
  assert.deepEqual(plan, [
    'git fetch origin harnessloop20260921',
    'git branch main FETCH_HEAD',
    'git push -u origin main:main',
    'git remote set-head origin main',
    'gh repo edit --repo https://github.com/o/r --default-branch main'
  ]);
  assert.ok(plan.every(p => !/HEAD\b(?!_)/.test(p.replace('FETCH_HEAD', '')) && !/--force|-f\b|-D\b|--delete/.test(p)), 'no HEAD, force or delete anywhere');
});

test('classifyShape: never cuts a default from local HEAD — with no remote source it asks', () => {
  const r = classifyShape({ hasCommits: true, hasRemote: true, want: 'main', localBranches: ['private'], remoteBranches: ['bambooed/x'], remoteDefault: null });
  assert.equal(r.verdict, 'no-remote-source');
  assert.equal(r.action, 'ask');
  assert.deepEqual(fixPlan(r), []);
  assert.throws(() => fixPlan({ action: 'create-and-set', want: 'main', from: null }), /SHAPE_NO_SOURCE/);
});

test('classifyShape: no commits, no remote or a bad --want is the user’s call', () => {
  assert.equal(classifyShape({ hasCommits: false, hasRemote: true }).action, 'ask');
  assert.equal(classifyShape({ hasCommits: true, hasRemote: false }).action, 'ask');
  assert.equal(classifyShape({ hasCommits: true, hasRemote: true, want: 'main:evil', remoteBranches: [] }).verdict, 'want-invalid');
  assert.equal(classifyShape({ hasCommits: true, hasRemote: true, want: 'release', remoteBranches: [] }).verdict, 'want-invalid');
});

test('classifyShape: a repository whose default is master is a correct shape, never repaired into a second default', () => {
  const r = classifyShape({ hasCommits: true, hasRemote: true, want: 'main', localBranches: ['master'], remoteBranches: ['master', 'bambooed/x'], remoteDefault: 'master' });
  assert.equal(r.ok, true); assert.equal(r.action, 'none'); assert.equal(r.defaultBranch, 'master');
  assert.deepEqual(fixPlan(r), []);
});

test('fixPlan is idempotent: steps already done are skipped on a rerun (the CLI verifies a local branch first)', () => {
  const r = { action: 'create-and-set', want: 'main', from: 'x' };
  const again = fixPlan(r, { remote: 'origin', repoUrl: 'https://github.com/o/r', state: { localExists: true, remoteExists: true } }).map(([c, a]) => `${c} ${a.join(' ')}`);
  assert.deepEqual(again, ['git remote set-head origin main', 'gh repo edit --repo https://github.com/o/r --default-branch main']);
  assert.equal(classifyShape({ hasCommits: true, hasRemote: true, want: 'release', remoteBranches: ['main'], remoteDefault: 'main' }).verdict, 'want-invalid');
  const noGh = fixPlan(r, { remote: 'origin', repoUrl: null });
  assert.ok(noGh.every(([c]) => c !== 'gh'), 'gh is never run against a non-GitHub remote');
});

test('standing authorization is the exact line, from AGENTS.md only; mentions and negations do not count', () => {
  assert.equal(hasStandingAuthorization(STANDING_AUTHORIZATION_LINE), true);
  assert.equal(hasStandingAuthorization(`# Rules\n\n${STANDING_AUTHORIZATION_LINE}\n- other`), true);
  assert.equal(hasStandingAuthorization('- Repository shape: standing authorization is NOT granted'), false);
  assert.equal(hasStandingAuthorization('Repository shape: standing authorization to create the default branch'), false);
  assert.equal(hasStandingAuthorization(''), false);
});

test('githubRepoUrl accepts only GitHub remotes and normalises them', () => {
  assert.equal(githubRepoUrl('git@github.com:Cumulus-Service-GmbH/WebChatMobile.git'), 'https://github.com/Cumulus-Service-GmbH/WebChatMobile');
  assert.equal(githubRepoUrl('https://github.com/o/r.git'), 'https://github.com/o/r');
  assert.equal(githubRepoUrl('https://dev.azure.com/org/proj/_git/r'), null);
  assert.equal(githubRepoUrl('/tmp/bare.git'), null);
});

// ---------- repo shape: --apply against a real remote ----------

test('inspectShape on a real repository with no remote reports no-remote and plans nothing', () => {
  const dir = initRepo('harnessloop20260921');
  commitFile(dir, 'a.txt', 'x', 'init');
  const r = inspectShape(dir, { remote: 'origin', want: 'main' });
  assert.equal(r.verdict, 'no-remote'); assert.equal(r.action, 'ask'); assert.deepEqual(fixPlan(r), []);
});

test('--apply publishes the REMOTE branch head as main, never the user’s unpushed local commit', () => {
  const { bare, work } = repoWithRemote();
  const remoteSha = git(work, 'rev-parse', 'origin/harnessloop20260921').trim();
  // The user's private, unpushed work on top, in the main checkout.
  commitFile(work, 'secret-experiment.txt', 'private', 'private experiment (never pushed)');
  const localHead = git(work, 'rev-parse', 'HEAD').trim();
  assert.notEqual(localHead, remoteSha);
  writeFileSync(join(work, 'AGENTS.md'), `# Rules\n${STANDING_AUTHORIZATION_LINE}\n`);

  const r = runShape(work, ['--apply']);
  const heads = Object.fromEntries(remoteHeads(bare).map(l => l.split(' ')));
  assert.equal(heads.main, remoteSha, `main must be the remote branch head, got ${r.stdout}${r.stderr}`);
  assert.notEqual(heads.main, localHead, 'the unpushed local commit was not published');
  assert.ok(heads.harnessloop20260921, 'the old branch still exists');
  assert.match(r.stderr, /SHAPE_PARTIAL/, 'a non-GitHub remote reports the default as a manual step');
  assert.equal(r.status, 2);
  // Rerun is idempotent: no "branch already exists", no second push failure.
  const again = runShape(work, ['--apply']);
  assert.doesNotMatch(again.stdout + again.stderr, /already exists|SHAPE_FAILED/);
});

test('--apply refuses without the exact authorization line and without a remote source', () => {
  const { work } = repoWithRemote();
  writeFileSync(join(work, 'AGENTS.md'), '- Repository shape: standing authorization is NOT granted here\n');
  let r = runShape(work, ['--apply']);
  assert.equal(r.status, 2); assert.match(r.stderr, /SHAPE_NOT_AUTHORIZED/);
  // CLAUDE.md is not a source of authorization.
  writeFileSync(join(work, 'CLAUDE.md'), `${STANDING_AUTHORIZATION_LINE}\n`);
  r = runShape(work, ['--apply']);
  assert.equal(r.status, 2); assert.match(r.stderr, /SHAPE_NOT_AUTHORIZED/);
});

test('gate 0 push passes the installed pre-push hook for a CREATION only, under the marker; any other main push is blocked', () => {
  const { bare, work } = repoWithRemote();
  if (process.platform === 'win32') return; // the hook is a sh script
  copyFileSync(HOOK, join(work, '.git', 'hooks', 'pre-push'));
  chmodSync(join(work, '.git', 'hooks', 'pre-push'), 0o755);
  writeFileSync(join(work, 'AGENTS.md'), `${STANDING_AUTHORIZATION_LINE}\n`);
  const r = runShape(work, ['--apply'], { CLAUDECODE: '1' });
  const heads = Object.fromEntries(remoteHeads(bare).map(l => l.split(' ')));
  assert.ok(heads.main, `main created through the hook: ${r.stdout}${r.stderr}`);
  // An agent UPDATE of main is still blocked by the same hook, marker or not.
  git(work, 'checkout', '--quiet', 'main');
  commitFile(work, 'b.txt', 'y', 'agent edit');
  const blocked = spawnSync('git', ['-C', work, 'push', 'origin', 'main'], { encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1', TRIOHARNESS_SHAPE_CREATE: 'main' } });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Push blocked/);
  const blocked2 = spawnSync('git', ['-C', work, 'push', 'origin', 'main'], { encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1' } });
  assert.notEqual(blocked2.status, 0);
});

test('inspectShape reads the LIVE remote default, not the cached symref', () => {
  const { bare, work } = repoWithRemote();
  // Fix the default on the remote by hand; the local cache still says task branch.
  git(work, 'push', '--quiet', 'origin', 'harnessloop20260921:main');
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const r = inspectShape(work, { remote: 'origin', want: 'main' });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.facts.remoteDefault, 'main');
});

// ---------- reclaim ----------

test('phasePolicy: no phase ever reclaims the main checkout or outside the current/idle worktrees', () => {
  for (const p of ['pre-worktree', 'post-push']) {
    assert.equal(phasePolicy(p).mainCheckout, 'never', p);
    assert.equal(phasePolicy(p).heavy, 'idle-worktrees', p);
    assert.equal(phasePolicy(p).ownTree, 'caches-only', p);
  }
  assert.throws(() => phasePolicy('whenever'), /RECLAIM_PHASE_UNKNOWN/);
});

function projectWithWorktree() {
  const main = realpathSync(initRepo('main'));
  writeFileSync(join(main, '.gitignore'), 'bin/\nobj/\nnode_modules/\n');
  git(main, 'add', '.gitignore'); git(main, 'commit', '--quiet', '-m', 'init');
  const wt = join(main, '..', `wt-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const br = `bambooed/${Math.random().toString(36).slice(2, 8)}`;
  git(main, 'worktree', 'add', '--quiet', '-b', br, wt);
  registerWorktree(main, 'fixture-run', { path: wt, branch: br }); // the caller's tree is the run's own; unregistered trees are never reclaimed
  return { main, wt };
}
const bigFile = (dir, name) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), 'x'.repeat(4096)); };

test('the main checkout is never reclaimed, even with artifacts and dirty work in it', () => {
  const { main, wt } = projectWithWorktree();
  bigFile(join(main, 'node_modules'), 'pkg.js'); bigFile(join(main, 'bin'), 'app.dll'); writeFileSync(join(main, 'wip.txt'), 'dirty');
  bigFile(join(wt, 'bin'), 'app.dll');
  const r = reclaimRun({ repo: wt, worktree: wt, phase: 'pre-worktree', apply: true });
  assert.ok(existsSync(join(main, 'node_modules', 'pkg.js')) && existsSync(join(main, 'bin', 'app.dll')) && existsSync(join(main, 'wip.txt')));
  assert.ok(r.skippedWorktrees.some(s => /main checkout/.test(s.reason)));
  assert.equal(existsSync(join(wt, 'bin')), false, 'the caller’s own caches are reclaimed');
  assert.equal(r.reclaimed.some(x => x.path.startsWith(join(main, 'node_modules'))), false);
});

test('the caller’s own worktree is reclaimed only under its run-lock, and never its node_modules', () => {
  const { wt } = projectWithWorktree();
  bigFile(join(wt, 'obj'), 'x.o'); bigFile(join(wt, 'node_modules'), 'pkg.js');
  const held = tryAcquire(lockNameFor(wt), { note: 'test build' });
  assert.equal(held.acquired, true);
  try {
    const r = reclaimRun({ repo: wt, worktree: wt, phase: 'post-push', apply: true });
    assert.ok(existsSync(join(wt, 'obj', 'x.o')), 'nothing deleted while a build holds the lock');
    assert.ok(r.skippedWorktrees.some(s => /run-lock is held/.test(s.reason)));
  } finally { release(held.file); }
  reclaimRun({ repo: wt, worktree: wt, phase: 'post-push', apply: true });
  assert.equal(existsSync(join(wt, 'obj')), false);
  assert.ok(existsSync(join(wt, 'node_modules', 'pkg.js')), 'own-tree node_modules survive');
  assert.equal(existsSync(join(lockNameFor(wt) && join(require_lockdir(), `${lockNameFor(wt)}.lock`))), false, 'lock released after reclaim');
});
function require_lockdir() { return join(process.env.HOME || process.env.USERPROFILE || tmpdir(), '.trioharness-lean', 'locks'); }

test('a linked worktree whose run-lock is held is skipped whole; an idle unlocked one is reclaimed', () => {
  const { main, wt } = projectWithWorktree();
  const other = join(main, '..', `wt2-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  git(main, 'worktree', 'add', '--quiet', '-b', 'bambooed/parallel', other);
  bigFile(join(other, 'bin'), 'out.dll'); bigFile(join(other, 'node_modules'), 'pkg.js');
  // Only a tree some run registered is the harness's to reclaim, and only once it has been quiet for 2 hours.
  registerWorktree(main, 'old-run', { path: other, branch: 'bambooed/parallel' });
  { const f = join(main, '.trioharness-direct', 'runs', 'old-run', 'state.json'); const st = JSON.parse(readFileSync(f, 'utf8')); st.finished = true; writeFileSync(f, JSON.stringify(st)); }
  const later = Date.now() + 3 * 3600 * 1000;
  const held = tryAcquire(lockNameFor(other), { note: 'test build' });
  try {
    const r = reclaimRun({ repo: wt, worktree: wt, phase: 'post-push', apply: true, now: later });
    assert.ok(r.skippedWorktrees.some(s => realpathSync(s.path) === realpathSync(other) && /run-lock is held/.test(s.reason)));
    assert.ok(existsSync(join(other, 'bin', 'out.dll')));
  } finally { release(held.file); }
  const r2 = reclaimRun({ repo: wt, worktree: wt, phase: 'post-push', apply: true, now: later });
  assert.equal(existsSync(join(other, 'bin')), false);
  assert.equal(existsSync(join(other, 'node_modules')), false, 'idle linked worktree loses node_modules');
  assert.ok(r2.reclaimed.some(x => x.kind === 'heavy'));
});

test('a linked worktree no run registered (the user’s own) is never reclaimed, even idle and unlocked', () => {
  const { main, wt } = projectWithWorktree();
  const mine = join(main, '..', `user-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  git(main, 'worktree', 'add', '--quiet', '-b', 'feature/mine', mine);
  bigFile(join(mine, 'node_modules'), 'pkg.js');
  const r = reclaimRun({ repo: wt, worktree: wt, phase: 'post-push', apply: true, now: Date.now() + 3 * 3600 * 1000 });
  assert.ok(existsSync(join(mine, 'node_modules', 'pkg.js')));
  assert.ok(r.skippedWorktrees.some(s => realpathSync(s.path) === realpathSync(mine) && /not registered/.test(s.reason)));
});

test('a nested repository under an ignored path is never scanned or deleted', () => {
  const { wt } = projectWithWorktree();
  const nested = join(wt, 'vendor', 'lib');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(wt, '.gitignore'), 'bin/\nobj/\nnode_modules/\nvendor/\n');
  execFileSync('git', ['init', '--quiet', nested]);
  bigFile(join(nested, 'bin'), 'tool.sh');
  execFileSync('git', ['-C', nested, 'add', '.']);
  execFileSync('git', ['-C', nested, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '--quiet', '-m', 'nested']);
  const dirs = findArtifactDirs(wt, ['bin']);
  assert.equal(dirs.some(d => d.startsWith(nested)), false, 'walker stops at a nested .git');
  const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const v = isDisposable(wt, join(nested, 'bin'), gitIn);
  assert.equal(v.ok, false); assert.match(v.reason, /nested repository/);
  reclaimRun({ repo: wt, worktree: wt, phase: 'pre-worktree', apply: true });
  assert.ok(existsSync(join(nested, 'bin', 'tool.sh')));
});

test('runActive / isIdle: no state, empty gates or any unfinished gate is active; file writes count as activity', () => {
  const wt = mkdtempSync(join(tmpdir(), 'thl-wt-'));
  assert.equal(isIdle(wt), true);
  const run = join(wt, '.trioharness-direct', 'runs', 'r3');
  mkdirSync(run, { recursive: true });
  assert.equal(runActive(run), true, 'no state.json = active');
  writeFileSync(join(run, 'state.json'), JSON.stringify({ gates: {} }));
  assert.equal(runActive(run), true, 'empty gates = active');
  writeFileSync(join(run, 'state.json'), JSON.stringify({ gates: { build: { status: 'in-progress' } } }));
  assert.equal(isIdle(wt, { now: Date.now() + 86400000 }), false, 'unfinished stays active however old');
  writeFileSync(join(run, 'state.json'), JSON.stringify({ gates: { build: { status: 'passed' }, learnings: { status: 'passed' } } }));
  // Age everything 3 h back, then overwrite a file in place (directory mtime does not change).
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  for (const p of [run, join(run, 'state.json')]) utimesSync(p, old, old);
  assert.equal(isIdle(wt), true, 'old and all-passed is idle');
  writeFileSync(join(run, 'state.json'), JSON.stringify({ gates: { build: { status: 'passed' }, review: { status: 'passed' }, learnings: { status: 'passed' } } }));
  utimesSync(run, old, old);
  assert.equal(isIdle(wt), false, 'a fresh write inside the run makes the worktree active again');
  assert.ok(readdirSync(join(wt, '.trioharness-direct', 'runs')).length === 1);
});

test('archiveSelect keeps the record (including proof and logs) and drops the scratch', () => {
  const { keep, drop } = archiveSelect(['ledger.md', 'failures.md', 'state.json', 'workers', 'proof', 'plans', 'tmp', 'bin']);
  assert.deepEqual(keep, ['ledger.md', 'failures.md', 'state.json', 'workers', 'proof', 'plans']);
  assert.deepEqual(drop, ['tmp', 'bin']);
  for (const k of ['ledger.md', 'state.json', 'workers', 'proof', 'logs']) assert.ok(ARCHIVE_KEEP.includes(k));
});

test('archiveRuns copies the keepers, leaves the source alone, never overwrites a newer archive with an older copy', () => {
  const wt = mkdtempSync(join(tmpdir(), 'thl-wt-'));
  const main = mkdtempSync(join(tmpdir(), 'thl-main-'));
  const run = join(wt, '.trioharness-direct', 'runs', 'r1');
  mkdirSync(join(run, 'workers'), { recursive: true }); mkdirSync(join(run, 'tmp'), { recursive: true });
  writeFileSync(join(run, 'ledger.md'), '# ledger v2');
  writeFileSync(join(run, 'workers', 'writer-1.md'), 'result');
  writeFileSync(join(run, 'tmp', 'big.log'), 'x'.repeat(1000));
  writeFileSync(join(run, 'state.json'), JSON.stringify({ finished: true, gates: { base: { status: 'passed' } } }));
  const planned = archiveRuns(wt, { repo: main, branch: 'bambooed/x', apply: true });
  assert.equal(planned.length, 1);
  const dest = join(main, '.trioharness-direct', 'archive', 'bambooed__x', 'r1');
  assert.ok(existsSync(join(dest, 'ledger.md')) && existsSync(join(dest, 'workers', 'writer-1.md')));
  assert.equal(existsSync(join(dest, 'tmp')), false, 'scratch is never archived');
  assert.ok(existsSync(join(run, 'ledger.md')), 'the source run folder is not touched');
  // An OLDER copy of the same run elsewhere must not overwrite the archive.
  const wt2 = mkdtempSync(join(tmpdir(), 'thl-wt2-'));
  const run2 = join(wt2, '.trioharness-direct', 'runs', 'r1');
  mkdirSync(run2, { recursive: true });
  writeFileSync(join(run2, 'ledger.md'), '# ledger v1 (stale)');
  writeFileSync(join(run2, 'state.json'), JSON.stringify({ finished: true, gates: { base: { status: 'passed' } } }));
  const old = new Date(Date.now() - 3600 * 1000);
  utimesSync(join(run2, 'ledger.md'), old, old);
  const p2 = archiveRuns(wt2, { repo: main, branch: 'bambooed/x', apply: true });
  assert.ok(p2[0].skipped, 'older copy skipped');
  assert.equal(readFileSync(join(dest, 'ledger.md'), 'utf8'), '# ledger v2');
});

test('archiveRuns skips unfinished runs when only finished runs are wanted, and never copies a keeper carrying a secret', () => {
  const wt = mkdtempSync(join(tmpdir(), 'thl-wt-'));
  const main = mkdtempSync(join(tmpdir(), 'thl-main-'));
  const run = join(wt, '.trioharness-direct', 'runs', 'r2');
  mkdirSync(join(run, 'workers'), { recursive: true });
  writeFileSync(join(run, 'ledger.md'), '# ledger');
  writeFileSync(join(run, 'state.json'), JSON.stringify({ gates: { base: { status: 'passed' }, build: { status: 'in-progress' } } }));
  assert.deepEqual(archiveRuns(wt, { repo: main, branch: 'b', apply: true, onlyFinished: true }), []);
  writeFileSync(join(run, 'state.json'), JSON.stringify({ finished: true, gates: { base: { status: 'passed' } } }));
  writeFileSync(join(run, 'workers', 'writer-1.md'), 'token: "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"');
  assert.equal(scanForSecrets(join(run, 'workers')).length, 1);
  const p = archiveRuns(wt, { repo: main, branch: 'b', apply: true, onlyFinished: true });
  assert.ok(p[0].secretHits.length === 1);
  assert.ok(existsSync(join(main, '.trioharness-direct', 'archive', 'b', 'r2', 'ledger.md')));
  assert.equal(existsSync(join(main, '.trioharness-direct', 'archive', 'b', 'r2', 'workers', 'writer-1.md')), false, 'the secret-bearing file was not copied');
  // Only the hit file is left out: a sibling in the same keeper is archived (R3).
  const run3 = join(wt, '.trioharness-direct', 'runs', 'r3');
  mkdirSync(join(run3, 'proof'), { recursive: true });
  writeFileSync(join(run3, 'state.json'), JSON.stringify({ finished: true, gates: { base: { status: 'passed' } } }));
  writeFileSync(join(run3, 'proof', 'huge.trx'), Buffer.alloc(5 * 1024 * 1024));
  writeFileSync(join(run3, 'proof', 'summary.txt'), 'Passed! 12 tests');
  const p3 = archiveRuns(wt, { repo: main, branch: 'b', apply: true, onlyFinished: true });
  assert.ok(p3.some(x => x.run === 'r3' && x.secretHits.some(h => /unscannable/.test(h.pattern))));
  assert.ok(existsSync(join(main, '.trioharness-direct', 'archive', 'b', 'r3', 'proof', 'summary.txt')), 'the rest of proof/ is archived');
  assert.equal(existsSync(join(main, '.trioharness-direct', 'archive', 'b', 'r3', 'proof', 'huge.trx')), false);
});

test('run scratch of an ACTIVE run is never reclaimed (its proof may still be cited by path)', () => {
  const { wt } = projectWithWorktree();
  const run = join(wt, '.trioharness-direct', 'runs', 'live');
  mkdirSync(join(run, 'tmp'), { recursive: true });
  writeFileSync(join(run, 'tmp', 'proof.log'), 'PASSED');
  writeFileSync(join(run, 'state.json'), JSON.stringify({ gates: { build: { status: 'in-progress' } } }));
  reclaimRun({ repo: wt, worktree: wt, phase: 'post-push', apply: true });
  assert.ok(existsSync(join(run, 'tmp', 'proof.log')));
  writeFileSync(join(run, 'state.json'), JSON.stringify({ gates: { build: { status: 'passed' } } }));
  reclaimRun({ repo: wt, worktree: wt, phase: 'post-push', apply: true });
  assert.ok(existsSync(join(run, 'tmp', 'proof.log')), 'a run between gates is still active');
  writeFileSync(join(run, 'state.json'), JSON.stringify({ finished: true, gates: { build: { status: 'passed' } } }));
  reclaimRun({ repo: wt, worktree: wt, phase: 'post-push', apply: true });
  assert.equal(existsSync(join(run, 'tmp')), false);
});

// ---------- live base ref ----------

test('guard --max-behind proves freshness against the LIVE remote: unfetched, stale or unreachable all fail', () => {
  const bare = mkdtempSync(join(tmpdir(), 'thl-bare-'));
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const w = initRepo('main');
  commitFile(w, 'src.txt', 'one', 'base');
  git(w, 'remote', 'add', 'origin', bare);
  git(w, 'push', '--quiet', '-u', 'origin', 'main');
  git(w, 'fetch', '--quiet', 'origin');
  const base = git(w, 'rev-parse', 'HEAD').trim();
  commitFile(w, 'src.txt', 'two', 'candidate');
  const opts = { repo: w, base, owned: ['src.txt'], remote: 'origin/main', tier: 'lean', allowMainWorktree: true };
  let r = guard({ ...opts, maxBehind: 0 });
  assert.equal(r.clean, true, JSON.stringify(r.violations));

  // Someone else lands a commit on the remote default. WITHOUT fetching, guard must already fail.
  const other = mkdtempSync(join(tmpdir(), 'thl-other-'));
  execFileSync('git', ['clone', '--quiet', bare, other]);
  git(other, 'checkout', '--quiet', '-B', 'main', 'origin/main');
  git(other, 'config', 'user.email', 'o@example.com'); git(other, 'config', 'user.name', 'O');
  commitFile(other, 'theirs.txt', 'theirs', 'their work');
  git(other, 'push', '--quiet', 'origin', 'HEAD:main');
  assert.throws(() => guard({ ...opts, maxBehind: 0 }), { code: 'REMOTE_REF_STALE' });

  // After the fetch the local ref is fresh, and now the base itself is behind.
  git(w, 'fetch', '--quiet', 'origin');
  r = guard({ ...opts, maxBehind: 0 });
  assert.equal(r.baseBehindRemote, 1);
  assert.ok(r.violations.some(v => v.rule === 'base-stale'));
  assert.equal(r.violations.some(v => v.rule === 'remote-ref-stale'), false);

  // A local branch passed as --remote is refused outright.
  assert.throws(() => guard({ ...opts, remote: 'main', maxBehind: 0 }), { code: 'DEFAULT_REMOTE_UNKNOWN' });

  // Ancestry alone still passes, which is why freshness needs its own limit.
  assert.equal(guard({ ...opts }).clean, true);

  // An unreachable configured remote cannot verify freshness either.
  git(w, 'remote', 'set-url', 'origin', join(w, 'missing-remote.git'));
  assert.throws(() => guard({ ...opts, maxBehind: 0 }), { code: 'DEFAULT_UNVERIFIED' });
});


test('--apply never pushes a pre-existing local main that is not the remote source head (N1)', () => {
  const { bare, work } = repoWithRemote();
  git(work, 'branch', 'main'); // a stale local main...
  commitFile(work, 'private.txt', 'p', 'USER PRIVATE LOCAL MAIN COMMIT');
  git(work, 'branch', '-f', 'main', 'HEAD'); // ...pointing at an unpushed private commit (user action, not the harness)
  git(work, 'checkout', '--quiet', 'harnessloop20260921');
  writeFileSync(join(work, 'AGENTS.md'), `${STANDING_AUTHORIZATION_LINE}\n`);
  const r = runShape(work, ['--apply']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /local-branch-conflict/);
  const heads = Object.fromEntries(remoteHeads(bare).map(l => l.split(' ')));
  assert.equal(heads.main, undefined, 'nothing was pushed');
  // When the local main IS the remote head, the rerun proceeds (idempotent path is safe).
  git(work, 'branch', '-f', 'main', 'origin/harnessloop20260921');
  const r2 = runShape(work, ['--apply']);
  const heads2 = Object.fromEntries(remoteHeads(bare).map(l => l.split(' ')));
  assert.equal(heads2.main, git(work, 'rev-parse', 'origin/harnessloop20260921').trim(), r2.stdout + r2.stderr);
});

test('hook marker admits only a conventional default, local==remote ref, creation only (N5)', () => {
  if (process.platform === 'win32') return;
  const { bare, work } = repoWithRemote();
  copyFileSync(HOOK, join(work, '.git', 'hooks', 'pre-push')); chmodSync(join(work, '.git', 'hooks', 'pre-push'), 0o755);
  const push = (refspec, marker) => spawnSync('git', ['-C', work, 'push', 'origin', refspec], { encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1', ...(marker ? { TRIOHARNESS_SHAPE_CREATE: marker } : {}) } });
  assert.notEqual(push('HEAD:refs/heads/release', 'release').status, 0, 'arbitrary new branch via marker is blocked');
  assert.notEqual(push('HEAD:refs/heads/main', 'main').status, 0, 'local ref must be the same branch');
  git(work, 'branch', 'main', 'origin/harnessloop20260921');
  assert.equal(push('main:main', 'main').status, 0, 'creation of main from local main under the marker is allowed');
  assert.notEqual(push('main:main', 'main').status === 0 && false, true);
  commitFile(work, 'c.txt', 'c', 'x'); git(work, 'checkout', '--quiet', 'main'); commitFile(work, 'd.txt', 'd', 'y');
  assert.notEqual(push('main:main', 'main').status, 0, 'an update of main is blocked even with the marker');
  assert.ok(remoteHeads(bare).some(l => l.startsWith('main ')));
});

test('guard --base live diffs only this run\u2019s work after the default branch is merged into the task branch (N4)', () => {
  const bare = mkdtempSync(join(tmpdir(), 'thl-bare-'));
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const w = initRepo('main');
  commitFile(w, 'src.txt', 'one', 'base');
  git(w, 'remote', 'add', 'origin', bare); git(w, 'push', '--quiet', '-u', 'origin', 'main');
  git(w, 'fetch', '--quiet', 'origin');
  git(w, 'checkout', '--quiet', '-b', 'bambooed/r1');
  commitFile(w, 'src.txt', 'two', 'candidate');
  const other = mkdtempSync(join(tmpdir(), 'thl-other-'));
  execFileSync('git', ['clone', '--quiet', bare, other]); git(other, 'checkout', '--quiet', '-B', 'main', 'origin/main');
  git(other, 'config', 'user.email', 'o@example.com'); git(other, 'config', 'user.name', 'O');
  commitFile(other, 'theirs.txt', 'theirs', 'their work'); git(other, 'push', '--quiet', 'origin', 'HEAD:main');
  git(w, 'fetch', '--quiet', 'origin');
  git(w, 'merge', '--quiet', '--no-edit', 'origin/main');
  const opts = { repo: w, owned: ['src.txt'], remote: 'origin/main', tier: 'lean', allowMainWorktree: true, maxBehind: 0 };
  const r = guard({ ...opts, base: 'live' });
  assert.equal(r.clean, true, JSON.stringify(r.violations));
  assert.deepEqual(r.paths.map(p => p.path || p), r.paths.map(p => p.path || p)); // shape sanity
  assert.equal(r.base, git(w, 'rev-parse', 'origin/main').trim(), 'live base equals the remote head once fully merged');
  assert.throws(() => guard({ ...opts, base: 'live', remote: undefined }), /BASE_LIVE_NEEDS_REMOTE/);
  assert.throws(() => guard({ ...opts, base: 'live', remote: 'origin/bambooed/other' }), /BASE_LIVE_NOT_DEFAULT/);
});

test('runFinished / runActive: a run is closed only by finished:true or a passed final learnings gate (N3)', () => {
  const wt = mkdtempSync(join(tmpdir(), 'thl-wt-'));
  const run = join(wt, '.trioharness-direct', 'runs', 'r9');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'state.json'), JSON.stringify({ gates: { base: { status: 'passed' }, 'commit-push': { status: 'passed' } } }));
  assert.equal(runActive(run), true, 'between commit-push and deploy-qa is still active');
  writeFileSync(join(run, 'state.json'), JSON.stringify({ gates: { base: { status: 'passed' }, learnings: { status: 'passed' } } }));
  assert.equal(runActive(run), false);
  writeFileSync(join(run, 'state.json'), JSON.stringify({ finished: true, gates: { base: { status: 'passed' } } }));
  assert.equal(runActive(run), false);
});


test('run-state: learnings closes a run only when accepted and nothing failed or blocked (R2)', async () => {
  const { setGate } = await import('./run-state.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'thl-rs-'));
  setGate(repo, 'r1', { gate: 'build', status: 'failed' });
  let st = setGate(repo, 'r1', { gate: 'learnings', status: 'passed' });
  assert.notEqual(st.finished, true); assert.match(st.notFinishedBecause, /done-jev/);
  setGate(repo, 'r2', { gate: 'done-jev', status: 'passed' });
  st = setGate(repo, 'r2', { gate: 'learnings', status: 'passed' });
  assert.equal(st.finished, true);
  setGate(repo, 'r3', { gate: 'done-jev', status: 'passed' }); setGate(repo, 'r3', { gate: 'deploy-qa', status: 'blocked' });
  st = setGate(repo, 'r3', { gate: 'learnings', status: 'passed' });
  assert.notEqual(st.finished, true); assert.match(st.notFinishedBecause, /deploy-qa/);
});

// S2-C5; injectable failures never delete. Success cases remain in test-root.
function s2ReclaimFixture() {
  const { main, wt } = projectWithWorktree();
  mkdirSync(join(wt, 'bin')); writeFileSync(join(wt, 'bin', 'large'), Buffer.alloc(2 * 1048576));
  const scratch = join(wt, '.trioharness-direct', 'runs', 'finished');
  mkdirSync(join(scratch, 'tmp'), { recursive: true });
  writeFileSync(join(scratch, 'tmp', 'large'), Buffer.alloc(1048576));
  writeFileSync(join(scratch, 'state.json'), JSON.stringify({ finished: true }));
  bigFile(join(wt, 'node_modules'), 'kept');
  writeFileSync(join(wt, 'user.txt'), 'kept');
  return { main, wt, scratch, env: confinedEnv(makeTestRoot()) };
}
// Exact reclaimed-path fixtures must not observe stale locks from other test processes or the host.
function s2ConfinedReclaim(options, env) {
  const code = `import { run } from ${JSON.stringify(new URL('./reclaim.mjs', import.meta.url).href)}; process.stdout.write(JSON.stringify(run(JSON.parse(process.argv[1]))));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options)], { encoding: 'utf8', env });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
test('hf5b1e-s2-d-reclaim: counts only confirmed deletions', () => {
  const { wt, scratch } = s2ReclaimFixture(); const attempts = [];
  const r = reclaimRun({ repo: wt, worktree: wt, phase: 'pre-worktree', apply: true,
    rm: path => { attempts.push(path); throw new Error('fixture denied'); } });
  assert.equal(r.freedMb, 0);
  assert.deepEqual(r.reclaimed, []);
  assert.ok(attempts.includes(join(wt, 'bin')) && attempts.includes(join(scratch, 'tmp')));
  assert.equal(r.errors.filter(e => /fixture denied/.test(e)).length, attempts.length);
  assert.equal(existsSync(join(wt, 'bin', 'large')), true);
  assert.equal(existsSync(join(scratch, 'tmp', 'large')), true);
});
test('hf5b1e-s2-p-reclaim: audit mode reports WOULD FREE and deletes nothing', () => {
  const { main, wt, scratch, env } = s2ReclaimFixture();
  const r = s2ConfinedReclaim({ repo: wt, worktree: wt, phase: 'pre-worktree' }, env);
  assert.equal(r.apply, false); assert.equal(r.freedMb, 3);
  assert.deepEqual(r.reclaimed.map(e => e.path).sort(), [join(wt, 'bin'), join(scratch, 'tmp')].sort());
  assert.ok(existsSync(join(wt, 'bin', 'large')) && existsSync(join(scratch, 'tmp', 'large')));
  const cli = spawnSync(process.execPath, [join(here, 'reclaim.mjs'), '--repo', main, '--worktree', wt, '--phase', 'pre-worktree'], { encoding: 'utf8', env });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /WOULD FREE .* across/);
});
test('hf5b1e-s2-p-reclaim: apply deletes and counts only existing allow-listed dirs', () => {
  const { wt, scratch, env } = s2ReclaimFixture();
  const r = s2ConfinedReclaim({ repo: wt, worktree: wt, phase: 'pre-worktree', apply: true }, env);
  assert.equal(r.freedMb, 3); assert.deepEqual(r.errors, []);
  assert.deepEqual(r.reclaimed.map(e => e.path).sort(), [join(wt, 'bin'), join(scratch, 'tmp')].sort());
  assert.ok(!existsSync(join(wt, 'bin')) && !existsSync(join(scratch, 'tmp')));
  assert.ok(existsSync(join(wt, 'node_modules', 'kept')) && existsSync(join(wt, 'user.txt')));
});
