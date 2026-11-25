import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTrustedDefault } from './default-ref.mjs';

// The launcher supplies a confined tmpdir and Git environment. Fixtures are create-only; leftovers stay.
const g = (cwd, ...args) => execFileSync('git', args, {
  cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim();
function fixture(branch = 'release') {
  const root = mkdtempSync(join(tmpdir(), 'hf5b1e-ref-'));
  const upstream = join(root, 'remote.git'), seed = join(root, 'seed'), repo = join(root, 'clone');
  mkdirSync(seed);
  g(root, 'init', '--bare', '-q', '-b', branch, upstream);
  g(seed, 'init', '-q', '-b', branch);
  g(seed, 'remote', 'add', 'origin', upstream);
  let n = 0;
  const commit = () => {
    writeFileSync(join(seed, 'content'), `revision ${++n}\n`);
    g(seed, 'add', 'content'); g(seed, 'commit', '-q', '-m', `revision ${n}`);
    return g(seed, 'rev-parse', 'HEAD');
  };
  const sha = commit(); g(seed, 'push', '-q', 'origin', branch);
  g(root, 'clone', '-q', upstream, repo);
  return { root, upstream, seed, repo, sha, branch, commit };
}
const expected = t => ({ remoteName: 'origin', branch: t.branch, ref: `refs/remotes/origin/${t.branch}`, sha: t.sha });
const refuses = (fn, code) => assert.throws(fn, e => e.code === code && e.message.startsWith(`${code}:`));

test('hf5b1e-s6-d-ref-01: conventional branches cannot replace an advertised release default', () => {
  const t = fixture();
  for (const branch of ['main', 'develop']) {
    g(t.seed, 'push', '-q', 'origin', `${t.sha}:refs/heads/${branch}`);
  }
  g(t.repo, 'fetch', '-q', 'origin');
  for (const remote of ['origin/main', 'origin/develop']) {
    refuses(() => resolveTrustedDefault({ repo: t.repo, remote }), 'REMOTE_NOT_DEFAULT');
  }
  refuses(() => resolveTrustedDefault({ repo: t.repo, remote: 'absent/release' }), 'DEFAULT_REMOTE_UNKNOWN');
});

test('hf5b1e-s6-d-ref-02: forged local origin/HEAD is ignored', () => {
  const t = fixture();
  g(t.repo, 'update-ref', 'refs/remotes/origin/main', t.sha);
  g(t.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.deepEqual(resolveTrustedDefault({ repo: t.repo, remote: 'origin' }), expected(t));
  refuses(() => resolveTrustedDefault({ repo: t.repo, remote: 'origin/HEAD' }), 'REMOTE_NOT_DEFAULT');
});

test('hf5b1e-s6-d-ref-03: a forged tracking tip is stale', () => {
  const t = fixture();
  const forged = t.commit(); g(t.repo, 'fetch', '-q', t.seed, t.branch);
  g(t.repo, 'update-ref', `refs/remotes/origin/${t.branch}`, forged);
  refuses(() => resolveTrustedDefault({ repo: t.repo, remote: 'origin' }), 'REMOTE_REF_STALE');
});

test('hf5b1e-s6-d-ref-04: a local origin/main branch cannot impersonate the full tracking ref', () => {
  const t = fixture('main');
  g(t.repo, 'branch', 'origin/main', t.sha);
  // No delete: make the full tracking ref symbolic to a missing ref while the impersonating branch still exists.
  g(t.repo, 'symbolic-ref', 'refs/remotes/origin/main', 'refs/remotes/origin/absent');
  assert.equal(g(t.repo, 'rev-parse', '--verify', 'refs/heads/origin/main'), t.sha);
  refuses(() => resolveTrustedDefault({ repo: t.repo, remote: 'origin/main' }), 'REMOTE_REF_STALE');
});

test('hf5b1e-s6-d-ref-05: unreachable, missing, detached, malformed and repeated advertisements fail closed', () => {
  const t = fixture();
  g(t.repo, 'remote', 'set-url', 'origin', join(t.root, 'unreachable.git'));
  refuses(() => resolveTrustedDefault({ repo: t.repo, remote: 'origin' }), 'DEFAULT_UNVERIFIED');
  g(t.repo, 'remote', 'set-url', 'origin', t.upstream);
  g(t.upstream, 'symbolic-ref', 'HEAD', 'refs/heads/unborn');
  refuses(() => resolveTrustedDefault({ repo: t.repo, remote: 'origin' }), 'DEFAULT_UNVERIFIED');
  // Replacing HEAD with its object id simulates a detached bare remote, without deleting any fixture file.
  writeFileSync(join(t.upstream, 'HEAD'), `${t.sha}\n`);
  refuses(() => resolveTrustedDefault({ repo: t.repo, remote: 'origin' }), 'DEFAULT_UNVERIFIED');
  const sym = 'ref: refs/heads/release\tHEAD\n', tip = `${t.sha}\tHEAD\n`;
  for (const advertisement of [tip, sym, sym + sym + tip, sym + tip + tip,
    sym + `${'a'.repeat(41)}\tHEAD\n`, 'ref: refs/tags/release\tHEAD\n' + tip,
    'ref: refs/heads/../release\tHEAD\n' + tip, sym + tip + 'garbage\n']) {
    const git = args => args[0] === 'remote' ? 'origin\n' : advertisement;
    refuses(() => resolveTrustedDefault({ repo: t.repo, remote: 'origin', git }), 'DEFAULT_UNVERIFIED');
  }
  for (const failure of ['timeout', 'unreadable']) {
    const git = args => {
      if (args[0] === 'remote') return 'origin\n';
      throw Object.assign(new Error(failure), { code: failure === 'timeout' ? 'ETIMEDOUT' : 'EIO' });
    };
    refuses(() => resolveTrustedDefault({ repo: t.repo, remote: 'origin', git }), 'DEFAULT_UNVERIFIED');
  }
});

test('hf5b1e-s6-d-ref-06: a nonstandard default resolves with bounded noninteractive Git', () => {
  const t = fixture('cumulus/main');
  const calls = [], originalEnvObject = process.env, originalEnv = { ...process.env };
  const git = (args, options) => {
    calls.push({ args, options });
    return execFileSync('git', args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  assert.deepEqual(resolveTrustedDefault({ repo: t.repo, remote: 'origin/cumulus/main', git }), expected(t));
  assert.deepEqual(calls.map(c => c.args), [
    ['remote'], ['ls-remote', '--symref', 'origin', 'HEAD'],
    ['rev-parse', '--verify', 'refs/remotes/origin/cumulus/main^{commit}']
  ]);
  assert.equal(calls[1].options.timeout, 120000);
  assert.equal(calls[1].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[1].options.cwd, t.repo);
  assert.equal(process.env, originalEnvObject);
  assert.deepEqual({ ...process.env }, originalEnv);
  // The JS contract accepts SHA-256 advertisements as well as SHA-1.
  const sha = 'b'.repeat(64);
  const git256 = args => args[0] === 'remote' ? 'origin\n' : args[0] === 'ls-remote'
    ? `ref: refs/heads/cumulus/main\tHEAD\n${sha}\tHEAD\n` : `${sha}\n`;
  assert.deepEqual(resolveTrustedDefault({ repo: t.repo, remote: 'origin', git: git256 }), { ...expected(t), sha });
});

test('hf5b1e-s6-d-ref-07: remote drift refuses a stale clone until fetch', () => {
  const t = fixture();
  const sha = t.commit(); g(t.seed, 'push', '-q', 'origin', t.branch);
  refuses(() => resolveTrustedDefault({ repo: t.repo, remote: 'origin' }), 'REMOTE_REF_STALE');
  g(t.repo, 'fetch', '-q', 'origin');
  assert.deepEqual(resolveTrustedDefault({ repo: t.repo, remote: 'origin' }), { ...expected(t), sha });
});

test('hf5b1e-s6-d-ref-08: the returned sha remains usable after a tracking ref moves', () => {
  const t = fixture();
  const result = resolveTrustedDefault({ repo: t.repo, remote: 'origin' });
  assert.equal(result.sha, t.sha);
  const later = t.commit(); g(t.repo, 'fetch', '-q', t.seed, t.branch);
  g(t.repo, 'update-ref', `refs/remotes/origin/${t.branch}`, later);
  assert.equal(result.sha, t.sha);
  assert.equal(g(t.repo, 'show', `${result.sha}:content`), 'revision 1');
  assert.equal(g(t.repo, 'show', `${result.ref}:content`), 'revision 2');
});
