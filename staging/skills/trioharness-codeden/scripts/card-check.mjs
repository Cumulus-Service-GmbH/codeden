#!/usr/bin/env node
// One bounded Jev check per card attempt; only confirmed receipts are reusable.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecrets } from './secret-patterns.mjs';
import { validateCard } from './questions.mjs';
import { isMain } from './is-main.mjs';

export const CONTRACT_VERSION = '1';
export const CARD_QUESTIONS = Object.freeze([
  { ask: 'Is the recommended option consistent with the approved criteria and earlier owner answers quoted in the evidence?', expect: 'yes' },
  { ask: 'Does the recommended option stay within the authorized scope quoted in the evidence?', expect: 'yes' },
  { ask: 'Is every factual statement on the card (question, option descriptions, why) supported by the quoted evidence?', expect: 'yes' },
  { ask: 'Does any option other than the recommended one better satisfy security, efficiency, complexity and risk at equal or lower cost?', expect: 'no' },
  { ask: 'Does the recommended option skip, loosen or override a gate, test, review finding or authorization rule?', expect: 'no' },
  { ask: 'Does the recommended option introduce an unreviewed security or data-loss risk?', expect: 'no' }
].map(Object.freeze));
const MAX_BYTES = 24000, ITEM_MAX = 2500, TRIMMED = '\n[trimmed]';
const CONTEXT = 'Check every recommended option against only the quoted card and supporting evidence. Missing evidence does not establish a recommendation.';

// Walk decoded strings, including labels and unknown fields, before any clipping or serialisation.
function hasSecrets(value) {
  if (typeof value === 'string') return findSecrets(value).length > 0;
  if (Array.isArray(value)) return value.some(hasSecrets);
  return !!value && typeof value === 'object' && Object.entries(value).some(([k, v]) => hasSecrets(k) || hasSecrets(v));
}
function validReceipt(out) {
  return out && out.gate === 'check' && out.verdict === 'confirmed' && out.pass === true && !Object.hasOwn(out, 'dryRun')
    && /^[0-9a-f]{16}$/.test(out.inputSha256 || '') && typeof out.at === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(out.at) && Number.isFinite(Date.parse(out.at)) && !hasSecrets(out);
}
const receiptId = out => `check-${out.inputSha256}-${out.at}`;
function renderCard(card) {
  return card.questions.map(q => [
    `CARD: ${q.id} [${q.header}] ${q.question}`,
    `MULTISELECT: ${!!q.multiSelect}`,
    ...q.options.map(o => `${o.id}: ${o.label} / ${o.description}`),
    `RECOMMENDED: ${Array.isArray(q.recommended) ? q.recommended.join(', ') : q.recommended}`,
    `WHY: ${q.why}`
  ].join('\n')).join('\n\n');
}
function buildInput(card, evidence) {
  const questions = card.questions.length === 1 ? CARD_QUESTIONS : CARD_QUESTIONS.map(q => ({ ...q, ask: q.ask.replaceAll('recommended option', 'recommended option(s)') }));
  const input = { context: CONTEXT, questions, evidence: [renderCard(card)] };
  const bytes = () => Buffer.byteLength(JSON.stringify({ context: input.context, evidence: input.evidence }), 'utf8');
  if (bytes() > MAX_BYTES) throw new Error('Card text exceeds the 24000-byte state budget.');
  for (const item of evidence.items) {
    const text = `${item.label}\n${item.text}`;
    input.evidence.push(text.length <= ITEM_MAX ? text : text.slice(0, ITEM_MAX - TRIMMED.length) + TRIMMED);
  }
  // Remove supporting excerpts tail-first; preserve the verbatim card and signal omitted evidence.
  while (bytes() > MAX_BYTES && input.evidence.length > 1) {
    const i = input.evidence.length - 1;
    if (input.evidence[i] === TRIMMED.trim()) {
      if (i === 1) break;
      input.evidence.splice(i - 1, 1); continue;
    }
    input.evidence[i] = TRIMMED.trim();
  }
  if (bytes() > MAX_BYTES) throw new Error('Card text leaves no room for the evidence trimming marker.');
  if (findSecrets(JSON.stringify(input)).length) throw new Error('Secret-shaped input refused; no text was sent.');
  return input;
}

function invoke(inputPath, timeoutMs, spawnImpl) {
  return new Promise(resolve => {
    let child, timer, stdout = '', settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    try {
      child = spawnImpl(process.execPath, [fileURLToPath(new URL('./jev.mjs', import.meta.url)), 'check', inputPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* still resolve at the deadline */ } finish({ status: 'timeout', reasons: ['Recommendation check exceeded its hard timeout.'] }); }, timeoutMs);
      child.stdout.on('data', data => {
        stdout += data.toString();
        if (Buffer.byteLength(stdout) > 1024 * 1024) {
          try { child.kill('SIGKILL'); } catch { /* unavailable */ }
          finish({ status: 'unavailable', reasons: ['Recommendation check output exceeded its bound.'] });
        }
      });
      child.stderr.resume(); // never forward raw stderr or include it in a failure reason
      child.once('error', () => finish({ status: 'unavailable', reasons: ['Recommendation check could not start.'] }));
      child.once('close', code => {
        if (settled) return;
        let out;
        try { out = JSON.parse(stdout.trim()); } catch { /* malformed stdout is never a pass */ }
        if (code === 0 && validReceipt(out)) return finish({ status: 'pass', result: out });
        if (code === 2 && out?.gate === 'check' && out.verdict === 'not-confirmed' && out.pass === false && !hasSecrets(out) && Array.isArray(out.reasons) && out.reasons.every(x => typeof x === 'string')) {
          return finish({ status: 'not-confirmed', reasons: out.reasons });
        }
        finish({ status: 'unavailable', reasons: ['Recommendation check unavailable or missing a valid confirmed receipt.'] });
      });
    } catch {
      try { child?.kill('SIGKILL'); } catch { /* unavailable */ }
      finish({ status: 'unavailable', reasons: ['Recommendation check could not start.'] });
    }
  });
}

export async function checkCard(card, evidence, { cacheDir = join(homedir(), '.trioharness-lean', 'card-check-cache'), timeoutMs = 20000, spawnImpl = spawn } = {}) {
  const start = Date.now(); let digest, temp;
  const response = (status, reasons = [], extra = {}) => ({ status, receiptId: null, reasons, cached: false, elapsedMs: Date.now() - start, ...extra });
  const failure = (status, reasons) => {
    const out = response(status, reasons);
    if (digest) {
      try {
        mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        out.reasonsPath = join(cacheDir, `${digest}.reasons.json`);
        writeFileSync(out.reasonsPath, JSON.stringify({ status, reasons }, null, 2) + '\n', { mode: 0o600 });
      } catch { out.reasonsPath = null; }
    }
    return out;
  };
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) return failure('refused', ['timeout-ms must be an integer from 1 to 20000.']);
    if (hasSecrets(card) || hasSecrets(evidence)) return failure('refused', ['Secret-shaped input refused; no text was sent.']);
    validateCard(card);
    if (card.questions.some(q => q.recommended === null)) return failure('refused', ['A recommendation is required for this check attempt.']);
    if (!evidence || !Array.isArray(evidence.items) || !evidence.items.length || evidence.items.some(i => !i || typeof i.label !== 'string' || typeof i.text !== 'string')) return failure('refused', ['Evidence must contain labelled text items.']);
    const questions = card.questions.length === 1 ? CARD_QUESTIONS : CARD_QUESTIONS.map(q => ({ ...q, ask: q.ask.replaceAll('recommended option', 'recommended option(s)') }));
    digest = createHash('sha256').update(JSON.stringify([CONTRACT_VERSION, questions, card, evidence])).digest('hex');
    if (renderCard(card).length > ITEM_MAX) return failure('refused', ['Card too large; shorten options/why to at most 2500 rendered characters.']);
    const input = buildInput(card, evidence);
    const cachePath = join(cacheDir, `${digest}.json`);
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (cached.contractVersion === CONTRACT_VERSION && cached.digest === digest && validReceipt(cached.result)) return response('pass', [], { receiptId: receiptId(cached.result), cached: true });
    } catch { /* cache miss: only a valid, matching confirmed result is reusable */ }
    temp = mkdtempSync(join(tmpdir(), 'thl-card-check-'));
    const inputPath = join(temp, 'input.json');
    writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 });
    const out = await invoke(inputPath, timeoutMs, spawnImpl);
    if (out.status !== 'pass') return failure(out.status, out.reasons);
    try {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      writeFileSync(cachePath, JSON.stringify({ contractVersion: CONTRACT_VERSION, digest, result: out.result }) + '\n', { mode: 0o600 });
    } catch { /* a cache write failure cannot fabricate or invalidate the received verdict */ }
    return response('pass', [], { receiptId: receiptId(out.result) });
  } catch {
    return failure('refused', ['Invalid card, evidence or oversized state; no recommendation was confirmed.']);
  } finally { if (temp) rmSync(temp, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2), opt = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
  let out;
  try {
    const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
    const cardPath = opt('card') || positional[0], evidencePath = opt('evidence') || positional[1];
    out = await checkCard(JSON.parse(readFileSync(cardPath, 'utf8')), JSON.parse(readFileSync(evidencePath, 'utf8')), {
      cacheDir: opt('cache-dir'), timeoutMs: args.includes('--timeout-ms') ? Number(opt('timeout-ms')) : 20000
    });
  } catch { out = { status: 'refused', receiptId: null, reasons: ['Usage: card-check.mjs <card.json> <evidence.json> [--cache-dir <dir>] [--timeout-ms 1..20000].'], cached: false, elapsedMs: 0 }; }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = out.status === 'pass' ? 0 : out.status === 'not-confirmed' ? 2 : 3;
}
