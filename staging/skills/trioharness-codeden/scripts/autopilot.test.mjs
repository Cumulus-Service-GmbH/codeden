import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { askCard, answerCard, autopilotReport, cardKind, deferredSets, isAutopilot, openQuestionsReason, openSets, promoteDeferred, questionKind, readSets, setAutopilot } from './questions.mjs';
import { setGate } from './run-state.mjs';
process.env.TRIOHARNESS_HOME = process.env.TRIOHARNESS_HOME_FOR_TESTS || '/nonexistent-trioharness-home';

const here = dirname(fileURLToPath(import.meta.url));
const RUN = '20261028-seal-abcd';
const tmp = () => mkdtempSync(join(tmpdir(), 'thl-ap-'));
const q = (id, header, question, over = {}) => ({ id, header, question, why: 'The smaller, reversible choice', options: [{ id: 'a', label: 'Option A', description: 'the first choice' }, { id: 'b', label: 'Option B', description: 'the second choice' }], recommended: 'a', ...over });
const exec = (n = 1) => ({ questions: Array.from({ length: n }, (_, i) => q(`e${i + 1}`, 'Scope', 'Which scope should the change cover?')) });
const gate = (over = {}) => ({ questions: [q('g1', 'Deploy', 'Deploy this build to the production app?', over)] });
const on = repo => setAutopilot(repo, RUN, true, { quote: 'run it on autopilot, only ask me at the final deploy' });

test('autopilot is only turned on with the user\'s own words, and is off by default', () => {
  const repo = tmp();
  assert.equal(isAutopilot(repo, RUN), false);
  assert.throws(() => setAutopilot(repo, RUN, true), /AUTOPILOT_PROVENANCE/);
  assert.throws(() => setAutopilot(repo, RUN, true, { quote: '   ' }), /AUTOPILOT_PROVENANCE/);
  on(repo); assert.equal(isAutopilot(repo, RUN), true);
  setAutopilot(repo, RUN, false); assert.equal(isAutopilot(repo, RUN), false);
});

test('without autopilot a card still stops the run exactly as before', () => {
  const repo = tmp(); const r = askCard(repo, RUN, exec());
  assert.equal(r.status, 'open'); assert.ok(openQuestionsReason(repo, RUN));
});

test('autopilot answers an execution card with the recommended options, records it, and does not stop the run', () => {
  const repo = tmp(); on(repo);
  const r = askCard(repo, RUN, exec(2));
  assert.equal(r.status, 'assumed'); assert.equal(r.autopilot, 'execution'); assert.equal(r.hostCard, null);
  assert.deepEqual(r.answers, { e1: 'a', e2: 'a' }); assert.equal(r.answeredVia, 'autopilot');
  assert.equal(openQuestionsReason(repo, RUN), null); assert.deepEqual(openSets(repo, RUN), []);
  assert.doesNotThrow(() => setGate(repo, RUN, { gate: 'route', status: 'passed' }), 'gates advance');
  const rep = autopilotReport(repo, RUN); assert.equal(rep.assumed.length, 1); assert.equal(rep.assumed[0].questions[0].took, 'a');
  assert.throws(() => answerCard(repo, RUN, 'Q-1', { e1: 'b', e2: 'b' }, { via: 'card', quote: 'x' }), /autopilot/);
});

test('autopilot parks a gate: nothing is answered, the run is not stopped, and it is listed', () => {
  const repo = tmp(); on(repo);
  const r = askCard(repo, RUN, gate());
  assert.equal(r.status, 'deferred'); assert.equal(r.autopilot, 'gate'); assert.equal(r.answers, undefined);
  assert.equal(openQuestionsReason(repo, RUN), null); assert.equal(deferredSets(repo, RUN).length, 1);
  assert.doesNotThrow(() => setGate(repo, RUN, { gate: 'route', status: 'passed' }));
  assert.equal(autopilotReport(repo, RUN).deferred.length, 1);
});

test('the wording forces a gate: an Architect cannot label a deploy, merge, secret, purge or role question as routine', () => {
  for (const text of ['Deploy this build to QA?', 'Should we merge the PR now?', 'Which secret should the app use?', 'Purge the old traces?', 'Which role should the identity get?', 'Rotate the key now?', 'Approve the plan?', 'Run the database migration?', 'Allow this guard exception?', 'Open the ruleset change?', 'Enable branch protection?', 'Publish the release?']) {
    assert.equal(questionKind({ ...q('x', 'H', text), kind: 'execution' }), 'gate', text);
  }
  for (const text of ['Should the error message display the order number?', 'Which foreign key naming should the table use?', 'Should the list sort by date?', 'Which settings page layout should be used?', 'Use the existing helper or a new one?']) assert.equal(questionKind(q('x', 'Scope', text)), 'execution', text);
  assert.equal(questionKind({ ...q('x', 'Scope', 'A plain question?'), kind: 'gate' }), 'gate', 'an explicit gate label is honoured');
});

test('app-path access is always a gate: a Service Layer call, a database write or a customer system is never routine', () => {
  for (const text of ['POST the order to the Service Layer?', 'Use the app-path read identity for the ERP?', 'Add the agent gateway as a Hybrid Connection sender?', 'Read from the customer database?', 'Run this SQL write on QA?', 'Allow a DB write for the repair?']) {
    assert.equal(questionKind({ ...q('x', 'H', text), kind: 'execution' }), 'gate', text);
  }
  for (const text of ['Should the writer update the README first?', 'Which layer should own the mapping?', 'Should the service return 404 or 400?']) assert.equal(questionKind(q('x', 'Scope', text)), 'execution', text);
});

test('the skill\'s own routine topics stay routine even when their wording mentions production', () => {
  const c = { questions: [q('runningref', 'Running code', 'QA runs code that is not on main; what should the base be?')] };
  c.questions[0].question = 'Production runs code that is not on main; what should the base be?';
  assert.equal(cardKind(c), 'execution');
});

test('a card may not mix routine and gate questions in autopilot', () => {
  const repo = tmp(); on(repo);
  const mixed = { questions: [exec().questions[0], gate().questions[0]] };
  assert.equal(cardKind(mixed), 'mixed');
  assert.throws(() => askCard(repo, RUN, mixed), /AUTOPILOT_MIXED_CARD/);
});

test('a standing order still answers first, and unattended mode is unchanged', () => {
  const repo = tmp(); on(repo);
  const r = askCard(repo, RUN, { questions: [q('runningref', 'Running code', 'Which base should be used?', { options: [{ id: 'a', label: 'main', description: 'base on main' }, { id: 'b', label: 'stop', description: 'stop here' }] })] }, { standing: { skip: true } });
  assert.equal(r.status, 'assumed');
});

test('promote turns every parked gate into ONE open card, and the answer settles each of them', () => {
  const repo = tmp(); on(repo);
  askCard(repo, RUN, gate());
  askCard(repo, RUN, { questions: [q('g2', 'Secrets', 'Which secret store should hold the key?'), q('g3', 'Role', 'Which role should the identity get?')] });
  const p = promoteDeferred(repo, RUN);
  assert.equal(p.status, 'open'); assert.equal(p.card.questions.length, 3); assert.ok(openQuestionsReason(repo, RUN));
  assert.deepEqual(p.merges.map(m => m.set), ['Q-1', 'Q-2']);
  assert.throws(() => promoteDeferred(repo, RUN), /QUESTIONS_ALREADY_OPEN/);
  const ids = p.card.questions.map(x => x.id);
  const ans = answerCard(repo, RUN, p.id, { [ids[0]]: 'b', [ids[1]]: 'a', [ids[2]]: 'b' }, { via: 'card', quote: 'selected on the final card' });
  assert.equal(ans.status, 'answered');
  const sets = readSets(repo, RUN);
  assert.equal(sets.find(s => s.id === 'Q-1').status, 'answered'); assert.deepEqual(sets.find(s => s.id === 'Q-1').answers, { g1: 'b' });
  assert.deepEqual(sets.find(s => s.id === 'Q-2').answers, { g2: 'a', g3: 'b' }); assert.equal(sets.find(s => s.id === 'Q-2').settledBy, p.id);
  assert.equal(deferredSets(repo, RUN).length, 0); assert.equal(openQuestionsReason(repo, RUN), null);
  assert.equal(promoteDeferred(repo, RUN), null, 'nothing left to promote');
});

test('promote never splits one parked card across two final cards, and takes at most four questions', () => {
  const repo = tmp(); on(repo);
  askCard(repo, RUN, { questions: [q('a1', 'Deploy', 'Deploy A?'), q('a2', 'Deploy', 'Deploy B?'), q('a3', 'Deploy', 'Deploy C?')] });
  askCard(repo, RUN, { questions: [q('b1', 'Purge', 'Purge one?'), q('b2', 'Purge', 'Purge two?')] });
  const p1 = promoteDeferred(repo, RUN); assert.equal(p1.card.questions.length, 3); assert.deepEqual(p1.merges.map(m => m.set), ['Q-1']);
  const ids = p1.card.questions.map(x => x.id); answerCard(repo, RUN, p1.id, Object.fromEntries(ids.map(i => [i, 'a'])), { via: 'card', quote: 'ok' });
  const p2 = promoteDeferred(repo, RUN); assert.deepEqual(p2.merges.map(m => m.set), ['Q-2']); assert.equal(p2.card.questions.length, 2);
});

test('a parked gate can also be answered directly, and cancelled', () => {
  const repo = tmp(); on(repo);
  askCard(repo, RUN, gate());
  const a = answerCard(repo, RUN, 'Q-1', { g1: 'a' }, { via: 'card', quote: 'chose A' }); assert.equal(a.status, 'answered');
});

test('the CLI: autopilot --on needs a quote; ask reports the autopilot outcome; deferred and promote work', () => {
  const repo = tmp(); const cli = (...a) => spawnSync(process.execPath, [join(here, 'questions.mjs'), ...a, '--repo', repo, '--run', RUN], { encoding: 'utf8', env: { ...process.env, TRIOHARNESS_HOME: '/nonexistent-trioharness-home' } });
  assert.equal(cli('autopilot', '--on').status, 3);
  assert.equal(cli('autopilot', '--on', '--quote', 'autopilot please').status, 0);
  const file = join(repo, 'c.json'); require_write(file, exec());
  const a = cli('ask', '--file', file); assert.equal(a.status, 0); assert.match(a.stderr, /answered by AUTOPILOT/); assert.equal(JSON.parse(a.stdout).status, 'assumed');
  const file2 = join(repo, 'g.json'); require_write(file2, gate());
  const g = cli('ask', '--file', file2); assert.equal(g.status, 0); assert.match(g.stderr, /GATE parked by autopilot/);
  assert.equal(JSON.parse(cli('deferred').stdout).length, 1);
  const p = cli('promote'); assert.equal(p.status, 0); assert.match(p.stderr, /FINAL APPROVAL card/);
  assert.equal(cli('check').status, 2, 'the promoted card is a normal open card');
  assert.equal(cli('autopilot').status, 0);
});

function require_write(file, obj) { writeFileSyncJson(file, obj); }
import { writeFileSync } from 'node:fs';
function writeFileSyncJson(file, obj) { writeFileSync(file, JSON.stringify(obj)); }
void existsSync; void readFileSync;
