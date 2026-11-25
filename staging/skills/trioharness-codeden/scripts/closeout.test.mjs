import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUSHABLE, auditRepo, closeAll, currentTree, decide, findRepos, inspectWorktree, isHarnessTree, normPath, snapshotDirty } from './closeout.mjs';
import { listWorktrees } from './reclaim.mjs';
import { lockNameFor, release, tryAcquire } from './run-lock.mjs';
import { readState, recordCloseout, registerWorktree, setGate } from './run-state.mjs';
import { recordCleanState } from './clean-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Windows creates symlinks only with Developer Mode or admin rights; those tests are skipped (not failed) where it cannot.
const CAN_SYMLINK = (() => { const t = mkdtempSync(join(tmpdir(), 'thl-sym-')); try { symlinkSync('x', join(t, 'l')); return true; } catch { return false; } finally { rmSync(t, { recursive: true, force: true }); } })();
const SYMLINK_SKIP = CAN_SYMLINK ? false : 'symlinks need Developer Mode or admin rights on Windows';
const CLOSEOUT = join(here, 'closeout.mjs');
const RUNSTATE = join(here, 'run-state.mjs');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (dir, ...a) => { try { return git(dir, ...a); } catch { return null; } };
const commitFile = (dir, name, content, msg = name) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); git(dir, 'add', name); git(dir, 'commit', '--quiet', '-m', msg); };

function project() {
  const bare = mkdtempSync(join(tmpdir(), 'thl-co-bare-'));
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  const main = mkdtempSync(join(tmpdir(), 'thl-co-main-'));
  git(main, 'init', '--quiet', '--initial-branch=main');
  git(main, 'config', 'user.email', 't@example.com'); git(main, 'config', 'user.name', 'T');
  commitFile(main, 'a.txt', 'x', 'init');
  writeFileSync(join(main, '.gitignore'), 'appsettings.Local.json\nbin/\nobj/\nnode_modules/\n.trioharness-direct/\n');
  git(main, 'add', '.gitignore'); git(main, 'commit', '--quiet', '-m', 'ignore');
  git(main, 'remote', 'add', 'origin', bare);
  git(main, 'push', '--quiet', '-u', 'origin', 'main');
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { bare, main };
}
// A harness-style tree: <main>.trioharness/<name>
function addTree(main, name, branch, { base = 'HEAD' } = {}) {
  const path = join(`${main}.trioharness`, name);
  mkdirSync(dirname(path), { recursive: true });
  if (branch === null) git(main, 'worktree', 'add', '--quiet', '--detach', path, base);
  else git(main, 'worktree', 'add', '--quiet', '-b', branch, path, base);
  return path;
}
const remoteHas = (bare, ref) => { try { execFileSync('git', ['-C', bare, 'show-ref', '--verify', '--quiet', `refs/heads/${ref}`]); return true; } catch { return false; } };
const treeAt = (main, p) => listWorktrees(main).find(w => normPath(w.path) === normPath(p));
const closePaths = (main, paths, flags = {}, extra = {}) => closeAll({ repo: main, paths, flags, apply: true, ...extra });

test('a clean, pushed worktree is closed and its branch survives; the main checkout is untouched', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/clean');
  const before = git(main, 'rev-parse', 'HEAD').trim();
  const r = closePaths(main, [wt]);
  assert.equal(r.closed, 1); assert.equal(r.open, 0);
  assert.equal(existsSync(wt), false);
  assert.ok(tryGit(main, 'rev-parse', '--verify', 'trio/clean'), 'branch remains');
  assert.equal(git(main, 'rev-parse', 'HEAD').trim(), before);
  assert.equal(existsSync(join(main, 'a.txt')), true);
});

test('dry run changes nothing', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/dry');
  writeFileSync(join(wt, 'new.txt'), 'n');
  const r = closeAll({ repo: main, paths: [wt], flags: { snapshot: true }, apply: false });
  assert.equal(r.results[0].status, 'would-close');
  assert.equal(existsSync(join(wt, 'new.txt')), true);
  assert.equal(tryGit(main, 'rev-parse', '--verify', 'refs/heads/trio/wip-' + 'x'), null);
});

test('uncommitted work without --snapshot is a blocker: nothing is removed', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/dirty');
  writeFileSync(join(wt, 'a.txt'), 'changed');
  const r = closePaths(main, [wt]);
  assert.equal(r.closed, 0); assert.equal(r.open, 1);
  assert.match(r.results[0].blockers.join(' '), /uncommitted/);
  assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'changed');
});

test('--snapshot preserves modified, staged and untracked files on a trio/wip ref, pushes it, and leaves the real branch alone', () => {
  const { main, bare } = project();
  const wt = addTree(main, 't1', 'trio/work');
  const tip = git(wt, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(wt, 'a.txt'), 'modified');                 // tracked change
  writeFileSync(join(wt, 'staged.txt'), 'staged'); git(wt, 'add', 'staged.txt');
  writeFileSync(join(wt, 'untracked.txt'), 'untracked');
  writeFileSync(join(wt, 'appsettings.Local.json'), '{"local":true}');  // ignored: not in the snapshot
  const r = closePaths(main, [wt], { snapshot: true, push: true });
  assert.equal(r.closed, 1, JSON.stringify(r));
  const ref = r.results[0].snapshotRef;
  assert.match(ref, /^trio\/wip-trio-work-\d{8}-[0-9a-f]{7}$/);
  assert.equal(git(main, 'show', `${ref}:a.txt`), 'modified');
  assert.equal(git(main, 'show', `${ref}:staged.txt`), 'staged');
  assert.equal(git(main, 'show', `${ref}:untracked.txt`), 'untracked');
  assert.equal(tryGit(main, 'show', `${ref}:appsettings.Local.json`), null, 'ignored files are not committed');
  assert.equal(remoteHas(bare, ref), true, 'snapshot pushed');
  assert.equal(git(main, 'rev-parse', 'trio/work').trim(), tip, 'the real branch did not move');
  assert.equal(existsSync(wt), false);
  // The ignored local-only file was archived, not lost.
  const archived = join(main, '.trioharness-direct', 'archive', 'trio-work', basename(wt), 'ignored-files', 'appsettings.Local.json');
  assert.equal(readFileSync(archived, 'utf8'), '{"local":true}');
});

test('a snapshot that would commit a secret is refused: no ref, worktree kept, the value never appears in the report', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/leaky');
  const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  writeFileSync(join(wt, 'config.js'), `const k = "${secret}";\n`);
  writeFileSync(join(wt, '.env'), 'X=1\n');
  const r = closePaths(main, [wt], { snapshot: true, push: true });
  assert.equal(r.closed, 0);
  assert.match(r.results[0].blockers.join(' '), /snapshot refused/);
  assert.equal(JSON.stringify(r).includes(secret), false);
  assert.equal(existsSync(wt), true);
  assert.equal(listBranches(main).some(b => b.startsWith('trio/wip-')), false);
});
const listBranches = main => git(main, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean);

test('a file over the size cap refuses the snapshot', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/big');
  writeFileSync(join(wt, 'dump.bin'), Buffer.alloc(21 * 1024 * 1024, 1));
  const r = closePaths(main, [wt], { snapshot: true, push: true });
  assert.equal(r.open, 1);
  assert.match(r.results[0].blockers.join(' '), /file-over-20MB/);
});

test('unpushed commits on a task branch need --push; with it they are pushed and the tree is removed', () => {
  const { main, bare } = project();
  const wt = addTree(main, 't1', 'trio/ahead');
  commitFile(wt, 'b.txt', 'b');
  let r = closePaths(main, [wt]);
  assert.equal(r.open, 1); assert.match(r.results[0].blockers.join(' '), /--push/);
  assert.equal(remoteHas(bare, 'trio/ahead'), false);
  r = closePaths(main, [wt], { push: true });
  assert.equal(r.closed, 1, JSON.stringify(r));
  assert.equal(remoteHas(bare, 'trio/ahead'), true);
  assert.equal(existsSync(wt), false);
});

test('unpushed commits on a branch the harness may not push are a blocker unless --local-ok; the branch is never pushed or deleted', () => {
  const { main, bare } = project();
  const wt = addTree(main, 't1', 'feature/mine');
  commitFile(wt, 'b.txt', 'b');
  let r = closePaths(main, [wt], { push: true });
  assert.equal(r.open, 1, 'push does not apply to non-task branches');
  assert.match(r.results[0].blockers.join(' '), /may not push/);
  r = closePaths(main, [wt], { push: true, localOk: true });
  assert.equal(r.closed, 1);
  assert.equal(remoteHas(bare, 'feature/mine'), false, 'never pushed');
  assert.ok(tryGit(main, 'rev-parse', '--verify', 'feature/mine'), 'branch kept');
});

test('a detached HEAD with commits that are not on the remote is pinned on a trio/wip ref before removal', () => {
  const { main, bare } = project();
  const wt = addTree(main, 'rev1', null);
  commitFile(wt, 'r.txt', 'review notes');
  const sha = git(wt, 'rev-parse', 'HEAD').trim();
  const r = closePaths(main, [wt], { push: true });
  assert.equal(r.closed, 1, JSON.stringify(r));
  const pin = r.results[0].pinRef;
  assert.match(pin, /^trio\/wip-rev1-/);
  assert.equal(git(main, 'rev-parse', pin).trim(), sha);
  assert.equal(remoteHas(bare, pin), true);
});

test('local-only ignored files are archived with identical bytes; build output is ignored; over the cap keeps the tree', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/ign');
  writeFileSync(join(wt, 'appsettings.Local.json'), 'conn=local');
  mkdirSync(join(wt, 'bin')); writeFileSync(join(wt, 'bin', 'x.dll'), 'bin');
  let r = closePaths(main, [wt]);
  assert.equal(r.closed, 1, JSON.stringify(r));
  const dest = join(main, '.trioharness-direct', 'archive', 'trio-ign', basename(wt), 'ignored-files');
  assert.equal(readFileSync(join(dest, 'appsettings.Local.json'), 'utf8'), 'conn=local');
  assert.equal(existsSync(join(dest, 'bin')), false, 'build output is not archived');
  const wt2 = addTree(main, 't2', 'trio/ign2');
  writeFileSync(join(wt2, 'appsettings.Local.json'), Buffer.alloc(51 * 1024 * 1024, 7));
  r = closePaths(main, [wt2]);
  assert.equal(r.open, 1); assert.match(r.results[0].blockers.join(' '), /over the 50 MB cap/);
  assert.equal(existsSync(wt2), true);
});

test('run ledgers inside a closed worktree are archived first', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/led');
  const run = join(wt, '.trioharness-direct', 'runs', 'r-old'); mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'ledger.md'), '# ledger'); writeFileSync(join(run, 'state.json'), JSON.stringify({ finished: true, gates: {} }));
  const r = closePaths(main, [wt]);
  assert.equal(r.closed, 1);
  assert.equal(readFileSync(join(main, '.trioharness-direct', 'archive', 'trio__led', 'r-old', 'ledger.md'), 'utf8'), '# ledger');
});

test('a held run-lock skips the tree; the current directory inside a tree skips it; the main checkout is never selected', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/busy');
  const held = tryAcquire(lockNameFor(wt), { note: 'build' });
  try {
    const r = closePaths(main, [wt]);
    assert.equal(r.results[0].status, 'skipped'); assert.match(r.results[0].blockers[0], /run-lock is held/);
    assert.equal(existsSync(wt), true);
  } finally { release(held.file); }
  const cwd = process.cwd();
  process.chdir(wt);
  try {
    const r = closePaths(main, [wt]);
    assert.equal(r.results[0].status, 'skipped'); assert.match(r.results[0].blockers[0], /current directory/);
  } finally { process.chdir(cwd); }
  assert.equal(closePaths(main, [main]).results.length, 0, 'main is not a linked worktree');
  assert.equal(decide({ isMain: true }).verdict, 'skip');
});

test('a worktree whose folder is already gone is pruned', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/gone');
  execFileSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(wt)}, { recursive: true, force: true })`]);
  const r = closePaths(main, [wt]);
  assert.equal(r.closed, 1);
  assert.equal(listWorktrees(main).length, 1);
});

test('run scope: only registered trees are touched; closeout is recorded; the run cannot finish while a tree is open', () => {
  const { main } = project();
  const a = addTree(main, 'a', 'trio/r1-a'), b = addTree(main, 'b', 'trio/r1-b'), other = addTree(main, 'other', 'trio/other-run');
  const closedDetails = [a, b].map(path => ({ path: realpathSync(path), branch: treeAt(main, path).branch, head: git(path, 'rev-parse', 'HEAD').trim(), status: 'closed' }));
  for (const { branch } of closedDetails) git(main, 'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
  registerWorktree(main, 'r1', { path: a, branch: 'trio/r1-a' }); registerWorktree(main, 'r1', { path: b, branch: 'trio/r1-b', role: 'slice' });
  writeFileSync(join(b, 'a.txt'), 'dirty');
  let r = closeAll({ repo: main, run: 'r1', flags: {}, apply: true });
  assert.equal(r.closed, 1); assert.equal(r.open, 1);
  assert.equal(existsSync(a), false); assert.equal(existsSync(b), true); assert.equal(existsSync(other), true, 'an unregistered tree is never touched');
  assert.equal(readState(main, 'r1').closeout.open, 1);
  assert.equal(r.results.find(r => normPath(r.path) === normPath(a)).head, closedDetails[0].head);
  assert.equal(readState(main, 'r1').closeout.details.find(d => typeof d.path === 'string' && normPath(d.path) === normPath(a))?.head, closedDetails[0].head);
  assert.equal(readState(main, 'r1').gates.closeout.status, 'blocked');
  setGate(main, 'r1', { gate: 'done-jev', status: 'passed' });
  const fin = spawnSync(process.execPath, [RUNSTATE, 'finish', '--repo', main, '--run', 'r1'], { encoding: 'utf8' });
  assert.notEqual(fin.status, 0); assert.match(fin.stderr, /RUN_HAS_OPEN_WORKTREES/);
  setGate(main, 'r1', { gate: 'learnings', status: 'passed' });
  assert.notEqual(readState(main, 'r1').finished, true, 'learnings cannot finish a run with an open tree');
  git(b, 'checkout', '--', 'a.txt');
  r = closeAll({ repo: main, run: 'r1', flags: {}, apply: true });
  assert.equal(r.open, 0); assert.equal(readState(main, 'r1').gates.closeout.status, 'passed');
  assert.equal(existsSync(b), false);
  for (const expected of closedDetails) {
    const actual = readState(main, 'r1').closeout.details.find(d => normPath(d.path) === normPath(expected.path));
    for (const key of ['path', 'branch', 'head', 'status']) assert.equal(actual?.[key], expected[key]);
  }
  closeAll({ repo: main, run: 'r1', apply: true });
  assert.equal(readState(main, 'r1').closeout.details.filter(d => d.status === 'closed').length, 2);
  // 2.31: with the trees closed, finishing also needs the clean end state (nothing uncommitted, unpushed or unmerged)
  const fin1 = spawnSync(process.execPath, [RUNSTATE, 'finish', '--repo', main, '--run', 'r1'], { encoding: 'utf8' });
  assert.notEqual(fin1.status, 0); assert.match(fin1.stderr, /CLEAN_STATE_NOT_REACHED/);
  recordCleanState(main, 'r1', { run: 'r1', at: new Date(Date.now() + 5000).toISOString(), ok: true, verdict: 'clean', blockers: [], warnings: [], branches: [], awaitingApproval: [] });
  const fin2 = spawnSync(process.execPath, [RUNSTATE, 'finish', '--repo', main, '--run', 'r1'], { encoding: 'utf8' });
  assert.equal(fin2.status, 0, fin2.stderr);
});

test('a run with registered worktrees and no closeout is not finished by the learnings gate', () => {
  const { main } = project();
  const a = addTree(main, 'a', 'trio/x');
  registerWorktree(main, 'r2', { path: a, branch: 'trio/x' });
  setGate(main, 'r2', { gate: 'done-jev', status: 'passed' });
  const s = setGate(main, 'r2', { gate: 'learnings', status: 'passed' });
  assert.notEqual(s.finished, true); assert.match(s.notFinishedBecause, /closeout has not run/);
});

test('an unknown run and a ledger inside a tree being closed are refused before anything is touched', () => {
  const { main } = project();
  const a = addTree(main, 'a', 'trio/led2');
  assert.throws(() => closeAll({ repo: main, run: 'nope', flags: {}, apply: true }), /CLOSEOUT_RUN_UNKNOWN/);
  registerWorktree(a, 'r3', { path: a, branch: 'trio/led2' });
  assert.throws(() => closeAll({ repo: main, run: 'r3', ledger: a, flags: {}, apply: true }), /CLOSEOUT_LEDGER_INSIDE_TREE/);
  assert.equal(existsSync(a), true);
});

test('stale scope closes only idle harness-made trees, never the user’s own worktrees', () => {
  const { main } = project();
  const mine = join(`${main}-user`, 'mine'); mkdirSync(dirname(mine), { recursive: true });
  git(main, 'worktree', 'add', '--quiet', '-b', 'feature/mine', mine, 'HEAD');
  const h1 = addTree(main, 'h1', 'trio/old-1'), h2 = addTree(main, 'h2', null);
  assert.equal(isHarnessTree({ path: mine, branch: 'feature/mine' }), false);
  const later = new Date(Date.now() + 3 * 3600 * 1000); // past the 2-hour quiet window
  const r = closeAll({ repo: main, scope: 'stale', flags: {}, apply: true, now: later });
  assert.equal(r.closed, 2, JSON.stringify(r));
  assert.equal(existsSync(h1), false); assert.equal(existsSync(h2), false); assert.equal(existsSync(mine), true);
});

test('stale scope never touches a user tree that merely sits on a bambooed/* branch, nor a harness tree touched in the last 2 hours', () => {
  const { main } = project();
  const mine = join(`${main}-user`, 'review'); mkdirSync(dirname(mine), { recursive: true });
  git(main, 'worktree', 'add', '--quiet', '-b', 'bambooed/run-A', mine, 'HEAD');
  writeFileSync(join(mine, 'notes.md'), 'private');
  const fresh = addTree(main, 'fresh', 'trio/fresh');
  const later = new Date(Date.now() + 3 * 3600 * 1000);
  let r = closeAll({ repo: main, scope: 'stale', flags: {}, apply: true, now: later });
  assert.equal(existsSync(mine), true, 'unregistered tree outside a harness root is the user’s'); assert.equal(existsSync(join(mine, 'notes.md')), true);
  assert.equal(existsSync(fresh), false, 'a harness tree quiet for 2h is closed');
  const recent = addTree(main, 'recent', 'trio/recent');
  r = closeAll({ repo: main, scope: 'stale', flags: {}, apply: true });
  assert.equal(existsSync(recent), true, 'a tree touched just now is left alone'); assert.equal(r.closed, 0);
  // registered by a run => the harness's own, wherever it lives
  registerWorktree(main, 'done-run', { path: mine, branch: 'bambooed/run-A' });
  setGate(main, 'done-run', { gate: 'done-jev', status: 'passed' });
  { const f = join(main, '.trioharness-direct', 'runs', 'done-run', 'state.json'); const st = JSON.parse(readFileSync(f, 'utf8')); st.finished = true; writeFileSync(f, JSON.stringify(st)); } // a finished run's tree
  r = closeAll({ repo: main, scope: 'stale', flags: {}, apply: false, now: later });
  assert.ok(r.results.some(x => x.path && normPath(x.path) === normPath(mine)), 'a run-registered tree is eligible');
});

test('audit reports every state, flags the over-limit case, and finds repositories under a root without counting linked worktrees', () => {
  const { main } = project();
  const t1 = addTree(main, 't1', 'trio/a1'), t2 = addTree(main, 't2', 'trio/a2'), t3 = addTree(main, 't3', 'trio/a3');
  writeFileSync(join(t2, 'x.txt'), 'd'); commitFile(t3, 'y.txt', 'y');
  const rep = auditRepo(main, { maxOpen: 2 });
  const states = Object.fromEntries(rep.worktrees.map(w => [w.leaf, w.state]));
  assert.deepEqual(states, { t1: 'clean', t2: 'dirty', t3: 'unpushed' });
  assert.equal(rep.overLimit, true); assert.equal(rep.problems, 2);
  assert.deepEqual(findRepos(dirname(main)).filter(p => p === main), [main]);
  assert.equal(findRepos(dirname(main)).some(p => p.includes('.trioharness')), false);
  const cli = spawnSync(process.execPath, [CLOSEOUT, 'audit', '--repo', main, '--strict'], { encoding: 'utf8' });
  assert.equal(cli.status, 2); assert.match(cli.stdout, /dirty\s+t2/);
  assert.equal(inspectWorktree({ path: t1, branch: 'trio/a1' }).state, 'clean');
});

// Attribution must come from registrations, never a matching branch name.
test('audit attributes this run, other runs, unregistered harness trees and unattributed trees', () => {
  const { main } = project();
  const own = addTree(main, 'own', 'trio/current'), other = addTree(main, 'other', 'trio/other');
  const orphan = addTree(main, 'orphan', null);
  const foreign = join(`${main}-user`, 'current'); mkdirSync(dirname(foreign), { recursive: true });
  git(main, 'worktree', 'add', '--quiet', '-b', 'bambooed/current', foreign, 'HEAD');
  registerWorktree(main, 'current', { path: own, branch: 'trio/current' });
  registerWorktree(main, 'previous', { path: other, branch: 'trio/other' });
  const stateFile = join(main, '.trioharness-direct', 'runs', 'previous', 'state.json');
  const st = JSON.parse(readFileSync(stateFile, 'utf8')); st.finished = true; writeFileSync(stateFile, JSON.stringify(st));
  const rows = auditRepo(main, { run: 'current', now: Date.now() + 3 * 3600 * 1000 }).worktrees;
  const row = path => rows.find(w => normPath(w.path) === normPath(path));
  assert.equal(row(own).owner, 'this-run'); assert.equal(row(own).status, 'active'); assert.equal(row(own).staleEligible, false);
  assert.equal(row(other).owner, 'other-run:previous'); assert.equal(row(other).status, 'finished'); assert.equal(row(other).staleEligible, true);
  assert.equal(row(orphan).owner, 'harness-unregistered'); assert.equal(row(orphan).status, 'unknown'); assert.equal(row(orphan).staleEligible, true);
  assert.equal(row(foreign).owner, 'unattributed'); assert.equal(row(foreign).status, 'unknown'); assert.equal(row(foreign).staleEligible, false);
  assert.ok(rows.every(w => typeof w.staleReason === 'string' && w.staleReason.length));
  assert.equal(auditRepo(main).worktrees.find(w => w.leaf === 'own').owner, 'other-run:current', 'this-run requires explicit run identity');
  const cli = spawnSync(process.execPath, [CLOSEOUT, 'audit', '--repo', main, '--run', 'current', '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout)[0].worktrees.find(w => w.leaf === 'own').owner, 'this-run');
});

test('audit stale eligibility shares the quiet and idle selection checks', () => {
  const { main } = project();
  const fresh = addTree(main, 'fresh', 'trio/fresh'), busy = addTree(main, 'busy', 'trio/busy');
  registerWorktree(busy, 'local-active', { path: busy, branch: 'trio/busy' });
  let rows = auditRepo(main).worktrees;
  assert.equal(rows.find(w => w.leaf === 'fresh').staleEligible, false);
  assert.match(rows.find(w => w.leaf === 'fresh').staleReason, /quiet|recent/i);
  rows = auditRepo(main, { now: Date.now() + 3 * 3600 * 1000 }).worktrees;
  assert.equal(rows.find(w => w.leaf === 'fresh').staleEligible, true);
  assert.equal(rows.find(w => w.leaf === 'busy').staleEligible, false);
  assert.match(rows.find(w => w.leaf === 'busy').staleReason, /idle|active/i);
  assert.equal(existsSync(fresh), true, 'audit never closes candidates');
});

test('audit treats multiple registrations as unattributed and unknown, never stale eligible', () => {
  const { main } = project();
  const wt = addTree(main, 'shared', 'trio/shared');
  for (const id of ['one', 'two']) {
    registerWorktree(main, id, { path: wt, branch: 'trio/shared' });
    const f = join(main, '.trioharness-direct', 'runs', id, 'state.json');
    const st = JSON.parse(readFileSync(f, 'utf8')); st.finished = true; writeFileSync(f, JSON.stringify(st));
  }
  const rep = auditRepo(main, { run: 'one', maxOpen: 0, now: Date.now() + 3 * 3600 * 1000 });
  assert.equal(rep.openCount, 1); assert.equal(rep.overLimit, true);
  assert.equal(rep.worktrees[0].owner, 'unattributed'); assert.equal(rep.worktrees[0].status, 'unknown');
  assert.equal(rep.worktrees[0].staleEligible, false); assert.match(rep.worktrees[0].staleReason, /multiple/i);
});

test('audit fails closed on unreadable registration state without losing the total count', () => {
  const { main } = project();
  const wt = addTree(main, 'registered', 'trio/registered'), orphan = addTree(main, 'orphan', null);
  registerWorktree(main, 'known', { path: wt, branch: 'trio/registered' });
  const bad = join(main, '.trioharness-direct', 'runs', 'broken'); mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, 'state.json'), '{invalid');
  const rep = auditRepo(main, { run: 'known', maxOpen: 1, now: Date.now() + 3 * 3600 * 1000 });
  assert.equal(rep.openCount, 2); assert.equal(rep.overLimit, true);
  for (const w of rep.worktrees) {
    assert.equal(w.owner, 'unattributed'); assert.equal(w.status, 'unknown'); assert.equal(w.staleEligible, false);
    assert.match(w.staleReason, /unreadable|unknown/i);
  }
  assert.equal(existsSync(wt), true); assert.equal(existsSync(orphan), true);
});

test('OVER LIMIT text lists only stale-eligible candidates and requires an owner card', () => {
  const { main } = project();
  const candidate = addTree(main, 'old-candidate', null), recent = addTree(main, 'recent', 'trio/recent');
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  const gd = resolve(candidate, git(candidate, 'rev-parse', '--git-dir').trim());
  for (const p of [join(candidate, 'a.txt'), join(candidate, '.gitignore'), join(gd, 'HEAD'), join(gd, 'logs', 'HEAD')]) utimesSync(p, old, old);
  const args = [CLOSEOUT, 'audit', '--repo', main, '--max-open', '1', '--min-free-gb', '0', '--strict'];
  const cli = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(cli.status, 2, cli.stderr); assert.match(cli.stdout, /OVER LIMIT/);
  assert.match(cli.stdout, /owner=harness-unregistered.*status=unknown.*stale-eligible=yes/i);
  assert.match(cli.stdout, /stale-eligible=no/i);
  const guidance = cli.stdout.split('\n').find(l => /candidates:/i.test(l));
  assert.ok(guidance, cli.stdout); assert.ok(guidance.includes(candidate), guidance); assert.equal(guidance.includes(recent), false);
  assert.match(guidance, /owner card/i); assert.match(guidance, /audit never closes/i);
  assert.equal(existsSync(candidate), true); assert.equal(existsSync(recent), true);
  const none = spawnSync(process.execPath, [CLOSEOUT, 'audit', '--repo', main, '--max-open', '0'], { encoding: 'utf8' });
  assert.equal(none.status, 0, none.stderr);
});

test('CLI: dry run by default, --apply closes; pushable names are exactly bambooed/* and trio/*', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/cli');
  let r = spawnSync(process.execPath, [CLOSEOUT, 'close', '--repo', main, '--path', wt], { encoding: 'utf8', cwd: main });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /dry run/); assert.equal(existsSync(wt), true);
  r = spawnSync(process.execPath, [CLOSEOUT, 'close', '--repo', main, '--path', wt, '--apply'], { encoding: 'utf8', cwd: main });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /CLOSED/); assert.equal(existsSync(wt), false);
  for (const n of ['bambooed/x', 'trio/x', 'trio/wip-y']) assert.equal(PUSHABLE.test(n), true, n);
  for (const n of ['main', 'feature/x', 'trioharness-v2/x', 'archive/trio/x', 'xtrio/y']) assert.equal(PUSHABLE.test(n), false, n);
});

test('closeout never deletes a branch, a tag or a stash', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/keepme');
  git(main, 'tag', 'v1');
  writeFileSync(join(main, 'stash.txt'), 's'); git(main, 'add', 'stash.txt'); git(main, 'stash', 'push', '--quiet', '-m', 'keep');
  const before = { branches: listBranches(main), tags: git(main, 'tag'), stash: git(main, 'stash', 'list') };
  closePaths(main, [wt]);
  assert.deepEqual(listBranches(main), before.branches); assert.equal(git(main, 'tag'), before.tags); assert.equal(git(main, 'stash', 'list'), before.stash);
});

// ---- regressions from the adversarial review ----
const gitCfg = (dir, k, v) => git(dir, 'config', k, v);

test('untracked files are never lost when status.showUntrackedFiles=no', () => {
  const { main } = project(); gitCfg(main, 'status.showUntrackedFiles', 'no');
  const wt = addTree(main, 't1', 'trio/hidden');
  mkdirSync(join(wt, 'src')); writeFileSync(join(wt, 'src', 'NewFeature.cs'), 'class A {}');
  let r = closePaths(main, [wt]);
  assert.equal(r.open, 1); assert.equal(existsSync(join(wt, 'src', 'NewFeature.cs')), true);
  r = closePaths(main, [wt], { snapshot: true, push: true });
  assert.equal(git(main, 'show', `${r.results[0].snapshotRef}:src/NewFeature.cs`), 'class A {}');
});

test('a nested repository inside a worktree blocks the snapshot and is never deleted', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/nested');
  const lib = join(wt, 'vendor', 'lib'); mkdirSync(lib, { recursive: true });
  git(lib, 'init', '--quiet'); git(lib, 'config', 'user.email', 'a@b.c'); git(lib, 'config', 'user.name', 'n'); commitFile(lib, 'lib.js', 'x'); writeFileSync(join(lib, 'wip.js'), 'unsaved');
  const r = closePaths(main, [wt], { snapshot: true, push: true });
  assert.equal(r.open, 1); assert.match(r.results[0].blockers.join(' '), /nested-repo/);
  assert.equal(existsSync(join(lib, 'wip.js')), true);
});

test('stale scope leaves trees registered to an unfinished run alone', () => {
  const { main } = project();
  const busy = addTree(main, 'busy', 'trio/active'), idle = addTree(main, 'idle', 'trio/old');
  registerWorktree(main, 'live-run', { path: busy, branch: 'trio/active' });
  const r = closeAll({ repo: main, scope: 'stale', flags: {}, apply: true, now: new Date(Date.now() + 3 * 3600 * 1000) });
  assert.equal(existsSync(busy), true); assert.equal(existsSync(idle), false); assert.equal(r.closed, 1);
});

test('closing one tree by --path never records the run closeout as passed', () => {
  const { main } = project();
  const w = addTree(main, 'w', 'trio/writer'), rv = addTree(main, 'rv', 'trio/review');
  registerWorktree(main, 'r9', { path: w, branch: 'trio/writer' }); registerWorktree(main, 'r9', { path: rv, branch: 'trio/review', role: 'reviewer' });
  closeAll({ repo: main, run: 'r9', paths: [rv], flags: {}, apply: true });
  assert.equal(existsSync(rv), false); assert.equal(existsSync(w), true);
  assert.notEqual(readState(main, 'r9').gates?.closeout?.status, 'passed');
});

test('a registered tree that belongs to another repository counts as open', () => {
  const a = project(), b = project();
  const wa = addTree(a.main, 'a', 'trio/a'), wb = addTree(b.main, 'b', 'trio/b');
  registerWorktree(a.main, 'x1', { path: wa, branch: 'trio/a' }); registerWorktree(a.main, 'x1', { path: wb, branch: 'trio/b' });
  const r = closeAll({ repo: a.main, run: 'x1', flags: {}, apply: true });
  assert.equal(r.closed, 1); assert.equal(r.open, 1); assert.equal(existsSync(wb), true);
  assert.equal(readState(a.main, 'x1').gates.closeout.status, 'blocked');
});

test('secrets are found in UTF-16, NUL-bearing and -diff files, and quoted non-ASCII paths; the value is never reported', () => {
  const { main } = project();
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const cases = {
    utf16: () => Buffer.from(`﻿$k = "${key}"\n`, 'utf16le'),
    nul: () => Buffer.concat([Buffer.from([0, 0, 0]), Buffer.from(`k=${key}\n`)]),
  };
  for (const [name, mk] of Object.entries(cases)) {
    const wt = addTree(main, `${name}-case`, `trio/s-${name}`); // never a bare device name ("nul" is reserved on Windows)
    writeFileSync(join(wt, 'cfg.ps1'), mk());
    const r = closePaths(main, [wt], { snapshot: true, push: true });
    assert.equal(r.open, 1, name); assert.match(r.results[0].blockers.join(' '), /secret-pattern/); assert.equal(JSON.stringify(r).includes(key), false);
  }
  const wt = addTree(main, 'nonascii', 'trio/s-uml');
  mkdirSync(join(wt, 'Entwürfe')); writeFileSync(join(wt, 'Entwürfe', '.env'), 'A=1\n');
  assert.match(closePaths(main, [wt], { snapshot: true, push: true }).results[0].blockers.join(' '), /file:/);
});

test('data dumps are refused; the harness folder never enters a snapshot even when it is not excluded', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/data');
  writeFileSync(join(wt, 'customers.csv'), 'name,phone\nA,1\n');
  assert.match(closePaths(main, [wt], { snapshot: true, push: true }).results[0].blockers.join(' '), /data-file/);
  const wt2 = addTree(main, 't2', 'trio/led3');
  mkdirSync(join(wt2, '.trioharness-direct', 'runs', 'r'), { recursive: true }); writeFileSync(join(wt2, '.trioharness-direct', 'runs', 'r', 'ledger.md'), 'ledger');
  writeFileSync(join(wt2, 'n.txt'), 'n');
  rmSync(join(main, '.git', 'info', 'exclude'), { force: true });
  const r = closePaths(main, [wt2], { snapshot: true, push: true });
  assert.equal(r.closed, 1, JSON.stringify(r));
  assert.equal(tryGit(main, 'ls-tree', '-r', '--name-only', r.results[0].snapshotRef).includes('.trioharness-direct'), false);
});

test('a snapshot over the total size cap is refused', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/total');
  for (let i = 0; i < 3; i++) writeFileSync(join(wt, `f${i}.txt`), Buffer.alloc(19 * 1024 * 1024, 65 + i));
  assert.match(closePaths(main, [wt], { snapshot: true, push: true }).results[0].blockers.join(' '), /snapshot-over-50MB/);
});

test('a rebase, merge or cherry-pick in progress blocks the close', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/mid');
  writeFileSync(join(resolve(wt, git(wt, 'rev-parse', '--git-dir').trim()), 'MERGE_HEAD'), git(wt, 'rev-parse', 'HEAD'));
  const r = closePaths(main, [wt], { snapshot: true, push: true });
  assert.equal(r.open, 1); assert.match(r.results[0].blockers.join(' '), /merge is in progress/);
});

test('a commit that only a stale remote-tracking ref holds is not treated as on the remote', () => {
  const { main, bare } = project();
  const wt = addTree(main, 'rev', null);
  commitFile(wt, 'r.txt', 'r');
  const sha = git(wt, 'rev-parse', 'HEAD').trim();
  git(main, 'push', '--quiet', 'origin', `${sha}:refs/heads/trio/gone`);
  git(main, 'fetch', '--quiet', 'origin');
  execFileSync('git', ['-C', bare, 'update-ref', '-d', 'refs/heads/trio/gone']);
  assert.ok(git(main, 'branch', '-r', '--contains', sha).includes('trio/gone'), 'stale tracking ref still present');
  const r = closePaths(main, [wt], { push: true });
  assert.ok(r.results[0].pinRef, 'pinned because the live remote no longer has it');
});

test('edits made after the snapshot stop the removal', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/race');
  writeFileSync(join(wt, 'a.txt'), 'v1');
  mkdirSync(join(main, '.git', 'hooks'), { recursive: true });
  const hook = join(main, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, `#!/bin/sh\necho late >> "${wt}/late.txt"\n`, { mode: 0o755 });
  const r = closePaths(main, [wt], { snapshot: true, push: true });
  assert.equal(r.open, 1); assert.match(r.results[0].blockers.join(' '), /changed while closing/);
  assert.equal(existsSync(join(wt, 'late.txt')), true);
});

test('run files that cannot be archived safely keep the tree', () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/arch');
  const w = join(wt, '.trioharness-direct', 'runs', 'r1', 'workers'); mkdirSync(w, { recursive: true });
  writeFileSync(join(wt, '.trioharness-direct', 'runs', 'r1', 'ledger.md'), 'l');
  writeFileSync(join(w, 'writer.md'), `token ${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`);
  const r = closePaths(main, [wt]);
  assert.equal(r.open, 1); assert.match(r.results[0].blockers.join(' '), /cannot be archived safely/);
  assert.equal(existsSync(wt), true);
});

test('a symlink among local-only ignored files is archived as a link, not dropped', { skip: SYMLINK_SKIP }, () => {
  const { main } = project();
  const wt = addTree(main, 't1', 'trio/link');
  execFileSync(process.execPath, ['-e', `require('fs').symlinkSync('/nonexistent-target-for-test', ${JSON.stringify(join(wt, 'appsettings.Local.json'))})`]);
  const r = closePaths(main, [wt]);
  assert.equal(r.closed, 1, JSON.stringify(r));
  assert.match(r.results[0].done.join(' '), /archived 1 /);
  const dest = join(main, '.trioharness-direct', 'archive', 'trio-link', basename(wt), 'ignored-files', 'appsettings.Local.json');
  assert.equal(execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readlinkSync(${JSON.stringify(dest)}))`], { encoding: 'utf8' }), '/nonexistent-target-for-test');
});

test('a worktree that is not a harness tree is not stale just because it once held a run folder', () => {
  const { main } = project();
  const mine = join(`${main}-user2`, 'mine'); mkdirSync(dirname(mine), { recursive: true });
  git(main, 'worktree', 'add', '--quiet', '-b', 'feature/own', mine, 'HEAD');
  mkdirSync(join(mine, '.trioharness-direct'));
  assert.equal(isHarnessTree({ path: mine, branch: 'feature/own' }), false);
});

test('audit: the harness run folder alone does not make a tree dirty, but real untracked files still do', () => {
  const { main } = project();
  const wt = addTree(main, 'harness-only', 'trio/harness-only');
  mkdirSync(join(wt, '.trioharness-direct', 'runs', 'r1'), { recursive: true });
  writeFileSync(join(wt, '.trioharness-direct', 'runs', 'r1', 'ledger.md'), 'x');
  writeFileSync(join(wt, '.trioharness-direct', 'note.txt'), 'y');
  const info = inspectWorktree(treeAt(main, wt));
  assert.equal(info.dirty, 0); assert.equal(info.state, 'clean');
  writeFileSync(join(wt, 'real-work.txt'), 'mine');
  const again = inspectWorktree(treeAt(main, wt));
  assert.equal(again.dirty, 1); assert.equal(again.state, 'dirty');
});

test('OS litter (.DS_Store, Thumbs.db) neither dirties a tree nor enters a snapshot; real files and tracked litter still count', () => {
  const { main } = project();
  const wt = addTree(main, 'junk', 'trio/junk');
  writeFileSync(join(wt, '.DS_Store'), 'x'); mkdirSync(join(wt, 'sub')); writeFileSync(join(wt, 'sub', 'Thumbs.db'), 'x');
  let info = inspectWorktree(treeAt(main, wt));
  assert.equal(info.dirty, 0); assert.equal(info.state, 'clean');
  writeFileSync(join(wt, 'real.txt'), 'mine');
  info = inspectWorktree(treeAt(main, wt));
  assert.equal(info.dirty, 1); assert.equal(info.state, 'dirty');
  const files = git(wt, 'ls-tree', '-r', '--name-only', currentTree(wt)).split('\n').filter(Boolean);
  assert.ok(files.includes('real.txt'));
  assert.ok(!files.some(f => /DS_Store|Thumbs\.db/.test(f)), `snapshot leaked litter: ${files}`);
  // a repository that really tracks such a file keeps it: edits to it are work
  commitFile(wt, 'keep/.DS_Store', 'v1', 'track it');
  writeFileSync(join(wt, 'keep', '.DS_Store'), 'v2');
  assert.ok(git(wt, 'ls-tree', '-r', '--name-only', currentTree(wt)).includes('keep/.DS_Store'));
  assert.equal(inspectWorktree(treeAt(main, wt)).trackedChanges, 1);
});

test('closing a tree whose only untracked files are OS litter works (litter is dropped, never a tracked file)', () => {
  const { main } = project();
  const wt = addTree(main, 'litter-close', 'trio/litter-close');
  git(wt, 'push', '--quiet', '-u', 'origin', 'trio/litter-close');
  writeFileSync(join(wt, '.DS_Store'), 'x'); mkdirSync(join(wt, 'd')); writeFileSync(join(wt, 'd', 'Thumbs.db'), 'x');
  const r = closeAll({ repo: main, paths: [wt], flags: { snapshot: true, push: true }, apply: true });
  assert.equal(r.results[0].status, 'closed', JSON.stringify(r.results[0]));
  assert.ok(!existsSync(wt));
});

test('audit skips a folder that is not a git repository instead of failing (a harness folder without git)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thl-nogit-')); mkdirSync(join(dir, '.trioharness-direct'));
  const r = spawnSync(process.execPath, [CLOSEOUT, 'audit', '--repo', dir, '--strict', '--min-free-gb', '0'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /not a git repository: skipped/);
  rmSync(dir, { recursive: true, force: true });
});

test('audit still reports a damaged repository (a .git that git cannot read) instead of skipping it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thl-badgit-')); mkdirSync(join(dir, '.git'));
  const r = spawnSync(process.execPath, [CLOSEOUT, 'audit', '--repo', dir, '--strict', '--min-free-gb', '0'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout, /ERROR/);
  rmSync(dir, { recursive: true, force: true });
});


test('v3 pin: closeout refuses a dirty credential source even with a name row', () => {
  const { main } = project();
  commitFile(main, '.trioharness/secret-allow.txt', 'src/credentials.rs name # reviewed\n');
  const wt = addTree(main, 'name-pin', 'trio/name-pin');
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(join(wt, 'src/credentials.rs'), 'pub fn credentials() {}\n');
  const result = snapshotDirty(wt, { branch: 'trio/name-pin' });
  assert.ok(result.refused.some(v => v.file === 'src/credentials.rs' && v.rule === 'file:credentials'), JSON.stringify(result));
  assert.equal(result.ref, undefined);
});


test('R2 stateless run folders leave stale close and audit attribution unchanged', () => {
  const { main } = project();
  const wt = addTree(main, 'stale-with-probe', 'trio/stale-with-probe');
  const now = Date.now() + 3 * 3600 * 1000;
  const before = auditRepo(main, { now }).worktrees;
  mkdirSync(join(main, '.trioharness-direct/runs/probe'), { recursive: true });
  assert.deepEqual(auditRepo(main, { now }).worktrees, before);
  // A stopped selection may leave audit artifacts without any checkpoint.
  writeFileSync(join(main, '.trioharness-direct/runs/probe/run-mode.json'), JSON.stringify({ run: 'probe', mode: 'audit' }));
  assert.deepEqual(auditRepo(main, { now }).worktrees, before);
  const result = closeAll({ repo: main, scope: 'stale', flags: {}, apply: true, now });
  assert.equal(result.closed, 1, JSON.stringify(result));
  assert.equal(existsSync(wt), false);
});


test('R2 an existing non-object state stays fail-closed instead of being skipped as stateless', () => {
  const { main } = project(); addTree(main, 'null-state', 'trio/null-state');
  const dir = join(main, '.trioharness-direct/runs/null-state'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), 'null');
  const now = Date.now() + 3 * 3600 * 1000;
  const rows = auditRepo(main, { now }).worktrees;
  assert.equal(rows[0].owner, 'unattributed'); assert.equal(rows[0].staleEligible, false);
  assert.throws(() => closeAll({ repo: main, scope: 'stale', flags: {}, apply: true, now }), /CLOSEOUT_STATE_UNREADABLE/);
});


for (const otherFinished of [false, true]) test(`fix batch ownership: other run finished=${otherFinished}`, () => {
  const { main } = project(), wt = addTree(main, 'shared', 'trio/shared');
  registerWorktree(main, 'one', { path: wt });
  // Seed a shared registration created before duplicate admission was refused.
  const dir = join(main, '.trioharness-direct/runs/two');
  mkdirSync(dir);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...readState(main, 'one'), run: 'two', finished: otherFinished }));
  const r = closeAll({ repo: main, run: 'one', apply: true });
  assert.equal(r.closed, otherFinished ? 1 : 0); assert.equal(existsSync(wt), !otherFinished);
  if (!otherFinished) assert.match(r.results[0].blockers.join(' '), /ownership|registration/i);
});
test('HD-2 single-owner closeout ignores ordinary files beside run directories', () => {
  const { main } = project(), wt = addTree(main, 'single-owner', 'trio/single-owner');
  registerWorktree(main, 'one', { path: wt, branch: 'trio/single-owner' });
  for (const file of ['.DS_Store', '.current-x']) writeFileSync(join(main, '.trioharness-direct/runs', file), 'litter');
  const r = closeAll({ repo: main, run: 'one', apply: true });
  assert.equal(r.closed, 1, JSON.stringify(r));
  assert.equal(r.open, 0);
  assert.equal(existsSync(wt), false);
});
test('run closeout refuses unknown ownership from unreadable run state', () => {
  const { main } = project(), wt = addTree(main, 'unknown', 'trio/unknown');
  registerWorktree(main, 'one', { path: wt });
  const dir = join(main, '.trioharness-direct/runs/broken'); mkdirSync(dir);
  writeFileSync(join(dir, 'state.json'), '{bad json');
  const r = closeAll({ repo: main, run: 'one', apply: true });
  assert.equal(r.closed, 0); assert.equal(existsSync(wt), true);
  assert.match(r.results[0].blockers.join(' '), /unknown|unreadable/i);
});
for (const field of ['gate', 'state']) test(`run closeout preserves ${field} owner-hold before apply and recordCloseout`, () => {
  const { main } = project(), wt = addTree(main, 'held', 'trio/held');
  registerWorktree(main, 'one', { path: wt });
  const file = join(main, '.trioharness-direct/runs/one/state.json'), st = readState(main, 'one');
  const hold = { status: 'blocked', note: 'owner-hold: retain all trees, owner, 2026-11-16' };
  if (field === 'gate') st.gates.closeout = hold; else st.closeout = hold;
  writeFileSync(file, JSON.stringify(st));
  assert.throws(() => closeAll({ repo: main, run: 'one', apply: true }), /owner-hold/i);
  assert.equal(existsSync(wt), true);
  // Direct result recording must not clear a hold either.
  recordCloseout(main, 'one', { closed: 0, open: 0 });
  assert.deepEqual(field === 'gate' ? readState(main, 'one').gates.closeout : readState(main, 'one').closeout, hold);
});


for (const refusal of ['unknown', 'locked']) test(`fix batch missing detached HEAD stays referenced despite ${refusal} refusal`, () => {
  const { main } = project(), wt = addTree(main, 'detached-missing', null);
  commitFile(wt, 'local.txt', 'detached local work');
  const head = git(wt, 'rev-parse', 'HEAD').trim();
  registerWorktree(main, 'one', { path: wt });
  let lock;
  if (refusal === 'unknown') {
    const dir = join(main, '.trioharness-direct/runs/broken'); mkdirSync(dir);
    writeFileSync(join(dir, 'state.json'), '{bad json');
  } else { lock = tryAcquire(lockNameFor(wt)); assert.equal(lock.acquired, true); }
  rmSync(wt, { recursive: true, force: true });
  try {
    const r = closeAll({ repo: main, run: 'one', apply: true });
    assert.equal(r.closed, 0); assert.equal(r.open, 1);
    assert.match(git(main, 'for-each-ref', '--format=%(refname)', '--contains', head), /refs\/heads\/trio\/wip-/);
    assert.ok(git(main, 'cat-file', '-t', head).includes('commit'));
  } finally { if (lock?.acquired) release(lock.file); }
});


test('A2 recreated worktree supersedes its earlier closed identity before another close', () => {
  const { main } = project(), wt = addTree(main, 'recreated', 'trio/recreated');
  registerWorktree(main, 'r1', { path: wt, branch: 'trio/recreated' });
  git(main, 'push', 'origin', 'trio/recreated');
  assert.equal(closeAll({ repo: main, run: 'r1', apply: true }).closed, 1);
  assert.equal(readState(main, 'r1').closeout.details.find(d => typeof d.path === 'string' && normPath(d.path) === normPath(wt))?.status, 'closed');
  git(main, 'worktree', 'add', wt, 'trio/recreated'); writeFileSync(join(wt, 'a.txt'), 'new dirt');
  assert.equal(closeAll({ repo: main, run: 'r1', apply: true }).open, 1);
  assert.notEqual(readState(main, 'r1').closeout.details.find(d => typeof d.path === 'string' && normPath(d.path) === normPath(wt))?.status, 'closed');
});


test('A2 delta H1 path close merges identities without changing full-close counts or gate', () => {
  const { main } = project(), a = addTree(main, 'path-a', 'trio/path-a'), b = addTree(main, 'path-b', 'trio/path-b');
  for (const [path, branch] of [[a, 'trio/path-a'], [b, 'trio/path-b']]) { registerWorktree(main, 'r1', { path, branch }); git(path, 'push', 'origin', branch); writeFileSync(join(path, 'a.txt'), 'dirty'); }
  closeAll({ repo: main, run: 'r1', apply: true }); const before = readState(main, 'r1'), head = git(a, 'rev-parse', 'HEAD').trim();
  git(a, 'checkout', '--', 'a.txt'); assert.equal(closeAll({ repo: main, run: 'r1', paths: [a], apply: true }).closed, 1);
  const after = readState(main, 'r1'), detail = after.closeout.details.find(d => normPath(d.path) === normPath(a));
  assert.equal(detail?.status, 'closed'); assert.equal(detail?.head, head); assert.equal(detail?.branch, 'trio/path-a');
  for (const key of ['at', 'closed', 'open']) assert.equal(after.closeout[key], before.closeout[key]);
  assert.deepEqual(after.gates.closeout, before.gates.closeout);
  git(b, 'checkout', '--', 'a.txt'); closeAll({ repo: main, run: 'r1', apply: true });
  assert.equal(readState(main, 'r1').closeout.details.filter(d => d.status === 'closed').length, 2);
});
