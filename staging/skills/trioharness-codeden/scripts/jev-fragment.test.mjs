// Regression: a standard changelog fragment (changes/<issue>-<slug>.md) in a plan that names its issue can be grounded
// by the issue and the plan instead of source excerpts (factory items #605 and #606 failed their plan gate on it).
// The source-grounding question stays for every item; the new-note question is a second route at the same threshold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GATES, T, inputDigest, runGate } from './jev.mjs';

const SOURCE_Q = n => `Does \`evidence\` show the current code, contract, or behaviour that \`changes[${n}]\` modifies or depends on?`;
const FRAGMENT_Q = (n, issue) => `\`changes[${n}].file\` is a changelog note named for #${issue}. Does \`changes[${n}].change\` only add a new note file (no edit, rename or deletion of an existing note, nothing else), and do \`objective\`, \`criteria\` or \`evidence\` show that #${issue} is this repository's issue that this plan fixes or builds and describe the user-facing change that the note records?`;
const SCOPE_Q = n => `Is \`changes[${n}]\` needed to satisfy \`objective\` or one of \`criteria\`? A test, verification step, or documentation for a needed change counts as needed.`;

const plan605 = {
  objective: 'Fix #605: all-project automations show only the viewed project\'s latest run',
  criteria: ['The latest run of an all-project automation is the viewed project\'s run, or none'],
  changes: [
    { file: 'apps/server/src/automations/runs.ts', change: 'Scope latest run to the viewed project' },
    { file: 'apps/server/test/automations.test.ts', change: 'Regression test' },
    { file: 'changes/605-all-project-automations-latest-run.md', change: 'Add a one-bullet fixed fragment' }
  ],
  proof: ['pnpm vitest run apps/server/test/automations.test.ts'],
  evidence: ['issue #605 body']
};
const withFile = (file, extra = {}) => ({ ...plan605, ...extra, changes: [...plan605.changes.slice(0, 2), { ...plan605.changes[2], file }] });
const questions = p => GATES.plan.build(p).questions;
const fragmentQ = p => questions(p).fragment_2?.instructions;

const noul = v => ({ type: 'noul', noul: v });
const fake = answers => async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers, usage: {} }) });
const answers = (source2, fragment2) => ({
  proof: noul(0.9), weakens: noul(0.02),
  scope_0: noul(0.95), grounded_0: noul(0.9), scope_1: noul(0.95), grounded_1: noul(0.9),
  scope_2: noul(0.9), grounded_2: noul(source2), ...(fragment2 === undefined ? {} : { fragment_2: noul(fragment2) })
});

test('#605-style plan: the fragment gets the new-note route and keeps the source question', () => {
  const q = questions(plan605);
  assert.equal(q.fragment_2.instructions, FRAGMENT_Q(2, 605));
  assert.equal(q.grounded_2.instructions, SOURCE_Q(2));
});

test('every other question keeps its original text and no other item gets a second route', () => {
  const q = questions(plan605);
  assert.equal(q.grounded_0.instructions, SOURCE_Q(0));
  assert.equal(q.grounded_1.instructions, SOURCE_Q(1));
  assert.equal(q.fragment_0, undefined);
  assert.equal(q.fragment_1, undefined);
  for (const n of [0, 1, 2]) assert.equal(q[`scope_${n}`].instructions, SCOPE_Q(n));
  assert.equal(q.proof.instructions, 'Does `proof` name a specific test or command whose result would show that `objective` and `criteria` are met?');
  assert.equal(q.weakens.instructions, 'Does any entry in `changes` delete, skip, loosen, or bypass a test, code review, validation, or security check?');
});

test('a criteria-only issue mention and a leading ./ still count', () => {
  const p = withFile('./changes/605-latest-run.md', { objective: 'Fix the latest run of all-project automations', criteria: ['#605: the viewed project\'s run, or none'] });
  assert.equal(fragmentQ(p), FRAGMENT_Q(2, 605));
  assert.equal(fragmentQ(withFile('changes/605-theme.md', { objective: 'Fix #605: header color' })), FRAGMENT_Q(2, 605));
  assert.equal(fragmentQ(withFile('changes/605-theme.md', { objective: 'Header color (#605)' })), FRAGMENT_Q(2, 605));
});

test('no second route for README, an unnamed issue, another number, other repos or non-fragment paths', () => {
  for (const file of ['changes/README.md', 'changes/606-other.md', 'changes/605-Upper.md', 'changes/605-x.mdx', 'docs/changes/605-x.md', 'CHANGELOG.md']) {
    assert.equal(fragmentQ(withFile(file)), undefined, file);
  }
  const unnamed = [
    { objective: 'Fix #6050 automations', criteria: ['see #60'] },
    { objective: 'Fix automations', criteria: ['no issue'] },
    { objective: 'Use color #605abc for the header', criteria: ['#605_x'] },
    { objective: 'Match the behavior in other/repo#605', criteria: ['no local issue'] },
    { objective: 'See owner/repo.js#605 and a-b#605', criteria: ['no local issue'] },
    { objective: 'Fix org#605', criteria: ['no local issue'] }
  ];
  for (const extra of unnamed) assert.equal(fragmentQ(withFile('changes/605-x.md', extra)), undefined, extra.objective);
});

test('either route at the unchanged threshold grounds the fragment; neither revises', async () => {
  assert.equal(T.grounded, 0.70);
  const run = a => runGate('plan', plan605, { key: 'k', fetchImpl: fake(a) });
  assert.equal((await run(answers(0.6, 0.70))).verdict, 'proceed');
  assert.equal((await run(answers(0.70, 0.1))).verdict, 'proceed');
  assert.equal((await run(answers(0.69, 0.69))).verdict, 'revise');
  const low = await run(answers(0.6, 0.6));
  assert.equal(low.verdict, 'revise');
  assert.match(low.reasons.join('\n'), /changes\[2\] changes\/605-all-project-automations-latest-run\.md: grounded 0\.6 and new-note 0\.6 < 0\.7/);
});

test('a non-fragment item is not rescued by an unasked fragment answer', async () => {
  const a = { ...answers(0.9, 0.9), grounded_0: noul(0.5), fragment_0: noul(0.99) };
  const r = await runGate('plan', plan605, { key: 'k', fetchImpl: fake(a) });
  assert.equal(r.verdict, 'revise');
  assert.match(r.reasons.join('\n'), /changes\[0\] apps\/server\/src\/automations\/runs\.ts: grounded 0\.5 < 0\.7 — add the exact current code it touches or depends on/);
});

test('an edit to an existing fragment keeps the source route and is revised when neither route holds', async () => {
  const p = withFile('changes/545-powershell-assignments.md', { objective: 'Reword the #545 note', criteria: ['The #545 note reads clearly'] });
  p.changes[2].change = 'Reword the existing bullet';
  assert.equal(questions(p).grounded_2.instructions, SOURCE_Q(2));
  const run = a => runGate('plan', p, { key: 'k', fetchImpl: fake(a) });
  assert.equal((await run(answers(0.85, 0.05))).verdict, 'proceed');
  assert.equal((await run(answers(0.3, 0.05))).verdict, 'revise');
});

test('#605 rerun: fragment scope 0.78 is in scope when the new-note answer reaches the scope threshold', async () => {
  assert.equal(T.inScope, 0.80);
  const run = a => runGate('plan', plan605, { key: 'k', fetchImpl: fake(a) });
  assert.equal((await run({ ...answers(0.68, 0.97), scope_2: noul(0.78) })).verdict, 'proceed');
  assert.equal((await run({ ...answers(0.68, 0.80), scope_2: noul(0.78) })).verdict, 'proceed');
  const low = await run({ ...answers(0.9, 0.79), scope_2: noul(0.78) });
  assert.equal(low.verdict, 'revise');
  assert.match(low.reasons.join('\n'), /changes\[2\] changes\/605-all-project-automations-latest-run\.md: scope 0\.78 and new-note 0\.79 < 0\.8/);
});

test('scope is not loosened for any other item, even with an unasked new-note answer', async () => {
  const a = { ...answers(0.9, 0.97), scope_0: noul(0.78), fragment_0: noul(0.99), scope_1: noul(0.78) };
  const r = await runGate('plan', plan605, { key: 'k', fetchImpl: fake(a) });
  assert.equal(r.verdict, 'revise');
  const reasons = r.reasons.join('\n');
  assert.match(reasons, /changes\[0\] apps\/server\/src\/automations\/runs\.ts: scope 0\.78 < 0\.8 — drop it to a follow-up or tie it to a criterion/);
  assert.match(reasons, /changes\[1\] apps\/server\/test\/automations\.test\.ts: scope 0\.78 < 0\.8/);
  assert.doesNotMatch(reasons, /changes\[2\]/);
  const unnamed = withFile('changes/605-x.md', { objective: 'Fix automations', criteria: ['no issue'] });
  const u = await runGate('plan', unnamed, { key: 'k', fetchImpl: fake({ ...answers(0.9), scope_2: noul(0.78), fragment_2: noul(0.99) }) });
  assert.match(u.reasons.join('\n'), /changes\[2\] changes\/605-x\.md: scope 0\.78 < 0\.8 — drop it/);
});

test('a non-numeric score is an invalid answer, never a pass', async () => {
  for (const bad of [true, '0.9', null, [0.9]]) {
    await assert.rejects(runGate('plan', plan605, { key: 'k', fetchImpl: fake({ ...answers(0.6, 0.9), scope_2: noul(0.78), fragment_2: noul(bad) }) }), /JEV_INVALID_ANSWER/, String(bad));
  }
  const route = { depth: { type: 'choice', choice: 'lean', confidence: '0.9', probabilities: {} } };
  await assert.rejects(runGate('route', { task: 't' }, { key: 'k', fetchImpl: fake(route) }), /JEV_INVALID_ANSWER/);
  const arrayChoice = { depth: { type: 'choice', choice: ['clarify'], confidence: 0.9, probabilities: {} } };
  await assert.rejects(runGate('route', { task: 't' }, { key: 'k', fetchImpl: fake(arrayChoice) }), /JEV_INVALID_ANSWER/);
  const ok = await runGate('route', { task: 't' }, { key: 'k', fetchImpl: fake({ depth: { type: 'choice', choice: 'lean', confidence: 0.9, probabilities: {} } }) });
  assert.equal(ok.verdict, 'lean');
});

test('the input digest is unchanged, so attempts and owner exceptions bind as before', () => {
  assert.equal(inputDigest('plan', plan605), 'cb9d28816add7b92');
});
