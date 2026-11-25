#!/usr/bin/env node
// TrioHarness Lean — serialize commands that share a resource (a worktree's bin/obj/TestResults, a fixed port,
// a local database, a fixed log file) across concurrent workers, tasks and sessions on this machine.
// Usage:
//   node run-lock.mjs run [--name <lock> ...] [--timeout <seconds>] -- <command> [args...]
//        always locks this worktree, plus each named resource (other worktrees still run in parallel)
//        --timeout is the total acquisition budget in seconds (default 900), shared by all locks
//   node run-lock.mjs status [--name <lock>]
// Implicit tree locks are always acquired first/outermost and are excluded from named-lock ordering.
// Only explicitly named resources enforce ascending extensions; declare all names at the outermost call
// if a nested call needs an earlier name. A different tree's implicit lock acquires normally: residual
// cross-tree waiting is bounded by the same total timeout, rather than rejected as a named inversion.
// Descendants, including sibling children under one wrapper, share its inherited locks; siblings that
// need mutual exclusion must use separate outer wrappers. Names dedupe case-insensitively; the first
// spelling is preserved for filenames and inherited claims, including legacy mixed-case locks.
// Inherited name/nonce pairs are valid only while their matching lock file and owner wrapper are live.
// Claims are validated only at acquisition: a detached job inheriting a claim keeps running unlocked
// after its wrapper exits. Use a separate outer wrapper when detached work needs its own lifetime lock.
// Child pid publication is tree-first; group liveness protects secondary locks before their updates.
// Before the tree lock publishes the child pid, wrapper SIGKILL has the original single-lock window.
// Exit: the command's exit code · 75 lock timeout (another holder is alive) · 3 usage error
// Never kills another holder; reclaim requires its owner and all matching group members to be dead.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { scrubEnv } from './secret-patterns.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './is-main.mjs';

export const LOCK_DIR = join(homedir(), '.trioharness-lean', 'locks');
export const EXIT_LOCK_TIMEOUT = 75;

export function lockNameFor(cwd) {
  let top = cwd;
  try { top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() || cwd; } catch { /* not a repo */ }
  // Real path: macOS temp dirs are symlinks, so the same worktree must hash identically from either spelling.
  try { top = realpathSync(top); } catch { /* keep as given */ }
  return `worktree-${createHash('sha256').update(resolve(top).toLowerCase()).digest('hex').slice(0, 16)}`;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Run executables directly (paths with spaces stay intact). Only Windows batch shims such as npm.cmd,
// which cannot be spawned directly, fall back to the shell with every argument quoted.
// The child never inherits credentials: proof commands, repo-defined scripts and worker commands run with
// the Architect's environment minus every secret-shaped variable. A command that needs one is run through
// `secrets.mjs require`, which adds exactly the names asked for.
export function runCommand(command, { platform = process.platform, spawn = spawnSync, env = process.env } = {}) {
  const { env: childEnv } = scrubEnv(env);
  let r = spawn(command[0], command.slice(1), { stdio: 'inherit', env: childEnv });
  if (r.error && platform === 'win32' && (r.error.code === 'ENOENT' || r.error.code === 'EINVAL')) {
    const q = a => (/[\s"&|<>^()%!]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
    r = spawn(command.map(q).join(' '), { stdio: 'inherit', shell: true, env: childEnv });
  }
  return r.status ?? 1;
}
// Lock notes identify a command without storing its arguments (which may carry a connection string).
export const commandNote = command => `${String(command[0] || '').split(/[\\/]/).pop()} #${createHash('sha256').update(command.join('\u0000')).digest('hex').slice(0, 12)}`;

const publicationWarning = e => process.stderr.write(`RUN-LOCK: child pid publication failed (${e.code || 'IO_ERROR'}); wrapper retains locks until command exit.\n`);

// Same child environment and Windows-shim fallback as runCommand, but asynchronous so the child's pid is known
// (and recorded in the lock) while it runs, and a SIGTERM to the wrapper is forwarded to it.
export function runCommandAsync(command, { platform = process.platform, env = process.env, onChild = () => {}, signals = true } = {}) {
  const { env: childEnv } = scrubEnv(env);
  return new Promise(resolveRun => {
    let child = null; let shell = false;
    const forward = sig => () => { try { child?.kill(sig); } catch { /* gone */ } };
    const handlers = signals ? ['SIGINT', 'SIGTERM'].map(sg => [sg, forward(sg)]) : [];
    for (const [sg, h] of handlers) process.on(sg, h);
    const done = status => { for (const [sg, h] of handlers) process.off(sg, h); resolveRun(status); };
    const q = a => (/[\s"&|<>^()%!]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
    const canShim = e => !shell && platform === 'win32' && (e?.code === 'ENOENT' || e?.code === 'EINVAL');
    const start = () => {
      let c;
      try { c = shell ? nodeSpawn(command.map(q).join(' '), { stdio: 'inherit', shell: true, env: childEnv }) : nodeSpawn(command[0], command.slice(1), { stdio: 'inherit', env: childEnv }); }
      catch (e) { if (canShim(e)) { shell = true; return start(); } return done(1); } // Node throws EINVAL for .cmd/.bat synchronously
      child = c;
      let superseded = false; // an ENOENT child emits 'error' AND then 'close'; the close of a replaced child must not end the run
      c.on('error', e => { if (canShim(e)) { superseded = true; shell = true; start(); } else if (!superseded) done(1); });
      c.on('close', (code, sig) => { if (superseded) return; done(code ?? (sig ? 128 + (sig === 'SIGTERM' ? 15 : sig === 'SIGINT' ? 2 : 9) : 1)); });
      // Publication is advisory while the wrapper lives: never unwind and release its locks early.
      if (c.pid) { try { onChild(c.pid); } catch (e) { publicationWarning(e); } }
    };
    start();
  });
}

export function readLock(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// A child may already be running while only the first (tree) lock has published its pid. All members
// of an acquisition group share the wrapper pid and nonce, so that first publication protects them all.
const ownerLive = (holder, isAlive) => isAlive(holder.pid) || (Number.isInteger(holder.childPid) && isAlive(holder.childPid));
const holderLive = (holder, isAlive, dir) => {
  if (ownerLive(holder, isAlive)) return true;
  if (!Array.isArray(holder.group) || typeof holder.nonce !== 'string') return false; // legacy single lock
  return holder.group.some(name => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(name)) return false;
    const member = readLock(join(dir, `${name}.lock`));
    return member && member.pid === holder.pid && member.host === holder.host && member.nonce === holder.nonce && ownerLive(member, isAlive);
  });
};

// A transient/undecidable read must not discard a valid inherited claim and make a nested wrapper wait
// on its own ancestor. Retry once before acquisition; mismatched or expired ownership is not inherited.
export async function claimHolder(name, nonce, { dir = LOCK_DIR, read = readLock, isAlive = alive, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const file = join(dir, `${name}.lock`);
  let holder = read(file);
  if (!holder) { await sleep(10); holder = read(file); }
  return holder && holder.host === hostname() && holder.nonce === nonce && Number.isInteger(holder.pid) && holder.pid > 0 && isAlive(holder.pid) ? holder : null;
}

export function tryAcquire(name, { dir = LOCK_DIR, pid = process.pid, note = '', isAlive = alive, guardStaleMs = 10000, implicit = false, group = [name], nonce = randomBytes(32).toString('hex') } = {}) {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) throw new Error(`LOCK_NAME_INVALID: ${name}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.lock`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid, host: hostname(), at: new Date().toISOString(), nonce, group, implicit, note }));
      closeSync(fd);
      return { acquired: true, file, nonce };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = readLock(file);
      if (!(holder && holder.host === hostname() && !holderLive(holder, isAlive, dir))) return { acquired: false, file, holder };
      // Stale. Removing it is a check-then-act, so it runs under a short-lived guard: whoever holds the guard
      // re-reads the lock and removes it only if it is still the same dead holder (never a lock another process
      // took in between).
      const guard = `${file}.reclaim`;
      let gfd;
      try { gfd = openSync(guard, 'wx'); closeSync(gfd); } catch (ge) {
        if (ge.code !== 'EEXIST') throw ge;
        try { if (Date.now() - statSync(guard).mtimeMs > guardStaleMs) rmSync(guard, { force: true }); } catch { /* gone */ }
        continue; // someone else is reclaiming: look again
      }
      try {
        const again = readLock(file);
        if (again && again.pid === holder.pid && again.at === holder.at && again.nonce === holder.nonce && !holderLive(again, isAlive, dir)) rmSync(file, { force: true });
      } finally { rmSync(guard, { force: true }); }
    }
  }
  return { acquired: false, file, holder: readLock(file) };
}

// Record the started command's pid in the lock this process holds.
export function recordChild(file, childPid, pid = process.pid, {
  beforeRename = () => {}, rename = renameSync,
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  onError = publicationWarning
} = {}) {
  const holder = readLock(file);
  if (!holder || holder.pid !== pid) return;
  // Same-directory rename exposes either the complete old record or the complete new one to readers.
  const temp = join(dirname(file), `.run-lock-${pid}-${randomBytes(16).toString('hex')}.tmp`);
  let failure;
  try {
    writeFileSync(temp, JSON.stringify({ ...holder, childPid }), { flag: 'wx', mode: 0o600 });
    beforeRename(); // injectable interleaving point; production does not yield here
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = readLock(file);
      if (!current || current.pid !== pid || current.nonce !== holder.nonce || current.at !== holder.at) break;
      try { rename(temp, file); break; }
      catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt === 2) throw e;
        sleep(10 * (attempt + 1));
      }
    }
  } catch (e) { failure = e; }
  finally {
    try { rmSync(temp, { force: true }); } catch (e) { failure ??= e; }
  }
  if (failure) onError(failure); // old record still protects the lock through the live wrapper
}

export function release(file, pid = process.pid) {
  const holder = readLock(file);
  if (holder && holder.pid === pid) rmSync(file, { force: true });
}

export async function acquire(name, { timeoutSeconds = 900, pollMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, deadline = now() + timeoutSeconds * 1000, ...opts } = {}) {
  let last;
  do {
    last = tryAcquire(name, opts);
    if (last.acquired) return last;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  } while (now() < deadline);
  return last;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const sep = argv.indexOf('--');
  const head = sep >= 0 ? argv.slice(0, sep) : argv;
  const opt = n => { const i = head.indexOf(`--${n}`); return i >= 0 ? head[i + 1] : undefined; };
  const name = opt('name') || lockNameFor(process.cwd());
  if (cmd === 'status') {
    const holder = readLock(join(LOCK_DIR, `${name}.lock`));
    const { nonce, ...publicHolder } = holder || {};
    process.stdout.write(`${JSON.stringify({ name, holder: holder ? publicHolder : null })}\n`);
  } else if (cmd === 'run' && sep >= 0 && argv.length > sep + 1) {
    const command = argv.slice(sep + 1);
    const deadline = Date.now() + +(opt('timeout') || 900) * 1000;
    const tree = lockNameFor(process.cwd());
    const namedByKey = new Map();
    for (const [i, arg] of head.entries()) {
      if (arg !== '--name' || !head[i + 1]) continue;
      const original = head[i + 1], key = original.toLowerCase();
      if (!namedByKey.has(key)) namedByKey.set(key, original);
    }
    const named = [...namedByKey.keys()].sort().map(key => namedByKey.get(key));
    const names = [tree, ...named.filter(n => n.toLowerCase() !== tree)];
    // This context survives scrubEnv. Never trust a bare name, an expired nonce, or a dead wrapper.
    const nonce = randomBytes(32).toString('hex'); // shared only by locks acquired by this wrapper
    let claims;
    try { claims = JSON.parse(process.env.TRIO_RUN_LOCKS_HELD || '[]'); } catch { /* old/forged context is not ownership */ }
    const inherited = new Map();
    for (const pair of Array.isArray(claims) ? claims : []) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [n, nonce] = pair;
      if (typeof n !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(n) || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) continue;
      const holder = await claimHolder(n, nonce);
      if (holder) inherited.set(n.toLowerCase(), { name: n, nonce, implicit: holder.implicit === true });
    }
    // Use the lock's acquisition kind, not its spelling: explicit --name worktree-* still participates.
    const heldNamed = [...inherited].filter(([, claim]) => !claim.implicit).map(([n]) => n);
    const inversion = named.find(n => n.toLowerCase() !== tree && !inherited.has(n.toLowerCase()) && heldNamed.some(held => held > n.toLowerCase()));
    if (inversion) {
      process.stderr.write(`RUN-LOCK: named lock order inversion for "${inversion}"; declare all names at the outermost call.\n`);
      process.exit(3);
    }
    const acquired = [];
    const releaseAll = () => { for (const got of [...acquired].reverse()) release(got.file); };
    // During acquisition there is no child to forward a signal to. Release partial ownership immediately.
    const handlers = ['SIGINT', 'SIGTERM'].map(sig => [sig, () => { releaseAll(); process.exit(sig === 'SIGINT' ? 130 : 143); }]);
    let status = 1;
    try {
      for (const [sig, handler] of handlers) process.on(sig, handler);
      try {
        for (const lockName of names) {
          const key = lockName.toLowerCase(), claim = inherited.get(key);
          if (claim && await claimHolder(claim.name, claim.nonce)) continue;
          inherited.delete(key);
          const got = await acquire(lockName, { deadline, implicit: lockName === tree, note: commandNote(command), group: names, nonce });
          if (!got.acquired) {
            process.stderr.write(`RUN-LOCK: timed out waiting for "${lockName}" held by pid ${got.holder?.pid} since ${got.holder?.at} (${got.holder?.note || ''}). Not killing it; retry later or ask the user.\n`);
            status = EXIT_LOCK_TIMEOUT;
            break;
          }
          acquired.push(got);
          inherited.set(key, { name: lockName, nonce: got.nonce, implicit: lockName === tree });
        }
      } finally { for (const [sig, handler] of handlers) process.off(sig, handler); }
      if (status !== EXIT_LOCK_TIMEOUT) {
        let publicationWarned = false;
        const onError = e => { if (!publicationWarned) { publicationWarned = true; publicationWarning(e); } };
        status = await runCommandAsync(command, {
          env: { ...process.env, TRIO_RUN_LOCKS_HELD: JSON.stringify([...inherited.values()].map(claim => [claim.name, claim.nonce])) },
          // acquired is tree-first. Inherited members have another pid/nonce and are ignored in group scans.
          onChild: cpid => { for (const got of acquired) recordChild(got.file, cpid, process.pid, { onError }); }
        });
      }
    } finally { releaseAll(); }
    process.exit(status);
  } else {
    process.stderr.write('Usage: node run-lock.mjs run [--name <lock> ...] [--timeout <total-seconds>] -- <command> [args...] | status [--name <lock>]\n');
    process.exit(3);
  }
}
