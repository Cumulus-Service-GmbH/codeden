import test from 'node:test';
import assert from 'node:assert/strict';
import { localRepo } from './test-local-repo.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openJobsReason, pidAlive, readJobs, supervise, waitJob } from './jobs.mjs';
import { finishWorker, readState, registerWorker, setGate, stalledRuns } from './run-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const JOBS = join(here, 'jobs.mjs');
const repo = () => mkdtempSync(join(tmpdir(), 'thl-jobs-'));
const cli = (r, ...a) => spawnSync(process.execPath, [JOBS, ...a, '--repo', r, '--run', 'r1'], { encoding: 'utf8', timeout: 60000 });
const node = code => `"${process.execPath}" -e "${code}"`;
const rec = (r, name) => JSON.parse(readFileSync(join(r, '.trioharness-direct', 'runs', 'r1', 'jobs', `${name}.json`), 'utf8'));

test('run: a passing command streams its output, records passed and exits 0', () => {
  const r = repo();
  const o = cli(r, 'run', '--name', 'ok', '--cmd', node("console.log('hello-job')"));
  assert.equal(o.status, 0); assert.match(o.stdout, /hello-job/);
  assert.equal(rec(r, 'ok').status, 'passed');
  assert.match(readFileSync(rec(r, 'ok').log, 'utf8'), /hello-job/);
  rmSync(r, { recursive: true, force: true });
});

test('run: a failing command keeps its exit code', () => {
  const r = repo();
  const o = cli(r, 'run', '--name', 'bad', '--cmd', node('process.exit(7)'));
  assert.equal(o.status, 7); assert.equal(rec(r, 'bad').status, 'failed'); assert.equal(rec(r, 'bad').exitCode, 7);
  rmSync(r, { recursive: true, force: true });
});

test('run: the timeout kills the process tree, records timeout and exits 124', () => {
  const r = repo();
  const o = cli(r, 'run', '--name', 'slow', '--timeout', '1', '--cmd', node('setTimeout(()=>{},60000)'));
  assert.equal(o.status, 124);
  const j = rec(r, 'slow'); assert.equal(j.status, 'timeout');
  assert.equal(pidAlive(j.pid), false, 'the timed-out process must be gone');
  rmSync(r, { recursive: true, force: true });
});

test('start + check + wait: check blocks the turn end until the job is waited for', () => {
  const r = repo();
  const s = cli(r, 'start', '--name', 'pw', '--cmd', node("setTimeout(()=>console.log('late'),1500)"));
  assert.equal(s.status, 0, s.stderr);
  const c1 = cli(r, 'check'); assert.equal(c1.status, 2); assert.match(c1.stderr, /do not end the turn/);
  assert.match(openJobsReason(r, 'r1'), /pw \(running\)/);
  const w = cli(r, 'wait', '--name', 'pw', '--timeout', '30'); assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.equal(JSON.parse(w.stdout).status, 'passed');
  assert.equal(cli(r, 'check').status, 0); assert.equal(openJobsReason(r, 'r1'), null);
  rmSync(r, { recursive: true, force: true });
});

test('wait that times out reports still running (124) and stop ends the job', () => {
  const r = repo();
  assert.equal(cli(r, 'start', '--name', 'long', '--cmd', node('setTimeout(()=>{},60000)')).status, 0);
  const w = cli(r, 'wait', '--name', 'long', '--timeout', '1'); assert.equal(w.status, 124);
  assert.equal(JSON.parse(w.stdout).stillRunning, true);
  assert.equal(cli(r, 'start', '--name', 'long', '--cmd', node('1')).status, 3, 'a running name cannot be started twice');
  assert.equal(cli(r, 'stop', '--name', 'long').status, 0);
  const w2 = cli(r, 'wait', '--name', 'long', '--timeout', '20'); assert.notEqual(w2.status, 124, w2.stdout);
  assert.equal(JSON.parse(w2.stdout).status, 'killed', 'a stopped job is recorded killed, not lost');
  assert.equal(cli(r, 'check').status, 0);
  rmSync(r, { recursive: true, force: true });
});

test('a record whose supervisor died is lost: check fails and finish is refused until it is rerun', async () => {
  const r = repo();
  const dir = join(r, '.trioharness-direct', 'runs', 'r1', 'jobs'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ghost.json'), JSON.stringify({ name: 'ghost', status: 'running', supervisorPid: 2147483000, pid: 2147483001, startedAt: new Date().toISOString(), timeoutSec: 600 }));
  assert.equal(readJobs(r, 'r1')[0].status, 'lost');
  const c = cli(r, 'check'); assert.equal(c.status, 2); assert.match(c.stderr, /ghost lost its supervisor/);
  assert.equal(cli(r, 'wait', '--name', 'ghost', '--timeout', '1').status, 125);
  const done = await supervise({ repo: r, run: 'r1', name: 'ghost', cmd: node('1'), timeoutSec: 30 });
  assert.equal(done.status, 'passed'); assert.equal(cli(r, 'check').status, 0);
  rmSync(r, { recursive: true, force: true });
});

test('a running record far past its own timeout counts as lost even if the pid number was reused', () => {
  const r = repo();
  const dir = join(r, '.trioharness-direct', 'runs', 'r1', 'jobs'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'old.json'), JSON.stringify({ name: 'old', status: 'running', supervisorPid: process.pid, startedAt: new Date(Date.now() - 3 * 3600e3).toISOString(), timeoutSec: 60 }));
  assert.equal(readJobs(r, 'r1')[0].status, 'lost');
  rmSync(r, { recursive: true, force: true });
});

test('a run with an unresolved job cannot be finished; resolved, it can', async () => {
  const r = localRepo('thl-jobs-');
  for (const gate of ['base', 'route', 'task-card', 'guard-proof']) setGate(r, 'r1', { gate, status: 'passed' });
  setGate(r, 'r1', { gate: 'done-jev', status: 'passed' });
  assert.equal(cli(r, 'start', '--name', 'pw', '--cmd', node('setTimeout(()=>{},4000)')).status, 0);
  const st = setGate(r, 'r1', { gate: 'learnings', status: 'passed' });
  assert.ok(!st.finished); assert.match(st.notFinishedBecause, /background job/);
  const fin = spawnSync(process.execPath, [join(here, 'run-state.mjs'), 'finish', '--repo', r, '--run', 'r1'], { encoding: 'utf8' });
  assert.equal(fin.status, 3); assert.match(fin.stderr, /RUN_HAS_OPEN_JOBS/);
  await waitJob(r, 'r1', 'pw', { timeoutSec: 30 });
  assert.ok(setGate(r, 'r1', { gate: 'learnings', status: 'passed' }).finished);
  rmSync(r, { recursive: true, force: true });
});

test('names, run ids, timeouts and commands are validated', () => {
  const r = repo();
  assert.equal(cli(r, 'run', '--name', '../x', '--cmd', 'echo 1').status, 3);
  assert.equal(cli(r, 'run', '--name', 'a', '--cmd', 'echo 1', '--timeout', '0').status, 3);
  assert.equal(cli(r, 'run', '--name', 'a', '--cmd', 'echo 1', '--timeout', '999999').status, 3);
  assert.equal(cli(r, 'run', '--name', 'a').status, 3);
  assert.equal(cli(r, 'wait', '--name', 'nope').status, 3);
  assert.equal(spawnSync(process.execPath, [JOBS, 'check', '--repo', r, '--run', '../r'], { encoding: 'utf8' }).status, 3);
  assert.equal(cli(r, 'frobnicate').status, 3);
  rmSync(r, { recursive: true, force: true });
});

test('wait: a job that hit its own timeout exits 126, never 124 (still running); a job that itself exits 124/125 reads as 1', () => {
  const r = repo();
  assert.equal(cli(r, 'run', '--name', 't', '--timeout', '1', '--cmd', node('setTimeout(()=>{},60000)')).status, 124);
  const w = cli(r, 'wait', '--name', 't', '--timeout', '5'); assert.equal(w.status, 126); assert.equal(JSON.parse(w.stdout).status, 'timeout');
  for (const code of [124, 125, 126]) {
    assert.equal(cli(r, 'run', '--name', `x${code}`, '--cmd', node(`process.exit(${code})`)).status, code);
    assert.equal(cli(r, 'wait', '--name', `x${code}`, '--timeout', '5').status, 1, `job exit ${code}`);
  }
  rmSync(r, { recursive: true, force: true });
});

test('two truly simultaneous starts of one name: exactly one wins, the loser says why, the winner is intact', async () => {
  const r = repo();
  const go = tag => new Promise(res => {
    const p = spawn(process.execPath, [JOBS, 'start', '--name', 'dup', '--cmd', node(`setTimeout(()=>console.log('${tag}'),1500)`), '--repo', r, '--run', 'r1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; }); p.on('exit', code => res({ status: code, stderr: err }));
  });
  const both = await Promise.all([go('A'), go('B')]);
  assert.equal(both.filter(p => p.status === 0).length, 1, both.map(p => `${p.status}:${p.stderr}`).join(' | '));
  assert.match(both.find(p => p.status !== 0).stderr, /JOB_RUNNING/);
  assert.equal(cli(r, 'wait', '--name', 'dup', '--timeout', '30').status, 0);
  assert.equal(readdirSync(join(r, '.trioharness-direct', 'runs', 'r1', 'jobs')).filter(f => /\.(lock|takeover|start-error\.log)$/.test(f) || f.endsWith('.takeover')).length, 0, 'no lock or startup litter');
  rmSync(r, { recursive: true, force: true });
});

test('a swept lock file does not lose the result of a job that passed', () => {
  const r = repo();
  const started = cli(r, 'start', '--name', 'sw', '--cmd', node('setTimeout(()=>{},1500)'));
  assert.equal(started.status, 0, JSON.stringify({ stdout: started.stdout, stderr: started.stderr, signal: started.signal, error: started.error && { code: started.error.code, message: started.error.message } }));
  rmSync(join(r, '.trioharness-direct', 'runs', 'r1', 'jobs', 'sw.lock'), { force: true });
  const w = cli(r, 'wait', '--name', 'sw', '--timeout', '30'); assert.equal(w.status, 0, w.stdout);
  rmSync(r, { recursive: true, force: true });
});

test('stale lock takeover is exclusive: with a takeover already in progress the second caller is refused', () => {
  const r = repo();
  const dir = join(r, '.trioharness-direct', 'runs', 'r1', 'jobs'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tk.lock'), JSON.stringify({ pid: 2147483000, startedAt: new Date().toISOString(), timeoutSec: 60 }));
  mkdirSync(join(dir, 'tk.lock.takeover'));
  const o = cli(r, 'run', '--name', 'tk', '--cmd', node('1')); assert.equal(o.status, 3); assert.match(o.stderr, /JOB_RUNNING/);
  rmSync(join(dir, 'tk.lock.takeover'), { recursive: true });
  assert.equal(cli(r, 'run', '--name', 'tk', '--cmd', node('1')).status, 0, 'a stale lock with no takeover in progress is taken over');
  rmSync(r, { recursive: true, force: true });
});

test('stop never kills by pid when the supervisor is gone (lost)', () => {
  const r = repo();
  const dir = join(r, '.trioharness-direct', 'runs', 'r1', 'jobs'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ghost.json'), JSON.stringify({ name: 'ghost', status: 'running', supervisorPid: 2147483000, pid: process.pid, startedAt: new Date().toISOString(), timeoutSec: 600 }));
  const s = cli(r, 'stop', '--name', 'ghost'); assert.equal(s.status, 3); assert.match(s.stderr, /JOB_LOST/);
  assert.equal(pidAlive(process.pid), true);
  rmSync(r, { recursive: true, force: true });
});

test('timeout is hard even when a descendant escaped the process group and holds the output pipes', () => {
  const r = repo();
  const t0 = Date.now();
  const code = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},12000)'],{detached:true,stdio:['ignore','inherit','inherit']}).unref();setTimeout(()=>{},60000)";
  const o = cli(r, 'run', '--name', 'esc', '--timeout', '1', '--cmd', node(code));
  assert.equal(o.status, 124); assert.ok(Date.now() - t0 < 9000, `returned after ${Date.now() - t0} ms`);
  assert.equal(rec(r, 'esc').status, 'timeout');
  rmSync(r, { recursive: true, force: true });
});

test('start reports why the supervisor could not start (for example a bad timeout or a running name)', () => {
  const r = repo();
  assert.equal(cli(r, 'start', '--name', 'a', '--cmd', 'echo 1', '--timeout', '0').status, 3);
  assert.equal(cli(r, 'start', '--name', 'b').status, 3);
  rmSync(r, { recursive: true, force: true });
});

// ---- heavy-job slots, worker deadlines, stalled-run detector
const slotEnv = () => ({ ...process.env, THL_SLOT_DIR: mkdtempSync(join(tmpdir(), 'thl-slots-')) });
const cliEnv = (r, env, ...a) => spawnSync(process.execPath, [JOBS, ...a, '--repo', r, '--run', 'r1'], { encoding: 'utf8', timeout: 60000, env });

test('heavy jobs share machine-wide slots: with one slot the second job queues until the first ends, and check blocks while it queues', () => {
  const r = repo(), env = slotEnv();
  assert.equal(cliEnv(r, env, 'start', '--name', 'a', '--heavy', '--slots', '1', '--cmd', node('setTimeout(()=>{},2500)')).status, 0);
  assert.equal(cliEnv(r, env, 'start', '--name', 'b', '--heavy', '--slots', '1', '--cmd', node('1')).status, 0);
  const listed = JSON.parse(cliEnv(r, env, 'list').stdout);
  assert.equal(listed.find(j => j.name === 'b').status, 'queued');
  assert.equal(cliEnv(r, env, 'check').status, 2);
  assert.equal(cliEnv(r, env, 'wait', '--name', 'a', '--timeout', '30').status, 0);
  assert.equal(cliEnv(r, env, 'wait', '--name', 'b', '--timeout', '30').status, 0);
  assert.ok(Date.parse(rec(r, 'b').startedAt) >= Date.parse(rec(r, 'a').endedAt) - 50, 'b started only after a released the slot');
  assert.equal(cliEnv(r, env, 'check').status, 0);
  rmSync(r, { recursive: true, force: true });
});

test('heavy: no free slot within --slot-wait exits 75 and runs nothing; a dead owner\'s slot is taken over', () => {
  const r = repo(), env = slotEnv();
  writeFileSync(join(env.THL_SLOT_DIR, 'slot-0.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), timeoutSec: 600 }));
  const o = cliEnv(r, env, 'run', '--name', 'h', '--heavy', '--slots', '1', '--slot-wait', '1', '--cmd', node("console.log('RAN')"));
  assert.equal(o.status, 75); assert.ok(!o.stdout.includes('RAN')); assert.match(rec(r, 'h').note, /no heavy-job slot/); assert.equal(rec(r, 'h').status, 'no-slot');
  writeFileSync(join(env.THL_SLOT_DIR, 'slot-0.lock'), JSON.stringify({ pid: 2147483000, startedAt: new Date().toISOString(), timeoutSec: 600 }));
  const ok = cliEnv(r, env, 'run', '--name', 'h2', '--heavy', '--slots', '1', '--slot-wait', '5', '--cmd', node("console.log('RAN')"));
  assert.equal(ok.status, 0); assert.match(ok.stdout, /RAN/);
  assert.equal(readdirSync(env.THL_SLOT_DIR).filter(f => f.endsWith('.lock')).length, 0, 'slot released');
  rmSync(r, { recursive: true, force: true });
});

test('heavy: invalid --slots and --slot-wait are refused', () => {
  const r = repo(), env = slotEnv();
  assert.equal(cliEnv(r, env, 'run', '--name', 'x', '--heavy', '--slots', '0', '--cmd', 'echo 1').status, 3);
  assert.equal(cliEnv(r, env, 'run', '--name', 'x', '--heavy', '--slot-wait', 'abc', '--cmd', 'echo 1').status, 3);
  rmSync(r, { recursive: true, force: true });
});

test('stalled: an open run with no sign of life is reported; finished, parked, and live runs are not', () => {
  const r = localRepo('thl-jobs-'); const later = Date.now() + 60 * 60000;
  setGate(r, 'idle', { gate: 'build', status: 'in_progress', next: 'run the tests' });
  for (const gate of ['base', 'route', 'task-card', 'guard-proof']) setGate(r, 'done', { gate, status: 'passed' });
  setGate(r, 'done', { gate: 'done-jev', status: 'passed' }); setGate(r, 'done', { gate: 'learnings', status: 'passed' });
  setGate(r, 'parked', { gate: 'build', status: 'in_progress' }); writeFileSync(join(r, '.trioharness-direct', 'runs', 'parked', 'HANDOVER-NEXT.md'), 'x');
  const list = stalledRuns(r, { minutes: 20, now: later });
  assert.deepEqual(list.map(x => x.run), ['idle']);
  assert.match(list[0].reasons.join(' '), /no sign of life for \d+ min at gate build \(next: run the tests\)/);
  assert.equal(stalledRuns(r, { minutes: 20 }).length, 0, 'just updated: not stalled');
  rmSync(r, { recursive: true, force: true });
});

test('stalled: a worker past its deadline is reported at once; within its deadline the run is alive; a finished worker is closed', () => {
  const r = repo();
  setGate(r, 'w', { gate: 'review', status: 'in_progress' });
  registerWorker(r, 'w', { id: 'rev-1', role: 'code-reviewer', deadlineMin: 30 });
  assert.equal(stalledRuns(r, { minutes: 20, now: Date.now() + 25 * 60000 }).length, 0, 'inside the deadline the worker counts as alive');
  const late = stalledRuns(r, { minutes: 20, now: Date.now() + 45 * 60000 });
  assert.match(late[0].reasons.join(' '), /past their deadline: rev-1 \(treat as failed and take over\)/);
  finishWorker(r, 'w', 'rev-1', 'stopped');
  assert.equal(readState(r, 'w').workers['rev-1'].status, 'stopped');
  assert.ok(!stalledRuns(r, { minutes: 20, now: Date.now() + 45 * 60000 }).some(x => /deadline/.test(x.reasons.join(' '))));
  assert.throws(() => registerWorker(r, 'w', { id: '../x' }), /WORKER_ID_INVALID/);
  assert.throws(() => registerWorker(r, 'w', { id: 'a', deadlineMin: 0 }), /DEADLINE_INVALID/);
  assert.throws(() => finishWorker(r, 'w', 'nope', 'done'), /WORKER_UNKNOWN/);
  rmSync(r, { recursive: true, force: true });
});

test('stalled CLI: dispatch --worker records the deadline; stalled exits 2 with findings and 0 without', () => {
  const r = repo(); const RS = join(here, 'run-state.mjs');
  const rs = (...a) => spawnSync(process.execPath, [RS, ...a, '--repo', r], { encoding: 'utf8' });
  assert.equal(rs('dispatch', '--run', 'c', '--role', 'writer', '--worker', 'w1', '--deadline-min', '1').status, 0);
  assert.equal(readState(r, 'c').workers.w1.status, 'running');
  assert.equal(rs('stalled', '--minutes', '20').status, 0);
  const st = JSON.parse(readFileSync(join(r, '.trioharness-direct', 'runs', 'c', 'state.json'), 'utf8'));
  st.workers.w1.deadlineAt = new Date(Date.now() - 60000).toISOString(); writeFileSync(join(r, '.trioharness-direct', 'runs', 'c', 'state.json'), JSON.stringify(st));
  const o = rs('stalled', '--minutes', '20'); assert.equal(o.status, 2); assert.match(o.stdout, /past their deadline: w1/);
  assert.equal(rs('worker-done', '--run', 'c', '--worker', 'w1', '--status', 'failed').status, 0);
  assert.equal(rs('stalled', '--minutes', '20').status, 0);
  assert.equal(rs('stalled', '--minutes', '0').status, 3);
  rmSync(r, { recursive: true, force: true });
});

test('stopping a queued heavy job ends it without ever running the command or taking a slot', () => {
  const r = repo(), env = slotEnv();
  assert.equal(cliEnv(r, env, 'start', '--name', 'a', '--heavy', '--slots', '1', '--cmd', node('setTimeout(()=>{},4000)')).status, 0);
  assert.equal(cliEnv(r, env, 'start', '--name', 'b', '--heavy', '--slots', '1', '--cmd', node("console.log('B-RAN')")).status, 0);
  assert.equal(JSON.parse(cliEnv(r, env, 'stop', '--name', 'b').stdout).status, 'stopping');
  const w = cliEnv(r, env, 'wait', '--name', 'b', '--timeout', '20'); assert.equal(JSON.parse(w.stdout).status, 'killed');
  assert.ok(!readFileSync(rec(r, 'b').log, 'utf8').includes('B-RAN'), 'the stopped job must never run');
  assert.equal(cliEnv(r, env, 'wait', '--name', 'a', '--timeout', '30').status, 0);
  rmSync(r, { recursive: true, force: true });
});

test('a job that itself exits 75 is not mistaken for "no slot"; a broken slot folder fails the job cleanly instead of leaving it queued', () => {
  const r = repo(), env = slotEnv();
  const o = cliEnv(r, env, 'run', '--name', 'own75', '--cmd', node('process.exit(75)')); assert.equal(o.status, 1); assert.equal(rec(r, 'own75').status, 'failed');
  assert.equal(cliEnv(r, env, 'wait', '--name', 'own75', '--timeout', '5').status, 1);
  const blocker = join(r, 'not-a-folder'); writeFileSync(blocker, 'x');
  const bad = { ...env, THL_SLOT_DIR: blocker };
  const s = cliEnv(r, bad, 'start', '--name', 'bad', '--heavy', '--cmd', node('1')); assert.equal(s.status, 0, s.stderr);
  const w = cliEnv(r, bad, 'wait', '--name', 'bad', '--timeout', '20'); assert.notEqual(w.status, 125, w.stdout); assert.match(JSON.parse(w.stdout).note, /heavy-job slot error/);
  assert.equal(cliEnv(r, bad, 'check').status, 0, 'nothing left queued');
  rmSync(r, { recursive: true, force: true });
});

test('run --heavy keeps slot-wait + timeout inside one tool call', () => {
  const r = repo(), env = slotEnv();
  const o = cliEnv(r, env, 'run', '--name', 'x', '--heavy', '--timeout', '540', '--cmd', 'echo 1'); assert.equal(o.status, 3); assert.match(o.stderr, /JOB_BUDGET/);
  assert.equal(cliEnv(r, env, 'run', '--name', 'y', '--heavy', '--cmd', node("console.log('ok')")).status, 0, 'defaults fit the budget');
  rmSync(r, { recursive: true, force: true });
});

test('a lock written on another host is live until overdue, never judged by pid', async () => {
  const r = repo();
  const dir = join(r, '.trioharness-direct', 'runs', 'r1', 'jobs'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'far.lock'), JSON.stringify({ pid: 2147483000, host: 'some-other-container', startedAt: new Date().toISOString(), timeoutSec: 600 }));
  await assert.rejects(supervise({ repo: r, run: 'r1', name: 'far', cmd: node('1'), timeoutSec: 30 }), /JOB_RUNNING/);
  rmSync(r, { recursive: true, force: true });
});

test('worker bookkeeping validates ids and runs, and a bad deadline counts nothing', () => {
  const r = repo(); const RS = join(here, 'run-state.mjs');
  const rs = (...a) => spawnSync(process.execPath, [RS, ...a, '--repo', r], { encoding: 'utf8' });
  assert.throws(() => finishWorker(r, '../../x', 'a', 'done'), /RUN_ID_INVALID/);
  setGate(r, 'v', { gate: 'build', status: 'in_progress' });
  assert.throws(() => finishWorker(r, 'v', 'constructor', 'done'), /WORKER_UNKNOWN/);
  assert.equal(rs('dispatch', '--run', 'v', '--role', 'writer', '--worker', 'w', '--deadline-min', 'abc').status, 3);
  assert.equal(readState(r, 'v').dispatches, undefined, 'the failed dispatch was not counted');
  rmSync(r, { recursive: true, force: true });
});

test('stalled: nested activity counts as life; a worker without a deadline is overdue; one odd run does not hide the others', () => {
  const r = repo(); const later = Date.now() + 60 * 60000;
  setGate(r, 'a', { gate: 'build', status: 'in_progress' });
  setGate(r, 'odd', { gate: 'build', status: 'in_progress' });
  const f = join(r, '.trioharness-direct', 'runs', 'odd', 'state.json'); const st = JSON.parse(readFileSync(f, 'utf8'));
  st.workers = { w1: { status: 'running' }, w2: 'junk', w3: null }; writeFileSync(f, JSON.stringify(st));
  const out = stalledRuns(r, { minutes: 20, now: later });
  assert.deepEqual(out.map(x => x.run).sort(), ['a', 'odd']);
  assert.match(out.find(x => x.run === 'odd').reasons.join(' '), /past their deadline: w1/);
  mkdirSync(join(r, '.trioharness-direct', 'runs', 'a', 'packets', 'deep'), { recursive: true });
  writeFileSync(join(r, '.trioharness-direct', 'runs', 'a', 'packets', 'deep', 'p.diff'), 'x');
  assert.ok(!stalledRuns(r, { minutes: 20, now: Date.now() + 5 * 60000 }).some(x => x.run === 'a'), 'recent nested file = alive');
  rmSync(r, { recursive: true, force: true });
});
