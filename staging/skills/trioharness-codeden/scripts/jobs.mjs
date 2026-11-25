#!/usr/bin/env node
// TrioHarness Lean — awaited jobs. Nothing wakes an agent when a background process ends, so a turn that
// "continues when the job returns" never continues. Every test, build, Playwright or other long command
// goes through here instead: it runs in the foreground with a hard timeout, or starts registered and is
// then waited for inside the SAME turn. `check` is the turn-end gate: it fails while a job is unresolved.
//
//   node jobs.mjs run   --repo . --run <id> --name <job> --cmd "<command>" [--timeout <sec, default 540>] [--cwd <dir>]
//        runs in the foreground, streams output, kills the whole process tree at the timeout; exits with the command's code (124 = timed out)
//   node jobs.mjs start --repo . --run <id> --name <job> --cmd "<command>" [--timeout <sec, default 1800>] [--cwd <dir>]
//        starts a registered job that survives this shell call; you MUST then `wait` for it before the turn ends
//        --heavy takes one of the machine-wide heavy-job slots first (default 2; --slots N or THL_HEAVY_SLOTS) and waits up to
//        --slot-wait <sec> (default 300) for a free one, so Playwright shards, emulator downloads, full test suites and
//        reviewers cannot all run at once and starve each other; no slot in time = status no-slot, exit 75, nothing was run; `run --heavy` defaults to a 60 s slot wait and a 480 s
//        timeout and refuses slot-wait + timeout above 570 s (use start + wait for longer jobs)
//   node jobs.mjs wait  --repo . --run <id> --name <job> [--timeout <sec, default 540>]
//        blocks until the job ends. Exit 0 = passed; 124 = STILL RUNNING (call wait again); 125 = lost (supervisor died; verify no
//        process of the job is left, then rerun); 126 = the job hit its own timeout; otherwise the job's own failing code
//        75 = it never got a heavy slot (nothing ran). A job that itself exits 75, 124, 125 or 126 is reported as 1, so these
//        codes only ever mean what is written here
//   node jobs.mjs check --repo . --run <id>        exit 2 while any job is running or lost; run before ending any turn
//   node jobs.mjs stop  --repo . --run <id> --name <job> [--lost]
//        --lost: a job whose supervisor died (a host killed the shell call) may still run; it is stopped by pid only if the pid still shows this job's command line
//   node jobs.mjs list  --repo . --run <id>
// Records live in <repo>/.trioharness-direct/runs/<run>/jobs/<job>.json (log next to it). Exit 3 = usage or state error.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validRunId } from './ids.mjs';
import { openQuestionsReason } from './questions.mjs';
import { withStateLock } from './run-state.mjs';
import { isMain } from './is-main.mjs';

export const DEFAULT_RUN_TIMEOUT_SEC = 540; // under a 10-minute tool-call limit: the host must not kill the supervisor first
export const DEFAULT_START_TIMEOUT_SEC = 1800;
export const DEFAULT_WAIT_SEC = 540; // stays under a 10-minute tool-call limit
export const MAX_TIMEOUT_SEC = 7200;
export const DEFAULT_HEAVY_SLOTS = 2;
export const DEFAULT_SLOT_WAIT_SEC = 300;
const GRACE_MS = 60_000; // a "running" record this far past its own timeout is a lost supervisor, not a live job
const NAME = /^[A-Za-z0-9._-]+$/;

const jobsDir = (repo, run) => join(repo, '.trioharness-direct', 'runs', run, 'jobs');
const jobFile = (repo, run, name) => join(jobsDir(repo, run), `${name}.json`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function check(run, name) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  if (name !== undefined && !NAME.test(name || '')) throw new Error('JOB_NAME_INVALID: use letters, digits, . _ -');
}

// Atomic: a concurrent `wait` or `check` never reads a half-written record.
function saveJob(file, rec) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2));
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (i < 3 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { const t = Date.now() + 50 * (i + 1); while (Date.now() < t) { /* brief wait */ } continue; }
      try { unlinkSync(tmp); } catch { /* gone */ }
      throw e;
    }
  }
}


// One owner per job name. The lock is created exclusively, so two simultaneous starts cannot both win; a lock whose
// owner is dead (or far past its own timeout) is stale and may be taken over.
const lockFile = (repo, run, name) => join(jobsDir(repo, run), `${name}.lock`);
const stopFile = (repo, run, name) => join(jobsDir(repo, run), `${name}.stop`);
function readLock(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
// A lock written on another host (a shared volume) cannot be judged by pid: it stays live until it is overdue.
function lockLive(l, now = Date.now()) { return Boolean(l) && (l.host && l.host !== hostname() ? true : pidAlive(l.pid)) && now <= Date.parse(l.startedAt) + (l.timeoutSec || 0) * 1000 + GRACE_MS; }
function claim(file, rec) {
  const body = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: rec.startedAt, timeoutSec: rec.timeoutSec });
  try { writeFileSync(file, body, { flag: 'wx' }); return; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const running = l => new Error(`JOB_RUNNING: ${rec.name} is already running (pid ${l?.pid}); wait for it or stop it`);
  const l = readLock(file);
  if (lockLive(l)) throw running(l);
  // Stale lock: taking it over is itself exclusive (a short-lived mutex folder), so two takers cannot both win.
  const mx = `${file}.takeover`;
  try { mkdirSync(mx); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let age = 0; try { age = Date.now() - statSync(mx).mtimeMs; } catch { /* gone */ }
    if (age < 10_000) throw new Error(`JOB_RUNNING: ${rec.name} is being started by another caller`);
    try { rmdirSync(mx); mkdirSync(mx); } catch { throw new Error(`JOB_RUNNING: ${rec.name} is being started by another caller`); }
  }
  try {
    const l2 = readLock(file);
    if (lockLive(l2)) throw running(l2);
    try { unlinkSync(file); } catch { /* already gone */ }
    writeFileSync(file, body, { flag: 'wx' });
  } finally { try { rmdirSync(mx); } catch { /* gone */ } }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The record as it really stands: "running" with a dead supervisor (or far past its timeout) is "lost".
export function effective(rec, now = Date.now()) {
  if (rec.status !== 'running' && rec.status !== 'queued') return rec;
  const overdue = now > Date.parse(rec.startedAt) + ((rec.slotWaitSec || 0) + (rec.timeoutSec || 0)) * 1000 + GRACE_MS;
  if (!pidAlive(rec.supervisorPid) || overdue) return { ...rec, status: 'lost' };
  return rec;
}

export function readJobs(repo, run, now = Date.now()) {
  check(run);
  const dir = jobsDir(repo, run);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(effective(JSON.parse(readFileSync(join(dir, f), 'utf8')), now)); } catch { out.push({ name: f.replace(/\.json$/, ''), status: 'lost', note: 'unreadable job record' }); }
  }
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

// Why a run may not be finished or closed yet: a job it started is still running, or its result was lost.
export function openJobsReason(repo, run) {
  let jobs; try { jobs = readJobs(repo, run); } catch { return null; }
  const open = jobs.filter(j => ['running', 'queued', 'lost'].includes(j.status));
  if (!open.length) return null;
  return `background job(s) unresolved: ${open.map(j => `${j.name} (${j.status})`).join(', ')}; wait for them with jobs.mjs wait, stop them with jobs.mjs stop, or rerun lost ones in the foreground`;
}

export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') { try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } return; }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
}

function parseTimeout(v, dflt) {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_TIMEOUT_SEC) throw new Error(`TIMEOUT_INVALID: seconds between 1 and ${MAX_TIMEOUT_SEC}`);
  return n;
}


// Machine-wide heavy-job slots: one lock file per slot, shared by every repo and run on this machine.
export const slotDir = () => process.env.THL_SLOT_DIR || join(tmpdir(), `trioharness-slots-${(() => { try { return userInfo().username; } catch { return 'user'; } })()}`);
async function acquireSlot({ slots, waitSec, rec, shouldStop }) {
  const dir = slotDir(); mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (typeof process.getuid === 'function' && statSync(dir).uid !== process.getuid()) throw new Error(`SLOT_DIR_UNSAFE: ${dir} belongs to another user; set THL_SLOT_DIR`);
  const end = Date.now() + waitSec * 1000;
  for (;;) {
    if (shouldStop()) return 'stopped';
    for (let i = 0; i < slots; i++) {
      const f = join(dir, `slot-${i}.lock`);
      try { claim(f, { name: `${rec.name}@${rec.run}`, startedAt: new Date().toISOString(), timeoutSec: rec.timeoutSec }); return f; } catch (e) { if (!/^JOB_RUNNING/.test(e.message)) throw e; }
    }
    if (Date.now() >= end) return null;
    await sleep(Math.min(1000, Math.max(50, end - Date.now())));
  }
}
function releaseSlot(f) { if (f && readLock(f)?.pid === process.pid) { try { unlinkSync(f); } catch { /* gone */ } } }

// Runs the command under supervision and records every state change. Foreground (`run`) also streams to stdout.
export async function supervise({ repo, run, name, cmd, cwd, timeoutSec, foreground, heavy = false, slots = DEFAULT_HEAVY_SLOTS, slotWaitSec = DEFAULT_SLOT_WAIT_SEC }) {
  check(run, name);
  if (!cmd) throw new Error('JOB_CMD_REQUIRED');
  const dir = jobsDir(repo, run); mkdirSync(dir, { recursive: true });
  const file = jobFile(repo, run, name), log = join(dir, `${name}.log`), lock = lockFile(repo, run, name), stop = stopFile(repo, run, name);
  const rec = { name, run, cmd, cwd: cwd || repo, timeoutSec, startedAt: new Date().toISOString(), supervisorPid: process.pid, status: heavy ? 'queued' : 'running', log, ...(heavy ? { heavy: true, slotWaitSec } : {}) };
  withStateLock(repo, run, () => {
    const q = openQuestionsReason(repo, run);
    if (q) throw new Error(`QUESTIONS_OPEN: ${q}; start nothing`);
    claim(lock, { ...rec, timeoutSec: heavy ? timeoutSec + slotWaitSec : timeoutSec });
    try {
      try { unlinkSync(stop); } catch { /* no stale stop request */ }
      writeFileSync(log, '');
      saveJob(file, rec);
    } catch (e) { try { unlinkSync(lock); } catch { /* gone */ } throw e; }
  });
  if (foreground) process.stdout.on('error', () => { /* a closed pipe must not crash the supervisor */ });
  let slotFile = null;
  if (heavy) {
    // While queued the supervisor must still honour stop requests and signals, and must never leave a queued record behind.
    let queuedStop = false; const onQ = () => { queuedStop = true; };
    for (const sg of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sg, onQ);
    const endEarly = (status, exitCode, note) => {
      const out = { ...rec, status, exitCode, endedAt: new Date().toISOString(), note };
      saveJob(file, out); try { unlinkSync(lock); } catch { /* gone */ } try { unlinkSync(stop); } catch { /* none */ }
      return out;
    };
    try {
      slotFile = await acquireSlot({ slots, waitSec: slotWaitSec, rec, shouldStop: () => queuedStop || existsSync(stop) });
    } catch (e) { return endEarly('failed', 1, `heavy-job slot error: ${e.message}`); } finally { for (const sg of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(sg, onQ); }
    if (slotFile === 'stopped') return endEarly('killed', 143, 'stopped while queued; nothing was run');
    if (!slotFile) return endEarly('no-slot', 75, `no heavy-job slot free within ${slotWaitSec}s (${slots} slot(s) busy); nothing was run`);
    rec.status = 'running'; rec.startedAt = new Date().toISOString(); rec.slot = slotFile; rec.slotWaitSec = 0; saveJob(file, rec); // the timeout clock starts when the job does
  }
  return new Promise(res => {
    let timedOut = false, stopped = false, done = false, logFailed = false, timer, grace;
    const child = spawn(cmd, { shell: true, cwd: rec.cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    rec.pid = child.pid; saveJob(file, rec);
    const sink = chunk => { try { appendFileSync(log, chunk); } catch { logFailed = true; } if (foreground) { try { process.stdout.write(chunk); } catch { /* closed */ } } };
    child.stdout.on('data', sink); child.stderr.on('data', sink);
    const finish = (status, exitCode, extra = {}) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(grace);
      for (const sg of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(sg, onSignal);
      const out = { ...rec, status, exitCode, endedAt: new Date().toISOString(), ...(logFailed ? { logWarning: 'the log could not be fully written' } : {}), ...extra };
      // Only the current owner of the name publishes (a takeover after a hang must not be overwritten); a missing lock
      // (swept by a cleanup) is not another owner, so the result is still recorded.
      releaseSlot(slotFile);
      const owner = readLock(lock);
      if (!owner || owner.pid === process.pid) {
        saveJob(file, out);
        try { unlinkSync(lock); } catch { /* gone */ }
        try { unlinkSync(stop); } catch { /* none */ }
      }
      res(out);
    };
    const conclude = (code, signal) => {
      if (timedOut) return finish('timeout', 124, { note: `killed after ${timeoutSec}s` });
      if (stopped || existsSync(stop)) return finish('killed', 143, { note: 'stopped' });
      if (code === 0) return finish('passed', 0);
      finish('failed', code ?? 1, signal ? { note: `signal ${signal}` } : {});
    };
    // A descendant that escaped the process group can hold the output pipes open after the command is gone or killed;
    // the result must not wait for it.
    const release = (code, signal) => { clearTimeout(grace); grace = setTimeout(() => { try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* closed */ } conclude(code, signal); }, 3000); };
    timer = setTimeout(() => { timedOut = true; killTree(child.pid); release(null, 'SIGTERM'); }, timeoutSec * 1000);
    const onSignal = () => { stopped = true; killTree(child.pid); };
    for (const sg of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sg, onSignal);
    child.on('error', e => finish('failed', 127, { note: `could not start: ${e.message}` }));
    child.on('exit', (code, signal) => release(code, signal));
    child.on('close', (code, signal) => conclude(code, signal));
  });
}

export async function waitJob(repo, run, name, { timeoutSec = DEFAULT_WAIT_SEC, pollMs = 500 } = {}) {
  check(run, name);
  const file = jobFile(repo, run, name);
  if (!existsSync(file)) throw new Error(`JOB_UNKNOWN: no job ${name} in run ${run}`);
  const end = Date.now() + timeoutSec * 1000;
  for (;;) {
    let rec; try { rec = effective(JSON.parse(readFileSync(file, 'utf8'))); } catch { rec = null; }
    if (rec && rec.status !== 'running' && rec.status !== 'queued') return rec;
    if (Date.now() >= end) return { ...(rec || { name }), status: rec?.status === 'queued' ? 'queued' : 'running', waitedSec: timeoutSec, stillRunning: true };
    await sleep(Math.min(pollMs, Math.max(50, end - Date.now())));
  }
}

// Writes a stop request and kills the job's process tree; the supervisor then records "killed". A lost job is never
// killed by pid: its pid may now belong to an unrelated process.
export function stopJob(repo, run, name) {
  check(run, name);
  const file = jobFile(repo, run, name);
  if (!existsSync(file)) throw new Error(`JOB_UNKNOWN: no job ${name} in run ${run}`);
  const rec = effective(JSON.parse(readFileSync(file, 'utf8')));
  if (rec.status === 'lost') throw new Error(`JOB_LOST: ${name} lost its supervisor, so it is not killed by pid (it may no longer be this job); check your process list, then rerun it`);
  if (rec.status !== 'running' && rec.status !== 'queued') return rec;
  writeFileSync(stopFile(repo, run, name), '');
  killTree(rec.pid);
  return { ...rec, status: 'stopping' };
}

// A job whose supervisor died keeps running orphaned (a host killed the shell call). Stopping it by pid is allowed only
// when the pid still shows THIS job's command line, because a recycled pid belongs to somebody else. POSIX only.
export function stopLostJob(repo, run, name, { psArgs = pid => spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).stdout.trim() } = {}) {
  check(run, name);
  const file = jobFile(repo, run, name);
  if (!existsSync(file)) throw new Error(`JOB_UNKNOWN: no job ${name} in run ${run}`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const rec = effective(raw);
  if (rec.status !== 'lost') throw new Error(`JOB_NOT_LOST: ${name} is ${rec.status}; --lost is only for a job whose supervisor died`);
  if (process.platform === 'win32') throw new Error('JOB_LOST_WINDOWS: stopping an orphan by pid is not supported on Windows; end it from Task Manager after checking its command line, then rerun');
  const done = note => { const r = { ...raw, status: 'killed', exitCode: 143, endedAt: new Date().toISOString(), note }; saveJob(file, r); return r; };
  if (!Number.isInteger(raw.pid) || !pidAlive(raw.pid)) return done('lost job: its process was already gone');
  const args = psArgs(raw.pid);
  if (!args || !String(args).includes(String(raw.cmd || '').slice(0, 80))) throw new Error(`JOB_PID_NOT_VERIFIED: pid ${raw.pid} no longer shows this job's command line, so it is not killed (it may belong to another process); check your process list`);
  killTree(raw.pid);
  return done('lost job stopped by pid after its command line matched');
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = resolve(opt('repo') || '.');
  const out = o => process.stdout.write(`${JSON.stringify(o)}\n`);
  const intOpt = (n, dflt, max) => { const v = opt(n); if (v === undefined) return dflt; const x = Number(v); if (!Number.isInteger(x) || x < 1 || x > max) throw new Error(`${n.toUpperCase().replace('-', '_')}_INVALID: whole number between 1 and ${max}`); return x; };
  const heavyOpts = (waitDflt = DEFAULT_SLOT_WAIT_SEC) => argv.includes('--heavy') ? { heavy: true, slots: intOpt('slots', Number(process.env.THL_HEAVY_SLOTS) || DEFAULT_HEAVY_SLOTS, 16), slotWaitSec: intOpt('slot-wait', waitDflt, 3600) } : {};
  (async () => {
    try {
      if ((cmd === 'run' || cmd === 'start' || cmd === '_supervise') && validRunId(opt('run'))) { const q = openQuestionsReason(repo, opt('run')); if (q) throw new Error(`QUESTIONS_OPEN: ${q}; start nothing`); }
      if (cmd === 'run') {
        const heavy = argv.includes('--heavy');
        const tmo = parseTimeout(opt('timeout'), heavy ? 480 : DEFAULT_RUN_TIMEOUT_SEC); const ho = heavy ? heavyOpts(60) : {};
        if (heavy && ho.slotWaitSec + tmo > 570) throw new Error('JOB_BUDGET: run --heavy keeps slot-wait + timeout within 570 s (a host may kill a longer tool call); use start + wait for longer jobs');
        const r = await supervise({ repo, run: opt('run'), name: opt('name'), cmd: opt('cmd'), cwd: opt('cwd') ? resolve(opt('cwd')) : undefined, timeoutSec: tmo, foreground: true, ...ho });
        process.stderr.write(`JOBS: ${r.name} ${r.status} (exit ${r.exitCode})\n`);
        process.exitCode = r.status === 'no-slot' ? 75 : r.exitCode === 75 ? 1 : r.exitCode;
      } else if (cmd === '_supervise') {
        await supervise({ repo, run: opt('run'), name: opt('name'), cmd: opt('cmd'), cwd: opt('cwd') ? resolve(opt('cwd')) : undefined, timeoutSec: parseTimeout(opt('timeout'), DEFAULT_START_TIMEOUT_SEC), foreground: false, ...heavyOpts() });
      } else if (cmd === 'start') {
        check(opt('run'), opt('name')); parseTimeout(opt('timeout'), DEFAULT_START_TIMEOUT_SEC);
        const args = [fileURLToPath(import.meta.url), '_supervise', '--repo', repo, '--run', opt('run'), '--name', opt('name'), '--cmd', opt('cmd') || ''];
        if (opt('timeout')) args.push('--timeout', opt('timeout'));
        if (opt('cwd')) args.push('--cwd', resolve(opt('cwd')));
        if (argv.includes('--heavy')) { const h = heavyOpts(); args.push('--heavy', '--slots', String(h.slots), '--slot-wait', String(h.slotWaitSec)); }
        // the supervisor's own startup errors (name already running, unwritable folder) are captured, not lost
        mkdirSync(jobsDir(repo, opt('run')), { recursive: true });
        const errPath = join(jobsDir(repo, opt('run')), `${opt('name')}.${process.pid}.start-error.log`);
        const t0 = Date.now();
        const errFd = openSync(errPath, 'w');
        const sv = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'ignore', errFd], windowsHide: true }); sv.unref(); closeSync(errFd);
        let svExited = false; sv.on('exit', () => { svExited = true; });
        let rec = null;
        for (let i = 0; i < 100 && !rec; i++) {
          await sleep(100);
          try { const r = JSON.parse(readFileSync(jobFile(repo, opt('run'), opt('name')), 'utf8')); if (r.supervisorPid === sv.pid && Date.parse(r.startedAt) >= t0) rec = r; /* not an older job's record that reused the pid */ } catch { /* not yet */ }
          if (!rec && svExited) break;
        }
        if (!rec) { let why = ''; try { why = readFileSync(errPath, 'utf8').trim(); } catch { /* none */ } try { unlinkSync(errPath); } catch { /* none */ } throw new Error(why ? why.replace(/^JOBS: /, '') : 'JOB_NOT_STARTED: the supervisor did not register the job'); }
        try { unlinkSync(errPath); } catch { /* keep */ }
        out({ name: rec.name, status: rec.status, log: rec.log, next: `node jobs.mjs wait --repo . --run ${opt('run')} --name ${rec.name}  (wait inside THIS turn; do not end the turn while it runs)` });
      } else if (cmd === 'wait') {
        const r = await waitJob(repo, opt('run'), opt('name'), { timeoutSec: parseTimeout(opt('timeout'), DEFAULT_WAIT_SEC) });
        out(r);
        process.exitCode = r.stillRunning ? 124 : r.status === 'passed' ? 0 : r.status === 'lost' ? 125 : r.status === 'timeout' ? 126 : r.status === 'no-slot' ? 75 : ([75, 124, 125, 126].includes(r.exitCode) || !r.exitCode ? 1 : r.exitCode);
      } else if (cmd === 'check') {
        const jobs = readJobs(repo, opt('run'));
        const running = jobs.filter(j => j.status === 'running' || j.status === 'queued').map(j => j.name), lost = jobs.filter(j => j.status === 'lost').map(j => j.name);
        out({ running, lost, finished: jobs.filter(j => !['running', 'queued', 'lost'].includes(j.status)).map(j => ({ name: j.name, status: j.status, exitCode: j.exitCode })) });
        if (running.length || lost.length) { process.stderr.write(`JOBS: do not end the turn: ${running.length ? `wait for ${running.join(', ')} with jobs.mjs wait` : ''}${running.length && lost.length ? '; ' : ''}${lost.length ? `${lost.join(', ')} lost its supervisor (its process may still be running: check, jobs.mjs stop cannot kill a lost job), then rerun it` : ''}\n`); process.exitCode = 2; }
      } else if (cmd === 'stop') {
        out(argv.includes('--lost') ? stopLostJob(repo, opt('run'), opt('name')) : stopJob(repo, opt('run'), opt('name')));
      } else if (cmd === 'list') {
        out(readJobs(repo, opt('run')).map(j => ({ name: j.name, status: j.status, exitCode: j.exitCode, startedAt: j.startedAt, endedAt: j.endedAt, log: j.log })));
      } else throw new Error('USAGE: run|start|wait|check|stop|list');
    } catch (e) { process.stderr.write(`JOBS: ${e.message}\n`); process.exitCode = 3; }
  })();
}
