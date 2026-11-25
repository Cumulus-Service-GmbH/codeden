#!/usr/bin/env node
// TrioHarness Lean — deterministic guard. No model involved.
// Checks the worker's changes against the task card before review:
//   owned paths only · size limits · no binaries · no credential files · no added secrets (tree AND every
//   commit in base..HEAD) · no newly skipped/disabled tests
//   node guard.mjs --scan <file…>   scan packets / worker results / evidence files for secret-shaped lines
// Usage: node guard.mjs --base <ref|live> --owned '["src/Foo.cs","tests/Foo/"]' [--tier trivial|lean|standard] [--risky '<paths>'] [--repo .] [--max-files N] [--max-lines N]
//                       [--remote origin/main] [--fork-remote fork] [--allow-binary] [--allow-large] [--allow-main-worktree]
//   --remote: verify the server-advertised default and exact fetched tracking tip for every base.
//             Base must be that immutable tip or an ancestor; no remote means local-only, no allowlist.
//   --fork-remote: also accept an ancestor of a live, fetched branch on this configured fork.
//                  The default branch remains the sole source of allowlist entries.
//   --base live:    use merge-base(HEAD, verified default SHA) as the base — after merging the default branch into the
//                   task branch (gate 9 drift), so only this run's changes are diffed
//   --max-behind N: fail when the verified default tip is more than N commits ahead of --base.
//                   0 = the base must BE the live remote head; used at cut time and before a push.
// Exit: 0 clean · 2 violation · 3 usage/git error
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Gate paths from subdirectories: without --repo, the run ledger belongs to the worktree ROOT, never the cwd.
const worktreeRoot = d => { try { const t = execFileSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return t ? resolve(t) : resolve(d); } catch { return resolve(d); } };
import { pathToFileURL } from 'node:url';

import { redactDeep, SECRET_VALUE_PATTERNS, isSecretFile, isContentGatedFile, findSecrets, ALLOW_FILE, parseAllow, isAllowedLine, isNameAllowed, lineFingerprint } from './secret-patterns.mjs';
import { resolveForkBase, resolveTrustedDefault } from './default-ref.mjs';
import { createHash } from 'node:crypto';
import { isMain } from './is-main.mjs';
// One shared list (secret-patterns.mjs) feeds guard, jev, reclaim, secrets and the pre-push hook.
export const SECRET_PATTERNS = SECRET_VALUE_PATTERNS;
export const SKIP_PATTERNS = /\.skip\(|\bxit\(|\bxdescribe\(|\[Ignore\b|\[Fact\s*\(\s*Skip\s*=|\[Theory\s*\(\s*Skip\s*=|@Disabled\b|@pytest\.mark\.skip|\bt\.Skip\(/;

// The merge verifier's own skip-marker detector is a regex literal, not a skipped test. Exempt only its exact, known
// definition line (matched by SHA-256 of the line, CR tolerated) in exactly those two files: any other regex body, or code around it,
// stays flagged. If the verifier's regex changes, update SKIP_DETECTOR_SHA256 (a test fails until then).
const SKIP_DETECTOR_FILES = ['.github/merge-verify/merge-verify.mjs', 'skills/trioharness-lean/scripts/merge-verify.mjs'];
export const lineSha256 = text => createHash('sha256').update(text.replace(/\r$/, '')).digest('hex');
export const SKIP_DETECTOR_SHA256 = ['7ec23de374171a3ed48a999dd257d36cf4e0367e5bba253fae78a3e61447f317'];
export const isSkipDetectorDefinition = (path, text) => SKIP_DETECTOR_FILES.includes(path) && SKIP_DETECTOR_SHA256.includes(lineSha256(text));
export const normalize = p => p.replace(/\\/g, '/').replace(/^\.\//, '');
export const isOwned = (path, owned) => owned.some(o => o.endsWith('/') ? path.startsWith(o) : path === o);

// Tier limits: exceeding them means the task was routed too low and must escalate.
export const TIER_LIMITS = { trivial: { maxFiles: 2, maxLines: 40 }, lean: { maxFiles: 8, maxLines: 400 }, standard: { maxFiles: 32, maxLines: 20000 } };

// Shared audit-check binding stays below Jev in the import graph: run-state's
// synchronous acceptance checks must never import the Jev CLI back into its closure.
export const CHECK_THRESHOLDS = Object.freeze({ yes: 0.80, no: 0.20 });
export function validateAuditCheck(i) {
  if (i.mode !== 'audit' || !i.audit || i.audit.mode !== 'audit' || !i.audit.run ||
      !/^[a-f0-9]{64}$/.test(i.audit.contractSha256 || '') || !i.audit.base || !i.audit.candidate?.diffEmpty ||
      !Array.isArray(i.audit.sources) || !i.audit.sources.length || !i.audit.coverage ||
      typeof i.context !== 'string' || !i.context.trim() || !Array.isArray(i.evidence) || !i.evidence.length ||
      !Array.isArray(i.questions) || !i.questions.length || i.questions.length > 12 ||
      i.questions.some(q => typeof q?.ask !== 'string' || !q.ask.trim() || !['yes', 'no'].includes(q.expect))) throw new Error('AUDIT_CONTRACT_INVALID');
}
export function auditCheckDigest(i) {
  validateAuditCheck(i);
  // Audit-only: bind full contract evidence as well as questions/expectations and
  // harness identity. Ordinary check/plan request-state digests remain untouched.
  return createHash('sha256').update(JSON.stringify(redactDeep({ context: i.context, evidence: i.evidence,
    mode: 'audit', audit: i.audit, questions: i.questions }))).digest('hex').slice(0, 16);
}
export function auditCheckPass(input, answers) {
  validateAuditCheck(input);
  return input.questions.every((q, n) => {
    const a = answers?.[`q_${n}`];
    if (a?.type !== 'noul' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) throw new Error('AUDIT_RECEIPT_INVALID');
    return q.expect === 'no' ? a.noul <= CHECK_THRESHOLDS.no : a.noul >= CHECK_THRESHOLDS.yes;
  });
}

// Audit mode inspects committed, index and worktree diffs separately, plus
// untracked non-ignored files. Only this run's own output is excluded.
export function auditDiffPaths(repo, base, run) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `.trioharness-direct/runs/${run}/`;
  const paths = new Set([
    ...git('diff', '--name-only', '-z', '--no-renames', base, 'HEAD').split('\0'),
    ...git('diff', '--cached', '--name-only', '-z', '--no-renames', base).split('\0'),
    ...git('diff', '--name-only', '-z', '--no-renames').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0')
  ].filter(p => p && !p.startsWith(output)));
  return [...paths].sort();
}

export function guard({ repo, base, owned, remote, forkRemote, tier, risky = [], maxFiles, maxLines, maxBehind, allowBinary = false, allowLarge = false, allowMainWorktree = false, resolveDefault = resolveTrustedDefault }) {
  if (tier && !TIER_LIMITS[tier]) throw new Error(`TIER_INVALID: ${tier}`);
  const limits = TIER_LIMITS[tier || 'standard'];
  maxFiles = maxFiles ?? limits.maxFiles; maxLines = maxLines ?? limits.maxLines;
  // The exact-line allowlist can accept a secret-shaped line, so changing it always needs the standard tier.
  const riskyN = [...risky.map(normalize), ALLOW_FILE];
  const badRisky = riskyN.find(r => !r || r.includes('*') || r.includes('..') || r.startsWith('/') || /^[A-Za-z]:/.test(r));
  if (badRisky !== undefined) throw new Error(`RISKY_PATHS_INVALID: "${badRisky}" — use repo-relative files or folders ending in "/", no wildcards`);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const ownedN = owned.map(normalize);
  if (!ownedN.length || ownedN.some(o => !o || o.includes('..') || o.startsWith('/') || /^[A-Za-z]:/.test(o) || o.includes('*')))
    throw new Error('OWNED_PATHS_INVALID: repo-relative files or dirs ending in "/", no wildcards or ".."');
  // Resolve once, then use only the immutable advertised SHA for every trust-sensitive read.
  if (base === 'live' && !remote) throw new Error('BASE_LIVE_NEEDS_REMOTE: --base live requires --remote <remote>/<branch>');
  if (forkRemote !== undefined && !remote) throw new Error('FORK_NEEDS_DEFAULT: --fork-remote requires --remote');
  let trusted = null;
  if (remote) {
    try { trusted = resolveDefault({ repo, remote }); }
    catch (e) {
      if (base === 'live' && e.code === 'REMOTE_NOT_DEFAULT') {
        throw Object.assign(new Error(`BASE_LIVE_NOT_DEFAULT: ${e.message}`), { code: e.code });
      }
      throw e;
    }
  }
  if (base === 'live') base = git('merge-base', 'HEAD', trusted.sha).trim();
  const baseSha = git('rev-parse', '--verify', `${base}^{commit}`).trim();
  // No unverified base or candidate can grant an allowance.
  let allow = { entries: new Map(), names: new Set(), errors: [] };
  if (trusted) {
    try { allow = parseAllow(git('show', `${trusted.sha}:${ALLOW_FILE}`)); } catch { /* no allowlist on verified default */ }
  }
  const allowedHits = new Set(), allowedNamePaths = new Set();
  // Check working-tree attributes, or the immutable commit's attributes during history scanning.
  const suppressesDiff = (path, sha) => {
    const fields = git('check-attr', '-z', ...(sha ? [`--source=${sha}`] : []), 'diff', 'binary', '--', path).split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3)
      if ((fields[i + 1] === 'diff' && fields[i + 2] === 'unset') || (fields[i + 1] === 'binary' && fields[i + 2] === 'set')) return true;
    return false;
  };
  // Inspect actual bytes as forced-text attributes can make NUL blobs look numeric in numstat.
  const hasNul = (path, sha) => {
    if (sha) return git('ls-tree', sha, '--', path).trim() ? git('cat-file', 'blob', `${sha}:${path}`).includes('\0') : false;
    try { return readFileSync(join(repo, path)).includes(0); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  };
  // Candidates are built in a linked worktree; in the main checkout the user's own work is at risk.
  const gitDir = git('rev-parse', '--absolute-git-dir').trim().replace(/\\/g, '/');
  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir').trim().replace(/\\/g, '/');
  const isMainWorktree = gitDir.replace(/\/$/, '') === commonDir.replace(/\/$/, '');
  const violations = [];
  for (const detail of allow.errors) violations.push({ rule: 'secret-allow-invalid', detail });
  let baseBehindRemote = null;
  let forkBaseRef = null;
  if (trusted) {
    try {
      git('merge-base', '--is-ancestor', baseSha, trusted.sha);
      baseBehindRemote = Number(git('rev-list', '--count', `${baseSha}..${trusted.sha}`).trim());
    } catch {
      const fork = forkRemote === undefined ? null : resolveForkBase({ repo, remote: forkRemote, base: baseSha });
      if (fork) {
        const { behind, ...ref } = fork;
        forkBaseRef = ref;
        baseBehindRemote = behind;
      } else {
        violations.push({ rule: 'base-not-on-remote', detail: `${base} is not reachable from the verified ${remote}${forkRemote ? ' or any fetched branch on ' + forkRemote : ''}` });
      }
    }
    // resolveDefault already verified live advertisement and tracking equality. Never re-read the ref.
    if (baseBehindRemote !== null && maxBehind !== undefined && maxBehind !== null && baseBehindRemote > maxBehind) {
      const source = forkBaseRef ? `${forkBaseRef.remote}/${forkBaseRef.branch}` : remote;
      violations.push({ rule: 'base-stale', detail: `${base} is ${baseBehindRemote} commit(s) behind ${source} (max ${maxBehind}) — fetch and rebase the candidate onto ${source}, then rerun proof` });
    }
  }

  const files = new Map(); // path -> {added, deleted, binary, untracked}
  for (const line of git('diff', '--numstat', '--no-renames', base).split('\n').filter(Boolean)) {
    const [a, d, ...p] = line.split('\t');
    files.set(normalize(p.join('\t')), { added: a === '-' ? 0 : +a, deleted: d === '-' ? 0 : +d, binary: a === '-' });
  }
  // The harness's own run ledger is never part of a candidate.
  for (const p of git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean).filter(x => !normalize(x).startsWith('.trioharness-direct/'))) {
    const buf = readFileSync(join(repo, p));
    const binary = buf.subarray(0, 8000).includes(0);
    files.set(normalize(p), { added: binary ? 0 : buf.toString('utf8').split('\n').length, deleted: 0, binary, untracked: true });
  }

  const paths = [...files.keys()];
  for (const p of paths) if (!isOwned(p, ownedN)) violations.push({ rule: 'outside-owned-paths', path: p });
  const totalLines = [...files.values()].reduce((s, f) => s + f.added + f.deleted, 0);
  if (isMainWorktree && !allowMainWorktree) violations.push({ rule: 'main-worktree', detail: 'build candidates in a linked worktree (git worktree add / a Bambooed task worktree), not the main checkout; --allow-main-worktree overrides' });
  if (tier && tier !== 'standard') for (const p of paths) if (isOwned(p, riskyN)) violations.push({ rule: 'risky-path-needs-standard', path: p });
  if (!allowLarge && paths.length > maxFiles) violations.push({ rule: 'too-many-files', detail: `${paths.length} > ${maxFiles}` });
  if (!allowLarge && totalLines > maxLines) violations.push({ rule: 'too-many-lines', detail: `${totalLines} > ${maxLines}` });
  for (const [p, f] of files) if ((f.binary && (!allowBinary || isNameAllowed(allow, p))) || (isNameAllowed(allow, p) && (suppressesDiff(p) || hasNul(p)))) violations.push({ rule: 'binary-change', path: p });
  // Only exact names reviewed on the verified default can suppress name rejection; never content checks.
  for (const p of paths) { const kind = isSecretFile(p); if (isNameAllowed(allow, p)) allowedNamePaths.add(p); else if (kind) violations.push({ rule: `secret:file-${kind}`, path: p }); }

  // Scan only ADDED lines. Report location and rule, never the matched value.
  const added = [];
  let cur = null, lineNo = 0, header = false;
  for (const l of git('diff', '-U0', '--no-renames', '--no-color', base).split('\n')) {
    if (l.startsWith('diff --git ')) { header = true; cur = null; continue; }
    if (header && l.startsWith('+++ ')) { cur = l.startsWith('+++ b/') ? normalize(l.slice(6)) : null; continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/); if (h) { header = false; lineNo = +h[1]; continue; }
    if (!header && cur && l.startsWith('+')) added.push([cur, lineNo++, l.slice(1)]);
  }
  for (const [p, f] of files) if (f.untracked && !f.binary)
    readFileSync(join(repo, p), 'utf8').split('\n').forEach((t, i) => added.push([p, i + 1, t]));
  for (const [p, n, text] of added) {
    if (isAllowedLine(allow, p, text)) { if (SECRET_PATTERNS.some(([, re]) => re.test(text))) allowedHits.add(`${p}:${lineFingerprint(text).slice(0, 12)}`); }
    else for (const [rule, re] of SECRET_PATTERNS) if (re.test(text)) { violations.push({ rule: `secret:${rule}`, path: p, line: n, ...(isContentGatedFile(p) ? { file: `content-gated:${isContentGatedFile(p)}` } : {}) }); break; }
    if (SKIP_PATTERNS.test(text) && !isSkipDetectorDefinition(p, text)) violations.push({ rule: 'test-skipped-or-disabled', path: p, line: n });
  }
  // History: a push sends every commit in base..HEAD, not the final tree. A secret added in one commit
  // and removed in a later one is still pushed, so each commit's ADDED lines are scanned too.
  let commits = [];
  try { commits = git('rev-list', '--reverse', `${base}..HEAD`).split('\n').filter(Boolean); } catch { commits = []; }
  for (const sha of commits) {
    let curH = null, headerH = false;
    const binaryPaths = new Set(git('show', '--format=', '--numstat', '--no-renames', '--diff-merges=separate', sha).split('\n').flatMap(row => {
      const [a, d, ...parts] = row.split('\t');
      return a === '-' && d === '-' ? [normalize(parts.join('\t'))] : [];
    }));
    // Names first (binary credential files print no +++ header), merges with --diff-merges=separate so an
    // evil merge is seen, renames disabled so `git mv x .env` is an add.
    for (const name of git('show', '--format=', '--name-only', '--no-renames', '--diff-merges=separate', sha).split('\n').filter(Boolean)) {
      const kind = isSecretFile(normalize(name));
      if (isNameAllowed(allow, normalize(name))) {
        allowedNamePaths.add(normalize(name));
        if (binaryPaths.has(normalize(name)) || suppressesDiff(normalize(name), sha) || hasNul(normalize(name), sha))
          violations.push({ rule: 'binary-change-in-history', path: normalize(name), commit: sha.slice(0, 12) });
      } else if (kind && !violations.some(v => v.rule === `secret:file-${kind}-in-history` && v.path === normalize(name) && v.commit === sha.slice(0, 12))) violations.push({ rule: `secret:file-${kind}-in-history`, path: normalize(name), commit: sha.slice(0, 12) });
    }
    // Commit messages travel with the push too.
    const msg = git('log', '-1', '--format=%B', sha);
    for (const h of findSecrets(msg)) violations.push({ rule: `secret:${h.rule}-in-commit-message`, commit: sha.slice(0, 12) });
    const show = git('show', '-U0', '--no-color', '--no-renames', '--diff-merges=separate', '--format=', sha);
    for (const l of show.split('\n')) {
      if (l.startsWith('diff --git ')) { headerH = true; curH = null; continue; }
      if (l.startsWith('@@')) { headerH = false; continue; }
      if (headerH && l.startsWith('+++ ')) { curH = l.startsWith('+++ b/') ? normalize(l.slice(6)) : null; continue; }
      if (headerH || !curH || !l.startsWith('+')) continue;
      if (isSecretFile(curH) && !isNameAllowed(allow, curH)) continue; // unallowed names already reported
      if (isAllowedLine(allow, curH, l.slice(1))) { if (SECRET_PATTERNS.some(([, re]) => re.test(l.slice(1)))) allowedHits.add(`${curH}:${lineFingerprint(l.slice(1)).slice(0, 12)}`); continue; }
      for (const [rule, re] of SECRET_PATTERNS) if (re.test(l.slice(1))) { violations.push({ rule: `secret:${rule}-in-history`, path: curH, commit: sha.slice(0, 12) }); break; }
    }
  }
  return { clean: !violations.length, tier: tier || 'standard', mainWorktree: isMainWorktree, base, remote: remote || null, baseVerified: baseBehindRemote !== null, defaultRef: trusted ? { remote: trusted.remoteName, branch: trusted.branch, sha: trusted.sha } : null, ...(forkBaseRef && { forkBaseRef }), baseBehindRemote, changedFiles: paths.length, changedLines: totalLines, paths, allowedSecretLines: [...allowedHits].sort(), allowedNamePaths: [...allowedNamePaths].sort(), violations };
}

// Scan arbitrary files (packets, worker results, Jev inputs, proof logs) before they are read or sent.
export function scanFiles(paths) {
  const hits = [];
  for (const p of paths) {
    let text;
    try { text = readFileSync(p, 'utf8'); } catch (e) { hits.push({ file: p, rule: 'unreadable', line: 0 }); continue; }
    for (const h of findSecrets(text)) hits.push({ file: p, ...h });
  }
  return hits;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] === '--scan') {
    // `--scan <file…> -- <command…>`: scan-before-send. The command runs ONLY when every file is clean, so a packet
    // that was flagged cannot go out by mistake. A flagged scan exits 2 and the command is never started.
    const sep = argv.indexOf('--', 1);
    const files = (sep > 0 ? argv.slice(1, sep) : argv.slice(1)).filter(a => !a.startsWith('--'));
    const command = sep > 0 ? argv.slice(sep + 1) : [];
    if (sep > 0 && (!command.length || !files.length)) { process.stderr.write('GUARD: error — USAGE: --scan <file…> -- <command…>\n'); process.exitCode = 3; }
    else {
      const hits = scanFiles(files.map(f => resolve(f)));
      process.stdout.write(`${JSON.stringify({ scanned: files.length, hits }, null, 2)}\n`);
      process.stderr.write(hits.length ? `GUARD: ${hits.length} secret-shaped line(s) — remove them before this file is read, dispatched or sent${command.length ? '; the command was NOT run' : ''}\n` : `GUARD: scan clean (${files.length} file(s))\n`);
      process.exitCode = hits.length ? 2 : 0;
      if (!hits.length && command.length) {
        const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
        process.exitCode = r.error ? 3 : (r.status ?? 1);
        if (r.error) process.stderr.write(`GUARD: error — could not start the command: ${r.error.code || r.error.message}\n`);
      }
    }
  } else try {
    const ownedRaw = opt('owned') || '';
    const owned = ownedRaw.trim().startsWith('[') ? JSON.parse(ownedRaw) : ownedRaw.split(',').map(s => s.trim()).filter(Boolean);
    if (!opt('base')) throw new Error('USAGE: --base <ref> --owned <json|comma list>');
    const r = guard({ repo: opt('repo') ? resolve(opt('repo')) : worktreeRoot('.'), base: opt('base'), owned, remote: opt('remote'), forkRemote: opt('fork-remote'),
      tier: opt('tier'), risky: opt('risky') ? (opt('risky').trim().startsWith('[') ? JSON.parse(opt('risky')) : opt('risky').split(',').map(x => x.trim()).filter(Boolean)) : [],
      maxFiles: opt('max-files') ? +opt('max-files') : undefined, maxLines: opt('max-lines') ? +opt('max-lines') : undefined,
      maxBehind: opt('max-behind') !== undefined ? +opt('max-behind') : undefined,
      allowBinary: argv.includes('--allow-binary'), allowLarge: argv.includes('--allow-large'), allowMainWorktree: argv.includes('--allow-main-worktree') });
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    if (!r.baseVerified) process.stderr.write('GUARD: UNVERIFIED BASE (local result only, not promotion proof)\n');
    process.stderr.write(r.clean ? `GUARD: clean (${r.changedFiles} files, ${r.changedLines} lines)\n` : `GUARD: ${r.violations.length} violation(s)\n`);
    process.exitCode = r.clean ? 0 : 2;
  } catch (e) {
    process.stderr.write(`GUARD: error — ${e.message}\n`);
    process.exitCode = 3;
  }
}
