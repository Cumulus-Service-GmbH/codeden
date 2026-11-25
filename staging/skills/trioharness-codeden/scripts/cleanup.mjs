#!/usr/bin/env node
// TrioHarness Lean — safe cleanup of worktrees, build caches, stale locks and old run folders.
// Audits by default and changes nothing without --apply. Never uses --force, never deletes unmerged
// branches, never touches a worktree with uncommitted or unpushed work, and never touches the main checkout.
// Usage:
//   node cleanup.mjs [--repo .] [--remote origin] [--branch main]
//                    [--apply] [--node-modules] [--remove-worktrees] [--runs [--keep-days 14]] [--locks] [--json]
// Default --apply reclaims only regenerable artifacts in EVERY worktree of the project: a directory is deleted
// only when its name is on the allowlist, git tracks no file inside it, and git ignores it. Tracked files,
// untracked source, run ledgers and stashes are never touched.
//   --node-modules     include node_modules (slow to restore, so opt-in)
//   --remove-worktrees also remove worktrees that are clean, pushed and merged (never --force, never the main checkout)
//   --runs             also delete finished run folders older than --keep-days
//   --locks            also delete lock files whose owner process is gone
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, statfsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './is-main.mjs';

// Regenerable build/test artifacts only. A match is deleted only if git tracks nothing inside it and git ignores it.
// Remote branches that must never be deleted, whatever their merge state.
export const PROTECTED_BRANCH_PATTERNS = [/^(main|master|develop|trunk)$/i, /^release/i, /^hotfix/i, /^prod/i, /^gh-pages$/i, /^dependabot\//i, /^renovate\//i];
export const isProtectedBranch = name => PROTECTED_BRANCH_PATTERNS.some(re => re.test(name));

// A remote branch is deletable only when: not protected, not the default, merged into the default branch as it
// stands right now, no open PR, and not checked out by any local worktree.
export function classifyRemoteBranch({ name, merged, openPr, usedByWorktree, isDefault }) {
  const reasons = [];
  if (isDefault) reasons.push('default branch');
  if (isProtectedBranch(name)) reasons.push('protected name pattern');
  if (!merged) reasons.push('not merged into the default branch');
  if (openPr) reasons.push(`open pull request #${openPr}`);
  if (usedByWorktree) reasons.push('checked out by a local worktree');
  return reasons.length ? { action: 'keep', reasons } : { action: 'delete', reasons: ['merged, no open PR, no local worktree'] };
}

export const remoteBranchAuthorization = (remote, count) => `delete-${count}-branches-on-${remote}`;

export const CACHE_DIRS = ['bin', 'obj', 'TestResults', 'test-results', 'playwright-report', 'coverage', '.vs', '.vite', '.turbo', '.angular', '.nuxt', '.next', '.pytest_cache', '__pycache__', '.mypy_cache'];
export const HEAVY_DIRS = ['node_modules'];
export const SKIP_SCAN = new Set(['.git', 'node_modules', ...CACHE_DIRS]);

// Depth-limited scan for artifact directories anywhere in a worktree (monorepo friendly).
export function findArtifactDirs(root, names, { maxDepth = 4 } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // A nested repository (vendored clone, checked-out submodule) has its own tracked files that the
    // superproject's index knows nothing about: never descend into one, and never match inside it.
    if (depth > 0 && entries.some(e => e.name === '.git')) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (names.includes(e.name)) { found.push(full); continue; }
      if (depth < maxDepth && !SKIP_SCAN.has(e.name)) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

// Safe only when git tracks nothing inside and git ignores the path: that is what makes it an artifact.
export function isDisposable(worktree, dir, git) {
  const rel = dir.slice(worktree.length + 1).replace(/\\/g, '/');
  if (!rel || rel.includes('..')) return { ok: false, reason: 'path outside the worktree' };
  // The proof below is only meaningful if `dir` belongs to THIS worktree's index, not a nested repo's.
  try {
    const top = git(dir, 'rev-parse', '--show-toplevel').trim().replace(/\\/g, '/').replace(/\/$/, '');
    // Compare real paths: macOS temp dirs are symlinks (/var -> /private/var) and git reports the resolved one.
    const real = p => { try { return realpathSync(p).replace(/\\/g, '/').replace(/\/$/, ''); } catch { return p.replace(/\\/g, '/').replace(/\/$/, ''); } };
    if (real(top) !== real(worktree)) return { ok: false, reason: `inside a nested repository (${top})` };
  } catch { return { ok: false, reason: 'git could not resolve the owning repository' }; }
  if (existsSync(join(dir, '.git'))) return { ok: false, reason: 'is itself a repository' };
  let tracked = '';
  try { tracked = git(worktree, 'ls-files', '--', rel).trim(); } catch { return { ok: false, reason: 'git could not check tracked files' }; }
  if (tracked) return { ok: false, reason: 'contains tracked files' };
  try { git(worktree, 'check-ignore', '-q', '--', rel); } catch { return { ok: false, reason: 'not git-ignored' }; }
  return { ok: true, rel };
}

// Pure rule: a worktree is removable only when nothing unique would be lost.
export function classify(w) {
  const reasons = [];
  if (w.isMain) reasons.push('main checkout');
  if (w.locked) reasons.push('locked by git');
  if (w.dirty) reasons.push('uncommitted changes');
  if (w.unpushed > 0) reasons.push(`${w.unpushed} commit(s) not on the remote`);
  if (w.stashes > 0) reasons.push(`${w.stashes} stash entr(y/ies) on its branch`);
  if (w.prunable) return { action: 'prune', reasons: ['worktree folder already gone'] };
  if (!w.isMain && !w.dirty && !w.unpushed && !w.stashes && !w.locked && !w.merged && w.remoteExists) reasons.push('branch not merged into the default branch (still open)');
  if (!w.isMain && !w.dirty && !w.unpushed && !w.stashes && !w.locked && !w.merged && !w.remoteExists) reasons.push('branch neither merged nor on the remote');
  return reasons.length ? { action: 'keep', reasons } : { action: 'remove', reasons: ['clean, pushed, merged into the default branch'] };
}

export function dirSize(path, { maxEntries = 200000 } = {}) {
  let total = 0, seen = 0;
  const walk = p => {
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > maxEntries) return;
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { try { total += statSync(full).size; } catch { /* vanished */ } }
    }
  };
  if (existsSync(path)) walk(path);
  return total;
}
const mb = bytes => Math.round(bytes / 1048576);
export const humanMb = m => (m >= 1024 ? `${(m / 1024).toFixed(2)} GB` : `${m} MB`);
// Free space this user can write (bavail), not root-reserved blocks.
export function diskFreeMb(path) {
  try { const st = statfsSync(path); return mb(Math.min(st.bavail ?? st.bfree, st.bfree) * st.bsize); } catch { return null; }
}

export function inspect(repo, { remote = 'origin', branch = 'main' } = {}) {
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // stdio pipes stderr: several probes here are expected to fail (detached HEAD, no upstream) and must not print.
  const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const stashBranches = git('stash', 'list').split('\n').filter(Boolean)
    .map(l => (l.match(/on ([^:]+):/) || [])[1]).filter(Boolean);
  const worktrees = [];
  let cur = null;
  for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9).trim(), prunable: false, locked: false }; worktrees.push(cur); }
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace('refs/heads/', '');
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return worktrees.map((w, i) => {
    const exists = existsSync(w.path);
    const info = { ...w, isMain: i === 0, exists, prunable: w.prunable || !exists, dirty: false, unpushed: 0, merged: false, remoteExists: false, stashes: 0, sizeMb: 0, cacheMb: 0, nodeModulesMb: 0 };
    if (exists && !info.prunable) {
      // An unreadable worktree (dubious ownership, permissions) is reported and kept; it never aborts the sweep.
      try { gitIn(w.path, 'rev-parse', '--is-inside-work-tree'); } catch (e) {
        return { ...info, unreadable: true, action: 'keep', reasons: [`unreadable: ${String(e.message).split('\n').find(l => l.includes('fatal:')) || 'git could not read this worktree'}`] };
      }
      info.dirty = gitIn(w.path, 'status', '--porcelain', '--untracked-files=all').trim().length > 0;
      // Compare against the branch's own upstream when it has one; origin/<default> otherwise.
      let upstream = null;
      try { upstream = gitIn(w.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').trim(); } catch { upstream = null; }
      info.upstream = upstream;
      try { info.unpushed = +gitIn(w.path, 'rev-list', '--count', `${upstream || `${remote}/${branch}`}..HEAD`).trim(); } catch { info.unpushed = 0; }
      try { gitIn(repo, 'merge-base', '--is-ancestor', w.head, `${remote}/${branch}`); info.merged = true; } catch { info.merged = false; }
      try { info.remoteExists = gitIn(repo, 'ls-remote', '--heads', remote, w.branch || '').trim().length > 0; } catch { info.remoteExists = false; }
      info.stashes = w.branch ? stashBranches.filter(b => b === w.branch).length : 0;
      info.sizeMb = mb(dirSize(w.path));
      info.cacheMb = mb(CACHE_DIRS.reduce((s, d) => s + dirSize(join(w.path, d)) + dirSize(join(w.path, 'backend', d)) + dirSize(join(w.path, 'frontend', d)), 0));
      info.nodeModulesMb = mb(dirSize(join(w.path, 'node_modules')) + dirSize(join(w.path, 'frontend', 'node_modules')));
    }
    return { ...info, ...classify(info) };
  });
}

export function inspectRemoteBranches(repo, { remote = 'origin', branch = 'main', gitRun, openPrs = null, worktreeBranches = [] } = {}) {
  const git = gitRun || ((...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  const heads = git('ls-remote', '--heads', remote).split('\n').filter(Boolean)
    .map(l => { const [sha, ref] = l.split(/\s+/); return { sha, name: String(ref).replace('refs/heads/', '') }; })
    .filter(b => b.name);
  const prs = openPrs; // null = unknown (gh unavailable): then nothing is deletable
  return heads.map(b => {
    let merged = false;
    try { git('merge-base', '--is-ancestor', b.sha, `${remote}/${branch}`); merged = true; } catch { merged = false; }
    const openPr = prs === null ? 'unknown' : (prs[b.name] || null);
    const c = classifyRemoteBranch({ name: b.name, merged, openPr: openPr === 'unknown' ? 'unknown (gh not available)' : openPr, usedByWorktree: worktreeBranches.includes(b.name), isDefault: b.name === branch });
    return { ...b, merged, openPr, ...c };
  });
}

export function staleLocks(dir = join(homedir(), '.trioharness-lean', 'locks'), isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.lock')).map(f => {
    const file = join(dir, f);
    let holder = null;
    try { holder = JSON.parse(execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`], { encoding: 'utf8' })); } catch { holder = null; }
    // A lock from another host cannot be probed with kill(0): it is never considered stale here.
    const sameHost = holder && (!holder.host || holder.host === hostname());
    return { file, holder, stale: !holder || (sameHost && !isAlive(holder.pid)) };
  });
}

// A run folder is deleted only when it is old AND finished: any gate still in progress, failed or blocked keeps it.
// Finished means CLOSED: `finished: true` (written by run-state.mjs when the learning gate passes or by
// `run-state.mjs finish`), or — for runs recorded before that flag existed — every recorded gate passed
// including the final `learnings` gate. "All recorded gates passed" alone is not finished: a run between
// two gates looks exactly like that.
export function runFinished(stateText) {
  if (!stateText) return false;
  try {
    const state = JSON.parse(stateText);
    if (state.finished === true) return true;
    const gates = state.gates || {};
    return Object.keys(gates).length > 0 && Object.values(gates).every(g => g.status === 'passed') && gates.learnings?.status === 'passed';
  } catch { return false; }
}

export function oldRunDirs(repo, keepDays = 14, now = Date.now()) {
  const runs = join(repo, '.trioharness-direct', 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs).map(r => join(runs, r)).map(p => {
    let age = 0, finished = true;
    try { age = now - statSync(p).mtimeMs; } catch { return null; }
    const stateFile = join(p, 'state.json');
    finished = false;
    if (existsSync(stateFile)) { try { finished = runFinished(readFileSync(stateFile, 'utf8')); } catch { finished = false; } }
    return { path: p, old: age > keepDays * 86400000, finished, sizeMb: mb(dirSize(p)) };
  }).filter(r => r && r.old && r.finished);
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const has = n => argv.includes(`--${n}`);
  const repo = resolve(opt('repo') || '.');
  const remote = opt('remote') || 'origin', branch = opt('branch') || 'main';
  const apply = has('apply');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let fetched = true;
    try { git('fetch', '--quiet', '--prune', remote); } catch { fetched = false; process.stderr.write(`CLEANUP: could not reach ${remote}; no worktree will be removed.\n`); }
    const trees = inspect(repo, { remote, branch }).map(w => (fetched || w.action !== 'remove' ? w : { ...w, action: 'keep', reasons: [`remote ${remote} unreachable — cannot confirm the branch is pushed and merged`] }));
    const names = [...CACHE_DIRS, ...(has('node-modules') ? HEAVY_DIRS : [])];
    const removeWorktrees = has('remove-worktrees');

    // Artifacts are collected for every worktree, including ones that stay.
    for (const w of trees) {
      w.artifacts = [];
      w.skipped = [];
      if (!w.exists || w.prunable) continue;
      if (removeWorktrees && w.action === 'remove') continue; // the whole folder goes anyway
      if (w.unreadable) continue;
      for (const dir of findArtifactDirs(w.path, names)) {
        const verdict = isDisposable(w.path, dir, gitIn);
        if (verdict.ok) w.artifacts.push({ path: dir, sizeMb: mb(dirSize(dir)) });
        else w.skipped.push({ path: dir, reason: verdict.reason });
      }
      const runTmp = join(w.path, '.trioharness-direct', 'runs');
      if (existsSync(runTmp)) for (const r of readdirSync(runTmp)) {
        const t = join(runTmp, r, 'tmp');
        if (existsSync(t)) w.artifacts.push({ path: t, sizeMb: mb(dirSize(t)) });
      }
    }
    const runs = has('runs') ? oldRunDirs(repo, +(opt('keep-days') || 14)) : [];
    // Remote branches: audited only unless --apply and the user's authorization phrase are both present.
    let remoteBranches = [];
    if (has('remote-branches')) {
      if (!fetched) throw new Error(`REMOTE_UNREACHABLE: cannot verify merge state on ${remote}`);
      let openPrs = null;
      try {
        const out = execFileSync('gh', ['pr', 'list', '--repo', git('remote', 'get-url', remote).trim().replace(/\.git$/, ''), '--state', 'open', '--limit', '200', '--json', 'number,headRefName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        openPrs = Object.fromEntries(JSON.parse(out).map(p => [p.headRefName, p.number]));
      } catch { openPrs = null; }
      remoteBranches = inspectRemoteBranches(repo, { remote, branch, openPrs, worktreeBranches: trees.map(w => w.branch).filter(Boolean) });
    }
    const locks = has('locks') ? staleLocks().filter(l => l.stale) : [];
    const report = { repo, apply, fetched, removeWorktrees, worktrees: trees, oldRuns: runs, remoteBranches, staleLocks: locks.map(l => l.file), removed: [], freedMb: 0, freedByKind: { artifacts: 0, worktrees: 0, runs: 0 }, diskFreeBeforeMb: diskFreeMb(repo), diskFreeAfterMb: null, errors: [] };

    if (apply) {
      for (const w of trees) {
        if (removeWorktrees && (w.action === 'remove' || w.action === 'prune')) {
          try {
            if (w.action === 'remove') git('worktree', 'remove', w.path);   // no --force: refuses on dirty trees
            report.removed.push(w.path); report.freedMb += w.sizeMb; report.freedByKind.worktrees += w.sizeMb;
            // The branch was already proved merged into <remote>/<branch>; `git branch -d` compares against the
            // CURRENT branch instead and warns misleadingly, so verify once more here and delete quietly.
            if (w.branch) {
              try {
                git('merge-base', '--is-ancestor', w.branch, `${remote}/${branch}`);
                execFileSync('git', ['-C', repo, 'branch', '-D', w.branch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
                report.removed.push(`branch ${w.branch}`);
              } catch (e) { report.errors.push(`branch ${w.branch} kept: ${String(e.message).split('\n')[0]}`); }
            }
          } catch (e) { report.errors.push(`${w.path}: ${e.message.split('\n')[0]}`); }
          continue;
        }
        for (const art of w.artifacts) {
          try { rmSync(art.path, { recursive: true, force: true }); report.removed.push(art.path); report.freedMb += art.sizeMb; report.freedByKind.artifacts += art.sizeMb; }
          catch (e) { report.errors.push(`${art.path}: ${e.message}`); }
        }
      }
      git('worktree', 'prune');
      const deletable = remoteBranches.filter(b => b.action === 'delete');
      if (deletable.length) {
        const phrase = remoteBranchAuthorization(remote, deletable.length);
        if (opt('authorize') !== phrase) {
          report.errors.push(`remote branches not deleted: pass --authorize "${phrase}" (the user's per-run authorization)`);
        } else {
          for (const b of deletable) {
            try { git('push', remote, '--delete', b.name); report.removed.push(`${remote}/${b.name}@${b.sha.slice(0, 12)}`); }
            catch (e) { report.errors.push(`${remote}/${b.name}: ${String(e.message).split('\n')[0]}`); }
          }
        }
      }
      for (const r of runs) { try { rmSync(r.path, { recursive: true, force: true }); report.removed.push(r.path); report.freedMb += r.sizeMb; report.freedByKind.runs += r.sizeMb; } catch (e) { report.errors.push(`${r.path}: ${e.message}`); } }
      for (const l of locks) { try { rmSync(l.file, { force: true }); report.removed.push(l.file); } catch (e) { report.errors.push(`${l.file}: ${e.message}`); } }
      report.diskFreeAfterMb = diskFreeMb(repo);
    }

    if (has('json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      for (const w of trees) {
        const artMb = w.artifacts?.reduce((s, a) => s + a.sizeMb, 0) || 0;
        const label = w.unreadable ? 'SKIP' : removeWorktrees ? w.action.toUpperCase() : (w.artifacts?.length ? 'CLEAN' : 'NONE');
        process.stdout.write(`${label.padEnd(6)} ${String(w.sizeMb).padStart(6)} MB  ${w.branch || '(detached)'}  ${w.path}\n`);
        process.stdout.write(`        ${w.reasons.join('; ')}${w.artifacts?.length ? ` | artifacts: ${w.artifacts.length} dirs, ${artMb} MB` : ''}${w.skipped?.length ? ` | kept (tracked or not ignored): ${w.skipped.length}` : ''}\n`);
      }
      if (runs.length) process.stdout.write(`finished run folders older than ${opt('keep-days') || 14}d: ${runs.length} (${runs.reduce((s, r) => s + r.sizeMb, 0)} MB)\n`);
      if (locks.length) process.stdout.write(`stale locks: ${locks.length}\n`);
      if (has('remote-branches')) {
        const del = remoteBranches.filter(b => b.action === 'delete');
        const kept = remoteBranches.filter(b => b.action !== 'delete');
        process.stdout.write(`\nremote branches on ${remote}: ${del.length} deletable, ${kept.length} kept\n`);
        for (const b of del) process.stdout.write(`  DELETE ${b.name} @ ${b.sha.slice(0, 12)}\n`);
        const why = new Map();
        for (const b of kept) for (const r of b.reasons) why.set(r, (why.get(r) || 0) + 1);
        for (const [r, n] of why) process.stdout.write(`  keep (${n}): ${r}\n`);
        if (del.length) process.stdout.write(`  to delete them: rerun with --apply --remote-branches --authorize "${remoteBranchAuthorization(remote, del.length)}"\n`);
      }
      const plannedMb = trees.reduce((s, w) => s + (removeWorktrees && w.action === 'remove' ? w.sizeMb : (w.artifacts?.reduce((t, a) => t + a.sizeMb, 0) || 0)), 0) + runs.reduce((s, r) => s + r.sizeMb, 0);
      if (apply) {
        const k = report.freedByKind;
        process.stdout.write(`\nTOTAL SPACE FREED: ${humanMb(report.freedMb)} (artifacts ${humanMb(k.artifacts)}, worktrees ${humanMb(k.worktrees)}, run folders ${humanMb(k.runs)}) from ${report.removed.length} item(s)\n`);
        if (report.diskFreeBeforeMb !== null && report.diskFreeAfterMb !== null)
          process.stdout.write(`Disk free on this volume: ${humanMb(report.diskFreeBeforeMb)} → ${humanMb(report.diskFreeAfterMb)}\n`);
        if (report.errors.length) process.stdout.write(`${report.errors.length} error(s): ${report.errors.join(' | ')}\n`);
      } else {
        process.stdout.write(`\nAudit only — ${humanMb(plannedMb)} would be freed. Rerun with --apply (add --node-modules, --remove-worktrees, --runs, --locks).\n`);
      }
    }
    process.exitCode = report.errors.length ? 2 : 0;
  } catch (e) { process.stderr.write(`CLEANUP: ${e.message}\n`); process.exitCode = 3; }
}
