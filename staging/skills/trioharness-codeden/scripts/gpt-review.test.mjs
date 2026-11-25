import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { gptReviewArgs, parseEvents, verifyGptRuntime, synthesizeReviewStream } from './gpt-review.mjs';
import { loadTeam, teamPolicyFile } from './team.mjs';
import { exportedTeam } from '../../../../.config/trioharness/team-export.mjs';

const temp = mkdtempSync(join(tmpdir(), 'gpt-review-team-'));
after(() => rmSync(temp, { recursive: true, force: true }));
const member = { role: 'reviewerFallback', provider: 'codex', model: 'codex-review-fixture', effort: 'high' };
const file = join(temp, 'team.json');
copyFileSync(teamPolicyFile(), teamPolicyFile(file));
writeFileSync(file, JSON.stringify(exportedTeam({ team: [member], sources: { reviewerFallback: 'default' } })));
const GPT_REVIEW_MODEL = loadTeam(file).roles.codeReviewer.fallback.claude[0].model;

test('gpt review reports the unset Settings role', () => {
  assert.throws(() => gptReviewArgs({ role: 'planReviewer' }),
    { message: 'TEAM_ROLE_UNSET: Set the Plan Reviewer in Settings → Team' });
  assert.throws(() => gptReviewArgs({ model: GPT_REVIEW_MODEL, effort: null }),
    { message: 'TEAM_ROLE_UNSET: Set the Code Reviewer Fallback in Settings → Team' });
});

const launch = { engine: 'codex', requestedModel: GPT_REVIEW_MODEL, requestedEffort: 'high', sandbox: 'read-only', ignoreUserConfig: true, noMcp: true, hooksDisabled: true, directApiKeyRemoved: true };
const ok = parseEvents('{"type":"thread.started"}\n{"type":"turn.started"}\nnot json\n{"type":"turn.completed","usage":{"input_tokens":10}}');
const verify = over => verifyGptRuntime({ launch, events: ok, lastMessage: 'REVIEW_DECISION: CLEAN', expectedModel: GPT_REVIEW_MODEL, expectedEffort: 'high', ...over });

test('gpt review: read-only, MCP-free, no user config, pinned model and effort', () => {
  const args = gptReviewArgs({ model: GPT_REVIEW_MODEL, effort: 'high', repo: 'C:/r', lastMessagePath: 'C:/o.txt' });
  const i = args.indexOf('--sandbox');
  assert.equal(args[i + 1], 'read-only');
  for (const f of ['--no-mcp', '--ignore-user-config', '--ephemeral', '--json']) assert.ok(args.includes(f), f);
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(args[args.indexOf('--model') + 1], GPT_REVIEW_MODEL);
  assert.ok(args.includes('model_reasoning_effort="high"'));
});
test('gpt review: verified only for a completed, isolated, subscription-auth run of the expected model', () => {
  assert.equal(verify().verified, true);
  assert.equal(verify({ events: parseEvents('{"type":"turn.started"}') }).verified, false);
  assert.equal(verify({ events: [...ok, { type: 'error', message: 'x' }] }).verified, false);
  assert.equal(verify({ events: [...ok, { type: 'x', model: 'gpt-5.6-sol' }] }).verified, false);
  assert.equal(verify({ lastMessage: '' }).verified, false);
  assert.equal(verify({ launch: { ...launch, sandbox: 'workspace-write' } }).verified, false);
  assert.equal(verify({ launch: { ...launch, directApiKeyRemoved: false } }).verified, false);
  assert.equal(verify({ expectedEffort: 'xhigh' }).verified, false);
  assert.match(verify().modelEvidence, /requested-only/);
});
test('gpt review: synthesized transcript matches the launcher terminal-record shape', () => {
  const lines = synthesizeReviewStream({ model: GPT_REVIEW_MODEL, effort: 'high', lastMessage: 'REVIEW_DECISION: CLEAN', events: ok, launch }).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'system'); assert.equal(lines[0].subtype, 'init'); assert.deepEqual(lines[0].mcp_servers, []);
  assert.equal(lines[1].type, 'result'); assert.equal(lines[1].is_error, false); assert.equal(lines[1].result, 'REVIEW_DECISION: CLEAN');
  const failed = synthesizeReviewStream({ model: GPT_REVIEW_MODEL, effort: 'high', lastMessage: '', events: [{ type: 'turn.failed' }], launch }).trim().split('\n').map(JSON.parse);
  assert.equal(failed[1].is_error, true);
});
