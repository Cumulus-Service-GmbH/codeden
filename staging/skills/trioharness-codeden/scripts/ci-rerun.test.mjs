import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./ci-rerun.mjs', import.meta.url));

// A stub gh: `run list` prints the runs, `run view <id> --json jobs` prints jobs[id] (no file: no job metadata).
function stubGh(t, runs, jobs = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-rerun-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'gh.log');
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(runs));
  for (const [id, names] of Object.entries(jobs)) writeFileSync(join(dir, `jobs-${id}.json`), JSON.stringify({ jobs: names.map(j => typeof j === 'object' && j ? j : { name: j, status: 'completed', conclusion: 'failure' }) }));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  "run list") cat "${join(dir, 'runs.json')}" ;;\n  "run view") cat "${dir}/jobs-$3.json" 2>/dev/null || echo '{}' ;;\n  "pr view") echo abc123def456 ;;\nesac\n`, { mode: 0o755 });
  const call = (...args) => spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` } });
  const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n'); } catch { return []; } };
  return { call, calls };
}
const reruns = gh => gh.calls().filter(line => line.startsWith('run rerun'));
const ci = (id, extra = {}) => ({ databaseId: id, name: 'CI', workflowName: 'CI', status: 'completed', conclusion: 'failure', ...extra });

test('reruns only failed runs positively identified as CI: named workflow, every job named', t => {
  const gh = stubGh(t, [
    ci(1), ci(2, { name: 'Lint', conclusion: 'success' }), ci(3, { name: 'E2E', conclusion: 'timed_out' }),
    ci(4, { name: 'Ship', workflowName: 'Ship' }), ci(5), ci(6, { name: 'Ship' }), ci(7),
  ], { 1: ['test'], 3: ['e2e'], 5: ['test', 'deploy-prod'], 6: ['test', 'ship'] });
  const r = gh.call('--pr', '7', '--workflow', 'CI', '--job', 'test', '--job', 'e2e');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(reruns(gh), ['run rerun 1 --failed', 'run rerun 3 --failed']);
  assert.match(r.stdout, /SKIPPED 4 Ship \(failure\): workflow not named with --workflow/);
  assert.match(r.stdout, /SKIPPED 5 CI \(failure\): deploy or release job "deploy-prod" is an owner gate/);
  assert.match(r.stdout, /SKIPPED 6 Ship \(failure\): job "ship" not named with --job/);
  assert.match(r.stdout, /SKIPPED 7 CI \(failure\): job list unknown/);
  assert.ok(gh.calls().some(line => line.startsWith('run list --commit abc123def456')));
});

test('needs --workflow and --job, waits while a run is in progress and never reruns a whole workflow', t => {
  const gh = stubGh(t, [ci(1), ci(2, { name: 'E2E', status: 'in_progress', conclusion: '' })], { 1: ['test'] });
  for (const args of [['--sha', 'abc'], ['--sha', 'abc', '--workflow', 'CI']]) {
    const unnamed = gh.call(...args);
    assert.equal(unnamed.status, 2);
    assert.match(unnamed.stderr, /name the CI workflow\(s\) and their jobs to rerun with --workflow <name> and --job <name>/);
  }
  const r = gh.call('--sha', 'abc', '--workflow', 'CI', '--job', 'test');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /CI_PENDING abc: E2E \(in_progress\)/);
  assert.deepEqual(reruns(gh), []);
});

test('dry run, green commits and commits with only reserved failures rerun nothing', t => {
  const gh = stubGh(t, [ci(1)], { 1: ['test'] });
  assert.match(gh.call('--sha', 'abc', '--workflow', 'CI', '--job', 'test', '--dry-run').stdout, /WOULD_RERUN --failed 1 CI/);
  assert.deepEqual(reruns(gh), []);
  const green = stubGh(t, [ci(1, { conclusion: 'success' })]);
  assert.match(green.call('--sha', 'abc', '--workflow', 'CI', '--job', 'test').stdout, /CI_NOTHING_TO_RERUN abc: 1 run\(s\), 0 failed run\(s\) skipped, none eligible/);
  const reserved = stubGh(t, [ci(9, { name: 'Release', workflowName: 'Release' })], { 9: ['build'] });
  const out = reserved.call('--sha', 'abc', '--workflow', 'Release', '--job', 'build').stdout;
  assert.match(out, /SKIPPED 9 Release \(failure\): deploy or release job "Release" is an owner gate/);
  assert.match(out, /CI_NOTHING_TO_RERUN abc: 1 run\(s\), 1 failed run\(s\) skipped, none eligible for rerun/);
  assert.deepEqual(reruns(reserved), []);
});

test('refuses when the run list may be truncated', t => {
  const gh = stubGh(t, Array.from({ length: 1000 }, (_, i) => ci(i)));
  const r = gh.call('--sha', 'abc', '--workflow', 'CI', '--job', 'test');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /may be incomplete/);
  assert.deepEqual(reruns(gh), []);
});

test('an option never doubles as a value, and unnamed or empty job names never qualify', t => {
  const gh = stubGh(t, [ci(1), ci(2)], { 1: ['test'], 2: ['test', ''] });
  const r = gh.call('--sha', 'abc', '--workflow', 'CI', '--job', 'test', '--job', '--dry-run');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad argument --job/);
  assert.deepEqual(reruns(gh), []);
  const ok = gh.call('--sha', 'abc', '--workflow', 'CI', '--job', 'test', '--dry-run');
  assert.match(ok.stdout, /SKIPPED 2 CI \(failure\): job "" not named with --job/);
  assert.match(ok.stdout, /WOULD_RERUN --failed 1 CI/);
});

test('a run with a skipped or unfinished dependent job is never rerun', t => {
  const gh = stubGh(t, [ci(1), ci(2)], {
    1: ['test', { name: 'e2e', status: 'completed', conclusion: 'skipped' }],
    2: ['test', { name: 'e2e', status: 'queued', conclusion: '' }],
  });
  const r = gh.call('--sha', 'abc', '--workflow', 'CI', '--job', 'test', '--job', 'e2e');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SKIPPED 1 CI \(failure\): dependent jobs not materialized/);
  assert.match(r.stdout, /SKIPPED 2 CI \(failure\): dependent jobs not materialized/);
  assert.deepEqual(reruns(gh), []);
});
