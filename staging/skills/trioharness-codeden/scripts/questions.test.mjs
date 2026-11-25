import test from 'node:test';
import assert from 'node:assert/strict';
import { localRepo } from './test-local-repo.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { askCard, answerCard, cancelCard, hostCard, openSets, openQuestionsReason, renderText, validateCard, setAutopilot, promoteDeferred } from './questions.mjs';
import { setGate, countDispatch, registerWorker, stalledRuns, readState } from './run-state.mjs';
// Hermetic: the user's own standing orders must never answer a test card.
process.env.TRIOHARNESS_HOME = process.env.TRIOHARNESS_HOME_FOR_TESTS || '/nonexistent-trioharness-home';

const ANS = { via: 'card', quote: 'selected in the card' };
const tmp = () => mkdtempSync(join(tmpdir(), 'thl-q-'));
const card = (over = {}) => ({ questions: [{ id: 'q1', header: 'Scope', question: 'Which scope should the change cover?', why: 'Smallest change that meets the criteria', options: [
  { id: 'a', label: 'Backend only', description: 'Touches the API and tests, no UI' },
  { id: 'b', label: 'Backend and UI', description: 'Also changes the settings page' }], recommended: 'a', ...over }] });

test('unchecked is the only null recommendation exception, with no recommendation badges in either renderer', () => {
  const c = card({ recommended: null, unchecked: true, why: 'Check unavailable; full reasons: /tmp/card.reasons.json' });
  assert.equal(validateCard(c), true);
  assert.throws(() => validateCard(card({ recommended: null })), /recommended/);
  assert.throws(() => validateCard(card({ unchecked: true })), /unchecked/);
  assert.throws(() => validateCard(card({ unchecked: false, recommended: null })), /recommended/);
  assert.throws(() => validateCard(card({ unchecked: true, recommended: null, why: 'x'.repeat(301) })), /why/);
  const host = hostCard(c).questions[0], text = renderText('Q-1', c);
  assert.match(host.question, /Not recommended \(unchecked\): Check unavailable/);
  assert.match(text, /Not recommended \(unchecked\): Check unavailable/);
  assert.ok(!JSON.stringify(host).includes('(Recommended)')); assert.ok(!text.includes('Recommended because'));
  assert.deepEqual(host.options.map(o => o.label), c.questions[0].options.map(o => o.label));
});

test('checked receipt is shown beside the recommended option in both renderers', () => {
  const c = card({ receipt: 'check-1234567890abcdef-2026-11-11T12:00:00.000Z' });
  assert.ok(hostCard(c).questions[0].options[0].description.includes(c.questions[0].receipt));
  assert.ok(renderText('Q-1', c).includes(c.questions[0].receipt));
  assert.throws(() => validateCard(card({ receipt: 'sk-' + 'x'.repeat(32) })), /secret/);
});

test('unchecked questions cannot also carry a receipt', () => {
  assert.throws(() => validateCard(card({
    recommended: null, unchecked: true,
    receipt: 'check-1234567890abcdef-2026-11-11T12:00:00.000Z',
    why: 'Check unavailable; full reasons: /tmp/card.reasons.json'
  })), /unchecked.*receipt/);
});

test('unchecked multiSelect stays open interactively and unattended; autopilot defers and promotes it', () => {
  for (const mode of ['interactive', 'unattended', 'autopilot']) {
    const repo = tmp();
    try {
      const c = card({ multiSelect: true, recommended: null, unchecked: true, why: 'Not confirmed; full reasons: /tmp/check.reasons.json' });
      if (mode === 'unattended') { mkdirSync(join(repo, '.trioharness-direct'), { recursive: true }); writeFileSync(join(repo, '.trioharness-direct', 'UNATTENDED'), ''); }
      if (mode === 'autopilot') setAutopilot(repo, 'r1', true, { quote: 'Run on autopilot' });
      const rec = askCard(repo, 'r1', c);
      assert.equal(rec.status, mode === 'autopilot' ? 'deferred' : 'open');
      assert.equal(rec.answers, undefined);
      if (mode === 'autopilot') {
        const promoted = promoteDeferred(repo, 'r1');
        assert.equal(promoted.status, 'open'); assert.equal(promoted.card.questions[0].recommended, null);
        assert.match(promoted.hostCard.questions[0].question, /Not recommended \(unchecked\)/);
        answerCard(repo, 'r1', promoted.id, { Q1_q1: ['b'] }, ANS);
      } else answerCard(repo, 'r1', rec.id, { q1: ['b'] }, ANS);
      assert.equal(openSets(repo, 'r1').length, 0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test('a valid card passes and the host card puts the recommended option first, marked, with no free-text field', () => {
  const c = card({ recommended: 'b' });
  assert.equal(validateCard(c), true);
  const h = hostCard(c).questions[0];
  assert.equal(h.allowFreeText, false);
  assert.match(h.options[0].label, /Backend and UI \(Recommended\)$/);
  assert.match(h.options[0].description, /Why: Smallest change/);
  assert.equal(h.options[1].label, 'Backend only');
});

test('invalid cards are refused with every problem named', () => {
  const bad = (over, re) => assert.throws(() => validateCard(card(over)), re);
  bad({ recommended: undefined }, /recommended option required/);
  bad({ recommended: ['a', 'b'] }, /exactly one recommended/);
  bad({ recommended: 'zzz' }, /recommended must name option ids/);
  bad({ question: 'Which scope' }, /ending in "\?"/);
  bad({ header: 'A header that is far too long' }, /header 1-12/);
  bad({ why: '' }, /why/);
  bad({ options: [{ id: 'a', label: 'Only one', description: 'one option' }] }, /2 to 4 options/);
  bad({ options: ['a', 'b', 'c', 'd', 'e'].map(i => ({ id: i, label: i.toUpperCase(), description: 'an option' })) }, /2 to 4 options/);
  bad({ options: [{ id: 'a', label: 'Other', description: 'type your own' }, { id: 'b', label: 'Fine', description: 'a real option' }] }, /free-text style option/);
  bad({ options: [{ id: 'a', label: 'Same', description: 'one two' }, { id: 'a', label: 'Same2', description: 'one two' }] }, /duplicate id/);
  assert.throws(() => validateCard({ questions: [] }), /1 to 4 questions/);
  assert.throws(() => validateCard({ questions: [card().questions[0], { ...card().questions[0] }] }), /q\[1\]: duplicate id/);
});

test('a card whose text carries a secret is refused without echoing it', () => {
  const key = 'AKIA' + 'IOSFODNN7EXAMPLE';
  try { validateCard(card({ question: `Is ${key} the right key?` })); assert.fail('should throw'); } catch (e) { assert.match(e.message, /secret/); assert.ok(!e.message.includes(key)); }
});

test('multiSelect: several recommended allowed, but not every option', () => {
  const opts = ['a', 'b', 'c'].map(i => ({ id: i, label: `Option ${i}`, description: `does ${i}` }));
  assert.equal(validateCard(card({ multiSelect: true, options: opts, recommended: ['a', 'b'] })), true);
  assert.throws(() => validateCard(card({ multiSelect: true, options: opts, recommended: ['a', 'b', 'c'] })), /every option/);
});

test('an open card stops the run: no gate advance, no dispatch, no worker, not stalled; blocked is still recordable', () => {
  const repo = localRepo('thl-q-');
  setGate(repo, 'r1', { gate: 'base', status: 'passed', task: 't' });
  const rec = askCard(repo, 'r1', card());
  assert.equal(rec.id, 'Q-1'); assert.equal(rec.status, 'open');
  assert.match(openQuestionsReason(repo, 'r1'), /Q-1/);
  assert.throws(() => setGate(repo, 'r1', { gate: 'route', status: 'passed' }), /QUESTIONS_OPEN/);
  assert.throws(() => setGate(repo, 'r1', { gate: 'route', status: 'in_progress' }), /QUESTIONS_OPEN/);
  assert.throws(() => countDispatch(repo, 'r1', 'writer'), /QUESTIONS_OPEN/);
  assert.throws(() => registerWorker(repo, 'r1', { id: 'w1', role: 'writer' }), /QUESTIONS_OPEN/);
  assert.equal(setGate(repo, 'r1', { gate: 'route', status: 'blocked', next: 'awaiting Q-1' }).gates.route.status, 'blocked');
  assert.deepEqual(stalledRuns(repo, { minutes: 0, now: Date.now() + 3 * 3600000 }), []);
  assert.throws(() => askCard(repo, 'r1', card()), /QUESTIONS_ALREADY_OPEN/);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'questions.mjs'), 'check', '--repo', repo, '--run', 'r1'], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /STOP/);
  rmSync(repo, { recursive: true, force: true });
});

test('only the card\'s own option ids answer it; a partial or free-text reply leaves it open', () => {
  const repo = localRepo('thl-q-');
  askCard(repo, 'r1', { questions: [card().questions[0], { ...card().questions[0], id: 'q2', multiSelect: true, options: ['x', 'y', 'z'].map(i => ({ id: i, label: `Pick ${i}`, description: `choose ${i}` })), recommended: ['x'] }] });
  assert.throws(() => answerCard(repo, 'r1', 'Q-1', { q1: 'a' }, ANS), /ANSWER_MISSING: q2/);
  assert.throws(() => answerCard(repo, 'r1', 'Q-1', { q1: 'do whatever you think', q2: ['x'] }, ANS), /ANSWER_INVALID/);
  assert.throws(() => answerCard(repo, 'r1', 'Q-1', { q1: ['a', 'b'], q2: ['x'] }, ANS), /exactly one/);
  assert.throws(() => answerCard(repo, 'r1', 'Q-1', { q1: 'a', q2: [] }, ANS), /at least one/);
  assert.throws(() => answerCard(repo, 'r1', 'Q-1', { q1: 'a', q2: ['x'], q9: 'a' }, ANS), /UNKNOWN_QUESTION/);
  assert.equal(openSets(repo, 'r1').length, 1, 'still open after every refused answer');
  const done = answerCard(repo, 'r1', 'Q-1', { q1: 'b', q2: ['x', 'z'] }, ANS);
  assert.equal(done.status, 'answered'); assert.deepEqual(done.answers, { q1: 'b', q2: ['x', 'z'] });
  assert.equal(openQuestionsReason(repo, 'r1'), null);
  assert.equal(setGate(repo, 'r1', { gate: 'base', status: 'passed' }).gates.base.status, 'passed');
  assert.throws(() => answerCard(repo, 'r1', 'Q-1', { q1: 'a', q2: ['x'] }, ANS), /SET_NOT_OPEN/);
  assert.equal(askCard(repo, 'r1', card()).id, 'Q-2');
  rmSync(repo, { recursive: true, force: true });
});

test('an unreadable card record counts as open, never as answered', () => {
  const repo = tmp();
  const dir = join(repo, '.trioharness-direct', 'runs', 'r1', 'questions'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Q-1.json'), '{ not json');
  assert.match(openQuestionsReason(repo, 'r1'), /Q-1/);
  rmSync(repo, { recursive: true, force: true });
});

test('cancel needs a reason and frees the run; render gives the numbered fallback with the recommendation', () => {
  const repo = tmp();
  const rec = askCard(repo, 'r1', card());
  const text = renderText(rec.id, rec.card);
  assert.match(text, /1\. Backend only {2}\(Recommended\)/); assert.match(text, /Waiting for your answer/);
  assert.throws(() => cancelCard(repo, 'r1', 'Q-1', 'x', { by: 'user' }), /REASON_REQUIRED/);
  assert.equal(cancelCard(repo, 'r1', 'Q-1', 'the user withdrew the task', { by: 'user' }).status, 'cancelled');
  assert.equal(openQuestionsReason(repo, 'r1'), null);
  assert.equal(readState(repo, 'r1'), null);
  rmSync(repo, { recursive: true, force: true });
});

test('an answer or a cancel without provenance is refused and the card stays open', () => {
  const repo = tmp();
  askCard(repo, 'r1', card());
  assert.throws(() => answerCard(repo, 'r1', 'Q-1', { q1: 'a' }), /ANSWER_PROVENANCE/);
  assert.throws(() => answerCard(repo, 'r1', 'Q-1', { q1: 'a' }, { via: 'card' }), /ANSWER_PROVENANCE/);
  assert.throws(() => cancelCard(repo, 'r1', 'Q-1', 'the user withdrew the task'), /CANCEL_PROVENANCE/);
  assert.equal(openSets(repo, 'r1').length, 1);
  const done = answerCard(repo, 'r1', 'Q-1', { q1: 'a' }, { via: 'numbered-reply', quote: '1' });
  assert.equal(done.answeredVia, 'numbered-reply'); assert.equal(done.answerQuote, '1');
  rmSync(repo, { recursive: true, force: true });
});

test('unattended is set only by the marker file, never by the card or the environment; then the recommended option is assumed and nothing stops', () => {
  const repo = tmp();
  process.env.THL_UNATTENDED = '1'; // an env var must not be able to switch the stop off
  assert.equal(askCard(repo, 'r1', card()).status, 'open');
  cancelCard(repo, 'r1', 'Q-1', 'testing the marker file', { by: 'architect' });
  delete process.env.THL_UNATTENDED;
  mkdirSync(join(repo, '.trioharness-direct', 'runs', 'r1'), { recursive: true });
  writeFileSync(join(repo, '.trioharness-direct', 'runs', 'r1', 'UNATTENDED'), '');
  const rec = askCard(repo, 'r1', card());
  assert.equal(rec.status, 'assumed'); assert.deepEqual(rec.answers, { q1: 'a' });
  assert.equal(openQuestionsReason(repo, 'r1'), null);
  rmSync(repo, { recursive: true, force: true });
});

test('ask refuses while a job is running: a card ends the turn, a running job forbids ending it', () => {
  const repo = tmp();
  const jobs = join(repo, '.trioharness-direct', 'runs', 'r1', 'jobs'); mkdirSync(jobs, { recursive: true });
  writeFileSync(join(jobs, 'build.json'), JSON.stringify({ name: 'build', run: 'r1', cmd: 'sleep 99', timeoutSec: 600, startedAt: new Date().toISOString(), supervisorPid: process.pid, status: 'running' }));
  writeFileSync(join(repo, 'card.json'), JSON.stringify(card()));
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'questions.mjs'), 'ask', '--repo', repo, '--run', 'r1', '--file', join(repo, 'card.json')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /JOBS_OPEN/);
  assert.equal(openSets(repo, 'r1').length, 0);
  rmSync(repo, { recursive: true, force: true });
});

for (const status of ['running', 'queued', 'lost', 'passed']) test(`approval entry points settle ${status} jobs before opening a card`, t => {
  const repo = tmp(); t.after(() => rmSync(repo, { recursive: true, force: true }));
  setAutopilot(repo, 'r1', true, { quote: 'Run this task on autopilot' });
  const gate = card({ kind: 'gate', question: 'May we merge the change?' });
  const deferred = askCard(repo, 'r1', gate);
  const jobs = join(repo, '.trioharness-direct/runs/r1/jobs'); mkdirSync(jobs, { recursive: true });
  writeFileSync(join(jobs, 'work.json'), JSON.stringify({ name: 'work', status, supervisorPid: process.pid, startedAt: new Date().toISOString(), timeoutSec: 600 }));
  if (status === 'passed') {
    const promoted = promoteDeferred(repo, 'r1');
    assert.equal(promoted.status, 'open'); assert.ok(promoted.hostCard);
    assert.deepEqual(promoted.merges, [{ set: deferred.id, questions: [['q1', 'Q1_q1']] }]);
    cancelCard(repo, 'r1', promoted.id, 'approval is complete', { by: 'architect' });
    setAutopilot(repo, 'r1', false);
    assert.equal(askCard(repo, 'r1', card()).status, 'open');
  } else {
    assert.throws(() => askCard(repo, 'r1', card()), /JOBS_OPEN/);
    assert.throws(() => promoteDeferred(repo, 'r1'), /JOBS_OPEN/);
    assert.equal(openSets(repo, 'r1').length, 0);
    const emptyJobs = join(repo, '.trioharness-direct/runs/empty-run/jobs'); mkdirSync(emptyJobs, { recursive: true });
    writeFileSync(join(emptyJobs, 'work.json'), JSON.stringify({ name: 'work', status: 'lost' }));
    assert.equal(promoteDeferred(repo, 'empty-run'), null, 'no deferred cards remains a no-op even with open jobs');
  }
});
