#!/usr/bin/env node
// TrioHarness Lean — automatic archive-then-reclaim, run at two fixed points:
//   --phase post-push      after every successful push of a task branch
//   --phase pre-worktree   before creating a new worktree
//
// Order matters: anything unique is archived first, then only regenerable bytes are deleted.
//   1. ARCHIVE  run ledgers, failures, state, worker results, proof output, review rounds and handovers
//               of linked worktrees into the main checkout at .trioharness-direct/archive/<branch>/<run-id>/
//               — so a worktree can later be removed without losing the record of what it produced.
//               Keepers are scanned for secrets first; a hit is reported and NOT copied.
//   2. RECLAIM  build/test caches, run scratch and (in idle worktrees) node_modules — each deleted only
//               when cleanup.mjs proves it regenerable: allowlisted name, no tracked file inside, git-ignored,
//               and owned by this worktree's index (never inside a nested repository).
//
// Where it may act:
//   - never in the main checkout (the user's own tree): it is skipped whole, always;
//   - in the caller's own worktree only while holding its run-lock, and only caches + run scratch there
//     (never node_modules, never the current run's proof output);
//   - in another linked worktree only when it is idle (no run in progress, no file written for 2 h) AND
//     its run-lock could be taken; the lock is held while deleting and released after.
// Never removes a worktree, a branch, a remote branch, a stash or a run ledger.
//
// Usage:
//   node reclaim.mjs --phase post-push --repo <main checkout> --worktree <path of the pushed tree> [--apply] [--json]
//   node reclaim.mjs --phase pre-worktree --repo <main checkout> [--worktree <current>] [--apply] [--json]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CACHE_DIRS, HEAVY_DIRS, dirSize, findArtifactDirs, humanMb, isDisposable, runFinished, staleLocks } from './cleanup.mjs';
import { lockNameFor, release, tryAcquire } from './run-lock.mjs';
import { harnessOwns, quietFor, registeredEver } from './ownership.mjs';
import { SECRET_VALUE_PATTERNS as SECRET_PATTERNS } from './secret-patterns.mjs';
import { isMain } from './is-main.mjs';

export const PHASES = ['post-push', 'pre-worktree'];

// What is worth keeping forever out of a run folder. Everything else in it is reproducible or scratch.
export const ARCHIVE_KEEP = ['ledger.md', 'failures.md', 'state.json', 'HANDOVER-NEXT.md', 'CODE_REVIEW_ROUNDS.jsonl', 'receipts.jsonl', 'task-card.md', 'plan.md', 'plans', 'workers', 'proof', 'logs'];
// Scratch that is never archived and is reclaimable (the only run-folder entries ever deleted).
export const ARCHIVE_DROP = ['tmp', 'cache', 'logs-raw'];

// Pure: given the entry names of a run folder, which are archived and which are left behind.
export function archiveSelect(entries) {
  const keep = [], drop = [];
  for (const e of entries || []) (ARCHIVE_KEEP.includes(e) || /^HANDOVER-TAKEN-\d+\.md$/.test(e) ? keep : drop).push(e);
  return { keep, drop };
}

// Pure: what each phase is allowed to do.
export function phasePolicy(phase) {
  if (!PHASES.includes(phase)) throw new Error(`RECLAIM_PHASE_UNKNOWN: ${phase} — use one of ${PHASES.join(', ')}`);
  return phase === 'pre-worktree'
    ? { phase, archive: 'all-finished-runs', heavy: 'idle-worktrees', ownTree: 'caches-only', locks: true, scope: 'idle-and-current', mainCheckout: 'never' }
    : { phase, archive: 'this-worktree', heavy: 'idle-worktrees', ownTree: 'caches-only', locks: true, scope: 'idle-and-current', mainCheckout: 'never' };
}

export function mainCheckout(repo, gitRun) {
  const git = gitRun || ((...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    return common.replace(/[\\/]\.git[\\/]?$/, '') || repo;
  } catch { return repo; }
}

export function listWorktrees(repo, gitRun) {
  const git = gitRun || ((...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  const out = [];
  let cur = null;
  for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9).trim(), isMain: out.length === 0 }; out.push(cur); }
    else if (line.startsWith('HEAD ') && cur) cur.head = line.slice(5).trim();
    else if ((line === 'locked' || line.startsWith('locked ')) && cur) cur.locked = true;
    else if ((line === 'prunable' || line.startsWith('prunable ')) && cur) cur.prunable = true;
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).trim().replace('refs/heads/', '');
  }
  return out;
}

// Newest mtime anywhere under a directory (bounded). A directory's own mtime only changes when an
// entry is added or removed, so activity must be measured on the files.
// A folder too large to walk within the bound is reported as "just now" (Infinity): unknown is never idle.
export function newestMtime(dir, { maxEntries = 20000 } = {}) {
  let newest = 0, seen = 0, truncated = false;
  const walk = p => {
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > maxEntries) { truncated = true; return; }
      const full = join(p, e.name);
      try { newest = Math.max(newest, statSync(full).mtimeMs); } catch { /* vanished */ }
      if (e.isDirectory()) walk(full);
    }
  };
  try { newest = statSync(dir).mtimeMs; } catch { return 0; }
  walk(dir);
  return truncated ? Infinity : newest;
}

// A run is active unless its state proves every gate passed. No state, unreadable state or an empty
// gate map is active: the harness checkpoints every gate, so their absence means "not finished".
export function runActive(runDir) {
  const state = join(runDir, 'state.json');
  if (!existsSync(state)) return true;
  let text = '';
  try { text = readFileSync(state, 'utf8'); } catch { return true; }
  return !runFinished(text); // closed only by `finished: true` or a passed final `learnings` gate
}

// A worktree is idle when no run inside it is active and nothing under its runs was written recently.
export function isIdle(worktree, { now = Date.now(), activeWithinMs = 2 * 3600 * 1000 } = {}) {
  const runs = join(worktree, '.trioharness-direct', 'runs');
  if (!existsSync(runs)) return true;
  let entries = [];
  try { entries = readdirSync(runs); } catch { return false; }
  for (const r of entries) {
    const dir = join(runs, r);
    if (runActive(dir)) return false;
    if (now - newestMtime(dir) < activeWithinMs) return false;
  }
  return true;
}

// Secret scan over the keepers before they are copied anywhere near the user's main checkout.
export function scanForSecrets(path, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const hits = [];
  const check = f => {
    let text;
    try { if (statSync(f).size > maxBytes) { hits.push({ file: f, pattern: 'unscannable: over size limit' }); return; } text = readFileSync(f, 'utf8'); } catch { hits.push({ file: f, pattern: 'unscannable: unreadable' }); return; }
    for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) { hits.push({ file: f, pattern: name }); return; }
  };
  const walk = p => {
    let st; try { st = statSync(p); } catch { return; }
    if (st.isFile()) return check(p);
    let entries = []; try { entries = readdirSync(p); } catch { return; }
    for (const e of entries) walk(join(p, e));
  };
  walk(path);
  return hits;
}

const fileMtime = p => { try { return statSync(p).mtimeMs; } catch { return 0; } };

// `.trioharness-direct/` is harness-owned and never committed: make sure the main checkout ignores it
// before anything is written there (via .git/info/exclude — never the tracked .gitignore).
export function ensureExcluded(main, report = { errors: [] }, gitRun) {
  const git = gitRun || ((...a) => execFileSync('git', ['-C', main, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  try { git('check-ignore', '-q', '--', '.trioharness-direct/'); return true; } catch { /* not ignored yet */ }
  try {
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    const exclude = join(common, 'info', 'exclude');
    mkdirSync(join(common, 'info'), { recursive: true });
    const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!/^\.trioharness-direct\/?$/m.test(cur)) writeFileSync(exclude, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}.trioharness-direct/\n`);
    return true;
  } catch (e) { report.errors.push(`exclude: ${String(e.message).split('\n')[0]}`); return false; }
}

// Copy the keepers of runs into the main checkout's archive. Idempotent and never regressive: a run
// already archived is copied again only when the source ledger is newer than the archived one; nothing
// in the source is ever deleted here; keepers carrying a secret pattern are skipped and reported.
export function archiveRuns(worktree, { repo, branch = 'detached', apply = false, onlyFinished = true, force = false } = {}) {
  const runs = join(worktree, '.trioharness-direct', 'runs');
  const planned = [];
  if (!existsSync(runs)) return planned;
  let entries = [];
  try { entries = readdirSync(runs, { withFileTypes: true }); } catch { return planned; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const src = join(runs, e.name);
    if (onlyFinished && runActive(src)) continue;
    let names = [];
    try { names = readdirSync(src); } catch { continue; }
    const { keep } = archiveSelect(names);
    if (!keep.length) continue;
    const dest = join(repo, '.trioharness-direct', 'archive', branch.replace(/[\\/]/g, '__'), e.name);
    const srcLedger = fileMtime(join(src, 'ledger.md')), destLedger = fileMtime(join(dest, 'ledger.md'));
    if (!force && destLedger && srcLedger && srcLedger <= destLedger) { planned.push({ run: e.name, from: src, to: dest, items: [], skipped: 'archive is already as new as the source' }); continue; }
    // Per keeper: skip what the archive already holds at the same or newer age (proof/ can be large).
    const fresh = force ? keep : keep.filter(k => !existsSync(join(dest, k)) || newestMtime(join(src, k)) > newestMtime(join(dest, k)));
    const secrets = fresh.flatMap(k => scanForSecrets(join(src, k)));
    const blocked = new Set(secrets.map(h => resolve(h.file)));
    // A keeper is copied file by file; only the files that hit (secret pattern, unscannable) are left out,
    // so one oversize .trx never un-archives the rest of proof/.
    const copy = fresh.filter(k => !blocked.has(resolve(join(src, k))));
    planned.push({ run: e.name, from: src, to: dest, items: copy, secretHits: secrets });
    if (!apply) continue;
    mkdirSync(dest, { recursive: true });
    for (const k of copy) {
      try { cpSync(join(src, k), join(dest, k), { recursive: true, force: true, filter: f => !blocked.has(resolve(f)) }); } catch { /* skip unreadable keeper */ }
    }
  }
  return planned;
}

const mb = bytes => Math.round(bytes / 1048576);
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const realOr = p => { try { return realpathSync(p); } catch { return resolve(p); } };
const normPath = p => { const n = realOr(p).replace(/\\/g, '/').replace(/\/$/, ''); return CASE_INSENSITIVE_FS ? n.toLowerCase() : n; };
const samePath = (a, b) => Boolean(a && b) && normPath(a) === normPath(b);

export function run({ repo, worktree, phase, apply = false, now = Date.now(), rm = rmSync } = {}) {
  const policy = phasePolicy(phase);
  const main = mainCheckout(repo);
  const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const trees = listWorktrees(repo).filter(w => existsSync(w.path));
  const here = worktree ? resolve(worktree) : null;
  const report = { phase, repo: main, worktree: here, apply, policy, archived: [], reclaimed: [], keptBack: [], skippedWorktrees: [], freedMb: 0, errors: [] };

  // 1. Archive before anything is deleted. The main checkout is a destination, never a source — and the
  //    destination must be git-excluded there, or the user's `git status` fills with harness artifacts.
  ensureExcluded(main, report);
  const linked = trees.filter(w => !w.isMain);
  const toArchive = policy.archive === 'this-worktree' ? linked.filter(w => samePath(w.path, here)) : linked;
  for (const w of toArchive) {
    try { report.archived.push(...archiveRuns(w.path, { repo: main, branch: w.branch || 'detached', apply, onlyFinished: policy.archive !== 'this-worktree' })); }
    catch (e) { report.errors.push(`archive ${w.path}: ${String(e.message).split('\n')[0]}`); }
  }

  // 2. Reclaim only what cleanup.mjs proves regenerable, and only where nothing is running.
  const everRegistered = registeredEver(main);
  for (const w of trees) {
    if (w.isMain) { report.skippedWorktrees.push({ path: w.path, reason: 'main checkout — never reclaimed automatically' }); continue; }
    const isHere = samePath(w.path, here);
    if (!harnessOwns(w, everRegistered)) { report.skippedWorktrees.push({ path: w.path, reason: 'not registered by any run: it is the user\'s own tree, never reclaimed' }); continue; }
    if (!isHere && !isIdle(w.path, { now })) { report.skippedWorktrees.push({ path: w.path, reason: 'a run inside it is unfinished or recently active' }); continue; }
    if (!isHere && !quietFor(w.path, { now })) { report.skippedWorktrees.push({ path: w.path, reason: 'files or HEAD changed in the last 2 hours' }); continue; }
    // Every tree, the caller's own included, is reclaimed only under its run-lock: a build that uses the
    // lock cannot start while it is held, and one already running keeps us out.
    let held = null;
    try { held = tryAcquire(lockNameFor(w.path), { note: `reclaim ${policy.phase}` }); } catch (e) { report.errors.push(`lock ${w.path}: ${String(e.message).split('\n')[0]}`); continue; }
    if (!held.acquired) { report.skippedWorktrees.push({ path: w.path, reason: `its run-lock is held by pid ${held.holder?.pid ?? '?'} (${held.holder?.note || 'another command'})` }); continue; }
    try {
      const heavyHere = !isHere; // only reachable for idle, lock-free linked worktrees
      const names = [...CACHE_DIRS, ...(heavyHere ? HEAVY_DIRS : [])];
      let dirs = [];
      try { dirs = findArtifactDirs(w.path, names); } catch (e) { report.errors.push(`scan ${w.path}: ${String(e.message).split('\n')[0]}`); continue; }
      for (const dir of dirs) {
        const verdict = isDisposable(w.path, dir, gitIn);
        if (!verdict.ok) { report.keptBack.push({ path: dir, reason: verdict.reason }); continue; }
        const sizeMb = mb(dirSize(dir));
        if (apply) { try { rm(dir, { recursive: true, force: true }); } catch (e) { report.errors.push(`${dir}: ${e.message}`); continue; } }
        report.reclaimed.push({ path: dir, sizeMb, kind: HEAVY_DIRS.some(h => dir.endsWith(h)) ? 'heavy' : 'cache' });
        report.freedMb += sizeMb;
      }
      // Run scratch (tmp/cache/logs-raw) is reclaimable only for runs that are finished: an active run's
      // scratch may hold proof output a gate still cites by path.
      const runsDir = join(w.path, '.trioharness-direct', 'runs');
      if (existsSync(runsDir)) {
        let rs = [];
        try { rs = readdirSync(runsDir); } catch { rs = []; }
        for (const r of rs) {
          if (runActive(join(runsDir, r))) continue;
          for (const d of ARCHIVE_DROP) {
            const t = join(runsDir, r, d);
            if (!existsSync(t)) continue;
            const sizeMb = mb(dirSize(t));
            if (apply) { try { rm(t, { recursive: true, force: true }); } catch (e) { report.errors.push(`${t}: ${e.message}`); continue; } }
            report.reclaimed.push({ path: t, sizeMb, kind: 'run-scratch' });
            report.freedMb += sizeMb;
          }
        }
      }
    } finally { release(held.file); }
  }

  // 3. Stale locks whose holder process is gone (same host only).
  if (policy.locks) {
    for (const l of staleLocks().filter(x => x.stale)) {
      if (apply) { try { rm(l.file, { force: true }); } catch (e) { report.errors.push(`${l.file}: ${e.message}`); continue; } }
      report.reclaimed.push({ path: l.file, sizeMb: 0, kind: 'lock' });
    }
  }
  return report;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const has = n => argv.includes(`--${n}`);
  try {
    const report = run({ repo: resolve(opt('repo') || '.'), worktree: opt('worktree'), phase: opt('phase') || 'post-push', apply: has('apply') });
    if (has('json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(`RECLAIM ${report.phase}${report.apply ? '' : ' (audit only)'}\n`);
      for (const a of report.archived) process.stdout.write(`  archive ${a.run} → ${a.to} (${a.skipped || a.items.join(', ')})${a.secretHits?.length ? ` | NOT archived (secret pattern): ${a.secretHits.map(h => `${h.file} [${h.pattern}]`).join(', ')}` : ''}\n`);
      for (const s of report.skippedWorktrees) process.stdout.write(`  skip ${s.path}: ${s.reason}\n`);
      const byKind = report.reclaimed.reduce((m, r) => { m[r.kind] = (m[r.kind] || 0) + r.sizeMb; return m; }, {});
      for (const [k, v] of Object.entries(byKind)) process.stdout.write(`  ${k}: ${humanMb(v)}\n`);
      process.stdout.write(`${report.apply ? 'FREED' : 'WOULD FREE'} ${humanMb(report.freedMb)} across ${report.reclaimed.length} item(s); ${report.archived.filter(a => a.items.length).length} run(s) archived; ${report.keptBack.length} kept back (tracked, not ignored, or nested repo)\n`);
      if (report.errors.length) process.stdout.write(`${report.errors.length} error(s): ${report.errors.join(' | ')}\n`);
    }
    process.exitCode = report.errors.length ? 2 : 0;
  } catch (e) { process.stderr.write(`RECLAIM: ${e.message}\n`); process.exitCode = 3; }
}
