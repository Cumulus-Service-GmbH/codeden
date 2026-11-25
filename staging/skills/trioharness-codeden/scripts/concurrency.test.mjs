import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_MARKERS, scrubEnv } from './secret-patterns.mjs';
import { tryAcquire, release, recordChild, readLock } from './run-lock.mjs';
import { classifyShape } from './repo-shape.mjs';
import { stopLostJob } from './jobs.mjs';
// Hermetic: the user's own standing orders must never answer a test card.
process.env.TRIOHARNESS_HOME = process.env.TRIOHARNESS_HOME_FOR_TESTS || '/nonexistent-trioharness-home';

const HERE = import.meta.dirname;
const RUNSTATE = join(HERE, 'run-state.mjs');
const HOOK = join(HERE, '..', 'templates', 'repo', 'pre-push');
const tmp = p => mkdtempSync(join(tmpdir(), `thl-${p}-`));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('scrubbing a secret-bearing agent marker never switches the agent flag off', () => {
  const key = 'sk-' + 'a'.repeat(40);
  const { env, strippedByValue } = scrubEnv({ PATH: '/bin', OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { key } }) });
  assert.ok(strippedByValue.includes('OPENCODE_CONFIG_CONTENT'));
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(env.TRIOHARNESS_AGENT, '1');
  assert.ok(AGENT_MARKERS.includes('TRIOHARNESS_AGENT'));
  assert.equal(scrubEnv({ PATH: '/bin' }).env.TRIOHARNESS_AGENT, undefined, 'a human shell is not marked');
});

function hookRepo() {
  const bare = tmp('bare'); execFileSync('git', ['init', '--quiet', '--bare', bare]);
  const w = tmp('w'); git(w, 'init', '--quiet', '--initial-branch=main'); git(w, 'config', 'user.email', 't@example.com'); git(w, 'config', 'user.name', 'T');
  git(w, 'remote', 'add', 'origin', bare);
  writeFileSync(join(w, 'a.txt'), 'x'); git(w, 'add', '.'); git(w, 'commit', '--quiet', '-m', 'init');
  git(w, 'push', '--quiet', 'origin', 'main'); // human push, before the hook exists
  const hook = join(w, '.git', 'hooks', 'pre-push'); copyFileSync(HOOK, hook); chmodSync(hook, 0o755);
  return { bare, w };
}
const push = (w, env, ...args) => spawnSync('git', ['-C', w, 'push', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env } });

test('pre-push: a marked agent may fast-forward its task branch, never force it, never touch main; the scrub marker counts', () => {
  const { w } = hookRepo();
  git(w, 'switch', '--quiet', '-c', 'bambooed/run-A'); writeFileSync(join(w, 'b.txt'), '1'); git(w, 'add', '.'); git(w, 'commit', '--quiet', '-m', 'one');
  const agent = { TRIOHARNESS_AGENT: '1' };
  assert.equal(push(w, agent, 'origin', 'bambooed/run-A').status, 0);
  writeFileSync(join(w, 'c.txt'), '2'); git(w, 'add', '.'); git(w, 'commit', '--quiet', '-m', 'two');
  assert.equal(push(w, agent, 'origin', 'bambooed/run-A').status, 0, 'fast-forward is fine');
  git(w, 'reset', '--quiet', '--hard', 'HEAD~2'); writeFileSync(join(w, 'd.txt'), '3'); git(w, 'add', '.'); git(w, 'commit', '--quiet', '-m', 'rewrite');
  const forced = push(w, agent, '--force', 'origin', 'bambooed/run-A');
  assert.notEqual(forced.status, 0); assert.match(forced.stderr, /fast-forward/);
  const main = push(w, agent, 'origin', 'HEAD:main');
  assert.notEqual(main.status, 0); assert.match(main.stderr, /bambooed\/\* or trio\/\*/);
  assert.equal(push(w, {}, '--force', 'origin', 'bambooed/run-A').status, 0, 'a human is not bound by the ref policy');
});

test('run-lock: a stale lock is reclaimed once; a live lock is never removed by a racing reclaimer', () => {
  const dir = tmp('lock');
  const dead = () => false, live = () => true;
  assert.equal(tryAcquire('n', { dir, pid: 111 }).acquired, true);
  const got = tryAcquire('n', { dir, pid: 222, isAlive: dead });
  assert.equal(got.acquired, true); assert.equal(readLock(got.file).pid, 222);
  // B decided "stale" from an old read, but A (pid 222) is alive now: B must not remove A's lock.
  const b = tryAcquire('n', { dir, pid: 333, isAlive: pid => pid !== 111 });
  assert.equal(b.acquired, false); assert.equal(readLock(got.file).pid, 222);
  release(got.file, 222);
  assert.equal(tryAcquire('n', { dir, pid: 444, isAlive: live }).acquired, true);
  rmSync(dir, { recursive: true, force: true });
});

test('run-lock: the lock stays live while the started command lives, even if the wrapper is gone', () => {
  const dir = tmp('lock2');
  const a = tryAcquire('n', { dir, pid: 10 }); recordChild(a.file, 20, 10);
  assert.equal(readLock(a.file).childPid, 20);
  assert.equal(tryAcquire('n', { dir, pid: 30, isAlive: pid => pid === 20 }).acquired, false, 'wrapper dead, build alive');
  assert.equal(tryAcquire('n', { dir, pid: 30, isAlive: () => false }).acquired, true, 'both dead');
  rmSync(dir, { recursive: true, force: true });
});

test('state.json: 20 parallel worktree registrations are all kept', async () => {
  const repo = tmp('par');
  await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise(res => spawn(process.execPath, [RUNSTATE, 'worktree', '--repo', repo, '--run', 'par', '--path', join(repo, `t${i}`)], { stdio: 'ignore' }).on('close', res))));
  const st = JSON.parse(readFileSync(join(repo, '.trioharness-direct', 'runs', 'par', 'state.json'), 'utf8'));
  assert.equal(st.worktrees.length, 20);
  rmSync(repo, { recursive: true, force: true });
});

test('repo-shape: a deliberate non-task default (release, stable) is asked about, never changed; a task-shaped one is repaired', () => {
  const base = { hasCommits: true, hasRemote: true, want: 'main', remoteBranches: ['main', 'release'] };
  for (const d of ['release', 'stable', 'v2']) {
    const v = classifyShape({ ...base, remoteBranches: ['main', d], remoteDefault: d });
    assert.equal(v.action, 'ask', d); assert.equal(v.verdict, 'default-differs');
  }
  assert.equal(classifyShape({ ...base, remoteBranches: ['main', 'trio/x'], remoteDefault: 'trio/x' }).action, 'set-default');
  assert.equal(classifyShape({ ...base, remoteDefault: null }).action, 'set-default');
});

test('jobs stop --lost: kills an orphan only when its pid still shows the job’s command line', { skip: process.platform === 'win32' }, async () => {
  const repo = tmp('lost');
  const jobs = join(repo, '.trioharness-direct', 'runs', 'r1', 'jobs'); mkdirSync(jobs, { recursive: true });
  const child = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' }); child.unref();
  const rec = { name: 'b', run: 'r1', cmd: 'sleep 30', cwd: repo, timeoutSec: 600, startedAt: new Date().toISOString(), supervisorPid: 2147483000, pid: child.pid, status: 'running', log: 'x' };
  writeFileSync(join(jobs, 'b.json'), JSON.stringify(rec));
  assert.throws(() => stopLostJob(repo, 'r1', 'b', { psArgs: () => 'node server.js' }), /JOB_PID_NOT_VERIFIED/);
  assert.doesNotThrow(() => process.kill(child.pid, 0), 'an unverified pid is left alone');
  const out = stopLostJob(repo, 'r1', 'b');
  assert.equal(out.status, 'killed');
  await new Promise(r => setTimeout(r, 300));
  assert.throws(() => process.kill(child.pid, 0));
  assert.throws(() => stopLostJob(repo, 'r1', 'b'), /JOB_NOT_LOST/);
  rmSync(repo, { recursive: true, force: true });
});

test('handover-taken consumes HANDOVER-NEXT.md, keeps the run id and records the handoff; depth is capped', async () => {
  const { handoverTaken, setGate, readState, stalledRuns } = await import('./run-state.mjs');
  const repo = tmp('ho');
  setGate(repo, 'r1', { gate: 'base', status: 'in_progress', task: 't' });
  const dir = join(repo, '.trioharness-direct', 'runs', 'r1');
  assert.throws(() => handoverTaken(repo, 'r1', { by: 'task-2' }), /HANDOVER_NONE/);
  writeFileSync(join(dir, 'HANDOVER-NEXT.md'), '# next');
  assert.throws(() => handoverTaken(repo, 'r1', { by: 'task-2', depth: 6 }), /HANDOVER_DEPTH/);
  assert.throws(() => handoverTaken(repo, 'r1', { by: '../x' }), /HANDOVER_BY_INVALID/);
  const h = handoverTaken(repo, 'r1', { by: 'task-2', depth: 2 });
  assert.equal(existsSync(join(dir, 'HANDOVER-NEXT.md')), false); assert.equal(existsSync(join(dir, h.file)), true);
  assert.equal(readState(repo, 'r1').handoff.takenBy, 'task-2');
  assert.ok(stalledRuns(repo, { minutes: 0, now: Date.now() + 3 * 3600000 }).some(r => r.run === 'r1'), 'once taken, the run is no longer parked');
  rmSync(repo, { recursive: true, force: true });
});

// ---- regressions from the adversarial review ----
const QS = join(HERE, 'questions.mjs'), JOBS = join(HERE, 'jobs.mjs'), CLOSEOUT = join(HERE, 'closeout.mjs'), RECLAIM = join(HERE, 'reclaim.mjs');
const cardJson = JSON.stringify({ questions: [{ id: 'q1', header: 'Scope', question: 'Which scope should the change cover?', why: 'Smallest change', options: [{ id: 'a', label: 'Backend only', description: 'API and tests' }, { id: 'b', label: 'Backend and UI', description: 'Also the page' }], recommended: 'a' }] });

test('questions.mjs ask really records the card from the CLI (no unsettled top-level await), and refuses cleanly while a job runs', () => {
  const repo = tmp('ask'); writeFileSync(join(repo, 'card.json'), cardJson);
  const ok = spawnSync(process.execPath, [QS, 'ask', '--repo', repo, '--run', 'r1', '--file', join(repo, 'card.json')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr); assert.doesNotMatch(ok.stderr, /unsettled/); assert.match(ok.stdout, /"Q-1"/);
  assert.equal(JSON.parse(readFileSync(join(repo, '.trioharness-direct', 'runs', 'r1', 'questions', 'Q-1.json'), 'utf8')).status, 'open');
  const jobs = join(repo, '.trioharness-direct', 'runs', 'r2', 'jobs'); mkdirSync(jobs, { recursive: true });
  writeFileSync(join(jobs, 'b.json'), JSON.stringify({ name: 'b', run: 'r2', cmd: 'x', timeoutSec: 600, startedAt: new Date().toISOString(), supervisorPid: process.pid, status: 'running' }));
  const no = spawnSync(process.execPath, [QS, 'ask', '--repo', repo, '--run', 'r2', '--file', join(repo, 'card.json')], { encoding: 'utf8' });
  assert.equal(no.status, 3); assert.match(no.stderr, /^QUESTIONS: |JOBS_OPEN/m); assert.doesNotMatch(no.stderr, /unsettled/);
  assert.equal(existsSync(join(repo, '.trioharness-direct', 'runs', 'r2', 'questions')), false);
  rmSync(repo, { recursive: true, force: true });
});

function userTreeRepo() {
  const bare = tmp('b'); execFileSync('git', ['init', '--quiet', '--bare', bare]);
  const main = tmp('m'); git(main, 'init', '--quiet', '--initial-branch=main'); git(main, 'config', 'user.email', 't@example.com'); git(main, 'config', 'user.name', 'T');
  writeFileSync(join(main, 'a.txt'), 'x'); git(main, 'add', '.'); git(main, 'commit', '--quiet', '-m', 'init'); git(main, 'remote', 'add', 'origin', bare); git(main, 'push', '--quiet', '-u', 'origin', 'main');
  const user = join(`${main}-user`, 'mine'); mkdirSync(join(`${main}-user`), { recursive: true });
  git(main, 'worktree', 'add', '--quiet', '-b', 'feature/mine', user); writeFileSync(join(user, 'notes.txt'), 'private'); mkdirSync(join(user, 'bin')); writeFileSync(join(user, 'bin', 'x'), '1');
  return { main, user };
}

test('a user’s own worktree is refused by closeout --path and untouched by reclaim --worktree; a card blocks closeout --run', () => {
  const { main, user } = userTreeRepo();
  const c = spawnSync(process.execPath, [CLOSEOUT, 'close', '--repo', main, '--path', user, '--snapshot', '--push', '--local-ok', '--apply'], { encoding: 'utf8' });
  assert.notEqual(c.status, 0); assert.match(c.stderr + c.stdout, /CLOSEOUT_NOT_HARNESS_TREE/); assert.equal(existsSync(join(user, 'notes.txt')), true);
  spawnSync(process.execPath, [RECLAIM, '--phase', 'post-push', '--repo', main, '--worktree', user, '--apply'], { encoding: 'utf8' });
  assert.equal(existsSync(join(user, 'bin', 'x')), true);
  // registered => the harness's own; then an open card still blocks closing it
  const reg = spawnSync(process.execPath, [RUNSTATE, 'worktree', '--repo', main, '--run', 'r2', '--path', user, '--branch', 'feature/mine'], { encoding: 'utf8' }); assert.equal(reg.status, 0, reg.stderr);
  writeFileSync(join(main, 'card.json'), cardJson);
  assert.equal(spawnSync(process.execPath, [QS, 'ask', '--repo', main, '--run', 'r2', '--file', join(main, 'card.json')], { encoding: 'utf8' }).status, 0);
  const blocked = spawnSync(process.execPath, [CLOSEOUT, 'close', '--repo', main, '--run', 'r2', '--local-ok', '--apply'], { encoding: 'utf8' });
  assert.notEqual(blocked.status, 0); assert.match(blocked.stderr + blocked.stdout, /QUESTIONS_OPEN/); assert.equal(existsSync(user), true);
  const reg2 = spawnSync(process.execPath, [RUNSTATE, 'worktree', '--repo', main, '--run', 'r2', '--path', join(user, '..', 'other')], { encoding: 'utf8' });
  assert.notEqual(reg2.status, 0); assert.match(reg2.stderr, /QUESTIONS_OPEN/);
});

test('jobs _supervise (the detached entry) also refuses while a card is open', () => {
  const repo = tmp('sup'); writeFileSync(join(repo, 'card.json'), cardJson);
  assert.equal(spawnSync(process.execPath, [QS, 'ask', '--repo', repo, '--run', 'r1', '--file', join(repo, 'card.json')], { encoding: 'utf8' }).status, 0);
  const r = spawnSync(process.execPath, [JOBS, '_supervise', '--repo', repo, '--run', 'r1', '--name', 'j', '--cmd', `echo RAN > ${join(repo, 'ran.txt')}`], { encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /QUESTIONS_OPEN/); assert.equal(existsSync(join(repo, 'ran.txt')), false);
  rmSync(repo, { recursive: true, force: true });
});

test('knowledge: a secret in author or run is refused, in add and in check', async () => {
  const k = join(HERE, 'knowledge.mjs'); const repo = tmp('kn');
  assert.equal(spawnSync(process.execPath, [k, 'init', '--repo', repo], { encoding: 'utf8' }).status, 0);
  const tok = 'ghp_' + 'A'.repeat(36);
  const base = ['add', '--repo', repo, '--topic', 'build', '--risk', 'low', '--symptom', 's', '--cause', 'c', '--fix', 'f', '--evidence', 'e', '--verify', 'node --version'];
  for (const extra of [['--run', 'r1', '--title', 'Author smuggle', '--author', tok], ['--title', 'Run smuggle', '--run', tok]]) {
    const r = spawnSync(process.execPath, [k, ...base, ...extra], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, r.stdout); assert.match(r.stderr, /KNOWLEDGE_SECRET/);
  }
  rmSync(repo, { recursive: true, force: true });
});

test('run-lock async runner: a Windows shim fallback is waited for, and a synchronous EINVAL falls back to the shell', async () => {
  const { runCommandAsync } = await import('./run-lock.mjs');
  const dir = tmp('shim'); const slow = join(dir, 'slow.sh'); writeFileSync(slow, '#!/bin/sh\nsleep 1\nexit 7\n'); chmodSync(slow, 0o755);
  const t0 = Date.now();
  // direct spawn of a bare name fails with ENOENT; the "shell" retry resolves it through PATH in dir
  const status = await runCommandAsync(['slow.sh'], { platform: 'win32', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, signals: false });
  assert.equal(status, 7); assert.ok(Date.now() - t0 >= 900, 'must wait for the real command, not the failed first child');
  assert.equal(await runCommandAsync(['definitely-missing-xyz'], { platform: 'linux', signals: false }), 1);
  rmSync(dir, { recursive: true, force: true });
});

test('state.lock: an empty lock (crash mid-create) is taken over; a handover cannot go back to a lower depth', async () => {
  const { handoverTaken, setGate } = await import('./run-state.mjs');
  const repo = tmp('lk'); setGate(repo, 'r1', { gate: 'base', status: 'in_progress', task: 't' });
  const dir = join(repo, '.trioharness-direct', 'runs', 'r1'); writeFileSync(join(dir, 'state.lock'), '');
  await new Promise(r => setTimeout(r, 1100));
  const t0 = Date.now(); setGate(repo, 'r1', { gate: 'route', status: 'in_progress' }); assert.ok(Date.now() - t0 < 5000);
  writeFileSync(join(dir, 'HANDOVER-NEXT.md'), 'a'); handoverTaken(repo, 'r1', { by: 't2', depth: 4 });
  writeFileSync(join(dir, 'HANDOVER-NEXT.md'), 'b'); assert.throws(() => handoverTaken(repo, 'r1', { by: 't3', depth: 1 }), /HANDOVER_DEPTH/);
  rmSync(repo, { recursive: true, force: true });
});

// S2-C3/C4; each test owns a fresh fixture run.
async function s2Handover() {
  const api = await import('./run-state.mjs');
  const repo = tmp('s2-handover');
  api.setGate(repo, 'r1', { gate: 'base', status: 'in_progress', task: 'fixture' });
  const dir = join(repo, '.trioharness-direct', 'runs', 'r1');
  const next = text => writeFileSync(join(dir, 'HANDOVER-NEXT.md'), text);
  return { ...api, repo, dir, next };
}
test('hf5b1e-s2-d-handover: derives depth and resumes idempotently', async () => {
  const { repo, dir, next, handoverTaken, readState } = await s2Handover();
  next('first'); handoverTaken(repo, 'r1', { by: 'one', depth: 2 }); next('second');
  assert.doesNotThrow(() => handoverTaken(repo, 'r1', { by: 'two' }));
  const recorded = readState(repo, 'r1').handoff;
  assert.equal(recorded.depth, 3);
  const stateBytes = readFileSync(join(dir, 'state.json'), 'utf8');
  for (const depth of [undefined, 3]) {
    assert.deepEqual(handoverTaken(repo, 'r1', { by: 'two', depth }), { ...recorded, resumed: true });
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), stateBytes);
  }
  assert.throws(() => handoverTaken(repo, 'r1', { by: 'other' }), /HANDOVER_NONE/);
  assert.throws(() => handoverTaken(repo, 'r1', { by: 'two', depth: 4 }), /HANDOVER_NONE|HANDOVER_DEPTH/);
  rmSync(join(dir, recorded.file));
  assert.throws(() => handoverTaken(repo, 'r1', { by: 'two' }), /HANDOVER_NONE/);
});
test('hf5b1e-s2-d-handover: two pickups in the same millisecond never overwrite', async () => {
  const { repo, dir, next, handoverTaken } = await s2Handover();
  const now = '2026-10-31T12:34:56.789Z';
  next('first'); const a = handoverTaken(repo, 'r1', { by: 'one', depth: 1 }, now);
  next('second'); const b = handoverTaken(repo, 'r1', { by: 'two', depth: 2 }, now);
  assert.notEqual(a.file, b.file);
  assert.match(a.file, /^HANDOVER-TAKEN-\d{17}\.md$/);
  assert.match(b.file, /^HANDOVER-TAKEN-\d{17}\.md$/);
  assert.equal(readFileSync(join(dir, a.file), 'utf8'), 'first');
  assert.equal(readFileSync(join(dir, b.file), 'utf8'), 'second');
});
test('hf5b1e-s2-d-handover: --keep leaves HANDOVER-NEXT.md and records kept', async () => {
  const { repo, dir, next, handoverTaken, readState } = await s2Handover();
  next('kept');
  const r = spawnSync(process.execPath, [RUNSTATE, 'handover-taken', '--repo', repo, '--run', 'r1', '--by', 'one', '--keep'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(dir, 'HANDOVER-NEXT.md')), true);
  const h = readState(repo, 'r1').handoff;
  assert.equal(h.kept, true);
  // Kept is a copy: later edits to NEXT cannot change the exclusive receipt.
  next('changed'); assert.equal(readFileSync(join(dir, h.file), 'utf8'), 'kept');
  const second = handoverTaken(repo, 'r1', { by: 'two', keep: true });
  assert.equal(second.depth, 2); assert.equal(second.kept, true);
});
test('hf5b1e-s2-d-handover: stalledRuns does not treat a kept pickup as parked', async () => {
  const { repo, dir, next, handoverTaken, stalledRuns } = await s2Handover();
  next('kept'); handoverTaken(repo, 'r1', { by: 'one', keep: true });
  // On the base, restore NEXT to isolate the stall policy from consuming pickup.
  if (!existsSync(join(dir, 'HANDOVER-NEXT.md'))) next('kept');
  assert.ok(stalledRuns(repo, { minutes: 0, now: Date.now() + 3600000 }).some(r => r.run === 'r1'));
});
test('hf5b1e-s2-p-handover: explicit increasing depth, 1-5 bounds and existing errors', async () => {
  const { repo, next, handoverTaken } = await s2Handover();
  assert.throws(() => handoverTaken(repo, 'r1', { by: 'one' }), /HANDOVER_NONE/);
  next('first');
  for (const depth of [0, 6, 1.5]) assert.throws(() => handoverTaken(repo, 'r1', { by: 'one', depth }), /HANDOVER_DEPTH/);
  assert.throws(() => handoverTaken(repo, 'r1', { by: '../bad', depth: 1 }), /HANDOVER_BY_INVALID/);
  handoverTaken(repo, 'r1', { by: 'one', depth: 2 }); next('second');
  for (const depth of [1, 2]) assert.throws(() => handoverTaken(repo, 'r1', { by: 'two', depth }), /HANDOVER_DEPTH/);
  assert.equal(handoverTaken(repo, 'r1', { by: 'two', depth: 5 }).depth, 5);
});
test('hf5b1e-s2-p-handover: first pickup consumes NEXT and records the handoff', async () => {
  const { repo, dir, next, handoverTaken, readState, stalledRuns } = await s2Handover();
  next('first');
  assert.deepEqual(stalledRuns(repo, { minutes: 0, now: Date.now() + 3600000 }), []);
  const h = handoverTaken(repo, 'r1', { by: 'one', depth: 1 });
  assert.equal(existsSync(join(dir, 'HANDOVER-NEXT.md')), false);
  assert.equal(readFileSync(join(dir, h.file), 'utf8'), 'first');
  assert.deepEqual(readState(repo, 'r1').handoff, h);
});

test('hf5b1e-s2-d-handover-repark: rewritten NEXT parks a previously kept pickup', async () => {
  const { repo, dir, next, handoverTaken, stalledRuns } = await s2Handover();
  next('first parked slice');
  const receipt = handoverTaken(repo, 'r1', { by: 'one', keep: true });
  const options = { minutes: 0, now: Date.now() + 3600000 };
  assert.ok(stalledRuns(repo, options).some(r => r.run === 'r1'), 'unchanged kept NEXT is active');
  next('second parked slice');
  assert.equal(readFileSync(join(dir, receipt.file), 'utf8'), 'first parked slice');
  assert.deepEqual(stalledRuns(repo, options), [], 'new NEXT bytes represent a deliberate re-park');
});

for (const problem of ['missing', 'unreadable', 'invalid-name']) {
  test(`hf5b1e-s2-d-handover-receipt: ${problem} kept receipt cannot hide a stalled run`, async () => {
    const { repo, dir, next, handoverTaken, stalledRuns, readState } = await s2Handover();
    next('kept pickup');
    const receipt = handoverTaken(repo, 'r1', { by: 'one', keep: true });
    next('different NEXT bytes cannot prove parking without the receipt');
    if (problem === 'invalid-name') {
      const state = readState(repo, 'r1');
      state.handoff.file = '../invalid-receipt.md';
      writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    } else {
      rmSync(join(dir, receipt.file));
      if (problem === 'unreadable') mkdirSync(join(dir, receipt.file));
    }
    assert.ok(stalledRuns(repo, { minutes: 0, now: Date.now() + 3600000 }).some(r => r.run === 'r1'),
      'a kept pickup needs readable receipt evidence before NEXT can park it');
  });
}

test('hf5b1e-s2-d-handover-miss: waits for a pickup receipt being saved under the lock', async () => {
  const { repo, dir, next, handoverTaken, readState } = await s2Handover();
  next('handoff bytes');
  const receipt = handoverTaken(repo, 'r1', { by: 'one' });
  const saved = readState(repo, 'r1');
  const pending = { ...saved }; delete pending.handoff;
  writeFileSync(join(dir, 'state.json'), JSON.stringify(pending));
  // Model another pickup between unlinking NEXT and publishing state.json.
  writeFileSync(join(dir, 'state.lock'), String(process.pid));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { handoverTaken } from ${JSON.stringify(new URL('./run-state.mjs', import.meta.url).href)};
    process.stdout.write('ready\\n');
    try { process.stdout.write(JSON.stringify(handoverTaken(process.argv[1], 'r1', { by: 'one' })) + '\\n'); }
    catch (e) { process.stderr.write(e.message); process.exitCode = 1; }
  `, repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('ready\n')) resolve(); });
      child.once('error', reject);
      child.once('close', () => { if (!stdout.includes('ready\n')) reject(new Error(stderr || 'pickup exited before ready')); });
    });
    // Give the reader time to encounter the absent NEXT while the lock is held.
    await new Promise(resolve => setTimeout(resolve, 200));
    writeFileSync(join(dir, 'state.json'), JSON.stringify(saved));
  } finally { rmSync(join(dir, 'state.lock'), { force: true }); }
  assert.equal(await closed, 0, stderr);
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), { ...receipt, resumed: true });
});

test('hf5b1e-s2-d-handover-depth: derived depth above five refuses without changing evidence', async () => {
  const { repo, dir, next, handoverTaken } = await s2Handover();
  next('fifth');
  const receipt = handoverTaken(repo, 'r1', { by: 'five', depth: 5 });
  next('sixth');
  const stateBytes = readFileSync(join(dir, 'state.json'));
  assert.throws(() => handoverTaken(repo, 'r1', { by: 'six' }), /HANDOVER_DEPTH/);
  assert.deepEqual(readFileSync(join(dir, 'state.json')), stateBytes);
  assert.equal(readFileSync(join(dir, 'HANDOVER-NEXT.md'), 'utf8'), 'sixth');
  assert.equal(readFileSync(join(dir, receipt.file), 'utf8'), 'fifth');
});

test('hf5b1e-s2-d-handover-keep-collision: same timestamp preserves both exclusive copies', async () => {
  const { repo, dir, next, handoverTaken, readState } = await s2Handover();
  const now = '2026-10-31T12:34:56.789Z';
  next('first kept slice');
  const first = handoverTaken(repo, 'r1', { by: 'one', keep: true }, now);
  next('second kept slice');
  const second = handoverTaken(repo, 'r1', { by: 'two', keep: true }, now);
  assert.notEqual(first.file, second.file);
  assert.match(first.file, /^HANDOVER-TAKEN-\d{17}\.md$/);
  assert.match(second.file, /^HANDOVER-TAKEN-\d{17}\.md$/);
  assert.equal(readFileSync(join(dir, first.file), 'utf8'), 'first kept slice');
  assert.equal(readFileSync(join(dir, second.file), 'utf8'), 'second kept slice');
  assert.equal(readFileSync(join(dir, 'HANDOVER-NEXT.md'), 'utf8'), 'second kept slice');
  assert.equal(first.kept, true); assert.equal(second.kept, true);
  assert.equal(second.depth, 2);
  assert.deepEqual(readState(repo, 'r1').handoff, second);
});

for (const mode of ['ask', 'promote']) for (const first of ['card', 'job']) test(`fix2 H2-race ${mode} ${first} publication owns shared lock`, async t => {
  const r = tmp('publication'); t.after(() => rmSync(r, { recursive: true, force: true }));
  const qurl = new URL('./questions.mjs', import.meta.url).href, jurl = new URL('./jobs.mjs', import.meta.url).href;
  const { askCard, setAutopilot } = await import('./questions.mjs');
  const card = { questions: [{ id: 'q', header: 'Scope', question: 'May we merge the change?', why: 'Choose the next action', options: [{ id: 'a', label: 'Wait', description: 'Wait for approval' }, { id: 'b', label: 'Proceed', description: 'Continue this change' }], recommended: 'a', kind: 'gate' }] };
  if (mode === 'promote') { setAutopilot(r, 'r1', true, { quote: 'Run on autopilot' }); askCard(r, 'r1', card); }
  const marker = name => join(r, name);
  const preload = join(r, 'barrier.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const write=fs.writeFileSync, rename=fs.renameSync, open=fs.openSync;
const base=${JSON.stringify(r)}, first=${JSON.stringify(first)};
const mark=n=>write(base+'/'+n,'yes');
const pause=()=>{mark('ready');while(!fs.existsSync(base+'/release'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)};
fs.openSync=(p,...a)=>{try{return open(p,...a)}catch(e){if(String(p).endsWith('state.lock')&&e.code==='EEXIST')mark(process.env.ACTOR+'-blocked');throw e}};
fs.writeFileSync=(p,...a)=>{if(/questions[\\/]Q-\\d+\\.json$/.test(String(p))){if(first==='card'&&process.env.ACTOR==='card')pause();mark('card-published')}return write(p,...a)};
fs.renameSync=(a,b)=>{if(/jobs[\\/]work\\.json$/.test(String(b))){if(first==='job'&&process.env.ACTOR==='job'&&!fs.existsSync(base+'/ready'))pause();mark('job-published')}return rename(a,b)};
syncBuiltinESMExports();`);
  const start = actor => {
    const jobCode = `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker('finish'))})){clearInterval(timer)}},10)`;
    const body = actor === 'card'
      ? `const q=await import(${JSON.stringify(qurl)});q.${mode === 'ask' ? 'askCard' : 'promoteDeferred'}(${JSON.stringify(r)},'r1'${mode === 'ask' ? ',' + JSON.stringify(card) : ''});`
      : `const j=await import(${JSON.stringify(jurl)});await j.supervise({repo:${JSON.stringify(r)},run:'r1',name:'work',cmd:${JSON.stringify(JSON.stringify(process.execPath)+' -e '+JSON.stringify(jobCode))},timeoutSec:10,foreground:false});`;
    const child = spawn(process.execPath, ['--import', new URL('file://'+preload).href, '--input-type=module', '-e', `try{${body}}catch(e){process.stderr.write(e.message);process.exitCode=3}`], { env: { ...process.env, ACTOR: actor }, stdio: ['ignore','pipe','pipe'] });
    let err='';child.stdout.resume();child.stderr.on('data',x=>err+=x);
    return { done:new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,err}))}) };
  };
  const until = async fn => { const end=Date.now()+10000;while(!fn()){assert.ok(Date.now()<end,'publication barrier timed out');await new Promise(resolve=>setTimeout(resolve,10))} };
  const a=start(first); let b, blocked=false, result;
  try {
    await until(()=>existsSync(marker('ready'))); b=start(first==='card'?'job':'card');
    await until(()=>existsSync(marker(first==='card'?'job-blocked':'card-blocked'))||existsSync(marker(first==='card'?'job-published':'card-published')));
    blocked=existsSync(marker(first==='card'?'job-blocked':'card-blocked'));
    writeFileSync(marker('release'),'yes');
    result=await (first==='card'?a.done:b.done);
  } finally {
    writeFileSync(marker('release'),'yes');writeFileSync(marker('finish'),'yes');
    await a.done;if(b)await b.done;
  }
  assert.equal(blocked,true,'second publication must wait for shared lock');
  assert.equal(result.code,first==='card'?0:3,result.err);
});
