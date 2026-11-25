import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFailure, ISSUE_EVENTS, FAILURE_CATEGORIES } from './issues-failure-log.mjs';

function fixture({ state = true } = {}) {
  const ledger = mkdtempSync(join(tmpdir(), 's6-failrec-'));
  const run = 's6-failrec';
  const dir = join(ledger, '.trioharness-direct', 'runs', run);
  if (state) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'state.json'), '{}'); }
  return { ledger, run, dir, file: join(dir, 'issues-failures.jsonl'), event: 'merged', category: 'IMPORT_FAILED' };
}
function lines(t) {
  assert.ok(existsSync(t.file), 'a failure record was appended');
  return readFileSync(t.file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
function calibratedFixture() {
  const t = fixture(); appendFailure(t); assert.equal(lines(t).length, 1); return t;
}

test('hf5b1e-s6-d-failrec-10 only fixed allowlisted fields and node imports', () => {
  const t = fixture(); let errorReads = 0;
  const input = { ...t, message: ['pass', 'word=ab1'].join(''), sha: 'a'.repeat(40), key: 'A' };
  Object.defineProperty(input, 'error', { get() { errorReads++; throw new Error('must not read'); } });
  appendFailure(input);
  const [line] = lines(t);
  assert.deepEqual(Object.keys(line).sort(), ['v', 'kind', 'ts', 'run', 'event', 'category', 'key'].sort());
  assert.equal(line.v, 1); assert.equal(line.kind, 'failure'); assert.equal(line.run, t.run);
  assert.equal(line.event, 'merged'); assert.equal(line.category, 'IMPORT_FAILED'); assert.equal(line.key, 'A');
  assert.equal(new Date(line.ts).toISOString(), line.ts); assert.equal(errorReads, 0);
  assert.doesNotMatch(JSON.stringify(line), /password|Error/);
  const source = readFileSync(new URL('./issues-failure-log.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(imports.every(name => name.startsWith('node:')));
  assert.doesNotMatch(source, /import\s*\(/);
});

test('hf5b1e-s6-d-failrec-11 categories use enum or OTHER and invalid events are refused', () => {
  const t = fixture();
  for (const category of [...FAILURE_CATEGORIES, 'unknown', undefined, null, { code: 'private' }]) appendFailure({ ...t, category });
  const recorded = lines(t);
  assert.deepEqual(recorded.map(l => l.category), [...FAILURE_CATEGORIES, 'OTHER', 'OTHER', 'OTHER', 'OTHER']);
  assert.deepEqual(ISSUE_EVENTS, ['writer-start', 'pr-open', 'merged', 'deployed-qa', 'deployed-prod', 'rollback', 'installed']);
  assert.deepEqual(FAILURE_CATEGORIES, ['IMPORT_FAILED', 'RUNNER_FAILED', 'GH_UNAVAILABLE', 'IDENTITY_UNVERIFIED', 'OTHER']);
  for (const event of ISSUE_EVENTS) appendFailure({ ...t, event });
  const before = readFileSync(t.file); appendFailure({ ...t, event: 'unknown' });
  assert.deepEqual(readFileSync(t.file), before);
});

test('hf5b1e-s6-d-failrec-12 invalid keys are omitted and valid boundary keys retained', () => {
  const t = fixture();
  for (const key of ['A', 'a'.repeat(40), 'a.b_C-1', '', 'a'.repeat(41), '../bad', 'bad key', 12, null]) appendFailure({ ...t, key });
  const recorded = lines(t);
  assert.deepEqual(recorded.slice(0, 3).map(l => l.key), ['A', 'a'.repeat(40), 'a.b_C-1']);
  assert.ok(recorded.slice(3).every(l => !Object.hasOwn(l, 'key')));
});

test('hf5b1e-s6-d-failrec-13 no state means no write and invalid run ids are refused', () => {
  calibratedFixture();
  const t = fixture({ state: false }); appendFailure(t); assert.equal(existsSync(t.dir), false);
  for (const run of ['', '.', '..', '../escape', '/absolute', undefined]) {
    const valid = fixture(); appendFailure({ ...valid, run }); assert.equal(existsSync(valid.file), false);
  }
});

test('hf5b1e-s6-d-failrec-14 append preserves all existing bytes', () => {
  const t = fixture(); const prefix = Buffer.from('{"older":"retained byte for byte"}\n'); writeFileSync(t.file, prefix);
  appendFailure(t); appendFailure({ ...t, event: 'rollback', category: 'OTHER' });
  const after = readFileSync(t.file);
  assert.equal(after.subarray(prefix.length).toString().trim().split('\n').length, 2);
  assert.deepEqual(after.subarray(0, prefix.length), prefix);
  assert.deepEqual(lines(t).slice(1).map(l => l.event), ['merged', 'rollback']);
  const source = readFileSync(new URL('./issues-failure-log.mjs', import.meta.url), 'utf8');
  assert.match(source, /flag:\s*'a'/);
  assert.doesNotMatch(source, /\b(?:writeFileSync|renameSync|unlinkSync|rmSync|truncateSync)\b/);
});

test('hf5b1e-s6-d-failrec-15 filesystem write errors are swallowed', () => {
  calibratedFixture();
  const t = fixture(); mkdirSync(t.file); const marker = join(t.file, 'keep'); writeFileSync(marker, 'unchanged');
  assert.doesNotThrow(() => appendFailure(t)); assert.equal(readFileSync(marker, 'utf8'), 'unchanged');
});
