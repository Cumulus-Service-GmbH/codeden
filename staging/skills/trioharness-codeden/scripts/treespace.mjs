#!/usr/bin/env node
// TrioHarness Lean — keep worktrees small: refuse a new tree when the disk is low, reuse an idle clean tree
// instead of cutting another, and seed dependency folders with copy-on-write clones instead of full copies.
//
//   node treespace.mjs room   --repo <main> [--path <future tree>] [--min-free-gb 20]
//   node treespace.mjs reusable --repo <main> [--idle-minutes 120 (minimum 15)]
//   node treespace.mjs reuse  --repo <main> --run <id> --base <sha> [--tree <path>] [--idle-minutes 120 (minimum 15)] [--apply]
//   node treespace.mjs seed   --from <tree> --to <tree> [--names node_modules,...] [--apply]
//
// Safety rules (the closeout rules still apply to every tree this creates):
//   - room: exit 2 when free space is below the limit or cannot be measured (unknown is never "enough").
//   - reuse: only a harness-made tree that is clean, fully on the LIVE remote, has no local-only ignored files, no
//     operation in progress, no previous run records, no sparse checkout, no activity in the last 2 h, is not locked
//     (run-lock or `git worktree lock`), is not the caller's folder and is not registered to an unfinished run.
//     Ownership, cleanliness and HEAD are re-checked UNDER the lock, and the switch is refused when it would overwrite
//     a git-ignored local file. It is re-pointed with
//     `git switch -c bambooed/<run> <base>`; the old branch is never touched, so nothing can be lost. Dry run unless --apply.
//   - seed: Linux btrfs/XFS reflink; macOS `cp -c` on the same volume, verified; elsewhere nothing is copied. Only regenerable, git-ignored, untracked dependency/cache folders (the same proof cleanup.mjs uses), into a
//     destination that does not have them and that also ignores them. Copy-on-write only; where the filesystem or volume cannot clone, NOTHING is copied and the caller installs normally. A full copy is
//     never made silently: it would inflate the disk, which is what this module exists to prevent.
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { HEAVY_DIRS, dirSize, diskFreeMb, findArtifactDirs, isDisposable } from './cleanup.mjs';
import { activeRegistered, inspectWorktree, isHarnessTree, normPath } from './closeout.mjs';
import { harnessOwns, lastActivityMs, registeredEver } from './ownership.mjs';
import { ensureExcluded, isIdle, listWorktrees, mainCheckout } from './reclaim.mjs';
import { lockNameFor, release, tryAcquire } from './run-lock.mjs';
import { readState, registerWorktree } from './run-state.mjs';
import { validRunId } from './ids.mjs';
import { openQuestionsReason } from './questions.mjs';
import { isMain } from './is-main.mjs';

export const DEFAULT_MIN_FREE_GB = 20;
export const DEFAULT_ACTIVE_WITHIN_MS = 2 * 3600 * 1000;
// Only dependency folders: caches such as obj/ or .vite carry absolute paths of the tree they were built in.
const SEEDABLE = new Set(HEAVY_DIRS);
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120000 });
const firstLine = e => String(e?.stderr || e?.message || e).split('\n').find(Boolean) || 'failed';
const inside = (child, parent) => { const c = normPath(child), p = normPath(parent); return c === p || c.startsWith(`${p}/`); };

// Deepest existing ancestor: a tree that does not exist yet is measured on the disk it will be created on.
function existingAncestor(p) {
  let cur = resolve(p);
  while (!existsSync(cur)) { const up = dirname(cur); if (up === cur) break; cur = up; }
  return cur;
}

export function roomCheck(path, { minFreeGb = DEFAULT_MIN_FREE_GB, measure = diskFreeMb } = {}) {
  const limit = Number(minFreeGb);
  if (!Number.isFinite(limit) || limit < 0) return { ok: false, freeGb: null, minFreeGb: limit, reason: 'minFreeGb must be a number >= 0' };
  if (limit === 0) return { ok: true, freeGb: null, minFreeGb: 0, reason: 'disk guard disabled (--min-free-gb 0)' };
  const mb = measure(existingAncestor(path));
  if (mb === null || mb === undefined) return { ok: false, freeGb: null, minFreeGb: limit, reason: 'free disk space could not be measured; free space or pass --min-free-gb 0 once you have checked it yourself' };
  const freeGb = Math.round((mb / 1024) * 10) / 10;
  return freeGb >= limit ? { ok: true, freeGb, minFreeGb: limit } : { ok: false, freeGb, minFreeGb: limit, reason: `only ${freeGb} GB free (limit ${limit} GB): close or reuse an existing worktree instead of cutting a new one` };
}

// Admission counts every non-missing linked tree, including foreign/busy trees. Repository identity
// is the real common Git directory, so overlapping roots and linked checkouts cannot multiply the count.
export function hostTreeBudget(repo, { roots = (process.env.TRIO_HOST_ROOTS || '').split(delimiter).filter(Boolean), maxHostTrees = process.env.TRIO_MAX_HOST_TREES, enforce = process.env.TRIO_HOST_TREES_ENFORCE === '1' } = {}) {
  const parsed = typeof maxHostTrees === 'string' && !maxHostTrees.trim() ? NaN : Number(maxHostTrees);
  const limit = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 12;
  if (limit === 0) return { ok: true, hostTreeCount: null, maxHostTrees: 0 };
  const main = mainCheckout(repo);
  if (!roots.length) roots = [dirname(main), join(homedir(), 'Projects')];
  const seen = new Set(), warnings = []; let count = 0;
  const skipped = (dir, error) => warnings.push(`skipped repository/root ${dir}: ${firstLine(error)}`);
  const walk = (dir, depth = 0) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') skipped(dir, error); return; }
    if (entries.some(e => e.name === '.git')) {
      try {
        const common = realpathSync(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
        if (!seen.has(common)) {
          const trees = listWorktrees(dir).filter(w => !w.isMain && existsSync(w.path));
          seen.add(common); count += trees.length;
        }
      } catch (error) { skipped(dir, error); }
      return;
    }
    if (depth >= 2) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(join(dir, e.name), depth + 1);
  };
  for (const root of new Set([main, ...roots].map(root => resolve(root)))) walk(root);
  if (!seen.size) return { ok: !enforce, hostTreeCount: null, maxHostTrees: limit, reason: 'host-tree-count-unknown', detail: 'the main repository and host roots could not be read', warnings,
    ...(!enforce ? { note: 'host-tree-count-unknown: no readable repository; warning only; set TRIO_HOST_TREES_ENFORCE=1 to enforce' } : {}) };
  const over = count >= limit;
  return { ok: !over || !enforce, hostTreeCount: count, maxHostTrees: limit, warnings,
    ...(over ? { reason: 'host-tree-budget' } : {}),
    ...(over && !enforce ? { note: `host-tree-budget: ${count} linked trees (limit ${limit}); warning only; set TRIO_HOST_TREES_ENFORCE=1 to enforce` } : {}) };
}

export { lastActivityMs };

// Trees another run could take over without losing anything and without disturbing anyone.
export function findReusable(repo, { remote = 'origin', now = Date.now(), activeWithinMs = DEFAULT_ACTIVE_WITHIN_MS, cwd = process.cwd() } = {}) {
  const main = mainCheckout(repo);
  const busy = activeRegistered(main);
  if (busy.unknown) return []; // a run state could not be read: unknown is never idle
  const ever = registeredEver(main); // only trees some run registered (or under a harness root) are ours to repoint
  const out = [];
  for (const w of listWorktrees(main)) {
    if (w.isMain || w.locked || w.prunable || !existsSync(w.path) || !isHarnessTree(w) || !harnessOwns(w, ever) || busy.has(normPath(w.path))) continue;
    if (inside(cwd, w.path)) continue;
    if (!isIdle(w.path, { now })) continue;
    const runs = join(w.path, '.trioharness-direct', 'runs');
    try { if (readdirSync(runs).length) continue; } catch { /* no runs folder */ } // the previous run's records stay in the tree: closeout it first
    try { if (git(w.path, 'config', '--get', 'core.sparseCheckout').trim() === 'true') continue; } catch { /* not set */ }
    if (Math.max(0, now - lastActivityMs(w.path)) < activeWithinMs) continue; // a timestamp a few ms ahead of the clock is not activity
    let info; try { info = inspectWorktree(w, { remote }); } catch { continue; }
    if (info.state !== 'clean' || info.op) continue; // dirty, unpushed, local-only files or a half-done operation: not ours to reuse
    const lock = tryAcquire(lockNameFor(w.path));
    if (!lock.acquired) continue;
    release(lock.file);
    out.push({ path: w.path, branch: w.branch || null, head: info.head });
  }
  return out;
}

// Ignored files that `git switch` would silently overwrite or delete when moving from `head` to `base`.
function ignoredInTheWay(wpath, head, base) {
  const names = git(wpath, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', head, base).split('\0').filter(Boolean).filter(n => existsSync(join(wpath, n)));
  if (!names.length) return [];
  try { return execFileSync('git', ['-C', wpath, 'check-ignore', '-z', '--stdin'], { input: `${names.join('\0')}\0`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).split('\0').filter(Boolean); } catch (e) { if (e.status === 1) return []; throw e; }
}

export function reuseTree(repo, { run, base, tree, remote = 'origin', apply = false, activeWithinMs = DEFAULT_ACTIVE_WITHIN_MS } = {}) {
  const main = mainCheckout(repo);
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  if (!/^[0-9a-f]{40}$/.test(base || '')) throw new Error('BASE_SHA_REQUIRED: pass the 40-character base SHA recorded in the ledger');
  if (readState(main, run)?.finished) throw new Error(`RUN_FINISHED: run ${run} is finished; use a new run id`);
  if (apply) { const q = openQuestionsReason(main, run); if (q) throw new Error(`QUESTIONS_OPEN: ${q}; no tree is repointed while a question is open`); }
  try { git(main, 'cat-file', '-e', `${base}^{commit}`); } catch { throw new Error(`BASE_UNKNOWN: ${base} is not a commit in this repository; fetch first`); }
  const branch = `bambooed/${run}`;
  try { git(main, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`); throw new Error(`BRANCH_EXISTS: ${branch} already exists`); } catch (e) { if (/^BRANCH_EXISTS/.test(e.message)) throw e; }
  const candidates = findReusable(main, { remote, activeWithinMs });
  const pick = tree ? candidates.find(c => normPath(c.path) === normPath(tree)) : candidates[0];
  if (!pick) return { reused: false, reason: tree ? `${tree} is not reusable (dirty, unpushed, busy, recently active, locked, registered to an unfinished run, or not a harness tree)` : 'no idle clean harness tree to reuse', candidates };
  if (!apply) return { reused: false, wouldReuse: pick.path, branch, base, candidates };
  const lock = tryAcquire(lockNameFor(pick.path), { note: 'reuse' });
  if (!lock.acquired) return { reused: false, reason: 'the tree is locked by another command', candidates };
  try {
    // Everything below is decided UNDER the lock: another Architect may have taken this tree since the listing.
    const busy = activeRegistered(main);
    if (busy.unknown || busy.has(normPath(pick.path))) return { reused: false, reason: 'the tree is registered to another run (or a run state is unreadable)', candidates };
    const again = inspectWorktree({ path: pick.path, branch: pick.branch }, { remote });
    if (again.state !== 'clean' || again.op) return { reused: false, reason: `the tree is no longer clean (${again.state})`, candidates };
    let nowBranch = null; try { nowBranch = git(pick.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { /* unreadable */ }
    if (again.head !== pick.head || nowBranch !== (pick.branch || 'HEAD')) return { reused: false, reason: 'the tree moved since it was listed', candidates };
    let blocked = []; try { blocked = ignoredInTheWay(pick.path, pick.head, base); } catch (e) { return { reused: false, reason: `could not prove no ignored file is in the way: ${firstLine(e)}`, candidates }; }
    if (blocked.length) return { reused: false, reason: `switching would overwrite git-ignored local file(s): ${blocked.slice(0, 5).join(', ')}`, candidates };
    try { git(pick.path, 'switch', '--quiet', '-c', branch, base); } catch (e) { return { reused: false, reason: `switch failed: ${firstLine(e)}`, candidates }; }
    registerWorktree(main, run, { path: pick.path, branch, role: 'writer' });
    return { reused: true, path: pick.path, branch, base, previousBranch: pick.branch, previousHead: pick.head };
  } finally { release(lock.file); }
}

// Copy-on-write clone of one folder, built in a private sibling folder and renamed into place only on success, so
// nothing concurrent is ever inside a folder this call may delete and a failure leaves the destination untouched.
// Never a silent full copy:
//   - Linux/other: our own per-file loop with COPYFILE_FICLONE_FORCE (cpSync drops that flag on its native fast path);
//     btrfs/XFS reflink works, anywhere else the first file throws and nothing is kept. Node/libuv cannot clone on
//     macOS or Windows, so there the loop refuses (ENOSYS) and the caller installs normally.
//   - macOS: `cp -c` falls back to a plain copy when it cannot clone, so it is used only on the same volume and the
//     result is verified by free-space delta; a full copy is deleted again and reported.
export function cloneDir(src, dest, { platform = process.platform, copyFile = copyFileSync, run = (c, a) => execFileSync(c, a, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000 }), measure = diskFreeMb, size = p => dirSize(p, { maxEntries: 2000000 }), tmpRoot = null, sameVolume = (a, b) => statSync(a).dev === statSync(b).dev } = {}) {
  try { lstatSync(dest); return { ok: false, reason: 'already present in the destination' }; } catch (e) { if (e.code !== 'ENOENT') return { ok: false, reason: firstLine(e) }; }
  const tmp = tmpRoot ? join(tmpRoot, `${process.pid}-${basename(dest)}`) : `${dest}.seed-${process.pid}`;
  if (tmpRoot) { try { mkdirSync(tmpRoot, { recursive: true }); } catch (e) { return { ok: false, reason: firstLine(e) }; } }
  const drop = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ours */ } };
  const fail = (e, hint = 'this filesystem or volume cannot clone') => { drop(); return { ok: false, reason: `${hint} (${firstLine(e)}): install the dependencies normally` }; };
  try { lstatSync(tmp); return { ok: false, reason: 'a previous seed folder is in the way; remove it' }; } catch { /* absent, as wanted */ }
  try {
    if (platform === 'darwin') {
      if (!sameVolume(src, dirname(dest))) return { ok: false, reason: 'source and destination are on different volumes: install the dependencies normally' };
      const srcMb = Math.round(size(src) / 1048576), before = measure(dirname(dest));
      run('cp', ['-c', '-R', src, tmp]);
      const after = measure(dirname(dest));
      if (before == null || after == null) return fail(new Error('free space could not be measured, so a silent full copy cannot be ruled out'), 'copy-on-write could not be verified');
      if (srcMb >= 100 && before - after > srcMb * 0.5) return fail(new Error(`cp made a full copy (${before - after} MB used of ${srcMb} MB)`), 'copy-on-write is not available here');
    } else {
      const walk = (from, to) => {
        mkdirSync(to);
        for (const e of readdirSync(from, { withFileTypes: true })) {
          const f = join(from, e.name), t = join(to, e.name);
          if (e.isSymbolicLink()) symlinkSync(readlinkSync(f), t);
          else if (e.isDirectory()) walk(f, t);
          else if (e.isFile()) copyFile(f, t, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
          else throw new Error(`unsupported entry ${e.name}`);
        }
      };
      walk(src, tmp);
    }
  } catch (e) { return fail(e); }
  try { renameSync(tmp, dest); } catch (e) { drop(); return { ok: false, reason: e.code === 'ENOTEMPTY' || e.code === 'EEXIST' ? 'already present in the destination' : firstLine(e) }; }
  return { ok: true };
}

// A seed killed mid-copy leaves <pid>-<name> behind: remove those whose process is gone (never a live one's).
export function sweepSeedLeftovers(root, isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }) {
  let names = []; try { names = readdirSync(root); } catch { return []; }
  const removed = [];
  for (const n of names) {
    const m = /^(\d+)-/.exec(n);
    if (!m || isAlive(Number(m[1]))) continue;
    try { rmSync(join(root, n), { recursive: true, force: true }); removed.push(n); } catch { /* leave it */ }
  }
  return removed;
}

export function seedCaches(from, to, { names = HEAVY_DIRS, apply = false, clone = cloneDir } = {}) {
  const src = resolve(from), dst = resolve(to);
  const bad = names.filter(n => !SEEDABLE.has(n));
  if (bad.length) throw new Error(`SEED_NAME_REFUSED: ${bad.join(', ')} is not a dependency folder that may be seeded (only ${[...SEEDABLE].join(', ')})`);
  if (normPath(src) === normPath(dst)) throw new Error('SEED_SAME_TREE');
  const mainSrc = mainCheckout(src), mainDst = mainCheckout(dst);
  if (normPath(mainSrc) !== normPath(mainDst)) throw new Error('SEED_OTHER_REPOSITORY: both trees must belong to the same repository');
  const seedRoot = join(dst, '.trioharness-direct', 'seed'); // git-excluded and on the tree's own filesystem
  if (apply) { try { ensureExcluded(mainDst); } catch { /* best effort */ } sweepSeedLeftovers(seedRoot); }
  const results = [];
  for (const dir of findArtifactDirs(src, names)) {
    const rel = dir.slice(src.length + 1).replace(/\\/g, '/');
    const out = { rel, status: 'skipped' };
    results.push(out);
    const proof = isDisposable(src, dir, (d, ...a) => git(d, ...a));
    if (!proof.ok) { out.reason = proof.reason; continue; }
    const target = join(dst, rel);
    let present = true; try { lstatSync(target); } catch { present = false; } // lstat: a dangling symlink is "present" too
    if (present) { out.reason = 'already present in the destination'; continue; }
    if (!existsSync(dirname(target))) { out.reason = 'parent folder does not exist in the destination'; continue; }
    try { git(dst, 'check-ignore', '-q', '--', `${rel}/`); } catch { out.reason = 'the destination does not ignore it (would show up as untracked)'; continue; }
    if (!apply) { out.status = 'would-clone'; continue; }
    const r = clone(dir, target, { tmpRoot: seedRoot });
    if (r.ok) out.status = 'cloned'; else out.reason = r.reason;
  }
  return { from: src, to: dst, apply, results, cloned: results.filter(r => r.status === 'cloned').length };
}

// ---------- CLI ----------
function idleMs(v) {
  if (v === undefined) return DEFAULT_ACTIVE_WITHIN_MS;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`IDLE_MINUTES_INVALID: ${v}`);
  return Math.max(15, n) * 60000; // floor: the guard cannot be zeroed from the command line
}
if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const has = n => argv.includes(`--${n}`);
  const out = o => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
  try {
    if (cmd === 'room') {
      const repo = mainCheckout(resolve(opt('repo') || '.'));
      const r = roomCheck(opt('path') ? resolve(opt('path')) : repo, { minFreeGb: opt('min-free-gb') ?? DEFAULT_MIN_FREE_GB });
      const budget = hostTreeBudget(repo);
      for (const warning of budget.warnings || []) process.stderr.write(`TREESPACE: note: ${warning}\n`);
      if (budget.note) process.stderr.write(`TREESPACE: warning: ${budget.note}\n`);
      const result = { ...r, ...(budget.note ? { note: budget.note } : {}), ...(budget.warnings?.length ? { warnings: budget.warnings } : {}), hostTreeCount: budget.hostTreeCount, maxHostTrees: budget.maxHostTrees, ...(!budget.ok ? { ok: false, reason: budget.reason, ...(budget.detail ? { detail: budget.detail } : {}) } : {}) };
      out(result); if (!result.ok) process.exitCode = 2;
    } else if (cmd === 'reusable') {
      out(findReusable(resolve(opt('repo') || '.'), { remote: opt('remote') || 'origin', activeWithinMs: idleMs(opt('idle-minutes')) }));
    } else if (cmd === 'reuse') {
      const r = reuseTree(resolve(opt('repo') || '.'), { run: opt('run'), base: opt('base'), tree: opt('tree') ? resolve(opt('tree')) : undefined, remote: opt('remote') || 'origin', apply: has('apply'), activeWithinMs: idleMs(opt('idle-minutes')) });
      out(r); if (!r.reused && !r.wouldReuse) process.exitCode = 2;
    } else if (cmd === 'seed') {
      const r = seedCaches(opt('from'), opt('to'), { names: opt('names') ? opt('names').split(',').map(s => s.trim()).filter(Boolean) : HEAVY_DIRS, apply: has('apply') });
      out(r);
    } else throw new Error('USAGE: room|reusable|reuse|seed');
  } catch (e) { process.stderr.write(`TREESPACE: ${e.message}\n`); process.exitCode = 3; }
}
