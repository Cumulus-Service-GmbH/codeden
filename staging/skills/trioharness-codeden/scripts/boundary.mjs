#!/usr/bin/env node
// Non-removing preservation. Callers retain admission until their publication is durable.
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, statSync, mkdirSync, mkdtempSync, openSync, closeSync, readSync, linkSync, unlinkSync, symlinkSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mainCheckout } from './reclaim.mjs';
import { normPath } from './ownership.mjs';
import { DATA_FILE, SNAPSHOT_FILE_CAP_BYTES, IGNORED_CAP_BYTES, operationInProgress, secretsIn } from './closeout.mjs';
import { isSecretFile } from './secret-patterns.mjs';
import { lockNameFor, tryAcquire, release as releaseLock } from './run-lock.mjs';
import { validRunId } from './ids.mjs';
import { isMain } from './is-main.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const fail = (reason, unknown = false) => { throw Object.assign(new Error(reason), { reason, unknown }); };
const ignoredLedger = p => p === '.trioharness-direct' || p.startsWith('.trioharness-direct/');
const taskBranch = b => /^(bambooed|trio)\//.test(b || '');
const held = s => [s?.closeout, s?.gates?.closeout].some(r => /^\s*owner-hold:/i.test(r?.note || ''));
const stopped = s => Object.values(s?.workers || {}).every(w => ['done', 'failed', 'stopped'].includes(w?.status));
function git(path, args, deadline, env = {}, buffer = false) {
  const left = deadline - Date.now(); if (left <= 0) fail('TIMEOUT', true);
  const clean = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete clean[key];
  try { return execFileSync('git', ['-C', path, ...args], { encoding: buffer ? undefined : 'utf8', env: { ...clean, ...env }, timeout: left, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { if (e.code === 'ETIMEDOUT') fail('TIMEOUT', true); throw e; }
}
export const validRegisteredState = state => state && typeof state === 'object' && !Array.isArray(state) &&
  (state.worktrees === undefined || Array.isArray(state.worktrees) && state.worktrees.every(w => w && typeof w.path === 'string' && isAbsolute(w.path)));
function worktreeRegistrations(ledgerRoot, target, seen) {
  const matches = [];
  for (const root of [join(ledgerRoot, '.trioharness-direct/runs'), join(ledgerRoot, 'trioharness-direct-runs')]) {
    let ids; try { ids = readdirSync(root); } catch (e) { if (e.code === 'ENOENT') continue; fail('NOT_OWNED', true); }
    for (const id of ids) {
      let file, fileKey, state;
      try {
        file = realpathSync(join(root, id, 'state.json'));
        fileKey = normPath(file);
        if (seen.has(fileKey)) {
          if (seen.get(fileKey) !== id) fail('WORKTREE_REGISTRATION_AMBIGUOUS');
          continue;
        }
        state = JSON.parse(readFileSync(file, 'utf8'));
        if (!validRegisteredState(state)) throw new Error();
      } catch (error) {
        if (error.reason === 'WORKTREE_REGISTRATION_AMBIGUOUS') throw error;
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
        throw Object.assign(new Error('NOT_OWNED'), { reason: 'NOT_OWNED', unknown: true, run: id });
      }
      seen.set(fileKey, id);
      for (const w of state.worktrees || []) if (normPath(w.path) === target) {
        matches.push({ run: id, state, registration: w, file, ledgerRoot });
      }
    }
  }
  return matches;
}
function stoppedJobs(jobs) {
  let names; try { names = readdirSync(jobs); } catch (e) { if (e.code === 'ENOENT') return; fail('NOT_OWNED', true); }
  for (const name of names) if (name.endsWith('.json')) {
    let job; try { job = JSON.parse(readFileSync(join(jobs, name))); } catch { fail('NOT_OWNED', true); }
    if (!['done', 'passed', 'failed', 'stopped', 'exited', 'completed', 'timeout', 'killed', 'no-slot'].includes(job?.status)) fail('NOT_OWNED');
  }
}
// The Git main checkout, explicit run ledger, and target checkout are the
// same ownership search for registration and preservation. Aliased ledgers
// may expose the same state file more than once.
export function registrationsForTree(main, path, ledger = main) {
  const seen = new Map(), target = normPath(path);
  const roots = new Map([main, ledger].map(root => [normPath(root), root]));
  const matches = [...roots.values()].flatMap(root => worktreeRegistrations(root, target, seen));
  if (!roots.has(target)) {
    matches.push(...worktreeRegistrations(path, target, seen).map(row => ({ ...row, targetLedgerOnly: true })));
  }
  return matches;
}
function authority(main, path, run, ledger = main, closedProof = false, attestedBranch = null) {
  const matches = registrationsForTree(main, path, ledger);
  const filesByRun = new Map();
  for (const row of matches) {
    const fileKey = normPath(row.file);
    if (filesByRun.has(row.run) && filesByRun.get(row.run) !== fileKey) fail('WORKTREE_REGISTRATION_AMBIGUOUS');
    filesByRun.set(row.run, fileKey);
  }
  if (matches.some(m => held(m.state))) fail('NOT_OWNED owner-hold');
  const active = matches.filter(m => m.state.finished !== true);
  const own = matches.filter(m => run ? m.run === run : !m.targetLedgerOnly);
  const registrations = matches.filter(m => !m.targetLedgerOnly || m.state.finished !== true);
  const ids = new Set(active.map(m => m.run));
  let match;
  // Attestation replaces only absent registration proof, never a registration refusal.
  if (registrations.length === 0 && !run && attestedBranch) {
    match = { run: attestedBranch.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120), synthetic: true,
      state: { scope: { files: [] } }, registration: {} };
  } else {
    if (own.length !== 1 || ids.size > 1 || (ids.size && !ids.has(own[0].run))) fail('NOT_OWNED');
    match = own[0];
  }
  const w = match.registration;
  const localRuns = join(path, '.trioharness-direct/runs');
  if (existsSync(localRuns)) {
    let ids; try { ids = readdirSync(localRuns); } catch { fail('NOT_OWNED', true); }
    for (const id of ids) {
      const dir = join(localRuns, id);
      try { if (!statSync(dir).isDirectory()) continue; } catch { fail('NOT_OWNED', true); }
      stoppedJobs(join(dir, 'jobs'));
      const file = join(dir, 'state.json'); if (!existsSync(file)) continue;
      let local; try { local = JSON.parse(readFileSync(file)); if (!validRegisteredState(local)) throw new Error(); } catch { fail('NOT_OWNED', true); }
      if (held(local)) fail('NOT_OWNED owner-hold');
      if (((match.synthetic || id !== match.run) && local.finished !== true) || local.readOnly === true || !stopped(local) ||
        (local.worktrees || []).some(w => normPath(w.path) === normPath(path) && (w.readOnly === true || ['reviewer', 'read-only', 'readonly'].includes(w.role)))) fail('NOT_OWNED');
    }
  }
  if (match.state.readOnly === true || w.readOnly === true || (['reviewer', 'read-only', 'readonly'].includes(w.role) && !(closedProof && w.role === 'reviewer' && !existsSync(path))) || !stopped(match.state)) fail('NOT_OWNED');
  if (!match.synthetic) {
    const jobDirectories = new Set([
      join(ledger, '.trioharness-direct/runs', match.run, 'jobs'),
      join(match.ledgerRoot, '.trioharness-direct/runs', match.run, 'jobs'),
      join(dirname(match.file), 'jobs'),
    ]);
    for (const jobs of jobDirectories) stoppedJobs(jobs);
  }
  return match;
}
function endpoint(path, deadline) {
  try {
    const fetch = git(path, ['remote', 'get-url', '--all', 'origin'], deadline).trim().split('\n');
    const push = git(path, ['remote', 'get-url', '--push', '--all', 'origin'], deadline).trim().split('\n');
    if (fetch.length !== 1 || push.length !== 1 || !fetch[0] || fetch[0] !== push[0]) fail('REMOTE_AMBIGUOUS');
    return fetch[0];
  } catch (e) { if (e.reason) throw e; fail('REMOTE_AMBIGUOUS'); }
}
function remote(path, branch, deadline) {
  let text; try { text = git(path, ['ls-remote', '--symref', 'origin', 'HEAD', `refs/heads/${branch}`], deadline); }
  catch (e) { if (e.reason) throw e; fail('REMOTE_UNREACHABLE', true); }
  const lines = text.trim().split('\n');
  if (lines.some(l => !/^(?:ref: refs\/heads\/[^\t\n]+|(?:[0-9a-f]{40}|[0-9a-f]{64}))\t(?:HEAD|refs\/heads\/[^\t\n]+)$/.test(l))) fail('UNKNOWN', true);
  const defaults = lines.filter(l => l.startsWith('ref: ')).map(l => l.slice(5).split('\t')[0]);
  if (defaults.length !== 1 || !lines.some(l => /^(?:[0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/.test(l))) fail('UNKNOWN', true);
  if (defaults[0] === `refs/heads/${branch}`) fail('DEFAULT_BRANCH');
  const tips = lines.filter(l => l.endsWith(`\trefs/heads/${branch}`)).map(l => l.split('\t')[0]);
  if (tips.length > 1) fail('UNKNOWN', true);
  const defaultTips = lines.filter(l => /^(?:[0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/.test(l)).map(l => l.split('\t')[0]);
  if (defaultTips.length !== 1) fail('UNKNOWN', true);
  return { defaultRef: defaults[0], defaultTip: defaultTips[0], tip: tips[0] || null };
}
function fileDigest(full, deadline) {
  const st = lstatSync(full);
  if (st.isSymbolicLink()) return `${st.mode}:${hash(readlinkSync(full))}`;
  if (!st.isFile()) fail('SECRET_OR_DATA');
  const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024), fd = openSync(full, 'r');
  try {
    for (;;) {
      if (Date.now() >= deadline) fail('TIMEOUT', true);
      const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
      digest.update(buffer.subarray(0, count));
    }
    return `${st.mode}:${digest.digest('hex')}`;
  } finally { closeSync(fd); }
}
function snapshot(path, deadline) {
  const run = args => git(path, args, deadline).trim();
  const branchResult = (() => { try { return run(['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { return null; } })();
  const entries = [...git(path, ['ls-files', '--stage', '-z'], deadline).split('\0'), ...git(path, ['ls-tree', '-r', '-z', 'HEAD'], deadline).split('\0')].filter(Boolean);
  if (entries.some(entry => entry.startsWith('160000 '))) fail('NESTED_REPO');
  const tracked = [...new Set(entries.map(entry => entry.slice(entry.indexOf('\t') + 1)))];
  const untracked = git(path, ['ls-files', '--others', '--exclude-standard', '-z'], deadline).split('\0').filter(p => p && !ignoredLedger(p) && !tracked.includes(p));
  const files = [...new Set([...tracked, ...untracked])].sort().map(p => {
    const full = join(path, p); let st;
    try { st = lstatSync(full); } catch (e) { if (e.code === 'ENOENT') return [p, null]; throw e; }
    if (st.isDirectory()) fail(existsSync(join(full, '.git')) ? 'NESTED_REPO' : 'SECRET_OR_DATA');
    return [p, fileDigest(full, deadline)];
  });
  const index = resolve(path, run(['rev-parse', '--git-path', 'index']));
  const dirtyTracked = [...new Set([['diff', 'HEAD'], ['diff', '--cached'], ['diff']].flatMap(args => git(path, [...args, '--name-only', '-z', '--no-renames'], deadline).split('\0').filter(Boolean)))];
  return { path: realpathSync(path), common: realpathSync(resolve(path, run(['rev-parse', '--git-common-dir']))), branch: branchResult,
    head: run(['rev-parse', '--verify', 'HEAD']), index, indexHash: existsSync(index) ? hash(readFileSync(index)) : null,
    files, untracked, changed: dirtyTracked, dirty: new Set([...dirtyTracked, ...untracked]).size };
}
function same(a, b, moved = [], { committed = false } = {}) {
  const skip = new Set(moved.map(m => m.path));
  return a.path === b.path && a.common === b.common && a.branch === b.branch && (committed || (a.head === b.head && a.indexHash === b.indexHash)) &&
    JSON.stringify(a.files.filter(([p]) => !skip.has(p))) === JSON.stringify(b.files);
}
function inScope(path, scope) {
  return (scope?.files || []).some(entry => {
    if (typeof entry !== 'string' || isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) return false;
    const prefix = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}
function scanFile(path, size, bytes) {
  if (isSecretFile(path) || DATA_FILE.test(path) || size > SNAPSHOT_FILE_CAP_BYTES) fail('SECRET_OR_DATA');
  if (secretsIn(bytes())) fail('SECRET_OR_DATA');
}
function scanOutgoing(path, base, head, deadline) {
  const commits = git(path, ['rev-list', head, `^${base}`], deadline).trim().split('\n').filter(Boolean);
  const seen = new Set();
  const outgoing = new Set(git(path, ['rev-list', '--objects', '--no-object-names', head, `^${base}`], deadline).trim().split('\n'));
  for (const commit of commits) {
    let total = 0;
    const changedNames = new Set(git(path, ['diff-tree', '--root', '-m', '-r', '--no-commit-id', '--name-only', '-z', commit], deadline).split('\0'));
    for (const raw of git(path, ['ls-tree', '-r', '-z', commit], deadline).split('\0').filter(Boolean)) {
      const match = /^(\d+) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(raw); if (!match) fail('UNKNOWN', true);
      const [, mode, type, sha, name] = match;
      if (mode === '160000') fail('NESTED_REPO');
      if (type !== 'blob') fail('SECRET_OR_DATA');
      if (!outgoing.has(sha) && !changedNames.has(name)) continue;
      const size = Number(git(path, ['cat-file', '-s', sha], deadline).trim()); if (!Number.isSafeInteger(size)) fail('UNKNOWN', true);
      total += size; if (total > IGNORED_CAP_BYTES) fail('SECRET_OR_DATA');
      if (!seen.has(`${name}\0${sha}`)) { scanFile(name, size, () => git(path, ['cat-file', 'blob', sha], deadline, {}, true)); seen.add(`${name}\0${sha}`); }
    }
  }
}
function scanWorking(path, snap, strays) {
  const stray = new Set(strays), changed = new Set([...snap.changed, ...snap.untracked]);
  // Scan the exact final candidate, including tracked files outside the task's scope.
  let total = 0;
  for (const [name, value] of snap.files) if (value !== null && changed.has(name) && !stray.has(name) && !ignoredLedger(name)) {
    const full = join(path, name), st = lstatSync(full); total += st.size;
    if (total > IGNORED_CAP_BYTES) fail('SECRET_OR_DATA');
    scanFile(name, st.size, () => st.isSymbolicLink() ? Buffer.from(readlinkSync(full)) : readFileSync(full));
    changed.delete(name);
  }
  // Deleted tracked paths intentionally have no candidate blob.
  if ([...changed].some(n => snap.untracked.includes(n) && !stray.has(n))) fail('UNKNOWN', true);
}
function missingSaved(repo, state, w, deadline, dryRun) {
  const detail = state?.closeout?.details?.find(d => typeof d.path === 'string' && normPath(d.path) === normPath(w.path) && d.status === 'closed');
  const branch = detail?.branch || w.branch, head = detail?.head;
  if (!detail || (w.branch && branch !== w.branch) || !taskBranch(branch) || typeof head !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) fail('MISSING', true);
  const endpointBefore = endpoint(repo, deadline), live = remote(repo, branch, deadline);
  if (live.tip !== head) {
    // Obtain only the advertised objects, without updating refs or FETCH_HEAD.
    // A deleted merged task branch is saved by ancestry of the live default.
    try {
      for (const sha of [head, live.defaultTip]) {
        try { git(repo, ['cat-file', '-e', `${sha}^{commit}`], deadline); }
        catch { if (dryRun) fail('UNKNOWN', true); git(repo, ['fetch', '--no-tags', '--no-write-fetch-head', '--', endpointBefore, sha], deadline); }
      }
      git(repo, ['merge-base', '--is-ancestor', head, live.defaultTip], deadline);
    } catch (e) { if (e.reason) throw e; fail('MISSING', true); }
  }
  if (endpoint(repo, deadline) !== endpointBefore) fail('MISSING', true);
  return { head, branch, dirty: 0, ahead: 0, action: 'clean' };
}
function callerInTree(path) {
  const cwd = normPath(process.cwd()), target = normPath(path);
  return cwd === target || cwd.startsWith(`${target}/`);
}
function saveTree(w, { repo, run, state, appOwned, dryRun, allowCleanInTree, deadline, locks, validations }) {
  const row = { path: resolve(w.path), branch: null, head: null, dirty: null, ahead: null, action: 'unknown', reason: null, parked: [], attested: appOwned ?? null };
  let committed = false, pushed = false, before, main, owner, boundEndpoint, observedRemote = false;
  try {
    if (!existsSync(w.path)) {
      if (held(state)) fail('NOT_OWNED owner-hold');
      main = mainCheckout(repo);
      authority(main, w.path, run, repo, true);
      const admission = tryAcquire(`boundary-${lockNameFor(w.path)}`, { note: 'boundary admission' }); if (!admission.acquired) fail('STATE_CHANGED'); locks.push(admission);
      const lock = tryAcquire(lockNameFor(w.path), { note: 'boundary closed tree' }); if (!lock.acquired) fail('STATE_CHANGED'); locks.push(lock);
      authority(main, w.path, run, repo, true);
      const closed = missingSaved(repo, state, w, deadline, dryRun);
      Object.assign(row, closed);
      validations.push(() => { if (existsSync(w.path)) fail('STATE_CHANGED'); authority(main, w.path, run, repo, true); });
      return row;
    }
    if (Date.now() >= deadline) fail('TIMEOUT', true);
    main = mainCheckout(w.path);
    before = snapshot(w.path, deadline); Object.assign(row, { path: before.path, branch: before.branch, head: before.head, dirty: before.dirty });
    if (normPath(main) === normPath(w.path)) fail('NOT_LINKED_WORKTREE');
    if (!before.branch) fail('DETACHED');
    const codeDen = Boolean(run && before.branch.startsWith('codeden/') && w.branch === before.branch);
    if (!taskBranch(before.branch) && !codeDen) fail('NOT_TASK_BRANCH');
    if (operationInProgress(w.path)) fail('OPERATION_IN_PROGRESS');
    const checkOwner = () => {
      const match = authority(main, w.path, run, repo, false, appOwned ? before.branch : null);
      if (codeDen && match.registration.branch !== before.branch) fail('NOT_TASK_BRANCH');
      return match;
    };
    owner = checkOwner();
    const inTree = callerInTree(w.path);
    if (inTree && !allowCleanInTree) fail('CALLER_IN_WORKTREE');
    const admission = tryAcquire(`boundary-${lockNameFor(w.path)}`, { note: 'boundary admission' }); if (!admission.acquired) fail('STATE_CHANGED'); locks.push(admission);
    const lock = tryAcquire(lockNameFor(w.path), { note: 'boundary save' }); if (!lock.acquired) fail('STATE_CHANGED'); locks.push(lock);
    owner = checkOwner();
    if (inTree && before.dirty) fail('CALLER_IN_WORKTREE');
    const bound = endpoint(w.path, deadline), live = remote(w.path, before.branch, deadline);
    boundEndpoint = bound; observedRemote = true;
    if (inTree && live.tip !== before.head) fail('CALLER_IN_WORKTREE');
    if (live.tip) {
      try { git(w.path, ['cat-file', '-e', `${live.tip}^{commit}`], deadline); }
      catch { if (dryRun) fail('UNKNOWN', true); try { git(w.path, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', live.tip], deadline); } catch (e) { if (e.reason) throw e; fail('REMOTE_UNREACHABLE', true); } }
      try { git(w.path, ['merge-base', '--is-ancestor', live.tip, before.head], deadline); } catch (e) { if (e.reason) throw e; fail('DIVERGED'); }
      const ahead = git(w.path, ['rev-list', '--count', `${live.tip}..${before.head}`], deadline).trim(); if (!/^\d+$/.test(ahead)) fail('UNKNOWN', true); row.ahead = Number(ahead);
    }
    const scanBase = live.tip || live.defaultTip;
    if (!live.tip) {
      try { git(w.path, ['cat-file', '-e', `${scanBase}^{commit}`], deadline); }
      catch {
        if (dryRun) fail('UNKNOWN', true);
        try {
          git(w.path, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', scanBase], deadline);
          git(w.path, ['cat-file', '-e', `${scanBase}^{commit}`], deadline);
        } catch (e) { if (e.reason) throw e; fail('UNKNOWN', true); }
      }
    }
    const strays = before.untracked.filter(p => !inScope(p, owner.state.scope));
    const strayRoot = owner.synthetic ? join(main, '.trioharness-direct', 'stray', owner.run) : join(main, '.trioharness-direct', 'runs', owner.run, 'stray');
    const destRoot = join(strayRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    const prospective = strays.map(path => ({ path, to: join(destRoot, path) }));
    if (strays.length) {
      try { git(main, ['check-ignore', '--quiet', '--', relative(main, destRoot)], deadline); } catch (e) { if (e.reason) throw e; fail('STRAY_UNSAFE'); }
      // Existing symlinked archive parents must never redirect owner bytes outside the ledger.
      let parent = dirname(destRoot); while (normPath(parent) !== normPath(main)) {
        if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) fail('STRAY_UNSAFE'); const next = dirname(parent); if (next === parent) fail('STRAY_UNSAFE'); parent = next;
      }
    }
    scanWorking(w.path, before, strays); scanOutgoing(w.path, scanBase, before.head, deadline);
    if (!same(before, snapshot(w.path, deadline))) fail('STATE_CHANGED');
    checkOwner();
    if (endpoint(w.path, deadline) !== bound) fail('STATE_CHANGED');
    if (inTree) {
      const verifyClean = () => {
        const current = snapshot(w.path, deadline);
        if (operationInProgress(w.path) || current.dirty || !same(before, current) || endpoint(w.path, deadline) !== bound) fail('STATE_CHANGED');
        checkOwner();
      };
      if (remote(w.path, before.branch, deadline).tip !== before.head) fail('STATE_CHANGED');
      verifyClean();
      validations.push(verifyClean);
      Object.assign(row, { ahead: 0, action: 'clean' });
      return row;
    }
    if (dryRun) { row.parked = prospective; row.action = before.dirty || live.tip !== before.head ? 'would-save' : 'clean'; return row; }
    for (const entry of prospective) {
      try {
        mkdirSync(dirname(entry.to), { recursive: true });
        const source = join(w.path, entry.path), st = lstatSync(source);
        const digest = full => fileDigest(full, deadline);
        if (digest(source) !== before.files.find(([p]) => p === entry.path)?.[1]) fail('STATE_CHANGED');
        // Exclusive destination creation preserves earlier partial saves, including symlinks.
        try { if (st.isSymbolicLink()) symlinkSync(readlinkSync(source), entry.to); else linkSync(source, entry.to); }
        catch (e) {
          if (e.code !== 'EXDEV') throw e;
          if (st.isSymbolicLink()) symlinkSync(readlinkSync(source), entry.to);
          else copyFileSync(source, entry.to, constants.COPYFILE_EXCL);
        }
        if (digest(entry.to) !== digest(source)) fail('STATE_CHANGED');
        unlinkSync(source); row.parked.push(entry);
      } catch (e) { if (e.reason === 'STATE_CHANGED') throw e; fail('STRAY_UNSAFE'); }
    }
    let current = snapshot(w.path, deadline); if (!same(before, current, row.parked)) fail('STATE_CHANGED');
    if (current.dirty) {
      // A synthetic task label must never address a real run's storage.
      const tmpRoot = owner.synthetic ? join(main, '.trioharness-direct/tmp/boundary', owner.run) : join(repo, '.trioharness-direct/runs', run || owner.run, 'tmp'); mkdirSync(tmpRoot, { recursive: true });
      const temp = mkdtempSync(join(tmpRoot, 'boundary-')), index = join(temp, 'index'), indexLock = `${current.index}.lock`;
      let locked = false;
      try {
        const indexEnv = { GIT_INDEX_FILE: index };
        git(w.path, ['read-tree', 'HEAD'], deadline, indexEnv);
        git(w.path, ['add', '-A', '--', '.', ':!.trioharness-direct'], deadline, indexEnv);
        const candidate = git(w.path, ['write-tree'], deadline, indexEnv).trim();
        if (!same(before, snapshot(w.path, deadline), row.parked)) fail('STATE_CHANGED');
        checkOwner();
        if (endpoint(w.path, deadline) !== bound) fail('STATE_CHANGED');
        const preCommit = remote(w.path, before.branch, deadline);
        if (preCommit.tip !== live.tip || preCommit.defaultRef !== live.defaultRef || (!live.tip && preCommit.defaultTip !== live.defaultTip)) fail('STATE_CHANGED');
        try { closeSync(openSync(indexLock, 'wx')); locked = true; } catch { fail('STATE_CHANGED'); }
        if (!same(before, snapshot(w.path, deadline), row.parked)) fail('STATE_CHANGED');
        try { git(w.path, ['commit', '--allow-empty', '-m', `wip(boundary): ${run || owner.run} ${new Date().toISOString()}`], deadline, { GIT_INDEX_FILE: index }); }
        catch (e) { if (e.reason) throw e; fail('HOOK_REJECTED'); }
        committed = true; row.action = 'committed'; row.head = git(w.path, ['rev-parse', 'HEAD'], deadline).trim();
        if (git(w.path, ['rev-parse', 'HEAD^'], deadline).trim() !== before.head || git(w.path, ['rev-parse', 'HEAD^{tree}'], deadline).trim() !== candidate || !same(before, snapshot(w.path, deadline), row.parked, { committed: true }) || snapshot(w.path, deadline).indexHash !== before.indexHash) fail('STATE_CHANGED');
        copyFileSync(index, indexLock); renameSync(indexLock, current.index); locked = false;
      } finally { if (locked) rmSync(indexLock, { force: true }); rmSync(temp, { recursive: true, force: true }); }
    }
    current = snapshot(w.path, deadline); if (current.dirty || !same(before, current, row.parked, { committed })) fail('STATE_CHANGED');
    checkOwner();
    if (endpoint(w.path, deadline) !== bound) fail('STATE_CHANGED');
    const fresh = remote(w.path, before.branch, deadline); if (fresh.tip !== live.tip || fresh.defaultRef !== live.defaultRef || (!live.tip && fresh.defaultTip !== live.defaultTip)) fail('STATE_CHANGED');
    scanOutgoing(w.path, scanBase, current.head, deadline);
    if (!same(current, snapshot(w.path, deadline))) fail('STATE_CHANGED');
    if (live.tip !== current.head) {
      try { git(w.path, ['push', '--no-follow-tags', 'origin', `refs/heads/${current.branch}:refs/heads/${current.branch}`], deadline); pushed = true; }
      catch (e) { if (e.reason) throw e; fail('PUSH_REJECTED'); }
    }
    const final = snapshot(w.path, deadline);
    if (!same(current, final) || final.dirty || remote(w.path, before.branch, deadline).tip !== final.head || endpoint(w.path, deadline) !== bound) fail('STATE_CHANGED');
    checkOwner();
    Object.assign(row, { head: final.head, dirty: 0, ahead: 0, action: committed ? 'committed+pushed' : pushed ? 'pushed' : row.parked.length ? 'parked' : 'clean' });
    validations.push(() => { if (!same(final, snapshot(w.path, deadline))) fail('STATE_CHANGED'); checkOwner(); });
  } catch (e) {
    row.reason = e.reason || 'UNKNOWN'; row.action = committed ? 'committed' : e.unknown || !e.reason ? 'unknown' : 'refused';
    if (!dryRun && ['REMOTE_UNREACHABLE', 'TIMEOUT'].includes(row.reason)) row.action = committed ? 'committed' : 'refused';
    if (before && existsSync(w.path)) try {
      const final = snapshot(w.path, deadline); Object.assign(row, { head: final.head, branch: final.branch, dirty: final.dirty });
      row.ahead = null;
      // A failed push or hook may still have side effects; report a fresh count.
      if (observedRemote) try {
        if (endpoint(w.path, deadline) === boundEndpoint) {
          const after = remote(w.path, final.branch, deadline);
          if (after.tip) {
            const count = git(w.path, ['rev-list', '--count', `${after.tip}..${final.head}`], deadline).trim();
            if (/^\d+$/.test(count)) row.ahead = Number(count);
          }
        }
      } catch { /* remote proof is unavailable: ahead remains unknown */ }
    } catch { row.head = row.dirty = row.ahead = null; }
  }
  return row;
}
export function saveBoundary({ path, repo, run, appOwned, dryRun = false, allowCleanInTree = false, deadline = Date.now() + 120000 } = {}) {
  if (appOwned !== undefined && (typeof appOwned !== 'string' || appOwned.trim().length < 8 || !path || repo || run)) throw new Error('USAGE');
  const locks = [], validations = []; let trees, state;
  const release = () => { for (const lock of locks.splice(0)) releaseLock(lock.file); };
  try {
    if (path) {
      if (repo || run) throw new Error('USAGE');
      if (!existsSync(path)) return { output: { ok: false, checkouts: [{ path: resolve(path), branch: null, head: null, dirty: null, ahead: null, action: 'unknown', reason: 'MISSING', parked: [], attested: appOwned ?? null }] }, release, validate() {} };
      repo = mainCheckout(path); trees = [{ path }];
    } else {
      if (!repo || !validRunId(run)) throw new Error('USAGE'); repo = resolve(repo);
      try { const canonical = join(repo, '.trioharness-direct/runs', run, 'state.json');
        state = JSON.parse(readFileSync(existsSync(canonical) ? canonical : join(repo, 'trioharness-direct-runs', run, 'state.json'), 'utf8')); if (!validRegisteredState(state)) throw new Error(); trees = state.worktrees || []; }
      catch {
        return { output: { ok: false, checkouts: [{ path: repo, branch: null, head: null, dirty: null, ahead: null, action: 'unknown', reason: 'UNKNOWN', parked: [], attested: null }] }, release, validate() {} };
      }
    }
    const save = w => saveTree(w, { repo, run, state, appOwned, dryRun, allowCleanInTree, deadline, locks, validations });
    // Prove every tree containing the caller before modifying any other tree.
    const callerResults = new Map();
    for (const w of trees.filter(w => callerInTree(w.path))) {
      const row = save(w);
      if (row.reason) {
        return { output: { ok: false, checkouts: [row] }, release, validate() {} };
      }
      callerResults.set(w, row);
    }
    const checkouts = trees.map(w => callerResults.get(w) ?? save(w));
    const output = { ok: checkouts.every(r => !r.reason && !['would-save', 'unknown', 'refused'].includes(r.action)), checkouts };
    return { output, release, validate() { for (const check of validations) check(); } };
  } catch (e) { release(); throw e; }
}
export function runCli(argv) {
  if (argv.length === 1 && argv[0] === '--version') { process.stdout.write('boundary-cli 1\n'); return 0; }
  try {
    if (argv.shift() !== 'save') throw new Error('USAGE');
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i]; if (!['--path', '--repo', '--run', '--json', '--dry-run', '--app-owned'].includes(key) || Object.hasOwn(opts, key)) throw new Error('USAGE');
      opts[key] = ['--json', '--dry-run'].includes(key) ? true : argv[++i]; if (!opts[key] || (typeof opts[key] === 'string' && opts[key].startsWith('--'))) throw new Error('USAGE');
    }
    if (!opts['--json'] || (opts['--path'] ? opts['--repo'] || opts['--run'] : !opts['--repo'] || !opts['--run'])) throw new Error('USAGE');
    const result = saveBoundary({ path: opts['--path'], repo: opts['--repo'], run: opts['--run'], appOwned: opts['--app-owned'], dryRun: Boolean(opts['--dry-run']) });
    try { process.stdout.write(`${JSON.stringify(result.output)}\n`); return result.output.ok ? 0 : 2; } finally { result.release(); }
  } catch (e) { process.stderr.write(`${e.reason || 'USAGE_OR_INTERNAL'}\n`); return 3; }
}
if (isMain(import.meta.url)) process.exitCode = runCli(process.argv.slice(2));
