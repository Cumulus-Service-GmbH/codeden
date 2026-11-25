import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installed = existsSync(new URL('./arbiter.mjs', import.meta.url));
const { loadTeam, loadTeamPolicy, mirrorDigest } = await import('./team.mjs');
function exportedTeam({ team, sources }) {
  const mirror = { version: 1, generated: 'Fixture Team export', source: 'settings-effective-team', team, sources };
  return { ...mirror, generatedSha256: mirrorDigest(mirror) };
}
const { jevPrecheck } = await import(installed ? './arbiter.mjs' : '../../config/arbiter-lib.mjs');
const before = '2026-01-01T00:00:00.000Z';
const after = '2026-01-02T00:00:00.000Z';

function fixture(t, settings = {}, git = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jev-arbiter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, '.config', 'trioharness');
  const run = join(root, '.trioharness-direct', 'runs', 'r1');
  mkdirSync(config, { recursive: true });
  mkdirSync(run, { recursive: true });
  const policy = loadTeamPolicy();
  const members = [{ role: 'arbiter', provider: 'claude', model: 'claude-fable-5-2', effort: 'high' }];
  const policyFile = join(config, 'team-policy.json');
  writeFileSync(policyFile, JSON.stringify({
    ...policy,
    roles: { ...policy.roles, arbiter: { ...policy.roles.arbiter, jevAttempts: 3, jevReviewRounds: 2, ...settings } },
  }));
  writeFileSync(join(config, 'team.json'), JSON.stringify(exportedTeam({ team: members, sources: { arbiter: 'default' } })));
  const team = loadTeam(join(config, 'team.json'));
  writeFileSync(join(config, 'team-sync.mjs'), '');
  const input = join(root, 'input.json');
  const log = join(run, 'jev-receipts.jsonl');
  writeFileSync(input, '{}');
  const add = (file, row) => appendFileSync(join(run, file), JSON.stringify(row) + '\n');
  const refused = (gate, at = before) => add('jev-receipts.jsonl', { gate, at, verdict: 'revise', pass: false });
  const esc = row => add('ESCALATION.jsonl', { completedAt: after, ...row });
  const noFetch = "globalThis.fetch = () => { throw new Error('UNEXPECTED_NETWORK'); };";
  const env = { ...process.env, HOME: root, USERPROFILE: root, TEAM_FILE: '', TRIOHARNESS_TEAM_HOME: root, ...git };
  delete env.TYPE_SAFE_API_KEY;
  delete env.TYPESAFE_API_KEY;
  delete env.JEV_API_KEY;
  delete env.JEV_KEY_FILE;
  env.JEV_KEY_FILE = join(root, 'missing-key');
  const launch = (script, args, fetch = noFetch, extra = {}) => spawnSync(process.execPath, [
    '--import', 'data:text/javascript,' + encodeURIComponent(fetch), fileURLToPath(new URL(script, import.meta.url)), ...args
  ], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...env, ...extra }
  });
  function jev(gate, expected, flags = [], { recordsReceipt = false } = {}) {
    const previous = existsSync(log) ? readFileSync(log, 'utf8') : null;
    const result = launch('./jev.mjs', [gate, input, '--log', log, ...flags]);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, expected);
    if (recordsReceipt) {
      assert.match(JSON.parse(readFileSync(log, 'utf8')).reasons[0], expected);
    } else {
      assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : null, previous);
    }
  }
  const blocked = () => JSON.parse(readFileSync(join(run, 'ITEM_BLOCKED.json'), 'utf8'));
  const code = (verdict = 'FINDINGS', { head = 'candidate', slot = 'primary', severities, changed = false } = {}) => {
    const row = { kind: 'team-review', slot, status: 'completed', head, verdict };
    if (severities) {
      const findings = severities.map((severity, i) =>
        `- ID: R${i + 1} | SEVERITY: ${severity} | FILE: src/a.js:1 | PROBLEM: example | EVIDENCE: e | MINIMAL FIX: f`);
      const report = `REVIEW_DECISION: FINDINGS\nFINDINGS:\n${findings.join('\n')}\n`;
      row.round = slot === 'second-pass' ? 'r2' : 'r1';
      row.output = join(run, `${slot}.md`);
      row.outputSha256 = createHash('sha256').update(report).digest('hex');
      writeFileSync(row.output, changed ? report + '\n' : report);
    }
    add('CODE_REVIEW_ROUNDS.jsonl', row);
  };
  return { root, run, input, team, teamFile: join(config, 'team.json'), policyFile, add, refused, esc, launch, jev, blocked, code };
}

test('Jev refuses ITEM_BLOCKED before reservation and leaves receipts untouched', t => {
  const f = fixture(t);
  f.add('ITEM_BLOCKED.json', { reason: 'owner decision' });
  f.jev('plan', /ITEM_BLOCKED/, ['--attempt-repo', f.root, '--attempt-run', 'r1']);
  assert.equal(existsSync(join(f.run, 'state.json')), false);
  f.jev('done', /ITEM_BLOCKED/);
});

test('Jev refuses the total-round ceiling and blocks the item', t => {
  const f = fixture(t, { totalRounds: 1 });
  f.code('CLEAN');
  f.jev('plan', /ROUNDS_CEILING/);
  assert.match(f.blocked().reason, /ROUNDS_CEILING/);
});

test('Jev refuses the per-gate attempt cap and blocks the item', t => {
  const f = headFixture(t, 2, { jevAttempts: 1 });
  f.code('CLEAN', { head: f.head });
  f.refused('plan');
  assert.doesNotThrow(() => jevPrecheck(f.team, f.run, 'done'));
  f.jev('plan', /JEV_ATTEMPT_CAP/);
  assert.match(f.blocked().reason, /JEV_ATTEMPT_CAP/);
});

test('Jev requires J completed same-gate reviews after the first refusal', t => {
  const f = fixture(t);
  f.refused('plan');
  f.esc({ kind: 'jev-review', scope: 'jev-done', status: 'completed' });
  f.esc({ kind: 'jev-review', scope: 'jev-plan', status: 'completed', completedAt: before });
  f.esc({ kind: 'jev-review', scope: 'jev-plan', status: 'completed' });
  f.jev('plan', /JEV_REVIEW_REQUIRED: 1 of 2/);
  f.esc({ kind: 'jev-review', scope: 'jev-plan', status: 'completed' });
  assert.doesNotThrow(() => jevPrecheck(f.team, f.run, 'plan'));
});

test('Jev requires a final Arbiter APPROVE for the same gate after the second refusal', t => {
  const f = headFixture(t, 2, { callsPerItem: 3 });
  f.code('CLEAN', { head: f.head });
  f.refused('done');
  f.refused('done');
  const ruling = { kind: 'arbiter', mode: 'ruling', status: 'completed', decision: 'APPROVE', rulings: [] };
  f.esc({ ...ruling, scope: 'jev-plan' });
  f.esc({ ...ruling, scope: 'jev-done', rulings: [{ id: 'j1', ruling: 'VALID-must-fix' }] });
  f.jev('done', /ARBITER_REQUIRED/);
  f.esc({ ...ruling, scope: 'jev-done' });
  assert.throws(() => jevPrecheck(f.team, f.run, 'done'), /ARBITER_FINAL/);
  const blocked = headFixture(t, 2, { callsPerItem: 3 });
  blocked.code('CLEAN', { head: blocked.head });
  blocked.refused('done');
  blocked.refused('done');
  blocked.esc({ ...ruling, scope: 'jev-done', decision: 'BLOCK' });
  blocked.jev('done', /ARBITER_BLOCK/);
});

test('Jev blocks when there are no Arbiter calls left for a required ruling', t => {
  const f = fixture(t, { callsPerItem: 1 });
  f.refused('plan');
  f.refused('plan');
  f.esc({ kind: 'arbiter', scope: 'jev-done', status: 'unavailable' });
  f.jev('plan', /ARBITER_CAP/);
  assert.match(f.blocked().reason, /ARBITER_CAP/);
});

test('Jev done refuses pending code review and code escalation', t => {
  const pending = fixture(t, { reviewFixRounds: 2 });
  pending.code();
  pending.jev('done', /CODE_REVIEW_PENDING/);
  const due = fixture(t, { reviewFixRounds: 1 });
  due.code();
  due.jev('done', /ARBITER_REQUIRED: the code stage is ruling/);
  due.esc({ kind: 'arbiter', scope: 'code', mode: 'ruling', status: 'completed', decision: 'APPROVE',
    rulings: [{ id: 'r1', ruling: 'VALID-must-fix' }] });
  due.jev('done', /ARBITER_REQUIRED: the code stage is confirm/);
});

function headFixture(t, reviewFixRounds = 1, settings = {}) {
  const f = fixture(t, { reviewFixRounds, ...settings });
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--template=');
  git('-c', 'user.name=Jev Test', '-c', 'user.email=jev-test@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--allow-empty', '--no-gpg-sign', '--quiet', '-m', 'Test HEAD');
  return { ...f, head: git('rev-parse', 'HEAD') };
}

test('Jev done requires an Arbiter ruling when a MEDIUM on HEAD makes escalation due', t => {
  const f = headFixture(t, 1);
  f.code('FINDINGS', { head: f.head, severities: ['MEDIUM'] });
  f.jev('done', /ARBITER_REQUIRED: the code stage is ruling/);
});

test('Jev done blocks when a code ruling on HEAD is due and Arbiter calls are exhausted', t => {
  const f = headFixture(t, 1, { callsPerItem: 1 });
  f.code('FINDINGS', { head: f.head, severities: ['MEDIUM'] });
  f.esc({ kind: 'arbiter', scope: 'plan', status: 'unavailable' });
  f.jev('done', /ARBITER_CAP/);
  assert.match(f.blocked().reason, /ARBITER_CAP/);
});

test('Jev done requires an ordinary review on HEAD even with a clean second pass', t => {
  const f = headFixture(t);
  f.code('CLEAN', { head: f.head, slot: 'second-pass' });
  f.jev('done', /CODE_REVIEW_PENDING/);
});

test('Jev done refuses a clean review when Git cannot resolve an explicitly configured repository', t => {
  const f = fixture(t, { reviewFixRounds: 1 }, { GIT_DIR: 'missing.git' });
  f.code('CLEAN');
  f.jev('done', /CODE_REVIEW_PENDING/);
});

test('Jev done refuses a clean review when a corrupt worktree looks standalone to Git', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, '.git'));
  f.code('CLEAN');
  f.jev('done', /CODE_REVIEW_PENDING/);
});

test('Jev done accepts a LOW-only primary and second pass on HEAD', t => {
  const f = headFixture(t);
  f.code('FINDINGS', { head: f.head, severities: ['LOW'] });
  f.code('FINDINGS', { head: f.head, slot: 'second-pass', severities: ['LOW'] });
  f.jev('done', /INPUT_MISSING:criteria/, [], { recordsReceipt: true });
});

test('Jev done requires a code review receipt on HEAD', t => {
  headFixture(t).jev('done', /CODE_REVIEW_PENDING/);
});

test('Jev done refuses a code review receipt for a different SHA', t => {
  const f = headFixture(t);
  f.code('CLEAN', { head: '0'.repeat(f.head.length) });
  f.jev('done', /CODE_REVIEW_PENDING/);
});

test('Jev done refuses a MEDIUM finding among LOWs even after a LOW-only second pass', t => {
  const f = headFixture(t, 2);
  f.code('FINDINGS', { head: f.head, severities: ['LOW', 'MEDIUM', 'LOW'] });
  f.code('FINDINGS', { head: f.head, slot: 'second-pass', severities: ['LOW'] });
  f.jev('done', /CODE_REVIEW_PENDING/);
});

for (const report of ['missing', 'changed']) {
  test(`Jev done refuses a ${report} FINDINGS report on HEAD`, t => {
    const f = headFixture(t, 2);
    f.code('FINDINGS', { head: f.head, ...(report === 'changed' && { severities: ['LOW'], changed: true }) });
    f.code('CLEAN', { head: f.head, slot: 'second-pass' });
    f.jev('done', /CODE_REVIEW_PENDING/);
  });
}

test('invoke-lane refuses the reviewer role once code escalation is due', t => {
  const f = fixture(t, { reviewFixRounds: 1 });
  f.code();
  const result = f.launch('./invoke-lane.mjs', ['--role', 'reviewer', '--repo', f.root,
    '--prompt', f.input, '--output', join(f.run, 'workers', 'review.md'), '--dry-run']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ARBITER_REQUIRED: the code stage is ruling/);
});


test('invoke-lane refuses the gpt-engine reviewer once code escalation is due', t => {
  const f = fixture(t, { reviewFixRounds: 1 });
  f.code();
  const result = f.launch('./invoke-lane.mjs', ['--role', 'reviewer', '--review-engine', 'gpt', '--repo', f.root,
    '--prompt', f.input, '--output', join(f.run, 'workers', 'review.md'), '--dry-run']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ARBITER_REQUIRED: the code stage is ruling/);
});

test('invoke-lane reviewer-opus rejects Team drift through the checked load', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.config', 'trioharness', 'team-sync.mjs'), 'process.exit(1);');
  const result = f.launch('./invoke-lane.mjs', ['--role', 'reviewer-opus', '--repo', f.root,
    '--prompt', f.input, '--output', join(f.run, 'workers', 'review.md'), '--dry-run']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEAM_DRIFT/);
});

test('Jev counts custom run logs across submissions and blocks when a refusal reaches the cap', t => {
  const f = headFixture(t, 2, { jevAttempts: 2, jevReviewRounds: 1 });
  f.code('CLEAN', { head: f.head });
  writeFileSync(f.input, JSON.stringify({ objective: 'Render the title', criteria: ['Title renders'], evidence: ['Title is missing'] }));
  const fetch = `globalThis.fetch = async () => ({ ok: true, json: async () => ({
    model: 'fixture', answers: { failing: { type: 'noul', noul: 0 }, unsupported: { type: 'noul', noul: 0 }, met_0: { type: 'noul', noul: 0 } }
  }) });`;
  function submit(log) {
    const result = f.launch('./jev.mjs', ['done', f.input, '--log', join(f.run, log)], fetch, {
      TYPESAFE_API_KEY: randomUUID(), JEV_API_KEY: ''
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).verdict, 'revise');
  }
  submit('first.jsonl');
  f.jev('done', /JEV_REVIEW_REQUIRED/);
  f.esc({ kind: 'jev-review', scope: 'jev-done', status: 'completed', completedAt: '2099-01-01T00:00:00.000Z' });
  submit('second.jsonl');
  assert.match(f.blocked().reason, /JEV_ATTEMPT_CAP/);
  assert.equal(f.blocked().usage.jev, 2);
});


test('Jev reports unavailable when the Team policy has no Arbiter limits', t => {
  const f = fixture(t);
  const policy = loadTeamPolicy(f.policyFile);
  delete policy.roles.arbiter;
  writeFileSync(f.policyFile, JSON.stringify(policy));
  const log = join(f.run, 'jev-receipts.jsonl');
  const result = f.launch('./jev.mjs', ['done', f.input, '--log', log]);
  assert.match(result.stderr, /TEAM_INVALID: roles\.arbiter\.reviewFixRounds/);
  assert.equal(JSON.parse(result.stdout).verdict, 'unavailable');
  assert.equal(existsSync(log), false);
});
