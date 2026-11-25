import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registrationsForTree, saveBoundary } from './boundary.mjs';

const root = join(import.meta.dirname, '../../../.trioharness-direct/runs/boundary-a/tmp');
mkdirSync(root, { recursive: true });
const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
function fixture(t) {
  const dir = mkdtempSync(join(root, 'boundary-')), main = join(dir, 'main'), remote = join(dir, 'remote.git'), tree = join(dir, 'task');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(main); git(main, 'init', '-b', 'main'); git(main, 'config', 'user.name', 'Boundary Test'); git(main, 'config', 'user.email', 'boundary@test.local');
  writeFileSync(join(main, 'tracked.txt'), 'base\n'); git(main, 'add', '.'); git(main, 'commit', '-m', 'base');
  git(main, 'init', '--bare', remote); git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'); git(main, 'remote', 'add', 'origin', remote); git(main, 'push', 'origin', 'main');
  writeFileSync(join(main, '.git/info/exclude'), '.trioharness-direct/\n');
  git(main, 'worktree', 'add', '-b', 'trio/test', tree); git(tree, 'push', 'origin', 'trio/test');
  const file = join(main, '.trioharness-direct/runs/r1/state.json'); mkdirSync(dirname(file), { recursive: true });
  const state = { repo: main, run: 'r1', gates: {}, history: [], scope: { outcome: 'preserve task bytes', nonGoals: [], files: ['src/', 'new.txt'] }, worktrees: [{ path: tree, branch: 'trio/test', role: 'writer' }] };
  const put = () => writeFileSync(file, JSON.stringify(state)); put();
  const save = (options = {}) => { const result = saveBoundary({ repo: main, run: 'r1', ...options }); result.release(); return result.output; };
  return { dir, main, remote, tree, state, file, put, save };
}
test('version and usage are stable', () => {
  const script = join(import.meta.dirname, 'boundary.mjs');
  let r = spawnSync(process.execPath, [script, '--version'], { encoding: 'utf8' }); assert.equal(r.status, 0); assert.equal(r.stdout, 'boundary-cli 1\n');
  r = spawnSync(process.execPath, [script, 'save', '--path', '.', '--run', 'r1', '--json'], { encoding: 'utf8' }); assert.equal(r.status, 3);
});
test('dirty tracked and scoped untracked bytes become one task commit and push; retry clean', t => {
  const f = fixture(t); writeFileSync(join(f.tree, 'tracked.txt'), 'changed\n'); writeFileSync(join(f.tree, 'new.txt'), 'new\n');
  const out = f.save(); assert.equal(out.ok, true); assert.equal(out.checkouts[0].action, 'committed+pushed');
  assert.equal(git(f.tree, 'status', '--porcelain'), ''); assert.equal(git(f.tree, 'log', '-1', '--format=%s').startsWith('wip(boundary): r1 '), true);
  assert.equal(git(f.remote, 'rev-parse', 'trio/test'), git(f.tree, 'rev-parse', 'HEAD')); assert.equal(f.save().checkouts[0].action, 'clean');
});
test('strays move locally with bytes and relative paths; dry run writes nothing', t => {
  const f = fixture(t); mkdirSync(join(f.tree, 'scratch')); writeFileSync(join(f.tree, 'scratch/probe'), 'local bytes');
  const dry = f.save({ dryRun: true }); assert.equal(dry.ok, false); assert.equal(dry.checkouts[0].action, 'would-save'); assert.equal(existsSync(dry.checkouts[0].parked[0].to), false);
  const out = f.save(); assert.equal(out.ok, true); assert.equal(out.checkouts[0].action, 'parked'); assert.equal(readFileSync(out.checkouts[0].parked[0].to, 'utf8'), 'local bytes'); assert.equal(existsSync(join(f.tree, 'scratch/probe')), false);
});
test('new task branch, ahead only, and dirty plus ahead save without default update', t => {
  const f = fixture(t), baseline = git(f.remote, 'rev-parse', 'main');
  git(f.remote, 'update-ref', '-d', 'refs/heads/trio/test'); assert.equal(f.save({ dryRun: true }).checkouts[0].ahead, null); assert.equal(f.save().checkouts[0].action, 'pushed');
  writeFileSync(join(f.tree, 'tracked.txt'), 'ahead'); git(f.tree, 'commit', '-am', 'ahead'); assert.equal(f.save().checkouts[0].action, 'pushed');
  writeFileSync(join(f.tree, 'tracked.txt'), 'ahead two'); git(f.tree, 'commit', '-am', 'ahead two'); writeFileSync(join(f.tree, 'tracked.txt'), 'dirty'); assert.equal(f.save().checkouts[0].action, 'committed+pushed'); assert.equal(git(f.remote, 'rev-parse', 'main'), baseline);
});
for (const [name, setup, reason] of [
  ['hold', f => { f.state.closeout = { note: 'owner-hold: retain' }; f.put(); }, 'NOT_OWNED owner-hold'],
  ['read only', f => { f.state.worktrees[0].role = 'reviewer'; f.put(); }, 'NOT_OWNED'],
  ['unowned', f => { f.state.worktrees = []; f.put(); }, 'NOT_OWNED'],
  ['detached', f => git(f.tree, 'checkout', '--detach'), 'DETACHED'],
  ['task shaped default', f => git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/trio/test'), 'DEFAULT_BRANCH'],
  ['split endpoint', f => git(f.tree, 'config', 'remote.origin.pushurl', f.main), 'REMOTE_AMBIGUOUS'],
  ['operation', f => writeFileSync(git(f.tree, 'rev-parse', '--git-path', 'MERGE_HEAD'), git(f.tree, 'rev-parse', 'HEAD')), 'OPERATION_IN_PROGRESS'],
  ['missing', f => rmSync(f.tree, { recursive: true }), 'MISSING']
]) test(`refuses ${name}`, t => { const f = fixture(t); setup(f); const out = name === 'unowned' ? saveBoundary({ path: f.tree }) : null; const result = out ? (out.release(), out.output) : f.save(); assert.equal(result.ok, false); assert.equal(result.checkouts[0].reason, reason); });
test('secret in clean unpublished history refuses without a hook', t => {
  const f = fixture(t); writeFileSync(join(f.tree, 'tracked.txt'), 'gh' + 'p_' + 'A'.repeat(36)); git(f.tree, 'commit', '-am', 'unpublished');
  assert.equal(f.save().checkouts[0].reason, 'SECRET_OR_DATA');
});

// All hooks, remotes and adverse operations below belong to this fixture only.
import { chmodSync, renameSync, symlinkSync } from 'node:fs';
import { parkRun, countLoop, LOOP_CAPS, updateDiscipline, handoverTaken, setGate, registerWorktree, registerWorker, countDispatch } from './run-state.mjs';
import { lockNameFor, tryAcquire, release as unlock } from './run-lock.mjs';
function hook(f, name, body) {
  const file = join(f.main, '.git/hooks', name), program = join(f.dir, `${name}.mjs`);
  writeFileSync(program, body); writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${program}'\n`); chmodSync(file, 0o755);
}
function command(args, cwd) { return spawnSync(process.execPath, [join(import.meta.dirname, 'run-state.mjs'), ...args], { cwd, encoding: 'utf8', timeout: 115000 }); }
const handoffRecord = f => ({ id: 'h1', itemId: 'I1', kind: 'same-repo', source: { repo: f.main, run: 'r1', task: 'old' }, target: { repo: f.main, run: 'r1', task: 'next' }, state: 'sent' });
test('primary, non-task, shared, unreadable registrations and held tree admission refuse', t => {
  const f = fixture(t);
  let result = saveBoundary({ path: f.main }); result.release(); assert.equal(result.output.checkouts[0].reason, 'NOT_LINKED_WORKTREE');
  git(f.tree, 'checkout', '-b', 'feature'); assert.equal(f.save().checkouts[0].reason, 'NOT_TASK_BRANCH'); git(f.tree, 'checkout', 'trio/test');
  const other = join(f.main, '.trioharness-direct/runs/r2/state.json'); mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, JSON.stringify({ run: 'r2', worktrees: [{ path: f.tree }] })); assert.equal(f.save().checkouts[0].reason, 'NOT_OWNED');
  writeFileSync(other, '{'); assert.equal(f.save().checkouts[0].action, 'unknown'); rmSync(dirname(other), { recursive: true });
  const lock = tryAcquire(lockNameFor(f.tree)); assert.equal(lock.acquired, true);
  try { assert.equal(f.save().checkouts[0].reason, 'STATE_CHANGED'); assert.throws(() => registerWorktree(f.main, 'r2', { path: f.tree }), /STATE_CHANGED/); } finally { unlock(lock.file); }
});
test('path save refuses ownership from the target checkout ledger alone', t => {
  const f = fixture(t), local = join(f.tree, '.trioharness-direct/runs/r1/state.json');
  mkdirSync(dirname(local), { recursive: true });
  renameSync(f.file, local);
  const head = git(f.tree, 'rev-parse', 'HEAD');
  writeFileSync(join(f.tree, 'tracked.txt'), 'keep local\n');
  const result = boundaryCli(f, ['--path', f.tree]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).checkouts[0].reason, 'NOT_OWNED');
  assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'keep local\n');
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.remote, 'rev-parse', 'trio/test'), head);
});

for (const finished of [false, true]) test(`path save refuses duplicate owner ledgers (main finished=${finished})`, t => {
  const f = fixture(t), local = join(f.tree, '.trioharness-direct/runs/r1/state.json');
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, JSON.stringify({ ...f.state, finished: false }));
  f.state.finished = finished;
  f.put();
  const head = git(f.tree, 'rev-parse', 'HEAD');
  writeFileSync(join(f.tree, 'tracked.txt'), 'keep local\n');
  const result = boundaryCli(f, ['--path', f.tree]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).checkouts[0].reason, 'WORKTREE_REGISTRATION_AMBIGUOUS');
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.remote, 'rev-parse', 'trio/test'), head);
  assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'keep local\n');
});

for (const appOwned of [false, true]) test(`path save reports target-ledger owner hold (attested=${appOwned})`, t => {
  const f = fixture(t), local = join(f.tree, '.trioharness-direct/runs/r1/state.json');
  f.state.closeout = { note: 'owner-hold: retain' };
  f.put();
  mkdirSync(dirname(local), { recursive: true });
  renameSync(f.file, local);
  const args = ['--path', f.tree];
  if (appOwned) args.push('--app-owned', attestation);
  const result = boundaryCli(f, args);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).checkouts[0].reason, 'NOT_OWNED owner-hold');
});

for (const layout of ['legacy', 'symlinked state']) test(`run save refuses a canonical live job with ${layout}`, t => {
  const f = fixture(t);
  const moved = layout === 'legacy'
    ? join(f.main, 'trioharness-direct-runs/r1/state.json')
    : join(f.dir, 'relocated/state.json');
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(f.file, moved);
  if (layout === 'symlinked state') symlinkSync(moved, f.file, 'file');
  const jobs = join(dirname(f.file), 'jobs');
  mkdirSync(jobs);
  writeFileSync(join(jobs, 'live.json'), JSON.stringify({ status: 'running' }));
  const head = git(f.tree, 'rev-parse', 'HEAD');
  writeFileSync(join(f.tree, 'tracked.txt'), 'keep local\n');
  assert.equal(f.save().checkouts[0].reason, 'NOT_OWNED');
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.remote, 'rev-parse', 'trio/test'), head);
  assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'keep local\n');
});

test('aliased run IDs refuse preservation and registration', t => {
  const f = fixture(t);
  symlinkSync('r1', join(dirname(dirname(f.file)), 'r2'));
  assert.equal(f.save().checkouts[0].reason, 'WORKTREE_REGISTRATION_AMBIGUOUS');
  assert.throws(() => registerWorktree(f.main, 'r1', { path: f.tree }), /WORKTREE_REGISTRATION_AMBIGUOUS/);
});

test('case-only state paths dedupe the same registration', t => {
  if (!['darwin', 'win32'].includes(process.platform)) return t.skip('platform does not fold paths');
  const dir = mkdtempSync(join(root, 'boundary-case-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, 'Main'), ledger = join(dir, 'ledger'), target = join(dir, 'task');
  const statePath = '.trioharness-direct/runs/r1/state.json';
  const file = join(main, statePath), alternate = join(dir, 'main', statePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ worktrees: [{ path: target }] }));
  if (!existsSync(alternate)) return t.skip('fixture volume is case-sensitive');
  const alias = join(ledger, statePath);
  mkdirSync(dirname(alias), { recursive: true });
  symlinkSync(alternate, alias, 'file');
  assert.equal(registrationsForTree(main, target, ledger).length, 1);
});

function baseDriftFixture(t, branch = 'bambooed/repro', registeredBranch = branch) {
  const f = fixture(t);
  f.state.worktrees = [];
  f.put();
  git(f.tree, 'switch', '-c', branch);
  git(f.tree, 'push', 'origin', branch);
  const owner = ['--repo', f.tree, '--run', 'owner'];
  const register = () => command(['worktree', ...owner, '--path', f.tree, '--branch', registeredBranch], f.tree);
  const added = register();
  assert.equal(added.status, 0, added.stderr);
  const loop = () => command(['loop', ...owner, '--kind', 'base-drift'], f.tree);
  const start = () => {
    const result = loop();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '1');
  };
  const file = join(f.tree, '.trioharness-direct/runs/owner/state.json');
  return { ...f, branch, owner, register, loop, start, ownerFile: file, ownerState: () => readFileSync(file, 'utf8') };
}

test('capped in-tree base drift parks through a symlinked checkout ledger', t => {
  const f = baseDriftFixture(t);
  rmSync(f.file);
  renameSync(join(f.tree, '.trioharness-direct/runs/owner'), join(f.main, '.trioharness-direct/runs/owner'));
  rmSync(join(f.tree, '.trioharness-direct'), { recursive: true });
  symlinkSync(join(f.main, '.trioharness-direct'), join(f.tree, '.trioharness-direct'));
  f.start();
  const capped = f.loop();
  assert.equal(capped.status, 2, capped.stderr);
  assert.equal(JSON.parse(f.ownerState()).status, 'parked:LOOP_CAP:base-drift');
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), git(f.remote, 'rev-parse', f.branch));
});

test('capped in-tree fix batch refuses without parking', t => {
  const f = baseDriftFixture(t);
  const loop = () => command(['loop', ...f.owner, '--kind', 'fix-batch'], f.tree);
  for (let i = 1; i < LOOP_CAPS['fix-batch']; i++) {
    const result = loop();
    assert.equal(result.status, 0, result.stderr);
  }
  const before = f.ownerState(), capped = loop();
  assert.equal(capped.status, 3, capped.stderr);
  assert.match(capped.stderr, /BOUNDARY_REFUSED.*CALLER_IN_WORKTREE/);
  assert.equal(f.ownerState(), before);
});

test('in-tree park refusal leaves the earlier dirty worktree untouched', t => {
  const f = fixture(t), caller = join(f.dir, 'caller');
  git(f.main, 'worktree', 'add', '-b', 'trio/caller', caller);
  git(caller, 'push', 'origin', 'trio/caller');
  registerWorktree(f.main, 'r1', { path: caller, branch: 'trio/caller' });
  const before = readFileSync(f.file, 'utf8'), head = git(f.tree, 'rev-parse', 'HEAD');
  writeFileSync(join(f.tree, 'tracked.txt'), 'dirty sibling\n');
  const result = command(['park', '--repo', f.main, '--run', 'r1', '--reason', 'test'], caller);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /BOUNDARY_REFUSED.*CALLER_IN_WORKTREE/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'dirty sibling\n');
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.remote, 'rev-parse', 'trio/test'), head);
});

test('in-tree validation checks local changes without contacting the remote', t => {
  const f = fixture(t), previous = process.cwd();
  process.chdir(f.tree);
  try {
    const saved = saveBoundary({ repo: f.main, run: 'r1', allowCleanInTree: true });
    try {
      assert.equal(saved.output.ok, true, JSON.stringify(saved.output));
      renameSync(f.remote, join(f.dir, 'offline.git'));
      assert.doesNotThrow(() => saved.validate());
      writeFileSync(join(f.tree, 'tracked.txt'), 'changed after proof\n');
      assert.throws(() => saved.validate(), /STATE_CHANGED/);
    } finally { saved.release(); }
  } finally { process.chdir(previous); }
});

test('caller proof checks nested registered worktrees before saving a sibling', t => {
  const f = fixture(t), outer = join(f.dir, 'outer'), inner = join(outer, 'nested');
  writeFileSync(join(f.main, '.git/info/exclude'), '.trioharness-direct/\nnested/\n');
  git(f.main, 'worktree', 'add', '-b', 'trio/outer', outer);
  git(f.main, 'worktree', 'add', '-b', 'trio/inner', inner);
  git(outer, 'push', 'origin', 'trio/outer');
  git(inner, 'push', 'origin', 'trio/inner');
  registerWorktree(f.main, 'r1', { path: outer, branch: 'trio/outer' });
  registerWorktree(f.main, 'r1', { path: inner, branch: 'trio/inner' });
  const head = git(f.tree, 'rev-parse', 'HEAD'), previous = process.cwd();
  writeFileSync(join(f.tree, 'tracked.txt'), 'dirty sibling\n');
  writeFileSync(join(inner, 'tracked.txt'), 'dirty inner\n');
  assert.equal(git(outer, 'status', '--porcelain'), '');
  process.chdir(inner);
  try {
    const out = f.save({ allowCleanInTree: true });
    assert.equal(out.ok, false);
    assert.equal(out.checkouts.length, 1);
    assert.equal(out.checkouts[0].reason, 'CALLER_IN_WORKTREE');
    assert.equal(out.checkouts[0].branch, 'trio/inner');
  } finally { process.chdir(previous); }
  assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'dirty sibling\n');
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.remote, 'rev-parse', 'trio/test'), head);
});

for (const branch of ['bambooed/repro', 'codeden/base-drift']) {
  test(`capped in-tree base drift parks a clean pushed ${branch} branch`, t => {
    const f = baseDriftFixture(t, branch);
    f.start();
    const capped = f.loop();
    assert.equal(capped.status, 2, capped.stderr);
    assert.match(capped.stderr, /LOOP_CAP:base-drift/);
    assert.equal(JSON.parse(f.ownerState()).status, 'parked:LOOP_CAP:base-drift');
    assert.equal(existsSync(f.tree), true);
    assert.equal(git(f.tree, 'rev-parse', 'HEAD'), git(f.remote, 'rev-parse', branch));
    assert.equal(git(f.tree, 'status', '--porcelain'), '');
  });
}

for (const [name, branch, recorded, reason] of [
  ['mismatched CodeDen registration', 'codeden/base-drift', 'codeden/other', /NOT_TASK_BRANCH/],
  ['owner hold', 'bambooed/repro', 'bambooed/repro', /BOUNDARY_REFUSED: NOT_OWNED owner-hold/],
  ['reviewer registration', 'bambooed/repro', 'bambooed/repro', /"reason":"NOT_OWNED"/],
  ['readOnly registration', 'bambooed/repro', 'bambooed/repro', /"reason":"NOT_OWNED"/],
  ['live job', 'bambooed/repro', 'bambooed/repro', /"reason":"NOT_OWNED"/],
  ['modified tracked file', 'bambooed/repro', 'bambooed/repro', /CALLER_IN_WORKTREE/],
  ['untracked file', 'bambooed/repro', 'bambooed/repro', /CALLER_IN_WORKTREE/],
  ['unpushed commit', 'bambooed/repro', 'bambooed/repro', /CALLER_IN_WORKTREE/],
  ['HEAD behind the remote tip', 'bambooed/repro', 'bambooed/repro', /CALLER_IN_WORKTREE/],
  ['duplicate owner ledgers', 'bambooed/repro', 'bambooed/repro', /WORKTREE_REGISTRATION_AMBIGUOUS/],
]) {
  test(`capped in-tree base drift refuses ${name}`, t => {
    const f = baseDriftFixture(t, branch, recorded);
    f.start();
    if (name === 'owner hold') {
      const result = command(['set', ...f.owner, '--gate', 'closeout', '--status', 'blocked', '--note', 'owner-hold: retain'], f.tree);
      assert.equal(result.status, 0, result.stderr);
    }
    if (name === 'reviewer registration' || name === 'readOnly registration') {
      const state = JSON.parse(f.ownerState());
      if (name === 'reviewer registration') state.worktrees[0].role = 'reviewer';
      else state.worktrees[0].readOnly = true;
      writeFileSync(f.ownerFile, JSON.stringify(state));
    }
    if (name === 'live job') {
      const jobs = join(dirname(f.ownerFile), 'jobs');
      mkdirSync(jobs);
      writeFileSync(join(jobs, 'live.json'), JSON.stringify({ status: 'queued' }));
    }
    if (name === 'duplicate owner ledgers') {
      const duplicate = join(dirname(dirname(f.file)), 'owner', 'state.json');
      mkdirSync(dirname(duplicate), { recursive: true });
      writeFileSync(duplicate, f.ownerState());
    }
    const dirty = name === 'modified tracked file' ? 'tracked.txt' : name === 'untracked file' ? 'new.txt' : null;
    if (dirty) writeFileSync(join(f.tree, dirty), 'local bytes');
    if (name === 'unpushed commit') git(f.tree, 'commit', '--allow-empty', '-m', 'local only');
    if (name === 'HEAD behind the remote tip') {
      git(f.tree, 'commit', '--allow-empty', '-m', 'remote only');
      git(f.tree, 'push', 'origin', branch);
      git(f.tree, 'reset', '--hard', 'HEAD^');
    }
    const head = git(f.tree, 'rev-parse', 'HEAD');
    const tip = git(f.remote, 'rev-parse', branch);
    if (name === 'unpushed commit') assert.notEqual(head, tip);
    if (name === 'HEAD behind the remote tip') assert.equal(git(f.tree, 'rev-parse', `${tip}^`), head);
    const before = f.ownerState();
    const status = git(f.tree, 'status', '--porcelain');
    const tracked = readFileSync(join(f.tree, 'tracked.txt'));
    const capped = f.loop();
    assert.equal(capped.status, 3, capped.stderr);
    assert.match(capped.stderr, /BOUNDARY_REFUSED/);
    assert.match(capped.stderr, reason);
    assert.equal(f.ownerState(), before);
    assert.equal(existsSync(f.tree), true);
    assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head);
    assert.equal(git(f.remote, 'rev-parse', branch), tip);
    assert.equal(git(f.tree, 'status', '--porcelain'), status);
    assert.deepEqual(readFileSync(join(f.tree, 'tracked.txt')), tracked);
    if (dirty) assert.equal(readFileSync(join(f.tree, dirty), 'utf8'), 'local bytes');
  });
}

for (const checkout of ['tree', 'main']) {
  test(`worktree registration through the ${checkout} ledger refuses a second owner`, t => {
    const f = baseDriftFixture(t);
    const refused = command(['worktree', '--repo', f[checkout], '--run', 'other', '--path', f.tree], f[checkout]);
    assert.equal(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, /WORKTREE_ALREADY_REGISTERED.*owner/);
    const repeated = f.register();
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(f.ownerState()).worktrees.length, 1);
  });
}

for (const finished of [false, true]) test(`worktree registration refuses the same run in a second ledger (finished=${finished})`, t => {
  const f = fixture(t);
  f.state.finished = finished;
  f.put();
  const file = join(f.tree, '.trioharness-direct/runs/r1/state.json');
  assert.throws(() => registerWorktree(f.tree, 'r1', { path: f.tree }), /WORKTREE_REGISTRATION_AMBIGUOUS/);
  assert.equal(existsSync(file), false);
});

test('worktree registration finds the main ledger for an absent path', t => {
  const f = fixture(t), missing = join(f.dir, 'missing');
  f.state.worktrees.push({ path: missing });
  f.put();
  assert.throws(() => registerWorktree(f.tree, 'other', { path: missing }), /WORKTREE_ALREADY_REGISTERED.*r1/);
});

test('boundary dry run from main reports the parked tree ledger owner clean', t => {
  const f = baseDriftFixture(t);
  f.start();
  assert.equal(f.loop().status, 2);
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'boundary.mjs'),
    'save', ...f.owner, '--dry-run', '--json'], { cwd: f.main, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.checkouts[0].action, 'clean');
});

test('path mode matches canonical registration and component scope, stages tracked edits outside scope', t => {
  const f = fixture(t); mkdirSync(join(f.tree, 'src')); mkdirSync(join(f.tree, 'src-other'));
  writeFileSync(join(f.tree, 'src/a'), 'include'); writeFileSync(join(f.tree, 'src-other/b'), 'park'); writeFileSync(join(f.tree, 'new.txt.extra'), 'park exact mismatch'); writeFileSync(join(f.tree, 'tracked.txt'), 'include tracked');
  const alias = join(f.dir, 'alias'); symlinkSync(f.tree, alias);
  const saved = saveBoundary({ path: alias }); saved.release(); assert.equal(saved.output.ok, true);
  const row = saved.output.checkouts[0]; assert.equal(row.parked.length, 2); assert.equal(git(f.tree, 'show', 'HEAD:src/a'), 'include'); assert.equal(git(f.tree, 'show', 'HEAD:tracked.txt'), 'include tracked');
  assert.equal(git(f.tree, 'ls-tree', '-r', '--name-only', 'HEAD').includes('src-other'), false);
});
test('missing exclude and unsafe archive parent refuse before moving; partial moves survive retry', t => {
  const f = fixture(t); writeFileSync(join(f.tree, 'a-stray'), 'first'); writeFileSync(join(f.tree, 'b-stray'), 'second');
  writeFileSync(join(f.main, '.git/info/exclude'), ''); assert.equal(f.save().checkouts[0].reason, 'STRAY_UNSAFE'); assert.equal(existsSync(join(f.tree, 'a-stray')), true);
  writeFileSync(join(f.main, '.git/info/exclude'), '.trioharness-direct/\n');
  const stray = join(f.main, '.trioharness-direct/runs/r1/stray'); writeFileSync(stray, 'block directory');
  assert.equal(f.save().checkouts[0].reason, 'STRAY_UNSAFE'); assert.equal(readFileSync(join(f.tree, 'b-stray'), 'utf8'), 'second'); rmSync(stray);
  const out = f.save(); assert.equal(out.ok, true); const first = out.checkouts[0].parked[0];
  writeFileSync(join(f.tree, first.path), 'new bytes'); const retry = f.save(); assert.equal(retry.ok, true); assert.equal(readFileSync(first.to, 'utf8'), 'first'); assert.notEqual(retry.checkouts[0].parked[0].to, first.to);
});
test('stray symlinks preserve the link locally without pushing it', t => {
  const f = fixture(t); symlinkSync('tracked.txt', join(f.tree, 'local-link')); const out = f.save(); assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.checkouts[0].action, 'parked');
});
test('behind and diverged live tips refuse, even without the advertised object', t => {
  const f = fixture(t), other = join(f.dir, 'other'); git(f.main, 'clone', f.remote, other); git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@test.local'); git(other, 'checkout', 'trio/test');
  writeFileSync(join(other, 'tracked.txt'), 'remote'); git(other, 'commit', '-am', 'remote'); git(other, 'push', 'origin', 'trio/test');
  assert.equal(f.save({ dryRun: true }).checkouts[0].action, 'unknown'); assert.equal(f.save().checkouts[0].reason, 'DIVERGED');
  writeFileSync(join(f.tree, 'tracked.txt'), 'local'); git(f.tree, 'commit', '-am', 'local'); assert.equal(f.save().checkouts[0].reason, 'DIVERGED'); assert.equal(git(f.tree, 'show', 'HEAD:tracked.txt'), 'local');
});
test('unreachable remote, unknown default, timeout and unreadable run fail closed', t => {
  const f = fixture(t); git(f.tree, 'remote', 'set-url', 'origin', join(f.dir, 'missing'));
  assert.equal(f.save({ dryRun: true }).checkouts[0].action, 'unknown'); assert.equal(f.save().checkouts[0].reason, 'REMOTE_UNREACHABLE');
  git(f.tree, 'remote', 'set-url', 'origin', f.remote); git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/missing'); assert.equal(f.save().checkouts[0].reason, 'UNKNOWN');
  assert.equal(f.save({ deadline: Date.now() - 1 }).checkouts[0].reason, 'TIMEOUT'); writeFileSync(f.file, '{'); assert.equal(f.save().checkouts[0].action, 'unknown');
});
test('commit and push hooks remain enabled and a partial committed refusal retries once', t => {
  const f = fixture(t); writeFileSync(join(f.tree, 'tracked.txt'), 'change'); hook(f, 'pre-commit', 'process.exit(1);'); assert.equal(f.save().checkouts[0].reason, 'HOOK_REJECTED');
  rmSync(join(f.main, '.git/hooks/pre-commit')); hook(f, 'pre-push', 'process.exit(1);'); const out = f.save(); assert.equal(out.ok, false); assert.equal(out.checkouts[0].action, 'committed'); assert.equal(out.checkouts[0].reason, 'PUSH_REJECTED'); assert.equal(out.checkouts[0].ahead, 1);
  const head = git(f.tree, 'rev-parse', 'HEAD'); rmSync(join(f.main, '.git/hooks/pre-push')); assert.equal(f.save().checkouts[0].action, 'pushed'); assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head);
});
test('equal-count secret replacement and data filenames refuse; scanner failure is unknown', t => {
  const f = fixture(t); writeFileSync(join(f.tree, 'tracked.txt'), 'gh' + 'p_' + 'A'.repeat(36)); git(f.tree, 'commit', '-am', 'secret'); git(f.tree, 'push', 'origin', 'trio/test');
  writeFileSync(join(f.tree, 'tracked.txt'), 'gh' + 'p_' + 'B'.repeat(36)); assert.equal(f.save().checkouts[0].reason, 'SECRET_OR_DATA');
  writeFileSync(join(f.tree, 'tracked.txt'), 'safe'); f.state.scope.files.push('data.csv'); f.put(); writeFileSync(join(f.tree, 'data.csv'), 'rows'); assert.equal(f.save().checkouts[0].reason, 'SECRET_OR_DATA');
  rmSync(join(f.tree, 'data.csv')); // An unreadable object is a proof failure, never a clean result.
  const head = git(f.tree, 'rev-parse', 'HEAD'), object = join(f.main, '.git/objects', head.slice(0, 2), head.slice(2)); chmodSync(object, 0o600); writeFileSync(object, 'corrupt'); assert.equal(f.save().ok, false);
});
test('concurrent editing from a commit hook preserves new bytes and refuses before push', t => {
  const f = fixture(t), original = git(f.remote, 'rev-parse', 'trio/test'); writeFileSync(join(f.tree, 'tracked.txt'), 'candidate');
  hook(f, 'pre-commit', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(f.tree, 'tracked.txt'))}, 'concurrent bytes');`);
  const out = f.save(); assert.equal(out.ok, false); assert.equal(out.checkouts[0].reason, 'STATE_CHANGED'); assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'concurrent bytes'); assert.equal(git(f.remote, 'rev-parse', 'trio/test'), original);
});
test('save retains admission until publication validation, rejecting a late edit', t => {
  const f = fixture(t), saved = saveBoundary({ repo: f.main, run: 'r1' });
  try { assert.equal(saved.output.ok, true); assert.throws(() => registerWorker(f.main, 'r1', { id: 'late', role: 'writer' }), /STATE_CHANGED/); assert.throws(() => countDispatch(f.main, 'r1', 'writer'), /STATE_CHANGED/); assert.throws(() => registerWorktree(f.main, 'r2', { path: f.tree }), /STATE_CHANGED/); writeFileSync(join(f.tree, 'tracked.txt'), 'late'); assert.throws(() => saved.validate(), /STATE_CHANGED/); }
  finally { saved.release(); }
});
for (const transition of ['park', 'implicit', 'handoff add', 'handoff set', 'pickup', 'keep', 'finish', 'learnings']) test(`boundary refusal preserves artifacts before ${transition}`, t => {
  const f = fixture(t), next = join(dirname(f.file), 'HANDOVER-NEXT.md'); writeFileSync(next, 'transfer bytes');
  f.state.items = [{ id: 'I1', item: 'preservation', owner: 'writer', status: 'done', blocker: '', next: 'review' }]; f.state.gates = { 'done-jev': { status: 'passed' } }; f.state.closeout = { closed: 1, open: 0, details: [] }; f.state.finished = false;
  f.state.worktrees[0].branch = null; // delivery baseline is branchless; actual branch inspection still applies.
  if (transition === 'handoff set') f.state.handoffs = [handoffRecord(f)];
  if (transition === 'implicit') f.state.loops = { 'fix-batch': LOOP_CAPS['fix-batch'] - 1 };
  f.put(); git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/trio/test'); const before = readFileSync(f.file, 'utf8');
  const action = () => {
    if (transition === 'park') parkRun(f.main, 'r1', 'test');
    else if (transition === 'implicit') countLoop(f.main, 'r1', 'fix-batch');
    else if (transition.startsWith('handoff')) updateDiscipline(f.main, 'r1', 'handoff', transition.endsWith('add') ? 'add' : 'set', transition.endsWith('add') ? handoffRecord(f) : { id: 'h1', state: 'running' });
    else if (['pickup', 'keep'].includes(transition)) handoverTaken(f.main, 'r1', { by: 'next', keep: transition === 'keep' });
    else if (transition === 'learnings') setGate(f.main, 'r1', { gate: 'learnings', status: 'passed' });
    else { const r = command(['finish', '--repo', f.main, '--run', 'r1'], f.main); assert.equal(r.status, 3); assert.match(r.stderr, /BOUNDARY_REFUSED.*DEFAULT_BRANCH/); return; }
    assert.fail('transition accepted');
  };
  if (transition === 'finish') action(); else assert.throws(action, /BOUNDARY_REFUSED.*DEFAULT_BRANCH/);
  assert.equal(readFileSync(f.file, 'utf8'), before); assert.equal(readFileSync(next, 'utf8'), 'transfer bytes'); assert.equal(readdirSync(dirname(next)).some(n => n.startsWith('HANDOVER-TAKEN')), false);
});
test('missing registered tree needs this run closed detail and a live matching HEAD', t => {
  const f = fixture(t), head = git(f.tree, 'rev-parse', 'HEAD'); git(f.main, 'worktree', 'remove', f.tree);
  assert.equal(f.save().checkouts[0].reason, 'MISSING'); f.state.closeout = { closed: 1, open: 0, details: [{ path: f.tree, status: 'closed', head }] }; f.put(); assert.equal(f.save().ok, true);
  f.state.closeout.details[0].head = '0'.repeat(40); f.put(); assert.equal(f.save().checkouts[0].reason, 'MISSING');
});
test('partial multi-tree success stays saved while terminal publication is refused; retry is idempotent', t => {
  const f = fixture(t), second = join(f.dir, 'second'); git(f.main, 'worktree', 'add', '-b', 'trio/second', second);
  f.state.worktrees.push({ path: second, branch: 'trio/second', role: 'writer' }); f.put(); writeFileSync(join(f.tree, 'tracked.txt'), 'first'); writeFileSync(join(second, 'tracked.txt'), 'second');
  hook(f, 'pre-push', `process.exit(process.cwd() === ${JSON.stringify(second)} ? 1 : 0);`);
  assert.throws(() => parkRun(f.main, 'r1', 'partial'), /PUSH_REJECTED/); const firstHead = git(f.tree, 'rev-parse', 'HEAD'); assert.equal(git(f.remote, 'rev-parse', 'trio/test'), firstHead); assert.equal(existsSync(join(dirname(f.file), 'HANDOVER-NEXT.md')), false);
  rmSync(join(f.main, '.git/hooks/pre-push')); const out = f.save(); assert.equal(out.ok, true); assert.equal(out.checkouts[0].action, 'clean'); assert.equal(git(f.tree, 'rev-parse', 'HEAD'), firstHead);
});
test('state lock stays absent during a save exceeding 60 seconds; competing generation retries fresh', { timeout: 115000 }, t => {
  const f = fixture(t), lock = join(dirname(f.file), 'state.lock'), observed = join(f.dir, 'observed'), late = join(f.dir, 'late');
  git(f.main, 'worktree', 'add', '-b', 'trio/late', late); writeFileSync(join(late, 'tracked.txt'), 'late tree bytes'); writeFileSync(join(f.tree, 'tracked.txt'), 'slow candidate');
  hook(f, 'pre-push', `import { existsSync, writeFileSync } from 'node:fs';
    import { registerWorktree } from ${JSON.stringify(new URL('./run-state.mjs', import.meta.url).href)};
    if (existsSync(${JSON.stringify(observed)})) process.exit(0);
    if (existsSync(${JSON.stringify(lock)})) process.exit(41);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 61000);
    if (existsSync(${JSON.stringify(lock)})) process.exit(42);
    registerWorktree(${JSON.stringify(f.main)}, 'r1', { path: ${JSON.stringify(late)}, branch: 'trio/late' });
    writeFileSync(${JSON.stringify(observed)}, 'lock absent past 60s');`);
  parkRun(f.main, 'r1', 'slow'); assert.equal(readFileSync(observed, 'utf8'), 'lock absent past 60s'); assert.equal(JSON.parse(readFileSync(f.file)).status, 'parked:slow');
  assert.equal(git(f.remote, 'show', 'trio/late:tracked.txt'), 'late tree bytes', 'fresh retry must include the tree registered during save');
});

test('index reconciliation preserves final working bytes even when staged bytes differ', t => {
  const f = fixture(t); writeFileSync(join(f.tree, 'tracked.txt'), 'staged'); git(f.tree, 'add', 'tracked.txt'); writeFileSync(join(f.tree, 'tracked.txt'), 'base\n');
  assert.equal(f.save().ok, true); assert.equal(git(f.tree, 'show', 'HEAD:tracked.txt'), 'base'); assert.equal(git(f.tree, 'status', '--porcelain'), '');
});
for (const automatic of [false, true]) for (const proof of [false, true]) test(`${automatic ? 'learnings' : 'finish'} after closeout requires exact missing-tree proof (${proof})`, t => {
  const f = fixture(t), head = git(f.tree, 'rev-parse', 'HEAD'); git(f.main, 'worktree', 'remove', f.tree);
  f.state.gates = { 'done-jev': { status: 'passed' } }; f.state.closeout = { at: new Date().toISOString(), closed: 1, open: 0, details: proof ? [{ path: f.tree, status: 'closed', head }] : [] }; f.put();
  writeFileSync(join(dirname(f.file), 'clean-state.json'), JSON.stringify({ at: new Date().toISOString(), ok: true })); const before = readFileSync(f.file, 'utf8');
  const r = command(automatic ? ['set', '--repo', f.main, '--run', 'r1', '--gate', 'learnings', '--status', 'passed'] : ['finish', '--repo', f.main, '--run', 'r1'], f.main);
  if (proof) { assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(readFileSync(f.file)).finished, true); }
  else { assert.equal(r.status, 3); assert.match(r.stderr, /MISSING/); assert.equal(readFileSync(f.file, 'utf8'), before); }
});
test('two consecutive concurrent edits refuse after exactly one fresh retry without publishing NEXT', t => {
  const f = fixture(t), count = join(f.dir, 'count'); writeFileSync(join(f.tree, 'tracked.txt'), 'candidate');
  hook(f, 'pre-commit', `import { existsSync, readFileSync, writeFileSync } from 'node:fs'; const file=${JSON.stringify(count)}; const n=existsSync(file)?Number(readFileSync(file))+1:1; writeFileSync(file,String(n)); writeFileSync(${JSON.stringify(join(f.tree, 'tracked.txt'))},'concurrent-'+n);`);
  const before = readFileSync(f.file, 'utf8'); assert.throws(() => parkRun(f.main, 'r1', 'race'), /STATE_CHANGED/); assert.equal(readFileSync(count, 'utf8'), '2'); assert.equal(readFileSync(f.file, 'utf8'), before); assert.equal(existsSync(join(dirname(f.file), 'HANDOVER-NEXT.md')), false); assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'concurrent-2');
});
test('v1 JSON keys and process exits distinguish clean, pending and unknown', t => {
  const f = fixture(t), script = join(import.meta.dirname, 'boundary.mjs');
  const run = extra => spawnSync(process.execPath, [script, 'save', '--path', f.tree, '--json', ...extra], { encoding: 'utf8', cwd: f.main });
  let r = run([]); assert.equal(r.status, 0, r.stderr); const out = JSON.parse(r.stdout); assert.deepEqual(Object.keys(out).sort(), ['checkouts', 'ok']); assert.deepEqual(Object.keys(out.checkouts[0]).sort(), ['action', 'ahead', 'attested', 'branch', 'dirty', 'head', 'parked', 'path', 'reason']);
  writeFileSync(join(f.tree, 'tracked.txt'), 'pending'); const head = git(f.tree, 'rev-parse', 'HEAD'); r = run(['--dry-run']); assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).checkouts[0].action, 'would-save'); assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head); assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'pending');
  git(f.tree, 'remote', 'set-url', 'origin', join(f.dir, 'offline')); r = run(['--dry-run']); assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).checkouts[0].action, 'unknown');
});

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { closeAll } from './closeout.mjs';
test('partial stray move failure reports completed moves and retries without overwrites; archive survives close', t => {
  const f = fixture(t); writeFileSync(join(f.tree, 'a-stray'), 'first'); writeFileSync(join(f.tree, 'b-stray'), 'second');
  const original = fs.linkSync; let out;
  fs.linkSync = (source, target) => { if (source === join(f.tree, 'b-stray')) throw Object.assign(new Error('fixture move failure'), { code: 'EACCES' }); return original(source, target); }; syncBuiltinESMExports();
  try { out = f.save(); } finally { fs.linkSync = original; syncBuiltinESMExports(); }
  assert.equal(out.ok, false); assert.equal(out.checkouts[0].reason, 'STRAY_UNSAFE'); assert.equal(out.checkouts[0].parked.length, 1); const parked = out.checkouts[0].parked[0]; assert.equal(readFileSync(parked.to, 'utf8'), 'first'); assert.equal(readFileSync(join(f.tree, 'b-stray'), 'utf8'), 'second');
  assert.equal(f.save().ok, true); assert.equal(readFileSync(parked.to, 'utf8'), 'first');
  const closed = closeAll({ repo: f.main, run: 'r1', apply: true }); assert.equal(closed.open, 0); assert.equal(existsSync(f.tree), false); assert.equal(f.save().ok, true); assert.equal(readFileSync(parked.to, 'utf8'), 'first');
});
for (const transition of ['handoff add', 'handoff set', 'pickup', 'keep']) test(`dirty task bytes are pushed before ${transition} publication`, t => {
  const f = fixture(t); f.state.items = [{ id: 'I1', item: 'task', owner: 'writer', status: 'done', blocker: '', next: 'review' }]; if (transition === 'handoff set') f.state.handoffs = [handoffRecord(f)]; f.put();
  const next = join(dirname(f.file), 'HANDOVER-NEXT.md'); writeFileSync(next, 'next bytes'); writeFileSync(join(f.tree, 'tracked.txt'), 'save before transfer');
  if (transition.startsWith('handoff')) updateDiscipline(f.main, 'r1', 'handoff', transition.endsWith('add') ? 'add' : 'set', transition.endsWith('add') ? handoffRecord(f) : { id: 'h1', state: 'running' });
  else handoverTaken(f.main, 'r1', { by: 'next', keep: transition === 'keep' });
  assert.equal(git(f.tree, 'status', '--porcelain'), ''); assert.equal(git(f.remote, 'rev-parse', 'trio/test'), git(f.tree, 'rev-parse', 'HEAD')); assert.equal(git(f.tree, 'show', 'HEAD:tracked.txt'), 'save before transfer');
});

test('oversize tracked candidate refuses before committing or pushing', t => {
  const f = fixture(t), head = git(f.tree, 'rev-parse', 'HEAD'); writeFileSync(join(f.tree, 'tracked.txt'), Buffer.alloc(20 * 1024 * 1024 + 1, 65));
  assert.equal(f.save().checkouts[0].reason, 'SECRET_OR_DATA'); assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head); assert.equal(git(f.remote, 'rev-parse', 'trio/test'), head);
});

test('reuse caller may register under its own existing lock without releasing it', t => {
  const f = fixture(t);
  f.state.finished = true; f.put();
  const lock = tryAcquire(lockNameFor(f.tree), { note: 'reuse' }); assert.equal(lock.acquired, true);
  try { const records = registerWorktree(f.main, 'r2', { path: f.tree, branch: 'trio/test' }); assert.equal(records[0].path, f.tree); assert.equal(existsSync(lock.file), true); }
  finally { unlock(lock.file); }
});
test('malformed run records and tree arrays stay unknown rather than becoming an empty successful save', t => {
  const f = fixture(t);
  for (const record of [[], { run: 'r1', worktrees: null }, { run: 'r1', worktrees: [null] }]) {
    writeFileSync(f.file, JSON.stringify(record)); const out = f.save(); assert.equal(out.ok, false); assert.equal(out.checkouts[0].reason, 'UNKNOWN');
  }
  f.put(); const other = join(f.main, '.trioharness-direct/runs/r2/state.json'); mkdirSync(dirname(other), { recursive: true }); writeFileSync(other, '[]');
  assert.equal(f.save().ok, false, 'malformed other-run ownership cannot be ignored');
});

import childProcess from 'node:child_process';
import { withStateLock } from './run-state.mjs';
test('malformed terminal records refuse before NEXT or state publication', t => {
  const f = fixture(t), next = join(dirname(f.file), 'HANDOVER-NEXT.md');
  for (const record of [[], { run: 'r1', gates: {}, history: [], worktrees: null }]) {
    const bytes = JSON.stringify(record); writeFileSync(f.file, bytes);
    assert.throws(() => parkRun(f.main, 'r1', 'malformed'), /BOUNDARY_REFUSED.*UNKNOWN/);
    assert.equal(readFileSync(f.file, 'utf8'), bytes); assert.equal(existsSync(next), false);
  }
});
test('closed-tree publication validation performs no remote observation under the state lock', t => {
  const f = fixture(t), head = git(f.tree, 'rev-parse', 'HEAD'); git(f.main, 'worktree', 'remove', f.tree);
  f.state.closeout = { closed: 1, open: 0, details: [{ path: f.tree, branch: 'trio/test', status: 'closed', head }] }; f.put();
  const saved = saveBoundary({ repo: f.main, run: 'r1' }); assert.equal(saved.output.ok, true);
  const original = childProcess.execFileSync; let remoteCalls = 0;
  childProcess.execFileSync = (file, args, ...rest) => {
    if (file === 'git' && args.includes('ls-remote')) { remoteCalls++; assert.equal(existsSync(join(dirname(f.file), 'state.lock')), false, 'remote IO must not run under state.lock'); }
    return original(file, args, ...rest);
  }; syncBuiltinESMExports();
  try { withStateLock(f.main, 'r1', () => saved.validate()); assert.equal(remoteCalls, 0); }
  finally { childProcess.execFileSync = original; syncBuiltinESMExports(); saved.release(); }
});
test('explicit task push never follows unpublished annotated tags from Git configuration', t => {
  const f = fixture(t); git(f.tree, 'tag', '-a', 'local-only', '-m', 'local tag'); git(f.tree, 'config', 'push.followTags', 'true'); writeFileSync(join(f.tree, 'tracked.txt'), 'tag check');
  assert.equal(f.save().ok, true); assert.equal(git(f.tree, 'ls-remote', '--tags', 'origin'), ''); assert.equal(git(f.tree, 'tag', '--list'), 'local-only');
});

for (const secret of [false, true]) test(`H1 absent task ref excludes long live default history; new secret=${secret}`, t => {
  const f = fixture(t); git(f.tree, 'push', 'origin', '--delete', 'trio/test');
  writeFileSync(join(f.main, 'published-fixture.txt'), 'gh' + 'p_' + 'A'.repeat(36));
  git(f.main, 'add', '.'); git(f.main, 'commit', '-m', 'published fixture');
  const tree = git(f.main, 'rev-parse', 'HEAD^{tree}'); let parent = git(f.main, 'rev-parse', 'HEAD');
  for (let n = 0; n < 150; n++) parent = git(f.main, 'commit-tree', tree, '-p', parent, '-m', `published ${n}`);
  git(f.main, 'update-ref', 'refs/heads/main', parent); git(f.main, 'push', 'origin', 'main'); git(f.tree, 'merge', '--ff-only', 'main');
  writeFileSync(join(f.tree, 'tracked.txt'), secret ? 'gh' + 'p_' + 'B'.repeat(36) : 'new safe commit');
  git(f.tree, 'commit', '-am', 'new task bytes'); const out = f.save();
  if (secret) assert.equal(out.checkouts[0].reason, 'SECRET_OR_DATA');
  else { assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(git(f.remote, 'rev-parse', 'trio/test'), git(f.tree, 'rev-parse', 'HEAD')); }
});
test('H2 proof command lock permits dispatch and worker registration', async t => {
  const f = fixture(t), ready = join(f.dir, 'proof-ready'), done = join(f.dir, 'proof-done');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [join(import.meta.dirname, 'run-lock.mjs'), 'run', '--', process.execPath, '-e',
    `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(done)})){clearInterval(timer);}},20);`], { cwd: f.tree, stdio: 'ignore' });
  const exited = new Promise(resolve => child.on('exit', resolve));
  try {
    for (let n=0; n<500 && !existsSync(ready); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(ready), true, 'proof command started under run-lock');
    assert.doesNotThrow(() => countDispatch(f.main, 'r1', 'writer'));
    assert.doesNotThrow(() => registerWorker(f.main, 'r1', { id: 'parallel', role: 'writer' }));
  } finally { writeFileSync(done, 'done'); assert.equal(await exited, 0); }
});

for (const unavailable of [false, true]) test(`H1 absent task ref establishes unfetched live default; unavailable=${unavailable}`, t => {
  const f = fixture(t), publisher = join(f.dir, 'publisher'); git(f.tree, 'push', 'origin', '--delete', 'trio/test');
  git(f.main, 'clone', f.remote, publisher); git(publisher, 'config', 'user.name', 'Publisher'); git(publisher, 'config', 'user.email', 'publisher@test.local');
  writeFileSync(join(publisher, 'published.txt'), 'published'); git(publisher, 'add', '.'); git(publisher, 'commit', '-m', 'live default'); git(publisher, 'push', 'origin', 'main');
  const tip = git(publisher, 'rev-parse', 'HEAD'), original = childProcess.execFileSync; let fetched = false, out;
  childProcess.execFileSync = (cmd, args, ...rest) => { if (cmd === 'git' && args.includes('fetch')) { fetched = true; if (unavailable) throw new Error('fetch unavailable'); } return original(cmd, args, ...rest); }; syncBuiltinESMExports();
  try { out = f.save(); } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
  assert.equal(fetched, true, 'must obtain the live default commit');
  if (unavailable) { assert.equal(out.checkouts[0].reason, 'UNKNOWN'); assert.equal(out.checkouts[0].action, 'unknown'); }
  else { assert.equal(out.ok, true, JSON.stringify(out)); git(f.tree, 'cat-file', '-e', tip + '^{commit}'); }
});


for (const dryRun of [false, true]) test(`A2 no-record path save refuses ownership without side effects; dryRun=${dryRun}`, t => {
  const f = fixture(t), head = git(f.tree, 'rev-parse', 'HEAD'); rmSync(f.file);
  writeFileSync(join(f.tree, 'tracked.txt'), 'tracked WIP'); mkdirSync(join(f.tree, 'scratch')); writeFileSync(join(f.tree, 'scratch/stray'), 'stray bytes');
  const marker = join(f.dir, 'mutation'); hook(f, 'pre-commit', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'commit');`);
  hook(f, 'pre-push', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'push');`);
  const result = saveBoundary({ path: f.tree, dryRun }); result.release();
  assert.equal(result.output.ok, false); assert.equal(result.output.checkouts[0].reason, 'NOT_OWNED'); assert.deepEqual(result.output.checkouts[0].parked, []);
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head); assert.equal(git(f.remote, 'rev-parse', 'trio/test'), head); assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'tracked WIP'); assert.equal(readFileSync(join(f.tree, 'scratch/stray'), 'utf8'), 'stray bytes');
  assert.equal(existsSync(join(f.main, '.trioharness-direct/stray')), false); assert.equal(existsSync(join(dirname(f.file), 'stray')), false);
});
for (const mode of ['task-tip', 'merged-deleted', 'unmerged-deleted', 'unavailable', 'unrecorded']) test(`A2 real closeout missing-tree proof: ${mode}`, t => {
  const f = fixture(t); writeFileSync(join(f.tree, 'tracked.txt'), 'saved task'); git(f.tree, 'commit', '-am', 'task'); git(f.tree, 'push', 'origin', 'trio/test');
  const head = git(f.tree, 'rev-parse', 'HEAD');
  assert.equal(closeAll({ repo: f.main, run: 'r1', apply: true }).closed, 1);
  if (mode === 'merged-deleted') {
    const other = join(f.dir, 'merger'); git(f.main, 'clone', f.remote, other); git(other, 'config', 'user.name', 'Merger'); git(other, 'config', 'user.email', 'merger@test.local');
    git(other, 'merge', '--ff-only', 'origin/trio/test'); writeFileSync(join(other, 'later.txt'), 'later default'); git(other, 'add', 'later.txt'); git(other, 'commit', '-m', 'later'); git(other, 'push', 'origin', 'main');
  }
  if (mode.endsWith('deleted')) git(f.remote, 'update-ref', '-d', 'refs/heads/trio/test');
  if (mode === 'unavailable') git(f.main, 'remote', 'set-url', 'origin', join(f.dir, 'offline'));
  if (mode === 'unrecorded') { const record = JSON.parse(readFileSync(f.file)); record.closeout.details = []; writeFileSync(f.file, JSON.stringify(record)); }
  const refs = git(f.main, 'show-ref'), fetchHead = join(f.main, '.git/FETCH_HEAD');
  const out = f.save();
  if (['task-tip', 'merged-deleted'].includes(mode)) { assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.checkouts[0].head, head); }
  else { assert.equal(out.ok, false); assert.ok(['MISSING', 'UNKNOWN', 'REMOTE_UNREACHABLE'].includes(out.checkouts[0].reason), JSON.stringify(out)); }
  assert.equal(git(f.main, 'show-ref'), refs, 'proof must not update refs'); assert.equal(existsSync(fetchHead), false, 'proof must not write FETCH_HEAD');
});
for (const kind of ['gitlink', 'absent-gitlink', 'nested']) for (const dirty of [false, true]) for (const dryRun of [false, true]) test(`A2 NESTED_REPO ${kind}, dirty=${dirty}, dryRun=${dryRun}`, t => {
  const f = fixture(t), nested = join(f.tree, 'sub');
  if (kind === 'nested') { mkdirSync(nested); git(nested, 'init'); writeFileSync(join(nested, 'local.txt'), 'nested bytes'); }
  else {
    git(f.tree, 'update-index', '--add', '--cacheinfo', `160000,${git(f.tree, 'rev-parse', 'HEAD')},sub`); git(f.tree, 'commit', '-m', 'gitlink'); git(f.tree, 'push', 'origin', 'trio/test');
    if (kind === 'gitlink') mkdirSync(nested);
  }
  if (dirty) writeFileSync(join(f.tree, 'tracked.txt'), 'keep dirty bytes');
  writeFileSync(join(f.tree, 'stray.txt'), 'do not move');
  const head = git(f.tree, 'rev-parse', 'HEAD'), index = readFileSync(git(f.tree, 'rev-parse', '--git-path', 'index'));
  // Also exercise a clean checkout (the untracked nested repo is itself the unsupported entry).
  if (!dirty && kind !== 'nested') rmSync(join(f.tree, 'stray.txt'));
  const beforeStatus = git(f.tree, 'status', '--porcelain');
  const out = f.save({ dryRun }); assert.equal(out.ok, false); assert.equal(out.checkouts[0].reason, 'NESTED_REPO'); assert.deepEqual(out.checkouts[0].parked, []);
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head); assert.equal(git(f.remote, 'rev-parse', 'trio/test'), head); assert.equal(git(f.tree, 'status', '--porcelain'), beforeStatus);
  assert.deepEqual(readFileSync(git(f.tree, 'rev-parse', '--git-path', 'index')), index); assert.equal(existsSync(join(dirname(f.file), 'stray')), false);
  if (kind === 'nested') assert.equal(readFileSync(join(nested, 'local.txt'), 'utf8'), 'nested bytes');
});


function unfetchedClosedDefault(t) {
  const f = fixture(t); closeAll({ repo: f.main, run: 'r1', apply: true });
  const other = join(f.dir, 'default-writer'); git(f.main, 'clone', f.remote, other); git(other, 'config', 'user.name', 'Default'); git(other, 'config', 'user.email', 'default@test.local');
  writeFileSync(join(other, 'later.txt'), 'new default'); git(other, 'add', 'later.txt'); git(other, 'commit', '-m', 'later default'); git(other, 'push', 'origin', 'main'); git(f.remote, 'update-ref', '-d', 'refs/heads/trio/test');
  return { ...f, tip: git(other, 'rev-parse', 'HEAD') };
}
for (const mode of ['dry-run', 'shared', 'read-only', 'held-admission', 'held-tree', 'admitted', 'closed-reviewer']) test(`A2 delta M2 missing-tree proof respects ${mode} before fetch`, t => {
  const f = unfetchedClosedDefault(t), names = [`boundary-${lockNameFor(f.tree)}`, lockNameFor(f.tree)];
  if (mode === 'shared') { const file = join(f.main, '.trioharness-direct/runs/r2/state.json'); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ run: 'r2', worktrees: [{ path: f.tree }] })); }
  if (mode === 'read-only' || mode === 'closed-reviewer') { const current = JSON.parse(readFileSync(f.file)); if (mode === 'read-only') current.readOnly = true; else current.worktrees[0].role = 'reviewer'; writeFileSync(f.file, JSON.stringify(current)); }
  const held = mode.startsWith('held-') ? tryAcquire(names[mode === 'held-admission' ? 0 : 1]) : null; if (held) assert.equal(held.acquired, true);
  const objects = git(f.main, 'count-objects', '-v'), refs = git(f.main, 'show-ref'), original = childProcess.execFileSync, fetches = [], observations = [];
  childProcess.execFileSync = (file, args, ...rest) => {
    if (file === 'git' && (args.includes('fetch') || args.includes('ls-remote'))) {
      if (args.includes('fetch')) fetches.push(args);
      if (['admitted', 'closed-reviewer'].includes(mode)) observations.push(names.map(name => { const probe = tryAcquire(name); if (probe.acquired) unlock(probe.file); return !probe.acquired; }));
    }
    return original(file, args, ...rest);
  }; syncBuiltinESMExports();
  let out; try { out = f.save({ dryRun: mode === 'dry-run' }); } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); if (held) unlock(held.file); }
  if (['admitted', 'closed-reviewer'].includes(mode)) { assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(fetches.length, 1); assert.ok(observations.length); assert.ok(observations.every(pair => pair.every(Boolean)), 'remote proof runs with admission and tree locks held'); }
  else {
    assert.equal(fetches.length, 0, 'refusal/dry-run must not fetch'); assert.equal(out.ok, false);
    assert.equal(out.checkouts[0].reason, mode === 'dry-run' ? 'UNKNOWN' : mode.startsWith('held-') ? 'STATE_CHANGED' : 'NOT_OWNED');
    if (mode === 'dry-run') assert.equal(out.checkouts[0].action, 'unknown');
    assert.equal(git(f.main, 'count-objects', '-v'), objects); assert.equal(git(f.main, 'show-ref'), refs);
    assert.equal(existsSync(join(f.main, '.git/FETCH_HEAD')), false);
  }
});
test('A2 delta L1 bound-endpoint fetch separates options from URL', t => {
  const f = unfetchedClosedDefault(t), original = childProcess.execFileSync, fetches = [];
  childProcess.execFileSync = (file, args, ...rest) => { if (file === 'git' && args.includes('fetch')) fetches.push(args); return original(file, args, ...rest); }; syncBuiltinESMExports();
  let out; try { out = f.save(); } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
  assert.equal(out.ok, true); assert.equal(fetches.length, 1); assert.equal(fetches[0][fetches[0].indexOf(f.remote) - 1], '--');
});
test('A2 delta L3 closed detail cannot vouch for a different registered branch', t => {
  const f = fixture(t); closeAll({ repo: f.main, run: 'r1', apply: true });
  const current = JSON.parse(readFileSync(f.file)); current.worktrees[0].branch = 'trio/replacement'; writeFileSync(f.file, JSON.stringify(current));
  const out = f.save(); assert.equal(out.ok, false); assert.equal(out.checkouts[0].reason, 'MISSING');
});


const attestation = 'reservation-a3-unique';
function pathSave(f, options = {}) {
  const result = saveBoundary({ path: f.tree, appOwned: attestation, ...options });
  try { return result.output; } finally { result.release(); }
}
function boundaryCli(f, args) {
  return spawnSync(process.execPath, [join(import.meta.dirname, 'boundary.mjs'), 'save', ...args, '--json'], { cwd: f.main, encoding: 'utf8' });
}
test('A3 attestation saves with only a finished target-ledger registration', t => {
  const f = fixture(t), local = join(f.tree, '.trioharness-direct/runs/r1/state.json');
  f.state.finished = true;
  f.put();
  mkdirSync(dirname(local), { recursive: true });
  renameSync(f.file, local);
  const before = readFileSync(local, 'utf8');
  const stray = join(f.tree, 'new.txt');
  writeFileSync(stray, 'attested stray\n');
  const result = boundaryCli(f, ['--path', f.tree, '--app-owned', attestation]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const row = JSON.parse(result.stdout).checkouts[0];
  assert.equal(row.attested, attestation);
  assert.equal(row.action, 'parked');
  assert.deepEqual(row.parked.map(entry => entry.path), ['new.txt']);
  assert.equal(readFileSync(row.parked[0].to, 'utf8'), 'attested stray\n');
  assert.equal(existsSync(stray), false);
  assert.equal(readFileSync(local, 'utf8'), before);
});

test('A3 attested no-record path commits tracked bytes and parks every untracked byte at the path destination', t => {
  const f = fixture(t); rmSync(f.file);
  writeFileSync(join(f.tree, 'tracked.txt'), 'attested tracked\n'); mkdirSync(join(f.tree, 'src'));
  writeFileSync(join(f.tree, 'src/untracked'), 'would match old scope\n'); writeFileSync(join(f.tree, 'new.txt'), 'all untracked are strays\n');
  const r = boundaryCli(f, ['--path', f.tree, '--app-owned', attestation]); assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout), row = out.checkouts[0]; assert.equal(out.ok, true); assert.equal(row.attested, attestation); assert.equal(row.action, 'committed+pushed');
  assert.equal(row.dirty, 0); assert.equal(row.ahead, 0); assert.equal(row.head, git(f.remote, 'rev-parse', 'trio/test'));
  assert.equal(git(f.remote, 'show', 'trio/test:tracked.txt'), 'attested tracked'); assert.equal(git(f.tree, 'status', '--porcelain'), '');
  assert.match(git(f.tree, 'log', '-1', '--format=%s'), /^wip\(boundary\): trio-test /);
  assert.deepEqual(row.parked.map(p => p.path).sort(), ['new.txt', 'src/untracked']);
  const archive = join(f.main, '.trioharness-direct/stray/trio-test');
  const dirs = readdirSync(archive); assert.equal(dirs.length, 1); assert.match(dirs[0], /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f-]{36}$/);
  for (const entry of row.parked) {
    assert.equal(entry.to, join(archive, dirs[0], entry.path)); assert.equal(existsSync(join(f.tree, entry.path)), false);
    assert.equal(readFileSync(entry.to, 'utf8'), entry.path === 'new.txt' ? 'all untracked are strays\n' : 'would match old scope\n');
  }
  assert.equal(existsSync(f.file), false); assert.equal(existsSync(join(f.main, '.trioharness-direct/runs/trio-test')), false, 'synthetic owner must never create a run');
});
test('A3 no flag still refuses no-record path and echoes null on early rows', t => {
  const f = fixture(t); rmSync(f.file); writeFileSync(join(f.tree, 'tracked.txt'), 'keep'); writeFileSync(join(f.tree, 'stray'), 'keep stray');
  const head = git(f.tree, 'rev-parse', 'HEAD'), out = pathSave(f, { appOwned: undefined });
  assert.equal(out.checkouts[0].attested, null); assert.equal(out.checkouts[0].reason, 'NOT_OWNED');
  assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'keep'); assert.equal(readFileSync(join(f.tree, 'stray'), 'utf8'), 'keep stray'); assert.equal(git(f.remote, 'rev-parse', 'trio/test'), head);
  for (const appOwned of [undefined, attestation]) {
    const missing = pathSave(f, { path: join(f.dir, 'missing'), appOwned }); assert.equal(missing.checkouts[0].attested, appOwned || null); assert.equal(missing.checkouts[0].reason, 'MISSING');
  }
  writeFileSync(f.file, '{'); const unknown = f.save(); assert.equal(unknown.checkouts[0].attested, null); assert.equal(unknown.checkouts[0].reason, 'UNKNOWN');
});
for (const [name, setup, reason] of [
  ['default', f => git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/trio/test'), 'DEFAULT_BRANCH'],
  ['non-task', f => git(f.tree, 'checkout', '-b', 'feature'), 'NOT_TASK_BRANCH'],
  ['primary', f => { f.tree = f.main; }, 'NOT_LINKED_WORKTREE'],
  ['detached', f => git(f.tree, 'checkout', '--detach'), 'DETACHED'],
  ['secret history', f => { writeFileSync(join(f.tree, 'tracked.txt'), 'gh' + 'p_' + 'A'.repeat(36)); git(f.tree, 'commit', '-am', 'unpublished'); }, 'SECRET_OR_DATA'],
  ['nested', f => { mkdirSync(join(f.tree, 'sub')); git(join(f.tree, 'sub'), 'init'); }, 'NESTED_REPO'],
  ['diverged', f => {
    const tree = git(f.tree, 'rev-parse', 'HEAD^{tree}'), parent = git(f.tree, 'rev-parse', 'HEAD');
    const remote = git(f.tree, 'commit-tree', tree, '-p', parent, '-m', 'remote'); git(f.tree, 'push', 'origin', `${remote}:refs/heads/trio/test`);
    writeFileSync(join(f.tree, 'tracked.txt'), 'local'); git(f.tree, 'commit', '-am', 'local');
  }, 'DIVERGED'],
  ['split endpoint', f => git(f.tree, 'config', 'remote.origin.pushurl', f.main), 'REMOTE_AMBIGUOUS'],
  ['operation', f => writeFileSync(git(f.tree, 'rev-parse', '--git-path', 'MERGE_HEAD'), git(f.tree, 'rev-parse', 'HEAD')), 'OPERATION_IN_PROGRESS']
]) test(`A3 attestation retains refusal: ${name}`, t => {
  const f = fixture(t); rmSync(f.file); setup(f); writeFileSync(join(f.tree, 'stray'), 'source intact');
  const head = git(f.tree, 'rev-parse', 'HEAD'), tip = git(f.remote, 'rev-parse', 'trio/test');
  const row = pathSave(f).checkouts[0]; assert.equal(row.reason, reason); assert.equal(row.attested, attestation); assert.deepEqual(row.parked, []);
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head); assert.equal(git(f.remote, 'rev-parse', 'trio/test'), tip); assert.equal(readFileSync(join(f.tree, 'stray'), 'utf8'), 'source intact');
});
for (const mode of ['ambiguous', 'unreadable', 'hold', 'read-only', 'worker', 'job']) test(`A3 attestation does not override main registration ${mode}`, t => {
  const f = fixture(t);
  if (mode === 'ambiguous' || mode === 'unreadable') {
    const other = join(f.main, '.trioharness-direct/runs/r2/state.json'); mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, mode === 'unreadable' ? '{' : JSON.stringify({ worktrees: [{ path: f.tree }] }));
  } else if (mode === 'hold') { f.state.closeout = { note: 'owner-hold: retain' }; f.put(); }
  else if (mode === 'read-only') { f.state.readOnly = true; f.put(); }
  else if (mode === 'worker') { f.state.workers = { active: { status: 'running' } }; f.put(); }
  else { const job = join(dirname(f.file), 'jobs/live.json'); mkdirSync(dirname(job)); writeFileSync(job, JSON.stringify({ status: 'running' })); }
  writeFileSync(join(f.tree, 'stray'), 'retain'); const row = pathSave(f).checkouts[0];
  assert.equal(row.reason, mode === 'hold' ? 'NOT_OWNED owner-hold' : 'NOT_OWNED'); assert.equal(row.attested, attestation); assert.deepEqual(row.parked, []); assert.equal(readFileSync(join(f.tree, 'stray'), 'utf8'), 'retain');
});
for (const mode of ['active', 'unreadable', 'malformed', 'hold', 'read-only', 'worker', 'job', 'unreadable-job']) test(`A3 no main registration still checks local ${mode}`, t => {
  const f = fixture(t); rmSync(f.file);
  const file = join(f.tree, '.trioharness-direct/runs/local/state.json'); mkdirSync(dirname(file), { recursive: true });
  const local = { finished: true };
  if (mode === 'active') local.finished = false;
  if (mode === 'hold') local.closeout = { note: 'owner-hold: retain' };
  if (mode === 'read-only') local.readOnly = true;
  if (mode === 'worker') local.workers = { live: { status: 'running' } };
  writeFileSync(file, mode === 'unreadable' ? '{' : mode === 'malformed' ? '[]' : JSON.stringify(local));
  if (mode.includes('job')) { const job = join(dirname(file), 'jobs/live.json'); mkdirSync(dirname(job)); writeFileSync(job, mode === 'unreadable-job' ? '{' : JSON.stringify({ status: 'running' })); }
  writeFileSync(join(f.tree, 'tracked.txt'), 'retain tracked'); writeFileSync(join(f.tree, 'stray'), 'retain stray');
  const head = git(f.tree, 'rev-parse', 'HEAD'), row = pathSave(f).checkouts[0]; assert.equal(row.reason, mode === 'hold' ? 'NOT_OWNED owner-hold' : 'NOT_OWNED'); assert.equal(row.attested, attestation); assert.deepEqual(row.parked, []);
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head); assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'retain tracked'); assert.equal(readFileSync(join(f.tree, 'stray'), 'utf8'), 'retain stray');
});
test('A3 app-owned validates path-only selector and id, and accepts an eight-character id', t => {
  const f = fixture(t);
  for (const args of [
    ['--path', f.tree, '--app-owned', ''], ['--path', f.tree, '--app-owned', '1234567'], ['--path', f.tree, '--app-owned'],
    ['--path', f.tree, '--app-owned', '--dry-run'], ['--run', 'r1', '--repo', f.main, '--app-owned', attestation],
    ['--repo', f.main, '--app-owned', attestation]
  ]) { const r = boundaryCli(f, args); assert.equal(r.status, 3, JSON.stringify(args)); assert.equal(r.stdout, ''); }
  const r = boundaryCli(f, ['--path', f.tree, '--app-owned', '12345678']); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).checkouts[0].attested, '12345678');
});
test('A3 attested dry-run lists prospective strays with no save writes', t => {
  const f = fixture(t); rmSync(f.file); writeFileSync(join(f.tree, 'tracked.txt'), 'dry tracked'); writeFileSync(join(f.tree, 'stray'), 'dry stray');
  const head = git(f.tree, 'rev-parse', 'HEAD'), objects = git(f.main, 'count-objects', '-v'), index = readFileSync(git(f.tree, 'rev-parse', '--git-path', 'index'));
  const row = pathSave(f, { dryRun: true }).checkouts[0]; assert.equal(row.action, 'would-save'); assert.equal(row.attested, attestation); assert.equal(row.parked.length, 1);
  assert.equal(existsSync(row.parked[0].to), false); assert.equal(existsSync(join(f.main, '.trioharness-direct/stray')), false);
  assert.equal(git(f.tree, 'rev-parse', 'HEAD'), head); assert.equal(git(f.remote, 'rev-parse', 'trio/test'), head); assert.equal(git(f.main, 'count-objects', '-v'), objects);
  assert.deepEqual(readFileSync(git(f.tree, 'rev-parse', '--git-path', 'index')), index); assert.equal(readFileSync(join(f.tree, 'stray'), 'utf8'), 'dry stray'); assert.equal(readFileSync(join(f.tree, 'tracked.txt'), 'utf8'), 'dry tracked');
});
for (const mode of ['exclude', 'symlink', 'collision']) test(`A3 no-record parking refuses unsafe ${mode} without overwriting bytes`, t => {
  const f = fixture(t); rmSync(f.file); writeFileSync(join(f.tree, 'stray'), 'source'); const archive = join(f.main, '.trioharness-direct/stray');
  if (mode === 'exclude') writeFileSync(join(f.main, '.git/info/exclude'), '');
  if (mode === 'symlink') symlinkSync(f.dir, archive);
  const original = fs.linkSync; let destination;
  if (mode === 'collision') { fs.linkSync = (source, target) => { destination = target; writeFileSync(target, 'previous owner bytes', { flag: 'wx' }); return original(source, target); }; syncBuiltinESMExports(); }
  let row; try { row = pathSave(f).checkouts[0]; } finally { fs.linkSync = original; syncBuiltinESMExports(); }
  assert.equal(row.reason, 'STRAY_UNSAFE'); assert.deepEqual(row.parked, []); assert.equal(readFileSync(join(f.tree, 'stray'), 'utf8'), 'source');
  if (destination) assert.equal(readFileSync(destination, 'utf8'), 'previous owner bytes');
});
test('A3 revalidates local ownership after admission and before publication', t => {
  const f = fixture(t); rmSync(f.file); const original = childProcess.execFileSync; let injected = false;
  childProcess.execFileSync = (cmd, args, ...rest) => {
    if (cmd === 'git' && args.includes('ls-remote') && !injected) {
      injected = true; const file = join(f.tree, '.trioharness-direct/runs/late/state.json'); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ finished: false }));
    }
    return original(cmd, args, ...rest);
  }; syncBuiltinESMExports();
  let row; try { row = pathSave(f).checkouts[0]; } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.equal(row.reason, 'NOT_OWNED');
  rmSync(join(f.tree, '.trioharness-direct/runs/late'), { recursive: true }); const saved = saveBoundary({ path: f.tree, appOwned: attestation });
  try { assert.equal(saved.output.ok, true); f.state.readOnly = true; f.put(); assert.throws(() => saved.validate(), /NOT_OWNED/); } finally { saved.release(); }
});
