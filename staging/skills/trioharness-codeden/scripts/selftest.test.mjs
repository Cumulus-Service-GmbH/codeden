import test from 'node:test';
import assert from 'node:assert/strict';
import { runSelftest } from './selftest.mjs';

test('selftest: the dress rehearsal passes on this machine (macOS-only checks are skipped elsewhere)', () => {
  const r = runSelftest();
  const bad = r.results.filter(x => x.status === 'FAIL');
  assert.deepEqual(bad, [], JSON.stringify(bad));
  assert.ok(r.passed >= 10, `only ${r.passed} checks passed`);
});
