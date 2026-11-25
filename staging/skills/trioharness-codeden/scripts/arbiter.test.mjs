// GENERATED: copy of ~/.config/trioharness/skill-scripts/arbiter.test.mjs written by team-sync.mjs, don't edit by hand.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installed = existsSync(new URL('./team.mjs', import.meta.url));
const lib = await import(installed ? './team.mjs' : '../team-lib.mjs');
const arb = await import(installed ? './arbiter.mjs' : '../arbiter-lib.mjs');
const { applyAppTeam, loadAppTeam, loadTeam, loadTeamPolicy, validateTeam } = lib;
const { arbiterPin, arbiterProblems, arbiterSettings, arbiterState, codeStage, findingKey, itemUsage, nextCallProblem,
  openFindings, parseResponses, parseRuling, readJsonl, reviewCycle, writeBlocked } = arb;

const configUrl = new URL(installed ? '../../../../.config/trioharness/' : '../', import.meta.url);
const { exportedTeam } = await import(new URL('team-export.mjs', configUrl));
const policy = loadTeamPolicy(fileURLToPath(new URL('team-policy.json', configUrl)));
const fixturePin = { provider: 'claude', model: 'claude-fable-5-2', effort: 'high' };
const reviewer = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
const writer = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'medium' };
const fallback = { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high' };
const live = { ...policy, roles: { ...policy.roles, writer, codeReviewer: {
  ...policy.roles.codeReviewer, primary: reviewer, fallback: { claude: [fallback] },
} } };
const clone = () => structuredClone(live);
const withArbiter = patch => { const t = clone(); t.roles.arbiter = { ...t.roles.arbiter, ...fixturePin, ...patch }; return validateTeam(t); };
const tmp = t => { const d = mkdtempSync(join(tmpdir(), 'arbiter-test-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const appFile = (t, doc) => { const d = tmp(t); const f = join(d, 'p1.json'); writeFileSync(f, JSON.stringify({ version: 1, projectId: 'p1', roots: [d], updatedAt: 'x', ...doc })); return f; };
const finding = (id, sev = 'MEDIUM', file = 'src/a.js:10', problem = 'wrong total') => `- ID: ${id} | SEVERITY: ${sev} | FILE: ${file} | PROBLEM: ${problem} | EVIDENCE: e | MINIMAL FIX: f`;
const report = (...fs) => `REVIEW_DECISION: FINDINGS\nFINDINGS:\n${fs.join('\n')}\nOUT_OF_SCOPE_RISKS:\n- ID: X1 | SEVERITY: HIGH | FILE: z | PROBLEM: not open | EVIDENCE: e | MINIMAL FIX: f\nSUMMARY: ${['HIGH', 'MEDIUM', 'LOW'].map(sev => sev.toLowerCase() + '=' + fs.filter(f => f.includes('SEVERITY: ' + sev)).length).join(' ')}\n`;
let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 22, 12, 0, clock++)).toISOString();
function reviewRows(dir, verdicts) {
  return verdicts.map(([head, verdict, text, slot = 'primary'], i) => {
    const output = join(dir, `r${i + 1}.md`);
    const body = text ?? (verdict === 'CLEAN' ? 'REVIEW_DECISION: CLEAN\n' : report(finding('R1', 'MEDIUM', `src/f${i}.js:1`, `problem number ${'abcdefghij'[i]}`)));
    writeFileSync(output, body);
    return { schema: 2, kind: 'team-review', status: 'completed', slot, head, verdict, round: i + 1, output, outputSha256: createHash('sha256').update(body).digest('hex'), completedAt: at() };
  });
}
const esc = (dir, row) => writeFileSync(join(dir, 'ESCALATION.jsonl'), `${readFileSync(join(dir, 'ESCALATION.jsonl'), { flag: 'a+' })}${JSON.stringify({ completedAt: at(), ...row })}\n`);

test('team-policy.json Arbiter settings: every value is range-checked and none has a code default', t => {
  const s = arbiterSettings(loadTeam(fileURLToPath(new URL('team.json', configUrl))));
  for (const k of ['reviewFixRounds', 'jevReviewRounds', 'callsPerItem', 'jevAttempts', 'totalRounds']) assert.ok(Number.isInteger(s[k]), k);
  for (const [k, v] of [['reviewFixRounds', 0], ['reviewFixRounds', 6], ['reviewFixRounds', 2.5], ['reviewFixRounds', '2'], ['jevReviewRounds', 6],
    ['callsPerItem', 4], ['callsPerItem', 0], ['jevAttempts', 4], ['totalRounds', 13], ['totalRounds', 0], ['dailyBudgetUsd', 0], ['dailyBudgetUsd', -1], ['dailyBudgetUsd', 'x']]) {
    assert.throws(() => withArbiter({ [k]: v }), /TEAM_INVALID/, `${k}=${v}`);
  }
  const missingTotal = clone(); delete missingTotal.roles.arbiter.totalRounds;
  assert.throws(() => validateTeam(missingTotal), /totalRounds/);
  for (const v of [1, 5]) assert.equal(arbiterSettings(withArbiter({ reviewFixRounds: v })).reviewFixRounds, v);
  assert.equal(arbiterSettings(withArbiter({ dailyBudgetUsd: 3.5 })).dailyBudgetUsd, 3.5);
  const missing = structuredClone(policy); delete missing.roles.arbiter;
  const file = join(tmp(t), 'team-policy.json');
  writeFileSync(file, JSON.stringify(missing));
  assert.throws(() => loadTeamPolicy(file), /roles.arbiter.reviewFixRounds/);
  const noModel = clone(); for (const k of ['provider', 'model', 'effort']) delete noModel.roles.arbiter[k];
  assert.throws(() => arbiterPin(validateTeam(noModel), { writer: 'codex' }), /TEAM_ROLE_UNSET/);
});

for (const [provider, model] of [['claude', 'default'], ['claude', ''], ['gemini', 'auto']]) {
  test(`Arbiter substitution skips ${provider}/${JSON.stringify(model)}`, () => {
    const team = clone();
    team.roles.arbiter = { ...team.roles.arbiter, ...writer };
    team.roles.investigator = { provider, model, effort: 'max' };
    assert.deepEqual(arbiterPin(team, { writer: 'codex' }), reviewer);
    team.roles.codeReviewer.primary = null;
    assert.throws(() => arbiterPin(team, { writer: 'codex' }), /ARBITER_SAME_VENDOR/);
  });
}

const unsetArbiter = { message: 'TEAM_ROLE_UNSET: Set the Arbiter in Settings → Team' };

test('an unset Arbiter fails closed and says Set the Arbiter in Settings → Team', t => {
  const team = clone();
  const { provider, model, effort, ...settings } = team.roles.arbiter;
  team.roles.arbiter = settings;
  const resolved = validateTeam(team);
  assert.throws(() => arbiterPin(resolved, { writer: 'codex' }), unsetArbiter);
  assert.deepEqual(nextCallProblem(resolved, tmp(t), 'arbiter'), { problem: unsetArbiter.message });
});

test('an in-app Team without an Arbiter fails closed and does not fall back to team.json', t => {
  const base = withArbiter({});
  for (const team of [[], [{ role: 'writer', provider: 'codex', model: 'fixture', effort: null }]]) {
    const resolved = applyAppTeam(base, loadAppTeam(appFile(t, { team })), 'codex');
    assert.equal(arbiterSettings(resolved).pin, null);
    assert.throws(() => arbiterPin(resolved, { writer: 'codex' }), unsetArbiter);
  }
});

test('the Team file overrides team-policy.json (session over project over global is resolved by CodeDen into it) and is range-checked', t => {
  const doc = loadAppTeam(appFile(t, { team: [{ role: 'arbiter', provider: 'codex', model: 'gpt-6.2-astra', effort: 'xhigh' }],
    escalation: { reviewFixRounds: 4, callsPerItem: 1, dailyBudgetUsd: 2, source: 'session' } }));
  const s = arbiterSettings(applyAppTeam(live, doc, 'claude'));
  assert.deepEqual([s.pin, s.reviewFixRounds, s.callsPerItem, s.dailyBudgetUsd, s.source, s.totalRounds],
    [{ provider: 'codex', model: 'gpt-6.2-astra', effort: 'xhigh' }, 4, 1, 2, 'session', live.roles.arbiter.totalRounds]);
  const project = arbiterSettings(applyAppTeam(live, loadAppTeam(appFile(t, { team: [], escalation: { reviewFixRounds: 3, source: 'project' } })), 'claude'));
  assert.deepEqual([project.reviewFixRounds, project.source, project.pin], [3, 'project', null]);
  for (const bad of [{ reviewFixRounds: 6, source: 'session' }, { callsPerItem: 4, source: 'project' }, { totalRounds: 2 }, { jevAttempts: 0, source: 'global' }]) {
    assert.throws(() => loadAppTeam(appFile(t, { team: [], escalation: bad })), /TEAM_FILE_INVALID/);
  }
});

test('no reviewer and no Arbiter of the writer\'s vendor: auto cross-vendor, refused otherwise, waits when no other vendor exists', () => {
  const { reviewChain, reviewerProblem, teamForWriter } = lib;
  // Code reviewer: a primary of the writer's vendor is replaced by the writer's cross-vendor fallback, never kept.
  const forClaude = teamForWriter(live, 'claude');
  const chain = reviewChain(forClaude, 'claude');
  assert.notEqual(live.vendors[chain.primary.provider], 'Anthropic', 'Claude-written code gets a non-Anthropic primary');
  assert.ok(chain.fallbacks.every(f => live.vendors[f.provider] !== 'Anthropic'), 'no same-vendor fallback');
  assert.match(reviewerProblem(forClaude, { slot: 'primary', writer: 'claude', reviewer: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } }), /same-vendor review/);
  for (const slot of ['fallback', 'second-pass']) assert.match(reviewerProblem(forClaude, { slot, writer: 'claude', reviewer: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } }), /same-vendor review/);
  const bad = clone(); bad.roles.codeReviewer.fallback.claude = [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }];
  assert.throws(() => validateTeam(bad), /writer's own vendor/, 'a same-vendor fallback is refused at load');
  // Arbiter: the configured fixture pin (Anthropic) never rules on Claude-written code; another vendor does, or the dispute waits.
  const team = withArbiter({});
  assert.deepEqual(arbiterPin(team, { writer: 'codex' }), arbiterSettings(team).pin, 'Codex-written code keeps the Team Arbiter');
  const pick = arbiterPin(team, { writer: 'claude' });
  assert.notEqual(team.vendors[pick.provider], 'Anthropic');
  assert.ok(pick.model && pick.effort);
  assert.throws(() => arbiterPin(team, {}), /ARBITER_WRITER_UNKNOWN/);
  assert.throws(() => arbiterPin(team, { writer: 'cursor' }), /ARBITER_SAME_VENDOR: writer cursor has no known vendor/, 'an unknown writer vendor waits');
  // The Team's pairing: Claude only for code from the Team's Writer (codex/gpt-6.2-sol today).
  const opus = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
  assert.equal(live.roles.writer.provider, 'codex');
  assert.equal(lib.claudeMayReview(live, 'codex'), true);
  assert.equal(lib.claudeMayReview(live, 'agy'), false);
  assert.equal(reviewerProblem(teamForWriter(live, 'codex'), { slot: 'primary', writer: 'codex', reviewer: opus }), null, "Claude may review the Team Writer's code");
  const withAgy = clone(); withAgy.roles.codeReviewer.fallback.agy = [opus];
  assert.match(reviewerProblem(validateTeam(withAgy), { slot: 'fallback', writer: 'agy', reviewer: opus }), /Claude reviews only code from the Team's Writer/);
  assert.notEqual(team.vendors[arbiterPin(team, { writer: 'agy' }).provider], 'Anthropic', 'no Claude Arbiter for a writer other than the Team Writer');
  const solo = withArbiter({});
  for (const r of Object.values(solo.roles)) if (r?.provider) Object.assign(r, { provider: 'claude', model: 'claude-opus-5-5' });
  solo.roles.codeReviewer.primary = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
  solo.roles.codeReviewer.fallback = { codex: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }], claude: [{ provider: 'codex', model: 'gpt-6.2-astra', effort: 'high' }] };
  const v = validateTeam(solo);
  v.roles.codeReviewer.fallback.claude = [];
  assert.throws(() => arbiterPin(v, { writer: 'claude' }), /ARBITER_SAME_VENDOR: .*the dispute waits/);
  const dir = mkdtempSync(join(tmpdir(), 'arbiter-vendor-'));
  try {
    const rows = [{ kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'completed', decision: 'APPROVE', rulings: [], head: 'h', arbiter: arbiterSettings(team).pin, participants: { writer: 'claude' }, completedAt: at() }];
    writeFileSync(join(dir, 'ESCALATION.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    assert.ok(arbiterProblems(team, dir, [], { head: 'h' }).some(p => /ARBITER_NOT_IN_TEAM/.test(p)), 'a recorded same-vendor ruling fails the merge check');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('open findings are bound to their report, quoted parts are kept apart and out-of-scope risks are not open', () => {
  const src = { round: 2, slot: 'primary', outputSha256: 'abc' };
  const f = openFindings(report(finding('R1'), finding('R2', 'HIGH')), { prefix: '2.', source: src });
  assert.deepEqual(f.map(x => [x.id, x.severity, x.source.round]), [['2.R1', 'MEDIUM', 2], ['2.R2', 'HIGH', 2]]);
  const parts = `REVIEW_DECISION: FINDINGS\n\n## Part 1\n\n> REVIEW_DECISION: FINDINGS\n> FINDINGS:\n> ${finding('R1')}\n\n## Part 2\n\n> REVIEW_DECISION: FINDINGS\n> FINDINGS:\n> ${finding('R1', 'LOW')}\n`;
  assert.deepEqual(openFindings(parts, { prefix: '3.' }).map(x => x.id), ['3.P1.R1', '3.P2.R1']);
  assert.deepEqual(openFindings('VERDICT: AMEND\nFINDINGS:\n[BLOCKING] P01 a.md:1 missing proof -> add it\n[ADVISORY] P02 b.md:2 wording -> fix\nFALSE_PREMISES: none\n', { scope: 'plan', prefix: '1.' }).map(x => [x.id, x.severity]), [['1.P01', 'BLOCKING'], ['1.P02', 'ADVISORY']]);
  assert.equal(findingKey({ finding: 'FILE: src/a.js:10 | PROBLEM: Wrong total!' }), findingKey({ finding: 'FILE: src/a.js:99 | PROBLEM: wrong   total' }));
  assert.deepEqual(parseResponses('- ID: 1.R1 | RESPONSE: DISPUTE | NOTE: no\n- ID: 1.R2 | RESPONSE: FIXED | NOTE: done\n- ID: 1.R3 | RESPONSE: maybe'), [{ id: '1.R1', response: 'DISPUTE' }, { id: '1.R2', response: 'FIXED' }]);
});

test('a ruling covers every finding once with VALID-must-fix or INVALID and a reason; anything else is refused', () => {
  const fs = [{ id: '2.R1', severity: 'HIGH', finding: 'a' }, { id: '2.R2', severity: 'LOW', finding: 'b' }];
  const good = 'ARBITER_DECISION: APPROVE\nRULINGS:\n- ID: 2.R1 | RULING: VALID-must-fix | REASON: real bug\n- ID: 2.R2 | RULING: INVALID | REASON: the caller guards it at x.js:3\n';
  assert.deepEqual(parseRuling(good, fs).rulings.map(r => [r.id, r.ruling, r.severity]), [['2.R1', 'VALID-must-fix', 'HIGH'], ['2.R2', 'INVALID', 'LOW']]);
  for (const [text, why] of [
    [good.replace('VALID-must-fix', 'VALID-waived'), /cannot waive/], [good.replace('VALID-must-fix', 'VALID-LOW'), /cannot waive/],
    [good.replace('INVALID', 'ACCEPT-RISK'), /cannot waive/], [good.replace(/- ID: 2\.R2.*\n/, ''), /no ruling on 2\.R2/],
    [good.replace('2.R2 |', '9.R9 |'), /not an open finding/], [good + '- ID: 2.R1 | RULING: INVALID | REASON: again\n', /ruled twice/],
    [good.replace('REASON: the caller guards it at x.js:3', 'REASON: none'), /no reasoning/], [good.replace('ARBITER_DECISION: APPROVE', 'ARBITER_DECISION: APPROVE | BLOCK'), /exactly one/],
    [good + 'ARBITER_DECISION: BLOCK\n', /exactly one/],
  ]) assert.match(parseRuling(text, fs).problem, why);
  assert.match(parseRuling(good, [...fs, { id: '2.R1', severity: 'LOW', finding: 'other' }]).problem, /share an ID \(2\.R1\)/, 'one ruling never disposes of two findings');
});

test('the cycle escalates at R (1, 2 and 5); a later CLEAN on a FINDINGS head never clears it; a CLEAN head resets', t => {
  const dir = tmp(t);
  for (const R of [1, 2, 5]) {
    const rows = reviewRows(dir, Array.from({ length: R }, (_, i) => [`h${i}`, 'FINDINGS']));
    assert.equal(reviewCycle(rows.slice(0, R - 1), [], R).due, false, `R=${R} before`);
    const c = reviewCycle(rows, [], R);
    assert.equal(c.due, true, `R=${R}`);
    assert.equal(c.label, `review round ${R} of ${R}, Arbiter next`);
    assert.equal(reviewCycle([...rows, ...reviewRows(dir, [['hx', 'CLEAN']])], [{ kind: 'adopted', completedAt: '' }], R).pastLimit, true, `R=${R} past`);
    assert.equal(reviewCycle([...rows, ...reviewRows(dir, [['hy', 'CLEAN']])], [], R).pastLimit, false, `R=${R}: rounds before adoption are counted, never judged`);
  }
  const mixed = reviewRows(dir, [['a', 'FINDINGS'], ['a', 'CLEAN', null, 'second-pass'], ['b', 'CLEAN'], ['b', 'FINDINGS', null, 'second-pass']]);
  assert.equal(reviewCycle(mixed, [], 2).due, true);
  assert.equal(reviewCycle(reviewRows(dir, [['a', 'FINDINGS'], ['b', 'CLEAN'], ['c', 'FINDINGS']]), [], 2).due, false);
  assert.equal(reviewCycle(reviewRows(dir, [['a', 'CLEAN', null, 'second-pass']]), [], 1).round, 0, 'a second pass creates no head');
});

test('early escalation: the same finding returning after a fix, or the writer disputing it twice', t => {
  const dir = tmp(t);
  const same = report(finding('R1', 'MEDIUM', 'src/a.js:10', 'wrong total'));
  const back = reviewCycle(reviewRows(dir, [['a', 'FINDINGS', same], ['b', 'FINDINGS', same.replace('a.js:10', 'a.js:12')]]), [], 5);
  assert.deepEqual([back.due, back.trigger], [true, 'same finding returned after a fix']);
  const rows = reviewRows(dir, [['a', 'FINDINGS', same]]);
  const key = findingKey(openFindings(same)[0]);
  assert.equal(reviewCycle(rows, [{ kind: 'responses', disputes: [key] }], 5).due, false);
  const twice = reviewCycle(rows, [{ kind: 'responses', disputes: [key] }, { kind: 'responses', disputes: [key] }], 5);
  assert.deepEqual([twice.due, twice.trigger], [true, 'the writer disputed the same finding twice']);
});

test('caps: A Arbiter calls and T model rounds block the item', t => {
  const dir = tmp(t);
  const team = withArbiter({ callsPerItem: 1, totalRounds: 3 });
  esc(dir, { kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'unavailable', reason: 'x' });
  const cap = nextCallProblem(withArbiter({ callsPerItem: 1, totalRounds: 3 }), dir, 'arbiter');
  assert.match(cap.problem, /ARBITER_CAP: 1 of 1/); assert.equal(cap.blocks, true);
  writeFileSync(join(dir, 'CODE_REVIEW_ROUNDS.jsonl'), reviewRows(dir, [['a', 'FINDINGS'], ['b', 'FINDINGS']]).map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(itemUsage(dir).total, 3);
  const ceiling = nextCallProblem(team, dir, 'review');
  assert.match(ceiling.problem, /ROUNDS_CEILING: 3 of 3/); assert.equal(ceiling.blocks, true);
});

test('an incomplete Arbiter attempt with an output digest uses one call and can retry', t => {
  const dir = tmp(t);
  const team = withArbiter({ callsPerItem: 2 });
  const rows = reviewRows(dir, [['a', 'FINDINGS'], ['b', 'FINDINGS']]);
  esc(dir, { kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'incomplete',
    outputSha256: arb.sha('partial output'), reason: 'no ruling on 2.R2' });
  assert.equal(itemUsage(dir).arbiter, 1);
  assert.equal(codeStage(team, dir, rows).phase, 'ruling');
  assert.equal(nextCallProblem(team, dir, 'arbiter'), null);
});

test('a BLOCK with an edited tooling-fault status still uses the call cap and blocks', t => {
  const dir = tmp(t);
  const team = withArbiter({ callsPerItem: 1 });
  const row = { kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'completed',
    decision: 'BLOCK', rulings: [], outputSha256: arb.sha('DECISION: BLOCK'), reason: 'ruling reason' };
  const ledger = join(dir, 'ESCALATION.jsonl');
  esc(dir, row);
  writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('"status":"completed"', '"status":"tooling-fault"'));
  assert.deepEqual([
    itemUsage(dir).arbiter,
    arbiterState(readJsonl(ledger), 'code').calls,
    arbiterState(readJsonl(ledger), 'code').decision,
  ], [1, 1, 'BLOCK']);
  assert.match(nextCallProblem(team, dir, 'arbiter').problem, /ARBITER_CAP: 1 of 1/);
  assert.ok(arbiterProblems(team, dir, []).some(problem => /ARBITER_BLOCK/.test(problem)));
});

test('a capped unresolved item ends BLOCKED for the orchestrator, never approved, and refuses every later round', t => {
  const dir = tmp(t);
  const rows = reviewRows(dir, [['a', 'FINDINGS'], ['b', 'FINDINGS']]);
  const team = withArbiter({ reviewFixRounds: 2 });
  assert.equal(codeStage(team, dir, rows).phase, 'ruling');
  writeBlocked(dir, { reason: 'ARBITER_CAP: 2 of 2 Arbiter calls used', openFindings: [{ id: '2.R1', severity: 'HIGH', finding: 'x' }] });
  assert.equal(codeStage(team, dir, rows).phase, 'blocked');
  assert.match(nextCallProblem(team, dir, 'review').problem, /ITEM_BLOCKED/);
  assert.match(nextCallProblem(team, dir, 'arbiter').problem, /ITEM_BLOCKED/);
  assert.ok(arbiterProblems(team, dir, rows).some(p => /^ITEM_BLOCKED/.test(p)));
  assert.match(readFileSync(join(dir, 'workers', 'blocked-report.md'), 'utf8'), /2\.R1 \[HIGH\]/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'ITEM_BLOCKED.json'), 'utf8')).status, 'BLOCKED');
});

test('merge problems: missing ruling, BLOCK, unavailable, unconfirmed VALID, wrong Arbiter, a review after escalation, high-risk head', t => {
  const team = withArbiter({ reviewFixRounds: 2 });
  const pin = arbiterSettings(team).pin;
  const participants = { writer: 'codex', reviewers: [{ provider: 'claude' }] };
  const valid = [{ id: '2.R1', severity: 'HIGH', finding: 'x', ruling: 'VALID-must-fix', reason: 'real' }];
  const cases = [
    [[], /ARBITER_RULING_MISSING/],
    [[{ kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'completed', decision: 'BLOCK', rulings: [], arbiter: pin, participants, head: 'c' }], /ARBITER_BLOCK/],
    [[{ kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'unavailable', reason: 'claude -p exit 1', arbiter: pin, participants, head: 'c' }], /ARBITER_UNAVAILABLE: code: claude -p exit 1/],
    [[{ kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'completed', decision: 'APPROVE', rulings: valid, arbiter: pin, participants, head: 'c' }], /ARBITER_CONFIRM_MISSING: code: 2\.R1/],
    [[{ kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'completed', decision: 'APPROVE', rulings: [], arbiter: { ...pin, effort: 'low' }, participants, head: 'c' }], /ARBITER_NOT_IN_TEAM/],
    [[{ kind: 'arbiter', scope: 'plan', mode: 'ruling', status: 'completed', decision: 'BLOCK', rulings: [], arbiter: pin, participants, head: null }], /ARBITER_BLOCK: the plan dispute ended in BLOCK/],
  ];
  for (const [rows, want] of cases) {
    const dir = tmp(t);
    const reviews = reviewRows(dir, [['a', 'FINDINGS'], ['b', 'FINDINGS']]);
    for (const r of rows) esc(dir, r);
    assert.ok(arbiterProblems(team, dir, reviews).some(p => want.test(p)), `${want}: ${arbiterProblems(team, dir, reviews)}`);
  }
  const dir = tmp(t);
  const reviews = reviewRows(dir, [['a', 'FINDINGS'], ['b', 'FINDINGS']]);
  esc(dir, { kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'completed', decision: 'APPROVE', rulings: valid, arbiter: pin, participants, head: 'c' });
  const confirmRound = { schema: 2, kind: 'team-review', status: 'completed', slot: 'primary', head: 'd', verdict: 'CLEAN', completedAt: at() };
  esc(dir, { kind: 'review-confirm', scope: 'code', decision: 'APPROVE', head: 'd' });
  assert.deepEqual(arbiterProblems(team, dir, [...reviews, confirmRound], { head: 'd' }), []);
  assert.ok(arbiterProblems(team, dir, [...reviews, confirmRound], { head: 'd', highRisk: true }).some(p => /SECOND_PASS_MISSING/.test(p)), 'a pre-fix second pass does not count');
  const second = { schema: 2, kind: 'team-review', status: 'completed', slot: 'second-pass', head: 'd', verdict: 'CLEAN', completedAt: at() };
  const reviewsPlus = [...reviews, confirmRound];
  assert.ok(arbiterProblems(team, dir, [...reviewsPlus, second], { head: 'd', highRisk: true }).some(p => /ARBITER_FINAL/.test(p)), 'a second pass after the confirm is a round past the dispute');
  assert.ok(arbiterProblems(team, dir, reviewsPlus, { head: 'other' }).some(p => /ARBITER_HEAD/.test(p)), 'only the head the dispute ended at may merge');
  const late = { schema: 2, kind: 'team-review', status: 'completed', slot: 'primary', head: 'e', verdict: 'CLEAN', completedAt: at() };
  assert.ok(arbiterProblems(team, dir, [...reviewsPlus, late], { head: 'd' }).some(p => /ARBITER_FINAL/.test(p)));
  const lane = { kind: 'invoke-lane', status: 'completed', slot: 'fallback', completedAt: at() };
  assert.ok(arbiterProblems(team, dir, [...reviewsPlus, lane], { head: 'd' }).some(p => /ARBITER_FINAL/.test(p)));
  assert.equal(arbiterState(readJsonl(join(dir, 'ESCALATION.jsonl')), 'code').phase, 'final');
});

test('team-sync renders the Arbiter rule from the Team into the skills and keeps the Team pointer free of pins', async () => {
  const sync = await import(installed ? new URL('../../../../.config/trioharness/team-sync.mjs', import.meta.url) : new URL('../team-sync.mjs', import.meta.url));
  const team = withArbiter({ reviewFixRounds: 3, callsPerItem: 1, totalRounds: 7, dailyBudgetUsd: 4 });
  const block = sync.arbiterBlock(team);
  for (const part of ['R=3 reviewer fix rounds', 'A=1 Arbiter calls per item', 'T=7 model rounds per item', 'daily Arbiter budget 4 USD', "Arbiter: the Team's Arbiter (provider, model and effort from the in-app Team).", 'Review escalation: see the trioharness skill / Team settings']) assert.ok(block.includes(part), part);
  assert.doesNotMatch(block, /\b[a-z][\w-]* +\/ +[a-z0-9][\w.-]*/);
  assert.doesNotMatch(sync.teamBlock(), /claude-fable-5-2|R=3 reviewer fix rounds/);
  assert.match(sync.teamBlock(), /`\[Arbiter\]`/);
  const skill = 'intro\n<!-- END Security rules (generated from security-rules.json) -->\n\n## Scope guard\n';
  const once = sync.syncArbiterMarkdown(skill, team, 'skill');
  assert.ok(once.indexOf('## Arbiter (review escalation)') > once.indexOf('END Security rules') && once.indexOf('## Arbiter') < once.indexOf('## Scope guard'));
  assert.equal(sync.syncArbiterMarkdown(once, team, 'skill'), once);
  assert.ok(sync.syncArbiterMarkdown(once, withArbiter({ reviewFixRounds: 4 }), 'skill').includes('R=4 reviewer fix rounds'));
  assert.ok(sync.syncArbiterMarkdown('# Convergence\n', team, 'append').endsWith('<!-- END Arbiter (generated from team.json) -->\n'));
  assert.throws(() => sync.syncArbiterMarkdown('no markers', team, 'skill'), /ARBITER_SECTION_NOT_FOUND/);
  assert.throws(() => sync.syncArbiterMarkdown(once.replace('<!-- END Arbiter (generated from team.json) -->', ''), team, 'skill'), /END marker missing/);
});

test('review fix batch: tampered or missing reports, a damaged ledger and plan reviews in T all refuse', t => {
  const dir = tmp(t);
  const rows = reviewRows(dir, [['a', 'FINDINGS'], ['b', 'FINDINGS']]);
  writeFileSync(rows[1].output, report(finding('R9')));
  assert.match(reviewCycle(rows, [], 2).inputProblems.join(), /differs from its recorded sha256/);
  rmSync(rows[1].output);
  assert.match(reviewCycle(rows, [], 2).inputProblems.join(), /is missing/);
  writeFileSync(join(dir, 'ESCALATION.jsonl'), '{"kind":"arbiter"\n');
  assert.ok(arbiterProblems(withArbiter({}), dir, rows).some(p => /ESCALATION_UNREADABLE/.test(p)));
  assert.throws(() => nextCallProblem(withArbiter({}), dir, 'review'), /ESCALATION_UNREADABLE/);
  const d2 = tmp(t);
  mkdirSync(join(d2, 'workers'));
  for (const n of [1, 2]) writeFileSync(join(d2, 'workers', `plan-reviewer-${n}.md`), 'VERDICT: AMEND\n');
  assert.equal(itemUsage(d2).planReviews, 2);
  assert.match(nextCallProblem(withArbiter({ totalRounds: 2 }), d2, 'review').problem, /ROUNDS_CEILING: 2 of 2/);
});

test('review fix batch: the final head must stay reviewed, and a high-risk final second pass must be CLEAN or ruled INVALID', t => {
  const team = withArbiter({});
  const pin = arbiterSettings(team).pin;
  const participants = { writer: 'codex', reviewers: [{ provider: 'claude' }] };
  const dir = tmp(t);
  const reviews = reviewRows(dir, [['a', 'FINDINGS'], ['c', 'FINDINGS']]);
  const secondDir = tmp(t);
  const [second] = reviewRows(secondDir, [['c', 'FINDINGS', report(finding('R1', 'HIGH', 'x.js:1', 'second pass issue')), 'second-pass']]);
  second.round = 7;
  esc(dir, { kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'completed', decision: 'APPROVE', arbiter: pin, participants, head: 'c',
    rulings: [{ id: '7.R1', severity: 'HIGH', finding: 'x', ruling: 'INVALID', reason: 'guarded at x.js:2' }] });
  assert.deepEqual(arbiterProblems(team, dir, [...reviews, second], { highRisk: true, head: 'c' }), [], 'ruled INVALID at the ruling head');
  assert.ok(arbiterProblems(team, dir, [...reviews, second], { head: 'later' }).some(p => /ARBITER_HEAD/.test(p)));
  const d2 = tmp(t);
  const r2 = reviewRows(d2, [['a', 'FINDINGS'], ['b', 'FINDINGS']]);
  esc(d2, { kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'completed', decision: 'APPROVE', arbiter: pin, participants, head: 'c', rulings: [{ id: '2.R1', severity: 'HIGH', finding: 'x', ruling: 'VALID-must-fix', reason: 'real' }] });
  const [clean, dirty] = reviewRows(d2, [['d', 'CLEAN'], ['d', 'FINDINGS', null, 'second-pass']]);
  esc(d2, { kind: 'review-confirm', scope: 'code', decision: 'APPROVE', head: 'd' });
  assert.ok(arbiterProblems(team, d2, [...r2, clean, dirty], { highRisk: true, head: 'd' }).some(p => /SECOND_PASS_MISSING/.test(p)), 'a FINDINGS second pass on the confirm head never passes');
});

test('review fix batch: the plan cycle counts numbered reviews after the last APPROVE and escalates early', () => {
  let n = 0;
  const r = (v, f = 'plan.md:1 missing proof -> add it', id = 'P01') => { const text = `VERDICT: ${v}\nFINDINGS:\n${v === 'APPROVE' ? '' : `[BLOCKING] ${id} ${f}\n`}FALSE_PREMISES: none\n`; n++; return { n, path: `/x/plan-reviewer-${n}.md`, text, sha256: createHash('sha256').update(text).digest('hex'), verdict: arb.planVerdict(text) }; };
  const a1 = r('AMEND', 'plan.md:1 first -> x');
  const a2 = { ...a1, n: 2, path: '/x/plan-reviewer-2.md' };
  assert.equal(arb.planCycle([a1, a2], [], 5).count, 2, 'two numbered reviews count twice even with equal text');
  assert.equal(arb.planCycle([a1, r('APPROVE'), r('AMEND', 'plan.md:9 other -> y')], [], 2).count, 1, 'an APPROVE resets the count');
  const back = arb.planCycle([r('AMEND', 'plan.md:1 same thing -> x', 'P01'), r('BLOCK', 'plan.md:4 same thing -> z', 'P07')], [], 5);
  assert.deepEqual([back.due, back.trigger], [true, 'same plan finding returned after a fix']);
  const key = arb.planFindingKey({ finding: 'plan.md:1 first -> x' });
  assert.equal(arb.planCycle([a1], [{ kind: 'responses', scope: 'plan', disputes: [key] }, { kind: 'responses', scope: 'plan', disputes: [key] }], 5).due, true);
  assert.equal(arb.planCycle([a1], [{ kind: 'responses', disputes: [key] }, { kind: 'responses', disputes: [key] }], 5).due, false, 'code disputes do not count for the plan');
  assert.equal(arb.planCycle([a1], [], 5, 1).trigger, 'the plan-review caps leave no further plan review');
});

test('an unresolved item goes to the orchestrator inbox marked owner decision, with the open findings, the ruling and the Jev receipts', t => {
  const dir = tmp(t);
  const team = withArbiter({});
  const pin = arbiterSettings(team).pin;
  esc(dir, { kind: 'arbiter', id: 'rul-1', scope: 'code', mode: 'ruling', status: 'completed', decision: 'APPROVE', arbiter: pin, head: 'c',
    rulings: [{ id: '2.R1', severity: 'HIGH', finding: 'x', ruling: 'VALID-must-fix', reason: 'real at a.js:1' }] });
  writeFileSync(join(dir, 'jev-receipts.jsonl'), [{ gate: 'done', pass: false, verdict: 'revise', inputSha256: 'abc123', at: at(), reasons: ['criteria[0] unsupported'] },
    { gate: 'done', pass: false, verdict: 'revise', inputSha256: 'def456', at: at(), reasons: ['still unsupported'] }].map(j => JSON.stringify(j)).join('\n') + '\n');
  const rec = writeBlocked(dir, { reason: 'JEV_REFUSED_TWICE', openFindings: [{ id: '2.R1', severity: 'HIGH', finding: 'x' }], rulings: [] });
  assert.deepEqual([rec.status, rec.inbox, rec.marker, rec.ruling.receipt, rec.ruling.arbiter.model, rec.jev.map(j => j.inputSha256)],
    ['BLOCKED', 'orchestrator', 'owner decision', 'rul-1', pin.model, ['abc123', 'def456']]);
  assert.equal(pin.model, 'claude-fable-5-2'); assert.equal(pin.effort, 'high');
  const md = readFileSync(join(dir, 'workers', 'blocked-report.md'), 'utf8');
  for (const part of ['(owner decision)', '2.R1 [HIGH]', 'receipt rul-1', 'done revise input abc123', 'still unsupported']) assert.ok(md.includes(part), part);
  assert.equal(codeStage(team, dir, []).phase, 'blocked', 'never approved: every later round is refused');
});

test('in-flight runs: fix rounds count from their receipts; past R without approval goes to the Arbiter, an approved run stays approved', t => {
  const team = withArbiter({ reviewFixRounds: 2 });
  const approved = tmp(t);
  const ok = reviewRows(approved, [['a', 'FINDINGS'], ['b', 'FINDINGS'], ['c', 'CLEAN']]);
  assert.deepEqual(arbiterProblems(team, approved, ok, { head: 'c' }), [], 'an old run that converged before the install is not judged');
  const open = tmp(t);
  const rows = reviewRows(open, [['a', 'FINDINGS'], ['b', 'FINDINGS'], ['c', 'FINDINGS']]);
  assert.equal(codeStage(team, open, rows).phase, 'ruling', 'past R without APPROVE: the next round is the Arbiter');
  assert.ok(arbiterProblems(team, open, rows).some(p => /ARBITER_RULING_MISSING/.test(p)));
  assert.ok(!arbiterProblems(team, open, rows).some(p => /ARBITER_REQUIRED/.test(p)), 'rounds before the adoption are counted, never refused');
});

test('an empty existing lock cannot be stolen', t => {
  const lock = join(tmp(t), 'item.lock');
  writeFileSync(lock, '');
  assert.throws(() => arb.withLock(lock, () => assert.fail('entered an occupied lock')), /ITEM_BUSY/);
  assert.equal(readFileSync(lock, 'utf8'), '');
  rmSync(lock);
  assert.throws(() => arb.withLock(lock, () => { throw new Error('callback failed'); }), /callback failed/);
  assert.equal(existsSync(lock), false);
});

test('malformed review and Jev rows fail closed with their line numbers', t => {
  const dir = tmp(t);
  for (const name of ['CODE_REVIEW_ROUNDS.jsonl', 'jev-receipts.jsonl']) {
    const file = join(dir, name);
    writeFileSync(file, '{}\n{broken\n');
    assert.throws(() => itemUsage(dir), e => e.message.includes(file) && e.message.includes('line 2'));
    rmSync(file);
  }
});

test('a valid finding cannot conceal a malformed finding or contradictory summary', t => {
  const dir = tmp(t);
  for (const [body, problem] of [
    [report(finding('R2', 'LOW')).replace('FINDINGS:\n', 'FINDINGS:\n- ID: R1 | SEVERITY HIGH | missing colon\n'), /malformed finding/],
    [report(finding('R2', 'LOW')).replace('high=0', 'high=1'), /counts differ/],
  ]) {
    const [row] = reviewRows(dir, [['a', 'FINDINGS', body]]);
    assert.match(arb.verifiedFindings(row).problem, problem);
  }
});

test('later plan approval cannot erase a post-adoption review beyond R', t => {
  const dir = tmp(t);
  mkdirSync(join(dir, 'workers'));
  for (const [n, verdict] of [[1, 'AMEND'], [2, 'AMEND'], [3, 'APPROVE']]) {
    writeFileSync(join(dir, 'workers', `plan-reviewer-${n}.md`), `VERDICT: ${verdict}\n`);
  }
  esc(dir, { kind: 'adopted', planReport: 0 });
  assert.ok(arbiterProblems(withArbiter({ reviewFixRounds: 2 }), dir, []).some(p => /plan-reviewer-3.md ran after .* due/.test(p)));
});

test('the Team digest distinguishes a disabled daily budget from an inherited one', t => {
  const base = withArbiter({ dailyBudgetUsd: 2 });
  const file = appFile(t, { team: [], escalation: { source: 'project' } });
  const inherited = loadAppTeam(file);
  writeFileSync(file, JSON.stringify({ ...inherited, escalation: { source: 'project', dailyBudgetUsd: null } }));
  const disabled = loadAppTeam(file);
  assert.notEqual(disabled.sha256, inherited.sha256);
  assert.equal(arbiterSettings(applyAppTeam(base, inherited)).dailyBudgetUsd, 2);
  assert.equal(arbiterSettings(applyAppTeam(base, disabled)).dailyBudgetUsd, null);
});

function jevStageFixture(t, settings = {}, setup = '') {
  const root = tmp(t);
  const dir = join(root, '.trioharness-direct', 'runs', 'r1');
  const config = join(root, '.config', 'trioharness');
  const bin = join(root, 'bin');
  for (const path of [dir, config, bin]) mkdirSync(path, { recursive: true });
  const team = clone();
  team.roles.codeReviewer.primary = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
  Object.assign(team.roles.arbiter, { ...fixturePin, jevAttempts: 3, jevReviewRounds: 2, callsPerItem: 1, totalRounds: 8, dailyBudgetUsd: null, ...settings });
  const members = Object.entries({ writer, reviewer, reviewerFallback: fallback, arbiter: fixturePin })
    .map(([role, pin]) => ({ role, ...pin }));
  const sources = Object.fromEntries(members.map(({ role }) => [role, 'default']));
  const fixturePolicy = structuredClone(policy);
  Object.assign(fixturePolicy.roles.arbiter, lib.arbiterLimits(team));
  writeFileSync(join(config, 'team-policy.json'), JSON.stringify(fixturePolicy));
  writeFileSync(join(config, 'team.json'), JSON.stringify(exportedTeam({ team: members, sources })));
  writeFileSync(join(config, 'team-sync.mjs'), '');
  const callsFile = join(root, 'calls.jsonl');
  const preload = join(root, 'home.mjs');
  writeFileSync(preload, `import os from 'node:os';
import fs from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
os.userInfo = () => ({ homedir: ${JSON.stringify(root)} });
${setup}
syncBuiltinESMExports();`);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(fs.readFileSync(0, 'utf8')) + '\\n');
const model = args[args.indexOf('--model') + 1];
console.log(JSON.stringify({ result: process.env.STUB_FALLBACK, modelUsage: { [model]: { outputTokens: 10 } }, total_cost_usd: 0.01 }));
`, { mode: 0o755 });
  const packet = join(root, 'brief.md');
  const input = join(root, 'input.json');
  const log = join(dir, 'jev-receipts.jsonl');
  writeFileSync(packet, 'Evidence for the title criterion.\n');
  writeFileSync(input, JSON.stringify({ objective: 'Render the title', criteria: ['Title renders'], evidence: ['Title is visible'] }));
  const env = { ...process.env, TEAM_FILE: '', TRIOHARNESS_TEAM_HOME: root, PATH: bin + delimiter + process.env.PATH };
  delete env.TYPESAFE_API_KEY;
  delete env.JEV_API_KEY;
  delete env.JEV_KEY_FILE;
  env.JEV_KEY_FILE = join(root, 'missing-key');
  const launch = (script, args, extra = {}) => spawnSync(process.execPath, ['--import', preload, fileURLToPath(script), ...args],
    { cwd: root, encoding: 'utf8', env: { ...env, ...extra }, timeout: 10000 });
  const command = (cmd, args, reply) => launch(new URL('./team-review.mjs', import.meta.url),
    [cmd, '--repo', root, '--run', 'r1', '--writer', 'codex', '--packet', packet, ...args], { STUB_FALLBACK: reply });
  const jevScript = new URL(installed ? './jev.mjs' : '../../../.claude/skills/trioharness-codeden/scripts/jev.mjs', import.meta.url);
  const fetch = `globalThis.fetch = async () => ({ ok: true, json: async () => ({
    model: 'fixture', answers: { failing: { type: 'noul', noul: 0 }, unsupported: { type: 'noul', noul: 0 }, met_0: { type: 'noul', noul: 1 } }
  }) });`;
  return { dir, team, log, config, calls: () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [],
    refuse: (gate, reason, stamp = new Date().toISOString()) => {
      const rows = readJsonl(log);
      writeFileSync(log, [...rows, { gate, at: stamp, pass: false, verdict: 'revise', reasons: [reason] }].map(row => JSON.stringify(row)).join('\n') + '\n');
    },
    review: (gate = 'done', reply = 'REVIEW_DECISION: CLEAN\n') => command('jev-review', ['--gate', gate], reply),
    arbitrate: (reply, scope = 'jev-done') => command('arbitrate', ['--scope', scope], reply),
    jev: (withKey = false) => launch(jevScript, ['done', input, '--log', log], {
      NODE_OPTIONS: '--import=data:text/javascript,' + encodeURIComponent(fetch),
      ...(withKey ? { TYPESAFE_API_KEY: randomUUID(), JEV_API_KEY: '' } : {})
    }),
    rows: () => arb.escalationRows(dir) };
}

test('C13 Jev-stage review requires a same-gate refusal, records J rounds, and clears JEV_REVIEW_REQUIRED', t => {
  const f = jevStageFixture(t);
  f.refuse('plan', 'other gate');
  const missing = f.review();
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /JEV_REFUSAL_REQUIRED/);
  assert.equal(f.calls().length, 0);
  f.refuse('done', 'title evidence is missing');
  assert.match(f.jev().stderr, /JEV_REVIEW_REQUIRED: 0 of 2/);
  for (let i = 1; i <= 2; i++) {
    const result = f.review();
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.calls().at(-1), /title evidence is missing/);
    assert.doesNotMatch(f.calls().at(-1), /other gate/);
    const row = f.rows().at(-1);
    assert.deepEqual([row.kind, row.scope, row.gate, row.status, row.round, row.verdict], ['jev-review', 'jev-done', 'done', 'completed', i, 'CLEAN']);
  }
  assert.equal(existsSync(join(f.dir, 'CODE_REVIEW_ROUNDS.jsonl')), false);
  const capped = f.review();
  assert.equal(capped.status, 2, capped.stderr);
  assert.match(capped.stderr, /JEV_REVIEW_CAP/);
  assert.equal(f.calls().length, 2);
  const passed = f.jev(true);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).pass, true);
});

test('Jev-stage review accepts a refusal in a registered custom log', t => {
  const f = jevStageFixture(t);
  const log = join(f.dir, 'first.jsonl');
  arb.registerJevLog(f.dir, log);
  writeFileSync(log, JSON.stringify({ gate: 'done', at: new Date().toISOString(),
    pass: false, verdict: 'revise', reasons: ['title evidence is missing'] }) + '\n');
  assert.match(f.jev().stderr, /JEV_REVIEW_REQUIRED/);
  const result = f.review();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.rows().at(-1).status, 'completed');
  assert.match(f.calls().at(-1), /title evidence is missing/);
});

test('C13 Jev-stage review refuses at T and leaves the item blocked', t => {
  const f = jevStageFixture(t, { totalRounds: 1 });
  f.refuse('done', 'title evidence is missing');
  const capped = f.review();
  assert.equal(capped.status, 2, capped.stderr);
  assert.match(capped.stderr, /ROUNDS_CEILING/);
  const blocked = f.review();
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /ITEM_BLOCKED/);
  assert.equal(f.calls().length, 0);
});

for (const decision of ['APPROVE', 'BLOCK']) {
  test(`C13 Jev done Arbiter ${decision} ${decision === 'APPROVE' ? 'clears ARBITER_REQUIRED' : 'blocks the item'}`, t => {
    const f = jevStageFixture(t, { jevReviewRounds: 1 });
    f.refuse('done', 'title evidence is missing');
    const review = f.review('done', report(finding('R1', 'MEDIUM', 'title.md:1', 'title evidence was unverified')));
    assert.equal(review.status, 0, review.stderr);
    f.refuse('done', 'title evidence is still unverified');
    assert.match(f.jev().stderr, /ARBITER_REQUIRED: Jev done/);
    const result = f.arbitrate(`ARBITER_DECISION: ${decision}\nRULINGS:
- ID: j1 | RULING: INVALID | REASON: title.md:1 contains evidence
- ID: r1.R1 | RULING: ${decision === 'BLOCK' ? 'VALID-must-fix' : 'INVALID'} | REASON: checked title.md:1
`);
    assert.equal(result.status, decision === 'APPROVE' ? 0 : 2, result.stderr);
    assert.match(f.calls().at(-1), /title evidence is still unverified/);
    assert.match(f.calls().at(-1), /title evidence was unverified/);
    const row = f.rows().findLast(row => row.kind === 'arbiter');
    assert.deepEqual([row.scope, row.gate, row.mode, row.status, row.decision], ['jev-done', 'done', 'ruling', 'completed', decision]);
    assert.equal(itemUsage(f.dir).arbiter, 1);
    assert.equal(existsSync(join(f.dir, 'CODE_REVIEW_ROUNDS.jsonl')), false);
    const jev = f.jev(decision === 'APPROVE');
    if (decision === 'APPROVE') {
      assert.equal(jev.status, 0, jev.stderr);
      assert.equal(JSON.parse(jev.stdout).pass, true);
    } else {
      assert.equal(jev.status, 3, jev.stderr);
      assert.match(jev.stderr, /ITEM_BLOCKED: ARBITER_BLOCK/);
    }
  });
}

const budgetGuard = (code = 'UNEXPECTED') => `
const budgetError = path => Object.assign(new Error('${code}: denied ' + path), { code: '${code}', path });
for (const method of ['accessSync', 'appendFileSync', 'existsSync', 'lstatSync', 'mkdirSync', 'openSync',
  'readFileSync', 'readdirSync', 'realpathSync', 'rmSync', 'statSync', 'unlinkSync', 'writeFileSync']) {
  const original = fs[method];
  fs[method] = (path, ...args) => {
    if (typeof path === 'string' && /(?:^|\\/)(?:arbiter-budget\\.lock|arbiter-usage\\.jsonl)(?:\\/|$)/.test(path)) {
      process.stderr.write('unexpected budget access: ' + method + ' ' + path + '\\n');
      throw budgetError(path);
    }
    return original(path, ...args);
  };
}`;
test('Jev-stage APPROVE with an open VALID-must-fix finding counts and blocks the item', t => {
  const f = jevStageFixture(t, { callsPerItem: 2, jevReviewRounds: 1 });
  const output = join(f.dir, 'review.md');
  const review = 'REVIEW_DECISION: CLEAN\n';
  writeFileSync(output, review);
  f.refuse('done', 'title evidence is missing', '2026-01-01T00:00:01.000Z');
  arb.appendEscalation(f.dir, { kind: 'jev-review', scope: 'jev-done', status: 'completed',
    completedAt: '2026-01-01T00:00:02.000Z', verdict: 'CLEAN', output,
    outputSha256: createHash('sha256').update(review).digest('hex'),
    reviewer: f.team.roles.codeReviewer.primary });
  f.refuse('done', 'title evidence remains missing', '2026-01-01T00:00:03.000Z');

  const result = f.arbitrate('ARBITER_DECISION: APPROVE\n- ID: j1 | RULING: VALID-must-fix | REASON: No title evidence.\n');
  assert.equal(result.status, 2, result.stderr);
  const receipt = f.rows().findLast(row => row.kind === 'arbiter');
  assert.deepEqual([receipt?.status, receipt?.decision], ['completed', 'BLOCK'], result.stderr);
  assert.equal(itemUsage(f.dir).arbiter, 1);
  assert.match(arb.itemBlocked(f.dir).reason, /ARBITER_BLOCK.*cannot leave VALID-must-fix/);
});

const budgetUnavailable = 'ARBITER_BUDGET_UNAVAILABLE: Arbiter daily budget needs host-side counting (CodeDen); not available';
const budgetReply = 'ARBITER_DECISION: APPROVE\nRULINGS:\n- ID: j1 | RULING: INVALID | REASON: verified title.md:1\n';
function readyBudgetArbiter(t, dailyBudgetUsd, setup) {
  const f = jevStageFixture(t, { dailyBudgetUsd, jevReviewRounds: 1 }, setup);
  f.refuse('done', 'title evidence is missing');
  const review = f.review();
  assert.equal(review.status, 0, review.stderr);
  f.refuse('done', 'title evidence is still unverified');
  return f;
}

test('budget off allows a ruling with zero budget filesystem access', t => {
  const f = readyBudgetArbiter(t, null, budgetGuard());
  const result = f.arbitrate(budgetReply);
  assert.doesNotMatch(result.stderr, /unexpected budget access/);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().length, 2);
});

test('budget on fails closed before model dispatch or filesystem access', t => {
  const f = readyBudgetArbiter(t, 1, budgetGuard());
  const result = f.arbitrate(budgetReply);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr.trim(), 'team-review: ' + budgetUnavailable);
  assert.equal(f.calls().length, 1);
  for (const name of ['arbiter-budget.lock', 'arbiter-usage.jsonl']) assert.equal(existsSync(join(f.config, name)), false);
});

for (const [code, name] of [['EPERM', 'arbiter-budget.lock'], ['EACCES', 'arbiter-usage.jsonl']]) {
  test(`budget path ${code} is logged as a tooling fault without consuming an Arbiter call`, t => {
    // Inject a budget-path error at dispatch, where a tooling fault can be recorded.
    const f = readyBudgetArbiter(t, null, `${budgetGuard(code)}
const mkdtemp = fs.mkdtempSync;
fs.mkdtempSync = (prefix, ...args) => {
  if (process.argv.includes('arbitrate') && basename(prefix) === 'team-review-') {
    const path = os.userInfo().homedir + '/.config/trioharness/${name}';
    throw budgetError(path);
  }
  return mkdtemp(prefix, ...args);
};`);
    const before = itemUsage(f.dir).arbiter;
    const result = f.arbitrate(budgetReply);
    assert.equal(result.status, 2, result.stderr);
    const receipt = f.rows().findLast(row => row.kind === 'arbiter');
    assert.equal(receipt?.status, 'tooling-fault', result.stderr);
    assert.ok(receipt.reason.includes(code) && receipt.reason.includes(name), receipt.reason);
    assert.ok(readFileSync(join(f.dir, 'workers', 'arbiter-rulings.md'), 'utf8').includes(`tooling-fault: ${receipt.reason}`));
    assert.equal(itemUsage(f.dir).arbiter, before);
    assert.equal(f.calls().length, 1);
  });
}

const parkedPin = { provider: 'claude', model: 'iris', effort: 'medium' };
const parkedRulingModel = 'claude-iris-7-1';
const parkedHelperModel = 'claude-cedar-3-2';

function directArbiterFixture(t, script) {
  const dir = tmp(t);
  const team = withArbiter({ ...parkedPin, dailyBudgetUsd: null, callsPerItem: 1, totalRounds: 8 });
  const arbiterUrl = new URL(installed ? './arbiter.mjs' : '../arbiter-lib.mjs', import.meta.url).href;
  const reviewUrl = new URL('./team-review.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { delimiter, join } from 'node:path';
const dir = ${JSON.stringify(dir)};
const team = ${JSON.stringify(team)};
const arbiterUrl = ${JSON.stringify(arbiterUrl)};
const reviewUrl = ${JSON.stringify(reviewUrl)};
${script}
`], { encoding: 'utf8', timeout: 10000, env: { ...process.env, TRIOHARNESS_TEAM_HOME: dir } });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return { dir, team, stderr: result.stderr };
}

for (const [item, auxiliaries] of [
  ['foundry 91aad395', { [parkedHelperModel]: { outputTokens: 5 } }],
  ['mobile gate-followups bf6c44c0', {}],
]) {
  test(`${item}: the full ruling model matches the saved alias and counts once`, t => {
    const modelUsage = { ...auxiliaries, [parkedRulingModel]: { outputTokens: 20 } };
    const reply = JSON.stringify({ result: budgetReply, modelUsage });
    const { dir, team } = directArbiterFixture(t, `
const arb = await import(arbiterUrl);
const pin = arb.arbiterPin(team, { writer: 'codex' });
fs.writeFileSync(join(dir, 'claude'), '#!' + process.execPath + '\\n' +
  'console.log(' + JSON.stringify(${JSON.stringify(reply)}) + ');\\n' +
  'const args = process.argv;\\n' +
  'if (args[args.indexOf("--model") + 1] !== "iris" || args[args.indexOf("--effort") + 1] !== "medium") process.exit(1);\\n',
  { mode: 0o755 });
process.env.PATH = dir + delimiter + process.env.PATH;
// Token ranking is inline in the private reviewer runner. Expose it only in this fixture process.
const hook = registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  return url === reviewUrl ? { ...loaded, source: loaded.source.toString() + '\\nexport { runReviewer };' } : loaded;
} });
const { runReviewer, savedModelMatches } = await import(reviewUrl);
hook.deregister();
assert.equal(arb.nextCallProblem(team, dir, 'arbiter'), null);
const output = join(dir, 'ruling.md');
const result = runReviewer(pin, { repo: dir, packet: 'Fixture packet', out: output, packetOnly: true });
assert.equal(result.ok, true, result.problem);
assert.equal(result.evidence.rulingModel, ${JSON.stringify(parkedRulingModel)});
assert.deepEqual(result.evidence.auxiliaryModels, ${JSON.stringify(Object.keys(auxiliaries))});
assert.equal(savedModelMatches(pin.provider, pin.model, result.evidence.rulingModel), true);
const ruling = arb.parseRuling(fs.readFileSync(output, 'utf8'), [{ id: 'j1', severity: 'MEDIUM' }]);
assert.equal(ruling.decision, 'APPROVE');
assert.equal(ruling.problem, undefined);
arb.appendEscalation(dir, { id: 'r1', kind: 'arbiter', status: 'completed', decision: ruling.decision });
`);
    assert.equal(itemUsage(dir).arbiter, 1);
    assert.match(nextCallProblem(team, dir, 'arbiter').problem, /ARBITER_CAP: 1 of 1/);
  });
}

test('mobile att-parity 9c78a87a: budget off skips the lock and a logged EPERM preserves the cap', t => {
  const { dir, team, stderr } = directArbiterFixture(t, `
${budgetGuard('EPERM')}
syncBuiltinESMExports();
const arb = await import(arbiterUrl);
assert.equal(arb.nextCallProblem(team, dir, 'arbiter'), null);
const lock = join(dir, '.config', 'trioharness', 'arbiter-budget.lock');
assert.throws(() => fs.mkdirSync(lock), error => {
  assert.equal(arb.isBudgetPermissionError(error), true);
  assert.equal(error.code, 'EPERM');
  arb.appendEscalation(dir, { id: 'r1', kind: 'arbiter-start', status: 'dispatched' });
  assert.equal(arb.itemUsage(dir).arbiter, 1);
  arb.appendEscalation(dir, { id: 'r1', kind: 'arbiter', status: 'tooling-fault', reason: error.message, toolingReason: error.message });
  return true;
});
`);
  assert.deepEqual(stderr.trim().split('\n'), [
    `unexpected budget access: mkdirSync ${join(dir, '.config', 'trioharness', 'arbiter-budget.lock')}`,
  ]);
  const [receipt] = arb.escalationRows(dir);
  assert.equal(receipt.status, 'tooling-fault');
  assert.match(receipt.reason, /EPERM: denied .*arbiter-budget\.lock/);
  assert.equal(itemUsage(dir).arbiter, 0);
  assert.equal(nextCallProblem(team, dir, 'arbiter'), null);
});

const mismatch = models => `claude/iris/medium: claude reported models ${models}, not iris`;
const budgetLockFailure = "EPERM: operation not permitted, mkdir 'TEAM_DIR/arbiter-budget.lock'";
const budgetUsageFailure = "EACCES: permission denied, open 'TEAM_DIR/arbiter-usage.jsonl'";

test('reclassify leaves EPERM and EACCES rows blocked without writing', t => {
  for (const reason of [budgetLockFailure, budgetUsageFailure]) {
    const f = parkedRun(t, [reason]);
    const original = f.snapshot();
    const result = f.run();
    assert.deepEqual(result.before, { blocked: true, reason: f.reason, callsUsed: 1, callsPerItem: 1 });
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(f.snapshot(), original);
  }
});

const mismatchRow = (models, modelUsage) => ({
  reason: mismatch(models.join(', ')),
  arbiter: { provider: 'claude', model: 'iris', effort: 'medium' },
  evidence: { reportedModels: models, ...(modelUsage === undefined ? {} : { modelUsage }) },
});
const parkedModels = [parkedRulingModel, parkedHelperModel];
const countedMismatch = (ruling, helper) => mismatchRow(parkedModels, {
  [parkedRulingModel]: { outputTokens: ruling },
  [parkedHelperModel]: { outputTokens: helper },
});

function parkedRun(t, failures, { extra = [], blockReason, callsPerItem = 1 } = {}) {
  const dir = tmp(t);
  const config = join(dir, '.config', 'trioharness');
  mkdirSync(config, { recursive: true });
  const fixturePolicy = structuredClone(policy);
  Object.assign(fixturePolicy.roles.arbiter, { callsPerItem, dailyBudgetUsd: null });
  writeFileSync(join(config, 'team-policy.json'), JSON.stringify(fixturePolicy));
  writeFileSync(join(config, 'team.json'), JSON.stringify(exportedTeam({ team: [{ role: 'arbiter', ...fixturePin }] })));
  const { TEAM_FILE, ...env } = process.env;
  const script = new URL(installed ? './arbiter.mjs' : '../arbiter-lib.mjs', import.meta.url);
  const ledger = join(dir, arb.ESCALATION);
  const block = join(dir, arb.BLOCKED);
  const receipts = failures.map(failure => {
    const details = typeof failure === 'string' ? { reason: failure } : failure;
    return { ...details, reason: details.reason.replace('TEAM_DIR', config) };
  });
  for (const receipt of receipts) {
    const id = randomUUID();
    const row = { kind: 'arbiter', id, mode: 'ruling', scope: 'code', settings: { callsPerItem } };
    esc(dir, { ...row, kind: 'arbiter-start', status: 'dispatched' });
    esc(dir, { ...row, status: 'unavailable', ...receipt });
  }
  for (const row of extra) esc(dir, row);
  const count = failures.length + extra.filter(row => row.kind === 'arbiter').length;
  const reason = blockReason ?? `ARBITER_CAP: ${count} of ${callsPerItem} Arbiter calls used after ARBITER_UNAVAILABLE: ${receipts.at(-1)?.reason}`;
  writeBlocked(dir, { reason });
  const run = (...args) => {
    const result = spawnSync(process.execPath, [fileURLToPath(script), 'reclassify', '--run', dir, ...args],
      { encoding: 'utf8', env: { ...env, TRIOHARNESS_TEAM_HOME: dir }, timeout: 10000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return JSON.parse(result.stdout);
  };
  const snapshot = () => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path, readFileSync(path)];
    }));
  return { dir, ledger, block, run, snapshot, reason };
}

for (const [item, reason] of [
  ['foundry 91aad395 alias plus helper', mismatchRow(parkedModels)],
  ['mobile gate-followups bf6c44c0 alias-only', mismatchRow([parkedRulingModel])],
  ['a mismatch with a confirmed ruling model', countedMismatch(20, 1)],
]) {
  test(`reclassify clears the cap for ${item}`, t => {
    const f = parkedRun(t, [reason]);
    setTeamHome(t, f.dir);
    const original = readFileSync(f.ledger);
    const result = f.run();
    assert.deepEqual(result.before, { blocked: true, reason: f.reason, callsUsed: 1, callsPerItem: 1 });
    assert.deepEqual(result.after, { blocked: false, reason: null, callsUsed: 0, callsPerItem: 1 });
    assert.equal(existsSync(f.block), false);
    const updated = readFileSync(f.ledger);
    assert.deepEqual(updated.subarray(0, original.length), original);
    assert.equal(updated.subarray(original.length).toString().trim().split('\n').length, 1);
    assert.equal(itemUsage(f.dir).arbiter, 0);
    assert.equal(itemUsage(f.dir).arbiterRounds, 1);
    const [row] = arb.escalationRows(f.dir).filter(row => row.kind === 'arbiter');
    assert.equal(row.status, 'tooling-fault');
    assert.equal(row.toolingReason, f.reason.split('ARBITER_UNAVAILABLE: ')[1]);
    assert.equal(nextCallProblem(withArbiter({ callsPerItem: 1, dailyBudgetUsd: null }), f.dir, 'arbiter'), null);
    f.run();
    assert.deepEqual(readFileSync(f.ledger), updated);
  });
}

function setTeamHome(t, home) {
  const previous = process.env.TRIOHARNESS_TEAM_HOME;
  process.env.TRIOHARNESS_TEAM_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.TRIOHARNESS_TEAM_HOME;
    else process.env.TRIOHARNESS_TEAM_HOME = previous;
  });
}

const eligibleMismatch = mismatchRow([parkedRulingModel]);

for (const [name, original, rowIndex, toolingReason] of [
  ['a missing original', eligibleMismatch, 99, eligibleMismatch.reason],
  ['a BLOCK ruling', { ...eligibleMismatch, decision: 'BLOCK' }, 1, eligibleMismatch.reason],
  ['an ineligible reason', { ...eligibleMismatch, reason: 'codex timed out' }, 1, 'codex timed out'],
  ['a different recorded reason', eligibleMismatch, 1, mismatch(parkedModels.join(', '))],
]) {
  test(`a forged grant referencing ${name} frees no call or prior block`, t => {
    const priorBlock = { kind: 'blocked', completedAt: 'prior', reason: 'ARBITER_CAP: 1 of 1 Arbiter calls used' };
    const f = parkedRun(t, [original, eligibleMismatch], { extra: [priorBlock], callsPerItem: 2 });
    setTeamHome(t, f.dir);
    esc(f.dir, {
      kind: 'arbiter-reclassification',
      reclassified: [{ rowIndex, toolingReason }],
      clearedBlock: { at: priorBlock.completedAt, reason: priorBlock.reason },
    });
    assert.equal(itemUsage(f.dir).arbiter, 2);
    const result = f.run('--dry-run');
    assert.deepEqual(result.after, result.before);
  });
}

test('an invalid later grant does not overwrite a genuine grant', t => {
  const f = parkedRun(t, [eligibleMismatch]);
  setTeamHome(t, f.dir);
  f.run();
  esc(f.dir, {
    kind: 'arbiter-reclassification',
    reclassified: [{ rowIndex: 1, toolingReason: 'codex timed out' }],
  });
  assert.equal(itemUsage(f.dir).arbiter, 0);
});

test('reclassify dry-run prints before and after without changing bytes', t => {
  const f = parkedRun(t, [eligibleMismatch, mismatchRow(parkedModels)], {
    callsPerItem: 2, blockReason: 'ARBITER_CAP: 2 of 2 Arbiter calls used',
  });
  setTeamHome(t, f.dir);
  const original = f.snapshot();
  const result = f.run('--dry-run');
  assert.deepEqual(result.before, { blocked: true, reason: f.reason, callsUsed: 2, callsPerItem: 2 });
  assert.deepEqual(result.after, { blocked: false, reason: null, callsUsed: 0, callsPerItem: 2 });
  assert.deepEqual(f.snapshot(), original);
  assert.deepEqual(f.run().after, result.after);
  assert.equal(itemUsage(f.dir).arbiter, 0);
});

for (const [name, failures, options] of [
  ['a real BLOCK', [], {
    extra: [{ kind: 'arbiter', mode: 'ruling', decision: 'BLOCK', reason: mismatch(parkedRulingModel) }],
    blockReason: 'ARBITER_BLOCK: the Arbiter blocked the code review',
  }],
  ['a qualifying row and a ruling', [eligibleMismatch], {
    extra: [{ kind: 'arbiter', mode: 'ruling', decision: 'APPROVE', rulings: [] }],
  }],
  ['a qualifying row and an unrelated marker', [eligibleMismatch], {
    blockReason: 'ROUNDS_CEILING: 8 of 8 model rounds used',
  }],
  ['a qualifying row and an unrelated block audit', [eligibleMismatch], {
    extra: [{ kind: 'blocked', reason: 'CONFIRM_FAILED: review still has findings' }],
  }],
  ['a qualifying row and a different failure', [eligibleMismatch, 'codex timed out'], { callsPerItem: 2 }],
  ['a qualifying row and an unrelated cap suffix', [eligibleMismatch], {
    blockReason: 'ARBITER_CAP: 1 of 1 Arbiter calls used after ARBITER_UNAVAILABLE: codex timed out',
  }],
  ['a cap marker with no Arbiter calls', [], { blockReason: 'ARBITER_CAP: 0 of 0 Arbiter calls used' }],
  ['a mismatch whose helper supplied the ruling', [countedMismatch(1, 20)], {}],
  ['a mismatch with two counted family versions', [mismatchRow([parkedRulingModel, 'claude-iris-7-2'], {
    [parkedRulingModel]: { outputTokens: 20 }, 'claude-iris-7-2': { outputTokens: 1 },
  })], {}],
  ['a mismatch with missing token counts', [countedMismatch(20, undefined)], {}],
  ['a mismatch with no evidence', [mismatch(parkedModels.join(', '))], {}],
  ['a legacy mismatch with two family versions', [mismatchRow([parkedRulingModel, 'claude-iris-7-2'])], {}],
  ['a legacy mismatch with no family model', [mismatchRow([parkedHelperModel])], {}],
  ['a legacy mismatch with a non-alias pin', [{
    ...mismatchRow(parkedModels), arbiter: { provider: 'claude', model: parkedRulingModel },
  }], {}],
  ...Object.entries({ text: 'reply', output: '/tmp/report.md', outputSha256: 'abc', rulings: [{ ruling: 'INVALID' }] })
    .map(([field, value]) => [`a matching reason with Arbiter ${field}`, [], {
      extra: [{ kind: 'arbiter', ...eligibleMismatch, [field]: value }],
      blockReason: 'ARBITER_CAP: 1 of 1 Arbiter calls used',
    }]),
]) {
  test(`reclassify keeps ${name} blocked without writing`, t => {
    const f = parkedRun(t, failures, options);
    const original = f.snapshot();
    const result = f.run();
    assert.ok(result.before.blocked);
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(f.snapshot(), original);
  });
}

test('reclassify retries a marker removal after the ledger append', t => {
  const f = parkedRun(t, [eligibleMismatch]);
  const marker = readFileSync(f.block);
  f.run();
  const updated = readFileSync(f.ledger);
  writeFileSync(f.block, marker);
  assert.equal(f.run('--dry-run').after.blocked, false);
  assert.deepEqual(readFileSync(f.block), marker);
  assert.equal(f.run().after.blocked, false);
  assert.equal(existsSync(f.block), false);
  assert.deepEqual(readFileSync(f.ledger), updated);
});
