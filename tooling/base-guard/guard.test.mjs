import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { guard } from './guard.mjs';
import { ALLOW_FILE } from './secret-patterns.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'guard-fork-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'candidate');
  const origin = join(root, 'origin.git');
  const fork = join(root, 'fork.git');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git(root, 'init', '-b', 'main', repo);
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'init', '--bare', '-b', 'main', fork);
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  const commit = value => {
    writeFileSync(join(repo, 'work.txt'), value);
    git(repo, 'add', 'work.txt');
    git(repo, 'commit', '-m', value);
    return git(repo, 'rev-parse', 'HEAD');
  };
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'remote', 'add', 'fork', fork);
  const allow = join(repo, ALLOW_FILE);
  mkdirSync(dirname(allow), { recursive: true });
  writeFileSync(allow, '# upstream policy\n');
  git(repo, 'add', ALLOW_FILE);
  const upstream = commit('upstream');
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
  git(repo, 'push', 'fork', 'HEAD:refs/heads/main');
  // A fork policy must have no authority, even when the fork proves base reachability.
  writeFileSync(allow, 'invalid fork policy\n');
  git(repo, 'add', ALLOW_FILE);
  const base = commit('fork base');
  git(repo, 'push', 'fork', 'HEAD:refs/heads/codeden/build');
  const localOnly = commit('local only');
  return { repo, git, base, localOnly, upstream, fork };
}

test('accepts a fork-only base using the live branch and keeps the upstream default pinned', t => {
  const { repo, base, upstream } = fixture(t);
  const opts = { repo, base, remote: 'origin/main', owned: ['work.txt'], allowMainWorktree: true };
  assert.ok(guard(opts).violations.some(v => v.rule === 'base-not-on-remote'));
  const result = guard({ ...opts, forkRemote: 'fork', maxBehind: 0 });
  assert.equal(result.clean, true, JSON.stringify(result.violations));
  assert.equal(result.baseVerified, true);
  assert.equal(result.defaultRef.sha, upstream);
  assert.deepEqual(result.forkBaseRef, { remote: 'fork', branch: 'codeden/build', sha: base });
  assert.equal(result.baseBehindRemote, 0);
});

test('refuses a base on neither remote and a stale fork-tracking ref', t => {
  const { repo, git, base, localOnly, upstream } = fixture(t);
  const opts = { repo, remote: 'origin/main', forkRemote: 'fork', owned: ['work.txt'], allowMainWorktree: true };
  const assertRefused = sha => {
    const result = guard({ ...opts, base: sha });
    assert.equal(result.clean, false);
    assert.equal(result.baseVerified, false);
    assert.ok(result.violations.some(v => v.rule === 'base-not-on-remote'));
  };
  assertRefused(localOnly);
  git(repo, 'update-ref', 'refs/remotes/fork/codeden/build', upstream);
  assertRefused(base);
});

test('checks maximum drift against the verified fork branch', t => {
  const { repo, git, base } = fixture(t);
  git(repo, 'push', 'fork', 'HEAD:refs/heads/codeden/build');
  const result = guard({ repo, base, remote: 'origin/main', forkRemote: 'fork',
    owned: ['work.txt'], allowMainWorktree: true, maxBehind: 0 });
  assert.equal(result.baseVerified, true);
  assert.equal(result.baseBehindRemote, 1);
  assert.ok(result.violations.some(v => v.rule === 'base-stale'));
});
