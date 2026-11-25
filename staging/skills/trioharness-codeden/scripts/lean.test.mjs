import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGate, redact, GATES } from './jev.mjs';
import { guard, SKIP_PATTERNS, SKIP_DETECTOR_SHA256, lineSha256 } from './guard.mjs';
import { issueLedgerReason } from './clean-state.mjs';

const fake = answers => async (_url, init) => {
  fake.last = JSON.parse(init.body);
  return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers, usage: {} }) };
};
const noul = v => ({ type: 'noul', noul: v });
const choice = (c, conf) => ({ type: 'choice', choice: c, confidence: conf, probabilities: {} });
const plan = { objective: 'Fix null ref in OrderSync', criteria: ['No exception when CardCode is null'],
  changes: [{ file: 'src/OrderSync.cs', change: 'Guard null CardCode in Map' }, { file: 'tests/OrderSyncTests.cs', change: 'RED test for null CardCode' }],
  proof: ['dotnet test --filter OrderSync'], evidence: ['OrderSync.cs:42 ...'] };
const planOk = { scope_0: noul(0.95), grounded_0: noul(0.9), scope_1: noul(0.9), grounded_1: noul(0.85), proof: noul(0.9), weakens: noul(0.02) };

test('plan passes when all atomic checks pass', async () => {
  const r = await runGate('plan', plan, { key: 'k', fetchImpl: fake(planOk) });
  assert.equal(r.pass, true); assert.equal(r.verdict, 'proceed');
});
test('route moves one tier up on low confidence and blocks on clarify', async () => {
  let r = await runGate('route', { task: 'x' }, { key: 'k', fetchImpl: fake({ depth: choice('lean', 0.5) }) });
  assert.equal(r.verdict, 'standard');
  r = await runGate('route', { task: 'x' }, { key: 'k', fetchImpl: fake({ depth: choice('trivial', 0.5) }) });
  assert.equal(r.verdict, 'lean');
  r = await runGate('route', { task: 'x' }, { key: 'k', fetchImpl: fake({ depth: choice('trivial', 0.9) }) });
  assert.equal(r.verdict, 'trivial');
  r = await runGate('route', { task: 'x' }, { key: 'k', fetchImpl: fake({ depth: choice('clarify', 0.9) }) });
  assert.equal(r.pass, false);
});
test('finding: fixing or LOW never calls Jev; dismissing HIGH needs agreement', async () => {
  const boom = async () => { throw new Error('should not call'); };
  assert.equal((await runGate('finding', { id: 'F1', severity: 'HIGH', text: 't', proposed: 'fix', evidence: ['e'] }, { key: 'k', fetchImpl: boom })).pass, true);
  assert.equal((await runGate('finding', { id: 'F2', severity: 'LOW', text: 't', proposed: 'false_positive', evidence: ['e'] }, { key: 'k', fetchImpl: boom })).pass, true);
  const r = await runGate('finding', { id: 'F3', severity: 'HIGH', text: 't', proposed: 'false_positive', evidence: ['e'] },
    { key: 'k', fetchImpl: fake({ disposition: choice('fix', 0.9), reproduced: noul(0.8) }) });
  assert.equal(r.pass, false); assert.equal(r.verdict, 'escalate-to-human');
});
test('done asks one question per criterion', async () => {
  const input = { objective: 'o', criteria: ['a', 'b'], evidence: ['tests: 12 passed'] };
  const r = await runGate('done', input, { key: 'k', fetchImpl: fake({ met_0: noul(0.9), met_1: noul(0.4), failing: noul(0.05), unsupported: noul(0.1) }) });
  assert.equal(r.pass, false); assert.ok(fake.last.questions.met_1);
});
test('missing key and malformed answers never pass', async () => {
  await assert.rejects(runGate('plan', plan, { key: '' }), /JEV_KEY_MISSING/);
  await assert.rejects(runGate('plan', plan, { key: 'k', fetchImpl: fake({ ...planOk, proof: noul(2) }) }), /JEV_INVALID_ANSWER/);
});
test('redacts secrets from state', () => {
  assert.doesNotMatch(redact('API_KEY=abc123secret sk-abcdefghijklmnopqrstu'), /abc123secret|sk-abcdef/);
});

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'guard-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  mkdirSync(join(d, 'src')); writeFileSync(join(d, 'src/a.js'), 'x\n'); writeFileSync(join(d, 'b.js'), 'y\n');
  g('add', '.'); g('commit', '-qm', 'base');
  return { d, base: g('rev-parse', 'HEAD').trim() };
}
test('guard: clean inside owned paths', () => {
  const { d, base } = repo();
  writeFileSync(join(d, 'src/a.js'), 'x\nz\n'); writeFileSync(join(d, 'src/new.js'), 'n\n');
  mkdirSync(join(d, '.trioharness-direct/runs/r1'), { recursive: true }); writeFileSync(join(d, '.trioharness-direct/runs/r1/state.json'), '{}');
  assert.equal(guard({ repo: d, base, owned: ['src/'], allowMainWorktree: true }).clean, true);
});
test('guard: flags outside path, secret, and skipped test', () => {
  const { d, base } = repo();
  writeFileSync(join(d, 'b.js'), 'y\nconst password = "hunter2hunter2";\nit.skip("x")\n');
  const r = guard({ repo: d, base, owned: ['src/'], allowMainWorktree: true });
  const rules = r.violations.map(v => v.rule);
  assert.ok(rules.includes('outside-owned-paths')); assert.ok(rules.includes('secret:assigned-secret')); assert.ok(rules.includes('test-skipped-or-disabled'));
  assert.ok(!JSON.stringify(r).includes('hunter2'));
});

const SKIP_MARK_LINE = readFileSync(fileURLToPath(new URL('./merge-verify.mjs', import.meta.url)), 'utf8').split('\n').find(l => l.startsWith('const SKIP_MARK = '));
test('guard: the verifier\'s SKIP_MARK line exists in both copies, trips the skip rule and is on the exemption list', () => {
  assert.ok(SKIP_MARK_LINE, 'SKIP_MARK definition not found in merge-verify.mjs');
  assert.match(SKIP_MARK_LINE, SKIP_PATTERNS);
  assert.ok(SKIP_DETECTOR_SHA256.includes(lineSha256(SKIP_MARK_LINE)), 'update SKIP_DETECTOR_SHA256 in guard.mjs to the verifier\'s new SKIP_MARK line');
  const other = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../.github/merge-verify/merge-verify.mjs'), 'utf8').split('\n').find(l => l.startsWith('const SKIP_MARK = '));
  assert.equal(other.replace(/\r$/, ''), SKIP_MARK_LINE.replace(/\r$/, ''));
});
const REAL_SKIP = ['it', 'skip("x")'].join('.');
test('guard: the verifier\'s own SKIP_MARK detector line is not a skipped test', () => {
  for (const rel of ['.github/merge-verify/merge-verify.mjs', 'skills/trioharness-lean/scripts/merge-verify.mjs']) {
    const { d, base } = repo();
    mkdirSync(join(d, dirname(rel)), { recursive: true }); writeFileSync(join(d, rel), `${SKIP_MARK_LINE}\n`);
    const r = guard({ repo: d, base, owned: ['.github/', 'skills/'], allowMainWorktree: true });
    assert.deepEqual(r.violations.map(v => v.rule), [], rel);
  }
});
test('guard: real skipped tests are still caught, also in the verifier file and on a lookalike line elsewhere', () => {
  const { d, base } = repo();
  mkdirSync(join(d, '.github/merge-verify'), { recursive: true });
  writeFileSync(join(d, '.github/merge-verify/merge-verify.mjs'), `${SKIP_MARK_LINE}\n${REAL_SKIP}\nconst SKIP_MARK = /a/; ${REAL_SKIP}; const z = /b/;\nconst carrier = ${'`'}\nconst SKIP_MARK = /${'$'}{${REAL_SKIP}}/;\n${'`'};\nconst SKIP_MARK = /${REAL_SKIP}/;\neval(SKIP_MARK.source);\n`);
  writeFileSync(join(d, 'src/other.js'), `${SKIP_MARK_LINE}\n`);
  const r = guard({ repo: d, base, owned: ['.github/', 'src/'], allowMainWorktree: true });
  const hits = r.violations.filter(v => v.rule === 'test-skipped-or-disabled').map(v => `${v.path}:${v.line}`).sort();
  assert.deepEqual(hits, ['.github/merge-verify/merge-verify.mjs:2', '.github/merge-verify/merge-verify.mjs:3', '.github/merge-verify/merge-verify.mjs:5', '.github/merge-verify/merge-verify.mjs:7', 'src/other.js:1']);
});

test('guard: base must be on the remote ref', () => {
  const { d, base } = repo();
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  const bare = mkdtempSync(join(tmpdir(), 'thl-lean-origin-'));
  g('init', '-q', '--bare', bare);
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  g('remote', 'add', 'origin', bare); g('push', '-q', 'origin', 'HEAD:main'); g('fetch', '-q', 'origin');
  assert.equal(guard({ repo: d, base, owned: ['src/'], remote: 'origin/main', allowMainWorktree: true }).clean, true);
  g('checkout', '-q', '-b', 'local-only'); writeFileSync(join(d, 'src/a.js'), 'local\n'); g('commit', '-qam', 'local');
  const localSha = g('rev-parse', 'HEAD').trim();
  const r = guard({ repo: d, base: localSha, owned: ['src/'], remote: 'origin/main', allowMainWorktree: true });
  assert.ok(r.violations.some(v => v.rule === 'base-not-on-remote'));
});

test('done rejects workflow or delivery-process criteria before calling Jev', async () => {
  const boom = async () => { throw new Error('should not call'); };
  await assert.rejects(runGate('done', { objective: 'o', criteria: ['Feature works', 'Uses the trioharness-lean workflow; Jev is the final gate'], evidence: ['e'] }, { key: 'k', fetchImpl: boom }), /CRITERION_NOT_PRODUCT: criteria\[1\]/);
});

test('check: atomic yes/no judgements with expected polarity', async () => {
  const input = { context: 'RED premise audit', questions: [{ ask: 'Does the test assert the follow-up turn has no approval request?' }, { ask: 'Does the fixture bypass compaction?', expect: 'no' }], evidence: ['Tests.cs:10-20 ...'] };
  let r = await runGate('check', input, { key: 'k', fetchImpl: fake({ q_0: noul(0.9), q_1: noul(0.1) }) });
  assert.equal(r.pass, true); assert.equal(r.verdict, 'confirmed');
  r = await runGate('check', input, { key: 'k', fetchImpl: fake({ q_0: noul(0.9), q_1: noul(0.7) }) });
  assert.equal(r.pass, false); assert.match(r.reasons[0], /q_1 expected no/);
  await assert.rejects(runGate('check', { ...input, questions: Array.from({ length: 13 }, () => ({ ask: 'x' })) }, { key: 'k' }), /CHECK_TOO_LARGE/);
});
test('fixed: verifies a correction batch per finding and flags extra behaviour', async () => {
  const input = { findings: [{ id: 'R1', severity: 'HIGH', text: 'null deref' }, { id: 'R2', severity: 'MEDIUM', text: 'missing test' }], diff: 'diff --git ...', evidence: ['dotnet test: Passed! Failed: 0, Passed: 12'] };
  let r = await runGate('fixed', input, { key: 'k', fetchImpl: fake({ resolved_0: noul(0.9), resolved_1: noul(0.85), new_behaviour: noul(0.05), failing: noul(0.02) }) });
  assert.equal(r.verdict, 'verified');
  r = await runGate('fixed', input, { key: 'k', fetchImpl: fake({ resolved_0: noul(0.9), resolved_1: noul(0.85), new_behaviour: noul(0.6), failing: noul(0.02) }) });
  assert.equal(r.verdict, 'needs-review'); assert.match(r.reasons[0], /new_behaviour/);
});

test('guard: tier limits and risky paths force escalation', () => {
  const { d, base } = repo();
  writeFileSync(join(d, 'src/a.js'), Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n'));
  let r = guard({ repo: d, base, owned: ['src/'], tier: 'trivial', allowMainWorktree: true });
  assert.ok(r.violations.some(v => v.rule === 'too-many-lines'));
  r = guard({ repo: d, base, owned: ['src/'], tier: 'lean', risky: ['src/'], allowMainWorktree: true });
  assert.ok(r.violations.some(v => v.rule === 'risky-path-needs-standard'));
  assert.equal(guard({ repo: d, base, owned: ['src/'], tier: 'standard', risky: ['src/'], allowMainWorktree: true }).clean, true);
});

test('guard: wildcard risky paths are rejected instead of silently matching nothing', () => {
  const { d, base } = repo();
  assert.throws(() => guard({ repo: d, base, owned: ['src/'], tier: 'lean', risky: ['src/**'], allowMainWorktree: true }), /RISKY_PATHS_INVALID/);
});

test('plan churn brake: attempt 3 needs new evidence or a scope cut; 5 is refused', async () => {
  const boom = async () => { throw new Error('should not call'); };
  await assert.rejects(runGate('plan', { ...plan, attempt: 3 }, { key: 'k', fetchImpl: boom }), /PLAN_CHURN/);
  await assert.rejects(runGate('plan', { ...plan, attempt: 5 }, { key: 'k', fetchImpl: boom }), /PLAN_ATTEMPTS_EXHAUSTED/);
  const ok = await runGate('plan', { ...plan, attempt: 3, after: 'investigator-pack' }, { key: 'k', fetchImpl: fake(planOk) });
  assert.equal(ok.pass, true);
  const cut = await runGate('plan', { ...plan, attempt: 4, after: 'scope-cut' }, { key: 'k', fetchImpl: fake(planOk) });
  assert.equal(cut.pass, true);
});

test('guard: refuses the main checkout, accepts a linked worktree', () => {
  const { d, base } = repo();
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  assert.ok(guard({ repo: d, base, owned: ['src/'] }).violations.some(v => v.rule === 'main-worktree'));
  assert.equal(guard({ repo: d, base, owned: ['src/'], allowMainWorktree: true }).clean, true);
  const wt = join(d, '..', `wt-${Date.now()}`);
  g('worktree', 'add', '-q', '--detach', wt, base);
  const r = guard({ repo: wt, base, owned: ['src/'] });
  assert.equal(r.mainWorktree, false);
  assert.equal(r.clean, true);
});

// S1: unconditional fixes and preservation controls.
const s1Input = { objective: 'o', criteria: ['a', 'b'], evidence: ['criteria[0] (A)\nnode --test\n# pass 2\n# fail 0'] };
const s1Answers = () => ({ met_0: noul(0.9), met_1: noul(0.9), failing: noul(0.05),
  unsupported: noul(0.1) });
const s1Source = () => readFileSync(new URL('./jev.mjs', import.meta.url), 'utf8');

test('hf5b1e-s1-d-usage: dry-run reports questionCount without fetching', async () => {
  let calls = 0;
  const r = await runGate('done', s1Input, { dryRun: true, fetchImpl: async () => { calls++; throw new Error('unexpected fetch'); } });
  assert.equal(calls, 0);
  assert.equal(r.request.questionCount, 4);
  assert.equal(Object.hasOwn(r.request, 'questions'), false);
  const shown = await runGate('done', s1Input, { dryRun: true, showState: true });
  assert.equal(r.request.questionCount, Object.keys(shown.request.questions).length);
});

test('hf5b1e-s1-d-usage: both usage strings list check and fixed', () => {
  const usage = 'Usage: node jev.mjs <route|plan|finding|check|fixed|done> <input.json> [--dry-run] [--log <file>] [--attempt-repo <repo> --attempt-run <id>]';
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./jev.mjs', import.meta.url)), '--help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0);
  assert.ok(cli.stderr.includes(usage), 'CLI usage lists every gate');
  assert.ok(s1Source().includes(`// ${usage}`), 'header usage lists every gate');
});

test('hf5b1e-s1-p-done: failing blocks; a low met_n blocks', async () => {
  for (const [id, score] of [['failing', 0.21], ['met_0', 0.79], ['met_1', 0.79]]) {
    const r = await runGate('done', s1Input, { key: 'k', fetchImpl: fake({ ...s1Answers(), [id]: noul(score) }) });
    assert.equal(r.pass, false, id);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], id === 'failing' ? /failing/ : new RegExp(`criterion ${id.at(-1)} not shown`));
  }
  const r = await runGate('done', s1Input, { key: 'k', fetchImpl: fake({ ...s1Answers(), met_0: noul(0.80), met_1: noul(0.80), failing: noul(0.20) }) });
  assert.equal(r.pass, true);
});

test('hf5b1e-s1-p-filter: exact process-word regex and throw are unchanged', () => {
  const pinned = [
    '      const processTerms = /\\b(trioharness|jev|gate|workflow|harness|code review|reviewer|fold|run-state|receipt)\\b/i;',
    '      const bad = criteria.findIndex(c => processTerms.test(String(c)));',
    '      if (bad >= 0) throw new Error(`CRITERION_NOT_PRODUCT: criteria[${bad}] describes workflow, not product behaviour; it is proven by run-state/receipts or gates 9-10, not by the done gate`);'
  ].join('\n');
  assert.ok(s1Source().includes(pinned));
});

test('hf5b1e-s1-p-filter: each of the ten terms throws before any fetch', async () => {
  let calls = 0;
  for (const term of ['trioharness', 'jev', 'gate', 'workflow', 'harness', 'code review', 'reviewer', 'fold', 'run-state', 'receipt']) {
    await assert.rejects(runGate('done', { ...s1Input, criteria: ['a', `Uses ${term.toUpperCase()}`] }, {
      key: 'k', fetchImpl: async () => { calls++; throw new Error('unexpected fetch'); }
    }), /CRITERION_NOT_PRODUCT: criteria\[1\]/);
  }
  assert.equal(calls, 0);
});

test('hf5b1e-s1-p-fixed: failing wording is byte-identical and names guard violation', () => {
  const { questions } = GATES.fixed.build({ findings: [{ id: 'R1', text: 'x' }], diff: 'd', evidence: ['e'] });
  assert.equal(questions.failing.instructions, 'Does `evidence` show any failing test, build error, or guard violation?');
  assert.match(questions.failing.instructions, /guard violation/);
});

test('hf5b1e-s1-p-fixed: failing 0.21 gives needs-review', async () => {
  const input = { findings: [{ id: 'R1', text: 'x' }], diff: 'd', evidence: ['e'] };
  const r = await runGate('fixed', input, { key: 'k', fetchImpl: fake({ resolved_0: noul(0.9), new_behaviour: noul(0.1), failing: noul(0.21) }) });
  assert.equal(r.pass, false); assert.equal(r.verdict, 'needs-review');
  assert.deepEqual(r.reasons, ['failing 0.21 > 0.2']);
});


// S3 + S5: documentation defects and unchanged refusal controls.
const s35Text = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const s35Section = (text, heading) => {
  const start = text.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
};
const s35Binding = (skill, file, prefix) => {
  const binding = skill.split('\n').find(line => line.startsWith(prefix));
  assert.ok(binding?.includes(`\`references/${file}\` binds.`), `missing core binding: ${file}`);
  assert.ok(skill.split('\n').some(line => line.startsWith('| ') && line.endsWith(` | \`references/${file}\` |`)),
    `missing trigger row: ${file}`);
  return binding;
};

test('hf5b1e-s3-d-text: skill text states the owner-hold disposition and the investigator create-only exception', () => {
  const skill = s35Text('SKILL.md');
  const closeout = s35Text('references/ops-agentsmd-closeout.md');
  const worktrees = s35Text('references/ops-worktrees-disk.md');
  const investigator = s35Text('templates/investigator-prompt.md');
  const agents = s35Text('templates/repo/AGENTS.md');
  const disposition = closeout.split('\n').find(line => line.startsWith('**Owner-preservation disposition'));
  const coreCloseout = s35Binding(skill, 'ops-agentsmd-closeout.md', '10.1–11. **AGENTS/closeout:**');
  assert.match(coreCloseout, /Owner hold forbids apply actions, finish or skipping\/passing gate 11; no dispatch with open cards/);
  const endState = s35Section(agents, 'Running environments and a clean end state');
  for (const phrase of ['owner-hold: <what, who decided, date>', 'never marked finished',
    'never mark finished, never skip gate 11', 'not finished: owner hold',
    '--gate closeout --status blocked', 'audit-only', 'closeout.mjs" audit --repo <main checkout>',
    'reclaim.mjs', 'owner decision card', 'everywhere in this skill',
    'complete it before asking this card']) {
    assert.ok(disposition.includes(phrase), `missing disposition phrase: ${phrase}`);
  }
  for (const phrase of ['owner-hold', 'blocked closeout', 'audit-only',
    'not finished: owner hold', 'never mark finished, never skip gate 11', 'Harness defects']) {
    assert.ok(endState.includes(phrase), `missing repository phrase: ${phrase}`);
  }
  const coreBase = s35Binding(skill, 'ops-worktrees-disk.md', '0–1. **Shape/running ref/base:**');
  assert.match(coreBase, /unresolved mess\/hold/);
  const gate1 = worktrees.split('\n').find(line => line.startsWith('1. **Base, ledger and checkpoints.**'));
  assert.match(gate1, /closeout\.mjs close --scope stale.*owner-hold.*audit-only/);
  const role = s35Section(skill, 'Team and responsibilities').split('\n').find(line => line.startsWith('| Investigator (optional)'));
  const budget = s35Section(skill, 'Model invocation budget').split('\n').find(line => line.startsWith('| Investigator |'));
  for (const row of [role, budget]) assert.match(row, /single create-only report exception/);
  const opening = investigator.split('\n')[0];
  const ending = investigator.split('\n').find(line => line.startsWith('Return in chat only:'));
  for (const paragraph of [opening, ending]) {
    assert.match(paragraph, /read-only/);
    assert.match(paragraph, /except creating exactly the single report/);
    assert.match(paragraph, /create-only/);
    assert.match(paragraph, /fail if (?:the path|it) exists/);
    assert.match(paragraph, /never overwrite/);
    assert.ok(paragraph.includes('named on the `Write your full pack to:` line'));
  }
  assert.equal((investigator.match(/^Write your full pack to:/gm) || []).length, 1);
  assert.match(investigator, /host write scope.*resolved single path/i);
  assert.doesNotMatch(investigator, /Do not plan, design, fix, or edit anything\./);
  const explorer = skill.slice(skill.indexOf('### Explorer lane (Investigator)'), skill.indexOf('\n## Tiers:'));
  assert.match(explorer, /read-only except the single assigned create-only report/);
  assert.match(explorer, /fail if existing; never overwrite; host scope = resolved report path/);
});

test('hf5b1e-s3-d-selfrepair: SKILL.md has the harness-defects.md, read-only, install card and never lowers phrases, and the template has the "Harness defects" heading', () => {
  const core = s35Text('SKILL.md');
  const binding = s35Binding(core, 'ops-agentsmd-closeout.md', '**Harness defects:**');
  assert.match(binding, /Records are create-only then append-only; never overwrite\/rewrite/);
  assert.match(binding, /No unapproved installs\/merges\/settings, weakened thresholds, advisory\/reset gates, hook edits, exemptions or automatic repair of blockers/);
  const skill = s35Section(s35Text('references/ops-agentsmd-closeout.md'), 'Harness defects');
  const agents = s35Section(s35Text('templates/repo/AGENTS.md'), 'Harness defects');
  for (const phrase of ['harness-defects.md', 'create-only', 'ledger',
    'heading exactly `## <key>`', '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$',
    'stable key chosen by the Architect', 'issues.mjs open --key',
    'append mode', 'existing records are never rewritten',
    'display ID', 'severity', 'file:line', 'evidence', 'suggested fix',
    'ONE read-only Investigator per run', 'installed version', 'FIXED', 'STILL-PRESENT',
    'invocation budget', 'harness-defect', 'agent identity',
    'https://github.com/Cumulus-Service-GmbH/trioharness-lean',
    'Plan Reviewer', 'Writer', 'guard', 'tests', 'Code Reviewer', 'Jev', 'PR',
    'owner install card', 'never lowers', 'marks a gate advisory', 'resets a gate',
    'edits a hook to get a run through', 'HIGH', 'failed gate', 'owner decision card']) {
    assert.ok(skill.includes(phrase), `missing self-repair phrase: ${phrase}`);
  }
  for (const section of [skill, agents]) {
    assert.ok(section.includes('Every defect record, including the first, appends its key and path to'));
    assert.ok(section.includes('No body line may start with `## `, inside or outside a code fence.'));
  }
  assert.doesNotMatch(skill, /Backfill|S6-C9|marks a mandatory gate advisory/);
  assert.ok(skill.includes('before asking any owner-hold card'));
  assert.match(skill, /only when defects were recorded/);
  assert.match(skill, /no recorded defects.*no.*dispatch/i);
  assert.match(agents, /^## Harness defects$/m);
  for (const phrase of ['harness-defects.md', 'read-only', 'issues.mjs open --key', 'owner install card',
    'heading exactly `## <key>`', 'before any owner-hold card']) {
    assert.ok(agents.includes(phrase), `missing repository defect phrase: ${phrase}`);
  }
});

test('hf5b1e-s3-d-heading: the documented defect heading passes issueLedgerReason with its matching issue key', () => {
  s35Binding(s35Text('SKILL.md'), 'ops-agentsmd-closeout.md', '**Harness defects:**');
  const defects = s35Section(s35Text('references/ops-agentsmd-closeout.md'), 'Harness defects');
  const documented = defects.match(/heading (?:exactly )?`([^`]+)`/);
  assert.ok(documented, 'the defect rule must specify its literal heading form');
  const key = 'future-defect';
  const heading = documented[1].replace(/<[^>]+>/g, token => token === '<display ID>' ? 'D2' : key);
  const d = mkdtempSync(join(tmpdir(), 's35-heading-'));
  const run = 's35-heading';
  const rd = join(d, '.trioharness-direct', 'runs', run);
  mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, 'harness-defects.md'), `${heading}\nDisplay ID: D2\nSeverity: HIGH\nfile:line: sample.mjs:1\nEvidence: reproduced\nSuggested fix: repair the defect\n`);
  const issue = { key, number: 1, url: 'https://github.com/o/r/issues/1', title: 'Defect',
    labels: [], observedLabels: [], status: 'triaged', history: [], prs: [], mergeSha: null, deliveries: [], rollbacks: [] };
  writeFileSync(join(rd, 'issues.json'), JSON.stringify({ version: 1, repo: 'o/r',
    issues: { [key]: issue }, pending: [], refusals: [] }));
  assert.equal(issueLedgerReason(d, run), null, `documented heading ${heading} must be accepted`);
  // The existing parser remains strict; extra display text belongs in the body.
  writeFileSync(join(rd, 'harness-defects.md'), `## ${key} D2\n`);
  assert.match(issueLedgerReason(d, run), /^ISSUE_KEY_INVALID:/);
});

test('hf5b1e-s3-p-text: SKILL.md and the template still contain the existing closeout, clean-state and finish refusal wording', () => {
  const skill = s35Text('SKILL.md');
  const closeout = s35Text('references/ops-agentsmd-closeout.md');
  const binding = s35Binding(skill, 'ops-agentsmd-closeout.md', '10.1–11. **AGENTS/closeout:**');
  assert.match(binding, /Never finish with open trees, unpushed\/unaccounted work/);
  const investigator = s35Text('templates/investigator-prompt.md');
  const agents = s35Text('templates/repo/AGENTS.md');
  for (const phrase of [
    'A run with an open registered worktree cannot reach `finished`.',
    '**Clean end state (part of this gate; the learnings gate and `finish` refuse without it).**',
    'A run that produced a task branch ends only when nothing it made exists in one place only:',
    '`UNPUSHED`, `NO_PR` (open it as the bot, task branches only), `PR_HEAD_STALE`, `TREE_OPEN`, `MERGED_NOT_ON_DEFAULT` (refetch, then report) and `PR_STATE_UNKNOWN` are the Architect\'s to fix, then rerun the check;',
    '`WIP_SNAPSHOT` and `PR_CLOSED_UNMERGED` need the user:'
  ]) assert.ok(closeout.includes(phrase), `refusal removed: ${phrase}`);
  for (const phrase of [
    'Exit 0 permits; exit 2 forbids; exit 3 (no key, API error, malformed answer) also forbids and is never a pass.',
    'Never lower thresholds, mark a gate advisory, or reset a gate; never ask the user to override one while a fix is left to try.'
  ]) assert.ok(skill.includes(phrase), `refusal removed: ${phrase}`);
  assert.ok(agents.includes('a run with an open worktree is not finished.'));
  assert.ok(agents.includes('`clean-state.mjs check --run <run-id>` after closeout.'));
  const ending = investigator.split('\n').find(line => line.startsWith('Return in chat only:'));
  for (const prohibition of ['commit', 'push', 'deploy', 'install dependencies', 'run migrations']) {
    assert.ok(ending.includes(prohibition), `investigator prohibition removed: ${prohibition}`);
  }
  assert.ok(investigator.includes('Never put a secret value in your result file'));
});


test('convergence core: role skills and mandatory receipt gate are wired', () => {
  const skill = s35Text('SKILL.md');
  assert.match(skill, /\| Always at gate 3 \| `references\/convergence-and-gates\.md` \|/);
  const team = s35Section(skill, 'Team and responsibilities');
  assert.match(team, /\| Role \| Assigned by the profile \| Constraint \| Skills \|/);
  for (const name of ['brainstorming', 'writing-plans', 'verification-before-completion',
    'receiving-code-review', 'test-driven-development', 'systematic-debugging',
    'context7-mcp', 'frontend-design', 'requesting-code-review']) assert.ok(team.includes(name), name);
  assert.match(team, /Skill\/docs receipts are mandatory per tier/);
  assert.match(team, /receipt-check\.mjs --role <role> --tier <tier> --file <result>/);
  assert.match(team, /before a worker result is accepted.*one re-dispatch, then park/);
});

test('convergence core: plan, review, browser and Jev bind caps without accepting findings', () => {
  const skill = s35Text('SKILL.md');
  const gates = s35Section(skill, 'Gates (in order)');
  const gate = n => gates.slice(gates.indexOf(`\n${n}. **`), gates.indexOf(`\n${n + 1}. **`) === -1 ? undefined : gates.indexOf(`\n${n + 1}. **`));
  for (const n of [4, 7, 10]) assert.ok(gate(n).includes('references/convergence-and-gates.md'), `gate ${n}`);
  assert.match(gate(4), /automatic plan-review dispatch cap 1/);
  for (const phrase of ['one plan review', 'BLOCKING', 'ADVISORY', 'no re-review']) assert.ok(gate(4).includes(phrase), phrase);
  assert.ok(gate(7).includes('automatic review-dispatch cap 2'));
  assert.ok(gate(7).includes('run-state.mjs loop --kind fix-batch'));
  assert.match(gate(10), /30 min.*run-state\.mjs park/);
  assert.match(s35Section(skill, 'Jev gates'), /reserveAttempt.*lifetime cap/);
  assert.match(skill, /caps end loops, never hide findings/);
  assert.match(skill, /caps list all open confirmed\/probable HIGH\/MEDIUM, failed gates and unmet criteria/);
  assert.match(skill, /Jev third unresolved awaits the exact-input owner exception, other caps park, never accept; done\/delivery stay refused/);
  assert.doesNotMatch(gate(4), /then reset once|unless a proven new/);
  assert.doesNotMatch(gate(7), /third reviewer call needs/);
});

test('convergence core: docs currency, security and UI regression pointers bind at their gates', () => {
  const skill = s35Text('SKILL.md');
  const gates = s35Section(skill, 'Gates (in order)');
  for (const n of [3, 5, 7]) {
    const start = gates.indexOf(`\n${n}. **`);
    const end = gates.indexOf(`\n${n + 1}. **`, start);
    const section = gates.slice(start, end);
    assert.match(section, /external-API/);
    assert.match(section, /Context7 receipts/);
    assert.match(section, /deprecation/);
  }
  for (const phrase of ['authn/authz', 'tenant filter', 'input validation/injection/SSRF',
    'dependency advisory command', 'PASS/FAIL/N-A', 'Unmitigated HIGH fails',
    'origin/main', '360/1280', 'light/dark', 'RTL', 'keyboard/focus', 'a11y', '<=0.5%']) assert.ok(gates.includes(phrase), phrase);
  assert.ok(Buffer.byteLength(skill) <= 40_000, 'core exceeds 40,000 bytes');
});

test('fix1 LOW and M6 binding text retains only restrictions and full UI capture matrix', () => {
  const skill = s35Text('SKILL.md');
  assert.match(skill, /user only answers genuine scope questions/);
  assert.match(skill, /default branch only for a configured remote name/);
  for (const file of ['references/convergence-and-gates.md', 'templates/browser-test-prompt.md']) {
    const text = s35Text(file); assert.match(text, /<=8/); assert.match(text, /<=4.*one theme/);
  }
  for (const file of ['templates/review-prompt.md', 'templates/repo/AGENTS.md']) { const text = s35Text(file); assert.match(text, /every change/i); assert.match(text, /N-A.*written reason/); }
  assert.ok(Buffer.byteLength(skill) <= 40000);
});

test('fix3 M-a trigger retains full task scope and core byte ceiling', () => {
  const skill = s35Text('SKILL.md');
  assert.match(skill.split('\n')[2], /TrioHarness Direct gates for Bambooed — run every repository task through a scope-locked, model-agnostic Architect\/writer\/reviewer workflow/);
  assert.ok(Buffer.byteLength(skill) <= 40000);
});
test('fix3 L1 and L4 exception order and receipt start are explicit', () => {
  assert.match(s35Text('SKILL.md'), /immediately after.*owner.*answer.*no other run-state writes/i);
  assert.match(s35Text('references/convergence-and-gates.md'), /RUN_START/);
});

test('run discipline references bind scope, owed work, structured handoffs and allowed turn endings', () => {
  const jobs = s35Text('references/ops-jobs-state.md');
  for (const phrase of ['run-state.mjs status', 'run-state.mjs scope', 'run-state.mjs defer', 'owner card', 'run-state.mjs item', 'open|blocked', 'sent|running|failed', 'registered', 'blocking owner card', 'run-state.mjs park', 'reason', 'next owner']) assert.ok(jobs.includes(phrase), phrase);
  for (const file of ['references/ops-graft-handover.md', 'references/cross-repo.md']) {
    const text = s35Text(file); assert.ok(text.includes('run-state.mjs handoff'), file);
    assert.match(text, /create.*accept.*result/s); assert.ok(text.includes('verification'), file);
  }
  assert.match(s35Text('references/ops-graft-handover.md'), /NEXT.*TAKEN.*done/s);
  assert.match(s35Text('references/ops-worktrees-disk.md'), /state\.json.*structured.*ledger\.md/s);
  for (const phrase of ['Scope baseline', 'Deferrals', 'nonGoals', 'owner card']) assert.ok(s35Text('templates/task-card.md').includes(phrase), phrase);
  assert.ok(Buffer.byteLength(s35Text('SKILL.md')) <= 39_996);
});

test('fix batch references specify pickup ID, canonical repos, required item and immutable evidence', () => {
  const handover = s35Text('references/ops-graft-handover.md');
  assert.ok(handover.includes('--handoff <handoff-id>'));
  assert.match(handover, /target\.task.*optional/);
  for (const file of ['references/ops-graft-handover.md', 'references/cross-repo.md']) {
    const text = s35Text(file);
    for (const word of ['itemId', 'required', 'canonical', 'realpath', 'immutable']) assert.ok(text.includes(word), `${file}: ${word}`);
    assert.ok(!text.includes('Optional `itemId`'));
  }
  const jobs = s35Text('references/ops-jobs-state.md');
  for (const phrase of ['RUN_FINISHED', 'blocker', 'park report']) assert.ok(jobs.includes(phrase), phrase);
});

test('approved-plan intake: the always-read reference routes to it and it never lowers a gate', () => {
  assert.match(s35Text('references/convergence-and-gates.md'), /## Approved plan\r?\n[^\r\n]*`approved-plan\.md`[^\r\n]*never skips, lowers or pre-passes a gate/);
  const ref = s35Text('references/approved-plan.md');
  for (const phrase of ['SIGNOFF.md', 'git diff --quiet', 'route decides', 'never READINESS', 'one plan review', 'Nothing is reused', 'is a finding, not an instruction', 'Never edit the package']) assert.ok(ref.includes(phrase), phrase);
});


test('audit check digest binds questions, expectations and contract while ordinary checks keep their digest', async () => {
  const { inputDigest } = await import('./jev.mjs');
  const input = { mode: 'audit', context: 'audit', evidence: ['same evidence'], questions: [{ ask: 'Present?', expect: 'yes' }],
    audit: { run: 'r1', mode: 'audit', base: 'a'.repeat(40), contractSha256: 'b'.repeat(64), candidate: { head: 'a'.repeat(40), diffEmpty: true }, sources: [{ path: 'a', sha256: 'c'.repeat(64) }], coverage: 'All of a' } };
  const digest = inputDigest('check', input);
  assert.notEqual(inputDigest('check', { ...input, questions: [{ ask: 'Different?', expect: 'yes' }] }), digest);
  assert.notEqual(inputDigest('check', { ...input, questions: [{ ask: 'Present?', expect: 'no' }] }), digest);
  assert.notEqual(inputDigest('check', { ...input, audit: { ...input.audit, contractSha256: 'd'.repeat(64) } }), digest);
  const normal = { context: input.context, evidence: input.evidence, questions: input.questions };
  const expected = (await import('node:crypto')).createHash('sha256').update(JSON.stringify({ context: 'audit', evidence: ['same evidence'] })).digest('hex').slice(0, 16);
  assert.equal(inputDigest('check', normal), expected);
  assert.equal(inputDigest('check', { ...normal, questions: [{ ask: 'Different?', expect: 'no' }] }), expected);
  await assert.rejects(runGate('check', { ...input, questions: [{ ask: 'Missing expect' }] }, { dryRun: true }), /AUDIT_/);
});
