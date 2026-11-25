import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCard, CARD_QUESTIONS, CONTRACT_VERSION } from './card-check.mjs';

const asks = [
  'Is the recommended option consistent with the approved criteria and earlier owner answers quoted in the evidence?',
  'Does the recommended option stay within the authorized scope quoted in the evidence?',
  'Is every factual statement on the card (question, option descriptions, why) supported by the quoted evidence?',
  'Does any option other than the recommended one better satisfy security, efficiency, complexity and risk at equal or lower cost?',
  'Does the recommended option skip, loosen or override a gate, test, review finding or authorization rule?',
  'Does the recommended option introduce an unreviewed security or data-loss risk?'
];
const card = () => ({ questions: [{ id: 'q1', header: 'Scope', question: 'Which scope should we use?', recommended: 'a', why: 'The approved criteria require this scope.', options: [
  { id: 'a', label: 'Small scope', description: 'Matches the approved criteria.' },
  { id: 'b', label: 'Large scope', description: 'Adds a second component.' }
] }] });
const evidence = () => ({ items: [{ label: 'criteria:1', text: 'The owner approved the small scope.' }] });
const receipt = (over = {}) => ({ gate: 'check', verdict: 'confirmed', pass: true, inputSha256: '1234567890abcdef', at: '2026-11-11T12:00:00.000Z', reasons: [], ...over });
function fixture(t) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'thl-card-check-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const calls = [];
  const fake = (code = 0, out = receipt(), stderr = '') => (exe, args) => {
    assert.equal(exe, process.execPath);
    assert.match(args[0], /jev\.mjs$/);
    assert.equal(args[1], 'check');
    calls.push(JSON.parse(readFileSync(args[2], 'utf8')));
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(typeof out === 'string' ? out : JSON.stringify(out) + '\n');
      child.stderr.end(stderr); child.emit('close', code);
    });
    return child;
  };
  return { cacheDir, calls, fake };
}

test('one invocation checks the exact six questions and verbatim card evidence; pass has a receipt', async t => {
  const f = fixture(t);
  assert.equal(CONTRACT_VERSION, '1');
  assert.deepEqual(CARD_QUESTIONS, asks.map((ask, i) => ({ ask, expect: i < 3 ? 'yes' : 'no' })));
  const r = await checkCard(card(), evidence(), { ...f, spawnImpl: f.fake() });
  assert.equal(r.status, 'pass'); assert.equal(r.cached, false);
  assert.equal(r.receiptId, 'check-1234567890abcdef-2026-11-11T12:00:00.000Z');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].questions, CARD_QUESTIONS);
  for (const s of ['CARD:', card().questions[0].question, 'a: Small scope', 'Matches the approved criteria.', 'RECOMMENDED: a', 'WHY: The approved criteria']) assert.ok(f.calls[0].evidence[0].includes(s), s);
});

test('one call covers four card questions using recommended option(s)', async t => {
  const f = fixture(t), c = card();
  c.questions = [1, 2, 3, 4].map(i => ({ ...c.questions[0], id: `q${i}`, question: `Should we choose scope ${i}?` }));
  assert.equal((await checkCard(c, evidence(), { ...f, spawnImpl: f.fake() })).status, 'pass');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].questions.length, 6);
  assert.ok(f.calls[0].questions.every(q => !q.ask.includes('recommended option') || q.ask.includes('recommended option(s)')));
  for (const q of c.questions) assert.ok(f.calls[0].evidence[0].includes(q.question));
});

test('not-confirmed persists full reasons and is never cached; unavailable hides stderr', async t => {
  const f = fixture(t), reasons = asks.map((q, i) => `${i}: ${q} ${'explanation '.repeat(40)}`);
  const r = await checkCard(card(), evidence(), { ...f, spawnImpl: f.fake(2, receipt({ pass: false, verdict: 'not-confirmed', reasons })) });
  assert.equal(r.status, 'not-confirmed'); assert.equal(r.receiptId, null);
  assert.deepEqual(JSON.parse(readFileSync(r.reasonsPath, 'utf8')).reasons, reasons);
  assert.deepEqual(r.reasons, reasons);
  const u = await checkCard(card(), evidence(), { ...f, spawnImpl: f.fake(3, '', 'DO-NOT-EXPOSE-STDERR') });
  assert.equal(u.status, 'unavailable'); assert.ok(!JSON.stringify(u).includes('DO-NOT-EXPOSE'));
  assert.equal(f.calls.length, 2);
});

test('only valid confirmed receipts pass; malformed, empty, dry-run and incomplete success refuse', async t => {
  const f = fixture(t);
  for (const out of ['{', '', receipt({ dryRun: true }), receipt({ verdict: 'not-confirmed' }), receipt({ pass: false }), receipt({ gate: 'plan' }), receipt({ inputSha256: 'bad' }), receipt({ at: undefined })]) {
    const r = await checkCard(card(), evidence(), { ...f, spawnImpl: f.fake(0, out) });
    assert.equal(r.status, 'unavailable'); assert.equal(r.cached, false);
  }
});

test('cache binds full receipt, contract, card, evidence and questions; corrupt cache is a miss', async t => {
  const f = fixture(t), opts = { ...f, spawnImpl: f.fake() };
  await checkCard(card(), evidence(), opts);
  assert.equal((await checkCard(card(), evidence(), opts)).cached, true); assert.equal(f.calls.length, 1);
  const file = join(f.cacheDir, readdirSync(f.cacheDir).find(x => !x.endsWith('.reasons.json')));
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(stored.result, receipt()); assert.equal(stored.contractVersion, '1');
  for (const bad of ['{', JSON.stringify({ ...stored, digest: 'wrong' }), JSON.stringify({ ...stored, contractVersion: '0' }), JSON.stringify({ ...stored, result: receipt({ dryRun: true }) })]) {
    writeFileSync(file, bad); assert.equal((await checkCard(card(), evidence(), opts)).cached, false);
  }
  const c = card(); c.questions[0].recommended = 'b';
  await checkCard(c, evidence(), opts);
  await checkCard(card(), { items: [{ label: 'new', text: 'Changed evidence' }] }, opts);
  assert.equal(f.calls.length, 7);
});

test('final UTF-8 state fits 24000 bytes; tail evidence trims with marker and item cap', async t => {
  const f = fixture(t), items = Array.from({ length: 18 }, (_, i) => ({ label: `source ${i}`, text: '漢'.repeat(3000) }));
  assert.equal((await checkCard(card(), { items }, { ...f, spawnImpl: f.fake() })).status, 'pass');
  const input = f.calls[0];
  assert.ok(Buffer.byteLength(JSON.stringify({ context: input.context, evidence: input.evidence })) <= 24000);
  assert.ok(input.evidence.slice(1).every(s => s.length <= 2500));
  assert.ok(input.evidence.join('\n').includes('[trimmed]'));
  assert.ok(input.evidence[1].startsWith('source 0'));
  assert.ok(!input.evidence.join('\n').includes('source 17'));
});

test('card text alone over budget refuses without calling or truncating it', async t => {
  const f = fixture(t), c = card();
  c.questions = [1, 2, 3, 4].map(i => ({ ...c.questions[0], id: `q${i}`.padEnd(24, 'x'), header: '漢'.repeat(12), question: '漢'.repeat(399) + '?', why: '漢'.repeat(300), options: [1, 2, 3, 4].map(n => ({ id: String(n).padEnd(24, 'x'), label: '漢'.repeat(60), description: '漢'.repeat(240) })), recommended: '1'.padEnd(24, 'x') }));
  assert.equal((await checkCard(c, evidence(), { ...f, spawnImpl: f.fake() })).status, 'refused');
  assert.equal(f.calls.length, 0);
});

test('rendered card above 2500 characters refuses before Jev can clip it', async t => {
  const f = fixture(t), c = card();
  c.questions = [1, 2, 3].map(i => ({ ...c.questions[0], id: `q${i}`, question: 'q'.repeat(399) + '?', why: 'w'.repeat(300), options: c.questions[0].options.map(o => ({ ...o, description: 'd'.repeat(240) })) }));
  const r = await checkCard(c, evidence(), { ...f, spawnImpl: f.fake() });
  assert.equal(r.status, 'refused'); assert.match(r.reasons.join(' '), /card too large.*shorten options\/why/i);
  assert.equal(f.calls.length, 0);
});

test('CLI prints one JSON line and maps a cache pass and invalid timeout to exit 0 and 3', async t => {
  const f = fixture(t);
  await checkCard(card(), evidence(), { ...f, spawnImpl: f.fake() });
  const cardPath = join(f.cacheDir, 'card-input.json'), evidencePath = join(f.cacheDir, 'evidence-input.json');
  writeFileSync(cardPath, JSON.stringify(card())); writeFileSync(evidencePath, JSON.stringify(evidence()));
  const args = [join(import.meta.dirname, 'card-check.mjs'), cardPath, evidencePath, '--cache-dir', f.cacheDir];
  const cached = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(cached.status, 0); assert.equal(cached.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(cached.stdout).cached, true);
  const invalid = spawnSync(process.execPath, [...args, '--timeout-ms', '20001'], { encoding: 'utf8' });
  assert.equal(invalid.status, 3); assert.equal(JSON.parse(invalid.stdout).status, 'refused');
});

test('scan decoded strings before trimming: tail item, label, card and JSON-escaped assignments', async t => {
  const f = fixture(t), secret = 'sk-' + 'x'.repeat(32), opts = { ...f, spawnImpl: f.fake() };
  for (const e of [
    { items: [...Array.from({ length: 30 }, () => ({ label: 'source', text: 'x'.repeat(2500) })), { label: 'tail', text: secret }] },
    { items: [{ label: secret, text: 'evidence' }] },
    JSON.parse('{"items":[{"label":"source","text":"API_KEY=\\u0022' + 'x'.repeat(32) + '\\u0022"}]}')
  ]) {
    const r = await checkCard(card(), e, opts); assert.equal(r.status, 'refused'); assert.ok(!JSON.stringify(r).includes(secret));
  }
  const c = card(); c.questions[0].why = secret;
  assert.equal((await checkCard(c, evidence(), opts)).status, 'refused'); assert.equal(f.calls.length, 0);
});

test('invalid or over-limit timeout never invokes child', async t => {
  const f = fixture(t);
  for (const timeoutMs of [0, -1, 20001, Infinity, NaN, 1.5, 'nonsense']) {
    assert.equal((await checkCard(card(), evidence(), { ...f, timeoutMs, spawnImpl: f.fake() })).status, 'refused');
  }
  assert.equal(f.calls.length, 0);
});

test('hard timeout SIGKILLs a hung fake child and returns without close', async t => {
  const f = fixture(t); let signal;
  const start = Date.now();
  const r = await checkCard(card(), evidence(), { ...f, timeoutMs: 25, spawnImpl: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = s => { signal = s; return true; }; return child;
  } });
  assert.equal(r.status, 'timeout'); assert.equal(signal, 'SIGKILL'); assert.ok(Date.now() - start < 1025);
});

test('hard timeout terminates a real sleeping fake Jev process', async t => {
  const f = fixture(t); let child;
  const start = Date.now();
  const r = await checkCard(card(), evidence(), { ...f, timeoutMs: 80, spawnImpl: () => (child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])) });
  assert.equal(r.status, 'timeout'); assert.ok(Date.now() - start < 1080);
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
  assert.equal(child.signalCode, 'SIGKILL');
});
