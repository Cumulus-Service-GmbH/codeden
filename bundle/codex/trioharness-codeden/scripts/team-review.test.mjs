// GENERATED: copy of ~/.config/trioharness/skill-scripts/team-review.test.mjs written by team-sync.mjs, don't edit by hand.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { reservePlanReview } from './team-role.mjs';
const arb = await import(existsSync(new URL('./arbiter.mjs', import.meta.url)) ? './arbiter.mjs' : '../arbiter-lib.mjs');
import * as review from './team-review.mjs';
const { changedPaths, checkRun, readRounds, ROUNDS, RUNS, scanPacket } = review;
const { applyAppTeam, canonicalModel, loadAppTeam, loadTeam, loadTeamPolicy, reviewChain, reviewerProblem, role, teamForWriter, teamDir, teamFile, validateTeam, vendorOf } = await import(
  existsSync(new URL('./team.mjs', import.meta.url)) ? './team.mjs' : '../team-lib.mjs'
);
const { teamBlock } = await import(pathToFileURL(join(teamDir(), 'team-sync.mjs')).href);
const { exportedTeam } = await import(pathToFileURL(join(teamDir(), 'team-export.mjs')).href);
// The review tests below drive the Neon wrapper, so they run on a fixture Team whose primary is Neon, whatever the
// live team.json says.
const policy = loadTeamPolicy();
const neonPrimary = { provider: 'agy', model: 'gemini-4-neon', effort: 'high' };
const codexWriter = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'medium' };
const investigator = { ...codexWriter, effort: 'high' };
const browserOperator = { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
const fixtureTeamText = JSON.stringify({ ...policy, roles: { ...policy.roles, writer: codexWriter, investigator,
  browserOperator, codeReviewer: { ...policy.roles.codeReviewer, primary: neonPrimary,
  fallback: { codex: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }], claude: [{ provider: 'codex', model: 'gpt-6.2-astra', effort: 'high' }] } } } }, null, 2);
const team = validateTeam(JSON.parse(fixtureTeamText));
Object.defineProperty(team, 'sha256', { value: createHash('sha256').update(fixtureTeamText).digest('hex'), enumerable: false });
const clean = 'REVIEW_DECISION: CLEAN\n';
const packetText = 'Review this candidate';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const reason = 'quota: Neon unavailable';
const rule = 'The second pass on high-risk changes (auth, tenant isolation, durable data, migrations, the skill\'s High-risk paths) is a fresh primary run; only if that primary second pass exits 3 does the fallback run it (the exit-3 reason is recorded). If the primary exits 3 on the first pass, the fallback is allowed and sufficient, and a second, fresh fallback run is the second pass.';

const testRoot = process.env.TRIOHARNESS_TEST_ROOT || join(userInfo().homedir, '.cache', 'trioharness-tests');
function putFixtureTeam(config, members, fixturePolicy = policy) {
  const team = Object.entries(members).map(([role, pin]) => ({ role, ...pin }));
  const sources = Object.fromEntries(team.map(({ role }) => [role, 'default']));
  writeFileSync(join(config, 'team.json'), JSON.stringify(exportedTeam({ team, sources })));
  writeFileSync(join(config, 'team-policy.json'), JSON.stringify(fixturePolicy));
  writeFileSync(join(config, 'team-sync.mjs'), '// Generation is covered separately.\n');
}

function fixture(t, writer = 'claude', { codex = true, arbiter, limits } = {}) {
  const parent = codex ? testRoot : tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const repo = realpathSync(mkdtempSync(join(parent, 'team-review-test-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dir = join(repo, ...RUNS, 'r1');
  const bin = join(repo, '.codex', 'bin');
  const config = join(repo, '.config', 'trioharness');
  for (const d of [dir, bin, config]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}');
  for (const d of ['.local/bin', '.claude/hooks']) mkdirSync(join(repo, d), { recursive: true });
  if (codex) copyFileSync(fileURLToPath(import.meta.resolve(pathToFileURL(join(userInfo().homedir, '.config', 'trioharness', 'codex-hook-trust.mjs')).href)), join(config, 'codex-hook-trust.mjs'));
  writeFileSync(join(repo, '.claude', 'hooks', 'codeden-guard.mjs'), '// fixture guard\n');
  writeFileSync(join(repo, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Agent|spawn_agent',
    hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(repo, '.claude', 'hooks', 'codeden-guard.mjs'))} codex`, timeout: 10 }] }] } }));
  const git = (...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', input: '',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  }).trim();
  git('init', '--quiet');
  const tree = git('mktree');
  git('update-ref', 'HEAD', git('commit-tree', tree, '-m', 'Fixture'));
  const base = git('rev-parse', 'HEAD');
  const commit = (files, remove = []) => {
    for (const path of remove) rmSync(join(repo, path));
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), bytes);
    }
    git('add', '--all', '--', ...Object.keys(files), ...remove);
    git('commit', '--quiet', '-m', 'Candidate');
  };
  commit({ 'candidate.js': 'export const answer = 42;\n' });
  putFixtureTeam(config, {
    reviewer: neonPrimary, reviewerFallback: team.roles.codeReviewer.fallback[writer][0],
    writer: codexWriter, investigator, ...(arbiter ? { arbiter } : {}),
  }, { ...policy, roles: { ...policy.roles, arbiter: { ...policy.roles.arbiter, ...limits } } });
  const preload = join(repo, 'home.mjs');
  writeFileSync(preload, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.userInfo = () => ({ homedir: ${JSON.stringify(repo)} });
syncBuiltinESMExports();\n`);
  const primary = team.roles.codeReviewer.primary;
  const fallback = team.roles.codeReviewer.fallback[writer][0];
  writeFileSync(join(bin, 'gemini-review.mjs'), `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const evPath = process.argv[process.argv.indexOf('--evidence') + 1];
const second = /code-reviewer-2-part/.test(evPath);
const packetPath = process.argv[process.argv.indexOf('--packet') + 1];
const packet = readFileSync(packetPath, 'utf8');
const part = Number(packet.match(/^PART (\\d+) of /m)?.[1] || 1);
if (process.env.STUB_REQUIRE && !packet.includes(process.env.STUB_REQUIRE)) process.exit(1);
appendFileSync(process.env.STUB_CALLS, JSON.stringify(['primary', packetPath, evPath, packet, process.argv.slice(2)]) + '\\n');
if (process.env.STUB_MUTATE_PACKET) writeFileSync(process.env.STUB_PACKET, 'Changed during review');
const failThisRound = !process.env.STUB_PART_FAILURE_SECOND_ONLY || second;
const exit = failThisRound && part === Number(process.env.STUB_UNAVAILABLE_PART) ? 3 : Number((second && process.env.STUB_SECOND_EXIT) || process.env.STUB_EXIT);
if (process.env.STUB_SKIP_EVIDENCE) { process.stdout.write(process.env.STUB_PRIMARY); process.exit(exit); }
const responseEvidence = JSON.parse(process.env.STUB_RESPONSE_EVIDENCE || '{}');
writeFileSync(process.argv[process.argv.indexOf('--evidence') + 1], JSON.stringify(exit === 3
  ? { fallbackReason: process.env.STUB_REASON || ${JSON.stringify(reason)}, ...responseEvidence } : { initModel: process.env.STUB_INIT_MODEL || ${JSON.stringify(primary.model)} }));
process.stdout.write(part === Number(process.env.STUB_INCOMPLETE_PART) ? 'missing context' : failThisRound && part === Number(process.env.STUB_FINDINGS_PART) ? 'REVIEW_DECISION: FINDINGS\\n' : (second && process.env.STUB_SECOND_PRIMARY) || process.env.STUB_PRIMARY);
process.exitCode = exit;
`);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const launched = Object.keys(process.env);
Object.assign(process.env, JSON.parse(fs.readFileSync(${JSON.stringify(join(bin, 'codex-env.json'))}, 'utf8')));
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(['fallback', fs.readFileSync(0, 'utf8'), process.argv.slice(2), launched]) + '\\n');
fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], process.env.STUB_FALLBACK);
console.error('model: ${fallback.model}\\nprovider: openai\\nreasoning effort: ${fallback.effort}\\nsandbox: read-only');
`, { mode: 0o755 });
  symlinkSync(join(bin, 'codex'), join(repo, '.local', 'bin', 'codex'));
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
if (process.env.STUB_REQUIRE_START) {
  const rows = fs.readFileSync(process.env.STUB_REQUIRE_START, 'utf8').trim().split('\\n').map(JSON.parse);
  if (!rows.some(row => row.kind === 'arbiter-start' && row.id && row.status === 'dispatched')) process.exit(1);
}
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(['fallback', fs.readFileSync(0, 'utf8'), process.argv.slice(2)]) + '\\n');
if (process.env.STUB_CLAUDE_ERROR) console.error(process.env.STUB_CLAUDE_ERROR);
if (process.env.STUB_CLAUDE_EXIT) process.exit(Number(process.env.STUB_CLAUDE_EXIT));
const modelUsage = JSON.parse(process.env.STUB_CLAUDE_USAGE || 'null') ??
  { [process.env.STUB_CLAUDE_MODEL || '${fallback.model}']: { outputTokens: 10 } };
console.log(process.env.STUB_CLAUDE_RAW ?? JSON.stringify({ result: process.env.STUB_FALLBACK, modelUsage }));
`, { mode: 0o755 });
  const packet = join(repo, 'packet.md');
  const output = join(repo, 'external.md');
  writeFileSync(packet, packetText);
  const call = (cmd, args, overrides) => (writeFileSync(join(bin, 'codex-env.json'), JSON.stringify(Object.fromEntries(Object.entries({ ...process.env,
    STUB_CALLS: join(repo, 'calls.jsonl'), STUB_PACKET: packet, STUB_EXIT: '3', STUB_PRIMARY: clean, STUB_FALLBACK: clean, ...overrides,
  }).filter(([k]) => k.startsWith('STUB_'))))), spawnSync(process.execPath, [
    '--import', preload, fileURLToPath(new URL('./team-review.mjs', import.meta.url)),
    cmd, '--repo', repo, '--run', 'r1', '--writer', writer, ...args,
  ], { encoding: 'utf8', env: {
    ...process.env, TRIOHARNESS_TEAM_HOME: repo, PATH: bin + delimiter + process.env.PATH,
    TEAM_FILE: '', CODEX_HOME: join(repo, '.codex'), STUB_CALLS: join(repo, 'calls.jsonl'), STUB_PACKET: packet, STUB_EXIT: '3', STUB_PRIMARY: clean, STUB_FALLBACK: clean, ...overrides,
  } }));
  return {
    git, commit, repo, base, dir, call,
    run: (args = [], env) => call('run', ['--base', base, '--packet', packet, ...args], env),
    writePacket: text => writeFileSync(packet, text),
    record: (slot, args = [], withPacket = true) => call('record', ['--slot', slot, '--provider', fallback.provider,
      '--model', fallback.model, '--effort', fallback.effort, '--reason', 'manual', '--output', output, ...(withPacket && slot !== 'native-factory' ? ['--packet', packet] : []), ...args]),
    calls: () => readFileSync(join(repo, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse),
    report: text => writeFileSync(output, text),
    rounds: () => {
      const entries = readRounds(repo, 'r1');
      assert.ok(entries.every(e => e.schema === 2));
      return entries;
    },
    rewrite: entries => writeFileSync(join(dir, ROUNDS), entries.map(e => JSON.stringify(e)).join('\n') + '\n'),
    check: () => checkRun(repo, 'r1', base, team),
  };
}

function status(result, expected) {
  assert.equal(result.status, expected, result.stderr + result.stdout);
}

test('stub reviewer NEED_CONTEXT is incomplete and the gate refuses', t => {
  const f = fixture(t);
  status(f.run([], { STUB_FALLBACK: 'NEED_CONTEXT: src/a.js:10 + caller missing\n' }), 2);
  const entry = f.rounds().at(-1);
  assert.equal(entry.status, 'incomplete');
  assert.equal(entry.slot, 'fallback');
  assert.equal(entry.reviewer.provider, 'codex');
  assert.ok(entry.round && entry.reason);
  assert.equal(f.check().ok, false);
});

test('template, fenced and indented decisions do not count', t => {
  const f = fixture(t);
  for (const text of [
    'REVIEW_DECISION: CLEAN | FINDINGS\n',
    '    REVIEW_DECISION: CLEAN\n\tREVIEW_DECISION: CLEAN\n',
    '   ~~~~ markdown\n~~~\n````\n~~~~ trailing\nREVIEW_DECISION: CLEAN\n~~~~~\n',
    '````\n```\nREVIEW_DECISION: CLEAN\n````\n',
  ]) {
    status(f.run([], { STUB_EXIT: '0', STUB_PRIMARY: text }), 2);
    assert.equal(f.rounds().at(-1).status, 'incomplete');
  }
  status(f.run([], { STUB_EXIT: '0', STUB_PRIMARY: '   ```md\r\n````\r\n   REVIEW_DECISION: FINDINGS\r\n' }), 0);
  assert.equal(f.check().ok, true);
});

test('record validates reviewer, slot and required arguments before appending', t => {
  const f = fixture(t);
  f.report('NEED_CONTEXT: missing caller\n');
  for (const [slot, args] of [['second-pass', ['--model', 'wrong']], ['wrong', []], ['second-pass', ['--effort', '']]]) {
    status(f.record(slot, args), 2);
    assert.deepEqual(f.rounds(), []);
  }
  status(f.record('second-pass'), 2);
  assert.deepEqual(f.rounds(), []);
  status(f.run(), 0);
  f.writePacket(f.calls().at(-1)[1]);
  status(f.record('second-pass'), 2);
  assert.equal(f.rounds().at(-1).status, 'incomplete');
  status(f.record('native-factory'), 0);
  assert.equal(f.check().ok, true);
});

test('exit 3 authorizes fallback with recorded evidence', t => {
  const f = fixture(t, 'codex');
  status(f.run(), 0);
  const [primary, fallback] = f.rounds();
  assert.equal(primary.evidence.fallbackReason, reason);
  assert.equal(fallback.fallbackReason, reason);
  assert.equal(f.check().ok, true);
  f.report(clean);
  f.writePacket(f.calls().at(-1)[1]);
  status(f.record('fallback'), 0);
  assert.equal(f.rounds().at(-1).fallbackReason, reason);
  f.rewrite([fallback]);
  assert.equal(f.check().ok, false);
  f.rewrite([{ ...primary, head: 'other-head' }, fallback]);
  assert.equal(f.check().ok, false);
});

test('high-risk primary invokes Neon twice on the same packet with fresh evidence', t => {
  const f = fixture(t);
  status(f.run(['--high-risk'], { STUB_EXIT: '0', STUB_MUTATE_PACKET: '1' }), 0);
  const [base, second] = f.rounds();
  assert.deepEqual(f.calls().map(([role]) => role), ['primary', 'primary']);
  const built = f.calls()[0][3];
  assert.deepEqual(f.calls().map(call => call[3]), [built, built]);
  const packetSha256 = digest(built);
  assert.equal(second.outputSha256, base.outputSha256);
  assert.equal(base.packetSha256, packetSha256);
  assert.equal(second.packetSha256, packetSha256);
  assert.equal(second.secondPassRule, 'neon-first');
  assert.notEqual(f.calls()[0][2], f.calls()[1][2]);
  assert.equal(second.slot, 'second-pass');
  assert.equal(second.head, base.head);
  assert.deepEqual(second.reviewer, base.reviewer);
  assert.equal(f.check().ok, true);
  for (const patch of [
    { output: base.output }, { packetSha256: 'f'.repeat(64) },
    { evidence: base.evidence }, { head: 'other-head' },
  ]) {
    f.rewrite([base, { ...second, ...patch }]);
    assert.equal(f.check().ok, false);
  }
});

test('only the second-pass Neon exit 3 allows a fallback after a primary verdict', t => {
  const f = fixture(t, 'codex');
  const response = 'Invalid second review';
  const responseSha256 = createHash('sha256').update(response).digest('hex');
  status(f.run(['--high-risk'], {
    STUB_EXIT: '0', STUB_SECOND_EXIT: '3', STUB_MUTATE_PACKET: '1', STUB_REASON: 'invalid-output: second pass',
    STUB_RESPONSE_EVIDENCE: JSON.stringify({ response, responseSha256 }),
  }), 0);
  assert.deepEqual(f.calls().map(([role]) => role), ['primary', 'primary', 'fallback']);
  const [base, unavailable, second] = f.rounds();
  const built = f.calls()[0][3];
  const packetSha256 = digest(built);
  assert.deepEqual(f.calls().map(call => call[0] === 'primary' ? call[3] : call[1]), [built, built, built]);
  assert.ok([base, unavailable, second].every(e => e.packetSha256 === packetSha256));
  assert.ok([unavailable, second].every(e => e.secondPassRule === 'neon-first'));
  assert.equal(unavailable.slot, 'second-pass');
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.outputSha256, responseSha256);
  assert.equal(readFileSync(unavailable.output, 'utf8'), response);
  assert.equal(second.slot, 'second-pass');
  assert.equal(second.primaryExitId, unavailable.id);
  assert.equal(second.fallbackReason, unavailable.reason);
  assert.equal(f.check().ok, true);
  f.report(clean);
  status(f.record('second-pass'), 2);
  status(f.record('second-pass', ['--fallback-reason', 'wrong']), 2);
  const recordArgs = ['--fallback-reason', unavailable.reason];
  const wrongPacket = f.record('second-pass', recordArgs);
  status(wrongPacket, 2);
  assert.match(wrongPacket.stderr, /FALLBACK_REFUSED: .*packet/i);
  f.writePacket(built);
  f.rewrite([{ ...base, packetSha256: 'a'.repeat(64) }, unavailable, second]);
  status(f.record('second-pass', recordArgs), 2);
  f.rewrite([base, unavailable, second]);
  status(f.record('second-pass', recordArgs), 0);
  assert.equal(f.rounds().at(-1).packetSha256, packetSha256);
  assert.equal(f.rounds().at(-1).primaryExitId, unavailable.id);
  assert.equal(f.rounds().at(-1).secondPassRule, 'neon-first');
  assert.equal(f.check().ok, true);
  for (const entries of [
    [base, second], [base, unavailable, { ...second, primaryExitId: null }],
    [base, unavailable, { ...second, fallbackReason: 'wrong' }],
    [base, { ...unavailable, head: 'other-head' }, second],
    [base, { ...unavailable, slot: 'primary' }, second], [unavailable, base, second],
  ]) {
    f.rewrite(entries);
    assert.match(f.check().problems.join('\n'), /FALLBACK_REFUSED/);
  }
  f.rewrite([base]);
  status(f.record('second-pass', ['--fallback-reason', unavailable.reason]), 2);
  status(f.run(['--high-risk', '--fallback', unavailable.reason]), 2);
  assert.deepEqual(f.calls().map(([role]) => role), ['primary', 'primary', 'fallback']);
});

test('high-risk fallback requires two fresh runs and never parks', t => {
  const f = fixture(t);
  status(f.run(['--high-risk']), 0);
  const entries = f.rounds();
  const completed = entries.filter(e => e.status === 'completed');
  assert.deepEqual(completed.map(e => e.slot), ['fallback', 'second-pass']);
  assert.deepEqual(f.calls().map(([role]) => role), ['primary', 'fallback', 'fallback']);
  assert.notEqual(completed[0].output, completed[1].output);
  assert.ok(completed.every(e => e.fallbackReason === reason));
  assert.ok(entries.every(e => !['park', 'parked', 'attempt'].includes(e.status)));
  assert.equal(f.check().ok, true);
  f.rewrite([entries[0], completed[0], { ...completed[1], output: completed[0].output }]);
  assert.equal(f.check().ok, false);
  f.rewrite(entries.filter(e => e.slot !== 'second-pass'));
  assert.equal(f.check().ok, false);
});

test('external fallback rounds require the reviewed packet and record its hash', t => {
  const f = fixture(t);
  status(f.run(['--high-risk']), 0);
  const entries = f.rounds();
  const built = f.calls().at(-1)[1];
  const packetSha256 = digest(built);
  f.report(clean);
  for (const slot of ['fallback', 'second-pass']) {
    const missingPacket = f.record(slot, [], false);
    status(missingPacket, 2);
    assert.match(missingPacket.stderr, /--packet/);
    f.writePacket(packetText + '\n');
    const wrongPacket = f.record(slot);
    status(wrongPacket, 2);
    assert.match(wrongPacket.stderr, /FALLBACK_REFUSED: .*packet/i);
    assert.deepEqual(f.rounds(), entries);
    f.writePacket(built);
    status(f.record(slot), 0);
    assert.equal(f.rounds().at(-1).packetSha256, packetSha256);
    f.rewrite(entries);
  }
  f.rewrite(entries.map(e => e.slot === 'fallback' ? { ...e, packetSha256: 'a'.repeat(64) } : e));
  const wrongBasePacket = f.record('second-pass');
  status(wrongBasePacket, 2);
  assert.match(wrongBasePacket.stderr, /FALLBACK_REFUSED: .*packet/i);
});

test('run fallback requires the recorded primary exit-3 reason', t => {
  const f = fixture(t);
  status(f.run(), 0);
  const [unavailable] = f.rounds();
  f.rewrite([unavailable]);
  const wrongReason = f.run(['--fallback', 'manual']);
  status(wrongReason, 2);
  assert.ok(wrongReason.stderr.includes(reason));
  assert.deepEqual(f.calls().map(([role]) => role), ['primary', 'fallback']);
  status(f.run(['--fallback', reason]), 0);
  assert.deepEqual(f.calls().map(([role]) => role), ['primary', 'fallback', 'fallback']);
});

test('exit 3 with an empty response leaves an empty part report and runs the fallback', t => {
  const f = fixture(t);
  status(f.run([], {
    STUB_RESPONSE_EVIDENCE: JSON.stringify({ response: '', responseSha256: createHash('sha256').update('').digest('hex') }),
  }), 0);
  const [primary, fallback] = f.rounds();
  assert.equal(primary.status, 'unavailable');
  assert.equal(primary.output, null);
  assert.equal(primary.outputSha256, undefined);
  assert.equal(readFileSync(primary.partReports[0].output, 'utf8'), '');
  assert.equal(fallback.slot, 'fallback');
  assert.equal(f.check().ok, true);
});

test('invalid primary output is preserved while the fallback passes the gate', t => {
  const f = fixture(t);
  const fallbackReason = 'invalid-output: no successful transport result';
  const response = '**REVIEW_DECISION: FINDINGS**\r\n- HIGH: missing validation';
  const responseSha256 = createHash('sha256').update(response).digest('hex');
  status(f.run([], {
    STUB_REASON: fallbackReason, STUB_PRIMARY: '',
    STUB_RESPONSE_EVIDENCE: JSON.stringify({ response, responseSha256 }),
  }), 0);
  const [primary, fallback] = f.rounds();
  assert.equal(primary.status, 'unavailable');
  assert.equal(primary.evidence.fallbackReason, fallbackReason);
  assert.ok(primary.output?.endsWith('/workers/code-reviewer-1-part1.md'));
  assert.deepEqual(readFileSync(primary.output), Buffer.from(response));
  assert.equal(primary.outputSha256, responseSha256);
  assert.equal(fallback.slot, 'fallback');
  assert.equal(fallback.status, 'completed');
  assert.equal(fallback.fallbackReason, fallbackReason);
  assert.equal(f.check().ok, true);
});

test('fallback is refused after a primary verdict, with or without a later exit 3', t => {
  const f = fixture(t);
  status(f.run([], { STUB_EXIT: '0' }), 0);
  f.report(clean);
  status(f.record('fallback'), 2);
  assert.equal(f.rounds().at(-1).status, 'refused');
  status(f.run(['--fallback', 'manual']), 2);
  assert.equal(f.rounds().at(-1).status, 'refused');
  status(f.run(), 2);
  assert.equal(f.rounds().at(-1).status, 'refused');
  assert.equal(f.check().ok, true);
});

test('later primary verdict preserves the earlier authorized fallback', t => {
  const f = fixture(t);
  status(f.run(), 0);
  status(f.run([], { STUB_EXIT: '0' }), 0);
  assert.equal(f.check().ok, true);
  const [exit, fallback, primary] = f.rounds();
  f.rewrite([exit, { ...primary, round: fallback.round }, fallback]);
  assert.equal(f.check().ok, false);
  f.rewrite([primary, exit, fallback]);
  assert.equal(f.check().ok, false);
});

test('gate rejects missing verdicts and incomplete rounds supersede earlier rounds by timestamp', t => {
  const f = fixture(t);
  status(f.run([], { STUB_EXIT: '0' }), 0);
  const [primary] = f.rounds();
  const { verdict, ...missing } = primary;
  f.rewrite([missing]);
  assert.equal(f.check().ok, false);
  f.rewrite([primary, { ...primary, status: 'incomplete', completedAt: '2099-01-01T01:00:00+01:00' }]);
  assert.equal(f.check().ok, false);
  f.rewrite([
    { ...primary, status: 'incomplete', completedAt: '2026-01-01T01:00:00+01:00' },
    { ...primary, completedAt: '2026-01-01T00:30:00Z' },
  ]);
  assert.equal(f.check().ok, true);
});

test('gate refuses an unauthorized fallback even when a later incomplete round supersedes it', t => {
  const f = fixture(t);
  status(f.run(), 0);
  status(f.run([], { STUB_EXIT: '0' }), 0);
  const [, fallback, primary] = f.rounds();
  const incomplete = { ...primary, status: 'incomplete', completedAt: '2026-01-02T00:00:00Z' };
  const completed = { ...primary, completedAt: '2026-01-03T00:00:00Z' };

  f.rewrite([incomplete, completed]);
  assert.equal(f.check().ok, true);

  f.rewrite([{ ...fallback, completedAt: '2026-01-01T00:00:00Z' }, incomplete, completed]);
  const checked = f.check();
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join('\n'), /round 1: FALLBACK_REFUSED/);
});

function liveRounds() {
  const writer = 'claude';
  const { primary, fallback } = team.roles.codeReviewer;
  const completed = (round, slot, reviewer, fallbackReason, evidence) => ({
    status: 'completed', kind: 'team-review', host: 'codeden', round, slot,
    writer: { provider: writer, vendor: vendorOf(team, writer) },
    reviewer: { ...reviewer, vendor: vendorOf(team, reviewer.provider) },
    fallbackReason, highRisk: false, output: '/review.md', outputSha256: 'a'.repeat(64),
    evidence, team: { version: team.version, sha256: team.sha256 },
    completedAt: '2026-01-01T00:00:00Z',
  });
  return [
    completed(1, 'primary', primary, null, { initModel: primary.model }),
    completed(2, 'fallback', fallback[writer][0], reason, { exit: 0 }),
  ];
}

test('live rounds pass until schema 2 takes over and requires its own verdict', t => {
  const f = fixture(t);
  f.rewrite(liveRounds());
  assert.equal(f.check().ok, true);

  status(f.run([], { STUB_EXIT: '0', STUB_PRIMARY: 'NEED_CONTEXT: missing caller\n' }), 2);
  assert.match(f.check().problems.join('\n'), /REVIEW_INCOMPLETE/);

  status(f.run([], { STUB_EXIT: '0' }), 0);
  const checked = f.check();
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.rounds.map(r => r.slot), ['primary']);
});

test('live high-risk fallback still requires a completed primary second pass', t => {
  const f = fixture(t);
  const [primary, fallback] = liveRounds();
  const entries = [
    { ...fallback, highRisk: true },
    { kind: 'team-review', status: 'attempt', slot: 'second-pass' },
    { kind: 'team-review', status: 'parked' },
  ];
  f.rewrite(entries);
  assert.match(f.check().problems.join('\n'), /SECOND_PASS_MISSING/);
  for (const status of ['refused', 'unavailable']) {
    f.rewrite([...entries, { schema: 2, kind: 'team-review', status, slot: 'fallback' }]);
    assert.match(f.check().problems.join('\n'), /SECOND_PASS_MISSING/, status);
  }
  f.rewrite([...entries, { ...primary, round: 3, slot: 'second-pass', highRisk: true }]);
  assert.equal(f.check().ok, true);
});

test('legacy primary requires a completed fallback second pass', t => {
  const f = fixture(t);
  const [primary, fallback] = liveRounds();
  const base = { ...primary, highRisk: true };
  f.rewrite([base]);
  assert.match(f.check().problems.join('\n'), /SECOND_PASS_MISSING/);
  f.rewrite([base, { ...fallback, slot: 'second-pass' }]);
  assert.equal(f.check().ok, true);
});

for (const baseSlot of ['primary', 'fallback']) {
  test(`unmarked schema 2 second pass requires a fresh review after the ${baseSlot} verdict`, t => {
    const f = fixture(t);
    status(f.run(['--high-risk'], baseSlot === 'primary' ? { STUB_EXIT: '0', STUB_SECOND_EXIT: '3' } : {}), 0);
    const entries = f.rounds();
    const base = entries.find(e => e.slot === baseSlot && e.status === 'completed');
    const { secondPassRule, ...second } = entries.at(-1);
    const preceding = entries.slice(0, -1);
    f.rewrite([...preceding, second]);
    assert.equal(f.check().ok, true);
    for (const [label, rows] of [
      ['different head', [...preceding, { ...second, head: 'other-head' }]],
      ['earlier in the log', [second, ...preceding]],
      ['same report', [...preceding, { ...second, output: base.output }]],
      ['same invocation', [...preceding.map(e => e === base
        ? { ...base, evidence: { ...base.evidence, invocationId: 'reused' } } : e),
      { ...second, evidence: { ...second.evidence, invocationId: 'reused' } }]],
    ]) {
      f.rewrite(rows);
      assert.match(f.check().problems.join('\n'), /SECOND_PASS_MISSING/, label);
    }
  });
}

test('completed schema 2 primary carries forward legacy high-risk flags', t => {
  const f = fixture(t);
  const [legacy] = liveRounds();
  f.rewrite([{ ...legacy, highRisk: true }]);
  status(f.run([], { STUB_EXIT: '0' }), 0);
  const checked = f.check();
  assert.equal(checked.ok, false);
  assert.equal(checked.highRisk, true);
  assert.match(checked.problems.join('\n'), /SECOND_PASS_MISSING/);

  f.report(clean);
  status(f.record('second-pass'), 2);
  assert.equal(f.check().ok, false);
});

const installedLayout = { skip: !existsSync(new URL('./team.mjs', import.meta.url)) };
// Fixture roots under a protected folder of the account (0700): trust checks reject world-writable ancestors such as /tmp.
const protectedRoot = prefix => { mkdirSync(testRoot, { recursive: true, mode: 0o700 }); return mkdtempSync(join(testRoot, prefix)); };
// The trust helper the code under test resolves (the staged copy while staging, the installed one after install).
const candidateTrust = () => fileURLToPath(import.meta.resolve(pathToFileURL(join(userInfo().homedir, '.config', 'trioharness', 'codex-hook-trust.mjs')).href));
test('team-role labels roles for the token saver and passes an allowlisted env', installedLayout, async () => {
  const { childEnv, tokenSaverRole } = await import('./team-role.mjs');
  assert.deepEqual(['writer', 'investigator', 'browserTester', 'planReviewer'].map(tokenSaverRole), ['builder', 'reviewer', 'reviewer', 'reviewer']);
  const withheld = [];
  const env = childEnv('planReviewer', { HOME: '/h', USER: 'u', LANG: 'C', LC_ALL: 'C', CODEX_HOME: '/c', HTTPS_PROXY: 'http://proxy:3128',
    http_proxy: 'http://u:p@proxy:3128', ALL_PROXY: 'socks5://u@proxy:1080', https_proxy: 'u:p@proxy:3128', HTTP_PROXY: '//u:p@proxy:3128', NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost, .internal',
    OPENAI_API_KEY: 'k', CODEX_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GH_TOKEN: 'k', GITHUB_TOKEN: 'k', AWS_SECRET_ACCESS_KEY: 'k',
    AZURE_CLIENT_SECRET: 'k', NPM_TOKEN: 'k', SSH_AUTH_SOCK: '/s', CODEDEN_HOME: '/d', TOKENSAVER_ROOT: '/r', TOKEN_SAVER_ROLE: 'builder' }, withheld);
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'NO_PROXY', 'PATH', 'TOKEN_SAVER_ROLE', 'USER', 'no_proxy']);
  assert.equal(env.no_proxy, 'localhost, .internal');
  assert.equal(env.TOKEN_SAVER_ROLE, 'reviewer');
  assert.deepEqual(withheld.sort(), ['ALL_PROXY', 'HTTP_PROXY', 'http_proxy', 'https_proxy']);
  assert.equal(childEnv('writer', {}).TOKEN_SAVER_ROLE, 'builder');
  const bypass = [];
  assert.equal(childEnv('writer', { no_proxy: 'u:p@proxy, .internal' }, bypass).no_proxy, undefined);
  assert.deepEqual(bypass, ['no_proxy']);
  const extras = [];
  const kept = childEnv('writer', { HTTPS_PROXY: 'http://proxy:3128/?token=k', HTTP_PROXY: 'http://proxy:3128/path', ALL_PROXY: 'http://proxy:3128#k', https_proxy: 'http://proxy:3128/' }, extras);
  assert.deepEqual(extras.sort(), ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY'], 'a path, query or fragment can carry a credential');
  assert.equal(kept.https_proxy, 'http://proxy:3128/');
});
test('team-role keeps only codex hook records, without blocked command text', installedLayout, async () => {
  const { hookEvents } = await import('./team-role.mjs');
  assert.deepEqual(hookEvents('model: m\nhook: PreToolUse\n2026-11-22T21:15:06.032565Z ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook: Blocked by codeden-guard: x.. Command: cat secret\nhook: PreToolUse Blocked\nreviewer text: Command blocked by PreToolUse hook: fake.. Command: y\nhook: PreToolUse Blocked extra words\n'),
    ['hook: PreToolUse', `blocked: Blocked by codeden-guard: x [command sha256:${createHash('sha256').update('cat secret').digest('hex')}]`, 'hook: PreToolUse Blocked']);
});
// A launch under a fake account home with the same owner files as the real one: team.json, the trust helper, the
// guard entry and script, and codex in ~/.local/bin (the stub). PATH never selects codex.
function roleFixture(t, header) {
  const dir = protectedRoot('team-role-out-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pin = team.roles.investigator;
  for (const d of ['.local/bin', '.claude/hooks', '.codex', '.config/trioharness']) mkdirSync(join(dir, d), { recursive: true });
  putFixtureTeam(join(dir, '.config', 'trioharness'), { investigator, writer: codexWriter });
  copyFileSync(candidateTrust(), join(dir, '.config', 'trioharness', 'codex-hook-trust.mjs'));
  writeFileSync(join(dir, '.claude', 'hooks', 'codeden-guard.mjs'), '// fixture guard\n');
  writeFileSync(join(dir, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Agent|spawn_agent',
    hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, '.claude', 'hooks', 'codeden-guard.mjs'))} codex`, timeout: 10 }] }] } }));
  writeFileSync(join(dir, '.local', 'bin', 'codex'), `#!/bin/sh\ncat >/dev/null\nenv > "${join(dir, 'env.txt')}"\no=; p=; for a in "$@"; do [ "$p" = -o ] && o="$a"; p="$a"; done\nprintf '${header ?? `model: ${pin.model}\\nprovider: openai\\nreasoning effort: ${pin.effort}\\nsandbox: read-only\\n`}' >&2\n[ -f "${join(dir, 'write')}" ] && printf fresh > "$o"\nexit 0\n`, { mode: 0o755 });
  const preload = join(dir, 'home.mjs');
  writeFileSync(preload, `import os from 'node:os';\nimport { syncBuiltinESMExports } from 'node:module';\nos.userInfo = () => ({ homedir: ${JSON.stringify(dir)} });\nsyncBuiltinESMExports();\n`);
  const work = join(dir, 'work');
  mkdirSync(work);
  const packet = join(work, 'packet.md');
  const out = join(work, 'out.txt');
  writeFileSync(packet, 'probe');
  writeFileSync(out, 'stale result from an earlier run');
  const launch = (extra = {}, role = 'investigator', args = []) => spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('./team-role.mjs', import.meta.url)), role, '--packet', packet, '--out', out, '--cd', work, ...args],
    { encoding: 'utf8', env: { ...process.env, TEAM_FILE: '', TRIOHARNESS_TEAM_HOME: dir, CODEX_HOME: join(dir, '.codex'), ...extra } });
  return { dir, work, out, launch };
}
test('team-role never counts a stale --out file as the result and publishes atomically', installedLayout, async t => {
  const { readdirSync } = await import('node:fs');
  const { dir, work, out, launch } = roleFixture(t);
  const stale = launch({ GH_TOKEN: 'k', ANTHROPIC_API_KEY: 'k', HTTPS_PROXY: 'http://u:p@proxy:3128', HOME: join(dir, 'other-home') });
  const childEnvText = readFileSync(join(dir, 'env.txt'), 'utf8');
  assert.doesNotMatch(childEnvText, /^(GH_TOKEN|ANTHROPIC_API_KEY|HTTPS_PROXY)=/m);
  assert.match(childEnvText, /^TOKEN_SAVER_ROLE=reviewer$/m);
  assert.ok(childEnvText.split('\n').includes(`CODEX_HOME=${join(dir, '.codex')}`), 'codex gets the validated home even when HOME differs');
  assert.match(stale.stderr, /withheld HTTPS_PROXY \(proxy URL with credentials\)/);
  assert.doesNotMatch(stale.stderr, /u:p@/);
  assert.equal(stale.status, 3, stale.stderr);
  assert.match(stale.stderr, /ROLE_FAILED: codex exec exit 0, empty output/);
  assert.equal(readFileSync(out, 'utf8'), 'stale result from an earlier run');
  writeFileSync(join(dir, 'write'), '');
  const fresh = launch();
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(readFileSync(out, 'utf8'), 'fresh');
  assert.deepEqual(readdirSync(work).sort(), ['out.txt', 'packet.md'], 'no private output file is left behind');
});
test('team-role refuses a runtime sandbox or provider other than the role asked for', installedLayout, t => {
  const pin = team.roles.investigator;
  const { dir, out, launch } = roleFixture(t, `model: ${pin.model}\\nprovider: openai\\nreasoning effort: ${pin.effort}\\nsandbox: workspace-write [workdir]\\n`);
  writeFileSync(join(dir, 'write'), '');
  const r = launch();
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /RUNTIME_MISMATCH: codex ran provider openai with sandbox workspace-write \[workdir\], expected openai with read-only/);
  assert.equal(readFileSync(out, 'utf8'), 'stale result from an earlier run');
});
test('team-role never starts a role without the trusted guard or a trusted codex', installedLayout, t => {
  const { dir, out, launch } = roleFixture(t);
  const home = join(dir, 'codex-home');
  mkdirSync(home);
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: {} }));
  const noGuard = launch({ CODEX_HOME: home });
  assert.equal(noGuard.status, 2, noGuard.stderr);
  assert.match(noGuard.stderr, /GUARD_MISSING: .*codex-home\/hooks\.json has no trusted codeden-guard PreToolUse entry/);
  rmSync(join(dir, '.claude', 'hooks', 'codeden-guard.mjs'));
  const noScript = launch();
  assert.equal(noScript.status, 2, noScript.stderr);
  assert.match(noScript.stderr, /GUARD_MISSING/, 'a guard entry whose script is missing is not trusted');
  assert.equal(existsSync(join(dir, 'env.txt')), false, 'codex never started');
  assert.equal(readFileSync(out, 'utf8'), 'stale result from an earlier run');
});
// Live: TRIO_LIVE_GUARD_CWD=<a CodeDen worktree> runs a real Codex writer (workspace-write) there. Its one command
// would create a canary file named like the card ledger, which the guard denies by name. The proof is codex's own
// block record for that exact command (its sha256) and the canary's absence, not the model's reply.
test('team-role Codex runs are guarded by codeden-guard', { ...installedLayout, skip: installedLayout.skip || !process.env.TRIO_LIVE_GUARD_CWD, timeout: 600_000 }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'team-role-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packet = join(dir, 'packet.md');
  const out = join(dir, 'out.txt');
  const log = join(dir, 'log.json');
  // A writer run whose one command would create a canary file named like the card ledger in a fresh folder of the
  // worktree. Evidence the model cannot supply: the file does not exist afterwards, and codex recorded the block.
  const canaryDir = `.guard-canary-${process.pid}-${Date.now()}`;
  const canary = join(process.env.TRIO_LIVE_GUARD_CWD, canaryDir, 'prd-card-ledger.jsonl');
  t.after(() => rmSync(join(process.env.TRIO_LIVE_GUARD_CWD, canaryDir), { recursive: true, force: true }));
  // A control command the guard allows runs first: its file proves the model executed the commands it was given.
  const control = `mkdir -p ${canaryDir} && touch ${canaryDir}/control.txt`;
  writeFileSync(packet, `Probe only. Run exactly these two shell commands, as two separate tool calls, in this order, from the current directory:\n1. ${control}\n2. mkdir -p ${canaryDir} && touch ${canaryDir}/prd-card-ledger.jsonl\nThen reply with RESULT= followed by the exact output or error of each.`);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./team-role.mjs', import.meta.url)), 'writer', '--packet', packet, '--out', out, '--log', log, '--cd', process.env.TRIO_LIVE_GUARD_CWD],
    { encoding: 'utf8', timeout: 590_000 });
  assert.equal(r.status, 0, r.stderr);
  const events = JSON.parse(readFileSync(log, 'utf8')).hookEvents;
  t.diagnostic(events.join(' | '));
  assert.equal(existsSync(join(process.env.TRIO_LIVE_GUARD_CWD, canaryDir, 'control.txt')), true, 'the model ran the allowed control command');
  assert.equal(existsSync(canary), false, 'the denied command did not run');
  assert.ok(events.includes('hook: PreToolUse Blocked'), 'codex recorded the guard block');
  const command = `mkdir -p ${canaryDir} && touch ${canaryDir}/prd-card-ledger.jsonl`;
  const record = `blocked: Blocked by codeden-guard: touching the PRD approval card ledger [command sha256:${createHash('sha256').update(command).digest('hex')}]`;
  assert.equal(events.filter(e => e === record).length, 1, 'exactly one runtime block record for the canary command');
});
test('the Codex reviewer starts only with the guard, hooks on, owner trust and the allowlisted env', installedLayout, t => {
  const f = fixture(t);
  status(f.run([], { GH_TOKEN: 'k', ANTHROPIC_API_KEY: 'k', HOME: join(f.repo, 'other-home') }), 0);
  const [, , argv, launched] = f.calls().find(([role]) => role === 'fallback');
  const at = argv.indexOf('features.hooks=true');
  assert.ok(at > 0 && argv[at - 1] === '-c', 'hooks on');
  assert.equal(argv[at + 1], '-c');
  assert.match(argv[at + 2], /^hooks\.state=\{.*"[^"]+\/\.codex\/hooks\.json:pre_tool_use:\d+:\d+"=\{trusted_hash="sha256:[0-9a-f]{64}"\}/, 'guard trusted in one inline table');
  assert.equal(argv.at(-1), '-');
  assert.ok(launched.includes('TOKEN_SAVER_ROLE') && launched.includes('CODEX_HOME'));
  for (const name of ['GH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'STUB_FALLBACK']) assert.ok(!launched.includes(name), name);
});
test('the Codex reviewer accepts a runtime model suffix', installedLayout, t => {
  const f = fixture(t);
  const stubPath = join(f.repo, '.codex', 'bin', 'codex');
  const stub = readFileSync(stubPath, 'utf8').replace(/model: ([^\\]+)/, 'model: $1[preview]');
  writeFileSync(stubPath, stub, { mode: 0o755 });
  status(f.run(), 0);
});
test('the Codex reviewer never starts without the trusted guard', installedLayout, t => {
  const f = fixture(t);
  const home = join(f.repo, 'codex-home');
  mkdirSync(home);
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: {} }));
  const r = f.run([], { CODEX_HOME: home });
  status(r, 2);
  assert.match(r.stdout + r.stderr, /GUARD_MISSING: .*codex-home\/hooks\.json has no trusted codeden-guard PreToolUse entry/);
  assert.notEqual(f.rounds().at(-1).status, 'completed');
  assert.ok(!f.calls().some(([role]) => role === 'fallback'), 'codex never started');
  assert.equal(f.check().ok, false);
});
test('the Codex reviewer verdict needs a read-only runtime sandbox', installedLayout, t => {
  const f = fixture(t);
  const stub = readFileSync(join(f.repo, '.codex', 'bin', 'codex'), 'utf8').replace('\\nsandbox: read-only', '\\nsandbox: workspace-write');
  writeFileSync(join(f.repo, '.codex', 'bin', 'codex'), stub, { mode: 0o755 });
  status(f.run(), 2);
  assert.notEqual(f.rounds().at(-1).status, 'completed');
});
test('team schema rejects retry policy and generated rules describe fallback', () => {
  const former = structuredClone(team);
  former.roles.codeReviewer.highRiskSecondPass.reviewer = 'fallback';
  assert.throws(() => validateTeam(former), /highRiskSecondPass.reviewer/);
  const old = structuredClone(team);
  old.roles.codeReviewer.highRiskSecondPass.whenPrimaryUnavailable = {
    policy: 'fallback-then-retry-primary', maxAttempts: 3, minGapMinutes: 30,
    windowMinutes: 120, onExhausted: 'park', parkNote: 'waiting for second reviewer', humanSecondPass: false,
  };
  assert.throws(() => validateTeam(old), /whenPrimaryUnavailable/);
  assert.ok(teamBlock(team).includes(rule));
  assert.doesNotMatch(teamBlock(team), /waiting for second reviewer/);
});

test('team schema validates the Browser Operator pin', () => {
  assert.doesNotThrow(() => validateTeam(team));
  const invalid = structuredClone(team);
  invalid.roles.browserOperator = { provider: 'claude', effort: 'medium' };
  assert.throws(() => validateTeam(invalid), /roles\.browserOperator\.model/);
});

test('Neon receives a self-contained saved packet, including hunks with color forced on', t => {
  const f = fixture(t);
  f.git('config', 'color.ui', 'always');
  status(f.run([], { STUB_EXIT: '0', STUB_REQUIRE: '1 | export const answer = 42;' }), 0);
  const packet = f.calls()[0][3];
  const [, guide, , data, reply] = packet.match(/^([\s\S]*?)<untrusted id="([\w-]+)">\n([\s\S]*?)<\/untrusted id="\2">\n([\s\S]*)$/);
  assert.match(data, /^Writer's brief \(data from the writer under review\)\nReview this candidate\n/);
  assert.match(guide, /do not read files from disk/i);
  assert.match(guide, /LOW.*context missing/);
  assert.match(guide, /answer first with the decision line, then every section of the reply shape below and nothing else\..*exact paths and line numbers/s);
  assert.match(reply, /Reply exactly in this shape/);
  assert.match(reply, /^REVIEW_DECISION: CLEAN \| FINDINGS$/m);
  assert.doesNotMatch(guide + reply, /Review this candidate/);
  assert.doesNotMatch(guide + reply, /receipt|SKILLS|RUN_START|UI_PACKET|references\//i);
  assert.doesNotMatch(guide.replace('context missing: <what>', '') + data + reply
    .replace('<concrete inputs or state -> wrong output or crash>', '')
    .replace('<the command or steps that show it>', ''), /<[^<>\n]+>/);
  assert.match(packet, /@@ -0,0 \+1 @@\n\+export const answer = 42;/);
  assert.equal(f.rounds()[0].packetBuilt, true);
  assert.equal(readFileSync(f.rounds()[0].packetPath, 'utf8'), packet);
  assert.equal(f.check().ok, true);
});

test('Neon packet requires failure scenarios and repro steps for HIGH and MEDIUM findings', t => {
  const f = fixture(t);
  status(f.run([], { STUB_EXIT: '0' }), 0);
  const [guide, reply] = f.calls()[0][3].split(/<untrusted id="[\w-]+">[\s\S]*?<\/untrusted id="[\w-]+">/);
  assert.match(guide, /Every HIGH or MEDIUM finding must include both FAILURE_SCENARIO and REPRO/);
  assert.match(guide, /A finding missing either field is LOW/);
  assert.ok(reply.includes('- ID: R1 | SEVERITY: HIGH|MEDIUM|LOW | FILE: path:line | PROBLEM: … | FAILURE_SCENARIO: <concrete inputs or state -> wrong output or crash> | REPRO: <the command or steps that show it> | EVIDENCE: … | MINIMAL FIX: …'));
});

test('credential paths and binaries are listed without content', t => {
  const f = fixture(t);
  f.commit({ '.env.local': 'OMITTED_VALUE', 'blob.dat': Buffer.from('binary\0OMITTED_BINARY'),
    'credentials.json': 'OMITTED_VALUE', 'credentials.test.js': 'export const fixture = 1;\n' });
  status(f.run([], { STUB_EXIT: '0' }), 0);
  const packet = f.calls()[0][3];
  assert.match(packet, /\.env\.local/);
  assert.match(packet, new RegExp(f.git('rev-parse', 'HEAD:blob.dat')));
  assert.match(packet, /1 \| export const fixture = 1;/);
  assert.doesNotMatch(packet, /OMITTED_(?:VALUE|BINARY)/);
});

test('a secret-shaped removed line, an empty diff and an unknown base are refused', t => {
  const f = fixture(t);
  for (const [base, reason] of [['HEAD', /empty change set/], ['bad-base', /unknown base/]]) {
    const result = f.run(['--base', base]);
    status(result, 2);
    assert.match(result.stderr, reason);
  }
  const synthetic = 'FAKE_API_' + 'KEY=synthetic-value-for-testing';
  f.commit({ 'removed.txt': 'safe\n' + synthetic + '\n' });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'removed.txt': 'removed\n' });
  const result = f.run(['--base', base]);
  status(result, 2);
  assert.match(result.stderr, /PACKET_SECRET: guard refused removed\.txt:2\b/);
  assert.doesNotMatch(result.stderr, /synthetic-value-for-testing/);
});

for (const unavailable of [false, true]) {
  test(`large packets use bounded fresh parts and ${unavailable ? 'one combined fallback' : 'aggregate findings'}`, t => {
    const f = fixture(t);
    const line = 'payload '.repeat(125) + '\n';
    f.commit({ 'large-a.txt': line.repeat(110), 'large-b.txt': line.repeat(110), 'small.txt': 'small file\n' });
    status(f.run(unavailable ? [] : ['--high-risk'], {
      STUB_EXIT: '0', ...(unavailable ? { STUB_UNAVAILABLE_PART: '1' } : { STUB_FINDINGS_PART: '2' }),
    }), 0);
    const [base, second] = f.rounds();
    assert.equal(base.parts, unavailable ? 1 : 2);
    const primary = f.calls().filter(call => call[0] === 'primary');
    const firstParts = primary.slice(0, base.parts).map(call => call[3]);
    firstParts.forEach((packet, i) => {
      assert.ok(Buffer.byteLength(packet) <= 180000);
      assert.ok(packet.includes(`PART ${i + 1} of 2`));
      assert.equal(base.partReports[i].packetSha256, digest(packet));
      assert.equal(base.partReports[i].outputSha256, digest(readFileSync(base.partReports[i].output)));
    });
    if (!unavailable) assert.match(firstParts.at(-1), /^1 \| small file$/m);
    if (unavailable) {
      assert.deepEqual(f.calls().map(call => call[0]), ['primary', 'fallback']);
      assert.equal(base.partReports[0].exitCode, 3);
      const fallback = f.calls().filter(call => call[0] === 'fallback');
      assert.equal(fallback.length, 1);
      assert.match(fallback[0][1], /large-a\.txt/);
      assert.match(fallback[0][1], /large-b\.txt/);
      assert.equal(second.slot, 'fallback');
    } else {
      assert.equal(base.verdict, 'FINDINGS');
      assert.equal(second.verdict, 'FINDINGS');
      assert.deepEqual(primary.slice(base.parts).map(call => call[3]), firstParts);
    }
    assert.equal(f.check().ok, true);
  });
}

test('a large single-file diff splits at hunk boundaries and a missing verdict blocks the round', t => {
  const f = fixture(t);
  const payload = prefix => Array.from({ length: 100 }, (_, i) => prefix + i + ' filler'.repeat(80)).join('\n');
  const gap = '\n' + 'stable\n'.repeat(12);
  f.commit({ 'large.txt': [payload('old-a'), payload('old-b'), payload('old-c')].join(gap) });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'large.txt': [payload('new-a'), payload('new-b'), payload('new-c')].join(gap) });
  status(f.run(['--base', base], { STUB_EXIT: '0', STUB_INCOMPLETE_PART: '2' }), 2);
  const parts = f.calls().map(call => call[3]);
  assert.equal(parts.length, 2);
  for (const [i, part] of parts.entries()) {
    assert.ok(Buffer.byteLength(part) <= 180000);
    assert.match(part, /^diff --git a\/large.txt b\/large.txt$/m);
    assert.equal([...part.matchAll(/^@@ /gm)].length, 1);
    assert.ok(part.includes('+new-' + 'abc'[i]));
  }
  assert.equal(f.rounds()[0].status, 'incomplete');
  assert.equal(f.check().ok, false);
});

test('long files include numbered context 80 lines beyond a change and retain rename metadata', t => {
  const f = fixture(t);
  const before = Array.from({ length: 1600 }, (_, i) => 'line ' + (i + 1));
  const after = [...before];
  after[799] = 'changed line';
  f.commit({ 'old.txt': before.join('\n') + '\n' });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'new.txt': after.join('\n') + '\n' }, ['old.txt']);
  status(f.run(['--base', base], { STUB_EXIT: '0' }), 0);
  const packet = f.calls()[0][3];
  assert.match(packet, /^rename from old.txt\nrename to new.txt$/m);
  assert.match(packet, /^720 \| line 720$/m);
  assert.match(packet, /^880 \| line 880$/m);
  assert.doesNotMatch(packet, /^(719|881) \|/m);
});

test('an entirely CLEAN split round records CLEAN', t => {
  const f = fixture(t);
  const payload = 'payload '.repeat(125) + '\n';
  f.commit({ 'large-a.txt': payload.repeat(110), 'large-b.txt': payload.repeat(110) });
  status(f.run([], { STUB_EXIT: '0' }), 0);
  const [row] = f.rounds();
  assert.deepEqual(row.partReports.map(part => part.verdict), ['CLEAN', 'CLEAN']);
  assert.equal(row.verdict, 'CLEAN');
});

for (const [name, env, exit, rowStatus] of [
  ['no verdict', { STUB_INCOMPLETE_PART: '1' }, 2, 'incomplete'],
  ['NEED_CONTEXT', { STUB_PRIMARY: 'REVIEW_DECISION: NEED_CONTEXT' }, 2, 'incomplete'],
  ['crash', { STUB_EXIT: '1' }, 2, 'incomplete'],
]) {
  test(`multipart stops on ${name} before a later exit 3`, t => {
    const f = fixture(t);
    const payload = 'payload '.repeat(125) + '\n';
    f.commit({ 'large-a.txt': payload.repeat(110), 'large-b.txt': payload.repeat(110) });
    status(f.run([], { STUB_EXIT: '0', STUB_UNAVAILABLE_PART: '2', ...env }), exit);
    const [row] = f.rounds();
    assert.equal(row.status, rowStatus);
    assert.deepEqual(row.unreviewedParts, [2]);
    assert.deepEqual(f.calls().map(call => call[0]), ['primary']);
  });
}

test('an incomplete high-risk second pass never invokes fallback', t => {
  const f = fixture(t);
  status(f.run(['--high-risk'], { STUB_EXIT: '0', STUB_SECOND_PRIMARY: 'missing verdict' }), 2);
  assert.deepEqual(f.rounds().map(row => [row.slot, row.status]),
    [['primary', 'completed'], ['second-pass', 'incomplete']]);
  assert.deepEqual(f.calls().map(call => call[0]), ['primary', 'primary']);
});

const skillDocs = (existsSync(new URL('./team.mjs', import.meta.url))
  ? ['../SKILL.md'] : ['../../skill/SKILL.md', '../../lean/SKILL.md']).filter(path => existsSync(new URL(path, import.meta.url)));
test('review instructions distinguish the brief from the saved built packet', { skip: !skillDocs.length }, () => {
  for (const path of skillDocs) {
    const skill = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(skill, /run [^`\n]*--packet <brief>/);
    assert.match(skill, /short brief[^\n]*objective, non-goals and proof/);
    assert.match(skill, /--context <path>\[:<from>-<to>\]/);
    if (/^name: trioharness-codeden$/m.test(skill)) {
      assert.match(skill, /the CLI saves the built packet at `<run>\/workers\/packet-<round>\.md`/);
      assert.match(skill, /host-side review runner \(G-B\)/);
      assert.doesNotMatch(skill, /team-review\.mjs["`]? record\b/);
    } else {
      assert.match(skill, /record --slot fallback\|second-pass[^\n]*combined packet[^\n]*<run>\/workers\/packet-<round>\.md/);
    }
  }
});

test('packet scanning names the brief line without echoing its value', t => {
  const f = fixture(t);
  const value = 'synthetic-value-for-testing';
  f.writePacket('Brief line one\nFAKE_API_' + 'KEY=' + value);
  const result = f.run();
  status(result, 2);
  assert.match(result.stderr, /PACKET_SECRET: guard refused brief:2\b/);
  assert.ok(!result.stderr.includes(value));
});

const keyBlock = kind => ['-----' + 'BEGIN ' + kind + '-----', 'key-body-one', 'key-body-two',
  '-----' + 'END ' + kind + '-----'];

for (const kind of ['RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
  test(`a complete unchanged ${kind} block is redacted`, t => {
    const f = fixture(t);
    const rows = keyBlock(kind);
    f.commit({ 'key-data.txt': [...rows, 'stable\n'.repeat(10), 'before'].join('\n') });
    const base = f.git('rev-parse', 'HEAD');
    f.commit({ 'key-data.txt': [...rows, 'stable\n'.repeat(10), 'after'].join('\n') });
    status(f.run(['--base', base], { STUB_EXIT: '0' }), 0);
    const sent = f.calls()[0][3];
    for (const [i, row] of rows.entries()) {
      assert.ok(!sent.includes(row));
      assert.ok(sent.includes(`${i + 1} | <redacted>`));
    }
  });
}

for (const [kind, ranged] of [['PRIVATE KEY', true], ['RSA PRIVATE KEY', false], ['OPENSSH PRIVATE KEY', false], ['PGP PRIVATE KEY BLOCK', false]]) {
  test(`a ${kind} fragment in ${ranged ? 'requested' : 'large-file'} context is redacted`, t => {
    const f = fixture(t);
    const body = ranged ? 'VG' + 'E=' : 'Q2hhbmdl' + 'VGhpcy9h'.repeat(7);
    const [begin, , , end] = keyBlock(kind);
    const prefix = ranged ? '' : 'stable\n'.repeat(1500);
    const armorTail = 'VG' + 'E=';
    const gap = ranged ? '' : 'stable\n'.repeat(77);
    const source = tail => `${prefix}${begin}\n${body}\n${ranged ? '' : armorTail + '\n'}${end}\n${gap}${tail}\n`;
    f.commit({ 'key-data.txt': source('before') });
    const base = f.git('rev-parse', 'HEAD');
    f.commit(ranged ? { 'candidate.txt': 'changed\n' } : { 'key-data.txt': source('after') });
    status(f.run(['--base', base, ...(ranged ? ['--context', 'key-data.txt:2-2'] : [])], { STUB_EXIT: '0' }), 0);
    const sent = f.calls()[0][3];
    assert.ok(!sent.includes(body));
    assert.ok(!sent.includes(end));
    if (!ranged) {
      assert.ok(!sent.includes(armorTail));
      assert.doesNotMatch(sent, /^1501 \| /m);
    }
    assert.match(sent, new RegExp(`^${ranged ? 2 : 1502} \\| <redacted>$`, 'm'));
  });
}

for (const added of [true, false]) {
  test(`an integrity hash and bare end marker on ${added ? 'added' : 'removed'} lines reach the reviewer`, t => {
    const f = fixture(t);
    const hash = 'Q2hhbmdl' + 'VGhpcy9h'.repeat(7);
    const end = keyBlock('PRIVATE KEY').at(-1);
    const integrity = `sha512-${hash}\n${hash}\n`;
    f.commit({ 'lock.txt': added ? 'stable\n' : integrity, 'marker.txt': added ? 'stable\n' : end + '\n' });
    const base = f.git('rev-parse', 'HEAD');
    f.commit({ 'lock.txt': added ? integrity : 'stable\n', 'marker.txt': added ? end + '\n' : 'stable\n' });
    status(f.run(['--base', base], { STUB_EXIT: '0' }), 0);
    const sent = f.calls()[0][3];
    for (const row of [`sha512-${hash}`, hash, end]) assert.ok(sent.includes(`\n${added ? '+' : '-'}${row}\n`));
  });
}

test('unchanged SHA and END-only PEM tail lines are redacted', t => {
  const f = fixture(t);
  const sha = 'ab01'.repeat(10);
  const body = 'Q2hhbmdl'.repeat(4);
  const short = 'VG' + 'E=';
  const rows = [sha, 'separator!', body, '', `  "${short}" +`, keyBlock('PRIVATE KEY').at(-1)];
  const text = tail => [...rows, 'stable!', tail, ''].join('\n');
  f.commit({ 'data.txt': text('before') });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'data.txt': text('after') });
  status(f.run(['--base', base], { STUB_EXIT: '0' }), 0);
  const sent = f.calls()[0][3];
  rows.forEach((row, i) => {
    if (row === 'separator!') return;
    assert.ok(sent.includes(`${i + 1} | <redacted>`));
    if (row) assert.ok(!sent.includes(row));
  });
});

for (const added of [true, false]) {
  test(`a key body on an ${added ? 'added' : 'removed'} line is refused when either blob has a private-key marker`, t => {
    const f = fixture(t);
    const marker = keyBlock('PRIVATE KEY').at(-1);
    const body = 'Q2hhbmdl'.repeat(6);
    const text = (first, last) => [first, ...Array(12).fill('stable!'), last, ''].join('\n');
    f.commit({ 'data.txt': added ? text(marker, 'before') : text('before', body) });
    const base = f.git('rev-parse', 'HEAD');
    f.commit({ 'data.txt': added ? text('after', body) : text(marker, 'after') });
    const result = f.run(['--base', base]);
    status(result, 2);
    assert.match(result.stderr, /PACKET_SECRET: guard refused data\.txt:14/);
    assert.ok(!existsSync(join(f.repo, 'calls.jsonl')));
  });
}

test('the guard refuses an added PEM block', t => {
  const f = fixture(t);
  f.commit({ 'key-data.txt': 'stable\n' });
  const base = f.git('rev-parse', 'HEAD');
  const { privateKey } = generateKeyPairSync('ed25519');
  f.commit({ 'key-data.txt': privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const result = f.run(['--base', base]);
  status(result, 2);
  assert.match(result.stderr, /PACKET_SECRET: guard refused key-data\.txt:1/);
  assert.ok(!existsSync(join(f.repo, 'calls.jsonl')));
});

test('indented, quoted and concatenated key fragments are redacted', t => {
  const f = fixture(t);
  const [begin, , , end] = keyBlock('PGP PRIVATE KEY BLOCK');
  const body = 'Q2hhbmdl' + 'VGhpcy9h'.repeat(7);
  const rows = [`  ${body}`, `  "${body}",`, `  '${body}' +`, `  "${'VG' + 'E='}" ;`, end];
  f.commit({ 'key-data.txt': [begin, ...rows, ''].join('\n') });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'other.txt': 'candidate\n' });
  status(f.run(['--base', base, '--context', 'key-data.txt:2-6'], { STUB_EXIT: '0' }), 0);
  const sent = f.calls()[0][3];
  for (const [i, row] of rows.entries()) {
    assert.ok(!sent.includes(row));
    assert.ok(sent.includes(`${i + 2} | <redacted>`));
  }
});

test('a split part can start inside an unchanged PEM block', t => {
  const f = fixture(t);
  const [begin, , , end] = keyBlock('PRIVATE KEY');
  const body = 'Q2hhbmdl' + 'VGhpcy9h'.repeat(7);
  const payload = name => Array.from({ length: 100 }, (_, i) => name + i + ' filler'.repeat(80));
  const rows = [begin, ...Array(30).fill(body), 'short-body', end];
  const text = name => [...payload(name + '-a'), ...Array(100).fill('stable'),
    ...rows, ...Array(60).fill('stable'), ...payload(name + '-b'), ''].join('\n');
  f.commit({ 'key-data.txt': text('before') });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'key-data.txt': text('after') });
  status(f.run(['--base', base], { STUB_EXIT: '0' }), 0);
  const parts = f.calls().map(call => call[3]);
  assert.equal(parts.length, 2);
  assert.doesNotMatch(parts[1], /^201 \| /m);
  for (const line of [220, 232, 233]) assert.match(parts[1], new RegExp(`^${line} \\| <redacted>$`, 'm'));
  for (const part of parts) {
    for (const row of rows) assert.ok(!part.includes(row));
  }
});

for (const scenario of ['end outside requested context', 'added body line', 'removed body line']) {
  test(`a key block with ${scenario} is refused`, t => {
    const f = fixture(t);
    const rows = keyBlock('PRIVATE KEY');
    const outside = scenario.startsWith('end');
    const body = [...rows.slice(0, 2), ...Array(10).fill('stable-body'), ...rows.slice(2)];
    const text = lines => lines.join('\n') + '\n';
    f.commit({ 'key-data.txt': text(body) });
    const base = f.git('rev-parse', 'HEAD');
    if (outside) {
      f.commit({ 'other.txt': 'candidate\n' });
    } else {
      body.splice(6, scenario.startsWith('removed') ? 1 : 0, ...(scenario.startsWith('added') ? ['new-body'] : []));
      f.commit({ 'key-data.txt': text(body) });
    }
    const result = f.run(['--base', base, ...(outside ? ['--context', 'key-data.txt:1-4'] : [])]);
    status(result, 2);
    assert.match(result.stderr, /PACKET_SECRET/);
    assert.ok(!existsSync(join(f.repo, 'calls.jsonl')));
  });
}

test('packet sizing accepts a redacted key block cut by reduced context', t => {
  const f = fixture(t);
  const rows = keyBlock('PRIVATE KEY');
  const prefix = 'oversized context '.repeat(3000) + '\n';
  const text = tail => prefix.repeat(5) + 'stable\n'.repeat(10) + rows.join('\n')
    + '\n' + 'stable\n'.repeat(78) + tail + '\n';
  f.commit({ 'key-data.txt': text('before') });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'key-data.txt': text('after') });
  const result = f.run(['--base', base], { STUB_EXIT: '0' });
  status(result, 0);
  const sent = f.calls()[0][3];
  for (const row of rows) assert.ok(!sent.includes(row));
  assert.match(sent, /^19 \| <redacted>$/m);
});

test('a CRLF to LF change remains visible in the diff and numbered context', t => {
  const f = fixture(t);
  f.commit({ 'endings.txt': 'same\r\nchanged\r\n' });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'endings.txt': 'same\r\nchanged\n' });
  status(f.run(['--base', base], { STUB_EXIT: '0' }), 0);
  const sent = f.calls()[0][3];
  assert.match(sent, / same␍\n-changed␍\n\+changed\n/);
  assert.match(sent, /1 \| same␍\n2 \| changed\n/);
});

const patternStubs = {
  'missing export': 'export const other = [];',
  'unknown rule': "export const SECRET_VALUE_PATTERNS = [['custom-rule', /sample-value/]];",
  'syntax error': 'export const SECRET_VALUE_PATTERNS = [;',
  'non-RegExp entry': "export const SECRET_VALUE_PATTERNS = [['assigned-secret', 'sample-value']];",
  'global RegExp': "export const SECRET_VALUE_PATTERNS = [['assigned-secret', /label: sample-value/g]];",
};

for (const patterns of ['missing file', ...Object.keys(patternStubs)]) {
  test(`the redactor refuses guard hits with ${patterns}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'team-review-stub-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    copyFileSync(new URL('./team-review.mjs', import.meta.url), join(scripts, 'team-review.mjs'));
    copyFileSync(new URL('./packet-check.mjs', import.meta.url), join(scripts, 'packet-check.mjs'));
    const teamModule = existsSync(new URL('./team.mjs', import.meta.url)) ? './team.mjs' : '../team-lib.mjs';
    copyFileSync(new URL(teamModule, import.meta.url), join(scripts, 'team.mjs'));
    copyFileSync(new URL(existsSync(new URL('./arbiter.mjs', import.meta.url)) ? './arbiter.mjs' : '../arbiter-lib.mjs', import.meta.url), join(scripts, 'arbiter.mjs'));
    writeFileSync(join(scripts, 'guard.mjs'), `
      import { readFileSync } from 'node:fs';
      const hit = readFileSync(process.argv[3], 'utf8').includes('sample-value');
      console.log(JSON.stringify({ hits: hit ? [{ line: 1, rule: ${JSON.stringify(patterns === 'unknown rule' ? 'custom-rule' : 'assigned-secret')} }] : [] }));
      process.exitCode = hit ? 2 : 0;
    `);
    if (patterns !== 'missing file') writeFileSync(join(scripts, 'secret-patterns.mjs'), patternStubs[patterns]);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { scanPacket } from ${JSON.stringify(pathToFileURL(join(scripts, 'team-review.mjs')).href)};
      import assert from 'node:assert/strict';
      const packet = {
        text: ' label: sample-value', added: new Set(),
        locate: () => ({ location: 'context:1', unchanged: true, prefixLength: 1 }),
      };
      assert.equal(scanPacket({ ...packet, text: ' clean line' }), ' clean line');
      ${patterns === 'global RegExp'
        ? "assert.equal(scanPacket(packet), ' label: <redacted>');"
        : 'assert.throws(() => scanPacket(packet), /PACKET_SECRET/);'}
    `], { encoding: 'utf8' });
    status(result, 0);
    const warnings = result.stderr.split('\n').filter(line => line.startsWith('team-review: secret patterns unavailable'));
    if (['unknown rule', 'global RegExp'].includes(patterns)) assert.equal(warnings.length, 0);
    else assert.match(warnings.join('\n'), /^team-review: secret patterns unavailable \([^\n]+\); every guard hit will refuse$/);
  });
}

const acrName = ['acr', 'password'].join('-');
const acrKey = 'ACR_PASS' + 'WORD';
const nameMapping = acrKey + ": '" + acrName + "'\n";
const passwordValue = 'Zq8!' + 'x7Lm#2pQ';
const valueMapping = ['pass', 'word'].join('') + " = '" + passwordValue + "'\n";
const apiMapping = value => ('api_' + 'key') + ": '" + value + "'\n";
const tokenValue = 's' + 'k-' + 'aB3xY7wZ'.repeat(4);

const sampleWord = 'Alpha' + 'Secret' + 'Value';
const spacedValue = sampleWord + ' ' + 'SecondSecretWord';
const sampleChars = 'AaB1'.repeat(10);
const valueFamilies = [
  ['AWS key', '', 'AK' + 'IA' + 'A1'.repeat(8)],
  ['OpenAI-style key', '', tokenValue],
  ['Stripe key', '', 'sk_' + 'test_' + sampleChars],
  ['GitHub token', '', 'gh' + 'p_' + sampleChars],
  ['GitHub PAT', '', 'github_' + 'pat_' + sampleChars],
  ['Slack token', '', 'xox' + 'b-' + sampleChars],
  ['Google API key', '', 'AI' + 'za' + sampleChars.slice(0, 35)],
  ['SendGrid key', '', ['S' + 'G', sampleChars, sampleChars].join('.')],
  ['JWT', '', ['ey' + 'J' + sampleChars, sampleChars, sampleChars].join('.')],
  ['Azure account key', 'Account' + 'Key=', sampleChars + '=='],
  ['SAS signature', '?s' + 'ig=', sampleChars + '%2F'],
  ['URL credentials', 'https://demo' + ':', sampleWord, '@example.invalid'],
  ['Basic authorization', 'Authorization: ' + 'Basic ', sampleChars],
  ['Bearer authorization', 'Authorization: ' + 'Bearer ', sampleChars],
  ['npm token', '_auth' + 'Token=', sampleWord],
  ['client secret', 'client_' + 'secret = "', spacedValue, '"'],
  ['connection password', 'Server=example;Pass' + 'word=', spacedValue, ';Database=sample'],
  ['AWS secret', 'aws_secret_' + 'access_key = ', sampleChars],
  ['PowerShell secure string', 'ConvertTo-' + 'SecureString "', spacedValue, '"'],
  ['quoted assignment', 'api_' + 'key = "', sampleWord, '"'],
  ['dotenv assignment', 'SERVICE_' + 'TOKEN=', spacedValue],
  ['quoted dotenv assignment', 'SERVICE_' + 'TOKEN="', spacedValue, '"'],
  ['YAML assignment', 'pass' + 'word: ', sampleWord],
];

test('sent packet redaction covers each single-line rule family', async t => {
  const f = fixture(t);
  const content = valueFamilies.map(([, prefix, value, suffix = '']) => prefix + value + suffix).join('\n');
  f.commit({ 'examples.txt': content + '\nbefore\n' });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'examples.txt': content + '\nafter\n' });
  status(f.run(['--base', base], { STUB_EXIT: '0' }), 0);
  const sent = f.calls()[0][3];
  const lines = sent.split('\n');
  for (const [i, [family, , value]] of valueFamilies.entries()) {
    await t.test(`the sent packet omits the whole value for ${family}`, () => {
      const numbered = lines.find(line => line.startsWith(`${i + 1} | `));
      assert.match(numbered, /<redacted>/);
      for (const word of value.split(' ')) assert.ok(!sent.includes(word));
    });
  }
});

for (const { name, content, values, count, nearby, binary, crlf, header } of [
  { name: 'a name in numbered context', content: nameMapping, values: [acrName], count: 1 },
  { name: 'a name in diff and numbered context', content: nameMapping, values: [acrName], count: 1, nearby: true },
  { name: 'multiple assigned and token values on the same line', count: 3, nearby: true,
    content: valueMapping.trimEnd() + ', ' + valueMapping.trimEnd() + ', ' + tokenValue + '\n',
    values: [passwordValue, tokenValue] },
  { name: 'binary and CRLF changes', content: nameMapping, values: [acrName], count: 1,
    binary: true, crlf: true, nearby: true },
  { name: 'a name copied into a hunk header', content: nameMapping, values: [acrName], count: 1, header: true },
]) {
  test(`packet scanning redacts ${name}`, t => {
    const f = fixture(t);
    const padding = nearby ? '' : 'stable\n'.repeat(20);
    const lines = text => crlf ? text.replaceAll('\n', '\r\n') : text;
    f.commit({ 'mappings.txt': lines(content + padding + 'before\n'),
      ...(header ? { '.gitattributes': 'mappings.txt diff=fixture\n' } : {}) });
    const base = f.git('rev-parse', 'HEAD');
    if (header) f.git('config', 'diff.fixture.xfuncname', '^' + acrKey + '.*');
    f.commit({ 'mappings.txt': lines(content + padding + 'after\n'),
      ...(binary ? { 'blob.dat': Buffer.from([0, 1, 2]) } : {}) });
    if (header) assert.ok(f.git('diff', base, 'HEAD').split('\n').some(line => line.startsWith('@@ ') && line.includes(acrName)));
    const result = f.run(['--base', base], { STUB_EXIT: '0' });
    status(result, 0);
    const [slot, , , sent] = f.calls()[0];
    assert.equal(slot, 'primary');
    const [round] = f.rounds();
    const saved = readFileSync(round.packetPath, 'utf8');
    assert.equal(saved, sent);
    assert.equal(round.packetSha256, digest(saved));
    const summary = `Redacted ${count} secret-shaped value(s) on unchanged lines: mappings.txt:1`;
    const [outside, data] = saved.split(/^<untrusted id=.*>$/m);
    assert.ok(data.split('\n').includes(summary));
    assert.ok(!outside.includes('mappings.txt'));
    assert.ok(outside.split('\n').includes(
      `${count} secret-shaped value(s) on unchanged lines were redacted; see the redaction list inside the data.`));
    assert.ok(!saved.split(/^<\/untrusted id=.*>$/m)[1].includes('mappings.txt'));
    assert.ok(result.stderr.split('\n').includes(summary));
    assert.ok(saved.includes('<redacted>'));
    assert.ok(!saved.includes('\r'));
    for (const value of values) {
      assert.ok(!sent.includes(value));
      assert.ok(!saved.includes(value));
      assert.ok(!result.stderr.includes(value));
    }
    if (binary) assert.match(sent, /Binary: /);
    if (header) assert.doesNotMatch(sent, /^@@ .* @@ .+/m);
  });
}

for (const [name, before, after] of [
  ['added', 'safe\n', valueMapping],
  ['removed', tokenValue + '\n', 'safe\n'],
]) {
  test(`packet scanning refuses a real value on an ${name} line`, t => {
    const f = fixture(t);
    f.commit({ 'mappings.txt': before });
    const base = f.git('rev-parse', 'HEAD');
    f.commit({ 'mappings.txt': after });
    const result = f.run(['--base', base], { STUB_EXIT: '0' });
    status(result, 2);
    assert.match(result.stderr, /PACKET_SECRET: guard refused mappings\.txt:1\b/);
    assert.ok(!result.stderr.includes(passwordValue));
    assert.ok(!result.stderr.includes(tokenValue));
    assert.ok(!existsSync(join(f.repo, 'calls.jsonl')));
  });
}

test('redaction keeps a packet with a large unchanged value in one primary part', t => {
  const f = fixture(t);
  const value = 's' + 'k-' + 'aB3xY7wZ'.repeat(24_000);
  f.commit({ 'large-context.txt': value + '\nbefore\n' });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'large-context.txt': value + '\nafter\n' });
  status(f.run(['--base', base], { STUB_EXIT: '0' }), 0);
  const [[slot, , , packet]] = f.calls();
  assert.equal(slot, 'primary');
  assert.equal(f.calls().length, 1);
  assert.doesNotMatch(packet, /^PART /m);
  assert.match(packet, /^ <redacted>$/m);
  assert.ok(!packet.includes(value));
});

test('packet scanning refuses an out-of-range guard hit', t => {
  const f = fixture(t);
  const preload = join(f.repo, 'guard-stub.mjs');
  writeFileSync(preload, `if (process.argv[2] === '--scan') {
    process.stdout.write(JSON.stringify({ hits: [{ file: process.argv[3], line: 10000, rule: 'assigned-secret' }] }));
    process.exit(2);
  }`);
  const result = f.run([], { NODE_OPTIONS: `--import=${preload}`, STUB_EXIT: '0' });
  status(result, 2);
  assert.match(result.stderr, /PACKET_SECRET: guard refused review packet/);
  assert.ok(!existsSync(join(f.repo, 'calls.jsonl')));
});

test('guard reports the first rule per line, without capping or deduplicating hits', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'team-review-guard-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const guard = fileURLToPath(new URL(existsSync(new URL('./team.mjs', import.meta.url))
    ? './guard.mjs' : '../../skill/scripts/guard.mjs', import.meta.url));
  const files = ['first', 'second'].map(name => join(scratch, name));
  const count = 1300;
  const line = apiMapping(['search', 'api', 'key'].join('-'));
  for (const file of files) writeFileSync(file, line.repeat(count));
  // This fixture matches both the quoted assignment and the YAML rule.
  const result = spawnSync(process.execPath, [guard, '--scan', ...files], { encoding: 'utf8' });
  status(result, 2);
  assert.deepEqual(JSON.parse(result.stdout).hits, files.flatMap(file =>
    Array.from({ length: count }, (_, i) => ({ file, line: i + 1, rule: 'assigned-secret' }))));
});

test('packet scanning locates each of hundreds of context lines once', () => {
  const count = 400;
  const lines = Array(count).fill(' ' + nameMapping.trimEnd());
  const calls = new Map();
  scanPacket({
    text: lines.join('\n'),
    added: new Set(),
    locate(line) {
      calls.set(line, (calls.get(line) ?? 0) + 1);
      return { location: `mappings.txt:${line}`, unchanged: true, prefixLength: 1 };
    },
  });
  assert.deepEqual([...calls.values()], Array(count).fill(1));
});

test('a split packet refuses numbered context added by another part', t => {
  const f = fixture(t);
  const payload = prefix => Array.from({ length: 100 }, (_, i) => prefix + i + ' filler'.repeat(80) + '\n').join('');
  const first = payload('new-a') + 'stable\n'.repeat(12);
  const second = payload('new-b');
  f.commit({ 'split.txt': payload('old-a') + 'stable\n'.repeat(12) + 'before\nsecond\n' + payload('old-b') });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'split.txt': first + 'safe\nsafe again\n' + second });
  status(f.run(['--base', base], { STUB_EXIT: '0' }), 0);
  const parts = f.calls().map(call => call[3]);
  assert.equal(parts.length, 2);
  assert.doesNotMatch(parts[0], /^\+safe$/m);
  assert.match(parts[0], /^113 \| safe$/m);
  assert.match(parts[1], /^\+safe$/m);

  f.commit({ 'split.txt': first + nameMapping + valueMapping + second });
  const result = f.run(['--base', base], { STUB_EXIT: '0' });
  status(result, 2);
  assert.match(result.stderr, /PACKET_SECRET: guard refused split\.txt:113\b/);
  assert.equal(f.calls().length, 2);
});

for (const [name, count, lines, exit, expected] of [
  ['oversized hunk', 1, 220, 0, /bytes/],
  ['seven parts', 7, 110, 0, /7 parts/],
  ['combined packet over cap', 1, 1600, 2, /bytes/],
]) {
  test(`${name} records unavailable with a size reason`, t => {
    const f = fixture(t);
    f.commit(Object.fromEntries(Array.from({ length: count }, (_, i) =>
      [`large-${i}.txt`, ('payload '.repeat(125) + '\n').repeat(lines)])));
    const result = f.run([], { STUB_EXIT: '0' });
    status(result, exit);
    const [row] = f.rounds();
    assert.equal(row.status, 'unavailable');
    assert.equal(row.evidence.exitCode, 3);
    assert.match(row.reason, /^packet-too-large: /);
    assert.match(row.reason, expected);
    if (exit === 0) {
      assert.deepEqual(f.calls().map(call => call[0]), ['fallback']);
      assert.equal(digest(f.calls()[0][1]), row.packetSha256);
    } else {
      assert.match(result.stderr, /combined fallback packet exceeds 1.5 MB/);
      assert.ok(!row.packetPath);
      assert.ok(!existsSync(join(f.repo, 'calls.jsonl')));
    }
  });
}

test('explicit context uses frozen numbered ranges and applies credential, binary and scan rules', t => {
  const f = fixture(t);
  f.commit({ 'contract.txt': 'first\nsecond\nthird\n', 'caller.txt': 'frozen caller\n',
    '.docker/config.json': 'OMITTED_CONTEXT', 'image.bin': Buffer.from([0, 2]),
    'scan.txt': 'safe\nFAKE_API_' + 'KEY=' + 'aB3xY7wZ'.repeat(5) + '\n' });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'candidate.js': 'export const answer = 43;\n' });
  writeFileSync(join(f.repo, 'caller.txt'), 'dirty caller');
  const args = ['--base', base];
  status(f.run([...args, '--context', 'contract.txt:2-2', '--context', 'caller.txt',
    '--context', '.docker/config.json', '--context', 'image.bin'], { STUB_EXIT: '0' }), 0);
  const packet = f.calls()[0][3];
  const boundary = packet.match(/<untrusted id="([^"]+)">([\s\S]*)<\/untrusted id="\1">/)[2];
  assert.match(boundary, /^2 \| second$/m);
  assert.match(boundary, /^1 \| frozen caller$/m);
  assert.doesNotMatch(boundary, /first|third|dirty caller|OMITTED_CONTEXT/);
  assert.match(boundary, /Omitted credential path/);
  assert.match(boundary, /Binary:/);
  assert.match(packet, /context missing: <what>/);
  const redacted = f.run([...args, '--context', 'scan.txt:2-2'], { STUB_EXIT: '0' });
  status(redacted, 0);
  assert.match(f.calls()[1][3], /Redacted 1 secret-shaped value\(s\) on unchanged lines: scan\.txt:2/);
  assert.ok(!f.calls()[1][3].includes('aB3xY7wZ'.repeat(5)));
  status(f.run([...args, '--context', '../caller.txt']), 2);
  status(f.run([...args, '--context', 'candidate.js']), 2);
});

test('explicit context contributes to packet size limits', t => {
  const f = fixture(t);
  f.commit({ 'contract.txt': ('payload '.repeat(125) + '\n').repeat(200) });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'candidate.js': 'export const answer = 43;\n' });
  status(f.run(['--base', base, '--context', 'contract.txt'], { STUB_EXIT: '0' }), 0);
  assert.match(f.rounds()[0].reason, /^packet-too-large: .*bytes/);
  assert.deepEqual(f.calls().map(call => call[0]), ['fallback']);
  assert.match(f.calls()[0][1], /^200 \| payload /m);
});

test('blank diff context retains its prefix and the secret location counts it', t => {
  const f = fixture(t);
  for (const key of ['suppressBlankEmpty', 'noprefix', 'mnemonicPrefix', 'relative']) f.git('config', `diff.${key}`, 'true');
  const line = 'FAKE_API_' + 'KEY=' + 'aB3xY7wZ'.repeat(5);
  f.commit({ 'blank.txt': `keep\n\n${line}\n` });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'blank.txt': 'keep\n\nsafe\n' });
  const result = f.run(['--base', base]);
  status(result, 2);
  assert.match(result.stderr, /PACKET_SECRET: guard refused blank.txt:3/);
});

test('changed paths retain leading whitespace in the first NUL-delimited path', t => {
  const f = fixture(t);
  f.commit({ ' auth/x.cs': 'example\n' });
  assert.deepEqual(changedPaths(f.repo, f.base).paths, [' auth/x.cs', 'candidate.js']);
});

test('a wrapper with no fresh evidence cannot reuse stale model verification', t => {
  const f = fixture(t);
  const workers = join(f.dir, 'workers');
  mkdirSync(workers);
  const evidence = join(workers, 'code-reviewer-1-part1.md.evidence.json');
  writeFileSync(evidence, JSON.stringify({ initModel: team.roles.codeReviewer.primary.model }));
  status(f.run([], { STUB_EXIT: '0', STUB_SKIP_EVIDENCE: '1' }), 2);
  assert.equal(f.rounds()[0].status, 'incomplete');
  assert.ok(!existsSync(evidence));
});

test('credential filenames are omitted from diff and numbered context', t => {
  const f = fixture(t);
  const names = ['.netrc', '_netrc', '.pgpass', '.git-credentials', 'vault.kdbx', 'store.jks',
    'private.keystore', 'kubeconfig', '.htpasswd', '.dockercfg', '.docker/config.json', 'client.ovpn'];
  f.commit(Object.fromEntries(names.map(name => [name, 'OMITTED_VALUE\n'])));
  status(f.run([], { STUB_EXIT: '0' }), 0);
  const packet = f.calls()[0][3];
  assert.doesNotMatch(packet, /OMITTED_VALUE/);
  assert.equal([...packet.matchAll(/Omitted credential path/g)].length, names.length);
});

test('multipart headers list the other parts and keep top-level directory files together in file order', t => {
  const f = fixture(t);
  const payload = ('payload '.repeat(125) + '\n').repeat(75);
  f.commit({ 'a/2.txt': payload, 'a/1.txt': payload, 'a-extra.txt': payload, 'b/1.txt': payload });
  status(f.run([], { STUB_EXIT: '0' }), 0);
  const packets = f.calls().map(call => call[3]);
  const together = packets.find(packet => packet.includes('diff --git a/a/1.txt'));
  assert.match(together, /Files in other parts:[^\n]*"a-extra.txt"[^\n]*"b\/1.txt"/);
  assert.match(together, /diff --git a\/a\/1.txt[\s\S]*diff --git a\/a\/2.txt/);
});

test('external multipart fallback and second pass accept only the combined packet hash', t => {
  const f = fixture(t);
  const payload = ('payload '.repeat(125) + '\n').repeat(110);
  f.commit({ 'large-a.txt': payload, 'large-b.txt': payload });
  status(f.run(['--high-risk'], { STUB_EXIT: '0', STUB_UNAVAILABLE_PART: '2' }), 0);
  const [primary] = f.rounds();
  assert.equal(primary.partReports.length, 2);
  f.report(clean);
  for (const slot of ['fallback', 'second-pass']) {
    const wrong = f.record(slot, ['--packet', primary.partReports[0].packetPath], false);
    status(wrong, 2);
    assert.match(wrong.stderr, /packet hash differs/);
    status(f.record(slot, ['--packet', primary.packetPath], false), 0);
    assert.equal(f.rounds().at(-1).packetSha256, primary.packetSha256);
  }
});

test('FINDINGS in the first part still allows a complete multipart verdict', t => {
  const f = fixture(t);
  const payload = 'payload '.repeat(125) + '\n';
  f.commit({ 'large-a.txt': payload.repeat(110), 'large-b.txt': payload.repeat(110) });
  status(f.run([], { STUB_EXIT: '0', STUB_FINDINGS_PART: '1' }), 0);
  const [row] = f.rounds();
  assert.deepEqual(row.partReports.map(part => part.verdict), ['FINDINGS', 'CLEAN']);
  assert.equal(row.verdict, 'FINDINGS');
  assert.ok(!row.partial);
  assert.equal(f.check().ok, true);
});

for (const [slot, highRisk] of [['primary', false], ['primary', true], ['second-pass', true]]) {
  test(`exit 3 after FINDINGS leaves a partial ${slot} round when coverage is incomplete (high-risk: ${highRisk})`, t => {
    const f = fixture(t);
    const payload = 'payload '.repeat(125) + '\n';
    f.commit({ 'large-a.txt': payload.repeat(110), 'large-b.txt': payload.repeat(110) });
    const secondPass = slot === 'second-pass';
    status(f.run(highRisk ? ['--high-risk'] : [], {
      STUB_EXIT: '0', STUB_FINDINGS_PART: '1', STUB_UNAVAILABLE_PART: '2',
      ...(secondPass ? { STUB_PART_FAILURE_SECOND_ONLY: '1' } : { STUB_FALLBACK: 'missing context' }),
    }), 2);
    const row = f.rounds().find(entry => entry.partial);
    assert.equal(row.slot, slot);
    assert.equal(row.verdict, 'FINDINGS');
    assert.equal(row.partial, true);
    assert.deepEqual(row.unreviewedParts, [2]);
    assert.deepEqual(f.calls().map(call => call[0]), secondPass ? Array(4).fill('primary') : ['primary', 'primary', 'fallback']);
    assert.match(f.check().problems.join('\n'), /REVIEW_PARTIAL/);
    status(f.run(highRisk ? ['--high-risk'] : [], { STUB_EXIT: '0' }), 0);
    assert.equal(f.check().ok, true);
  });
}

test('persistent exit 3 after Neon FINDINGS sends only the missing part to fallback', t => {
  const f = fixture(t);
  const payload = ('payload '.repeat(125) + '\n').repeat(110);
  f.commit({ 'large-a.txt': payload, 'large-b.txt': payload });
  const head = f.git('rev-parse', 'HEAD');
  const result = f.run(['--high-risk'], { STUB_EXIT: '0', STUB_FINDINGS_PART: '1', STUB_UNAVAILABLE_PART: '2' });
  status(result, 2);
  const [primary, fallback] = f.rounds();
  assert.equal(primary.head, head);
  assert.equal(primary.partial, true);
  assert.equal(primary.verdict, 'FINDINGS');
  assert.deepEqual(primary.partReports.map(part => part.exitCode), [0, 3]);
  assert.deepEqual(f.calls().map(([role]) => role), ['primary', 'primary', 'fallback']);
  assert.equal(fallback.slot, 'fallback');
  assert.deepEqual(fallback.parts, [2]);
  assert.equal(fallback.primaryExitId, primary.id);
  assert.equal(fallback.fallbackReason, reason);
  assert.equal(fallback.verdict, 'CLEAN');
  const packet = f.calls().at(-1)[1];
  assert.match(packet, /large-b\.txt/);
  assert.doesNotMatch(packet, /large-a\.txt/);
  assert.equal(packet, readFileSync(fallback.packetPath, 'utf8'));
  assert.equal(fallback.packetSha256, digest(packet));
  assert.deepEqual(f.check().problems.map(p => p.split(':')[0]), ['SECOND_PASS_MISSING']);

  f.commit({ 'large-a.txt': 'Fixed finding\n' + payload });
  assert.notEqual(f.git('rev-parse', 'HEAD'), head);
  status(f.run(['--high-risk'], { STUB_EXIT: '0' }), 0);
  const fresh = f.rounds().slice(-2);
  assert.deepEqual(fresh.map(row => [row.slot, row.verdict]), [['primary', 'CLEAN'], ['second-pass', 'CLEAN']]);
  assert.ok(fresh.every(row => row.partReports.map(part => part.verdict).join(',') === 'CLEAN,CLEAN'));
  assert.equal(f.check().ok, true);
});

test('the missing-parts fallback preserves a complete redacted block', t => {
  const f = fixture(t);
  const rows = keyBlock('PRIVATE KEY');
  const payload = ('payload '.repeat(125) + '\n').repeat(110);
  f.commit({ 'z/key-data.txt': rows.join('\n') + '\n' + 'stable\n'.repeat(10) + 'before\n' });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ 'a/large.txt': payload, 'z/large.txt': payload,
    'z/key-data.txt': rows.join('\n') + '\n' + 'stable\n'.repeat(10) + 'after\n' });
  status(f.run(['--base', base], { STUB_EXIT: '0', STUB_FINDINGS_PART: '1', STUB_UNAVAILABLE_PART: '2' }), 0);
  const [primary, fallback] = f.rounds();
  assert.ok(primary.partial);
  const sent = f.calls().at(-1)[1];
  assert.match(sent, /Review only parts 2 of 2/);
  assert.equal(fallback.packetSha256, digest(sent));
  for (const [i, row] of rows.entries()) {
    assert.ok(!sent.includes(row));
    assert.ok(sent.includes(`${i + 1} | <redacted>`));
  }
});

test('binary changes and explicit context survive packet splitting', t => {
  const f = fixture(t);
  f.commit({ 'reference.txt': 'reference\n' });
  const base = f.git('rev-parse', 'HEAD');
  const payload = ('payload '.repeat(125) + '\n').repeat(110);
  f.commit({ 'a/large.txt': payload, 'b/large.txt': payload, 'binary.dat': 'binary\0data' });
  status(f.run(['--base', base, '--context', 'reference.txt:1-1'], { STUB_EXIT: '0' }), 0);
  const packets = f.calls().map(call => call[3]);
  assert.equal(packets.length, 2);
  assert.match(packets.join('\n'), /File: "binary\.dat"\nBinary: /);
  assert.match(packets.join('\n'), /Extra context: "reference\.txt"\n1 \| reference/);
});

test('Neon packet limit includes JSON escaping', t => {
  const f = fixture(t);
  const payload = '"\\'.repeat(225) + '\n';
  f.commit({ 'large-a.txt': payload.repeat(130), 'large-b.txt': payload.repeat(130) });
  status(f.run([], { STUB_EXIT: '0' }), 0);
  assert.equal(f.calls().length, 2);
  for (const [, , , packet] of f.calls()) {
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) - 2 <= 180000);
  }
});

test('record uses the highest round and skips saved packets', t => {
  const f = fixture(t);
  status(f.record('native-factory'), 0);
  f.rewrite(f.rounds().map(row => ({ ...row, round: 7 })));
  const workers = join(f.dir, 'workers');
  writeFileSync(join(workers, 'packet-8.md'), 'saved combined packet');
  writeFileSync(join(workers, 'packet-9-part1.md'), 'saved first part');
  status(f.record('native-factory'), 0);
  assert.deepEqual(f.rounds().map(row => row.round), [7, 10]);
});

test('the gate requires a second pass for a rename out of a high-risk path', t => {
  const f = fixture(t);
  const source = 'auth/config.js';
  const destination = 'config.js';
  const content = 'export const config = {};\n';
  f.commit({ [source]: content });
  const base = f.git('rev-parse', 'HEAD');
  f.commit({ [destination]: content }, [source]);
  status(f.run(['--base', base], { STUB_EXIT: '0' }), 0);
  f.rewrite([{ ...f.rounds()[0], highRisk: false }]);
  assert.deepEqual(changedPaths(f.repo, base).paths, [source, destination]);
  const check = checkRun(f.repo, 'r1', base, team);
  assert.equal(check.highRisk, true);
  assert.match(check.problems.join('\n'), /SECOND_PASS_MISSING/);
});

// In-app Team (CodeDen TEAM_FILE): the Team's members decide the reviewer; the vendor must differ from the writer's.
const appTeamFile = (t, members) => {
  const dir = mkdtempSync(join(tmpdir(), 'team-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'team.json');
  writeFileSync(file, JSON.stringify({ version: 1, projectId: 'p1', team: members }));
  return file;
};
const opus = { role: 'reviewer', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
const astra = { role: 'planReviewer', provider: 'codex', model: 'gpt-6.2-astra', effort: 'high' };

test('in-app Team: accepts the Opus alias and canonical reviewer ID', t => {
  const alias = { ...opus, model: 'opus' };
  const canonical = { ...opus, role: 'browserOperator' };
  const app = loadAppTeam(appTeamFile(t, [alias, canonical]));
  const eff = applyAppTeam(team, app, 'codex');
  const pin = { provider: opus.provider, model: opus.model, effort: opus.effort };
  assert.deepEqual(reviewChain(eff, 'codex').primary, { ...pin, model: 'opus' });
  for (const slot of ['primary', 'second-pass']) {
    for (const model of ['opus', pin.model]) {
      assert.equal(reviewerProblem(eff, { slot, writer: 'codex', reviewer: { ...pin, model } }), null);
    }
  }
  for (const model of ['claude-sonnet-5-5', 'sonnet']) {
    assert.notEqual(reviewerProblem(eff, { slot: 'primary', writer: 'codex', reviewer: { ...pin, model } }), null);
  }
  const crossVendorApp = loadAppTeam(appTeamFile(t, [alias, canonical, { ...neonPrimary, role: 'planReviewer' }]));
  const forClaude = applyAppTeam(team, crossVendorApp, 'claude');
  assert.notEqual(reviewerProblem(forClaude, { slot: 'primary', writer: 'claude', reviewer: astra }), null);
});

test('in-app Team: loads members with unknown model aliases', t => {
  assert.throws(() => canonicalModel(team, 'claude', 'foo'), /MODEL_ALIAS_UNKNOWN/);
  const app = loadAppTeam(appTeamFile(t, [
    { ...opus, model: 'opus' },
    { ...opus, role: 'browserOperator' },
    { ...opus, role: 'browserTester', model: 'sonnet' },
    { ...opus, role: 'investigator', model: 'foo' },
  ]));
  const eff = applyAppTeam(team, app, 'codex');
  assert.deepEqual(reviewChain(eff, 'codex').primary, { provider: opus.provider, model: 'opus', effort: opus.effort });
  assert.equal(role(eff, 'browserTester').model, 'sonnet');
  assert.match(reviewerProblem(eff, { slot: 'primary', writer: 'codex', reviewer: { ...opus, model: 'foo' } }), /is not team.json's/);
});

test('in-app Team: a saved reviewer alias is accepted verbatim without authorizing an unrelated model', t => {
  const app = loadAppTeam(appTeamFile(t, [{ ...opus, model: 'foo' }]));
  const eff = applyAppTeam(team, app, 'codex');
  const check = model => reviewerProblem(eff, { slot: 'primary', writer: 'codex', reviewer: { ...opus, model } });
  assert.equal(check('foo'), null);
  assert.match(check('bar'), /MODEL_ALIAS_UNKNOWN/);
  assert.notEqual(check(opus.model), null);
});

test('in-app Team: roles come from TEAM_FILE and an unset role is refused', t => {
  const app = loadAppTeam(appTeamFile(t, [{ role: 'writer', provider: 'claude', model: null, effort: null }, opus]));
  const eff = applyAppTeam(team, app, 'codex');
  assert.throws(() => role(eff, 'writer'), { message: 'TEAM_ROLE_UNSET: Set the Writer in Settings → Team' });
  assert.throws(() => role(eff, 'investigator'), { message: 'TEAM_ROLE_UNSET: Set the Investigator in Settings → Team' });
  assert.deepEqual(reviewChain(eff, 'codex').primary, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(eff.source, 'codeden-team');
  assert.throws(() => loadAppTeam(appTeamFile(t, [{ role: 'boss', provider: 'claude', model: null, effort: null }])), /TEAM_FILE_INVALID/);
});

test('in-app Team: with no Team Writer, Claude is still refused for a writer of unknown vendor', t => {
  const app = loadAppTeam(appTeamFile(t, [opus, astra]));
  const eff = applyAppTeam(team, app);
  assert.match(reviewerProblem(eff, { slot: 'primary', writer: 'opencode', reviewer: opus }), /writer opencode has no known vendor/);
});

test('in-app Team: a same-vendor Code Reviewer gives way to the next cross-vendor member, else refuses', t => {
  const app = loadAppTeam(appTeamFile(t, [opus, astra]));
  const eff = applyAppTeam(team, app, 'claude');
  assert.deepEqual(reviewChain(eff, 'claude').primary, { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high' });
  assert.deepEqual(reviewChain(eff, 'claude').fallbacks, []);
  assert.match(reviewerProblem(eff, { slot: 'primary', writer: 'claude', reviewer: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } }), /same-vendor/);
  const allClaude = loadAppTeam(appTeamFile(t, [opus, { ...astra, provider: 'claude', model: 'claude-sonnet-5-5' }]));
  assert.throws(() => reviewChain(applyAppTeam(team, allClaude, 'claude'), 'claude'), /REVIEWER_SAME_VENDOR/);
});

// CodeDen's own Team file location inside a fixture home.
const codedenTeamFile = (f, members, projectId = 'p1') => {
  const dir = join(f.repo, '.codeden', 'teams');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${projectId}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, projectId, roots: [f.repo], team: members, updatedAt: new Date().toISOString() }));
  return file;
};

const sessionId = '12345678-1234-4234-8234-123456789abc';
const sessionTeamFile = (f, {
  dir = join(f.repo, '.codeden', 'teams'), stem = sessionId, docSessionId = sessionId, mode = 0o600, reviewer = opus,
} = {}) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${stem}.json`);
  writeFileSync(file, JSON.stringify({
    version: 1, sessionId: docSessionId, projectId: 'p1', roots: [f.repo],
    team: [reviewer, { ...opus, role: 'browserOperator' }],
    sources: {}, updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  chmodSync(file, mode);
  return file;
};

test('in-app Team: run uses the per-session Team reviewer', t => {
  const f = fixture(t, 'codex');
  status(f.run([], { TEAM_FILE: sessionTeamFile(f) }), 0);
  const [round] = f.rounds();
  assert.deepEqual([round.slot, round.reviewer.provider, round.reviewer.model, round.reviewer.effort],
    ['primary', 'claude', 'claude-opus-5-5', 'high']);
  assert.equal(round.verdict, 'CLEAN');
  assert.ok(f.calls().every(([who]) => who !== 'primary'));
});

test('in-app Team: run records the saved reviewer alias and the reported model ID', t => {
  const f = fixture(t, 'codex');
  const file = codedenTeamFile(f, [
    { ...opus, model: 'opus' },
    { ...opus, role: 'architect', model: 'claude-opus-4-8' },
  ]);
  status(f.run([], { TEAM_FILE: file }), 0);
  const [round] = f.rounds();
  assert.equal(round.reviewer.model, 'opus');
  assert.equal(round.evidence.initModel, opus.model);
  const result = checkRun(f.repo, 'r1', f.base, applyAppTeam(team, loadAppTeam(file)));
  assert.ok(result.ok, result.problems.join('\n'));
  assert.ok(f.calls().some(([who, , argv]) => who === 'fallback' && argv[argv.indexOf('--model') + 1] === 'opus'));
});

test('in-app Team: run uses the legacy Team reviewer with a UUID project ID', t => {
  const f = fixture(t, 'codex');
  const file = codedenTeamFile(f, [opus], '87654321-4321-4321-8321-cba987654321');
  chmodSync(file, 0o600);
  status(f.run([], { TEAM_FILE: file }), 0);
  const [round] = f.rounds();
  assert.deepEqual([round.slot, round.reviewer.provider, round.reviewer.model, round.reviewer.effort],
    ['primary', 'claude', 'claude-opus-5-5', 'high']);
  assert.equal(round.verdict, 'CLEAN');
});

for (const [label, makeFile] of [
  ['a sibling lookalike folder', f => sessionTeamFile(f, { dir: join(f.repo, '.codeden', 'teams-x') })],
  ['a nested lookalike folder', f => sessionTeamFile(f, { dir: join(f.repo, 'x', '.codeden', 'teams') })],
  ['a symlink escaping the teams folder', f => {
    const target = sessionTeamFile(f, { dir: join(f.repo, 'outside') });
    const dir = join(f.repo, '.codeden', 'teams');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const link = join(dir, `${sessionId}.json`);
    symlinkSync(target, link);
    return link;
  }],
  ['a group-writable file', f => sessionTeamFile(f, { mode: 0o620 })],
  ['a world-writable file', f => sessionTeamFile(f, { mode: 0o602 })],
  ['a group-writable teams folder', f => {
    const file = sessionTeamFile(f);
    chmodSync(dirname(file), 0o770);
    return file;
  }],
  ['a group-writable legacy file', f => {
    const file = codedenTeamFile(f, [opus]);
    chmodSync(file, 0o620);
    return file;
  }],
  ['a world-writable legacy file', f => {
    const file = codedenTeamFile(f, [opus]);
    chmodSync(file, 0o602);
    return file;
  }],
  ['a legacy file in a group-writable teams folder', f => {
    const file = codedenTeamFile(f, [opus]);
    chmodSync(file, 0o600);
    chmodSync(dirname(file), 0o770);
    return file;
  }],
  ['a symlinked teams folder', f => {
    const target = sessionTeamFile(f, { dir: join(f.repo, 'outside') });
    const dir = join(f.repo, '.codeden');
    mkdirSync(dir);
    const link = join(dir, 'teams');
    symlinkSync(dirname(target), link);
    return join(link, `${sessionId}.json`);
  }],
  ['a non-UUID session filename', f => sessionTeamFile(f, { stem: 'abc', docSessionId: 'abc' })],
  ['a UUID filename with a different sessionId', f => sessionTeamFile(f, {
    docSessionId: '12345678-1234-4234-8234-123456789abd',
  })],
]) {
  test(`in-app Team: refuses ${label}`, t => {
    const f = fixture(t, 'codex');
    // Create the canonical directory for the outside-path cases so they exercise containment.
    if (label.includes('lookalike')) mkdirSync(join(f.repo, '.codeden', 'teams'), { recursive: true, mode: 0o700 });
    const result = f.run([], { TEAM_FILE: makeFile(f) });
    status(result, 2);
    assert.match(result.stderr, /TEAM_FILE_UNTRUSTED/);
  });
}

test('in-app Team: unpinned members, multi-model providers and the hash', t => {
  const app = loadAppTeam(appTeamFile(t, [{ ...opus, model: null, effort: null }, { ...astra, provider: 'opencode' }]));
  const eff = applyAppTeam(team, app, 'codex');
  assert.throws(() => reviewChain(eff, 'codex'), { message: 'TEAM_ROLE_UNSET: Set the Code Reviewer in Settings → Team' });
  const configured = loadAppTeam(appTeamFile(t, [opus]));
  assert.throws(() => reviewChain(applyAppTeam(team, configured, 'opencode'), 'opencode'), /REVIEWER_SAME_VENDOR/);
  const again = loadAppTeam(appTeamFile(t, [{ ...opus, model: null, effort: null }, { ...astra, provider: 'opencode' }]));
  assert.equal(again.sha256, app.sha256);
});

test('in-app Team: TEAM_FILE outside CodeDen\'s teams folder or naming another project is refused', t => {
  const f = fixture(t, 'codex');
  const outside = f.run([], { TEAM_FILE: appTeamFile(t, [opus, astra]) });
  status(outside, 2);
  assert.match(outside.stderr, /TEAM_FILE_UNTRUSTED/);
  const file = codedenTeamFile(f, [opus], 'p1');
  writeFileSync(file, JSON.stringify({ version: 1, projectId: 'p2', team: [opus] }));
  assert.match(f.run([], { TEAM_FILE: file }).stderr, /TEAM_FILE_UNTRUSTED/);
  const other = codedenTeamFile(f, [opus], 'p3');
  writeFileSync(other, JSON.stringify({ version: 1, projectId: 'p3', roots: [tmpdir() + '/elsewhere'], team: [opus] }));
  assert.match(f.run([], { TEAM_FILE: other }).stderr, /not in project p3's folders/);
  assert.throws(() => loadAppTeam(appTeamFile(t, [opus, opus])), /duplicate roles/);
});

test('team.json bridge: the primary is never its own fallback', () => {
  const bridge = validateTeam({ ...team, roles: { ...team.roles, codeReviewer: { ...team.roles.codeReviewer, primary: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } } } });
  assert.deepEqual(reviewChain(teamForWriter(bridge, 'codex'), 'codex').fallbacks, []);
});

test('in-app Team: a Team without an Arbiter fails closed when a ruling is needed', t => {
  const f = fixture(t, 'codex', { codex: false });
  const env = { TEAM_FILE: codedenTeamFile(f, [{ role: 'reviewer', ...neonPrimary }]), STUB_EXIT: '0' };
  for (const round of [1, 2]) {
    status(f.run([], { ...env, STUB_PRIMARY: arbFindings(`p${round}a`, `p${round}b`) }), 0);
    f.commit({ 'candidate.js': `export const answer = ${42 + round};\n` });
  }
  assert.deepEqual(f.rounds().map(round => round.reviewer.provider), ['agy', 'agy']);
  const responses = join(f.repo, 'responses.md');
  writeFileSync(responses, '- ID: 2.R1 | RESPONSE: FIXED | NOTE: done\n- ID: 2.R2 | RESPONSE: DISPUTE | NOTE: style only\n');
  const result = f.run(['--responses', responses], env);
  status(result, 2);
  assert.match(result.stderr, /TEAM_ROLE_UNSET: Set the Arbiter in Settings → Team/);
  assert.equal(f.calls().length, 2);
});

test('in-app Team: routes an agy fallback through the wrapper after a Codex primary fails', t => {
  const f = fixture(t, 'claude', { codex: false });
  const TEAM_FILE = codedenTeamFile(f, [
    { role: 'reviewer', provider: 'codex', model: 'gpt-6.2-astra', effort: 'high' },
    { role: 'reviewerFallback', ...neonPrimary },
  ]);
  status(f.run([], { TEAM_FILE, STUB_EXIT: '0' }), 0);
  assert.deepEqual(f.calls()[0][4].slice(-10), [
    '--role', 'codeReviewer', '--writer', 'claude',
    '--provider', neonPrimary.provider, '--model', neonPrimary.model, '--effort', neonPrimary.effort,
  ]);
  assert.deepEqual(f.rounds().map(({ slot, status }) => [slot, status]), [
    ['primary', 'unavailable'], ['fallback', 'completed'],
  ]);
});

test('in-app Team: an empty TEAM_FILE uses team.json', t => {
  const f = fixture(t, 'codex');
  status(f.run([], { TEAM_FILE: '', STUB_EXIT: '0' }), 0);
  assert.equal(f.rounds()[0].reviewer.provider, 'agy');
});

test('team.json: a primary of the writer\'s vendor gives way to the writer\'s fallback', () => {
  const bridge = validateTeam({ ...team, roles: { ...team.roles, codeReviewer: { ...team.roles.codeReviewer, primary: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } } } });
  Object.defineProperty(bridge, 'sha256', { value: team.sha256, enumerable: false });
  assert.throws(() => reviewChain(bridge, 'claude'), /REVIEWER_SAME_VENDOR/);
  const forClaude = teamForWriter(bridge, 'claude');
  assert.deepEqual(reviewChain(forClaude, 'claude').primary, { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high' });
  assert.deepEqual(reviewChain(teamForWriter(bridge, 'codex'), 'codex').primary, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
});

test('in-app Team: run uses the Team reviewer (Opus for Codex code), not the Neon wrapper, and the gate accepts it', t => {
  const f = fixture(t, 'codex', { codex: false });
  const file = codedenTeamFile(f, [opus, astra, { role: 'writer', ...team.roles.writer }]);
  status(f.run([], { TEAM_FILE: file }), 0);
  const [round] = f.rounds();
  assert.equal(round.slot, 'primary');
  assert.deepEqual([round.reviewer.provider, round.reviewer.model, round.reviewer.effort], ['claude', 'claude-opus-5-5', 'high']);
  assert.equal(round.verdict, 'CLEAN');
  assert.ok(f.calls().every(([who]) => who !== 'primary'), 'Neon wrapper must not run');
  const r = checkRun(f.repo, 'r1', f.base, applyAppTeam(team, loadAppTeam(file)));
  assert.ok(r.ok, r.problems.join('\n'));
});

test('in-app Team: a recorded primary alias requires canonical init-model evidence', t => {
  const f = fixture(t, 'codex');
  const file = codedenTeamFile(f, [{ ...opus, model: 'opus' }, { ...opus, role: 'browserOperator' }, astra]);
  status(f.run([], { TEAM_FILE: file }), 0);
  const effective = applyAppTeam(team, loadAppTeam(file));
  const [round] = f.rounds();
  const fullIdRound = { ...round, reviewer: { ...round.reviewer, model: opus.model } };
  const { initModel, ...evidence } = round.evidence;
  assert.equal(initModel, 'claude-opus-5-5');

  for (const receipt of [round, fullIdRound]) {
    f.rewrite([{ ...receipt, evidence }]);
    const check = checkRun(f.repo, 'r1', f.base, effective);
    assert.equal(check.ok, false, receipt.reviewer.model);
    assert.match(check.problems.join('\n'), /PRIMARY_UNVERIFIED/);
  }

  for (const receipt of [round, fullIdRound]) {
    f.rewrite([receipt]);
    const check = checkRun(f.repo, 'r1', f.base, effective);
    assert.ok(check.ok, check.problems.join('\n'));
  }
});

test('in-app Team: Claude-written code goes to the next cross-vendor member; an all-Claude Team refuses', t => {
  const f = fixture(t, 'claude');
  status(f.run([], { TEAM_FILE: codedenTeamFile(f, [opus, astra]) }), 0);
  const [round] = f.rounds();
  assert.deepEqual([round.slot, round.reviewer.provider, round.reviewer.model], ['primary', 'codex', 'gpt-6.2-astra']);
  const g = fixture(t, 'claude');
  putFixtureTeam(join(g.repo, '.config', 'trioharness'), {});
  const refused = g.run([], { TEAM_FILE: codedenTeamFile(g, [opus]) });
  status(refused, 2);
  assert.match(refused.stderr, /REVIEWER_SAME_VENDOR/);
});

// ---- Arbiter (arbiter.mjs): the code dispute through team-review.mjs run, and the plan dispute through arbitrate ----
const arbFindings = (a = 'p1', b = 'p2') => `REVIEW_DECISION: FINDINGS\nFINDINGS:\n- ID: R1 | SEVERITY: HIGH | FILE: candidate.js:1 | PROBLEM: ${a} | EVIDENCE: e | MINIMAL FIX: m\n- ID: R2 | SEVERITY: LOW | FILE: candidate.js:1 | PROBLEM: ${b} | EVIDENCE: e | MINIMAL FIX: m\nOUT_OF_SCOPE_RISKS: none\nNON_FINDINGS: none\nSUMMARY: high=1 medium=0 low=1\n`;
const arbRuling = 'ARBITER_DECISION: APPROVE\nRULINGS:\n- ID: 2.R1 | RULING: VALID-must-fix | REASON: real at candidate.js:1\n- ID: 2.R2 | RULING: INVALID | REASON: style only, candidate.js:1\n';
function arbFixture(t, arbiterPatch = {}) {
  const { provider = 'claude', model = 'claude-fable-5-2', effort = 'high', ...limits } = arbiterPatch;
  const f = fixture(t, 'codex', { codex: false, limits, arbiter: { provider, model, effort } });
  const fixtureTeam = loadTeam(join(f.repo, '.config', 'trioharness', 'team.json'));
  const responses = join(f.repo, 'responses.md');
  writeFileSync(responses, '- ID: 2.R1 | RESPONSE: FIXED | NOTE: done\n- ID: 2.R2 | RESPONSE: DISPUTE | NOTE: style only\n');
  const env = { STUB_EXIT: '0', STUB_PRIMARY: arbFindings(), STUB_CLAUDE_MODEL: 'claude-fable-5-2' };
  let n = 0;
  const fix = () => f.commit({ 'candidate.js': `export const answer = ${43 + n++};\n` });
  const rows = () => readFileSync(join(f.dir, 'ESCALATION.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const arbiterCalls = () => f.calls().filter(c => c[0] === 'fallback');
  const toArbiter = (rounds = 2, advance = true) => { for (let i = 0; i < rounds; i++) { status(f.run([], { ...env, STUB_PRIMARY: arbFindings(`p${i}a`, `p${i}b`) }), 0); if (i + 1 < rounds || advance) fix(); } };
  const blocked = () => JSON.parse(readFileSync(join(f.dir, 'ITEM_BLOCKED.json'), 'utf8'));
  const arbitrate = (subject, args = [], extra = {}) => spawnSync(process.execPath, ['--import', join(f.repo, 'home.mjs'), fileURLToPath(new URL('./team-review.mjs', import.meta.url)),
    'arbitrate', '--scope', 'plan', '--repo', f.repo, '--run', 'r1', '--writer', 'codex', '--subject', subject, ...args],
    { encoding: 'utf8', env: { ...process.env, TRIOHARNESS_TEAM_HOME: f.repo, PATH: join(f.repo, '.codex', 'bin') + delimiter + process.env.PATH, TEAM_FILE: '', STUB_CALLS: join(f.repo, 'calls.jsonl'), STUB_CLAUDE_MODEL: 'claude-fable-5-2', ...extra } });
  const planReport = (n, verdict, finding = `[BLOCKING] P0${n} plan.md:${n} gap ${n} -> fix`) => { const p = join(f.dir, 'workers', `plan-reviewer-${n}.md`); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `VERDICT: ${verdict}\nFINDINGS:\n${verdict === 'APPROVE' ? '' : `${finding}\n`}FALSE_PREMISES: none\n`); return p; };
  return { ...f, env, fix, rows, responses, arbiterCalls, toArbiter, blocked, arbitrate, planReport, team: fixtureTeam, check: () => checkRun(f.repo, 'r1', f.base, fixtureTeam) };
}

test('agy Arbiter: uses the wrapper and counts exactly one verified ruling', t => {
  const f = arbFixture(t, neonPrimary);
  const teamFile = codedenTeamFile(f, [
    { role: 'reviewer', ...neonPrimary }, { role: 'arbiter', ...neonPrimary, provider: 'antigravity' },
  ]);
  const env = { ...f.env, TEAM_FILE: teamFile };
  for (let i = 0; i < 2; i++) {
    status(f.run([], { ...env, STUB_PRIMARY: arbFindings(`p${i}a`, `p${i}b`) }), 0);
    f.fix();
  }
  const args = ['--responses', f.responses];
  const mismatch = f.run(args, { ...env, STUB_PRIMARY: arbRuling, STUB_INIT_MODEL: 'another-model' });
  status(mismatch, 2);
  assert.match(mismatch.stderr, /unverified model/);
  assert.equal(arb.itemUsage(f.dir).arbiter, 0);
  status(f.run(args, { ...env, STUB_PRIMARY: arbRuling }), 0);
  const calls = f.calls();
  assert.deepEqual(calls.map(call => call[4].slice(-10)), [
    ['--role', 'codeReviewer', '--writer', 'codex', '--provider', neonPrimary.provider, '--model', neonPrimary.model, '--effort', neonPrimary.effort],
    ['--role', 'codeReviewer', '--writer', 'codex', '--provider', neonPrimary.provider, '--model', neonPrimary.model, '--effort', neonPrimary.effort],
    ['--role', 'arbiter', '--writer', 'codex', '--provider', neonPrimary.provider, '--model', neonPrimary.model, '--effort', neonPrimary.effort],
    ['--role', 'arbiter', '--writer', 'codex', '--provider', neonPrimary.provider, '--model', neonPrimary.model, '--effort', neonPrimary.effort],
  ]);
  const [fault, ruling] = f.rows().filter(row => row.kind === 'arbiter');
  assert.equal(fault.status, 'tooling-fault');
  assert.deepEqual([ruling.status, ruling.decision, ruling.arbiter.provider], ['completed', 'APPROVE', 'agy']);
  assert.equal(arb.itemUsage(f.dir).arbiter, 1);
});

test('a Team that sets the Arbiter runs it with that pin', t => {
  const f = arbFixture(t);
  f.toArbiter(2);
  const primaries = f.calls().length;
  const noResponses = f.run([], f.env);
  status(noResponses, 2);
  assert.match(noResponses.stderr, /ARBITER_NEEDS_RESPONSES: 2 fix rounds without approval .*\(2\.R1, 2\.R2\)/);
  assert.equal(f.calls().length, primaries, 'no reviewer round 3 started');
  assert.ok(f.check().problems.some(p => /ARBITER_RULING_MISSING/.test(p)), 'a missing ruling blocks the merge check');
  const ruled = f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling, STUB_REQUIRE_START: join(f.dir, 'ESCALATION.jsonl') });
  status(ruled, 0);
  assert.match(ruled.stdout, /Arbiter: code ruling claude\/claude-fable-5-2\/high APPROVE \(receipt [0-9a-f-]+\); 2\.R1 VALID-must-fix, 2\.R2 INVALID/);
  assert.match(ruled.stdout, /Formula: the regular reviewer confirms the VALID fixes; Arbiter calls 1 of 1; model rounds 3 of 8/);
  const packet = f.arbiterCalls().at(-1)[1];
  for (const part of ['Open findings (rule on each ID):', '- ID: 2.R1 | SEVERITY: HIGH', 'RESPONSE: DISPUTE', 'Frozen files', 'Earlier rounds:', 'ARBITER_DECISION: APPROVE | BLOCK']) assert.ok(packet.includes(part), part);
  const args = f.arbiterCalls().at(-1)[2];
  assert.equal(args[args.indexOf('--tools') + 1], '', 'the Arbiter has no file tools');
  assert.ok(!args.includes('--add-dir'), 'the repository is outside the Arbiter input');
  assert.match(packet, /export const answer/, 'scanned evidence is provided on stdin');
  assert.ok(!readFileSync(f.rows().find(r => r.kind === 'arbiter').packetPath, 'utf8').includes('export const answer'), 'the saved packet keeps diff references');
  const diffFile = packet.match(/- diff\.md \([^)]*\): (\S+) sha256/)[1];
  assert.match(readFileSync(diffFile, 'utf8'), /candidate\.js/, 'the frozen diff packet exists in the attempt folder');
  assert.ok(/report-round-2-primary\.md: \S+ sha256/.test(packet), 'the reviewer report is a frozen copy');
  const ruling = f.rows().find(r => r.kind === 'arbiter');
  assert.deepEqual([ruling.mode, ruling.status, ruling.decision, ruling.rulings.map(r => r.ruling), ruling.rulings[0].source.round], ['ruling', 'completed', 'APPROVE', ['VALID-must-fix', 'INVALID'], 2]);
  assert.ok(f.check().problems.some(p => /ARBITER_CONFIRM_MISSING: code: 2\.R1 .*regular reviewer/.test(p)), 'APPROVE with a VALID finding is not a pass');
  assert.match(f.run([], f.env).stderr, /ARBITER_CONFIRM_NEEDS_FIX/);
  f.fix();
  const confirmed = f.run([], { ...f.env, STUB_PRIMARY: clean });
  status(confirmed, 0);
  assert.match(confirmed.stdout, /Arbiter: code confirm by the regular reviewer APPROVE/);
  assert.equal(f.arbiterCalls().length, 1, 'there is no second Arbiter call');
  assert.match(f.calls().at(-1)[3], /found these findings VALID[\s\S]*2\.R1 \[HIGH\]/, 'the confirming reviewer sees the VALID findings');
  assert.deepEqual(f.check().problems, []);
  assert.match(f.run([], f.env).stderr, /ARBITER_FINAL/);
  f.report(clean);
  status(f.record('fallback'), 2);
  assert.match(readFileSync(join(f.dir, 'workers', 'arbiter-rulings.md'), 'utf8'), /\| 2\.R2 \| LOW \| INVALID \| style only, candidate\.js:1 \|/);
  assert.ok(!existsSync(join(f.dir, 'jev-receipts.jsonl')), 'the Arbiter never writes Jev state');
});

test('c2: the 7 + 2 > 8 ceiling permits one verified high-risk confirmation', t => {
  const f = arbFixture(t, { totalRounds: 8 });
  f.toArbiter(1);
  status(f.run(['--high-risk'], { ...f.env, STUB_PRIMARY: arbFindings('p1a', 'p1b'), STUB_SECOND_PRIMARY: clean }), 0);
  const receipt = gate => JSON.stringify({ gate, pass: true, verdict: 'proceed' });
  writeFileSync(join(f.dir, 'jev-receipts.jsonl'), [receipt('plan'), receipt('plan'), receipt('done')].join('\n') + '\n');
  writeFileSync(f.responses, readFileSync(f.responses, 'utf8').replaceAll('2.R', '3.R'));
  const ruled = f.run(['--high-risk', '--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling.replaceAll('2.R', '3.R') });
  assert.equal(arb.itemUsage(f.dir).total, 7, ruled.stderr + ruled.stdout);
  const ruling = f.rows().find(row => row.kind === 'arbiter');
  const ledger = join(f.dir, 'ESCALATION.jsonl');
  const rows = f.rows().map(({ run, ...row }) => row);
  writeFileSync(ledger, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const latch = join(f.dir, 'ITEM_BLOCKED.json');
  if (!existsSync(latch)) arb.writeBlocked(f.dir, { reason: 'ROUNDS_CEILING: 7 of 8 model rounds used; the confirming round needs 2' });
  else assert.match(ruled.stderr, /ROUNDS_CEILING: 7 of 8/);
  const blocked = readFileSync(latch, 'utf8');
  assert.match(f.run(['--high-risk'], f.env).stderr, /ARBITER_CONFIRM_NEEDS_FIX/);
  const original = f.git('rev-parse', 'HEAD');
  f.git('checkout', '--detach', f.base);
  assert.match(f.run(['--high-risk'], f.env).stderr, /ARBITER_CONFIRM_NEEDS_FIX/);
  assert.equal(readFileSync(latch, 'utf8'), blocked);
  f.git('checkout', '--detach', original);
  f.fix();
  const args = [];
  const env = { ...f.env, STUB_PRIMARY: clean };
  const report = readFileSync(ruling.output);
  rmSync(ruling.output);
  assert.match(f.run(args, env).stderr, /ITEM_BLOCKED/);
  writeFileSync(ruling.output, 'changed receipt');
  assert.match(f.run(args, env).stderr, /ITEM_BLOCKED/);
  writeFileSync(ruling.output, report);
  writeFileSync(latch, blocked.replace('ROUNDS_CEILING:', 'OTHER_BLOCK:'));
  assert.match(f.run(args, env).stderr, /ITEM_BLOCKED/);
  writeFileSync(latch, blocked);
  status(f.run(args, env), 0);
  assert.equal(arb.itemUsage(f.dir).total, 9);
  assert.deepEqual(f.rounds().slice(-2).map(row => row.slot), ['primary', 'second-pass']);
  assert.equal(existsSync(latch), false);
  assert.deepEqual(f.check().problems, []);
  assert.match(f.run(args, env).stderr, /ARBITER_FINAL/);
});

test('c2: a missing required high-risk second pass can run once at 8/8', t => {
  const f = arbFixture(t, { totalRounds: 8 });
  f.commit({ 'AGENTS.md': '## High-risk paths\n- candidate.js\n' });
  const head = f.git('rev-parse', 'HEAD');
  const receipt = JSON.stringify({ gate: 'plan', pass: true, verdict: 'proceed' });
  writeFileSync(join(f.dir, 'jev-receipts.jsonl'), Array(7).fill(receipt).join('\n') + '\n');
  const env = { ...f.env, STUB_PRIMARY: clean };
  const first = f.run([], env);
  status(first, 2);
  assert.match(first.stderr, /ROUNDS_CEILING: 8 of 8/);
  assert.equal(arb.itemUsage(f.dir).total, 8);
  assert.deepEqual(f.rounds().map(({ slot, verdict }) => [slot, verdict]), [['primary', 'CLEAN']]);
  assert.match(f.check().reviewProblems.join('\n'), /SECOND_PASS_MISSING/);
  const blocked = f.blocked();
  const original = f.rounds()[0];
  const report = readFileSync(original.output);
  writeFileSync(original.output, 'changed report');
  assert.match(f.run([], env).stderr, /ITEM_BLOCKED/);
  assert.equal(f.calls().length, 1);
  writeFileSync(original.output, report);
  status(f.run([], env), 0);
  assert.equal(arb.itemUsage(f.dir).total, 9);
  assert.equal(f.rounds()[1].run, 'r1');
  assert.equal(f.rounds()[1].packetSha256, original.packetSha256);
  assert.deepEqual(f.rounds().map(({ slot, verdict, head: at }) => [slot, verdict, at]),
    [['primary', 'CLEAN', head], ['second-pass', 'CLEAN', head]]);
  assert.deepEqual(f.rows().filter(row => row.kind === 'ceiling-second-pass-start').map(({ run, head: at }) => [run, at]),
    [['r1', head]]);
  assert.equal(f.calls().length, 2);
  assert.deepEqual(f.blocked(), blocked);
  assert.deepEqual(f.check().problems, []);
  assert.match(f.run([], env).stderr, /ITEM_BLOCKED/);
  assert.equal(f.calls().length, 2);
});

test('c2: ceiling second-pass fallback uses the primary launcher exit-3 evidence', t => {
  const f = arbFixture(t, { totalRounds: 8 });
  const config = join(f.repo, '.config', 'trioharness');
  putFixtureTeam(config, { reviewer: opus, reviewerFallback: neonPrimary, writer: codexWriter });
  const effective = loadTeam(join(config, 'team.json'));
  f.commit({ 'AGENTS.md': '## High-risk paths\n- candidate.js\n' });
  const receipt = JSON.stringify({ gate: 'plan', pass: true, verdict: 'proceed' });
  writeFileSync(join(f.dir, 'jev-receipts.jsonl'), Array(7).fill(receipt).join('\n') + '\n');
  const env = { ...f.env, STUB_PRIMARY: clean, STUB_FALLBACK: clean, STUB_CLAUDE_MODEL: 'claude-opus-5-5' };
  const first = f.run([], env);
  status(first, 2);
  assert.match(first.stderr, /ROUNDS_CEILING: 8 of 8/);
  status(f.run([], { ...env, STUB_CLAUDE_EXIT: '1' }), 0);
  assert.deepEqual(f.rounds().map(row => [row.slot, row.status, row.reviewer.provider]), [
    ['primary', 'completed', 'claude'],
    ['second-pass', 'unavailable', 'claude'],
    ['second-pass', 'completed', 'agy'],
  ]);
  assert.deepEqual(checkRun(f.repo, 'r1', f.base, effective).problems, []);
});

test('c2: record binds the ceiling block to the code run and head', t => {
  const f = arbFixture(t, { reviewFixRounds: 3, totalRounds: 8 });
  f.toArbiter(2, false);
  const receipt = JSON.stringify({ gate: 'plan', pass: true, verdict: 'proceed' });
  writeFileSync(join(f.dir, 'jev-receipts.jsonl'), Array(6).fill(receipt).join('\n') + '\n');
  const recorded = f.record('fallback');
  status(recorded, 2);
  assert.match(recorded.stderr, /ROUNDS_CEILING: 8 of 8/);
  const { scope, head, run } = f.blocked();
  assert.deepEqual([scope, head, run], ['code', f.git('rev-parse', 'HEAD'), 'r1']);
});

test('c2: the exhausted Arbiter cap supersedes a held ceiling block', t => {
  const f = arbFixture(t, { reviewFixRounds: 3, totalRounds: 8, callsPerItem: 1 });
  f.toArbiter(1);
  const receipt = JSON.stringify({ gate: 'plan', pass: true, verdict: 'proceed' });
  writeFileSync(join(f.dir, 'jev-receipts.jsonl'), Array(6).fill(receipt).join('\n') + '\n');
  status(f.run([], { ...f.env, STUB_PRIMARY: arbFindings('second', 'other') }), 2);
  assert.match(f.blocked().reason, /^ROUNDS_CEILING/);
  const result = f.run(['--responses', f.responses], { ...f.env, STUB_CLAUDE_EXIT: '1' });
  status(result, 2);
  assert.match(result.stderr, /ARBITER_CAP/);
  assert.match(f.blocked().reason, /^ARBITER_CAP/);
  assert.ok(f.rows().some(row => row.kind === 'blocked' && row.supersedes?.reason.startsWith('ROUNDS_CEILING:')));
});

test('c2: code and Jev done each have a ceiling Arbiter call', t => {
  const f = arbFixture(t, { totalRounds: 8, callsPerItem: 1, jevReviewRounds: 1 });
  f.toArbiter(2, false);
  status(f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling.replace('VALID-must-fix', 'INVALID') }), 0);
  const head = f.git('rev-parse', 'HEAD');
  const refusals = ['2026-01-01', '2026-01-03'].map(date => ({ at: date + 'T00:00:00.000Z', gate: 'done', pass: false,
    verdict: 'revise', reasons: ['J1 candidate.js:1'] }));
  const receipts = [...refusals, ...Array.from({ length: 2 }, () => ({ gate: 'plan', pass: true, verdict: 'proceed' }))];
  writeFileSync(join(f.dir, 'jev-receipts.jsonl'), receipts.map(r => JSON.stringify(r)).join('\n') + '\n');
  const output = join(f.dir, 'workers', 'jev-done-review.md');
  writeFileSync(output, clean);
  arb.appendEscalation(f.dir, { kind: 'jev-review', scope: 'jev-done', status: 'completed', verdict: 'CLEAN', head: f.base,
    completedAt: '2026-01-02T00:00:00.000Z', reviewer: neonPrimary, output, outputSha256: digest(clean) });
  assert.equal(arb.itemUsage(f.dir).total, 8);
  arb.blockJevAtCap(f.team, f.dir, 'done');
  assert.equal(f.blocked().head, head);
  const args = ['--scope', 'jev-done'];
  status(f.call('arbitrate', args, { ...f.env,
    STUB_FALLBACK: 'ARBITER_DECISION: APPROVE\nRULINGS:\n- ID: j1 | RULING: INVALID | REASON: candidate.js:1\n' }), 0);
  assert.equal(arb.itemUsage(f.dir).total, 9);
  assert.equal(arb.itemBlocked(f.dir), null);
  assert.deepEqual(f.rows().filter(row => row.kind === 'arbiter').map(row => [row.scope, row.run, row.head]),
    [['code', 'r1', head], ['jev-done', 'r1', head]]);
  assert.deepEqual(f.check().problems, []);
  assert.match(f.call('arbitrate', args, f.env).stderr, /ARBITER_FINAL/);
});

test('c2: plan gets one hash-bound confirmation at the ceiling', t => {
  const f = arbFixture(t, { totalRounds: 2, reviewFixRounds: 1 });
  const plan = join(f.repo, 'plan.md');
  writeFileSync(plan, 'Original plan\n');
  f.planReport(1, 'AMEND');
  const head = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.dir, 'jev-receipts.jsonl'), JSON.stringify({ gate: 'plan', pass: true, verdict: 'proceed' }) + '\n');
  arb.writeBlocked(f.dir, { reason: 'ROUNDS_CEILING: 2 of 2 model rounds used', binding: { scope: 'plan', run: 'r1', head } });
  writeFileSync(f.responses, '- ID: p1.P01 | RESPONSE: ACCEPTED | NOTE: fixed\n');
  status(f.arbitrate(plan, ['--responses', f.responses], {
    STUB_FALLBACK: 'ARBITER_DECISION: APPROVE\nRULINGS:\n- ID: p1.P01 | RULING: VALID-must-fix | REASON: plan.md:1\n',
  }), 0);
  assert.equal(arb.itemUsage(f.dir).total, 3);
  writeFileSync(plan, 'Fixed plan\n');
  const reviewed = reservePlanReview(f.team, f.dir, 2, plan);
  assert.equal(reviewed.row.head, head);
  assert.throws(() => reservePlanReview(f.team, f.dir, 3, plan), /ARBITER_CONFIRM_EXISTS/);
  const report = f.planReport(2, 'APPROVE');
  arb.appendEscalation(f.dir, { kind: 'plan-review-finish', startId: reviewed.row.id, sha256: digest(readFileSync(report)) });
  status(f.arbitrate(plan), 0);
  assert.equal(arb.itemUsage(f.dir).total, 4);
  assert.equal(arb.itemBlocked(f.dir), null);
  assert.deepEqual(f.check().arbiterProblems, []);
  assert.match(f.arbitrate(plan).stderr, /ARBITER_FINAL/);
  f.fix();
  assert.deepEqual(f.check().arbiterProblems, [], 'a later code head does not invalidate the already verified plan');
});

test('c2: a newly ruled ceiling latch stays held until its confirmation', t => {
  const f = arbFixture(t, { totalRounds: 8, reviewFixRounds: 3 });
  f.toArbiter(1);
  const receipt = gate => JSON.stringify({ gate, pass: true, verdict: 'proceed' });
  writeFileSync(join(f.dir, 'jev-receipts.jsonl'), Array.from({ length: 6 }, () => receipt('plan')).join('\n') + '\n');
  status(f.run([], { ...f.env, STUB_PRIMARY: arbFindings('second', 'other') }), 2);
  const latch = f.blocked();
  assert.match(latch.reason, /^ROUNDS_CEILING: 8 of 8/);
  assert.equal(latch.ruling, null);
  status(f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling }), 0);
  assert.deepEqual(f.blocked(), latch);
  f.fix();
  status(f.run([], { ...f.env, STUB_PRIMARY: clean }), 0);
  assert.equal(arb.itemBlocked(f.dir), null);
});

test('c2: an unbound ceiling latch cannot authorize a new code ruling', t => {
  const f = arbFixture(t);
  f.toArbiter(2, false);
  arb.writeBlocked(f.dir, { reason: 'ROUNDS_CEILING: 8 of 8 model rounds used' });
  const result = f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling.replace('VALID-must-fix', 'INVALID') });
  status(result, 2);
  assert.match(result.stderr, /ITEM_BLOCKED/);
  assert.equal(f.arbiterCalls().length, 0);
});

test('c2: a failed ceiling confirmation records the final block', t => {
  const f = arbFixture(t);
  f.toArbiter(2, false);
  status(f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling }), 0);
  arb.writeBlocked(f.dir, { reason: 'ROUNDS_CEILING: 7 of 8 model rounds used; the confirming round needs 2' });
  f.fix();
  const result = f.run(['--high-risk'], { ...f.env, STUB_SECOND_PRIMARY: clean });
  status(result, 2);
  assert.match(result.stderr, /CONFIRM_FAILED/);
  assert.match(f.blocked().reason, /^CONFIRM_FAILED/);
  assert.ok(f.rows().some(row => row.kind === 'blocked' && row.supersedes?.reason.startsWith('ROUNDS_CEILING:')));
});

const c21Receipt = JSON.stringify({ gate: 'plan', pass: true, verdict: 'proceed' });
const c21AtCeiling = (f, n) => writeFileSync(join(f.dir, 'jev-receipts.jsonl'), Array(n).fill(c21Receipt).join('\n') + '\n');

for (const severity of ['LOW', 'MEDIUM', 'HIGH']) {
  test(`c2.1: ${severity} primary findings at 8/8`, t => {
    const f = arbFixture(t, { totalRounds: 8 });
    f.commit({ 'AGENTS.md': '## High-risk paths\n- candidate.js\n' });
    c21AtCeiling(f, 7);
    const summary = ['high', 'medium', 'low'].map(key => `${key}=${Number(key.toUpperCase() === severity) + Number(key === 'low')}`).join(' ');
    const report = arbFindings().replace('SEVERITY: HIGH', `SEVERITY: ${severity}`).replace('high=1 medium=0 low=1', summary);
    const first = f.run([], { ...f.env, STUB_PRIMARY: report });
    status(first, 2);
    assert.match(first.stderr, /ROUNDS_CEILING: 8 of 8/);
    assert.deepEqual(f.rounds().map(r => r.verdict), ['FINDINGS']);
    assert.equal(arb.itemUsage(f.dir).total, 8);
    const recovery = { ...f.env, STUB_PRIMARY: clean };
    if (severity !== 'LOW') {
      assert.match(f.run([], recovery).stderr, /ITEM_BLOCKED/);
      assert.equal(f.calls().length, 1);
      return;
    }
    const primary = f.rounds()[0];
    writeFileSync(primary.output, report + '\n');
    assert.match(f.run([], recovery).stderr, /ITEM_BLOCKED/);
    assert.equal(f.calls().length, 1);
    writeFileSync(primary.output, report);
    status(f.run([], recovery), 0);
    assert.deepEqual(f.rounds().map(r => [r.slot, r.verdict]), [['primary', 'FINDINGS'], ['second-pass', 'CLEAN']]);
    assert.deepEqual(f.check().problems, []);
  });
}

test('c2.1: Jev done suspension permits clean delivery at 8/8 without a model round', t => {
  const f = arbFixture(t, { totalRounds: 8 });
  status(f.run([], { ...f.env, STUB_PRIMARY: clean }), 0);
  c21AtCeiling(f, 7);
  arb.blockJevAtCap(f.team, f.dir, 'done');
  const blocked = f.blocked();
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(blocked.head, head);
  assert.match(blocked.reason, /ROUNDS_CEILING: 8 of 8/);
  const policyFile = readFileSync(join(teamDir(), 'jev-receipt-policy.mjs'), 'utf8');
  assert.match(policyFile, /export const JEV_RECEIPT_REQUIRED = (true|false);/);
  const required = policyFile.includes('JEV_RECEIPT_REQUIRED = true');
  const args = ['--scope', 'jev-done', '--base', f.base];
  const result = f.call('arbitrate', args, f.env);
  if (required) {
    status(result, 2);
    assert.match(result.stderr, /JEV_REFUSAL_REQUIRED/);
    assert.ok(!f.rows().some(row => row.kind === 'jev-suspension'));
  } else {
    status(result, 0);
    status(f.call('arbitrate', args, f.env), 0);
    assert.deepEqual(f.rows().filter(row => row.kind === 'jev-suspension').map(row => [row.run, row.head]), [['r1', head]]);
    assert.deepEqual(f.check().problems, []);
  }
  assert.deepEqual(f.blocked(), blocked);
  assert.equal(f.calls().length, 1);
  assert.equal(arb.itemUsage(f.dir).total, 8);
  assert.ok(!arb.jevReceipts(f.dir).some(row => row.gate === 'done'));
});

function c21Fault(t, legacyMarker = true) {
  const f = arbFixture(t, { reviewFixRounds: 3, totalRounds: 8, callsPerItem: 1 });
  f.toArbiter(1);
  c21AtCeiling(f, 6);
  status(f.run([], { ...f.env, STUB_PRIMARY: arbFindings('second', 'other') }), 2);
  const args = ['--responses', f.responses];
  const value = 'example-' + 'diagnostic-value';
  const faultEnv = { ...f.env, STUB_CLAUDE_EXIT: '1', STUB_CLAUDE_ERROR: `Temporary reviewer failure; token=${value}` };
  status(f.run(args, faultEnv), 2);
  const failed = f.rows().find(row => row.kind === 'arbiter' && row.status === 'tooling-fault');
  assert.ok(failed);
  const blockPath = join(f.dir, 'ITEM_BLOCKED.json');
  const block = f.blocked();
  const legacy = { ...block, reason: `ROUNDS_CEILING: 8 of 8 model rounds used after ARBITER_UNAVAILABLE: ${failed.toolingReason}` };
  if (legacyMarker) writeFileSync(blockPath, JSON.stringify(legacy));
  return { ...f, args, faultEnv, failed, value, blockPath, legacy };
}

test('c2.1: a tooling-fault ceiling permits one exact-head Arbiter retry', t => {
  const f = c21Fault(t);
  assert.equal(arb.itemUsage(f.dir).arbiter, 0);
  assert.match(f.run([], f.env).stderr, /ITEM_BLOCKED|ARBITER_NEEDS_RESPONSES/);
  const head = f.git('rev-parse', 'HEAD');
  f.fix();
  assert.match(f.run(f.args, f.env).stderr, /ITEM_BLOCKED/);
  f.git('checkout', '--detach', head);
  const env = { ...f.env, STUB_FALLBACK: arbRuling.replace('VALID-must-fix', 'INVALID') };
  const packet = join(f.repo, 'packet.md');
  const brief = readFileSync(packet, 'utf8');
  f.writePacket(brief + '\nDifferent scope.\n');
  const changed = f.run(f.args, env);
  status(changed, 2);
  assert.match(changed.stderr, /ITEM_BLOCKED/);
  assert.equal(f.arbiterCalls().length, 1);
  f.writePacket(brief);
  status(f.run(f.args, env), 0);
  const retry = f.rows().find(row => row.kind === 'arbiter' && row.status === 'completed');
  assert.deepEqual([retry.retryOf, retry.run, retry.head], [f.failed.id, 'r1', f.git('rev-parse', 'HEAD')]);
  assert.equal(arb.itemUsage(f.dir).arbiter, 1);
  assert.equal(f.arbiterCalls().length, 2);
  assert.equal(arb.itemBlocked(f.dir), null);
  assert.match(f.failed.evidence.cliErrorExcerpt, /Temporary reviewer failure.*\[REDACTED\]/);
  assert.ok(!f.failed.evidence.cliErrorExcerpt.includes(f.value));
});

test('c2.1: a recovered Arbiter ruling retains the cap latch until confirmation', t => {
  const f = c21Fault(t, false);
  assert.match(f.blocked().reason, /^ARBITER_CAP/);
  status(f.run(f.args, { ...f.env, STUB_FALLBACK: arbRuling }), 0);
  assert.match(f.blocked().reason, /^ARBITER_CAP/);
  assert.match(f.run([], f.env).stderr, /ARBITER_CONFIRM_NEEDS_FIX/);
  f.fix();
  status(f.run([], { ...f.env, STUB_PRIMARY: clean }), 0);
  assert.equal(arb.itemBlocked(f.dir), null);
  assert.deepEqual(f.check().problems, []);
});

test('c2.1: a plan Arbiter retry cannot confirm on a different head', t => {
  const f = arbFixture(t, { totalRounds: 2, reviewFixRounds: 1 });
  const plan = join(f.repo, 'plan.md');
  writeFileSync(plan, 'Original plan\n');
  f.planReport(1, 'AMEND');
  c21AtCeiling(f, 1);
  const head = f.git('rev-parse', 'HEAD');
  arb.writeBlocked(f.dir, { reason: 'ROUNDS_CEILING: 2 of 2 model rounds used', binding: { scope: 'plan', run: 'r1', head } });
  writeFileSync(f.responses, '- ID: p1.P01 | RESPONSE: ACCEPTED | NOTE: fixed\n');
  const args = ['--responses', f.responses];
  status(f.arbitrate(plan, args, { STUB_CLAUDE_EXIT: '1' }), 2);
  assert.match(f.blocked().reason, /^ARBITER_CAP/);
  status(f.arbitrate(plan, args, {
    STUB_FALLBACK: 'ARBITER_DECISION: APPROVE\nRULINGS:\n- ID: p1.P01 | RULING: VALID-must-fix | REASON: plan.md:1\n',
  }), 0);
  const blocked = f.blocked();
  writeFileSync(plan, 'Fixed plan\n');
  f.fix();
  assert.throws(() => reservePlanReview(f.team, f.dir, 2, plan), /ITEM_BLOCKED/);
  assert.match(f.arbitrate(plan).stderr, /ITEM_BLOCKED/);
  assert.deepEqual(f.blocked(), blocked);
  assert.equal(f.arbiterCalls().length, 2);
});

test('c2.1: a second Arbiter tooling fault stays blocked', t => {
  const f = c21Fault(t);
  status(f.run(f.args, f.faultEnv), 2);
  assert.equal(f.arbiterCalls().length, 2);
  assert.equal(arb.itemUsage(f.dir).arbiter, 0);
  assert.match(f.run(f.args, f.env).stderr, /ITEM_BLOCKED/);
  assert.equal(f.arbiterCalls().length, 2);
  assert.ok(arb.itemBlocked(f.dir));
});

test('c2.1: an unrelated block does not permit an Arbiter retry', t => {
  const f = c21Fault(t);
  writeFileSync(f.blockPath, JSON.stringify({ ...f.legacy, reason: 'CONFIRM_FAILED: unrelated block' }));
  assert.match(f.run(f.args, f.env).stderr, /ITEM_BLOCKED/);
  assert.equal(f.arbiterCalls().length, 1);
});

test('c2.1: an interrupted retry dispatch consumes the single retry', t => {
  const f = c21Fault(t);
  const start = JSON.parse(readFileSync(join(f.dir, 'ESCALATION.jsonl'), 'utf8').split('\n').find(line => line.includes('"kind":"arbiter-start"')));
  arb.appendEscalation(f.dir, { ...start, id: 'interrupted-retry', retryOf: f.failed.id });
  assert.match(f.run(f.args, f.env).stderr, /ITEM_BLOCKED/);
  assert.equal(f.arbiterCalls().length, 1);
});

test('arbiter: a failed confirming round sends the item BLOCKED to the orchestrator inbox as an owner decision, never approved', t => {
  const f = arbFixture(t);
  f.toArbiter(2);
  status(f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling }), 0);
  f.fix();
  const r = f.run([], { ...f.env, STUB_PRIMARY: arbFindings('still broken', 'other') });
  status(r, 2);
  assert.match(r.stderr, /CONFIRM_FAILED.*owner decision/);
  const b = f.blocked();
  assert.deepEqual([b.status, b.marker, b.inbox, b.ruling.arbiter.model], ['BLOCKED', 'owner decision', 'orchestrator', 'claude-fable-5-2']);
  assert.ok(b.openFindings.some(x => /still broken/.test(x.finding)) && b.rulings.some(x => x.id === '2.R1'));
  assert.ok(f.check().problems.some(p => /ITEM_BLOCKED/.test(p) || /ARBITER_BLOCK/.test(p)));
  f.fix();
  assert.match(f.run([], f.env).stderr, /ITEM_BLOCKED/);
});

test('arbiter: a waiving or BLOCKing ruling fails closed; with A=1 nothing is left, so the item is BLOCKED', t => {
  for (const [stub, want, extra] of [
    [arbRuling.replace('VALID-must-fix', 'VALID-waived'), /ARBITER_BLOCK.*cannot waive/, {}],
    [arbRuling.replace('DECISION: APPROVE', 'DECISION: BLOCK'), /ARBITER_BLOCK.*owner decision/, {}],
  ]) {
    const f = arbFixture(t, extra);
    f.toArbiter(2);
    const r = f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: stub });
    status(r, 2);
    assert.match(r.stderr, want);
    assert.equal(f.blocked().marker, 'owner decision');
    assert.ok(f.check().problems.some(p => /ITEM_BLOCKED/.test(p)));
  }
});

for (const [label, reply] of [
  ['no ruling lines', 'ARBITER_DECISION: BLOCK\n'],
  ['a malformed ruling line', 'ARBITER_DECISION: BLOCK\n- ID: 2.R1 | RULING: VALID-must-fix | REASON:\n'],
  ['contradictory decision lines', arbRuling + 'ARBITER_DECISION: BLOCK\n'],
  ['a Markdown-bold decision', arbRuling.replace('ARBITER_DECISION: APPROVE', '**ARBITER_DECISION: APPROVE**')],
  ['an alternate decision label', arbRuling.replace('ARBITER_DECISION: APPROVE', 'Decision: APPROVE')],
  ['ruling lines without a decision', arbRuling.slice(arbRuling.indexOf('\n') + 1)],
  ['only prose', 'missing ruling'],
  ['a clean and a decorated decision', arbRuling + '**ARBITER_DECISION: BLOCK**\n'],
  ['APPROVE and a malformed ruling line', arbRuling.replace('REASON: style only, candidate.js:1', 'REASON:')],
  ['a malformed decision line', arbRuling.replace('DECISION: APPROVE', 'DECISION: MAYBE')],
  ['a valid and a malformed decision line', arbRuling + 'ARBITER_DECISION: MAYBE\n'],
]) {
  test(`arbiter: counts and blocks a ruling with ${label}`, t => {
    const f = arbFixture(t, { callsPerItem: 2 });
    f.toArbiter(2);
    const r = f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: reply });
    status(r, 2);
    const receipt = f.rows().find(row => row.kind === 'arbiter');
    assert.deepEqual([receipt.status, receipt.decision], ['completed', 'BLOCK'], r.stderr);
    assert.equal(arb.itemUsage(f.dir).arbiter, 1);
    assert.match(f.blocked().reason, /ARBITER_BLOCK/);
  });
}

const savedModelRows = [
  ['claude', 'opus', 'claude-opus-5', 'claude-sonnet-5'], // claude/adapter.ts and claude/models.ts
  ['claude', 'sonnet', 'claude-sonnet-5', 'claude-opus-5'], // claude/adapter.ts and claude/models.ts
  ['claude', 'haiku', 'claude-haiku-4-5', 'claude-opus-5'], // claude/adapter.ts and claude/models.ts
  ['claude', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', 'claude-sonnet-5'], // claude/models.ts
  ['gemini', 'auto', 'auto', 'gemini-3-pro-preview'], // gemini/models.ts
  ['gemini', 'flash-lite', 'flash-lite', 'gemini-2.5-flash'], // gemini/models.ts
  ['gemini', 'pro', 'gemini-3-pro-preview', 'gemini-2.5-flash'], // gemini/models.ts
  ['gemini', 'flash', 'gemini-2.5-flash', 'gemini-3-pro-preview'], // gemini/models.ts
  ['gemini', 'gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-3-pro-preview'], // gemini/models.ts
  ['codex', 'gpt-6.2-astra', 'gpt-6.2-astra[preview]', 'gpt-6.2-sol'], // codex/models.ts
  ['codex', 'gpt-sol', 'gpt-sol', 'gpt-luna'], // codex/models.ts and test/codex-models.test.ts
  ['antigravity', 'gemini-4-neon', 'gemini-4-neon-high', 'gemini-4-neon-preview'], // antigravity/models.ts
  ['antigravity', 'gpt-oss-120b-medium', 'gpt-oss-120b-medium', 'gpt-oss-120b-high'], // antigravity/models.ts
  ['opencode', 'anthropic/claude-opus-5-5', 'claude-opus-5-5', 'anthropic/claude-sonnet-5'], // opencode/models.ts
  ['opencode', 'openai/gpt-5.5', 'openai/gpt-5.5', 'openai/gpt-5'], // opencode/models.ts
];

test('saved model: matches picker rows against reported model IDs', () => {
  for (const [provider, saved, reported, other] of savedModelRows) {
    assert.equal(review.savedModelMatches(provider, saved, reported), true, `${provider}/${saved} against ${reported}`);
    if (/^[a-z]+$/.test(saved)) {
      assert.throws(() => review.savedModelMatches(provider, saved, other), {
        message: `MODEL_ALIAS_UNKNOWN: unknown alias ${saved} for ${provider}`,
      });
    } else {
      assert.equal(review.savedModelMatches(provider, saved, other), false, `${provider}/${saved} against ${other}`);
    }
  }
});

test('saved model: rejects default, empty and unknown aliases for every provider', () => {
  for (const [provider, , reported] of savedModelRows) {
    // util/model.ts defines default and empty as the provider's own selection.
    for (const saved of ['default', '', null, 'unlistedalias']) {
      assert.throws(() => review.savedModelMatches(provider, saved, reported), {
        message: `MODEL_ALIAS_UNKNOWN: unknown alias ${saved || 'default'} for ${provider}`,
      });
    }
  }
});

const rulingId = 'claude-iris-7-1';
const helperId = 'claude-cedar-3-2';

test('arbiter: accepts a bare alias for the ruling model and records the auxiliary model', t => {
  const f = arbFixture(t, { model: 'iris', effort: 'medium' });
  f.toArbiter(2);
  status(f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling,
    STUB_CLAUDE_USAGE: JSON.stringify({ [helperId]: { outputTokens: 5 }, [rulingId]: { outputTokens: 20 } }) }), 0);
  const { arbiter, evidence } = f.rows().find(r => r.kind === 'arbiter');
  assert.equal(arbiter.model, 'iris');
  assert.equal(arbiter.resolvedModel, rulingId);
  assert.equal(evidence.rulingModel, rulingId);
  assert.deepEqual(evidence.auxiliaryModels, [helperId]);
});

for (const [label, model, modelUsage, reason] of [
  ['a different ruling model', rulingId, { [rulingId]: { outputTokens: 5 }, [helperId]: { outputTokens: 20 } }, /ruling model.*cedar/],
  ['tied output token counts', rulingId, { [rulingId]: { outputTokens: 20 }, [helperId]: { outputTokens: 20 } }, /cannot identify/],
  ['no usable output token counts', rulingId, { [rulingId]: {}, [helperId]: { outputTokens: '20' } }, /cannot identify/],
  ['a missing auxiliary token count', rulingId, { [rulingId]: { outputTokens: 20 }, [helperId]: {} }, /cannot identify/],
  ['a non-integer auxiliary token count', rulingId, { [rulingId]: { outputTokens: 20 }, [helperId]: { outputTokens: 1.5 } }, /cannot identify/],
  ['two reported versions of the alias family', 'iris', { [rulingId]: { outputTokens: 20 }, 'claude-iris-7-2': { outputTokens: 5 } }, /MODEL_ALIAS_AMBIGUOUS: iris matched claude-iris-7-1 and claude-iris-7-2/],
  ['an alias that only matches the helper', 'iris', { [rulingId]: { outputTokens: 5 }, [helperId]: { outputTokens: 20 } }, /MODEL_ALIAS_UNKNOWN: unknown alias iris for claude/],
]) {
  test(`arbiter: rejects ${label}`, t => {
    const f = arbFixture(t, { model });
    f.toArbiter(2);
    const r = f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling,
      STUB_CLAUDE_USAGE: JSON.stringify(modelUsage) });
    status(r, 2);
    assert.match(r.stderr, reason);
    assert.equal(f.rows().find(row => row.kind === 'arbiter').status, 'tooling-fault');
  });
}

test('arbiter: tooling faults are logged without using the call cap, and a ruling still uses it', t => {
  const f = arbFixture(t);
  f.toArbiter(2, false);
  for (const [extra, reason] of [
    [{ STUB_FALLBACK: '' }, /empty result/],
    [{ STUB_CLAUDE_EXIT: '1' }, /exit 1/],
    [{ STUB_CLAUDE_RAW: 'broken JSON' }, /JSON/],
    [{ STUB_FALLBACK: ' \n' }, /empty result/],
  ]) {
    const r = f.run(['--responses', f.responses], { ...f.env, ...extra });
    status(r, 2);
    assert.match(r.stderr, /ARBITER_UNAVAILABLE.*fails closed/);
    const faults = f.rows().filter(row => row.kind === 'arbiter' && row.status === 'tooling-fault');
    assert.match(faults.at(-1)?.reason ?? '', reason);
    assert.equal(arb.itemUsage(f.dir).arbiter, 0);
    assert.equal(arb.nextCallProblem(f.team, f.dir, 'arbiter'), null);
    assert.ok(f.check().problems.some(p => /ARBITER_UNAVAILABLE/.test(p)));
  }
  status(f.run([], { ...f.env, STUB_FALLBACK: arbRuling }), 0);
  assert.equal(arb.itemUsage(f.dir).arbiter, 1);
  assert.match(arb.nextCallProblem(f.team, f.dir, 'arbiter').problem, /ARBITER_CAP: 1 of 1/);
});

test('arbiter: R=1 and R=5 come from the Team, and T ends the item BLOCKED as soon as no round is left', t => {
  const one = arbFixture(t, { reviewFixRounds: 1 });
  one.toArbiter(1);
  assert.match(one.run([], one.env).stderr, /ARBITER_NEEDS_RESPONSES/);
  const five = arbFixture(t, { reviewFixRounds: 5 });
  five.toArbiter(4);
  status(five.run([], { ...five.env, STUB_PRIMARY: arbFindings('x5a', 'x5b') }), 0);
  five.fix();
  assert.match(five.run([], five.env).stderr, /ARBITER_NEEDS_RESPONSES/);
  const ceiling = arbFixture(t, { reviewFixRounds: 5, totalRounds: 2 });
  ceiling.toArbiter(1);
  const exhausted = ceiling.run([], { ...ceiling.env, STUB_PRIMARY: arbFindings('next', 'unresolved') });
  status(exhausted, 2);
  assert.match(exhausted.stderr, /ROUNDS_CEILING/);
  assert.match(ceiling.blocked().reason, /ROUNDS_CEILING: 2 of 2 .*still unresolved/, 'blocked right after the last allowed round');
  assert.match(ceiling.run([], ceiling.env).stderr, /ITEM_BLOCKED/);
});

test('arbiter: early escalation when the same finding returns after a fix, and a secret in the responses is never kept or sent', t => {
  const f = arbFixture(t, { reviewFixRounds: 5 });
  status(f.run([], f.env), 0);
  f.fix();
  status(f.run([], f.env), 0);
  f.fix();
  assert.match(f.run([], f.env).stderr, /ARBITER_NEEDS_RESPONSES: same finding returned after a fix/);
  writeFileSync(f.responses, `- ID: 2.R1 | RESPONSE: DISPUTE | NOTE: key AKIA${'ABCDEFGHIJKLMNOP'}\n- ID: 2.R2 | RESPONSE: FIXED | NOTE: ok\n`);
  const r = f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling });
  status(r, 2);
  assert.match(r.stderr, /PACKET_SECRET/);
  assert.equal(f.arbiterCalls().length, 0);
  assert.ok(!readdirSync(join(f.dir, 'workers')).some(n => n.startsWith('responses-')) && !f.rows().some(x => x.kind === 'responses'), 'a refused response is never kept');
});

test('arbiter: the plan dispute reads the run\'s numbered plan reviews, and the regular plan reviewer confirms the VALID fixes', t => {
  const f = arbFixture(t);
  const plan = join(f.repo, 'plan.md'); const other = join(f.repo, 'other.md');
  writeFileSync(plan, '# Plan\n'); writeFileSync(other, '# Other\n');
  f.planReport(1, 'AMEND');
  writeFileSync(f.responses, '- ID: p1.P01 | RESPONSE: FIXED | NOTE: added\n');
  assert.match(f.arbitrate(plan, ['--responses', f.responses]).stderr, /ARBITER_NOT_DUE/);
  assert.match(f.arbitrate(plan, ['--responses', f.responses, '--reports', 'x']).stderr, /--reports is not accepted/);
  f.planReport(2, 'AMEND');
  assert.ok(f.check().arbiterProblems.some(p => /ARBITER_RULING_MISSING: plan review is due/.test(p)), 'the merge check finds the due plan ruling by itself');
  assert.match(f.arbitrate(plan, ['--responses', f.responses]).stderr, /RESPONSES_INVALID: .*unknown p1\.P01; missing p2\.P02/);
  writeFileSync(f.responses, '- ID: p2.P02 | RESPONSE: ACCEPTED | NOTE: will fix\n');
  status(f.arbitrate(plan, ['--responses', f.responses], { STUB_FALLBACK: 'ARBITER_DECISION: APPROVE\nRULINGS:\n- ID: p2.P02 | RULING: VALID-must-fix | REASON: gap at plan.md:2\n' }), 0);
  assert.ok(f.check().arbiterProblems.some(p => /ARBITER_CONFIRM_MISSING: plan: p2\.P02/.test(p)));
  assert.match(f.arbitrate(plan).stderr, /ARBITER_CONFIRM_NEEDS_FIX/);
  assert.match(f.arbitrate(other).stderr, /the confirm must check the plan the Arbiter ruled on/);
  writeFileSync(plan, '# Plan\nGap 2 fixed.\n');
  assert.match(f.arbitrate(plan).stderr, /ARBITER_CONFIRM_MISSING: run the plan reviewer/);
  const reviewed = reservePlanReview(f.team, f.dir, 3, plan);
  const report = f.planReport(3, 'APPROVE');
  arb.appendEscalation(f.dir, { kind: 'plan-review-finish', startId: reviewed.row.id, sha256: digest(readFileSync(report)) });
  writeFileSync(plan, '# Changed during review\n');
  assert.match(f.arbitrate(plan).stderr, /ARBITER_CONFIRM_UNVERIFIED/);
  writeFileSync(plan, reviewed.text);
  assert.match(f.arbitrate(plan).stdout, /plan confirm by the plan reviewer APPROVE/);
  assert.equal(f.arbiterCalls().length, 1, 'one Arbiter call');
  assert.deepEqual(f.check().arbiterProblems, []);
  writeFileSync(plan, '# Plan\nChanged after approval.\n');
  assert.ok(f.check().arbiterProblems.some(p => /ARBITER_PLAN_CHANGED/.test(p)), 'the approved plan is pinned');
});

test('arbiter: the merge check needs exactly the head the dispute ended at, and responses are validated and kept once per open set', t => {
  const f = arbFixture(t);
  f.toArbiter(2, false);
  status(f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling.replace('VALID-must-fix', 'INVALID') }), 0);
  assert.deepEqual(f.check().problems, []);
  f.fix();
  assert.ok(f.check().problems.some(p => /ARBITER_HEAD/.test(p)), 'a commit after the final ruling was never reviewed');
  const g = arbFixture(t, { reviewFixRounds: 5 });
  status(g.run([], { ...g.env, STUB_PRIMARY: arbFindings('a1', 'b1') }), 0);
  const resp = join(g.repo, 'r1.md');
  writeFileSync(resp, '- ID: 1.R1 | RESPONSE: DISPUTE | NOTE: no\n- ID: 1.R2 | RESPONSE: FIXED | NOTE: done\n');
  g.fix();
  status(g.run(['--responses', resp], { ...g.env, STUB_PRIMARY: arbFindings('a2', 'b2') }), 0);
  writeFileSync(resp, '- ID: 2.R1 | RESPONSE: DISPUTE | NOTE: no\n- ID: 9.R9 | RESPONSE: FIXED | NOTE: x\n');
  assert.match(g.run(['--responses', resp], g.env).stderr, /RESPONSES_INVALID: .*unknown 9\.R9; missing 2\.R2/);
  assert.equal(g.rows().filter(r => r.kind === 'responses').length, 1, 'one responses row per open set');
});

test('arbiter: a configured daily budget refuses without blocking for either provider', t => {
  for (const pin of [{}, { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high' }]) {
    const f = arbFixture(t, { dailyBudgetUsd: 1, ...pin });
    f.toArbiter(2);
    const result = f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling });
    status(result, 2);
    assert.match(result.stderr, /ARBITER_BUDGET_UNAVAILABLE:/);
    assert.equal(f.arbiterCalls().length, 0);
    assert.equal(existsSync(join(f.dir, 'ITEM_BLOCKED.json')), false);
  }
});

test('arbiter: T covers second passes and records', t => {
  const h = arbFixture(t, { totalRounds: 1 });
  const hr = h.run(['--high-risk'], h.env);
  status(hr, 2);
  assert.match(hr.stderr, /ROUNDS_CEILING: 1 of 1/);
  assert.equal(h.calls().length, 1, 'the second pass did not start past T');
  h.report(clean);
  assert.match(h.record('fallback').stderr, /ITEM_BLOCKED|ROUNDS_CEILING/);
});

test('arbiter: adopt counts an in-flight run\'s fix rounds from its receipts and sends a run past R straight to the Arbiter', t => {
  const f = arbFixture(t, { reviewFixRounds: 5 });
  f.toArbiter(3);
  rmSync(join(f.dir, 'ESCALATION.jsonl'));
  const file = join(f.repo, '.config', 'trioharness', 'team-policy.json');
  const doc = JSON.parse(readFileSync(file, 'utf8')); doc.roles.arbiter.reviewFixRounds = 2; writeFileSync(file, JSON.stringify(doc, null, 2));
  const adopt = spawnSync(process.execPath, ['--import', join(f.repo, 'home.mjs'), fileURLToPath(new URL('./team-review.mjs', import.meta.url)), 'adopt', '--repo', f.repo, '--run', 'r1'],
    { encoding: 'utf8', env: { ...process.env, TRIOHARNESS_TEAM_HOME: f.repo, TEAM_FILE: '' } });
  status(adopt, 0);
  assert.match(adopt.stdout, /^ADOPTED r1: ruling \(ARBITER_DUE: 2 fix rounds without approval/);
  assert.equal(f.rows()[0].kind, 'adopted');
  assert.match(f.run([], f.env).stderr, /ARBITER_NEEDS_RESPONSES/, 'the next round of the adopted run is the Arbiter');
});

test('arbiter: code writer must agree with the underlying receipts at dispatch and merge', t => {
  const f = arbFixture(t);
  f.toArbiter(2, false);
  const args = ['--responses', f.responses];
  const env = { ...f.env, STUB_FALLBACK: arbRuling.replace('VALID-must-fix', 'INVALID') };
  const before = f.calls().length;
  const mismatch = f.run([...args, '--writer', 'claude'], env);
  status(mismatch, 2);
  assert.match(mismatch.stderr, /ARBITER_WRITER/);
  assert.equal(f.calls().length, before);
  status(f.run(args, env), 0);
  const file = join(f.dir, 'ESCALATION.jsonl');
  writeFileSync(file, f.rows().map(e => JSON.stringify(e.kind === 'arbiter' ? { ...e, participants: { ...e.participants, writer: 'claude' } } : e)).join('\n') + '\n');
  assert.ok(f.check().arbiterProblems.some(p => /code writer differs/.test(p)));
});

test('arbiter: the first unsuccessful plan confirmation is terminal', t => {
  const f = arbFixture(t);
  const subject = join(f.repo, 'plan.md');
  writeFileSync(subject, 'First version\n');
  f.planReport(1, 'AMEND');
  f.planReport(2, 'AMEND');
  arb.appendEscalation(f.dir, { kind: 'arbiter', scope: 'plan', status: 'completed', mode: 'ruling', id: 'plan-ruling', planReport: 2,
    decision: 'APPROVE', subject: { path: subject, sha256: digest(readFileSync(subject)) }, rulings: [{ id: 'p2.P02', ruling: 'VALID-must-fix' }] });
  writeFileSync(subject, 'Fixed version\n');
  reservePlanReview(f.team, f.dir, 3, subject);
  f.planReport(3, 'AMEND');
  f.planReport(4, 'APPROVE');
  const confirm = f.arbitrate(subject);
  status(confirm, 2);
  assert.match(confirm.stderr, /CONFIRM_FAILED/);
  assert.match(f.blocked().reason, /plan-reviewer-3.md is AMEND/);
});

test('arbiter: plan confirmation reserves T at dispatch and refuses over-cap reports', t => {
  const f = arbFixture(t, { totalRounds: 3 });
  const subject = join(f.repo, 'plan.md');
  writeFileSync(subject, 'Fixed plan\n');
  f.planReport(1, 'AMEND');
  arb.appendEscalation(f.dir, { kind: 'arbiter', scope: 'plan', status: 'completed', mode: 'ruling', id: 'plan-ruling', planReport: 1,
    decision: 'APPROVE', subject: { path: subject, sha256: digest('Old plan\n') }, rulings: [{ id: 'p1.P01', ruling: 'VALID-must-fix' }] });
  const reviewed = reservePlanReview(f.team, f.dir, 2, subject);
  assert.equal(arb.itemUsage(f.dir).total, 3);
  const report = f.planReport(2, 'APPROVE');
  arb.appendEscalation(f.dir, { kind: 'plan-review-finish', startId: reviewed.row.id, sha256: digest(readFileSync(report)) });
  assert.equal(arb.itemUsage(f.dir).total, 3, 'a finished review consumes its original slot');
  assert.match(f.arbitrate(subject).stdout, /plan confirm .* APPROVE/);
  f.planReport(3, 'APPROVE');
  assert.ok(f.check().arbiterProblems.some(p => /ARBITER_CONFIRM_UNVERIFIED/.test(p)));
  writeFileSync(join(f.dir, 'ESCALATION.jsonl'), f.rows().filter(e => e.kind !== 'review-confirm').map(e => JSON.stringify(e)).join('\n') + '\n');
  const over = f.arbitrate(subject);
  status(over, 2);
  assert.match(over.stderr, /ROUNDS_CEILING: 4 of 3/);
});

test('arbiter: external recording uses the item lock and refuses damaged active evidence', t => {
  const f = arbFixture(t);
  status(f.run([], f.env), 0);
  const lock = join(f.dir, '.arbiter-item.lock');
  mkdirSync(lock);
  assert.match(f.record('fallback').stderr, /ITEM_BUSY/);
  rmSync(lock, { recursive: true });
  writeFileSync(f.rounds()[0].output, 'changed');
  assert.match(f.record('fallback').stderr, /REPORT_UNVERIFIED/);
});

test('arbiter: an interrupted dispatch consumes an Arbiter call and a model round', t => {
  const f = arbFixture(t);
  f.toArbiter(2);
  arb.appendEscalation(f.dir, { kind: 'arbiter-start', scope: 'code', id: 'interrupted', status: 'dispatched', completedAt: new Date().toISOString() });
  assert.deepEqual([arb.itemUsage(f.dir).arbiter, arb.itemUsage(f.dir).total], [1, 3]);
  assert.ok(f.check().arbiterProblems.some(p => /ARBITER_INTERRUPTED/.test(p)));
  assert.match(f.run(['--responses', f.responses], f.env).stderr, /ARBITER_CAP/);
});

test('arbiter: a ruling cannot outlive its source report', t => {
  const f = arbFixture(t);
  f.toArbiter(2, false);
  status(f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling.replace('VALID-must-fix', 'INVALID') }), 0);
  rmSync(f.rounds()[1].output);
  assert.ok(f.check().arbiterProblems.some(p => /ruling source .* changed or is missing/.test(p)));
});

test('arbiter: a fresh second pass contributes its findings on the already-reviewed head', t => {
  const f = arbFixture(t, { reviewFixRounds: 1 });
  f.toArbiter(1, false);
  const args = ['--high-risk', '--responses', f.responses];
  writeFileSync(f.responses, '- ID: 1.R1 | RESPONSE: DISPUTE | no\n- ID: 1.R2 | RESPONSE: DISPUTE | no\n');
  const result = f.run(args, { ...f.env, STUB_PRIMARY: arbFindings('fresh second pass issue', 'other issue'), STUB_FALLBACK: arbRuling });
  status(result, 2);
  assert.match(result.stderr, /RESPONSES_INVALID: .*missing 3\.R1, 3\.R2/);
  assert.equal(f.arbiterCalls().length, 0);
});

test('arbiter: an all-invalid ruling cannot clear a head that received no ordinary review', t => {
  const f = arbFixture(t);
  f.toArbiter(2);
  const result = f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling.replace('VALID-must-fix', 'INVALID') });
  status(result, 2);
  assert.match(result.stderr, /ARBITER_HEAD/);
  assert.ok(f.check().arbiterProblems.some(p => /approved code head has no ordinary review/.test(p)));
});

test('arbiter: the frozen Arbiter evidence retains explicitly reviewed context and its digest', t => {
  const f = arbFixture(t, { reviewFixRounds: 1 });
  f.commit({ 'contract.js': 'export const unchangedContract = 17;\n' });
  const base = f.git('rev-parse', 'HEAD');
  f.fix();
  status(f.run(['--base', base, '--context', 'contract.js'], f.env), 0);
  writeFileSync(f.responses, '- ID: 1.R1 | RESPONSE: DISPUTE | no\n- ID: 1.R2 | RESPONSE: DISPUTE | no\n');
  status(f.run(['--base', base, '--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling.replaceAll('2.R', '1.R').replace('VALID-must-fix', 'INVALID') }), 0);
  const packet = f.arbiterCalls().at(-1)[1];
  assert.match(packet, /unchangedContract = 17/);
  assert.ok(packet.includes(f.rounds()[0].packetSha256));
});

test('arbiter: an unpriced ruling with budget off leaves no shared budget files', t => {
  const f = arbFixture(t, { dailyBudgetUsd: null });
  f.toArbiter(2);
  const result = f.run(['--responses', f.responses], { ...f.env, STUB_FALLBACK: arbRuling });
  status(result, 0);
  for (const name of ['arbiter-budget.lock', 'arbiter-usage.jsonl']) {
    assert.equal(existsSync(join(f.repo, '.config', 'trioharness', name)), false, name);
  }
  assert.match(f.run([], f.env).stderr, /ARBITER_FINAL|ARBITER_CONFIRM_NEEDS_FIX/);
});
for (const literal of ['GPT-6.2-example', 'opus']) {
  test(`team-review refuses packet literal ${literal} before launch`, t => {
    const f = fixture(t);
    f.writePacket(`Review this.\nUse ${literal}.`);
    const result = f.run([], { STUB_EXIT: '0' });
    status(result, 2);
    assert.ok(result.stderr.includes(`PACKET_MODEL_LITERAL: ${join(f.repo, 'packet.md')}:2: ${literal}`), result.stderr);
    assert.equal(existsSync(join(f.repo, 'calls.jsonl')), false);
  });

  test(`team-role writer refuses packet literal ${literal} before launch`, t => {
    const { dir, work, launch } = roleFixture(t);
    const packet = join(work, 'packet.md');
    writeFileSync(packet, `Run this.\nUse ${literal}.`);
    const result = launch({}, 'writer');
    status(result, 2);
    assert.ok(result.stderr.includes(`PACKET_MODEL_LITERAL: ${packet}:2: ${literal}`), result.stderr);
    assert.equal(existsSync(join(dir, 'env.txt')), false);
  });
}

test('R4 team-review accepts a bare model alias in frozen changed content', t => {
  const f = fixture(t);
  f.commit({ 'candidate.js': 'export const form = "haiku";\n' });
  const result = f.run([], { STUB_EXIT: '0', STUB_REQUIRE: 'export const form = "haiku";' });
  status(result, 0);
  assert.ok(existsSync(join(f.repo, 'calls.jsonl')));
});

test('R4 team-review refuses a writer brief naming a model before launch', t => {
  const f = fixture(t);
  f.writePacket('Use gpt-6.2-example.');
  const result = f.run([], { STUB_EXIT: '0' });
  status(result, 2);
  assert.match(result.stderr, /PACKET_MODEL_LITERAL: .*packet\.md:1: gpt-6\.2-example/);
  assert.equal(existsSync(join(f.repo, 'calls.jsonl')), false);
});

test('team-role logs the Settings role and mirror hash for a clean packet', t => {
  const { dir, launch } = roleFixture(t);
  const log = join(dir, 'role.json');
  writeFileSync(join(dir, 'write'), '');
  status(launch({}, 'investigator', ['--log', log]), 0);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')).resolved, {
    role: 'investigator', ...role(team, 'investigator'), source: 'settings',
    mirrorSha256: digest(readFileSync(join(dir, '.config', 'trioharness', 'team.json'))),
  });
});

test('team-role logs the resolved session role and takes precedence over the mirror', t => {
  const pin = { provider: 'codex', model: 'session-investigator', effort: 'medium' };
  const { dir, work, launch } = roleFixture(t, `model: ${pin.model}\\nprovider: openai\\nreasoning effort: ${pin.effort}\\nsandbox: read-only\\n`);
  const settings = join(dir, '.codeden', 'teams');
  mkdirSync(settings, { recursive: true, mode: 0o700 });
  const file = join(settings, 'project.json');
  writeFileSync(file, JSON.stringify({ version: 1, projectId: 'project', roots: [work], team: [{ role: 'investigator', ...pin }] }), { mode: 0o600 });
  const log = join(dir, 'role.json');
  writeFileSync(join(dir, 'write'), '');
  status(launch({ TEAM_FILE: file }, 'investigator', ['--log', log]), 0);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')).resolved, {
    role: 'investigator', ...pin, source: 'settings', teamFileSha256: digest(readFileSync(file)),
  });
});

test('team-review receipts log the resolved Settings role and source hash', t => {
  const mirror = fixture(t);
  status(mirror.run([], { STUB_EXIT: '0' }), 0);
  assert.deepEqual(mirror.rounds()[0].resolved, {
    role: 'reviewer', ...neonPrimary, source: 'settings',
    mirrorSha256: digest(readFileSync(join(mirror.repo, '.config', 'trioharness', 'team.json'))),
  });
  const app = fixture(t, 'codex');
  const file = sessionTeamFile(app);
  status(app.run([], { TEAM_FILE: file }), 0);
  assert.deepEqual(app.rounds()[0].resolved, {
    ...opus, source: 'settings', teamFileSha256: digest(readFileSync(file)),
  });
});
