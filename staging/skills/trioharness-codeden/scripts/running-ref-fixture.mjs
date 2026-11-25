import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './running-ref.mjs';
// Hermetic: the user's own standing orders must never answer a test card.
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.TRIOHARNESS_HOME = process.env.TRIOHARNESS_HOME_FOR_TESTS || '/nonexistent-trioharness-home';

const env = { GIT_ALLOW_PROTOCOL: 'file', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function mkRepo() {
  const base = mkdtempSync(join(tmpdir(), 'rr-'));
  const remote = join(base, 'remote.git'), work = join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { env: { ...process.env, ...env } });
  mkdirSync(work);
  g(work, 'init', '-b', 'main'); g(work, 'remote', 'add', 'origin', remote);
  const commit = name => { writeFileSync(join(work, name), name); g(work, 'add', '-A'); g(work, 'commit', '-m', name); return g(work, 'rev-parse', 'HEAD'); };
  const c1 = commit('c1'), c2 = commit('c2'), c3 = commit('c3');
  g(work, 'push', 'origin', 'main');
  g(work, 'checkout', '-b', 'feat', c2); const f1 = commit('f1'); g(work, 'push', 'origin', 'feat'); g(work, 'checkout', 'main');
  const keyFile = join(base, 'running-ref.key');
  const azureTargetsFile = join(base, 'azure-targets.json');
  writeFileSync(azureTargetsFile, JSON.stringify(defaultAzure));
  return { work, c1, c2, c3, f1, commit, keyFile, azureTargetsFile };
}
const fakeRead = map => async h => map[h.url] ?? { ok: false, status: 503 };
const envFile = (work, obj) => { mkdirSync(join(work, '.trioharness'), { recursive: true }); writeFileSync(join(work, '.trioharness', 'environments.json'), JSON.stringify(obj)); };
const H = u => ({ url: `https://${u}/health`, shaField: 'commit' });

const defaultAzure = {
  version: 1,
  prd: { deployTargets: [{ name: 'prd' }], apps: [{ name: 'mobile-api-prod' }] },
  test: { deployTargets: [{ name: 'test' }], apps: [{ name: 'mobile-api-test' }] },
  qa: { deployTargets: [{ name: 'qa' }], apps: [{ name: 'mobile-api-qa' }] }
};
const targetNames = ['test', 'qa', 'prd'];
// Publish manifests to the remote default before checking.
const publish = r => { g(r.work, 'add', '-A'); g(r.work, 'commit', '-m', 'environments'); g(r.work, 'push', '-q', 'origin', 'main'); r.c3 = g(r.work, 'rev-parse', 'HEAD'); };
function targetRepo() {
  const r = mkRepo();
  envFile(r.work, { schema: 1, environments: Object.fromEntries(targetNames.map(name => [name, { health: H(name) }])) });
  publish(r);
  return r;
}

const azureFile = obj => {
  const path = join(mkdtempSync(join(tmpdir(), 'rr-az-')), 'azure-targets.json');
  writeFileSync(path, JSON.stringify({ version: 1, ...obj }));
  return path;
};

async function checkCli(r, args = [], targets) {
  const oldTargets = process.env.RUNNING_REF_TARGETS;
  if (targets === undefined) delete process.env.RUNNING_REF_TARGETS;
  else process.env.RUNNING_REF_TARGETS = targets;
  let stdout = '', stderr = '';
  const probes = [];
  try {
    const status = await main(['check', '--repo', r.work, '--run', 'selected', ...args], {
      ...r, readSha: health => { probes.push(health.url); return { ok: true, sha: r.c3 }; },
      out: value => { stdout += value; }, err: value => { stderr += value; }
    });
    return { status, stdout, stderr, probes };
  } finally {
    if (oldTargets === undefined) delete process.env.RUNNING_REF_TARGETS;
    else process.env.RUNNING_REF_TARGETS = oldTargets;
  }
}

export { g, mkRepo, fakeRead, envFile, H, targetNames, publish, targetRepo, azureFile, checkCli, defaultAzure };
