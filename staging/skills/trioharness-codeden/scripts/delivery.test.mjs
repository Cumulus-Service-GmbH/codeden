import test from 'node:test';
import assert from 'node:assert/strict';
import { localRepo } from './test-local-repo.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, checkPreconditions, azDeployArgs, shaMatches, waitForSha, fill, Refusal, acrBuildArgs, containerappUpdateArgs, containerappImageQueryArgs, containerappUpdateWithRevisionArgs, containerappTrafficSetArgs, containerappTrafficQueryArgs, revisionSuffix, servingRevision, buildArgsFromAppEnv, maskedBuildArgs, revisionHealthUrl, containerappRevisionShowArgs, containerappEnvQueryArgs, acrBuildArgs as acrArgs, authorizationPhrase } from './deploy.mjs';
import { setGate, readState, resumePoint, latestRun, countDispatch, auditRun } from './run-state.mjs';
import * as deployModule from './deploy.mjs'; // namespace import: the H1 additions are looked up at call time
import { validRunId } from './ids.mjs';

const template = JSON.parse(readFileSync(fileURLToPath(new URL('../templates/repo/deploy.json', import.meta.url)), 'utf8'));
const SHA = 'a'.repeat(40);
const qa = template.targets.qa, prod = template.targets.prod;
const base = { sha: SHA, env: {}, isTTY: true, shaOnRemote: true, shaOnDefault: true, sameShaOn: true };

test('deploy: template config is valid', () => { validateConfig(template); });
test('deploy: config rejects secrets and migrations', () => {
  const withSecret = structuredClone(template); withSecret.targets.qa.password = 'x';
  assert.throws(() => validateConfig(withSecret), /CONFIG_HAS_SECRET_FIELD/);
  const withMigration = structuredClone(template); withMigration.targets.qa.build.push({ command: 'dotnet', args: ['ef', 'database', 'update'] });
  assert.throws(() => validateConfig(withMigration), /MIGRATION_IN_BUILD/);
});
test('deploy: agents may deploy QA but never production', () => {
  checkPreconditions({ ...base, target: qa, targetName: 'qa', env: { OPENCODE_CONFIG_CONTENT: '{}' }, isTTY: false });
  assert.throws(() => checkPreconditions({ ...base, target: prod, targetName: 'prod', env: { OPENCODE_CONFIG_CONTENT: '' } }), /AGENT_NOT_ALLOWED/);
  assert.throws(() => checkPreconditions({ ...base, target: prod, targetName: 'prod', isTTY: false }), /INTERACTIVE_REQUIRED/);
  checkPreconditions({ ...base, target: prod, targetName: 'prod' });
});
test('deploy: SHA must be pushed; prod needs default branch and same SHA on QA', () => {
  assert.throws(() => checkPreconditions({ ...base, target: qa, targetName: 'qa', shaOnRemote: false }), /SHA_NOT_PUSHED/);
  assert.throws(() => checkPreconditions({ ...base, target: prod, targetName: 'prod', shaOnDefault: false }), /SHA_NOT_ON_DEFAULT/);
  assert.throws(() => checkPreconditions({ ...base, target: prod, targetName: 'prod', sameShaOn: false }), /PREREQUISITE_TARGET_MISMATCH/);
  assert.throws(() => checkPreconditions({ ...base, target: qa, targetName: 'qa', sha: 'abc' }), Refusal);
});
test('deploy: az arguments and placeholders', () => {
  const args = azDeployArgs({ ...qa, slot: 'staging' }, 'C:/a/b.zip');
  assert.deepEqual(args.slice(0, 2), ['webapp', 'deploy']);
  assert.ok(args.includes('zip') && args.includes('staging') && args.includes('C:/a/b.zip'));
  // az rejects unknown flags before uploading: only the global --only-show-errors exists (2.37: --only-output-errors stopped a QA deploy)
  assert.ok(args.includes('--only-show-errors') && !args.includes('--only-output-errors'));
  assert.equal(fill('-p:SourceRevisionId={sha}', { sha: SHA }), `-p:SourceRevisionId=${SHA}`);
});
test('deploy: verification waits for the health endpoint to report the SHA', async () => {
  assert.ok(!shaMatches(SHA.slice(0, 7), SHA)); assert.ok(!shaMatches('abc', SHA)); assert.ok(!shaMatches('bbbbbbb', SHA));
  let calls = 0, t = 0;
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ commit: ++calls < 3 ? 'b'.repeat(40) : SHA }) });
  const r = await waitForSha({ ...qa.health, timeoutSeconds: 100 }, SHA, { fetchImpl, sleep: async () => { t += 10000; }, now: () => t });
  assert.equal(r.verified, true);
  const never = await waitForSha({ ...qa.health, timeoutSeconds: 30 }, SHA, { fetchImpl: async () => ({ ok: false, status: 503 }), sleep: async () => { t += 10000; }, now: () => t });
  assert.equal(never.verified, false);
});

test('run-state: records gates and resumes at the first unfinished one', () => {
  const repo = localRepo('state-');
  setGate(repo, 'r1', { gate: 'base', status: 'passed', task: 'x' });
  setGate(repo, 'r1', { gate: 'route', status: 'passed' });
  setGate(repo, 'r1', { gate: 'task-card', status: 'passed' });
  setGate(repo, 'r1', { gate: 'plan-review', status: 'in_progress', next: 'dispatch Opus plan review' });
  assert.equal(latestRun(repo), 'r1');
  assert.deepEqual(resumePoint(readState(repo, 'r1')), { resumeAt: 'plan-review', status: 'in_progress', next: 'dispatch Opus plan review' });
  assert.throws(() => setGate(repo, 'r1', { gate: 'nope', status: 'passed' }), /GATE_UNKNOWN/);
  assert.throws(() => setGate(repo, '../x', { gate: 'base', status: 'passed' }), /RUN_ID_INVALID/);
});

const hasSh = process.platform !== 'win32' || spawnSync('sh', ['-c', 'exit 0']).status === 0;
test('pre-push template: agents push only task branches; humans unaffected', { skip: !hasSh && 'no sh' }, () => {
  const d = mkdtempSync(join(tmpdir(), 'hook-'));
  const remote = join(d, 'remote.git'), work = join(d, 'work');
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', work]);
  g(work, 'config', 'user.email', 't@t'); g(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'a.txt'), 'a\n'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'a');
  g(work, 'remote', 'add', 'origin', remote);
  const hook = join(work, '.git', 'hooks', 'pre-push');
  copyFileSync(fileURLToPath(new URL('../templates/repo/pre-push', import.meta.url)), hook); chmodSync(hook, 0o755);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['OPENCODE_CONFIG_CONTENT', 'CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'TRIOHARNESS_AGENT'].includes(k)));
  const agent = { ...clean, OPENCODE_CONFIG_CONTENT: '{}' };
  const run = (ref, env) => spawnSync('git', ['-C', work, 'push', '-q', 'origin', ref], { env, encoding: 'utf8' });
  const diagnostic = r => JSON.stringify({ status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error?.message });
  let result = run('HEAD:refs/heads/main', agent); assert.notEqual(result.status, 0, diagnostic(result));
  result = run('HEAD:refs/heads/trio/x', agent); assert.equal(result.status, 0, diagnostic(result));
  result = run(':refs/heads/trio/x', agent); assert.notEqual(result.status, 0, diagnostic(result));
  result = run('HEAD:refs/heads/main', clean); assert.equal(result.status, 0, diagnostic(result));
});

test('run-state: counts dispatches per role', () => {
  const repo = mkdtempSync(join(tmpdir(), 'disp-'));
  countDispatch(repo, 'r2', 'code-reviewer'); countDispatch(repo, 'r2', 'writer');
  assert.deepEqual(countDispatch(repo, 'r2', 'code-reviewer'), { 'code-reviewer': 2, writer: 1 });
  assert.throws(() => countDispatch(repo, 'r2', 'Bad Role'), /ROLE_INVALID/);
});

import { tryAcquire, release, acquire, lockNameFor, runCommand } from './run-lock.mjs';
test('run-lock: exclusive, reclaims only dead owners, never steals from live ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locks-'));
  const a = tryAcquire('build-x', { dir, pid: 111, isAlive: () => true });
  assert.equal(a.acquired, true);
  const b = tryAcquire('build-x', { dir, pid: 222, isAlive: () => true });
  assert.equal(b.acquired, false); assert.equal(b.holder.pid, 111);
  const c = tryAcquire('build-x', { dir, pid: 222, isAlive: pid => pid !== 111 });
  assert.equal(c.acquired, true);
  release(c.file, 999); assert.equal(tryAcquire('build-x', { dir, pid: 333, isAlive: () => true }).acquired, false);
  release(c.file, 222); assert.equal(tryAcquire('build-x', { dir, pid: 333, isAlive: () => true }).acquired, true);
  let t = 0;
  const timedOut = await acquire('build-x', { dir, pid: 444, isAlive: () => true, timeoutSeconds: 5, sleep: async ms => { t += ms; }, now: () => t });
  assert.equal(timedOut.acquired, false);
  assert.throws(() => tryAcquire('bad name', { dir }), /LOCK_NAME_INVALID/);
  assert.match(lockNameFor(dir), /^worktree-[0-9a-f]{16}$/);
});
test('run-lock CLI: runs the command under the lock and releases it', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./run-lock.mjs', import.meta.url)), 'run', '--name', `t-${process.pid}`, '--', process.execPath, '-e', 'process.exit(7)'], { encoding: 'utf8' });
  assert.equal(r.status, 7);
  const again = spawnSync(process.execPath, [fileURLToPath(new URL('./run-lock.mjs', import.meta.url)), 'run', '--name', `t-${process.pid}`, '--timeout', '3', '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.equal(again.status, 0);
});

test('run-lock: executables run directly; only Windows shims fall back to a quoted shell', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, shell: !!(opts && opts.shell) || !!(args && args.shell) }); return calls.length === 1 ? { error: { code: 'EINVAL' } } : { status: 4 }; };
  assert.equal(runCommand(['C:/Program Files/nodejs/npm.cmd', 'run', 'x (y)'], { platform: 'win32', spawn }), 4);
  assert.equal(calls[0].cmd, 'C:/Program Files/nodejs/npm.cmd');
  assert.equal(calls[1].cmd, '"C:/Program Files/nodejs/npm.cmd" run "x (y)"');
  assert.equal(runCommand([process.execPath, '-e', 'process.exit(3)']), 3);
});

const caTemplate = JSON.parse(readFileSync(fileURLToPath(new URL('../templates/repo/deploy.containerapp.json', import.meta.url)), 'utf8'));
for (const t of Object.values(caTemplate.targets)) { t.registry = 'myacr'; t.image = 'webchat'; }
test('deploy containerapp: template valid; build in ACR at the SHA; update by image', () => {
  validateConfig(caTemplate);
  const t = { ...caTemplate.targets.qa, container: 'web' };
  const b = acrBuildArgs(t, SHA);
  assert.deepEqual(b.slice(0, 2), ['acr', 'build']);
  assert.equal(b[b.indexOf('--image') + 1], `${t.image}:${SHA}`);
  assert.ok(b.includes(`BUILD_SHA=${SHA}`));
  assert.equal(b.at(-1), '.');
  const u = containerappUpdateArgs(t, `x.azurecr.io/${t.image}:${SHA}`);
  assert.deepEqual(u.slice(0, 2), ['containerapp', 'update']);
  assert.equal(u[u.indexOf('--container-name') + 1], 'web');
  assert.match(containerappImageQueryArgs(t).join(' '), /containers\[\?name=='web'\]/);
});
test('deploy containerapp: rejects missing registry/dockerfile and migrations in build args', () => {
  const noReg = structuredClone(caTemplate); delete noReg.targets.qa.registry;
  assert.throws(() => validateConfig(noReg), /registry required/);
  const noDf = structuredClone(caTemplate); delete noDf.targets.qa.build.dockerfile;
  assert.throws(() => validateConfig(noDf), /dockerfile required/);
  const mig = structuredClone(caTemplate); mig.targets.qa.build.buildArgs.RUN = 'dotnet ef database update';
  assert.throws(() => validateConfig(mig), /MIGRATION_IN_BUILD/);
});
test('deploy: health check without a SHA only requires a healthy response (rollback to an untagged image)', async () => {
  let t = 0;
  const r = await waitForSha({ url: 'x', shaField: 'commit', timeoutSeconds: 30 }, null, { fetchImpl: async () => ({ ok: true, text: async () => '{}' }), sleep: async () => { t += 10000; }, now: () => t });
  assert.equal(r.verified, true);
});

test('deploy: plain-text health endpoints use shaField "."', async () => {
  const { readHealthSha } = await import('./deploy.mjs');
  const r = await readHealthSha({ url: 'x', shaField: '.' }, async () => ({ ok: true, text: async () => `${SHA}\n` }));
  assert.equal(r.sha, SHA);
  const j = await readHealthSha({ url: 'x', shaField: 'commit' }, async () => ({ ok: true, text: async () => 'not json' }));
  assert.equal(j.sha, undefined);
});

import { classify, oldRunDirs, CACHE_DIRS, HEAVY_DIRS, findArtifactDirs, isDisposable, runFinished, humanMb, classifyRemoteBranch, isProtectedBranch, remoteBranchAuthorization, inspectRemoteBranches } from './cleanup.mjs';
const wt = o => ({ isMain: false, locked: false, dirty: false, unpushed: 0, stashes: 0, merged: true, remoteExists: true, prunable: false, ...o });
test('cleanup: removes only clean, pushed, merged worktrees', () => {
  assert.equal(classify(wt({})).action, 'remove');
  for (const o of [{ isMain: true }, { dirty: true }, { unpushed: 2 }, { stashes: 1 }, { locked: true }, { merged: false }, { merged: false, remoteExists: false }]) {
    assert.equal(classify(wt(o)).action, 'keep', JSON.stringify(o));
  }
  assert.equal(classify(wt({ prunable: true })).action, 'prune');
  assert.match(classify(wt({ unpushed: 3 })).reasons.join(), /not on the remote/);
});
test('cleanup: old run folders are selected only when old AND closed (a run without state is never finished)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'clean-'));
  const runs = join(repo, '.trioharness-direct', 'runs');
  for (const r of ['old-closed', 'old-nostate', 'old-open', 'new-closed']) mkdirSync(join(runs, r), { recursive: true });
  writeFileSync(join(runs, 'old-closed', 'state.json'), JSON.stringify({ finished: true, gates: { base: { status: 'passed' } } }));
  writeFileSync(join(runs, 'old-nostate', 'x.json'), '{}');
  writeFileSync(join(runs, 'old-open', 'state.json'), JSON.stringify({ gates: { base: { status: 'passed' }, build: { status: 'in-progress' } } }));
  writeFileSync(join(runs, 'new-closed', 'state.json'), JSON.stringify({ finished: true, gates: { base: { status: 'passed' } } }));
  const now = Date.now() + 30 * 86400000;
  const picked = oldRunDirs(repo, 14, now).map(r => r.path).sort();
  assert.deepEqual(picked, [join(runs, 'new-closed'), join(runs, 'old-closed')].sort(), 'only closed runs, whatever their age');
  assert.equal(oldRunDirs(repo, 14, Date.now()).length, 0, 'nothing is old yet');
  assert.ok(CACHE_DIRS.includes('obj'));
});

test('cleanup: only git-ignored, untracked artifact dirs are disposable', () => {
  const d = mkdtempSync(join(tmpdir(), 'art-'));
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', d]);
  g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't');
  writeFileSync(join(d, '.gitignore'), 'bin/\nobj/\n');
  mkdirSync(join(d, 'src', 'bin'), { recursive: true }); writeFileSync(join(d, 'src', 'bin', 'a.dll'), 'x');
  mkdirSync(join(d, 'keep', 'bin'), { recursive: true }); writeFileSync(join(d, 'keep', 'bin', 'tracked.txt'), 'y');
  g(d, 'add', '-f', '.gitignore', 'keep/bin/tracked.txt'); g(d, 'commit', '-qm', 'base');
  const found = findArtifactDirs(d, CACHE_DIRS).map(p => p.replace(/\\/g, '/'));
  assert.ok(found.some(p => p.endsWith('src/bin')));
  const gitIn = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  assert.equal(isDisposable(d, join(d, 'src', 'bin'), gitIn).ok, true);
  assert.equal(isDisposable(d, join(d, 'keep', 'bin'), gitIn).ok, false);
  mkdirSync(join(d, 'docs'), { recursive: true });
  assert.equal(isDisposable(d, join(d, 'docs'), gitIn).ok, false);
  assert.ok(HEAVY_DIRS.includes('node_modules'));
});
test('cleanup: unfinished run folders are never deleted', () => {
  assert.equal(runFinished(JSON.stringify({ gates: { base: { status: 'passed' }, review: { status: 'passed' } } })), false, 'all recorded gates passed is not closed');
  assert.equal(runFinished(JSON.stringify({ gates: { base: { status: 'passed' }, learnings: { status: 'passed' } } })), true);
  assert.equal(runFinished(JSON.stringify({ finished: true, gates: { base: { status: 'passed' } } })), true);
  assert.equal(runFinished(''), false);
  assert.equal(runFinished(JSON.stringify({ gates: { base: { status: 'passed' }, review: { status: 'blocked' } } })), false);
  assert.equal(runFinished('not json'), false);
});

test('cleanup: freed space is reported in human units', () => {
  assert.equal(humanMb(512), '512 MB');
  assert.equal(humanMb(2048), '2.00 GB');
});

test('cleanup: an unreadable worktree is kept and never removed', () => {
  const w = { isMain: false, locked: false, dirty: false, unpushed: 0, stashes: 0, merged: true, remoteExists: true, prunable: false, unreadable: true };
  assert.equal(classify({ ...w, dirty: true }).action, 'keep');
  assert.equal(classify({ ...w, unpushed: 1 }).action, 'keep');
});

test('run-state audit: flags open gates, missing gates and dispatch mismatches', () => {
  const repo = localRepo('audit-');
  setGate(repo, 'r3', { gate: 'base', status: 'passed' });
  setGate(repo, 'r3', { gate: 'review', status: 'in_progress' });
  countDispatch(repo, 'r3', 'writer');
  const a = auditRun(repo, 'r3', { workerFiles: 15, hasReviewRounds: false });
  assert.equal(a.ok, false);
  const joined = a.problems.join(' | ');
  assert.match(joined, /in progress: review/);
  assert.match(joined, /never recorded: route/);
  assert.match(joined, /disagrees with 15/);
  assert.match(joined, /CODE_REVIEW_ROUNDS/);
  assert.equal(auditRun(repo, 'missing').ok, false);
});

test('deploy containerapp: creates a suffixed revision and switches traffic to it', () => {
  const t = { ...caTemplate.targets.qa, registry: 'myacr', image: 'web' };
  assert.equal(revisionSuffix(SHA), `r${SHA.slice(0, 8)}`);
  const u = containerappUpdateWithRevisionArgs(t, `x/web:${SHA}`, SHA);
  assert.equal(u[u.indexOf('--revision-suffix') + 1], revisionSuffix(SHA));
  const tr = containerappTrafficSetArgs(t, `${t.app}--${revisionSuffix(SHA)}`);
  assert.deepEqual(tr.slice(0, 4), ['containerapp', 'ingress', 'traffic', 'set']);
  assert.equal(tr[tr.indexOf('--revision-weight') + 1], `${t.app}--${revisionSuffix(SHA)}=100`);
  assert.match(containerappTrafficQueryArgs(t).join(' '), /ingress.traffic/);
});
test('deploy containerapp: serving revision is the weighted one', () => {
  assert.equal(servingRevision('[{"revisionName":"app--old","weight":100},{"revisionName":"app--new","weight":0}]'), 'app--old');
  assert.equal(servingRevision('[{"revisionName":"a","weight":30},{"revisionName":"b","weight":70}]'), 'b');
  assert.equal(servingRevision('[{"latestRevision":true,"weight":100}]'), 'latest');
  assert.equal(servingRevision('not json'), null);
  assert.equal(servingRevision('[]'), null);
});

test('deploy: build args are read from the live app and never printed', () => {
  const map = { ENTRA_SPA_CLIENT_ID: 'VITE_ENTRA_CLIENT_ID', ENTRA_TENANT_ID: 'VITE_TENANT_ID' };
  const env = JSON.stringify([{ name: 'VITE_ENTRA_CLIENT_ID', value: 'abc-123' }, { name: 'VITE_TENANT_ID', value: 'tid-9' }, { name: 'OTHER', value: 'x' }]);
  const resolved = buildArgsFromAppEnv(map, env);
  assert.deepEqual(resolved, { ENTRA_SPA_CLIENT_ID: 'abc-123', ENTRA_TENANT_ID: 'tid-9' });
  const shown = JSON.stringify(maskedBuildArgs(map, resolved));
  assert.ok(!shown.includes('abc-123') && !shown.includes('tid-9'));
  assert.match(shown, /from app env VITE_ENTRA_CLIENT_ID/);
  assert.throws(() => buildArgsFromAppEnv(map, JSON.stringify([{ name: 'VITE_TENANT_ID', value: 't' }])), /BUILD_ARG_MISSING_ON_APP/);
  assert.throws(() => buildArgsFromAppEnv({ A: 'S' }, JSON.stringify([{ name: 'S', secretRef: 'k' }])), /BUILD_ARG_IS_SECRET/);
  assert.throws(() => buildArgsFromAppEnv(map, 'not json'), /APP_ENV_UNREADABLE/);
  const t = { ...caTemplate.targets.qa, registry: 'myacr', image: 'web' };
  assert.ok(acrArgs(t, SHA, resolved).includes('ENTRA_TENANT_ID=tid-9'));
});
test('deploy: the new revision is health-checked on its own hostname', () => {
  assert.equal(revisionHealthUrl('https://app.example.com/build-info?x=1', 'app--r1234.eastus.azurecontainerapps.io'),
    'https://app--r1234.eastus.azurecontainerapps.io/build-info?x=1');
  const t = { ...caTemplate.targets.qa, registry: 'myacr', image: 'web' };
  assert.match(containerappRevisionShowArgs(t, 'app--r1').join(' '), /revision show .*--revision app--r1/);
  assert.match(containerappEnvQueryArgs(t).join(' '), /containers\[0\]\.env/);
});

test('deploy: with-authorization lets the agent deploy only with the user\'s exact phrase', () => {
  const t = { ...prod, agentAllowed: 'with-authorization' };
  const agentEnv = { OPENCODE_CONFIG_CONTENT: '{}' };
  const args = { ...base, target: t, targetName: 'prod', env: agentEnv, isTTY: false };
  assert.throws(() => checkPreconditions(args), /AUTHORIZATION_REQUIRED/);
  assert.throws(() => checkPreconditions({ ...args, authorization: 'wrong' }), /AUTHORIZATION_REQUIRED/);
  const phrase = authorizationPhrase(t, SHA);
  assert.equal(phrase, `${t.app}:${SHA.slice(0, 12)}`);
  checkPreconditions({ ...args, authorization: phrase });
  // the other prod gates still apply
  assert.throws(() => checkPreconditions({ ...args, authorization: phrase, shaOnDefault: false }), /SHA_NOT_ON_DEFAULT/);
  assert.throws(() => checkPreconditions({ ...args, authorization: phrase, sameShaOn: false }), /PREREQUISITE_TARGET_MISMATCH/);
  // user-only mode is unchanged
  assert.throws(() => checkPreconditions({ ...base, target: prod, targetName: 'prod', env: agentEnv, isTTY: false, authorization: phrase }), /AGENT_NOT_ALLOWED/);
  const bad = structuredClone(caTemplate); bad.targets.prod.agentAllowed = 'maybe';
  assert.throws(() => validateConfig(bad), /agentAllowed must be/);
});

const rb = o => ({ name: 'trio/x', merged: true, openPr: null, usedByWorktree: false, isDefault: false, ...o });
test('cleanup: a remote branch is deletable only when merged, PR-free and unused', () => {
  assert.equal(classifyRemoteBranch(rb({})).action, 'delete');
  for (const o of [{ merged: false }, { openPr: 42 }, { usedByWorktree: true }, { isDefault: true }, { name: 'release/2026-09' }, { name: 'main' }, { openPr: 'unknown (gh not available)' }]) {
    assert.equal(classifyRemoteBranch(rb(o)).action, 'keep', JSON.stringify(o));
  }
  assert.ok(isProtectedBranch('prod-eastus') && isProtectedBranch('hotfix/a') && !isProtectedBranch('bambooed/x'));
  assert.equal(remoteBranchAuthorization('origin', 33), 'delete-33-branches-on-origin');
});
test('cleanup: remote inspection re-verifies each branch SHA against the default branch now', () => {
  const calls = [];
  const gitRun = (...a) => {
    calls.push(a.join(' '));
    if (a[0] === 'ls-remote') return 'aaa1\trefs/heads/trio/done\nbbb2\trefs/heads/trio/open\nccc3\trefs/heads/main\n';
    if (a[0] === 'merge-base' && a[2] === 'bbb2') throw new Error('not an ancestor');
    return '';
  };
  const r = inspectRemoteBranches('.', { gitRun, openPrs: { 'trio/done': 0 }, worktreeBranches: [] });
  const byName = Object.fromEntries(r.map(b => [b.name, b]));
  assert.equal(byName['trio/done'].action, 'delete');
  assert.equal(byName['trio/open'].action, 'keep');
  assert.equal(byName['main'].action, 'keep');
  assert.ok(calls.some(c => c.startsWith('merge-base --is-ancestor aaa1')));
  // with gh unavailable nothing is deletable
  const unknown = inspectRemoteBranches('.', { gitRun, openPrs: null, worktreeBranches: [] });
  assert.ok(unknown.every(b => b.action === 'keep'));
});

// ---------------------------------------------------------------- H1: D10 rollback authorization, D6 run ids
const rollbackAuthorizationPhrase = (...a) => deployModule.rollbackAuthorizationPhrase(...a);
const checkRollbackAuthorization = (...a) => deployModule.checkRollbackAuthorization(...a);
test('deploy: the rollback phrase names the revision, or the 12-character SHA when there is no revision', () => {
  const t = { ...prod, agentAllowed: 'with-authorization' };
  assert.equal(rollbackAuthorizationPhrase(t, 'app-prd--r1a2b3c4d'), `${t.app}:rollback:app-prd--r1a2b3c4d`);
  assert.equal(rollbackAuthorizationPhrase(t, SHA), `${t.app}:rollback:${SHA.slice(0, 12)}`);
  assert.notEqual(rollbackAuthorizationPhrase(t, SHA), authorizationPhrase(t, SHA), 'the deploy phrase must not double as the rollback phrase');
});
test('deploy: with-authorization lets the agent roll back only with the user\'s exact rollback phrase', () => {
  const t = { ...prod, agentAllowed: 'with-authorization' };
  const agentEnv = { OPENCODE_CONFIG_CONTENT: '{}' };
  for (const which of [{ revision: 'app-prd--rold', sha: SHA }, { revision: null, sha: SHA }]) {
    const args = { target: t, targetName: 'prod', env: agentEnv, isTTY: false, ...which };
    const phrase = rollbackAuthorizationPhrase(t, which.revision || which.sha);
    assert.throws(() => checkRollbackAuthorization(args), /AUTHORIZATION_REQUIRED/, 'missing');
    assert.throws(() => checkRollbackAuthorization({ ...args, authorization: 'wrong' }), /AUTHORIZATION_REQUIRED/, 'wrong');
    assert.throws(() => checkRollbackAuthorization({ ...args, authorization: authorizationPhrase(t, SHA) }), /AUTHORIZATION_REQUIRED/, 'the deploy phrase');
    checkRollbackAuthorization({ ...args, authorization: phrase });
    assert.throws(() => checkRollbackAuthorization({ ...args, authorization: phrase + ' ' }), /AUTHORIZATION_REQUIRED/, 'exact match only');
    // a person without a terminal needs the same phrase; at a terminal they confirm interactively instead
    const person = { ...args, env: {} };
    assert.throws(() => checkRollbackAuthorization(person), /AUTHORIZATION_REQUIRED/);
    assert.throws(() => checkRollbackAuthorization({ ...person, authorization: authorizationPhrase(t, SHA) }), /AUTHORIZATION_REQUIRED/);
    checkRollbackAuthorization({ ...person, authorization: phrase });
    checkRollbackAuthorization({ ...person, isTTY: true });
  }
  // other modes are unchanged: an agent-allowed target needs no phrase; user-only is still refused by main()'s AGENT_NOT_ALLOWED line
  const rest = { targetName: 'x', revision: 'r1', sha: SHA, env: agentEnv, isTTY: false };
  checkRollbackAuthorization({ ...rest, target: { ...qa, agentAllowed: true } });
  checkRollbackAuthorization({ ...rest, target: { ...prod, agentAllowed: false } });
});
test('ids: a run id may not start with "-" (it would read as a flag), normal ids are unchanged', () => {
  for (const bad of ['--gate', '-x', '-', '.', '..', '', 'a/b', undefined]) assert.equal(validRunId(bad), false, String(bad));
  for (const good of ['x-1', '20261028-webchat-readiness-dcb0', 'a.b_c', '0', '.resume', '_resume']) assert.equal(validRunId(good), true, good);
});

// S2-C1: full commit identity, with deterministic clocks (no live endpoint).
test('hf5b1e-s2-d-sha: shaMatches accepts only the full 40-char SHA', () => {
  for (const report of [SHA.slice(0, 7), SHA.slice(0, 39), SHA + 'a', 'g'.repeat(40), ' ' + SHA, null])
    assert.equal(shaMatches(report, SHA), false, String(report));
  assert.equal(shaMatches('g'.repeat(40), 'g'.repeat(40)), false);
});
test('hf5b1e-s2-d-sha: waitForSha does not verify on a 7-char report', async () => {
  let t = 0;
  const r = await waitForSha({ url: 'fixture', shaField: 'sha', timeoutSeconds: 1 }, SHA, {
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ sha: SHA.slice(0, 7) }) }),
    sleep: async ms => { t += ms; }, now: () => t });
  assert.equal(r.verified, false);
});
test('hf5b1e-s2-p-sha: full SHA verifies case-insensitively and null-SHA rollback waiting is unchanged', async () => {
  assert.equal(shaMatches(SHA.toUpperCase(), SHA), true);
  for (const sha of [SHA, null]) {
    let t = 0;
    const r = await waitForSha({ url: 'fixture', shaField: 'sha', timeoutSeconds: 1 }, sha, {
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(sha === null ? {} : { sha: SHA.toUpperCase() }) }),
      sleep: async ms => { t += ms; }, now: () => t });
    assert.equal(r.verified, true);
  }
});
