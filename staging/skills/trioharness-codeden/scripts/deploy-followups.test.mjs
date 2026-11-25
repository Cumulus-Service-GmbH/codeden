import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HISTORY_WINDOW, planRevisionCleanup, runCli } from './deploy.mjs';

test('verified full switches notify the issue hook with the revision when applicable', async t => {
  const ledger = mkdtempSync(join(tmpdir(), 'deploy-followups-'));
  t.after(() => rmSync(ledger, { recursive: true, force: true }));
  const dir = join(ledger, '.trioharness-direct', 'runs', 'switch-test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), '{}');
  const sha = 'a'.repeat(40), revision = 'app--candidate';
  for (const [flags, result, expected] of [
    [['--switch-traffic', revision], { switched: true, plan: { type: 'containerapp', destination: revision, sha, percent: 100 } }, 1],
    [['--switch-traffic', revision], { switched: true, plan: { type: 'containerapp', destination: revision, sha, percent: 75 } }, 0],
    [['--action', 'switch'], { switched: true, revision, sha, percent: 100 }, 1],
    [['--switch-traffic', 'staging'], { switched: true, slot: 'staging', plan: { type: 'webapp', destination: 'staging', sha, percent: 100 } }, 1],
    [['--action', 'recover'], { switched: true, revision, sha, percent: 100 }, 1],
    [['--action', 'recover'], { recovered: true, recoveryStep: 'record-rollback', rolledBack: true, plan: { sha, revision } }, 1],
    [['--action', 'rollback'], { rolledBack: true, plan: { sha, revision } }, 1],
    [['--action', 'switch'], { dryRun: true, plan: { revision, sha, percent: 100 } }, 0],
  ]) {
    for (const target of ['qa', 'prod']) {
      const calls = [];
      const code = await runCli(['--repo', ledger, '--ledger', ledger, '--key', 'work', '--target', target, '--run', 'switch-test', ...flags], {
        run: async () => result, stdout: () => {}, stderr: () => {},
        loadIssues: async () => ({ transitionForEvent: async (event, opts) => calls.push([event, opts]) }),
      });
      assert.equal(code, 0);
      assert.equal(calls.length, expected);
      if (expected) {
        const [[event, opts]] = calls;
        assert.equal(event, result.rolledBack ? 'rollback' : 'deployed-' + target);
        assert.equal(opts.revision, result.slot ? undefined : revision);
        if (result.rolledBack) {
          assert.equal(opts.toRevision, revision);
          assert.equal(opts.toSha, sha);
        }
        assert.equal(opts.sha, sha);
        assert.equal(opts.ledger, ledger);
        assert.equal(opts.key, 'work');
      }
    }
  }
});

test('cleanup retires an old verified stage only if it never served', () => {
  const staged = { revision: 'candidate', previousRevision: 'live', staged: true, verified: true, at: '2026-04-01' };
  const padding = Array.from({ length: HISTORY_WINDOW }, (_, i) =>
    ({ revision: 'other-' + i, previousRevision: 'live', at: '2026-04-10', verified: true }));
  const plan = (entries, overrides) => planRevisionCleanup({
    revisions: [{ name: 'candidate', active: true, created: '2026-03-31', weight: 0 }],
    trafficEntries: [{ revisionName: 'live', weight: 100 }], serving: 'live', latest: 'latest',
    history: [...entries, ...padding], now: Date.parse('2026-04-20'),
    cfg: { quietDays: 7 }, maxInactive: 100, ...overrides,
  });
  assert.deepEqual(plan([staged]).deactivate, ['candidate']);
  assert.deepEqual(plan([{ ...staged, at: '2026-04-18' }]).kept, [{ name: 'candidate', reason: 'young-retired' }]);
  for (const entry of [
    { ...staged, verified: false },
    { ...staged, switched: true, percent: 50 },
    { ...staged, staged: false, switched: true, percent: 50 },
    { revision: 'other', previousRevision: 'candidate', staged: true, verified: true, at: staged.at },
  ]) assert.deepEqual(plan([staged, entry]).deactivate, []);
  for (const overrides of [{ serving: 'candidate' }, { latest: 'candidate' }, { protectedNames: ['candidate'] },
    { previousRevision: 'candidate' }, { history: [staged] }]) {
    assert.deepEqual(plan([staged], overrides).deactivate, []);
  }
});
