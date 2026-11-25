import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { add, check, confirm, decide, find, getEntry, init, parse, readAll, recordLearnings, reindex, serialize, supersede, verifyIndex } from './knowledge.mjs';
import { setGate } from './run-state.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'thl-k-'));
const base = (over = {}) => ({ run: 'r1', title: 'Frontend tests need Node 20', topic: 'env', risk: 'low', symptom: '42 frontend tests fail on Node 26', cause: 'CI pins Node 20', fix: 'Put node@20 first on PATH', evidence: 'npm test: 42 failed on 26, all passed on 20', files: ['frontend/'], verify: 'node --version', ...over });
const asHuman = fn => { const old = process.env.THL_KNOWLEDGE_APPROVER; process.env.THL_KNOWLEDGE_APPROVER = 'human'; try { return fn(); } finally { if (old === undefined) delete process.env.THL_KNOWLEDGE_APPROVER; else process.env.THL_KNOWLEDGE_APPROVER = old; } };
const git = (repo, ...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });

test('serialize/parse round-trips quotes, newlines and unicode', () => {
  const e = { id: 'K-20261023-x', title: 'He said "hi" — ünï', topic: 'fix', status: 'proposed', risk: 'low', created: '2026-10-23', run: 'r1', author: 'a', approved_by: '', approved_at: '', last_confirmed: '', superseded_by: '', files: ['a/b'], verify: 'echo "x"', symptom: 'line1\nline2', cause: 'c', fix: 'f', evidence: 'e' };
  assert.deepEqual(parse(serialize(e)), e);
});

test('add proposes an entry that is not in the index; the id is K-date-slug and a duplicate is refused', () => {
  const repo = tmp(); init(repo);
  const e = add(repo, base(), new Date('2026-10-23T10:00:00Z'));
  assert.equal(e.id, 'K-20261023-frontend-tests-need-node-20'); assert.equal(e.status, 'proposed');
  assert.ok(!readFileSync(join(repo, 'docs/agent-knowledge/INDEX.md'), 'utf8').includes(e.id), 'proposed entries stay out of the index');
  assert.throws(() => add(repo, base(), new Date('2026-10-24T10:00:00Z')), /ENTRY_DUPLICATE/);
  assert.equal(getEntry(repo, e.id).run, 'r1');
  rmSync(repo, { recursive: true, force: true });
});

test('add refuses secrets (without echoing them), bad fields, absolute paths and an uninitialised repo', () => {
  const repo = tmp();
  assert.throws(() => add(repo, base()), /KNOWLEDGE_NOT_INITIALISED/);
  init(repo);
  const key = 'AKIA' + 'IOSFODNN7EXAMPLE';
  try { add(repo, base({ fix: `use ${key}` })); assert.fail(); } catch (e) { assert.match(e.message, /KNOWLEDGE_SECRET/); assert.ok(!e.message.includes(key)); }
  assert.throws(() => add(repo, base({ topic: 'misc' })), /topic/);
  assert.throws(() => add(repo, base({ risk: 'medium' })), /risk/);
  assert.throws(() => add(repo, base({ evidence: '  ' })), /FIELD_REQUIRED: evidence/);
  assert.throws(() => add(repo, base({ files: ['/etc/passwd'] })), /repo-relative/);
  assert.throws(() => add(repo, base({ files: ['../x'] })), /repo-relative/);
  assert.equal(readAll(repo).length, 0, 'nothing written by a refused add');
  rmSync(repo, { recursive: true, force: true });
});

test('agents cannot approve: only a human (terminal or UI) can; approval indexes the entry', () => {
  const repo = tmp(); init(repo);
  const e = add(repo, base());
  assert.throws(() => decide(repo, e.id, 'approve', { by: 'Moshe' }), /HUMAN_ONLY/);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'knowledge.mjs'), 'approve', '--repo', repo, '--id', e.id, '--by', 'Moshe'], { encoding: 'utf8', env: { ...process.env, THL_KNOWLEDGE_APPROVER: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.status, 3); assert.match(r.stderr, /HUMAN_ONLY/);
  asHuman(() => {
    assert.throws(() => decide(repo, e.id, 'approve', { by: 'claude' }), /APPROVER_REQUIRED/);
    const a = decide(repo, e.id, 'approve', { by: 'Moshe' });
    assert.equal(a.status, 'approved'); assert.equal(a.approved_by, 'Moshe');
    assert.throws(() => decide(repo, e.id, 'approve', { by: 'Moshe' }), /NOT_PROPOSED/);
  });
  assert.match(readFileSync(join(repo, 'docs/agent-knowledge/INDEX.md'), 'utf8'), new RegExp(e.id));
  assert.equal(verifyIndex(repo), true);
  assert.equal(confirm(repo, e.id, new Date('2026-11-01T00:00:00Z')).last_confirmed, '2026-11-01');
  rmSync(repo, { recursive: true, force: true });
});

test('reject keeps the entry (never deleted) and out of the index', () => {
  const repo = tmp(); init(repo);
  const e = add(repo, base());
  asHuman(() => decide(repo, e.id, 'reject', { by: 'Moshe', reason: 'not true on the Mac mini' }));
  const r = getEntry(repo, e.id);
  assert.equal(r.status, 'rejected'); assert.match(r.evidence, /Rejected: not true/);
  assert.ok(!readFileSync(join(repo, 'docs/agent-knowledge/INDEX.md'), 'utf8').includes(e.id));
  assert.throws(() => confirm(repo, e.id), /NOT_APPROVED/);
  rmSync(repo, { recursive: true, force: true });
});

test('find ranks approved entries by touched files and task words; proposed ones only with --all', () => {
  const repo = tmp(); init(repo);
  const a = add(repo, base());
  const b = add(repo, base({ title: 'Deploy QA uses aspnet 9 alpine', topic: 'deploy', files: ['Dockerfile.qa'], symptom: 'QA image differs from PRD', fix: 'build with the 9.0 alpine base', evidence: 'docker build log line 12', verify: '' }));
  assert.deepEqual(find(repo, { files: ['frontend/src/a.ts'] }), [], 'nothing approved yet');
  asHuman(() => { decide(repo, a.id, 'approve', { by: 'M' }); decide(repo, b.id, 'approve', { by: 'M' }); });
  assert.equal(find(repo, { files: ['frontend/src/a.ts'] })[0].id, a.id);
  assert.equal(find(repo, { files: ['Dockerfile.qa'], q: 'qa image' })[0].id, b.id);
  assert.equal(find(repo, { q: 'unrelated words only' }).length, 0);
  const c = add(repo, base({ title: 'Flaky render test', files: ['frontend/'] }));
  assert.ok(!find(repo, { files: ['frontend/x'] }).some(r => r.id === c.id));
  assert.ok(find(repo, { files: ['frontend/x'], all: true }).some(r => r.id === c.id));
  rmSync(repo, { recursive: true, force: true });
});

test('supersede marks the old entry and drops it from the index; the old file stays', () => {
  const repo = tmp(); init(repo);
  const o = add(repo, base()); const n = add(repo, base({ title: 'Frontend tests need Node 22 now' }));
  asHuman(() => {
    decide(repo, o.id, 'approve', { by: 'M' });
    assert.throws(() => supersede(repo, o.id, n.id, { by: 'M' }), /approve .* first/);
    decide(repo, n.id, 'approve', { by: 'M' });
    assert.equal(supersede(repo, o.id, n.id, { by: 'M' }).superseded_by, n.id);
  });
  assert.equal(getEntry(repo, o.id).status, 'superseded');
  const idx = readFileSync(join(repo, 'docs/agent-knowledge/INDEX.md'), 'utf8');
  assert.ok(!idx.includes(o.id) && idx.includes(n.id));
  rmSync(repo, { recursive: true, force: true });
});

test('check finds a forged approval, a stale index, a secret and a bad id; passes a clean base', () => {
  const repo = tmp(); init(repo);
  const e = add(repo, base());
  assert.equal(check(repo).ok, true);
  const f = join(repo, 'docs/agent-knowledge/entries', `${e.id}.md`);
  const forged = readFileSync(f, 'utf8').replace('status: "proposed"', 'status: "approved"');
  writeFileSync(f, forged);
  let r = check(repo);
  assert.ok(r.problems.some(p => /approved without approved_by/.test(p)), 'an agent-written approval is flagged');
  assert.ok(r.problems.some(p => /INDEX.md is out of date/.test(p)));
  writeFileSync(f, readFileSync(f, 'utf8').replace('Put node@20 first on PATH', `use ${'AKIA' + 'IOSFODNN7EXAMPLE'}`));
  r = check(repo);
  assert.ok(r.problems.some(p => /secret/.test(p)));
  assert.ok(!JSON.stringify(r).includes('AKIAIOSFODNN7EXAMPLE'));
  writeFileSync(join(repo, 'docs/agent-knowledge/entries/wrong-name.md'), serialize({ ...e, id: 'K-20261023-other' }));
  assert.ok(check(repo).problems.some(p => /id does not match/.test(p)));
  rmSync(repo, { recursive: true, force: true });
});

test('check --base: an approved entry cannot be rewritten or deleted, only confirmed or superseded', () => {
  const repo = tmp(); git(repo, 'init', '-q'); init(repo);
  const e = add(repo, base()); asHuman(() => decide(repo, e.id, 'approve', { by: 'M' }));
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'k');
  assert.equal(check(repo, { base: 'HEAD' }).ok, true);
  confirm(repo, e.id, new Date('2026-12-01T00:00:00Z'));
  assert.equal(check(repo, { base: 'HEAD' }).ok, true, 'confirming is allowed');
  const f = join(repo, 'docs/agent-knowledge/entries', `${e.id}.md`);
  writeFileSync(f, readFileSync(f, 'utf8').replace('Put node@20 first on PATH', 'Put node@26 first on PATH'));
  assert.ok(check(repo, { base: 'HEAD' }).problems.some(p => /approved entry changed fix/.test(p)));
  git(repo, 'checkout', '--', '.'); unlinkSync(f); reindex(repo);
  assert.ok(check(repo, { base: 'HEAD' }).problems.some(p => /deleted/.test(p)));
  rmSync(repo, { recursive: true, force: true });
});

test('the index is capped at 150 lines', () => {
  const repo = tmp(); init(repo);
  asHuman(() => { for (let i = 0; i < 150; i++) { const e = add(repo, base({ title: `Fact number ${i}`, files: [`d${i}/`] })); try { decide(repo, e.id, 'approve', { by: 'M' }); } catch (err) { assert.match(err.message, /INDEX_TOO_LARGE/); return; } } assert.fail('expected the index cap to trip'); });
  rmSync(repo, { recursive: true, force: true });
});

test('learnings gate: a knowledge repo needs entries from the run or a justified "nothing new" before learnings can pass', () => {
  const repo = tmp(); init(repo);
  assert.throws(() => recordLearnings(repo, 'r1', {}), /LEARNINGS_NOT_RECORDED/);
  assert.throws(() => recordLearnings(repo, 'r1', { none: 'nothing' }), /LEARNINGS_NOT_RECORDED/);
  assert.throws(() => setGate(repo, 'r1', { gate: 'learnings', status: 'passed' }), /LEARNINGS_NOT_RECORDED/);
  recordLearnings(repo, 'r1', { none: 'The run only renamed a label; no new fact about the repo.' });
  assert.equal(setGate(repo, 'r1', { gate: 'learnings', status: 'passed' }).gates.learnings.status, 'passed');
  const e = add(repo, base({ run: 'r2' }));
  assert.deepEqual(recordLearnings(repo, 'r2', {}).entries, [e.id]);
  rmSync(repo, { recursive: true, force: true });
});

test('a repo without docs/agent-knowledge keeps the old learnings behaviour', () => {
  const repo = tmp();
  assert.equal(setGate(repo, 'r1', { gate: 'learnings', status: 'passed' }).gates.learnings.status, 'passed');
  assert.equal(check(repo).enabled, false);
  rmSync(repo, { recursive: true, force: true });
});
