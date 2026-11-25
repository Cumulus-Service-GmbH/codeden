import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const script = join(import.meta.dirname, 'receipt-check.mjs');
function fixture(t, { tier = 'lean', role = 'writer', external = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thl-receipts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const installed = join(home, '.codex/skills'); mkdirSync(installed, { recursive: true });
  const runDir = join(dir, '.trioharness-direct/runs/r1'); mkdirSync(join(runDir, 'proof/docs'), { recursive: true });
  const skills = ['test-driven-development', 'verification-before-completion'].map(name => {
    mkdirSync(join(installed, name));
    const path = join(installed, name, 'SKILL.md'), body = `---\nname: ${name}\n---\nChecklist\n`;
    writeFileSync(path, body);
    return { name: `superpowers:${name}`, version: '1', path, sha256: createHash('sha256').update(body).digest('hex') };
  });
  const proof = join(runDir, 'proof/docs/1.txt'), file = join(runDir, 'worker.md');
  const doc = { libraryId: '/vendor/lib', servedVersion: '2.1', url: 'https://vendor.example/docs/2.1', date: new Date(Date.now() - 60000).toISOString(), proof };
  writeFileSync(join(runDir, 'state.json'), JSON.stringify({ createdAt: new Date(Date.now()-120000).toISOString() }));
  const raw = () => writeFileSync(doc.proof, JSON.stringify(doc));
  raw();
  const write = (changes = {}) => {
    const data = { skills, docs: external ? [doc] : [], start: new Date(Date.now() - 120000).toISOString(), ...changes };
    writeFileSync(file, `SKILLS: ${JSON.stringify(data.skills)}\nDOCS: ${JSON.stringify(data.docs)}\nRUN_START: ${data.start}\nEXTERNAL_APIS: ${external ? 'yes' : 'no'}\nUI_PACKET: no\nFAILURE: no\nDEPRECATIONS: none\n`);
  };
  write();
  return { dir: runDir, root: dir, home, file, skills, doc, write, raw, run: (flags = ['--ui', 'no', '--failure', 'no', '--external-apis', external ? 'yes' : 'no']) => spawnSync(process.execPath, [script, '--role', role, '--tier', tier, '--file', file, ...flags], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } }) };
}
function refused(f, pattern) { const r = f.run(); assert.equal(r.status, 2, r.stderr); assert.match(r.stdout, pattern); }
test('trivial tier requires no receipt', t => { const f = fixture(t, { tier: 'trivial' }); writeFileSync(f.file, 'done'); assert.equal(f.run().status, 0); });
test('lean verifies skill file digests and names', t => { const f = fixture(t); assert.equal(f.run().status, 0); writeFileSync(f.skills[0].path, 'changed'); refused(f, /SKILL_HASH/); });
test('missing required skill and missing file are refused together', t => { const f = fixture(t); rmSync(f.skills[1].path); f.write({ skills: [f.skills[1]] }); refused(f, /test-driven-development/); refused(f, /SKILL_FILE/); });
test('receipt cannot label a different skill file as TDD', t => { const f = fixture(t); f.skills[0].path = f.skills[1].path; f.skills[0].sha256 = f.skills[1].sha256; f.write(); refused(f, /SKILL_NAME/); });
test('external APIs require raw docs proof and deprecation disposition', t => { const f = fixture(t, { external: true }); assert.equal(f.run().status, 0); rmSync(f.doc.proof); refused(f, /DOCS_PROOF/); });
test('missing docs receipt is refused', t => { const f = fixture(t, { external: true }); f.write({ docs: [] }); refused(f, /DOCS_MISSING/); });
for (const field of ['libraryId', 'servedVersion', 'url', 'date']) test(`docs proof must contain ${field}`, t => { const f = fixture(t, { external: true }); const raw = { ...f.doc }; delete raw[field]; writeFileSync(f.doc.proof, JSON.stringify(raw)); refused(f, /DOCS_PROOF/); });
test('stale date and invalid date are refused', t => { const f = fixture(t, { external: true }); for (const date of ['2020-01-01', 'invalid']) { f.doc.date = date; f.raw(); f.write(); refused(f, /DOCS_DATE/); } });
test('run state start takes precedence over a caller supplied earlier start', t => { const f = fixture(t, { external: true }); writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ createdAt: new Date().toISOString() })); refused(f, /DOCS_DATE/); });
test('standard reviewer requires its role skill', t => { const f = fixture(t, { tier: 'standard', role: 'code-reviewer' }); refused(f, /requesting-code-review/); });
test('unknown role or tier is refused', t => { for (const opts of [{ role: 'anything' }, { tier: 'anything' }]) { const f = fixture(t, opts); refused(f, /INPUT_INVALID/); } });
test('empty or malformed result lists missing items', t => { const f = fixture(t); writeFileSync(f.file, 'SKILLS: invalid\n'); refused(f, /SKILLS_FORMAT/); });

test('fix1 M4 refuses project skill despite matching name/hash', t => {
  const f = fixture(t), path = join(f.root, 'fake/SKILL.md'); mkdirSync(join(f.root, 'fake')); writeFileSync(path, readFileSync(f.skills[0].path)); f.skills[0].path = path; f.write(); refused(f, /SKILL_ROOT/);
});
test('fix1 M4 installed symlink escaping root is refused', t => {
  const f = fixture(t), outside = join(f.root, 'outside.md'); writeFileSync(outside, readFileSync(f.skills[0].path)); rmSync(f.skills[0].path); symlinkSync(outside, f.skills[0].path); refused(f, /SKILL_ROOT/);
});
test('fix1 M4 Architect flags required and worker cannot suppress triggers', t => {
  const f = fixture(t);
  for (const flags of [[], ['--ui', 'bad', '--failure', 'no', '--external-apis', 'no'], ['--ui', 'yes', '--failure', 'no', '--external-apis', 'no'], ['--ui', 'no', '--failure', 'yes', '--external-apis', 'yes']]) { const r = f.run(flags); assert.equal(r.status, 2); assert.match(r.stdout, /FLAGS|MISMATCH/); }
});
test('fix1 M4 late receipts cannot count', t => { const f = fixture(t); writeFileSync(f.file, '\n'.repeat(30) + readFileSync(f.file, 'utf8')); refused(f, /SKILLS_FORMAT/); });
test('fix1 M4 docs outside owning run and future dates are refused', t => {
  const f = fixture(t, { external: true }); const original = f.doc.proof; f.doc.proof = join(f.root, 'outside.txt'); f.raw(); f.write(); refused(f, /DOCS_PROOF_PATH/);
  f.doc.proof = original; f.doc.date = new Date(Date.now()+86400000).toISOString(); f.raw(); f.write(); refused(f, /DOCS_DATE/);
});
test('fix1 LOW lean non-writer needs no TDD or verification skill receipts', t => { const f = fixture(t, { role: 'code-reviewer' }); f.write({ skills: [] }); const r = f.run(); assert.equal(r.status, 0, r.stdout); });

test('fix1 M4 proof symlink cannot escape owning docs directory', t => {
  const f = fixture(t, { external: true }), outside = join(f.root, 'outside.txt');
  writeFileSync(outside, readFileSync(f.doc.proof)); rmSync(f.doc.proof); symlinkSync(outside, f.doc.proof); refused(f, /DOCS_PROOF_PATH/);
});

for (const role of ['investigator', 'agents-md-writer']) test(`fix3 L3 standard ${role} always requires docs despite external flag no`, t => {
  const f = fixture(t, { role, tier: 'standard' });
  for (const name of role === 'investigator' ? ['context7-mcp', 'systematic-debugging'] : ['context7-mcp']) {
    const path = join(f.home, '.codex/skills', name, 'SKILL.md'), body = `---\nname: ${name}\n---\nChecklist\n`;
    mkdirSync(join(f.home, '.codex/skills', name)); writeFileSync(path, body);
    f.skills.push({ name, version: '1', path, sha256: createHash('sha256').update(body).digest('hex') });
  }
  f.write();
  refused(f, /DOCS_MISSING/);
  f.write({ docs: [f.doc] });
  const r = f.run(); assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /RECEIPT_CHECK: PASS/);
});

for (const [role, flag, field, name] of [
  ['writer', 'executing-plan', 'EXECUTING_PLAN', 'executing-plans'],
  ['writer', 'review-feedback', 'REVIEW_FEEDBACK', 'receiving-code-review'],
  ['architect', 'review-feedback', 'REVIEW_FEEDBACK', 'receiving-code-review'],
  ['architect', 'selecting-tree', 'SELECTING_TREE', 'using-git-worktrees'],
  ['architect', 'closing', 'CLOSING', 'finishing-a-development-branch'],
  ['architect', 'requesting-review', 'REQUESTING_REVIEW', 'requesting-code-review'],
  ['architect', 'intake-exploration', 'INTAKE_EXPLORATION', 'brainstorming']
]) test(`conditional ${name} receipt is required only for assigned ${role} trigger`, t => {
  const f = fixture(t, { role });
  f.write({ skills: role === 'writer' ? f.skills : [] });
  assert.equal(f.run().status, 0);
  const flags = ['--ui', 'no', '--failure', 'no', '--external-apis', 'no', `--${flag}`, 'yes'];
  const original = readFileSync(f.file, 'utf8');
  writeFileSync(f.file, original + `${field}: yes\n`);
  let r = f.run(flags); assert.equal(r.status, 2); assert.match(r.stdout, new RegExp(`SKILL_MISSING:${name}`));
  const path = join(f.home, '.codex/skills', name, 'SKILL.md'), body = `---\nname: ${name}\n---\nChecklist\n`;
  mkdirSync(join(f.home, '.codex/skills', name)); writeFileSync(path, body);
  f.write({ skills: [...(role === 'writer' ? f.skills : []), { name, version: '1', path, sha256: createHash('sha256').update(body).digest('hex') }] });
  writeFileSync(f.file, readFileSync(f.file, 'utf8') + `${field}: yes\n`);
  r = f.run(flags); assert.equal(r.status, 0, r.stdout);
  writeFileSync(f.file, readFileSync(f.file, 'utf8').replace(`${field}: yes`, `${field}: no`));
  r = f.run(flags); assert.equal(r.status, 2); assert.match(r.stdout, /FLAGS_MISMATCH/);
  r = f.run([...flags.slice(0, -1), 'bad']); assert.equal(r.status, 2); assert.match(r.stdout, /FLAGS_INVALID/);
});

for (const role of ['investigator', 'agents-md-writer']) test(`standard ${role} external facts still require docs`, t => {
  const f = fixture(t, { role, tier: 'standard', external: true });
  f.write({ docs: [] }); refused(f, /DOCS_MISSING/);
});


test('standard architect requires brainstorming even without an intake flag', t => {
  const f = fixture(t, { role: 'architect', tier: 'standard' });
  refused(f, /SKILL_MISSING:brainstorming/);
});

test('legacy free-text trigger fields do not become flags', t => {
  const f = fixture(t);
  writeFileSync(f.file, readFileSync(f.file, 'utf8') + 'CLOSING: merged PR\nEXECUTING_PLAN: completed\nREVIEW_FEEDBACK: accepted R1\n');
  const r = f.run(); assert.equal(r.status, 0, r.stdout);
});

function reviewerFlags(originalFlags) {
  const packet = readFileSync(new URL('../templates/review-prompt.md', import.meta.url), 'utf8');
  const command = /`receipt-check\.mjs ([^`]+)`/.exec(packet)?.[1];
  assert.ok(command?.includes('<original-writer-receipt-flags>'), 'review must forward the original packet flags');
  return command.split(/\s+/).slice(6).flatMap(arg => arg === '<original-writer-receipt-flags>' ? originalFlags : [arg]);
}

test('reviewer validation accepts the legacy packet flags without inferring triggers', t => {
  const f = fixture(t);
  writeFileSync(f.file, readFileSync(f.file, 'utf8') + 'CLOSING: merged PR\n');
  const r = f.run(reviewerFlags(['--ui', 'no', '--failure', 'no', '--external-apis', 'no']));
  assert.equal(r.status, 0, r.stdout);
});

test('reviewer validation forwards triggered packet flags and requires the skill', t => {
  const f = fixture(t);
  const flags = reviewerFlags(['--ui', 'no', '--failure', 'no', '--external-apis', 'no', '--executing-plan', 'yes', '--review-feedback', 'no']);
  const claims = 'EXECUTING_PLAN: yes\nREVIEW_FEEDBACK: no\n';
  writeFileSync(f.file, readFileSync(f.file, 'utf8') + claims);
  let r = f.run(flags); assert.equal(r.status, 2); assert.match(r.stdout, /SKILL_MISSING:executing-plans/);
  const path = join(f.home, '.codex/skills/executing-plans/SKILL.md'), body = '---\nname: executing-plans\n---\nChecklist\n';
  mkdirSync(join(f.home, '.codex/skills/executing-plans')); writeFileSync(path, body);
  f.write({ skills: [...f.skills, { name: 'executing-plans', version: '1', path, sha256: createHash('sha256').update(body).digest('hex') }] });
  writeFileSync(f.file, readFileSync(f.file, 'utf8') + claims);
  r = f.run(flags); assert.equal(r.status, 0, r.stdout);
});
