import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as team from './team-lib.mjs';

const base = () => team.loadTeamPolicy(fileURLToPath(new URL('./team-policy.json', import.meta.url)));
const pin = (model, role) => ({ role, provider: 'claude', model, effort: 'high' });
const opus = 'claude-opus-5-5';

test('validateTeam accepts absent and null role pins', () => {
  const document = base();
  delete document.roles.architect;
  document.roles.planReviewer = null;
  document.roles.agentsMdWriter = null;
  document.roles.codeReviewer.primary = null;
  delete document.roles.codeReviewer.fallback;
  assert.equal(team.validateTeam(document), document);
});

test('role and reviewChain report unset pins', () => {
  const document = base();
  document.roles.writer = null;
  document.roles.codeReviewer.primary = null;
  assert.throws(() => team.role(document, 'writer'), /TEAM_ROLE_UNSET: Set the Writer in Settings → Team/);
  assert.throws(() => team.reviewChain(document, 'codex'), /TEAM_ROLE_UNSET: Set the Code Reviewer in Settings → Team/);
});

test('normalizeModel resolves a unique full id from session pins', () => {
  const document = base();
  document.roles = { writer: null, codeReviewer: { primary: null, fallback: null } };
  const pins = [pin('opus'), pin(opus), { provider: 'codex', model: 'codex-opus-example' }];
  assert.deepEqual([...team.knownModelIds(document, 'claude', pins)], [opus]);
  assert.equal(team.normalizeModel(document, 'claude', opus), opus);
  assert.equal(team.normalizeModel(document, 'claude', 'opus', pins), opus);
  assert.equal(team.sameModel(document, 'claude', 'opus', opus, pins), true);
  assert.equal(team.sameModel(document, 'claude', opus, 'opus', pins), true);
  assert.equal(team.sameModel(document, 'claude', 'opus', 'opus'), true);
  assert.equal(team.sameModel(document, 'claude', opus, 'claude-sonnet-example', pins), false);
});

for (const [alias, pins] of [['sonnet', []], ['opus', [pin(opus), pin('claude-opus-older')]], ['default', [pin('claude-default-example')]]]) {
  test(`normalizeModel refuses ${alias} without a unique alias resolution`, () => {
    assert.equal(typeof team.normalizeModel, 'function', 'normalizeModel must be exported');
    assert.throws(() => team.normalizeModel(base(), 'claude', alias, pins), new RegExp(`MODEL_ALIAS_UNKNOWN: claude/${alias}`));
  });
}

test('loadAppTeam accepts reviewerFallback and arbiter and applies app model aliases', () => {
  const document = base();
  document.roles = { codeReviewer: document.roles.codeReviewer };
  document.roles.codeReviewer.primary = null;
  document.roles.codeReviewer.fallback = null;
  const full = 'claude-sonnet-example';
  const app = team.loadAppTeam('session.json', JSON.stringify({
    version: 1, team: [pin('sonnet', 'writer'), pin(full, 'reviewerFallback'), pin(full, 'arbiter')],
  }));
  const resolved = team.applyAppTeam(document, app);
  assert.equal(resolved.roles.writer.model, 'sonnet');
  assert.equal(resolved.roles.arbiter.model, full);
  assert.equal(resolved.roles.architect, null);
});

test('S1 routes the app Antigravity reviewer to the Google agy pin', () => {
  const reviewer = { ...pin('fixture-antigravity', 'reviewer'), provider: 'antigravity' };
  const app = team.loadAppTeam('project.json', JSON.stringify({ version: 1, team: [reviewer] }));
  const resolved = team.applyAppTeam(base(), app, 'codex');
  const { primary } = team.reviewChain(resolved, 'codex');
  assert.deepEqual(primary, { provider: 'agy', model: reviewer.model, effort: reviewer.effort });
  assert.equal(team.vendorOf(resolved, primary.provider), 'Google');
});

test('S1 refuses a reviewer with no vendor even when a fallback exists', () => {
  const reviewer = { ...pin('unknown-model', 'reviewer'), provider: 'unknown-provider' };
  const app = team.loadAppTeam('project.json', JSON.stringify({
    version: 1, team: [reviewer, pin(opus, 'reviewerFallback')],
  }));
  const resolved = team.applyAppTeam(base(), app, 'codex');
  assert.throws(() => team.reviewChain(resolved, 'codex'),
    /TEAM_ROLE_UNSET: Set the Code Reviewer in Settings → Team \(provider unknown-provider has no vendor\)/);
});

test('the session reviewerFallback becomes primary without appearing in its own fallback list', () => {
  const reviewer = { role: 'reviewer', provider: 'codex', model: 'reviewer-model', effort: 'high' };
  const app = team.loadAppTeam('session.json', JSON.stringify({
    version: 1, team: [reviewer, pin('opus', 'reviewerFallback'), pin(opus, 'arbiter')],
  }));
  const chain = team.reviewChain(team.applyAppTeam(base(), app, 'codex'), 'codex');
  assert.deepEqual(chain.primary, { provider: 'claude', model: 'opus', effort: 'high' });
  assert.deepEqual(chain.fallbacks, []);
  assert.deepEqual(team.reviewChain(team.applyAppTeam(base(), app, 'claude'), 'claude').fallbacks, []);
});

test('a reviewerFallback saved as opus needs no full model ID in the Team', () => {
  const reviewer = { role: 'reviewer', provider: 'gemini', model: 'pro', effort: 'high' };
  const app = team.loadAppTeam('session.json', JSON.stringify({
    version: 1, team: [reviewer, pin('opus', 'reviewerFallback')],
  }));
  const resolved = team.applyAppTeam(base(), app, 'codex');
  const fallback = team.reviewChain(resolved, 'codex').fallbacks[0];
  assert.equal(team.pinLabel(fallback), 'claude/opus/high');
  assert.equal(team.reviewerProblem(resolved, { slot: 'fallback', writer: 'codex', reviewer: fallback }), null);
});

test('TeamMember omission defaults to unset, while malformed member shapes fail closed', () => {
  const parse = member => team.loadAppTeam('session.json', JSON.stringify({ version: 1, team: [member] }));
  const required = { role: 'browserOperator', provider: 'claude' };
  const doc = parse(required);
  assert.deepEqual(doc.team, [{ ...required, model: null, effort: null }]);
  assert.throws(() => team.role(team.applyAppTeam(base(), doc), required.role), {
    message: team.unsetRole(required.role),
  });
  for (const patch of [
    { provider: '../claude' }, { model: '--option' }, { model: 'not a model token' },
    { model: 42 }, { effort: 'bad' }, { role: 'planReviewer', model: 'sonnet', effort: 'minimal' },
  ]) {
    assert.throws(() => parse({ ...required, ...patch }), /^Error: TEAM_FILE_INVALID:/);
  }
});


test('R13 role aliases survive resolution and still match full review receipt IDs', () => {
  const app = team.loadAppTeam('session.json', JSON.stringify({
    version: 1, team: [pin(opus, 'architect'), pin('opus', 'uiWriter'), pin('opus', 'reviewer'),
      { role: 'writer', provider: 'codex', model: 'settings-writer', effort: 'high' }],
  }));
  const resolved = team.applyAppTeam(base(), app, 'codex');
  assert.equal(team.role(resolved, 'uiWriter').model, 'opus');
  assert.equal(team.sameModel(resolved, 'claude', team.role(resolved, 'uiWriter').model, opus), true);
  assert.equal(team.reviewerProblem(resolved, {
    slot: 'primary', writer: 'codex', reviewer: pin(opus),
  }), null);
});


test('R13 primary review receipts accept a runtime model suffix', () => {
  const reviewer = { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high' };
  const resolved = team.applyAppTeam(base(), { team: [{ role: 'reviewer', ...reviewer }] }, 'claude');
  const entries = [{
    kind: 'team-review', status: 'completed', slot: 'primary', writer: 'claude', reviewer,
    verdict: 'CLEAN', evidence: { initModel: 'gpt-6.2-astra[1m]' },
  }];
  assert.deepEqual(team.checkReviewRounds({ team: resolved, entries }).problems, []);
});

test('redo: a host snapshot uses only the reviewer roles it carries', () => {
  const document = base();
  const teamMembers = [
    pin(opus, 'reviewer'),
    { role: 'investigator', provider: 'agy', model: 'gemini-4-neon', effort: 'xhigh' },
  ];
  const snapshot = team.loadAppTeam('fixture', JSON.stringify({ version: 1, hostReview: true, team: teamMembers }));
  const resolved = team.applyAppTeam(document, snapshot, 'claude');
  assert.equal(resolved.roles.codeReviewer.primary.provider, 'claude');
  assert.deepEqual(resolved.roles.codeReviewer.fallback.claude, []);
  assert.match(team.reviewerProblem(resolved, { writer: 'claude', slot: 'primary',
    reviewer: resolved.roles.codeReviewer.primary }), /same-vendor review/);
});
