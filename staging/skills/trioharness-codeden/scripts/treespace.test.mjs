import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, readdirSync, readlinkSync, readFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Windows creates symlinks only with Developer Mode or admin rights; those tests are skipped (not failed) where it cannot.
const CAN_SYMLINK = (() => { const t = mkdtempSync(join(tmpdir(), 'thl-sym-')); try { symlinkSync('x', join(t, 'l')); return true; } catch { return false; } finally { rmSync(t, { recursive: true, force: true }); } })();
const SYMLINK_SKIP = CAN_SYMLINK ? false : 'symlinks need Developer Mode or admin rights on Windows';
import { constants } from 'node:fs';
import { auditRepo, closeAll } from './closeout.mjs';
import { diskFreeMb } from './cleanup.mjs';
import { lockNameFor, release, tryAcquire } from './run-lock.mjs';
import { readState, registerWorktree, setGate } from './run-state.mjs';
import { DEFAULT_MIN_FREE_GB, cloneDir, sweepSeedLeftovers, findReusable, reuseTree, roomCheck, seedCaches } from './treespace.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const IDLE = { activeWithinMs: 0 }; // fresh test trees would otherwise count as active
const TREESPACE = join(here, 'treespace.mjs');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (dir, ...a) => { try { return git(dir, ...a); } catch { return null; } };

function project() {
  const bare = mkdtempSync(join(tmpdir(), 'thl-ts-bare-'));
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  const main = mkdtempSync(join(tmpdir(), 'thl-ts-main-'));
  git(main, 'init', '--quiet', '--initial-branch=main');
  git(main, 'config', 'user.email', 't@example.com'); git(main, 'config', 'user.name', 'T');
  writeFileSync(join(main, 'a.txt'), 'x');
  writeFileSync(join(main, '.gitignore'), 'node_modules/\nbin/\n.trioharness-direct/\n');
  git(main, 'add', '-A'); git(main, 'commit', '--quiet', '-m', 'init');
  git(main, 'remote', 'add', 'origin', bare);
  git(main, 'push', '--quiet', '-u', 'origin', 'main');
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { bare, main, base: git(main, 'rev-parse', 'HEAD').trim() };
}
// Make a tree look untouched for hours (as a real idle tree is), so the default activity guard can be exercised.
function ageTree(wt, hours = 5) {
  const old = new Date(Date.now() - hours * 3600 * 1000);
  const touch = p => { try { utimesSync(p, old, old); } catch { /* ignore */ } };
  for (const f of git(wt, 'ls-files').split('\n').filter(Boolean)) touch(join(wt, f));
  const gd = join(git(wt, 'rev-parse', '--absolute-git-dir').trim());
  touch(join(gd, 'logs', 'HEAD')); touch(join(gd, 'HEAD'));
  for (const e of readdirSync(wt, { withFileTypes: true })) if (e.isDirectory() && e.name !== '.git') touch(join(wt, e.name));
}
function addTree(main, name, branch) {
  const path = join(`${main}.trioharness`, name);
  mkdirSync(dirname(path), { recursive: true });
  git(main, 'worktree', 'add', '--quiet', '-b', branch, path, 'HEAD');
  return path;
}

test('room: enough, too little, unmeasurable and disabled', () => {
  assert.equal(roomCheck('/x', { minFreeGb: 20, measure: () => 50 * 1024 }).ok, true);
  const low = roomCheck('/x', { minFreeGb: 20, measure: () => 5 * 1024 });
  assert.equal(low.ok, false); assert.match(low.reason, /only 5 GB free/);
  const unknown = roomCheck('/x', { minFreeGb: 20, measure: () => null });
  assert.equal(unknown.ok, false); assert.match(unknown.reason, /could not be measured/);
  assert.equal(roomCheck('/x', { minFreeGb: 0, measure: () => null }).ok, true);
  assert.equal(roomCheck('/x', { minFreeGb: 'abc' }).ok, false);
  assert.equal(DEFAULT_MIN_FREE_GB, 20);
});

test('room: a tree that does not exist yet is measured on its nearest existing folder', () => {
  const seen = [];
  const { main } = project();
  roomCheck(join(main, 'not', 'yet', 'there'), { minFreeGb: 1, measure: p => { seen.push(p); return 99999; } });
  assert.equal(seen.length, 1); assert.ok(existsSync(seen[0]));
});

test('reusable: a clean, pushed, idle harness tree is offered; dirty, unpushed, busy and foreign trees are not', () => {
  const { main } = project();
  const clean = addTree(main, 'clean', 'trio/clean');
  const dirty = addTree(main, 'dirty', 'trio/dirty'); writeFileSync(join(dirty, 'new.txt'), 'n');
  const unpushed = addTree(main, 'unpushed', 'trio/unpushed'); writeFileSync(join(unpushed, 'c.txt'), 'c'); git(unpushed, 'add', '-A'); git(unpushed, 'commit', '--quiet', '-m', 'c');
  const foreign = join(`${main}-other`, 'f'); mkdirSync(dirname(foreign), { recursive: true }); git(main, 'worktree', 'add', '--quiet', '-b', 'feature/mine', foreign, 'HEAD');
  const busy = addTree(main, 'busy', 'trio/busy'); registerWorktree(main, 'run-busy', { path: busy, branch: 'trio/busy', role: 'writer' });
  const locked = addTree(main, 'locked', 'trio/locked'); const lock = tryAcquire(lockNameFor(locked));
  try {
    const paths = findReusable(main, IDLE).map(c => c.path.replace(/^\/private/, ''));
    assert.deepEqual(paths.map(p => p.replace(/^.*\//, '')), ['clean']);
    assert.ok(paths[0].endsWith('/clean') && clean);
  } finally { release(lock.file); }
});

test('reuse: dry run changes nothing; apply re-points the tree, keeps the old branch and registers it', () => {
  const { main, base } = project();
  const wt = addTree(main, 'idle', 'trio/old');
  const dry = reuseTree(main, { run: 'run-2', base, ...IDLE });
  assert.ok(dry.wouldReuse); assert.equal(tryGit(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'trio/old');
  const r = reuseTree(main, { run: 'run-2', base, apply: true, ...IDLE });
  assert.equal(r.reused, true);
  assert.equal(tryGit(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'bambooed/run-2');
  assert.ok(tryGit(main, 'rev-parse', '--verify', 'refs/heads/trio/old'), 'the old branch is untouched');
  assert.equal(readState(main, 'run-2').worktrees.length, 1);
  assert.equal(findReusable(main, IDLE).length, 0, 'now registered to an unfinished run, so not reusable again');
});

test('reuse refuses: bad sha, unknown sha, existing branch, dirty tree, no candidate', () => {
  const { main, base } = project();
  const wt = addTree(main, 'idle', 'trio/old');
  assert.throws(() => reuseTree(main, { run: 'r', base: 'abc' }), /BASE_SHA_REQUIRED/);
  assert.throws(() => reuseTree(main, { run: 'r', base: 'f'.repeat(40) }), /BASE_UNKNOWN/);
  assert.throws(() => reuseTree(main, { run: 'bad run', base }), /RUN_ID_INVALID/);
  git(main, 'branch', 'bambooed/taken');
  assert.throws(() => reuseTree(main, { run: 'taken', base }), /BRANCH_EXISTS/);
  writeFileSync(join(wt, 'dirt.txt'), 'd');
  const r = reuseTree(main, { run: 'r2', base, apply: true, ...IDLE });
  assert.equal(r.reused, false); assert.match(r.reason, /no idle clean/);
  assert.equal(existsSync(join(wt, 'dirt.txt')), true);
});

test('reuse: a tree that turns dirty after the listing is not switched', () => {
  const { main, base } = project();
  const wt = addTree(main, 'idle', 'trio/old');
  const first = findReusable(main, IDLE);
  assert.equal(first.length, 1);
  writeFileSync(join(wt, 'late.txt'), 'late');
  const r = reuseTree(main, { run: 'r3', base, tree: wt, apply: true, ...IDLE });
  assert.equal(r.reused, false);
  assert.equal(tryGit(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'trio/old');
});

test('cloneDir (linux/other path): per-file clone flag, symlinks verbatim, never overwrites, only its own folder is removed', { skip: SYMLINK_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), 'thl-ts-clone-'));
  const src = join(root, 's'); mkdirSync(join(src, 'sub'), { recursive: true }); writeFileSync(join(src, 'sub', 'f'), 'hi'); symlinkSync('../sub/f', join(src, 'link'));
  const flags = [];
  const fake = (f, t, fl) => { flags.push(fl); cpSync(f, t); };
  assert.equal(cloneDir(src, join(root, 'd'), { platform: 'linux', copyFile: fake }).ok, true);
  assert.deepEqual(flags, [constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL]);
  assert.equal(readlinkSync(join(root, 'd', 'link')), '../sub/f');
  assert.equal(cloneDir(src, join(root, 'd'), { platform: 'linux', copyFile: fake }).ok, false);
  mkdirSync(join(root, 'e')); writeFileSync(join(root, 'e', 'mine'), 'keep');
  assert.equal(cloneDir(src, join(root, 'e'), { platform: 'linux', copyFile: fake }).ok, false);
  assert.equal(existsSync(join(root, 'e', 'mine')), true, 'a folder it did not create is never touched');
  symlinkSync('/nonexistent-target-for-test', join(root, 'dangling'));
  assert.equal(cloneDir(src, join(root, 'dangling'), { platform: 'linux', copyFile: fake }).ok, false);
  const bad = cloneDir(src, join(root, 'g'), { platform: 'linux', copyFile: () => { throw Object.assign(new Error('x'), { stderr: 'Operation not supported' }); } });
  assert.equal(bad.ok, false); assert.match(bad.reason, /install the dependencies normally/);
  assert.deepEqual(readdirSync(root).filter(n => n.startsWith('g')), [], 'no destination and no temp folder left behind');
});

test('cloneDir on this machine matches what the filesystem can really do (no silent full copy)', () => {
  const root = mkdtempSync(join(tmpdir(), 'thl-ts-real-'));
  const src = join(root, 's'); mkdirSync(src); writeFileSync(join(src, 'f'), 'hi');
  let canClone = true; try { copyFileSync(join(src, 'f'), join(root, 'probe'), constants.COPYFILE_FICLONE_FORCE); } catch { canClone = false; }
  const r = cloneDir(src, join(root, 'd'));
  // Node cannot probe clonefile on macOS (libuv has no clone there); `cp -c` may legitimately succeed on APFS, so
  // on a Mac the only claim is consistency: ok exactly when the folder exists. Elsewhere the probe decides.
  if (process.platform === 'darwin') assert.equal(r.ok, existsSync(join(root, 'd')));
  else { assert.equal(r.ok, canClone); assert.equal(existsSync(join(root, 'd')), canClone); }
  assert.deepEqual(readdirSync(root).filter(n => n.includes('.seed-')), []);
});

test('cloneDir on macOS: same volume only, cp -c, and a full copy is detected, deleted and reported', () => {
  const root = mkdtempSync(join(tmpdir(), 'thl-ts-mac-'));
  const src = join(root, 's'); mkdirSync(src); writeFileSync(join(src, 'f'), 'hi');
  const calls = [];
  const run = (c, a) => { calls.push([c, ...a.slice(0, 2)]); cpSync(a[2], a[3], { recursive: true }); };
  const ok = cloneDir(src, join(root, 'd'), { platform: 'darwin', run, size: () => 500 * 1048576, measure: (() => { let n = 0; return () => (n++ ? 99000 : 100000); })() }); // 1 GB-ish drop would be a copy; 1000 MB here
  assert.equal(ok.ok, false); assert.match(ok.reason, /copy-on-write is not available/);
  assert.equal(existsSync(join(root, 'd')), false); assert.deepEqual(readdirSync(root).filter(n => n.includes('.seed-')), []);
  assert.deepEqual(calls[0], ['cp', '-c', '-R']);
  const good = cloneDir(src, join(root, 'd2'), { platform: 'darwin', run, size: () => 500 * 1048576, measure: (() => { let n = 0; return () => (n++ ? 99990 : 100000); })() });
  assert.equal(good.ok, true); assert.equal(existsSync(join(root, 'd2', 'f')), true);
  const cross = cloneDir(src, join(root, 'd3'), { platform: 'darwin', run: () => { throw new Error('must not run'); }, sameVolume: () => false });
  assert.equal(cross.ok, false); assert.match(cross.reason, /different volumes/);
});

function seedFixture() {
  const p = project();
  const a = addTree(p.main, 'a', 'trio/a'); const b = addTree(p.main, 'b', 'trio/b');
  mkdirSync(join(a, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(a, 'node_modules', 'pkg', 'index.js'), 'module.exports=1');
  return { ...p, a, b };
}
const fakeClone = (src, dest) => { cpSync(src, dest, { recursive: true, verbatimSymlinks: true }); return { ok: true }; };

test('seed: dry run lists, apply clones an ignored dependency folder into a sibling tree', () => {
  const { a, b } = seedFixture();
  const dry = seedCaches(a, b);
  assert.equal(dry.results[0].status, 'would-clone'); assert.equal(existsSync(join(b, 'node_modules')), false);
  const r = seedCaches(a, b, { apply: true, clone: fakeClone });
  assert.equal(r.cloned, 1); assert.equal(existsSync(join(b, 'node_modules', 'pkg', 'index.js')), true);
  assert.equal(git(b, 'status', '--porcelain').trim(), '', 'the clone is ignored: the destination stays clean');
  assert.equal(seedCaches(a, b, { apply: true, clone: fakeClone }).results[0].reason, 'already present in the destination');
});

test('seed refuses: tracked folder, non-dependency names, other repository, same tree, destination that does not ignore', () => {
  const { main, a, b } = seedFixture();
  git(a, 'add', '-f', 'node_modules/pkg/index.js'); git(a, 'commit', '--quiet', '-m', 't');
  const r = seedCaches(a, b, { apply: true, clone: fakeClone });
  assert.equal(r.cloned, 0); assert.match(r.results[0].reason, /tracked files/);
  assert.throws(() => seedCaches(a, b, { names: ['src'] }), /SEED_NAME_REFUSED/);
  assert.throws(() => seedCaches(a, b, { names: ['obj'] }), /SEED_NAME_REFUSED/, 'build caches carry absolute paths and are not seeded');
  assert.throws(() => seedCaches(a, a), /SEED_SAME_TREE/);
  const other = project().main;
  assert.throws(() => seedCaches(a, other), /SEED_OTHER_REPOSITORY/);
  const f2 = seedFixture();
  writeFileSync(join(f2.b, '.gitignore'), 'bin/\n'); // node_modules no longer ignored in b
  const r2 = seedCaches(f2.a, f2.b, { apply: true, clone: fakeClone });
  assert.equal(r2.cloned, 0); assert.match(r2.results.find(x => x.rel === 'node_modules').reason, /does not ignore/);
  assert.ok(main);
});

test('seed: a failed clone copies nothing and reports why', () => {
  const { a, b } = seedFixture();
  const r = seedCaches(a, b, { apply: true, clone: () => ({ ok: false, reason: 'this filesystem cannot clone' }) });
  assert.equal(r.cloned, 0); assert.equal(existsSync(join(b, 'node_modules')), false); assert.match(r.results[0].reason, /cannot clone/);
});

test('seed: a nested repository inside the source is never entered', () => {
  const { a, b } = seedFixture();
  const nested = join(a, 'vendor', 'lib'); mkdirSync(join(nested, 'node_modules'), { recursive: true }); execFileSync('git', ['init', '--quiet', nested]);
  const r = seedCaches(a, b, { apply: true, clone: fakeClone });
  assert.equal(r.results.some(x => x.rel.startsWith('vendor')), false);
});

test('audit reports free disk and flags a low disk under --strict', () => {
  const { main } = project();
  assert.equal(auditRepo(main, { minFreeGb: 20, measure: () => 50 * 1024 }).lowDisk, false);
  const low = auditRepo(main, { minFreeGb: 20, measure: () => 2 * 1024 });
  assert.equal(low.lowDisk, true); assert.equal(low.freeGb, 2);
  assert.equal(auditRepo(main, { minFreeGb: 20, measure: () => null }).lowDisk, true);
  assert.equal(auditRepo(main, { minFreeGb: 0, measure: () => null }).lowDisk, false);
  const closeout = join(here, 'closeout.mjs');
  const ok = spawnSync('node', [closeout, 'audit', '--repo', main, '--strict', '--min-free-gb', '1'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync('node', [closeout, 'audit', '--repo', main, '--strict', '--min-free-gb', '999999999'], { encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.match(bad.stdout, /LOW DISK/);
});

test('CLI: room exits 2 when too little is free; reusable and reuse work end to end', () => {
  const { main, base } = project();
  ageTree(addTree(main, 'idle', 'trio/old'));
  const env = { ...process.env, TRIO_HOST_ROOTS: main, TRIO_MAX_HOST_TREES: '12' };
  const room = spawnSync('node', [TREESPACE, 'room', '--repo', main, '--min-free-gb', '999999999'], { encoding: 'utf8', env });
  assert.equal(room.status, 2); assert.equal(JSON.parse(room.stdout).ok, false);
  assert.equal(spawnSync('node', [TREESPACE, 'room', '--repo', main, '--min-free-gb', '0'], { encoding: 'utf8', env }).status, 0);
  assert.equal(JSON.parse(spawnSync('node', [TREESPACE, 'reusable', '--repo', main, '--idle-minutes', '15'], { encoding: 'utf8', env }).stdout).length, 1);
  const reuse = spawnSync('node', [TREESPACE, 'reuse', '--repo', main, '--run', 'cli-run', '--base', base, '--apply'], { encoding: 'utf8', env });
  assert.equal(reuse.status, 0, reuse.stderr); assert.equal(JSON.parse(reuse.stdout).reused, true);
  assert.equal(spawnSync('node', [TREESPACE, 'bogus'], { encoding: 'utf8', env }).status, 3);
});

test('run-state: registering a reviewer tree warns that reviewers do not need one', () => {
  const { main } = project();
  const r = spawnSync('node', [join(here, 'run-state.mjs'), 'worktree', '--repo', main, '--run', 'rv', '--path', join(main, 'x'), '--role', 'reviewer'], { encoding: 'utf8' });
  assert.equal(r.status, 0); assert.match(r.stderr, /reviewers do not need a worktree/);
});

test('disk guard measures what the user can write (bavail), not root-reserved blocks', () => {
  const st = statfsSync(tmpdir());
  const mb = diskFreeMb(tmpdir());
  assert.ok(mb <= Math.round((st.bavail * st.bsize) / 1048576) + 1);
});

test('reuse: a tree registered to another run between listing and apply is refused (compare-and-swap under the lock)', () => {
  const { main, base } = project();
  const wt = addTree(main, 'idle', 'trio/old');
  const listed = findReusable(main, IDLE); assert.equal(listed.length, 1);
  registerWorktree(main, 'run-A', { path: wt, branch: 'trio/old', role: 'writer' }); // run A takes it after B listed it
  const r = reuseTree(main, { run: 'run-B', base, tree: wt, apply: true, ...IDLE });
  assert.equal(r.reused, false);
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'trio/old');
  assert.equal(readState(main, 'run-B'), null);
});

test('reuse: two applies in a row give the tree to exactly one run', () => {
  const { main, base } = project();
  const wt = addTree(main, 'idle', 'trio/old');
  assert.equal(reuseTree(main, { run: 'run-A', base, apply: true, ...IDLE }).reused, true);
  const second = reuseTree(main, { run: 'run-B', base, tree: wt, apply: true, ...IDLE });
  assert.equal(second.reused, false);
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'bambooed/run-A');
});

test('reuse skips: git-locked tree, recently active tree, the caller\'s own folder, leftover run records, sparse checkout', () => {
  const { main } = project();
  const locked = addTree(main, 'locked', 'trio/locked'); git(main, 'worktree', 'lock', locked);
  assert.equal(findReusable(main, IDLE).length, 0);
  git(main, 'worktree', 'unlock', locked);
  assert.equal(findReusable(main, IDLE).length, 1);
  assert.equal(findReusable(main, { activeWithinMs: 3600 * 1000 }).length, 0, 'fresh files mean someone may be working');
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  for (const f of ['a.txt', '.gitignore']) utimesSync(join(locked, f), old, old);
  assert.equal(findReusable(main, { activeWithinMs: 3600 * 1000, cwd: locked }).length, 0, 'never the caller\'s own folder');
  mkdirSync(join(locked, '.trioharness-direct', 'runs', 'old-run'), { recursive: true });
  assert.equal(findReusable(main, IDLE).length, 0, 'previous run records stay in the tree');
});

test('reuse refuses to overwrite a git-ignored local file that the base commit tracks', () => {
  const { main } = project();
  const wt = addTree(main, 'idle', 'trio/old');
  mkdirSync(join(wt, 'bin'), { recursive: true }); writeFileSync(join(wt, 'bin', 'tool'), 'my local build');
  git(main, 'checkout', '--quiet', '-b', 'maint'); mkdirSync(join(main, 'bin'), { recursive: true }); writeFileSync(join(main, 'bin', 'tool'), 'tracked'); git(main, 'add', '-f', 'bin/tool'); git(main, 'commit', '--quiet', '-m', 'track tool');
  const base = git(main, 'rev-parse', 'HEAD').trim(); git(main, 'checkout', '--quiet', 'main');
  const r = reuseTree(main, { run: 'r-ign', base, apply: true, ...IDLE });
  assert.equal(r.reused, false); assert.match(r.reason, /overwrite git-ignored/);
  assert.equal(readFileSync(join(wt, 'bin', 'tool'), 'utf8'), 'my local build');
});

test('an unreadable run state means no tree is reusable and stale scope refuses to guess', () => {
  const { main } = project();
  addTree(main, 'idle', 'trio/old');
  registerWorktree(main, 'run-x', { path: join(main, 'nowhere'), role: 'scratch' });
  writeFileSync(join(main, '.trioharness-direct', 'runs', 'run-x', 'state.json'), '{ half written');
  assert.deepEqual(findReusable(main, IDLE), []);
  assert.throws(() => closeAll({ repo: main, scope: 'stale', apply: false }), /CLOSEOUT_STATE_UNREADABLE/);
});

test('a finished run cannot register or reuse trees', () => {
  const { main, base } = project();
  registerWorktree(main, 'done-run', { path: join(main, 'p'), role: 'scratch' });
  const f = join(main, '.trioharness-direct', 'runs', 'done-run', 'state.json');
  const st = JSON.parse(readFileSync(f, 'utf8')); st.finished = true; writeFileSync(f, JSON.stringify(st));
  assert.throws(() => registerWorktree(main, 'done-run', { path: join(main, 'q'), role: 'writer' }), /RUN_FINISHED/);
  addTree(main, 'idle', 'trio/old');
  assert.throws(() => reuseTree(main, { run: 'done-run', base, apply: true, ...IDLE }), /RUN_FINISHED/);
});

test('the documented flow works with the DEFAULT guard: audit, list, dry run, then apply on an idle tree', () => {
  const { main, base } = project();
  const wt = addTree(main, 'idle', 'trio/old'); ageTree(wt);
  auditRepo(main); // read-only git commands rewrite the index; they must not make the tree look active
  assert.equal(findReusable(main).length, 1);
  assert.ok(reuseTree(main, { run: 'flow', base }).wouldReuse);
  assert.equal(reuseTree(main, { run: 'flow', base, apply: true }).reused, true);
});

test('--idle-minutes cannot zero the activity guard (floor 15)', () => {
  const { main } = project();
  addTree(main, 'fresh', 'trio/fresh');
  const r = spawnSync('node', [TREESPACE, 'reusable', '--repo', main, '--idle-minutes', '0'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('seed builds in an ignored folder inside the tree, so a crash never leaves untracked clutter; dead leftovers are swept', () => {
  const { a, b } = seedFixture();
  const root = join(b, '.trioharness-direct', 'seed');
  mkdirSync(join(root, '999999-node_modules'), { recursive: true }); mkdirSync(join(root, `${process.pid}-live`), { recursive: true });
  const removed = sweepSeedLeftovers(root, pid => pid === process.pid);
  assert.deepEqual(removed, ['999999-node_modules']); assert.equal(existsSync(join(root, `${process.pid}-live`)), true);
  const r = seedCaches(a, b, { apply: true, clone: (src, dest, o) => { assert.equal(o.tmpRoot, root); return fakeClone(src, dest); } });
  assert.equal(r.cloned, 1);
  assert.equal(git(b, 'status', '--porcelain').trim(), '', 'the seed folder is excluded from git');
});

test('macOS verification refuses when free space cannot be measured; a bad --idle-minutes is an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'thl-ts-mac2-'));
  const src = join(root, 's'); mkdirSync(src); writeFileSync(join(src, 'f'), 'hi');
  const r = cloneDir(src, join(root, 'd'), { platform: 'darwin', run: (c, a) => cpSync(a[2], a[3], { recursive: true }), measure: () => null, size: () => 1 });
  assert.equal(r.ok, false); assert.match(r.reason, /could not be verified/); assert.equal(existsSync(join(root, 'd')), false);
  const { main } = project();
  assert.equal(spawnSync('node', [TREESPACE, 'reusable', '--repo', main, '--idle-minutes', 'abc'], { encoding: 'utf8' }).status, 3);
});


function hostRoom(repo, roots, limit, enforce = '1') {
  const env = { ...process.env, TRIO_HOST_ROOTS: roots.join(delimiter), TRIO_MAX_HOST_TREES: String(limit) };
  if (enforce === null) delete env.TRIO_HOST_TREES_ENFORCE; else env.TRIO_HOST_TREES_ENFORCE = enforce;
  return spawnSync(process.execPath, [TREESPACE, 'room', '--repo', repo, '--min-free-gb', '0'], {
    encoding: 'utf8', env
  });
}
test('host budget: room counts linked trees across repositories and deduplicates common dirs', () => {
  const a = project(), b = project();
  const one = addTree(a.main, 'one', 'trio/host-one'); addTree(b.main, 'two', 'trio/host-two');
  const roots = [a.main, b.main, a.main, one];
  const blocked = hostRoom(a.main, roots, 2);
  assert.equal(blocked.status, 2, blocked.stderr);
  const report = JSON.parse(blocked.stdout);
  assert.equal(report.reason, 'host-tree-budget'); assert.equal(report.hostTreeCount, 2);
  const allowed = hostRoom(a.main, roots, 3);
  assert.equal(allowed.status, 0, allowed.stderr); assert.equal(JSON.parse(allowed.stdout).hostTreeCount, 2);
  const above = hostRoom(a.main, roots, 1); assert.equal(above.status, 2);
});
test('host budget: zero disables; invalid values use default twelve; missing linked trees do not count', () => {
  const { main } = project(), roots = [main];
  const missing = addTree(main, 'missing', 'trio/missing'); rmSync(missing, { recursive: true, force: true });
  for (let i = 0; i < 12; i++) addTree(main, `host-${i}`, `trio/host-${i}`);
  const disabled = hostRoom(main, roots, 0); assert.equal(disabled.status, 0, disabled.stderr);
  for (const invalid of ['oops', '-1', '1.5', '']) {
    const r = hostRoom(main, roots, invalid); assert.equal(r.status, 2, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.reason, 'host-tree-budget'); assert.equal(report.maxHostTrees, 12); assert.equal(report.hostTreeCount, 12);
  }
});


test('fix batch reuse followed by normal run closeout ignores finished historical registration', () => {
  const { main, base } = project(), wt = addTree(main, 'reuse-close', 'trio/previous');
  registerWorktree(main, 'previous', { path: wt });
  const file = join(main, '.trioharness-direct/runs/previous/state.json');
  writeFileSync(file, JSON.stringify({ ...readState(main, 'previous'), finished: true }));
  ageTree(wt);
  const reused = reuseTree(main, { run: 'current', base, tree: wt, apply: true });
  assert.equal(reused.reused, true, JSON.stringify(reused));
  const r = spawnSync(process.execPath, [join(here, 'closeout.mjs'), 'close', '--repo', main, '--run', 'current', '--apply', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(JSON.parse(r.stdout).closed, 1);
  assert.equal(existsSync(wt), false); assert.equal(readState(main, 'current').closeout.open, 0);
});

test('fix batch host rollout warns by default; only enforce=1 blocks; disk guard still blocks', () => {
  const { main } = project(); addTree(main, 'warn', 'trio/warn');
  for (const enforce of [null, '0', 'true']) {
    const r = hostRoom(main, [main], 1, enforce);
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).ok, true);
    assert.match(JSON.parse(r.stdout).note, /host-tree-budget/);
    assert.match(r.stderr, /warning.*host-tree-budget/i);
  }
  assert.equal(hostRoom(main, [main], 1, '1').status, 2);
  const disk = spawnSync(process.execPath, [TREESPACE, 'room', '--repo', main, '--min-free-gb', '999999999'], {
    encoding: 'utf8', env: { ...process.env, TRIO_HOST_ROOTS: main, TRIO_MAX_HOST_TREES: '1', TRIO_HOST_TREES_ENFORCE: '0' }
  });
  assert.equal(disk.status, 2); assert.match(JSON.parse(disk.stdout).reason, /only .* GB free/);
});

test('fix batch host scan skips and reports broken repo while counting readable repos', () => {
  const { main } = project(); addTree(main, 'counted', 'trio/counted');
  const broken = mkdtempSync(join(tmpdir(), 'thl-ts-broken-'));
  writeFileSync(join(broken, '.git'), 'gitdir: nowhere\n');
  for (const roots of [[broken, main], [main, broken]]) {
    const r = hostRoom(main, roots, 2);
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).hostTreeCount, 1);
    assert.match(r.stderr, /skipp.*broken/i);
    assert.equal(hostRoom(main, roots, 1).status, 2, 'remaining readable trees still enforce the budget');
  }
});
test('final batch host scan with no readable repo warns unless enforcement is enabled', () => {
  const broken = mkdtempSync(join(tmpdir(), 'thl-ts-broken-'));
  writeFileSync(join(broken, '.git'), 'gitdir: nowhere\n');
  for (const enforce of [null, '0', '1']) {
    const r = hostRoom(broken, [broken], 12, enforce), report = JSON.parse(r.stdout);
    assert.equal(r.status, enforce === '1' ? 2 : 0, r.stderr);
    assert.equal(report.ok, enforce !== '1'); assert.equal(report.hostTreeCount, null);
    if (enforce === '1') assert.equal(report.reason, 'host-tree-count-unknown');
    else { assert.match(report.note, /host-tree-count-unknown/); assert.match(r.stderr, /warning.*host-tree-count-unknown/); }
    assert.match(r.stderr, /skipp.*broken/i);
  }
});

test('final batch host scan includes own main repo with custom roots and deduplicates it', () => {
  const a = project(), b = project();
  const own = addTree(a.main, 'own', 'trio/own'), other = addTree(b.main, 'other', 'trio/other');
  const enforced = hostRoom(a.main, [b.main], 2);
  assert.equal(enforced.status, 2, enforced.stderr); assert.equal(JSON.parse(enforced.stdout).hostTreeCount, 2);
  const allowed = hostRoom(a.main, [b.main, a.main, own, other], 3);
  assert.equal(allowed.status, 0, allowed.stderr); assert.equal(JSON.parse(allowed.stdout).hostTreeCount, 2);
  const broken = mkdtempSync(join(tmpdir(), 'thl-ts-broken-')); writeFileSync(join(broken, '.git'), 'gitdir: nowhere\n');
  const ownOnly = hostRoom(a.main, [broken], 2);
  assert.equal(ownOnly.status, 0, ownOnly.stderr); assert.equal(JSON.parse(ownOnly.stdout).hostTreeCount, 1);
});