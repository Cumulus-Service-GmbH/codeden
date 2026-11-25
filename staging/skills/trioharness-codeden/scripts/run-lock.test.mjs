import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK_DIR, lockNameFor, readLock, tryAcquire, recordChild } from './run-lock.mjs';
import * as runLock from './run-lock.mjs';

const cli = fileURLToPath(new URL('./run-lock.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 30000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await delay(25);
  }
}
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'run-lock-cli-'));
  const a = join(dir, 'a'), b = join(dir, 'b');
  mkdirSync(a); mkdirSync(b);
  const children = [], stops = [];
  const names = new Set([lockNameFor(a), lockNameFor(b)]);
  const name = (suffix, prefix = 'z') => { const n = `${prefix}-run-lock-${process.pid}-${dir.split(/[/\\]/).at(-1).toLowerCase()}-${suffix}`; names.add(n); return n; };
  const file = n => join(LOCK_DIR, `${n}.lock`);
  function start(cwd, locks = [], command = [process.execPath, '-e', 'process.exit(0)'], timeout = '0', inherited, renameFailures) {
    // Each CLI scenario is independent of the outer test runner's inherited tree lock.
    const env = { ...process.env }; delete env.TRIO_RUN_LOCKS_HELD;
    if (inherited !== undefined) env.TRIO_RUN_LOCKS_HELD = inherited;
    // Patch the actual filesystem binding in this wrapper only, before importing the CLI.
    const injection = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.renameSync;let failures=0;
      fs.renameSync=(...args)=>{if(args[0].includes('.run-lock-')&&failures++<${renameFailures ?? 0})throw Object.assign(new Error('injected rename failure'),{code:'EPERM'});return rename(...args)};
      syncBuiltinESMExports();process.argv.splice(1,0,${JSON.stringify(cli)});await import(${JSON.stringify(new URL('./run-lock.mjs', import.meta.url).href)});`;
    const prefix = renameFailures === undefined ? [cli] : ['--input-type=module', '-e', injection];
    const child = spawn(process.execPath, [...prefix, 'run', ...locks.flatMap(n => ['--name', n]), '--timeout', timeout, '--', ...command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', s => { stdout += s; }); child.stderr.on('data', s => { stderr += s; });
    const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
    children.push({ child, done });
    return { child, done, output: () => ({ stdout, stderr }) };
  }
  let count = 0;
  async function hold(cwd, locks = [], renameFailures) {
    const ready = join(dir, `ready-${count}`), stop = join(dir, `stop-${count++}`);
    stops.push(stop);
    const command = [process.execPath, '-e', 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0)},25)', ready, stop];
    const run = start(cwd, locks, command, '10', undefined, renameFailures);
    await until(() => existsSync(ready), 'holder child did not start');
    return { ...run, ready, stop, finish: async () => { writeFileSync(stop, ''); assert.equal((await run.done).code, 0); } };
  }
  t.after(async () => {
    for (const stop of stops) writeFileSync(stop, '');
    for (const { child } of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
    await Promise.all(children.map(c => c.done));
    for (const n of names) rmSync(file(n), { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  return { a, b, dir, name, file, start, hold };
}

for (const namedFirst of [false, true]) test(`same tree: ${namedFirst ? 'named blocks default' : 'default blocks named'}`, async t => {
  const f = setup(t), n = f.name('shared');
  const holder = await f.hold(f.a, namedFirst ? [n] : []);
  const r = await f.start(f.a, namedFirst ? [] : [n]).done;
  assert.equal(r.code, 75, r.stderr);
  await holder.finish();
});

test('different trees: a shared name contends', async t => {
  const f = setup(t), n = f.name('shared');
  const holder = await f.hold(f.a, [n]);
  const r = await f.start(f.b, [n]).done;
  assert.equal(r.code, 75, r.stderr);
  await holder.finish();
});

test('repeatable names are de-duplicated and opposite orders serialize without deadlock', async t => {
  const f = setup(t), x = f.name('x'), y = f.name('y');
  const holder = await f.hold(f.a, [y, x, y]);
  assert.equal(readLock(f.file(x))?.pid, holder.child.pid);
  assert.equal(readLock(f.file(y))?.pid, holder.child.pid);
  const other = f.start(f.b, [x, y, x], undefined, '10');
  await until(() => existsSync(f.file(lockNameFor(f.b))), 'contender did not acquire its tree first');
  assert.equal(other.child.exitCode, null);
  await holder.finish();
  const r = await other.done; assert.equal(r.code, 0, r.stderr);
  for (const n of [lockNameFor(f.a), lockNameFor(f.b), x, y]) assert.equal(existsSync(f.file(n)), false);
});

test('default run passes its tree name and preserves command exit status', async t => {
  const f = setup(t);
  const r = await f.start(f.a, [], [process.execPath, '-e', 'console.log(process.env.TRIO_RUN_LOCKS_HELD);process.exit(7)']).done;
  assert.equal(r.code, 7); const claims = JSON.parse(r.stdout);
  assert.equal(claims.length, 1); assert.equal(claims[0][0], lockNameFor(f.a));
  assert.match(claims[0][1], /^[a-f0-9]{64}$/);
  assert.equal(existsSync(f.file(lockNameFor(f.a))), false);
});

test('nested named runs inherit ancestor locks, add new names, and retain ancestor ownership', async t => {
  const f = setup(t), x = f.name('x'), y = f.name('y');
  const probe = 'const fs=require("node:fs");const claims=JSON.parse(process.env.TRIO_RUN_LOCKS_HELD);const names=claims.map(([n])=>n);console.log(JSON.stringify(names));for(const n of names){const h=JSON.parse(fs.readFileSync(process.argv[1]+"/"+n+".lock"));if(!h.childPid||!h.at||!claims.some(([name,nonce])=>name===n&&nonce===h.nonce))process.exit(8)}';
  const nested = [process.execPath, cli, 'run', '--name', x, '--name', y, '--timeout', '0', '--', process.execPath, '-e', probe, LOCK_DIR];
  // The intermediate child checks that the inner wrapper did not release inherited locks.
  const script = 'const cp=require("node:child_process"),fs=require("node:fs");const r=cp.spawnSync(process.execPath,JSON.parse(process.argv[1]),{stdio:"inherit"});if(r.status!==0)process.exit(r.status||1);for(const n of JSON.parse(process.env.TRIO_RUN_LOCKS_HELD).map(([n])=>n)){if(!fs.existsSync(process.argv[2]+"/"+n+".lock"))process.exit(9)}';
  const r = await f.start(f.a, [x], [process.execPath, '-e', script, JSON.stringify(nested.slice(1)), LOCK_DIR]).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [lockNameFor(f.a), x, y].sort());
  for (const n of [lockNameFor(f.a), x, y]) assert.equal(existsSync(f.file(n)), false);
});

test('partial acquisition: timeout on a held second lock releases the tree', async t => {
  const f = setup(t), n = f.name('held');
  const holder = await f.hold(f.b, [n]);
  const r = await f.start(f.a, [n]).done;
  assert.equal(r.code, 75, r.stderr);
  assert.equal(existsSync(f.file(lockNameFor(f.a))), false);
  assert.equal(readLock(f.file(n))?.pid, holder.child.pid);
  await holder.finish();
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`partial acquisition: ${signal} releases already acquired locks`, {
  skip: process.platform === 'win32' ? 'Requires POSIX signal delivery and exit codes' : false
}, async t => {
  const f = setup(t), x = f.name('a'), y = f.name('z');
  const holder = await f.hold(f.b, [y]);
  const pending = f.start(f.a, [x, y], undefined, '60');
  await until(() => readLock(f.file(x))?.pid === pending.child.pid, 'first named lock was not acquired');
  pending.child.kill(signal);
  const r = await pending.done;
  assert.equal(r.code, signal === 'SIGINT' ? 130 : 143);
  for (const n of [lockNameFor(f.a), x]) assert.equal(existsSync(f.file(n)), false);
  assert.equal(readLock(f.file(y))?.pid, holder.child.pid);
  await holder.finish();
});

test('partial acquisition: an invalid later name releases earlier locks', async t => {
  const f = setup(t), n = f.name('a');
  const r = await f.start(f.a, [n, 'zz invalid']).done;
  assert.equal(r.code, 1); assert.match(r.stderr, /LOCK_NAME_INVALID/);
  for (const name of [lockNameFor(f.a), n]) assert.equal(existsSync(f.file(name)), false);
});

test('every lock records the live child; secondary locks survive wrapper death then recover', {
  skip: process.platform === 'win32' ? 'Requires POSIX SIGKILL and orphan process survival' : false
}, async t => {
  const f = setup(t), x = f.name('a'), y = f.name('z');
  const holder = await f.hold(f.a, [x, y]);
  const locks = [lockNameFor(f.a), x, y];
  const childPid = readLock(f.file(locks[0]))?.childPid;
  assert.ok(Number.isInteger(childPid));
  for (const n of locks) assert.equal(readLock(f.file(n))?.childPid, childPid);
  holder.child.kill('SIGKILL');
  // 'close' also waits for stdout inherited by the orphan; observe wrapper exit separately.
  await until(() => holder.child.signalCode === 'SIGKILL', 'wrapper did not exit');
  const blocked = await f.start(f.b, [y]).done;
  assert.equal(blocked.code, 75, blocked.stderr);
  writeFileSync(holder.stop, '');
  await until(() => { try { process.kill(childPid, 0); return false; } catch { return true; } }, 'orphan child did not exit');
  await holder.done;
  const recovered = await f.start(f.b, [y]).done;
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(existsSync(f.file(y)), false);
});

test('a stale secondary lock is reclaimed while acquiring the full set', async t => {
  const f = setup(t), n = f.name('stale');
  // Obtain a genuinely dead pid without guessing an OS-specific pid limit.
  const dead = f.start(f.b); await dead.done;
  writeFileSync(f.file(n), JSON.stringify({ pid: dead.child.pid, host: hostname(), at: 'old' }));
  const r = await f.start(f.a, [n]).done;
  assert.equal(r.code, 0, r.stderr);
  for (const name of [lockNameFor(f.a), n]) assert.equal(existsSync(f.file(name)), false);
});


// A probe observes ownership while the command is running, before the wrapper releases it.
const ownerProbe = 'const fs=require("node:fs");const p=process.argv[1];console.log(fs.existsSync(p)?fs.readFileSync(p,"utf8"):"null")';

test('forged legacy name-only context cannot skip acquisition', async t => {
  const f = setup(t), n = f.name('forged');
  const r = await f.start(f.a, [n], [process.execPath, '-e', ownerProbe, f.file(n)], '0', n).done;
  assert.equal(r.code, 0, r.stderr);
  const holder = JSON.parse(r.stdout);
  assert.ok(holder?.nonce, 'the requested lock must actually be acquired');
  assert.ok(holder.childPid); assert.ok(holder.at);
});

test('stale inherited context with a matching nonce and dead owner is reacquired', async t => {
  const f = setup(t), n = f.name('stale-context');
  const dead = f.start(f.b); await dead.done;
  const nonce = 'a'.repeat(64);
  writeFileSync(f.file(n), JSON.stringify({ pid: dead.child.pid, host: hostname(), nonce, at: 'old' }));
  const r = await f.start(f.a, [n], [process.execPath, '-e', ownerProbe, f.file(n)], '0', JSON.stringify([[n, nonce]])).done;
  assert.equal(r.code, 0, r.stderr);
  const holder = JSON.parse(r.stdout);
  assert.match(holder.nonce, /^[a-f0-9]{64}$/); assert.notEqual(holder.nonce, nonce);
  assert.notEqual(holder.pid, dead.child.pid);
});

for (const legacy of [false, true]) test(`foreign live holder cannot be bypassed with ${legacy ? 'a forged name' : 'a mismatched nonce'}`, async t => {
  const f = setup(t), n = f.name('foreign');
  const holder = await f.hold(f.b, [n]);
  const context = legacy ? n : JSON.stringify([[n, '0'.repeat(64)]]);
  const r = await f.start(f.a, [n], undefined, '0', context).done;
  assert.equal(r.code, 75, r.stderr);
  assert.equal(readLock(f.file(n)).pid, holder.child.pid);
  await holder.finish();
});

test('detached descendant after wrapper exit must acquire its own lock', {
  skip: process.platform === 'win32' ? 'Requires POSIX detached process and cleanup semantics' : false
}, async t => {
  const f = setup(t), n = f.name('detached');
  const go = join(f.dir, 'descendant-go'), result = join(f.dir, 'descendant-result');
  const descendant = `const fs=require('node:fs'),cp=require('node:child_process');
    const timer=setInterval(()=>{if(!fs.existsSync(process.argv[1]))return;clearInterval(timer);
    const r=cp.spawnSync(process.execPath,${JSON.stringify([cli, 'run', '--name', n, '--timeout', '0', '--', process.execPath, '-e', ownerProbe, f.file(n)])},{encoding:'utf8'});
    fs.writeFileSync(process.argv[2],JSON.stringify({code:r.status,stdout:r.stdout,stderr:r.stderr}));},25)`;
  const launch = `const cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)},...process.argv.slice(1)],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref()`;
  const r = await f.start(f.a, [n], [process.execPath, '-e', launch, go, result]).done;
  assert.equal(r.code, 0, r.stderr);
  const descendantPid = Number(r.stdout.trim());
  t.after(async () => {
    try { process.kill(descendantPid, 'SIGTERM'); } catch { /* already exited */ }
    await until(() => { try { process.kill(descendantPid, 0); return false; } catch { return true; } }, 'detached fixture did not exit');
  });
  assert.equal(existsSync(f.file(n)), false, 'outer wrapper must have released the lock');
  writeFileSync(go, '');
  await until(() => existsSync(result), 'detached descendant did not finish');
  const inner = JSON.parse(readFileSync(result, 'utf8'));
  assert.equal(inner.code, 0, inner.stderr);
  assert.ok(JSON.parse(inner.stdout)?.nonce, 'descendant must not trust the expired inherited claim');
});

for (const prefix of ['z', 'worktree']) test(`nested named order inversion fails fast (${prefix} prefix) and explains outermost declaration`, async t => {
  const f = setup(t), a = f.name('a', 'a'), z = f.name('z', prefix);
  const nested = [process.execPath, cli, 'run', '--name', a, '--timeout', '30', '--', process.execPath, '-e', 'console.log("unexpected child")'];
  const began = Date.now();
  const r = await f.start(f.a, [z], nested).done;
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /declare all names at the outermost call/i);
  assert.ok(Date.now() - began < 5000, 'inversion must not wait for timeout');
  assert.equal(r.stdout, '');
  for (const name of [lockNameFor(f.a), a, z]) assert.equal(existsSync(f.file(name)), false);
});

test('ascending named extension below worktree-* succeeds in a different cwd', async t => {
  const f = setup(t), a = f.name('a', 'a'), b = f.name('b', 'a');
  const script = 'const cp=require("node:child_process");const r=cp.spawnSync(process.execPath,JSON.parse(process.argv[1]),{cwd:process.argv[2],stdio:"inherit"});process.exit(r.status??1)';
  const nested = [cli, 'run', '--name', a, '--name', b, '--timeout', '0', '--', process.execPath, '-e', 'process.exit(0)'];
  const r = await f.start(f.a, [a], [process.execPath, '-e', script, JSON.stringify(nested), f.b]).done;
  assert.equal(r.code, 0, r.stderr);
});

test('one timeout budget covers waiting for the tree and a held second lock', async t => {
  const f = setup(t), n = f.name('deadline');
  const first = await f.hold(f.a), second = await f.hold(f.b, [n]);
  const began = Date.now(), pending = f.start(f.a, [n], undefined, '3');
  await delay(750); await first.finish();
  // Acquiring the tree after its initial poll consumes roughly two seconds of the budget.
  await until(() => readLock(f.file(lockNameFor(f.a)))?.pid === pending.child.pid, 'pending wrapper did not acquire the tree');
  const r = await pending.done;
  assert.equal(r.code, 75, r.stderr); assert.match(r.stderr, new RegExp(n));
  assert.ok(Date.now() - began < 5000, 'a second lock must not receive a fresh three-second timeout');
  assert.equal(existsSync(f.file(lockNameFor(f.a))), false);
  await second.finish();
});

test('case-insensitive duplicate names preserve the first original spelling', async t => {
  const f = setup(t), n = f.name('X-DB');
  const r = await f.start(f.a, [n, n.replace('DB', 'db')], [process.execPath, '-e', 'console.log(process.env.TRIO_RUN_LOCKS_HELD)']).done;
  assert.equal(r.code, 0, r.stderr);
  const claims = JSON.parse(r.stdout);
  assert.deepEqual(claims.map(([name]) => name).sort(), [lockNameFor(f.a), n].sort());
});

test('sibling children under one wrapper share the inherited lock', async t => {
  const f = setup(t), n = f.name('siblings');
  const script = `const cp=require('node:child_process');const args=JSON.parse(process.argv[1]);
    Promise.all([1,2].map(()=>new Promise(resolve=>{const c=cp.spawn(process.execPath,args,{stdio:'inherit'});c.on('close',resolve)})))
    .then(codes=>process.exit(codes.every(c=>c===0)?0:1))`;
  const probe = 'const fs=require("node:fs");const h=JSON.parse(fs.readFileSync(process.argv[1]));const claims=JSON.parse(process.env.TRIO_RUN_LOCKS_HELD);if(!claims.some(([n,nonce])=>n===process.argv[2]&&nonce===h.nonce))process.exit(8)';
  const nested = [cli, 'run', '--name', n, '--timeout', '0', '--', process.execPath, '-e', probe, f.file(n), n];
  const r = await f.start(f.a, [n], [process.execPath, '-e', script, JSON.stringify(nested)]).done;
  assert.equal(r.code, 0, r.stderr);
});

test('header documents sibling sharing, total timeout and residual cross-tree waiting', () => {
  const header = readFileSync(cli, 'utf8').split("import ")[0];
  assert.match(header, /sibling children/i);
  assert.match(header, /total.*timeout|timeout.*total/i);
  assert.match(header, /cross-tree.*(?:wait|timeout)/i);
  assert.match(header, /explicitly named|explicit named/i);
});

test('package explicitly runs and syntax-checks the run-lock suite', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  for (const key of ['test', 'test:quick']) assert.ok(scripts[key].split(/\s+/).includes('skills/trioharness-lean/scripts/run-lock.test.mjs'), key);
  assert.ok(scripts.check.includes('node --check skills/trioharness-lean/scripts/run-lock.test.mjs'));
});


test('publication interleaving: tree child protects unpublished secondary until the group is dead', t => {
  const f = setup(t), tree = lockNameFor(f.a), n = f.name('publication');
  const group = [tree, n], wrapperPid = 101, childPid = 202;
  const live = new Set([wrapperPid, childPid]);
  const opts = { dir: f.dir, pid: wrapperPid, group, isAlive: pid => live.has(pid) };
  const first = tryAcquire(tree, opts);
  const second = tryAcquire(n, { ...opts, nonce: first.nonce });
  // Deterministic SIGKILL point: only the tree's publication has happened.
  recordChild(first.file, childPid, wrapperPid);
  live.delete(wrapperPid);
  assert.equal(readLock(second.file).childPid, undefined);
  assert.equal(tryAcquire(n, { ...opts, pid: 303 }).acquired, false,
    'the tree child must protect a secondary still carrying only the dead wrapper');
  assert.deepEqual(readLock(second.file).group, group);
  assert.equal(readLock(second.file).nonce, first.nonce);
  live.clear();
  assert.equal(tryAcquire(n, { ...opts, pid: 303 }).acquired, true, 'fully dead group is reclaimable');
});

test('a replaced group member with a different nonce cannot keep an old lock alive', t => {
  const f = setup(t), tree = lockNameFor(f.a), n = f.name('replaced-group');
  const group = [tree, n], opts = { dir: f.dir, pid: 101, group, isAlive: pid => pid === 202 };
  const first = tryAcquire(tree, opts);
  tryAcquire(n, { ...opts, nonce: first.nonce });
  writeFileSync(first.file, JSON.stringify({ ...readLock(first.file), nonce: 'f'.repeat(64), childPid: 202 }));
  assert.equal(tryAcquire(n, { ...opts, pid: 303 }).acquired, true);
});

test('atomic child update: an interleaved reader and nested wrapper see the complete old record', t => {
  const f = setup(t), n = f.name('atomic-update');
  const got = tryAcquire(n);
  const old = readFileSync(got.file, 'utf8');
  let observed = false;
  recordChild(got.file, process.pid, process.pid, { beforeRename: () => {
    observed = true;
    assert.equal(readFileSync(got.file, 'utf8'), old);
    assert.ok(readLock(got.file)?.nonce, 'no partial or empty record is visible');
    const r = spawnSync(process.execPath, [cli, 'run', '--name', n, '--timeout', '0', '--', process.execPath, '-e', 'process.exit(0)'], {
      cwd: f.a, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, TRIO_RUN_LOCKS_HELD: JSON.stringify([[n, got.nonce]]) }
    });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
  } });
  assert.equal(observed, true, 'exercise the interval between writing the temp file and renaming it');
  assert.equal(readLock(got.file).childPid, process.pid);
});

test('an undecidable inherited claim is re-read once before acquisition can self-wait', async t => {
  const f = setup(t), n = f.name('retry-claim');
  const got = tryAcquire(n);
  assert.equal(typeof runLock.claimHolder, 'function');
  let reads = 0, retries = 0;
  const holder = await runLock.claimHolder(n, got.nonce, {
    read: file => ++reads === 1 ? null : readLock(file),
    sleep: async () => { retries++; }
  });
  assert.equal(holder?.pid, process.pid, 'preserve the inherited claim of the live ancestor');
  assert.equal(reads, 2); assert.equal(retries, 1);
  reads = 0; retries = 0;
  assert.equal(await runLock.claimHolder(n, got.nonce, {
    read: () => { reads++; return null; }, sleep: async () => { retries++; }
  }), null);
  assert.equal(reads, 2); assert.equal(retries, 1, 'retry must be bounded');
});

test('CLI records the complete acquisition group with the tree first', async t => {
  const f = setup(t), n = f.name('group-record');
  const probe = `const fs=require('node:fs');console.log(JSON.stringify(JSON.parse(process.env.TRIO_RUN_LOCKS_HELD).map(([n])=>JSON.parse(fs.readFileSync(process.argv[1]+'/'+n+'.lock')))))`;
  const r = await f.start(f.a, [n], [process.execPath, '-e', probe, LOCK_DIR]).done;
  assert.equal(r.code, 0, r.stderr);
  const records = JSON.parse(r.stdout);
  for (const holder of records) assert.deepEqual(holder.group, [lockNameFor(f.a), n]);
  assert.equal(records[0].nonce, records[1].nonce);
});

test('status omits the ownership nonce', async t => {
  const f = setup(t), n = f.name('status-private');
  const holder = await f.hold(f.a, [n]);
  const nonce = readLock(f.file(n)).nonce;
  const r = spawnSync(process.execPath, [cli, 'status', '--name', n], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);
  assert.equal(status.holder.pid, holder.child.pid);
  assert.equal('nonce' in status.holder, false);
  assert.equal(r.stdout.includes(nonce), false);
  await holder.finish();
});

test('header documents the initial publication window and detached inherited work limitation', () => {
  const header = readFileSync(cli, 'utf8').split('import ')[0];
  assert.match(header, /before.*tree.*publish|before.*publish.*tree/i);
  assert.match(header, /single-lock/i);
  assert.match(header, /detached.*unlocked/i);
  assert.match(header, /validated only at acquisition/i);
});


test('a live legacy uppercase holder is respected by the same original name', async t => {
  const f = setup(t), n = f.name('DB');
  const legacy = { pid: process.pid, host: hostname(), at: 'legacy', note: 'old CLI' };
  writeFileSync(f.file(n), JSON.stringify(legacy));
  const r = await f.start(f.a, [n], undefined, '0.1').done;
  assert.equal(r.code, 75, r.stderr);
  assert.deepEqual(readLock(f.file(n)), legacy);
  assert.equal(existsSync(f.file(lockNameFor(f.a))), false);
  const status = spawnSync(process.execPath, [cli, 'status', '--name', n], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), { name: n, holder: legacy });
});

test('nested mixed-case claims retain original filenames without self-blocking', async t => {
  const f = setup(t), n = f.name('X-DB');
  const nested = [process.execPath, cli, 'run', '--name', n.toLowerCase(), '--timeout', '0', '--', process.execPath, '-e', 'console.log(process.env.TRIO_RUN_LOCKS_HELD)'];
  const r = await f.start(f.a, [n, n.toLowerCase()], nested).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map(([name]) => name).sort(), [lockNameFor(f.a), n].sort());
});

test('atomic child publication retries transient permission and busy rename failures', t => {
  const f = setup(t);
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const got = tryAcquire(f.name(code));
    let attempts = 0; const backoffs = [], errors = [];
    recordChild(got.file, 202, process.pid, {
      rename: (...args) => {
        if (++attempts === 1) throw Object.assign(new Error('injected rename failure'), { code });
        renameSync(...args);
      },
      sleep: ms => backoffs.push(ms), onError: e => errors.push(e)
    });
    assert.equal(attempts, 2, code);
    assert.equal(backoffs.length, 1); assert.ok(backoffs[0] > 0 && backoffs[0] <= 100);
    assert.equal(readLock(got.file).childPid, 202);
    assert.deepEqual(errors, []);
    assert.equal(readdirSync(LOCK_DIR).some(n => n.startsWith(`.run-lock-${process.pid}-`)), false);
  }
});

test('persistent rename failures are bounded, non-fatal and remove temporary files', t => {
  const f = setup(t), got = tryAcquire(f.name('rename-failure'));
  let attempts = 0; const errors = [], backoffs = [];
  recordChild(got.file, 202, process.pid, {
    rename: () => { attempts++; throw Object.assign(new Error('injected rename failure'), { code: 'EPERM' }); },
    sleep: ms => backoffs.push(ms), onError: e => errors.push(e)
  });
  assert.ok(attempts >= 2 && attempts <= 5, 'retry count must be bounded');
  assert.equal(backoffs.length, attempts - 1);
  assert.equal(errors.length, 1); assert.equal(errors[0].code, 'EPERM');
  assert.equal(readLock(got.file).pid, process.pid);
  assert.equal(readLock(got.file).childPid, undefined);
  assert.equal(readdirSync(LOCK_DIR).some(n => n.startsWith(`.run-lock-${process.pid}-`)), false);
});

test('CLI completes child publication after a transient injected rename failure', async t => {
  const f = setup(t), n = f.name('transient-cli');
  const holder = await f.hold(f.a, [n], 1);
  await until(() => readLock(f.file(n))?.childPid, 'publication did not recover');
  assert.equal(readLock(f.file(lockNameFor(f.a))).childPid, Number(readFileSync(holder.ready, 'utf8')));
  assert.equal(holder.output().stderr, '');
  await holder.finish();
  for (const name of [lockNameFor(f.a), n]) assert.equal(existsSync(f.file(name)), false);
});

test('CLI keeps every lock until child exit when rename persistently fails', async t => {
  const f = setup(t), x = f.name('rename-a'), y = f.name('rename-z');
  const holder = await f.hold(f.a, [x, y], 10000);
  await until(() => holder.child.exitCode !== null || holder.output().stderr.includes('RUN-LOCK:'), 'publication failure was not reported');
  assert.equal(holder.child.exitCode, null, holder.output().stderr);
  for (const name of [lockNameFor(f.a), x, y]) {
    const status = spawnSync(process.execPath, [cli, 'status', '--name', name], { encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).holder?.pid, holder.child.pid, name);
    assert.equal(readLock(f.file(name)).childPid, undefined);
  }
  const blocked = await f.start(f.b, [y]).done;
  assert.equal(blocked.code, 75, blocked.stderr);
  assert.equal(readdirSync(LOCK_DIR).some(n => n.startsWith(`.run-lock-${holder.child.pid}-`)), false);
  await holder.finish();
  const result = await holder.done;
  assert.equal((result.stderr.match(/RUN-LOCK:/g) || []).length, 1, result.stderr);
  assert.match(result.stderr, /publication.*EPERM/i);
  for (const name of [lockNameFor(f.a), x, y]) assert.equal(existsSync(f.file(name)), false);
});

test('an onChild publication exception cannot end a running command early', async () => {
  const status = await runLock.runCommandAsync([process.execPath, '-e', 'process.exit(7)'], {
    signals: false, onChild: () => { throw new Error('injected publication callback failure'); }
  });
  assert.equal(status, 7);
});
