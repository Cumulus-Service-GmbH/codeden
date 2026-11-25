#!/usr/bin/env node
// TrioHarness Lean — worktree closeout: no run leaves a worktree open, dirty or unpushed behind it.
//
// A task may create many worktrees (writer, reviewers, slices) in one or several repositories. Each one is
// registered with `run-state.mjs worktree` when it is cut. At the end of the task (gate "closeout", before the
// learning step) this script walks every registered worktree and drives it to one of two end states:
//   - CLOSED   the folder is removed; every commit and every uncommitted byte is preserved on a git ref
//              (and pushed when the ref is a task branch), local-only files are archived, run ledgers archived;
//   - KEPT     the folder stays, with a named blocker the Architect must resolve — and the run cannot be
//              finished (`run-state.mjs finish` and the learnings gate refuse) while any worktree is open.
//
// What it does to one worktree, in order, under that worktree's run-lock:
//   1. busy?      a held run-lock, an active run, or the process's own current directory -> skipped, reported.
//   2. dirty?     with --snapshot, EVERYTHING not git-ignored (modified, staged, untracked) is committed onto a
//                 new ref `trio/wip-<branch>-<date>-<sha>` via a temporary index, so the working tree, the real
//                 index and the real branch are never touched. The snapshot is secret-scanned first (file names
//                 and added lines); a hit refuses the snapshot and keeps the worktree. Files > 20 MB refuse too.
//   3. unpushed?  commits not on any remote branch: a `bambooed/*` or `trio/*` branch is pushed with --push;
//                 any other branch is left local only with --local-ok (it survives the worktree) — otherwise it
//                 is a blocker for the user. A detached HEAD not on the remote is pinned on a `trio/wip-*` ref.
//   4. local-only ignored files (not build output): copied to <main>/.trioharness-direct/archive/…/ignored-files/
//                 (cap 50 MB); over the cap -> kept. Run ledgers are archived with reclaim's archiveRuns.
//   5. remove     `git worktree remove` (never --force unless step 2 preserved the dirt), then `git worktree prune`.
// Never: touches the main checkout, a nested repository, a worktree it does not own (run scope = registered ones;
// stale scope = harness-made trees only), deletes a branch/tag/stash, force-pushes, bypasses a hook, prints file contents.
//
// Usage:
//   node closeout.mjs audit --repo <path> | --root <dir of repos>  [--run <id>] [--json] [--strict] [--max-open 6] [--min-free-gb 20]
//   node closeout.mjs close --repo <main checkout> --run <id> [--ledger <repo>]   [--snapshot] [--push] [--local-ok] [--apply]
//   node closeout.mjs close --repo <main checkout> --scope stale                  [--snapshot] [--push] [--local-ok] [--apply]
//   node closeout.mjs close --repo <main checkout> --path <worktree> [--path …]    (explicit trees)
// Run from the main checkout (or anywhere outside the trees being closed); dry run unless --apply.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, statSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CACHE_DIRS, HEAVY_DIRS, diskFreeMb, dirSize } from './cleanup.mjs';
import { archiveRuns, ensureExcluded, isIdle, listWorktrees, mainCheckout } from './reclaim.mjs';
import { lockNameFor, release, tryAcquire } from './run-lock.mjs';
import { findSecrets, isSecretFile } from './secret-patterns.mjs';
import { closeoutHoldReason, readState, recordCloseout } from './run-state.mjs';
import { openQuestionsReason } from './questions.mjs';
import { harnessOwns, normPath, realOr, quietFor, registeredEver, underHarnessRoot } from './ownership.mjs';
import { isMain } from './is-main.mjs';

export const PUSHABLE = /^(codeden|bambooed|trio)\//;
export const HARNESS_BRANCH = /^(codeden|bambooed|trio|trioharness-v2)\//;
export const DATA_FILE = /\.(sql|bak|dump|mdf|ldf|trc|csv|xlsx|xls|pst|parquet|db|sqlite3?)$/i;
export const IGNORED_CAP_BYTES = 50 * 1024 * 1024;
export const SNAPSHOT_FILE_CAP_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_OPEN = 6;
// Ignored names that are build output or the harness's own ledger (archived separately), never "local-only files".
// OS litter (Finder, Explorer) is never the user's work: it neither makes a tree dirty nor enters a snapshot —
// unless the repository tracks that very file, in which case it is real content like any other.
export const OS_JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const NOT_LOCAL = new Set([...CACHE_DIRS, ...HEAVY_DIRS, '.git', '.trioharness-direct']);

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
function git(dir, args, { env = {}, timeout = 120000, input } = {}) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], env: { ...GIT_ENV, ...env }, timeout, input });
}
function gitBuf(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], env: GIT_ENV, timeout: 120000 });
}
const firstLine = e => String(e?.stderr || e?.message || e).split('\n').find(Boolean) || 'git failed';
export { normPath };
const insideOrSame = (child, parent) => { const c = normPath(child), p = normPath(parent); return c === p || c.startsWith(`${p}/`); };
const san = s => String(s || 'tree').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tree';
const stamp = (now = new Date()) => now.toISOString().slice(0, 10).replace(/-/g, '');

export const isHarnessTree = w => HARNESS_BRANCH.test(w.branch || '') || /\.trioharness([\\/]|$)/i.test(String(w.path).replace(/\\/g, '/'));

// ---------- inspection (read-only) ----------

// A half-done rebase/merge/cherry-pick/revert/bisect is not work to snapshot and delete: it is the user's to finish or abort.
export function operationInProgress(wpath) {
  for (const [name, label] of [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']]) {
    try { if (existsSync(resolve(wpath, git(wpath, ['rev-parse', '--git-path', name]).trim()))) return label; } catch { /* unreadable */ }
  }
  return null;
}

// "On the remote" is asked of the LIVE remote (ls-remote), never of cached remote-tracking refs; unreachable = not proven.
export function liveRemoteContains(wpath, head, remote = 'origin') {
  let heads;
  try { heads = git(wpath, ['ls-remote', '--heads', remote], { timeout: 60000 }).split('\n').map(l => l.split('\t')[0]).filter(Boolean); } catch { return false; }
  for (const sha of heads) {
    if (sha === head) return true;
    try { git(wpath, ['merge-base', '--is-ancestor', head, sha]); return true; } catch { /* not an ancestor, or object not fetched */ }
  }
  return false;
}

export function localOnlyIgnored(wpath) {
  let out = '';
  try { out = git(wpath, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']); } catch { return []; }
  return out.split('\0').filter(Boolean).filter(p => !p.replace(/\/$/, '').split('/').some(seg => NOT_LOCAL.has(seg)));
}


// Deletes untracked OS litter only (never a file the repository tracks).
export function dropOsLitter(wpath) {
  let list = [];
  try { list = git(wpath, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(f => f && OS_JUNK.test(f)); } catch { return 0; }
  let n = 0;
  for (const f of list) { try { rmSync(join(wpath, f), { force: true }); n++; } catch { /* leave it: remove will report */ } }
  return n;
}

export function inspectWorktree(w, { remote = 'origin' } = {}) {
  const info = { path: w.path, leaf: basename(w.path), branch: w.branch || null, isMain: Boolean(w.isMain) };
  if (w.isMain) return { ...info, state: 'main' };
  if (!existsSync(w.path)) return { ...info, state: 'missing', head: w.head && !/^0+$/.test(w.head) ? w.head : undefined };
  let head;
  try { head = git(w.path, ['rev-parse', 'HEAD']).trim(); } catch (e) { return { ...info, state: 'unreadable', error: firstLine(e) }; }
  let lines;
  // The harness's own run folder is never the user's work: untracked files inside it do not make a tree dirty.
  const ownFolder = l => { const f = l.slice(3).replace(/^"/, ''); return l.startsWith('?? ') && (f === '.trioharness-direct' || f.startsWith('.trioharness-direct/') || OS_JUNK.test(f.replace(/"$/, ''))); };
  try { lines = git(w.path, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).filter(l => !ownFolder(l)); } catch (e) { return { ...info, head, state: 'unreadable', error: firstLine(e) }; }
  const onRemote = liveRemoteContains(w.path, head, remote);
  const op = operationInProgress(w.path);
  const ignored = localOnlyIgnored(w.path);
  const dirty = lines.length;
  const state = dirty ? 'dirty' : !onRemote ? 'unpushed' : ignored.length ? 'ignored-files' : 'clean';
  return { ...info, head, state, op, dirty, trackedChanges: lines.filter(l => !l.startsWith('??')).length, untracked: lines.filter(l => l.startsWith('??')).length, onRemote, ignoredLocal: ignored.length, remote };
}

// Pure: what would closing this tree take, and what stops it. flags: { snapshot, push, localOk }.
export function decide(info, flags = {}) {
  if (info.isMain || info.state === 'main') return { verdict: 'skip', reason: 'main checkout is never closed', steps: [], blockers: [] };
  if (info.state === 'missing') return { verdict: 'prune', steps: ['prune'], blockers: [] };
  if (info.state === 'unreadable') return { verdict: 'keep', steps: [], blockers: [`unreadable: ${info.error}`] };
  const steps = [], blockers = [];
  if (info.op) blockers.push(`a ${info.op} is in progress: finish or abort it first`);
  if (info.dirty > 0) { if (flags.snapshot) steps.push('snapshot'); else blockers.push('uncommitted changes: commit them or pass --snapshot'); }
  const pushable = PUSHABLE.test(info.branch || '');
  if (!info.onRemote) {
    if (!info.branch) steps.push('pin-head'); // detached commits would live only in the reflog once the folder is gone
    else if (pushable) { if (flags.push) steps.push('push'); else if (!flags.localOk) blockers.push(`unpushed commits on ${info.branch}: pass --push`); }
    else if (!flags.localOk) blockers.push(`unpushed commits on ${info.branch}, a branch the harness may not push: pass --local-ok or push it yourself`);
  }
  if (info.ignoredLocal > 0) steps.push('archive-ignored');
  steps.push('remove');
  return { verdict: blockers.length ? 'keep' : 'close', steps, blockers };
}

// ---------- snapshot of uncommitted work onto a ref, never touching the tree ----------

function identityEnv(dir) {
  let have = true;
  try { have = Boolean(git(dir, ['config', 'user.email']).trim() && git(dir, ['config', 'user.name']).trim()); } catch { have = false; }
  return have ? {} : { GIT_AUTHOR_NAME: 'trioharness-closeout', GIT_AUTHOR_EMAIL: 'closeout@trioharness.local', GIT_COMMITTER_NAME: 'trioharness-closeout', GIT_COMMITTER_EMAIL: 'closeout@trioharness.local' };
}
const refExists = (dir, ref) => { try { git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]); return true; } catch { return false; } };
function freshRefName(dir, base, tree) {
  let name = base, n = 1;
  while (refExists(dir, name)) {
    try { if (git(dir, ['rev-parse', `refs/heads/${name}^{tree}`]).trim() === tree) return { name, reuse: true }; } catch { /* differing */ }
    name = `${base}-${++n}`;
  }
  return { name, reuse: false };
}

// Work tree content as a git tree, built on a temporary index (real index, branch and working tree untouched).
// The harness's own folder never enters it.
function workTree(wpath, env) {
  git(wpath, ['read-tree', 'HEAD'], { env });
  git(wpath, ['add', '-A'], { env });
  try { git(wpath, ['rm', '-r', '--cached', '--ignore-unmatch', '-q', '--', '.trioharness-direct'], { env }); } catch { /* none */ }
  // OS litter that HEAD does not track stays out of the snapshot.
  try {
    const inHead = new Set(git(wpath, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean));
    const junk = git(wpath, ['ls-files', '-z'], { env }).split('\0').filter(f => f && OS_JUNK.test(f) && !inHead.has(f));
    for (let i = 0; i < junk.length; i += 100) git(wpath, ['--literal-pathspecs', 'rm', '--cached', '--ignore-unmatch', '-q', '--', ...junk.slice(i, i + 100)], { env });
  } catch { /* nothing to drop */ }
  return git(wpath, ['write-tree'], { env }).trim();
}
export function currentTree(wpath) {
  const tmp = mkdtempSync(join(tmpdir(), 'thl-closeout-'));
  try { return workTree(wpath, { GIT_INDEX_FILE: join(tmp, 'index') }); } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } }
}
const NUL = /\0/g;
export const secretsIn = buf => findSecrets(buf.toString('latin1').replace(NUL, '')).length;

// Returns { ref, commit, tree } | { clean: true, tree } | { refused: [...] }. Secret hits report rule and file only.
export function snapshotDirty(wpath, { branch, now = new Date() } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'thl-closeout-'));
  const env = { GIT_INDEX_FILE: join(tmp, 'index'), ...identityEnv(wpath) };
  try {
    const tree = workTree(wpath, env);
    const headTree = git(wpath, ['rev-parse', 'HEAD^{tree}']).trim();
    if (tree === headTree) return { clean: true, tree };
    const refused = [];
    const raw = gitBuf(wpath, ['diff-tree', '-r', '-z', '--no-renames', 'HEAD', tree]).toString('utf8').split('\0');
    let total = 0; const scan = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const m = raw[i].match(/^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/);
      if (!m) continue;
      const [, , newMode, oldSha, sha, status] = m; const file = raw[i + 1];
      if (status === 'D') continue;
      if (newMode === '160000') { refused.push({ file, rule: 'nested-repo' }); continue; }
      const rule = isSecretFile(file);
      if (rule) refused.push({ file, rule: `file:${rule}` });
      if (DATA_FILE.test(file)) refused.push({ file, rule: 'data-file' });
      let size = 0; try { size = Number(git(wpath, ['cat-file', '-s', sha]).trim()); } catch { /* ignore */ }
      total += size;
      if (size > SNAPSHOT_FILE_CAP_BYTES) { refused.push({ file, rule: `file-over-${SNAPSHOT_FILE_CAP_BYTES / 1048576}MB` }); continue; }
      scan.push({ file, sha, oldSha, status });
    }
    if (total > IGNORED_CAP_BYTES) refused.push({ file: '(all changes)', rule: `snapshot-over-${IGNORED_CAP_BYTES / 1048576}MB` });
    // Content scan only once size limits hold. It reads the blob bytes (git's textual diff skips NUL-bearing, UTF-16 and
    // -diff files); a change counts only when it adds hits over the old version, so an old finding does not block new work.
    if (!refused.length) for (const { file, sha, oldSha, status } of scan) {
      try {
        const now_ = secretsIn(gitBuf(wpath, ['cat-file', 'blob', sha]));
        const was = status === 'A' || /^0+$/.test(oldSha) ? 0 : secretsIn(gitBuf(wpath, ['cat-file', 'blob', oldSha]));
        if (now_ > was) refused.push({ file, rule: 'secret-pattern' });
      } catch { refused.push({ file, rule: 'unreadable-blob' }); }
    }
    if (refused.length) return { refused };
    const short = git(wpath, ['rev-parse', '--short=7', 'HEAD']).trim();
    const base = `trio/wip-${san(branch || basename(wpath))}-${stamp(now)}-${short}`;
    const { name, reuse } = freshRefName(wpath, base, tree);
    if (reuse) return { ref: name, commit: git(wpath, ['rev-parse', `refs/heads/${name}`]).trim(), reused: true, tree };
    const commit = git(wpath, ['commit-tree', tree, '-p', 'HEAD', '-m', `closeout snapshot of ${branch || basename(wpath)} (uncommitted work preserved)`], { env }).trim();
    git(wpath, ['update-ref', `refs/heads/${name}`, commit]);
    return { ref: name, commit, tree };
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } }
}

function pinHead(wpath, { now = new Date() } = {}) {
  const short = git(wpath, ['rev-parse', '--short=7', 'HEAD']).trim();
  const tree = git(wpath, ['rev-parse', 'HEAD^{tree}']).trim();
  const { name } = freshRefName(wpath, `trio/wip-${san(basename(wpath))}-${stamp(now)}-${short}`, tree);
  if (!refExists(wpath, name)) git(wpath, ['update-ref', `refs/heads/${name}`, 'HEAD']);
  return name;
}

// Never follow a hosting provider's "allow this secret" link: redact locally and re-snapshot.
export function classifyPush(e) {
  const t = String(e?.stderr || e?.message || e);
  if (/GH013|push protection|secret scanning|secret.*detected/i.test(t)) return 'secret-rejected';
  if (/GH006|GH009|ruleset|protected branch|repository rule/i.test(t)) return 'ruleset-rejected';
  if (/signed|signature/i.test(t)) return 'signature-required';
  if (/non-fast-forward|fetch first|rejected/i.test(t)) return 'non-fast-forward';
  return 'other';
}
function pushRef(dir, ref, remote) {
  if (!PUSHABLE.test(ref)) return { ok: false, class: 'policy', error: `refusing to push ${ref}: agents push only codeden/*, bambooed/* or trio/*` };
  try { git(dir, ['push', remote, `refs/heads/${ref}:refs/heads/${ref}`], { timeout: 300000 }); return { ok: true }; } catch (e) { return { ok: false, class: classifyPush(e), error: firstLine(e) }; }
}

// ---------- local-only ignored files ----------

function entryBytes(full) {
  try { const st = lstatSync(full); if (st.isSymbolicLink()) return 0; return st.isDirectory() ? dirSize(full) : st.size; } catch { return 0; }
}
export function archiveIgnored(wpath, entries, dest) {
  let bytes = 0;
  for (const e of entries) bytes += entryBytes(join(wpath, e));
  if (bytes > IGNORED_CAP_BYTES) return { ok: false, bytes, reason: `local-only ignored files total ${Math.round(bytes / 1048576)} MB, over the ${IGNORED_CAP_BYTES / 1048576} MB cap` };
  let count = 0;
  for (const e of entries) {
    const src = join(wpath, e), to = join(dest, e);
    try {
      mkdirSync(join(to, '..'), { recursive: true });
      // A symlink (even a dangling one: cpSync stats the target and throws ENOENT on macOS) is recreated as a link.
      if (lstatSync(src).isSymbolicLink()) { try { rmSync(to, { force: true }); } catch { /* none */ } symlinkSync(readlinkSync(src), to); count++; continue; }
      cpSync(src, to, { recursive: true, force: true, dereference: false, verbatimSymlinks: true });
      count++;
    } catch (err) { return { ok: false, bytes, reason: `copy failed: ${firstLine(err)}` }; }
  }
  const copied = entries.reduce((a, e) => a + entryBytes(join(dest, e)), 0);
  if (copied !== bytes) return { ok: false, bytes, reason: `archive size ${copied} differs from source ${bytes}` };
  return { ok: true, bytes, count };
}

// ---------- close ----------

export function closeWorktree(info, { main, flags, run, apply, now = new Date(), staleScope = false, ledger = main }) {
  const plan = decide(info, flags);
  const out = { leaf: info.leaf, path: info.path, branch: info.branch, head: info.head, state: info.state, plan: plan.steps, blockers: [...plan.blockers], done: [], status: 'kept' };
  if (plan.verdict === 'skip') return { ...out, status: 'skipped', blockers: [plan.reason] };
  if (!apply) return { ...out, status: plan.verdict === 'keep' ? 'would-keep' : 'would-close' };
  if (plan.verdict === 'keep') return out;
  // A missing tree's HEAD may exist only in its worktree record. Preserve it before any
  // lock/ownership refusal: closeAll's final prune can remove that record even when closing is refused.
  if (plan.verdict === 'prune') {
    if (info.head && !liveRemoteContains(main, info.head, info.remote || 'origin')) { try { const ref = `trio/wip-${san(info.leaf)}-${stamp(now)}-${info.head.slice(0, 7)}`; if (!refExists(main, ref)) git(main, ['update-ref', `refs/heads/${ref}`, info.head]); out.done.push(`pinned ${ref}`); out.pinRef = ref; } catch { /* object gone */ } }
  }
  if (insideOrSame(process.cwd(), info.path)) return { ...out, status: 'skipped', blockers: ['the current directory is inside this worktree; run closeout from the main checkout'] };
  let lock = null;
  try { lock = tryAcquire(lockNameFor(info.path), { note: 'closeout' }); } catch { lock = null; }
  if (!lock?.acquired) return { ...out, status: 'skipped', blockers: [`its run-lock is held by pid ${lock?.holder?.pid ?? '?'}`] };
  try {
    if (run) {
      const hold = closeoutHoldReason(readState(ledger, run));
      if (hold) return { ...out, blockers: [hold] };
      const scans = [activeRegistered(main)];
      if (normPath(ledger) !== normPath(main)) scans.push(activeRegistered(ledger));
      const owners = new Set(scans.flatMap(scan => [...(scan.registrations.get(normPath(info.path)) || [])].filter(([id, status]) => id === run || status !== 'finished').map(([id]) => id)));
      if (scans.some(scan => scan.unknown) || owners.size !== 1 || !owners.has(run)) return {
        ...out, status: 'skipped', blockers: ['ownership shared with another run or unknown/unreadable (checked under the lock)']
      };
    }
    if (plan.verdict === 'prune') {
      try {
        git(main, ['worktree', 'prune']);
        if (listWorktrees(main).some(w => normPath(w.path) === normPath(info.path))) return { ...out, blockers: ['the folder is gone but git still lists the worktree (locked?): run git worktree unlock, then prune'] };
        return { ...out, status: 'closed', done: [...out.done, 'prune'] };
      } catch (e) { return { ...out, blockers: [firstLine(e)] }; }
    }
    if (staleScope) { const busyNow = activeRegistered(main); if (busyNow.unknown || busyNow.has(normPath(info.path))) return { ...out, status: 'skipped', blockers: ['registered to an active run (checked under the lock)'] }; }
    let preservedDirt = false, expectTree = null;
    ensureExcluded(main);
    if (plan.steps.includes('snapshot')) {
      const s = snapshotDirty(info.path, { branch: info.branch, now });
      if (s.refused) return { ...out, blockers: [`snapshot refused: ${[...new Set(s.refused.map(r => `${r.rule} in ${r.file}`))].slice(0, 5).join('; ')}`] };
      if (s.ref) {
        out.done.push(`snapshot ${s.ref}`); out.snapshotRef = s.ref;
        const p = flags.push ? pushRef(main, s.ref, info.remote || 'origin') : { ok: false, error: 'not pushed (no --push)' };
        if (p.ok) out.done.push(`pushed ${s.ref}`);
        else if (!flags.localOk) return { ...out, blockers: [`snapshot ${s.ref} is only local: ${p.error}; pass --push, or --local-ok to accept a local ref`] };
      }
      preservedDirt = true; expectTree = s.tree;
    }
    if (plan.steps.includes('pin-head')) { const ref = pinHead(info.path, { now }); out.done.push(`pinned ${ref}`); out.pinRef = ref; if (flags.push) { const p = pushRef(main, ref, info.remote || 'origin'); out.done.push(p.ok ? `pushed ${ref}` : `not pushed: ${p.error}`); if (!p.ok && !flags.localOk) return { ...out, blockers: [`pinned ref ${ref} is only local: ${p.error}`] }; } else if (!flags.localOk) return { ...out, blockers: [`detached commits pinned on ${ref} (local); pass --push or --local-ok`] }; }
    if (plan.steps.includes('push')) {
      const p = pushRef(info.path, info.branch, info.remote || 'origin');
      if (!p.ok) return { ...out, blockers: [`push failed: ${p.error}`] };
      out.done.push(`pushed ${info.branch}`);
    }
    try {
      ensureExcluded(main);
      const sub = san(info.branch || info.leaf);
const planned = archiveRuns(info.path, { repo: main, branch: info.branch || 'detached', apply: true, onlyFinished: false, force: true });
      const left = planned.flatMap(r => r.secretHits || []);
      if (left.length) return { ...out, blockers: [`run files that cannot be archived safely (secret-shaped or unscannable): ${[...new Set(left.map(h => basename(String(h.file))))].slice(0, 5).join(', ')}; resolve them, then rerun`] };
      if (plan.steps.includes('archive-ignored')) {
        const entries = localOnlyIgnored(info.path);
        const dest = join(main, '.trioharness-direct', 'archive', sub, run || info.leaf, 'ignored-files');
        const a = archiveIgnored(info.path, entries, dest);
        if (!a.ok) return { ...out, blockers: [a.reason] };
        out.done.push(`archived ${a.count} local-only ignored entr${a.count === 1 ? 'y' : 'ies'} (${Math.round(a.bytes / 1024)} KB)`);
      }
    } catch (e) { return { ...out, blockers: [`archive failed: ${firstLine(e)}`] }; }
    if (preservedDirt) { // nothing may have been written since the snapshot: --force would destroy it
      let now2 = null; try { now2 = currentTree(info.path); } catch { now2 = null; }
      if (now2 !== expectTree) return { ...out, blockers: ['the worktree changed while closing (new edits after the snapshot); nothing was removed, rerun closeout'] };
    }
    dropOsLitter(info.path); // untracked Finder/Explorer litter would make `worktree remove` refuse a tree that is otherwise clean
    try { git(main, ['worktree', 'remove', ...(preservedDirt ? ['--force'] : []), '--', info.path]); } catch (e) { return { ...out, blockers: [`worktree remove failed: ${firstLine(e)}`] }; }
    if (existsSync(info.path)) return { ...out, blockers: ['worktree record removed but the folder remains (long path or open handle); delete it by hand'] };
    out.done.push('removed');
    return { ...out, status: 'closed', blockers: [] };
  } finally { if (lock?.acquired) release(lock.file); }
}

// Trees registered by a run that has not finished: another session may be working in them right now.
export function activeRegistered(main) {
  const busy = new Set(); const dir = join(main, '.trioharness-direct', 'runs');
  // Keep run ids alongside the busy set so audit attribution uses the same state scan.
  busy.registrations = new Map();
  let ids = []; try { ids = readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') busy.unknown = true; return busy; }
  for (const id of ids) {
    try {
      if (!statSync(join(dir, id)).isDirectory()) continue;
      const st = readState(main, id);
      if (st === null) {
        try { lstatSync(join(dir, id, 'state.json')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      }
      if (!st || typeof st !== 'object' || Array.isArray(st)) { busy.unknown = true; continue; }
      for (const w of st.worktrees || []) {
        const path = normPath(w.path);
        const runs = busy.registrations.get(path) || new Map();
        runs.set(id, st.finished === true ? 'finished' : 'active'); busy.registrations.set(path, runs);
        if (!st.finished) busy.add(path);
      }
    } catch { busy.unknown = true; /* unreadable state: we cannot tell which trees are busy */ }
  }
  return busy;
}

// Shared by stale selection and audit: eligibility is not permission to close a tree.
function staleEligibility(w, { ever, busy, now }) {
  let reason;
  if (ever.unknown || busy.unknown) reason = 'run state unreadable or unknown';
  else if ((busy.registrations.get(normPath(w.path))?.size || 0) > 1) reason = 'multiple run registrations';
  else if (!harnessOwns(w, ever)) reason = 'no harness ownership evidence';
  else if (!isHarnessTree(w)) reason = 'outside stale scope';
  else if (busy.has(normPath(w.path))) reason = 'registered to an active run';
  else if (!isIdle(w.path)) reason = 'tree is not idle';
  else if (!quietFor(w.path, { now })) reason = 'tree has recent activity; not quiet';
  return { staleEligible: !reason, staleReason: reason || 'idle and quiet; close safety checks still apply' };
}

// Which worktrees a close covers.
export function selectTrees(main, { run, ledger, scope, paths = [], now = Date.now() }) {
  const all = listWorktrees(main).filter(w => !w.isMain);
  if (paths.length) {
    // A path is a request about one tree, not proof that it is the harness's: a user's own worktree is never closed,
    // snapshotted or pushed from here. Only trees some run registered, or under a .trioharness root, qualify.
    const ever = registeredEver(main);
    const hit = all.filter(w => paths.some(p => normPath(p) === normPath(w.path)));
    const foreign = hit.filter(w => !harnessOwns(w, ever));
    if (foreign.length) throw new Error(`CLOSEOUT_NOT_HARNESS_TREE: ${foreign.map(w => w.path).join(', ')} was not registered by any run and is not under a .trioharness root, so it is the user's own tree; close it with git yourself`);
    return hit;
  }
  if (run) {
    const state = readState(ledger || main, run);
    if (!state) throw new Error(`CLOSEOUT_RUN_UNKNOWN: no state.json for run ${run} under ${ledger || main}; pass --ledger <repo that holds .trioharness-direct/runs/${run}>`);
    const reg = (state?.worktrees || []).map(w => normPath(w.path));
    return all.filter(w => reg.includes(normPath(w.path)));
  }
  if (scope === 'stale') { const busy = activeRegistered(main); if (busy.unknown) throw new Error('CLOSEOUT_STATE_UNREADABLE: a run state.json could not be read, so busy trees cannot be told apart; retry in a moment or fix the file'); const ever = registeredEver(main); return all.filter(w => staleEligibility(w, { ever, busy, now }).staleEligible); }
  return [];
}

export function closeAll({ repo, run, ledger, scope, paths = [], flags = {}, apply = false, remote = 'origin', now = new Date() }) {
  const main = mainCheckout(repo);
  if (!run && !scope && !paths.length) throw new Error('CLOSEOUT_SCOPE: pass --run <id>, --scope stale or --path <worktree>');
  if (apply && run) { const hold = closeoutHoldReason(readState(ledger || main, run)); if (hold) throw new Error(`CLOSEOUT_OWNER_HOLD: ${hold}`); const q = openQuestionsReason(ledger || main, run); if (q) throw new Error(`QUESTIONS_OPEN: ${q}; no tree is closed, snapshotted or pushed while a question is open`); }
  const trees = selectTrees(main, { run, ledger, scope, paths, now: +now });
  // The ledger must outlive the trees: closeout's own record and the run registry are written there afterwards.
  const ledgerDir = ledger || main;
  const clash = trees.find(w => insideOrSame(ledgerDir, w.path));
  if (run && clash) throw new Error(`CLOSEOUT_LEDGER_INSIDE_TREE: the ledger ${ledgerDir} lives inside worktree ${clash.path}, which is being closed; run closeout with --ledger <main checkout>`);
const results = trees.map(w => {
    try { return closeWorktree({ ...inspectWorktree(w, { remote }), remote }, { main, flags, run, apply, now, ledger: ledgerDir, staleScope: Boolean(scope === 'stale' && !run && !paths.length) }); } catch (e) { return { leaf: basename(w.path), path: w.path, branch: w.branch || null, state: 'error', plan: [], blockers: [`unexpected error: ${firstLine(e)}`], done: [], status: 'kept' }; }
  });
  // Registered trees git does not list for this repository are still open if they exist (another repository, a typo).
  if (run) {
    const state = readState(ledger || main, run);
    const listed = new Set(listWorktrees(main).map(w => normPath(w.path)));
    for (const rw of state?.worktrees || []) if (!listed.has(normPath(rw.path)) && existsSync(rw.path)) results.push({ leaf: basename(rw.path), path: rw.path, branch: rw.branch || null, state: 'foreign', plan: [], blockers: ['registered, but not a worktree of this repository: close it with --repo <its main checkout>'], done: [], status: 'kept' });
  }
  try { git(main, ['worktree', 'prune']); } catch { /* ignore */ }
  const closed = results.filter(r => r.status === 'closed').length;
  const open = results.filter(r => !['closed', 'would-close'].includes(r.status)).length;
  if (apply && run) { try { recordCloseout(ledger || main, run, { closed, open, detailsOnly: Boolean(paths.length), details: results.map(r => ({ leaf: r.leaf, path: realOr(r.path), branch: r.branch, head: r.head, status: r.status, blockers: r.blockers })) }); } catch { /* no ledger for this run */ } }
  return { repo: main, run: run || null, scope: scope || null, apply, closed, open, results };
}

// ---------- audit across worktrees and repositories ----------

export function auditRepo(repo, { run, now = Date.now(), maxOpen = DEFAULT_MAX_OPEN, remote = 'origin', minFreeGb = 20, measure = diskFreeMb } = {}) {
  const main = mainCheckout(repo);
  const ever = registeredEver(main), busy = activeRegistered(main);
  const trees = listWorktrees(main).filter(w => !w.isMain).map(w => {
    const runs = busy.registrations.get(normPath(w.path));
    const known = !ever.unknown && !busy.unknown && runs?.size === 1;
    const [id, status] = known ? [...runs][0] : [null, 'unknown'];
    const owner = known ? (run && id === run ? 'this-run' : `other-run:${id}`)
      : !ever.unknown && !busy.unknown && !runs?.size && underHarnessRoot(w.path) ? 'harness-unregistered' : 'unattributed';
    return { ...inspectWorktree(w, { remote }), owner, status, ...staleEligibility(w, { ever, busy, now }) };
  });
  const openCount = trees.filter(t => t.state !== 'missing').length;
  const problems = trees.filter(t => t.state !== 'clean');
  const mb = measure(main); const freeGb = mb === null || mb === undefined ? null : Math.round((mb / 1024) * 10) / 10;
  const lowDisk = minFreeGb > 0 && (freeGb === null || freeGb < minFreeGb); // unmeasurable counts as low: unknown is never enough
  return { repo: main, freeGb, lowDisk, worktrees: trees.map(t => ({ leaf: t.leaf, path: t.path, branch: t.branch, state: t.state, dirty: t.dirty ?? 0, onRemote: t.onRemote ?? null, ignoredLocal: t.ignoredLocal ?? 0, owner: t.owner, status: t.status, staleEligible: t.staleEligible, staleReason: t.staleReason })), openCount, overLimit: openCount > maxOpen, problems: problems.length };
}

export function findRepos(root, { maxDepth = 2 } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.name === '.git' && e.isDirectory())) { found.push(dir); return; }
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory() && !['node_modules', '.git'].includes(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1);
  };
  walk(resolve(root), 0);
  return found;
}

// ---------- CLI ----------

function render(report) {
  const lines = [];
  for (const r of report.results) lines.push(`${r.status.toUpperCase().padEnd(11)} ${r.leaf}  ${r.done?.length ? `[${r.done.join('; ')}]` : ''}${r.blockers?.length ? `  BLOCKED: ${r.blockers.join(' | ')}` : ''}`);
  lines.push(`${report.apply ? 'applied' : 'dry run'}: ${report.closed} closed, ${report.open} open`);
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const all = n => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
  const has = n => argv.includes(`--${n}`);
  try {
    if (cmd === 'audit') {
      const repos = opt('root') ? findRepos(opt('root')) : [resolve(opt('repo') || '.')];
      const reports = repos.map(r => { try { return auditRepo(r, { run: opt('run'), maxOpen: opt('max-open') !== undefined && Number.isFinite(Number(opt('max-open'))) ? Number(opt('max-open')) : DEFAULT_MAX_OPEN, minFreeGb: opt('min-free-gb') !== undefined && Number.isFinite(Number(opt('min-free-gb'))) ? Number(opt('min-free-gb')) : 20 }); } catch (e) { const m = firstLine(e); return /not a git repository/i.test(m) && !existsSync(join(r, '.git')) ? { repo: r, notRepo: true, worktrees: [], openCount: 0, problems: 0 } : { repo: r, error: m, worktrees: [], openCount: 0, problems: 0 }; } });
      if (has('json')) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
      else for (const r of reports) {
        process.stdout.write(`${r.repo}${r.notRepo ? '  (not a git repository: skipped)' : r.error ? `  ERROR ${r.error}` : `  (${r.openCount} linked worktree(s), ${r.problems} not clean${r.overLimit ? ', OVER LIMIT' : ''}${r.lowDisk ? `, LOW DISK (${r.freeGb ?? 'unknown'} GB free)` : ''})`}\n`);
        for (const w of r.worktrees) process.stdout.write(`  ${w.state.padEnd(13)} ${w.leaf}${w.branch ? `  [${w.branch}]` : ''}${w.dirty ? `  dirty=${w.dirty}` : ''}${w.ignoredLocal ? `  local-only-ignored=${w.ignoredLocal}` : ''}  owner=${w.owner}  status=${w.status}  stale-eligible=${w.staleEligible ? 'yes' : 'no'} (${w.staleReason})\n`);
        if (r.overLimit) process.stdout.write(`  OVER LIMIT stale-eligible candidates: ${r.worktrees.filter(w => w.staleEligible).map(w => w.path).join(', ') || 'none'}; closing them requires an owner card; audit never closes anything.\n`);
      }
      if (has('strict') && reports.some(r => r.error || r.problems || r.overLimit || r.lowDisk)) process.exitCode = 2;
    } else if (cmd === 'close') {
      const report = closeAll({ repo: resolve(opt('repo') || '.'), run: opt('run'), ledger: opt('ledger') ? resolve(opt('ledger')) : undefined, scope: opt('scope'), paths: all('path').map(p => resolve(p)), flags: { snapshot: has('snapshot'), push: has('push'), localOk: has('local-ok') }, apply: has('apply'), remote: opt('remote') || 'origin' });
      process.stdout.write(has('json') ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
      if (report.apply && report.open > 0) process.exitCode = 2;
    } else throw new Error('USAGE: audit|close');
  } catch (e) { process.stderr.write(`CLOSEOUT: ${e.message}\n`); process.exitCode = 3; }
}
