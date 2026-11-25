import test, { after as afterTest } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findSecrets } from './secret-patterns.mjs';

const script = fileURLToPath(new URL('./agents-md-check.mjs', import.meta.url));
const skillText = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const protectedNames = ['Stack and delivery', 'Proof commands', 'High-risk paths', 'Repository shape', 'Secrets', 'Running environments and a clean end state', 'Handover at the round limit'];
const protectedText = protectedNames.map(n => `## ${n}\n- Preserve ${n}.\n`).join('\n');
const base = protectedText + '\n## Run learnings\n- Keep this fact.\n- Old fact.\n';
const secret = 'gh' + 'p_' + 'Q'.repeat(35);
const userPath = '/' + 'Users/' + 'fixture/private';

// R0 preservation anchors exercise existing contracts before any checker exists.
test('hf5b1e-s7-p-base-headings', () => {
  const text = skillText('templates/repo/AGENTS.md');
  for (const heading of protectedNames) assert.ok(text.includes(`## ${heading}\n`));
});
test('hf5b1e-s7-p-base-secret-diagnostics', () => {
  const hits = findSecrets(secret);
  assert.deepEqual(hits, [{ rule: 'github-token', line: 1 }]);
  assert.ok(!JSON.stringify(hits).includes(secret));
});

function fixture({ before = base, after = before, overflow = {}, notesRoot = 'docs', retire, claude = '@AGENTS.md\n' } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'hf5b1e-s7-'));
  // Register before writing: this test cleans up only the directory it just created.
  afterTest(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'before.md'), before);
  writeFileSync(join(repo, 'AGENTS.md'), after);
  writeFileSync(join(repo, 'CLAUDE.md'), claude);
  for (const [name, text] of Object.entries(overflow)) {
    mkdirSync(join(repo, notesRoot, 'agent-notes'), { recursive: true });
    writeFileSync(join(repo, notesRoot, 'agent-notes', name), text);
  }
  if (retire !== undefined) writeFileSync(join(repo, 'retire.json'), typeof retire === 'string' ? retire : JSON.stringify(retire));
  return { repo, retire };
}
function fixtureChildEnv() {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  return env;
}
function run(fx, extra = []) {
  const args = [script, '--repo', fx.repo, '--before', join(fx.repo, 'before.md')];
  if (fx.retire !== undefined) args.push('--retire', join(fx.repo, 'retire.json'));
  const r = spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8', timeout: 60000, env: fixtureChildEnv() });
  return { status: r.status, error: r.error, signal: r.signal, stderr: r.stderr, output: (r.stdout ?? '') + (r.stderr ?? '') };
}
const diagnostic = r => JSON.stringify({ status: r.status, signal: r.signal, error: r.error && { code: r.error.code, message: r.error.message }, stderr: r.stderr, output: r.output ?? (r.stdout ?? '') + (r.stderr ?? '') });
function refused(fx, code, extra = []) {
  const r = run(fx, extra);
  // Check the reason first: a missing checker is RED, never a successful refusal.
  assert.ok(r.output.includes(code), `expected reason ${code}; ${diagnostic(r)}`);
  assert.equal(r.status, 2, diagnostic(r));
  return r.output;
}
const link = 'See docs/agent-notes/topic.md\n';
const backlink = '[AGENTS.md](../../AGENTS.md)\n';

test('hf5b1e-s7-d-AGENTS_TOO_LARGE', () => refused(fixture(), 'AGENTS_TOO_LARGE', ['--max-bytes', '20']));
test('hf5b1e-s7-d-default-size-cap-is-bytes', () => refused(fixture({ after: base + 'é'.repeat(6200) }), 'AGENTS_TOO_LARGE'));
test('hf5b1e-s7-d-OVERFLOW_UNREFERENCED', () => refused(fixture({ overflow: { 'topic.md': backlink + 'A fact.\n' } }), 'OVERFLOW_UNREFERENCED'));
test('hf5b1e-s7-d-OVERFLOW_NO_BACKLINK', () => refused(fixture({ after: base + link, overflow: { 'topic.md': 'No backlink.\n' } }), 'OVERFLOW_NO_BACKLINK'));
test('hf5b1e-s7-d-missing-referenced-overflow', () => refused(fixture({ after: base + link }), 'OVERFLOW_UNREFERENCED'));
test('hf5b1e-s7-d-PROTECTED_SECTION_CHANGED', () => refused(fixture({ after: base.replace('- Preserve High-risk paths.', '- Changed policy.') }), 'PROTECTED_SECTION_CHANGED'));
test('hf5b1e-s7-d-protected-section-relocation', () => {
  const section = '## High-risk paths\n- Preserve High-risk paths.\n';
  refused(fixture({ after: base.replace(section, '') + link, overflow: { 'topic.md': backlink + section } }), 'PROTECTED_SECTION_CHANGED');
});
test('hf5b1e-s7-d-all-protected-sections', () => {
  for (const name of protectedNames) refused(fixture({ after: base.replace(`- Preserve ${name}.`, '- Changed.') }), 'PROTECTED_SECTION_CHANGED');
});
test('hf5b1e-s7-d-LOST_LINE', () => refused(fixture({ after: base.replace('- Old fact.\n', '') }), 'LOST_LINE'));
test('hf5b1e-s7-d-duplicate-deletion-counted', () => refused(fixture({ before: base + 'x\nx\n', after: base + 'x\n' }), 'LOST_LINE'));
test('hf5b1e-s7-d-unreferenced-move-does-not-cover-loss', () => {
  const output = refused(fixture({ after: base.replace('- Old fact.\n', ''), overflow: { 'topic.md': backlink + '- Old fact.\n' } }), 'LOST_LINE');
  assert.ok(output.includes('OVERFLOW_UNREFERENCED'));
});
test('hf5b1e-s7-d-excess-retirement', () => refused(fixture({ before: base + 'x\nx\n', after: base + 'x\n', retire: [{ line: 'x', reason: 'obsolete' }, { line: 'x', reason: 'obsolete' }] }), 'LOST_LINE'));
test('hf5b1e-s7-d-unmatched-retirement', () => refused(fixture({ retire: [{ line: 'not in before', reason: 'obsolete' }] }), 'LOST_LINE'));
test('hf5b1e-s7-d-empty-retire-reason', () => refused(fixture({ after: base.replace('- Old fact.\n', ''), retire: [{ line: '- Old fact.', reason: '  ' }] }), 'LOST_LINE'));
test('hf5b1e-s7-d-meaningful-whitespace-is-not-trimmed', () => refused(fixture({ after: base.replace('- Old fact.', ' - Old fact.') }), 'LOST_LINE'));
test('hf5b1e-s7-d-CLAUDE_IMPORT_MISSING', () => refused(fixture({ claude: '# Instructions\n' }), 'CLAUDE_IMPORT_MISSING'));
test('hf5b1e-s7-d-commented-import-is-missing', () => refused(fixture({ claude: '<!-- @AGENTS.md -->\n' }), 'CLAUDE_IMPORT_MISSING'));
for (const location of ['agents', 'overflow', 'removed', 'retire-line', 'retire-reason']) {
  test(`hf5b1e-s7-d-SECRET_SHAPED-${location}`, () => {
    const opts = location === 'agents' ? { after: base + secret } : location === 'overflow' ? { after: base + link, overflow: { 'topic.md': backlink + secret } } : location === 'removed' ? { before: base + secret + '\n', after: base } : location === 'retire-line' ? { before: base + secret + '\n', after: base, retire: [{ line: secret, reason: 'obsolete' }] } : { before: base + 'x\n', after: base, retire: [{ line: 'x', reason: secret }] };
    const output = refused(fixture(opts), 'SECRET_SHAPED');
    assert.ok(!output.includes(secret), 'unsafe text must not be echoed');
  });
}
for (const value of [userPath, 'C:' + '\\Users\\fixture\\private']) {
  test(`hf5b1e-s7-d-ABSOLUTE_PATH-${value === userPath ? 'posix' : 'windows'}-reason`, () => {
    const output = refused(fixture({ after: base.replace('- Old fact.\n', ''), retire: [{ line: '- Old fact.', reason: value }] }), 'ABSOLUTE_PATH');
    assert.ok(!output.includes(value));
  });
}
test('hf5b1e-s7-d-ABSOLUTE_PATH-agents-and-overflow', () => {
  for (const opts of [{ after: base + userPath }, { after: base + link, overflow: { 'topic.md': backlink + userPath } }]) {
    const output = refused(fixture(opts), 'ABSOLUTE_PATH'); assert.ok(!output.includes(userPath));
  }
});

test('hf5b1e-s7-p-clean-update', () => { const r = run(fixture({ after: base + '- New verified fact.\n' })); assert.equal(r.status, 0, diagnostic(r)); });
test('hf5b1e-s7-p-verbatim-move', () => {
  const marker = base.indexOf('## Run learnings');
  const r = run(fixture({ after: base.slice(0, marker) + '## Run learnings\n' + link, overflow: { 'topic.md': backlink + base.slice(marker) } }));
  assert.equal(r.status, 0, diagnostic(r));
});
test('hf5b1e-s7-p-valid-retire-list-printed-per-unit', () => {
  const r = run(fixture({ after: base.replace('- Old fact.\n', ''), retire: [{ line: '- Old fact.', reason: 'Superseded by verified guidance.' }] }));
  assert.equal(r.status, 0, diagnostic(r)); assert.ok(r.output.includes('- Old fact.'), diagnostic(r)); assert.ok(r.output.includes('Superseded by verified guidance.'), diagnostic(r));
});
test('hf5b1e-s7-p-duplicate-one-occurrence-retired', () => {
  const r = run(fixture({ before: base + 'x\nx\n', after: base + 'x\n', retire: [{ line: 'x', reason: 'duplicate' }] }));
  assert.equal(r.status, 0, diagnostic(r));
});
test('hf5b1e-s7-p-crlf-normalized-only', () => { const r = run(fixture({ before: base.replaceAll('\n', '\r\n'), after: base })); assert.equal(r.status, 0, diagnostic(r)); });
test('hf5b1e-s7-p-template-pins', () => {
  const text = skillText('templates/agents-md-worker-prompt.md');
  for (const phrase of ['AGENTS MD Writer', '12288 bytes', 'verbatim', '## Run learnings', 'MEMORY.md', 'personal', 'user facts', 'secrets', 'absolute user paths', '@AGENTS.md', 'retire', 'reason', 'docs/agent-notes/', 'read-only', 'docs/agent-knowledge/', 'proposal']) assert.ok(text.includes(phrase), `template missing ${phrase}`);
  for (const name of protectedNames) assert.ok(text.includes(name), `template missing protected ${name}`);
});
test('hf5b1e-s7-p-skill-pins', () => {
  const core = skillText('SKILL.md');
  assert.ok(core.includes('references/ops-graft-handover.md'));
  assert.ok(core.includes('references/ops-agentsmd-closeout.md'));
  const text = core + '\n' + skillText('references/ops-graft-handover.md') + '\n' + skillText('references/ops-agentsmd-closeout.md');
  const learning = text.split('\n').find(l => l.startsWith('- **Learning**'));
  assert.ok(learning.includes('knowledge.mjs gate')); assert.ok(learning.includes('proposed')); assert.ok(learning.includes('10.1'));
  const start = text.indexOf('10.1. **AGENTS.md close-out**');
  assert.ok(start > text.indexOf('10. **Browser test**'));
  const end = text.indexOf('11. **Closeout**'); assert.ok(start < end);
  const section = text.slice(start, end);
  for (const phrase of ['AGENTS MD Writer', 'agents-md-worker-prompt.md', 'agents-md-check.mjs', 'guard', 'affected proof', 'Code Reviewer', 'delta review', 'owner card', 'retire list', 'check output', 'instruction commit', 'pre-push/PR', 'missing', 'stop', 'docs/agent-knowledge/', 'proposals']) assert.ok(section.includes(phrase), `close-out missing ${phrase}`);
  assert.ok(section.indexOf('owner card') < section.indexOf('instruction commit'));
});


// Review regression tests. New defect cases are frozen before the product fixes.
test('hf5b1e-s7-d-fix1-h1-symlinked-script-directory', () => {
  for (const bad of [true, false]) {
    const fx = fixture(bad ? { claude: '# Missing import\n' } : {});
    const linked = join(fx.repo, 'linked-scripts');
    symlinkSync(dirname(script), linked, 'dir');
    const r = spawnSync(process.execPath, [join(linked, 'agents-md-check.mjs'), '--repo', fx.repo, '--before', join(fx.repo, 'before.md')], { encoding: 'utf8', timeout: 5000, env: fixtureChildEnv() });
    const output = r.stdout + r.stderr;
    assert.equal(r.status, bad ? 2 : 0);
    assert.ok(output.includes(bad ? 'CLAUDE_IMPORT_MISSING' : 'AGENTS_MD_CHECK: PASS'));
  }
});
test('hf5b1e-s7-d-fix1-m1-proof-fenced-shell-comment', () => {
  const before = base.replace('- Preserve Proof commands.', '```sh\n# run tests\nnode test.mjs\n```');
  const after = before.replace('node test.mjs', 'true');
  refused(fixture({ before, after, retire: [{ line: 'node test.mjs', reason: 'replaced command' }] }), 'PROTECTED_SECTION_CHANGED');
});
test('hf5b1e-s7-d-fix1-m1-high-risk-after-comment', () => {
  const before = base.replace('- Preserve High-risk paths.', '# Critical\n- `src/auth/**`');
  refused(fixture({ before, after: before.replace('- `src/auth/**`\n', ''), retire: [{ line: '- `src/auth/**`', reason: 'removed policy' }] }), 'PROTECTED_SECTION_CHANGED');
});
const windowsUserPath = 'C:' + '\\Users\\fixture\\private';
const doubledWindowsUserPath = windowsUserPath.replaceAll('\\', '\\\\');
test('hf5b1e-s7-d-fix1-m2-windows-extra-retire-value', () => {
  for (const value of [windowsUserPath, doubledWindowsUserPath]) {
    const output = refused(fixture({ after: base.replace('- Old fact.\n', ''), retire: [{ line: '- Old fact.', reason: 'outdated', note: { nested: [value] } }] }), 'ABSOLUTE_PATH');
    assert.ok(!output.includes(value)); assert.ok(!output.includes(JSON.stringify(value)));
  }
});
test('hf5b1e-s7-d-fix1-m2-all-retire-keys-scanned', () => {
  for (const [key, code] of [[windowsUserPath, 'ABSOLUTE_PATH'], [userPath, 'ABSOLUTE_PATH'], [secret, 'SECRET_SHAPED']]) {
    const output = refused(fixture({ after: base.replace('- Old fact.\n', ''), retire: [{ line: '- Old fact.', reason: 'outdated', metadata: { [key]: 'value' } }] }), code);
    assert.ok(!output.includes(key)); assert.ok(!output.includes(JSON.stringify(key)));
  }
});
test('hf5b1e-s7-d-fix1-m2-unknown-retire-key-refused', () => refused(fixture({ after: base.replace('- Old fact.\n', ''), retire: [{ line: '- Old fact.', reason: 'outdated', note: 'safe extra field' }] }), 'LOST_LINE'));
test('hf5b1e-s7-d-fix1-m2-doubled-windows-path', () => {
  const output = refused(fixture({ after: base + doubledWindowsUserPath }), 'ABSOLUTE_PATH');
  assert.ok(!output.includes(doubledWindowsUserPath));
});
test('hf5b1e-s7-d-fix1-m3-relative-users-in-protected-section', () => {
  for (const path of ['src/users/auth.ts', 'src/Users/auth.ts']) {
    const before = base.replace('- Preserve High-risk paths.', '- `' + path + '`');
    const r = run(fixture({ before }));
    assert.equal(r.status, 0, diagnostic(r)); assert.ok(r.output.includes('AGENTS_MD_CHECK: PASS'), diagnostic(r));
  }
});
test('hf5b1e-s7-d-fix1-l6-user-path-in-removed-line-and-reason', () => {
  for (const value of [userPath, windowsUserPath, doubledWindowsUserPath]) {
    const scenarios = [
      { before: base + value + '\n', after: base },
      { after: base.replace('- Old fact.\n', ''), retire: [{ line: '- Old fact.', reason: value }] },
      { before: base + value + '\n', after: base, retire: [{ line: value, reason: 'outdated' }] }
    ];
    for (const opts of scenarios) {
      const output = refused(fixture(opts), 'ABSOLUTE_PATH');
      assert.ok(!output.includes(value)); assert.ok(!output.includes(JSON.stringify(value)));
    }
  }
});
test('hf5b1e-s7-p-fix3-n2-fixtures-use-os-tempdir', () => {
  const fx = fixture();
  assert.equal(dirname(realpathSync(fx.repo)), realpathSync(tmpdir()));
});
test('hf5b1e-s7-d-fix3-n2-fixture-cleanup-after-test', async t => {
  let repo;
  await t.test('fixture exists during its owning test', () => {
    repo = fixture().repo;
    assert.ok(existsSync(repo));
  });
  assert.ok(!existsSync(repo), 'the owning test must remove its fixture in an after hook');
});
test('hf5b1e-s7-p-fix2-user-triggered-and-sensitive-card', () => {
  const text = skillText('SKILL.md');
  const roles = (text + '\n' + skillText('references/convergence-and-gates.md')).split('\n').filter(line => /^\| AGENTS MD Writer \|/.test(line));
  assert.equal(roles.length, 1, 'optional role has one owning-reference skill row');
  assert.ok(roles[0].includes('context7'), 'stack facts use Context7');
  const start = text.split('\n').find(l => l.startsWith('- **Run start:**'));
  assert.ok(start, 'run-start role contract present');
  assert.ok(!start.includes('AGENTS MD Writer')); assert.ok(!start.includes('10.1'));
  assert.ok(!text.includes('| 10.1 AGENTS.md close-out |'));
  const tierHeading = '## Tiers: process proportional to the task';
  const tierStart = text.indexOf(tierHeading);
  assert.notEqual(tierStart, -1, 'CodeDen tier contract present');
  const tierEnd = text.indexOf('\n## ', tierStart + tierHeading.length);
  const tiers = tierEnd === -1 ? text.slice(tierStart) : text.slice(tierStart, tierEnd);
  assert.match(tiers, /^\| Gate \| trivial \| lean \| standard \|$/m);
  assert.match(tiers, /^\*\*Trivial review\*\*/m);
  assert.doesNotMatch(tiers, /10\.1|AGENTS MD Writer/);
  assert.ok(text.includes('references/ops-graft-handover.md'));
  assert.ok(text.includes('references/ops-agentsmd-closeout.md'));
  const learning = skillText('references/ops-graft-handover.md').split('\n').find(l => l.startsWith('- **Learning**'));
  assert.ok(learning.includes('only when the user asks'));
  const closeoutText = skillText('references/ops-agentsmd-closeout.md');
  const closeout = closeoutText.slice(closeoutText.indexOf('10.1. **AGENTS.md close-out**'), closeoutText.indexOf('11. **Closeout**'));
  for (const phrase of ['user-triggered only', 'only when the user asks', 'close out AGENTS.md', 'invokes the AGENTS MD Writer', 'never automatically in any tier', 'profile worker named **AGENTS MD Writer**', 'missing', 'stop', 'Code Reviewer']) assert.ok(closeout.includes(phrase), `close-out missing ${phrase}`);
  assert.ok(!closeout.includes('lean and standard only')); assert.ok(!closeout.includes('trivial skips'));
  assert.ok(!closeout.includes('Code Reviewer in lean/standard'));
  assert.ok(closeout.includes('Committing AGENTS.md after QA is a sensitive path for verified merge, so that PR goes to the approval card.'));
});
test('hf5b1e-s7-p-fix1-template-output-paths', () => {
  const text = skillText('templates/agents-md-worker-prompt.md');
  const inputs = text.slice(text.indexOf('Input paths'), text.indexOf('Collect only'));
  assert.ok(!inputs.includes('- Repository AGENTS.md'));
  assert.ok(text.includes('Instruction output: <authorized repo AGENTS.md path>'));
  assert.ok(text.includes('Knowledge proposals output: <named output file path'));
  assert.ok(text.includes('write proposals only to the named output file'));
});

for (const [name, value] of [
  ['file-url', 'file://' + userPath],
  ['double-slash', '/' + userPath],
  ['dot-slash', '.' + userPath]
]) {
  test(`hf5b1e-s7-d-fix3-n1-${name}`, () => {
    const scenarios = [
      { after: base + value },
      { after: base + link, overflow: { 'topic.md': backlink + value } },
      { before: base + value + '\n', after: base },
      { before: base + value + '\n', after: base, retire: [{ line: value, reason: 'outdated' }] },
      { after: base.replace('- Old fact.\n', ''), retire: [{ line: '- Old fact.', reason: 'see ' + value }] }
    ];
    for (const opts of scenarios) {
      const output = refused(fixture(opts), 'ABSOLUTE_PATH');
      assert.ok(!output.includes(value)); assert.ok(!output.includes(JSON.stringify(value)));
    }
  });
}
test('hf5b1e-s7-d-fix3-n1-relative-users-remain-allowed', () => {
  for (const path of ['src/users/auth.ts', 'src/Users', 'src/Users/auth.ts']) {
    const before = base.replace('- Preserve High-risk paths.', '- `' + path + '`');
    const r = run(fixture({ before }));
    assert.equal(r.status, 0, diagnostic(r)); assert.ok(r.output.includes('AGENTS_MD_CHECK: PASS'), diagnostic(r));
  }
});


// A4: opt-in legacy paths must match a Git snapshot and share an occurrence budget.
// Fixture commits live only in each test's temporary repository.
function fixtureGit(fx, args, input) {
  const r = spawnSync('git', ['-C', fx.repo, ...args], {
    input, encoding: 'utf8', timeout: 5000,
    env: { ...fixtureChildEnv(), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function existingPaths(fx, text = readFileSync(join(fx.repo, 'before.md')), notes = {}) {
  fixtureGit(fx, ['init', '--quiet']);
  fixtureGit(fx, ['read-tree', '--empty']);
  for (const [name, content] of Object.entries({ 'AGENTS.md': text, ...notes })) {
    const blob = fixtureGit(fx, ['hash-object', '-w', '--stdin'], content);
    fixtureGit(fx, ['update-index', '--add', '--cacheinfo', '100644', blob, name]);
  }
  const tree = fixtureGit(fx, ['write-tree']);
  const commit = fixtureGit(fx, ['commit-tree', tree], 'fixture base\n');
  fixtureGit(fx, ['update-ref', 'HEAD', commit]);
  return ['--allow-existing-paths', commit];
}
function passes(fx, extra) {
  const r = run(fx, extra);
  assert.equal(r.status, 0, diagnostic(r));
  assert.equal(r.output, 'AGENTS_MD_CHECK: PASS\n', diagnostic(r));
}
for (const [name, value] of [['windows', windowsUserPath], ['posix', userPath]]) {
  test(`abspath-a4-retained-${name}`, () => {
    const fx = fixture({ before: base + value + '\n' });
    passes(fx, existingPaths(fx));
  });
  test(`abspath-a4-strict-without-flag-${name}`, () => {
    refused(fixture({ before: base + value + '\n' }), 'ABSOLUTE_PATH');
  });
  test(`abspath-a4-moved-verbatim-${name}`, () => {
    const fx = fixture({ before: base + value + '\n', after: base + link, overflow: { 'topic.md': backlink + value + '\n' } });
    passes(fx, existingPaths(fx));
  });
}
test('abspath-a4-before-must-match-git', () => {
  const fx = fixture({ before: base + userPath + '\n' });
  refused(fx, 'INPUT_INVALID', existingPaths(fx, base));
});
for (const location of ['agents', 'overflow', 'multiple-overflow-files']) {
  test(`abspath-a4-extra-duplicate-${location}`, () => {
    const before = base + userPath + '\n';
    const opts = location === 'agents' ? { before, after: before + userPath + '\n' }
      : location === 'overflow' ? { before, after: before + link, overflow: { 'topic.md': backlink + userPath + '\n' } }
      : { before, after: base + link + 'See docs/agent-notes/other.md\n', overflow: { 'topic.md': backlink + userPath + '\n', 'other.md': backlink + userPath + '\n' } };
    const fx = fixture(opts);
    refused(fx, 'ABSOLUTE_PATH', existingPaths(fx));
  });
}
test('abspath-a4-budget-preserves-multiple-before-occurrences', () => {
  const fx = fixture({ before: base + userPath + '\n' + userPath + '\n', after: base + userPath + '\n' + link, overflow: { 'topic.md': backlink + userPath + '\n' } });
  passes(fx, existingPaths(fx));
});
for (const location of ['agents', 'overflow']) {
  test(`abspath-a4-new-line-${location}`, () => {
    const before = base + userPath + '\n';
    const added = userPath + '/new';
    const fx = fixture(location === 'agents' ? { before, after: before + added + '\n' }
      : { before, after: before + link, overflow: { 'topic.md': backlink + added + '\n' } });
    const output = refused(fx, 'ABSOLUTE_PATH', existingPaths(fx));
    assert.ok(!output.includes(added));
  });
}
test('abspath-a4-crlf-normalizes-before-git-and-output', () => {
  const before = base + userPath + '\n';
  const fx = fixture({ before: before.replaceAll('\n', '\r\n'), after: before + link, overflow: { 'topic.md': backlink.replaceAll('\n', '\r\n') } });
  passes(fx, existingPaths(fx, before));
});
test('abspath-a4-crlf-does-not-allow-changed-line', () => {
  const before = base + userPath + '\n';
  const fx = fixture({ before: before.replaceAll('\n', '\r\n'), after: before + ' ' + userPath + '\n' });
  refused(fx, 'ABSOLUTE_PATH', existingPaths(fx, before));
});
for (const location of ['line', 'reason', 'nested-value', 'nested-key']) {
  test(`abspath-a4-retire-json-escaped-${location}`, () => {
    const before = base + windowsUserPath + '\n';
    const item = location === 'line' ? { line: windowsUserPath, reason: 'obsolete' }
      : location === 'reason' ? { line: '- Old fact.', reason: windowsUserPath }
      : { line: '- Old fact.', reason: 'obsolete', metadata: location === 'nested-value' ? { nested: [windowsUserPath] } : { [windowsUserPath]: 'value' } };
    const fx = fixture({ before, after: location === 'line' ? base : before.replace('- Old fact.\n', ''), retire: [item] });
    const output = refused(fx, 'ABSOLUTE_PATH', existingPaths(fx));
    assert.ok(!output.includes(windowsUserPath));
    assert.ok(!output.includes(JSON.stringify(windowsUserPath)));
  });
}
for (const location of ['agents', 'overflow', 'removed']) {
  test(`abspath-a4-secret-shaped-legacy-${location}`, () => {
    const unsafe = userPath + ' ' + secret + '\n';
    const before = base + unsafe;
    const fx = fixture(location === 'agents' ? { before } : location === 'overflow'
      ? { before, after: base + link, overflow: { 'topic.md': backlink + unsafe } }
      : { before, after: base });
    const output = refused(fx, 'SECRET_SHAPED', existingPaths(fx));
    assert.ok(!output.includes(secret));
  });
}
test('abspath-a4-option-shaped-ref-cannot-create-output', () => {
  const fx = fixture();
  existingPaths(fx);
  const output = join(fx.repo, 'unexpected-output');
  refused(fx, 'INPUT_INVALID', ['--allow-existing-paths', `--output=${output}`]);
  assert.ok(!existsSync(output));
});
test('abspath-a4-missing-git-ref-fails-without-echoing-input', () => {
  const fx = fixture();
  existingPaths(fx);
  const ref = 'missing-' + userPath;
  const output = refused(fx, 'INPUT_INVALID', ['--allow-existing-paths', ref]);
  assert.ok(!output.includes(ref));
});


// M1/M2/L3: repeated close-outs use the committed tree and an ancestor commit.
for (const [name, value] of [['windows', windowsUserPath], ['posix', userPath]]) {
  test(`abspath-review-legacy-overflow-at-ref-${name}`, () => {
    const before = base + link;
    const notes = backlink + value + '\n';
    const fx = fixture({ before, overflow: { 'topic.md': notes } });
    const flag = existingPaths(fx, before, { 'docs/agent-notes/topic.md': notes });
    passes(fx, flag);
    refused(fx, 'ABSOLUTE_PATH');
  });
  for (const location of ['agents', 'overflow']) {
    test(`abspath-review-legacy-overflow-excess-${name}-${location}`, () => {
      const before = base + link;
      const notes = backlink + value + '\n';
      const fx = fixture({ before, after: location === 'agents' ? before + value + '\n' : before,
        overflow: { 'topic.md': notes + (location === 'overflow' ? value + '\n' : '') } });
      refused(fx, 'ABSOLUTE_PATH', existingPaths(fx, before, { 'docs/agent-notes/topic.md': notes }));
    });
  }
}
test('abspath-review-bare-tree-ref-refused', () => {
  const fx = fixture();
  const [, commit] = existingPaths(fx);
  const tree = fixtureGit(fx, ['rev-parse', `${commit}^{tree}`]);
  refused(fx, 'INPUT_INVALID', ['--allow-existing-paths', tree]);
});
test('abspath-review-index-ref-refused', () => {
  const fx = fixture();
  existingPaths(fx);
  refused(fx, 'INPUT_INVALID', ['--allow-existing-paths', ':0']);
});
test('abspath-review-non-ancestor-commit-refused', () => {
  const fx = fixture();
  const [, commit] = existingPaths(fx);
  const tree = fixtureGit(fx, ['rev-parse', `${commit}^{tree}`]);
  const side = fixtureGit(fx, ['commit-tree', tree, '-p', commit], 'side branch\n');
  fixtureGit(fx, ['update-ref', 'refs/heads/side', side]);
  refused(fx, 'INPUT_INVALID', ['--allow-existing-paths', side]);
});
test('abspath-review-dangling-commit-refused', () => {
  const fx = fixture();
  const [, commit] = existingPaths(fx);
  const tree = fixtureGit(fx, ['rev-parse', `${commit}^{tree}`]);
  const dangling = fixtureGit(fx, ['commit-tree', tree], 'unreachable commit\n');
  refused(fx, 'INPUT_INVALID', ['--allow-existing-paths', dangling]);
});
test('abspath-review-ancestor-base-remains-valid-after-head-advances', () => {
  const fx = fixture({ before: base + userPath + '\n' });
  const flag = existingPaths(fx);
  const tree = fixtureGit(fx, ['rev-parse', `${flag[1]}^{tree}`]);
  const head = fixtureGit(fx, ['commit-tree', tree, '-p', flag[1]], 'new head\n');
  fixtureGit(fx, ['update-ref', 'HEAD', head]);
  passes(fx, flag);
});
test('abspath-review-different-invalid-utf8-bytes-do-not-compare-equal', () => {
  const prefix = Buffer.from(base + userPath);
  const before = Buffer.concat([prefix, Buffer.from([0xfe, 0x0a])]);
  const refText = Buffer.concat([prefix, Buffer.from([0xff, 0x0a])]);
  const fx = fixture({ before });
  refused(fx, 'INPUT_INVALID', existingPaths(fx, refText));
});


test('abspath-low-committed-symlink-grants-no-path-budget', () => {
  const fx = fixture({ after: base + userPath + '\n' });
  const [, parent] = existingPaths(fx);
  const blob = fixtureGit(fx, ['hash-object', '-w', '--stdin'], userPath);
  fixtureGit(fx, ['update-index', '--add', '--cacheinfo', '120000', blob, 'docs/agent-notes/x.md']);
  const tree = fixtureGit(fx, ['write-tree']);
  const commit = fixtureGit(fx, ['commit-tree', tree, '-p', parent], 'legacy symlink\n');
  fixtureGit(fx, ['update-ref', 'HEAD', commit]);
  refused(fx, 'ABSOLUTE_PATH', ['--allow-existing-paths', commit]);
});

// Overflow folder spelling follows the repository; only docs and Docs are supported.
for (const notesRoot of ['docs', 'Docs']) {
  const pointer = `See ${notesRoot}/agent-notes/x.md\n`;
  test(`notes-case-${notesRoot}-referenced-overflow`, () => {
    passes(fixture({ after: base + pointer, notesRoot, overflow: { 'x.md': backlink + 'A fact.\n' } }));
  });
  test(`notes-case-${notesRoot}-unreferenced-overflow`, () => {
    refused(fixture({ notesRoot, overflow: { 'x.md': backlink + 'A fact.\n' } }), 'OVERFLOW_UNREFERENCED');
  });
  test(`notes-case-${notesRoot}-legacy-line-moved-from-agents`, () => {
    const fx = fixture({ before: base + userPath + '\n', after: base + pointer,
      notesRoot, overflow: { 'x.md': backlink + userPath + '\n' } });
    passes(fx, existingPaths(fx));
  });
  test(`notes-case-${notesRoot}-legacy-overflow-at-ref-seeds-budget`, () => {
    const before = base + pointer;
    const notes = backlink + userPath + '\n';
    const fx = fixture({ before, notesRoot, overflow: { 'x.md': notes } });
    const flag = existingPaths(fx, before, { [`${notesRoot}/agent-notes/x.md`]: notes });
    passes(fx, flag);
    writeFileSync(join(fx.repo, notesRoot, 'agent-notes/x.md'), notes + userPath + '\n');
    refused(fx, 'ABSOLUTE_PATH', flag);
  });
  test(`notes-case-${notesRoot}-uppercase-pointer-refused`, () => {
    refused(fixture({ after: base + 'See DOCS/agent-notes/x.md\n', notesRoot,
      overflow: { 'x.md': backlink + 'A fact.\n' } }), 'OVERFLOW_UNREFERENCED');
  });
  test(`notes-case-${notesRoot}-opposite-pointer-does-not-alias`, () => {
    const other = notesRoot === 'docs' ? 'Docs' : 'docs';
    refused(fixture({ after: base + `See ${other}/agent-notes/x.md\n`, notesRoot,
      overflow: { 'x.md': backlink + 'A fact.\n' } }), 'OVERFLOW_UNREFERENCED');
  });
}
test('notes-case-distinct-directories-keep-separate-references-and-budget', t => {
  const before = base + link + 'See Docs/agent-notes/topic.md\n';
  const fx = fixture({ before, overflow: { 'topic.md': backlink + userPath + '\n' } });
  const upper = join(fx.repo, 'Docs/agent-notes');
  mkdirSync(upper, { recursive: true });
  if (!readdirSync(fx.repo).includes('Docs')) {
    t.skip('requires a case-sensitive filesystem for distinct docs and Docs directories');
    return;
  }
  writeFileSync(join(upper, 'topic.md'), backlink + windowsUserPath + '\n');
  const flag = existingPaths(fx, before, {
    'docs/agent-notes/topic.md': backlink + userPath + '\n',
    'Docs/agent-notes/topic.md': backlink + windowsUserPath + '\n'
  });
  passes(fx, flag);
  writeFileSync(join(fx.repo, 'AGENTS.md'), base + link);
  refused(fx, 'OVERFLOW_UNREFERENCED', flag);
});

for (const notesRoot of ['docs', 'Docs']) {
  const pointer = `See ${notesRoot}/agent-notes/x.md\n`;
  test(`notes-review-m3-${notesRoot}-agent-notes-stored-case-must-match`, () => {
    const fx = fixture({ after: base + pointer });
    const dir = join(fx.repo, notesRoot, 'Agent-Notes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.md'), backlink + 'A fact.\n');
    refused(fx, 'OVERFLOW_UNREFERENCED');
  });
  test(`notes-review-l6-${notesRoot}-root-symlink-refused`, () => {
    const fx = fixture({ after: base + pointer });
    const dir = join(fx.repo, 'reference', 'agent-notes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.md'), backlink + 'A fact.\n');
    symlinkSync('reference', join(fx.repo, notesRoot), 'dir');
    refused(fx, 'OVERFLOW_UNREFERENCED');
  });
  test(`notes-review-l6-${notesRoot}-agent-notes-symlink-refused`, () => {
    const fx = fixture({ after: base + pointer });
    mkdirSync(join(fx.repo, notesRoot));
    const dir = join(fx.repo, 'reference');
    mkdirSync(dir);
    writeFileSync(join(dir, 'x.md'), backlink + 'A fact.\n');
    symlinkSync('../reference', join(fx.repo, notesRoot, 'agent-notes'), 'dir');
    refused(fx, 'OVERFLOW_UNREFERENCED');
  });
}

test('standards permits newly created CLAUDE import and appended unprotected sections', () => {
  const before = protectedText.trimEnd() + '\n';
  const after = before + '\n## Security review\n- Check authorization.\n';
  const r = run(fixture({ before, after, claude: '@AGENTS.md\n' }));
  assert.equal(r.status, 0, diagnostic(r));
});

test('fix1 LOW Standards creates missing CLAUDE.md import before check', () => {
  const fx = fixture(); rmSync(join(fx.repo, 'CLAUDE.md'));
  assert.equal(existsSync(join(fx.repo, 'CLAUDE.md')), false);
  writeFileSync(join(fx.repo, 'CLAUDE.md'), '@AGENTS.md\n', { flag: 'wx' });
  assert.equal(run(fx).status, 0);
});
