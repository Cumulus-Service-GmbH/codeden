#!/usr/bin/env node
// TrioHarness Lean — the user's decision to proceed past a rejected Jev plan gate.
// Jev stays a hard gate for the Architect: it never lowers a threshold, marks a gate advisory or asks for an override
// while it still has fixes to try (revise, Investigator pack, scope-cut). When those are used up and Jev still rejects a
// plan item the USER wants done, the Architect shows ONE card with Jev's failing items verbatim. Only the user's answer
// "proceed" can waive it, and the waiver covers exactly the one input Jev rejected (bound by digest), is written to the
// run's jev-exceptions.jsonl, and is listed in the final report. The independent code review, tests, guard and CI still apply.
// Plan gate only. Never for done, finding, guard or secret-scan hits, failing tests, deploys or production.
// Usage:
//   node gate-exception.mjs card  --repo . --run <id> --input <plan.json> --item "<what this plan item is>"   needs a recorded Jev rejection of this exact input; asks the card
//   node gate-exception.mjs grant --repo . --run <id> --set Q-n --input <plan.json>                           after the user answered "proceed" on that card
//   node gate-exception.mjs list  --repo . --run <id>                                                         for the final report
//   then: node jev.mjs plan <plan.json> --exception-repo . --exception-run <id>
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isMain } from './is-main.mjs';
import { inputDigest, loadPacketSource, receiptsPath } from './jev.mjs';
export { receiptsPath } from './jev.mjs';
import { askCard, readSets } from './questions.mjs';
import { runDir, fileOf, listExceptions } from './exception-store.mjs';
export { listExceptions, findException } from './exception-store.mjs';
import { redactText } from './secret-patterns.mjs';
import { readState, withStateLock, saveState, preparePlanBudgetRenewal, grantPlanBudgetRenewal } from './run-state.mjs';

export const TOPIC = 'jevexc';

export function lastRejection(digest, receipts) {
  if (!existsSync(receipts)) return null;
  const lines = readFileSync(receipts, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return [...lines].reverse().find(r => r.gate === 'plan' && r.verdict === 'revise' && r.inputSha256 === digest) || null;
}

export function makeCard({ item, digest, reasons, reasonsFile, run }) {
  const text = redactText(reasons.join('; ')).slice(0, 190);
  return { questions: [{
    id: TOPIC, header: 'Jev gate', kind: 'gate', multiSelect: false,
    question: `Jev still rejects "${redactText(String(item)).slice(0, 60)}" (run ${run ?? "untracked"}, input ${digest}) after every fix was tried: ${text}. Proceed anyway?`,
    options: [
      { id: 'park', label: 'Park it (Recommended)', description: `The item stays open; nothing is built. Full Jev reasons: ${basename(reasonsFile)}.` },
      { id: 'proceed', label: 'Proceed, record my exception', description: 'Build it. Code review, tests, guard and CI still apply; the exception is listed in the final report.' }
    ],
    recommended: 'park', why: 'Waiving a gate is your decision; parking is the safe default and is what an unattended run takes.'
  }] };
}

export function ask({ repo, run, input, item, receipts = receiptsPath(repo), now }) {
  if (!item || !String(item).trim()) throw new Error('USAGE: --item "<what this plan item is>"');
  const digest = inputDigest('plan', input);
  const state = readState(repo, run);
  if (state?.status?.startsWith('parked:')) throw new Error('RUN_PARKED');
  const rej = lastRejection(digest, receipts);
  const missingExceptionRejection = !rej && state?.status === 'awaiting-exception';
  if (state?.status === 'awaiting-budget' || missingExceptionRejection || (!rej && state?.planBudgetRenewal)) {
    try {
      preparePlanBudgetRenewal(repo, run, digest);
    } catch (error) {
      // An unavailable judgement at the cap can qualify for renewal without a rejection.
      const message = String(error?.message ?? error);
      const renewalUnavailable = message === 'BUDGET_RENEWAL_NOT_AVAILABLE' || message.startsWith('BUDGET_RENEWAL_USED:');
      if (missingExceptionRejection && renewalUnavailable) {
        throw new Error(`NO_MATCHING_REJECTION: ${digest} not in ${receipts}`);
      }
      throw error;
    }
    const card = { questions: [{
      id: TOPIC, header: 'Jev budget', kind: 'gate', multiSelect: false,
      question: `Jev plan submission budget is exhausted for "${redactText(String(item)).slice(0, 60)}" (run ${run}, input ${digest}). Renew one submission?`,
      options: [
        { id: 'park', label: 'Park it (Recommended)', description: 'Keep the plan unresolved and stop this run.' },
        { id: 'renew', label: 'Renew one submission', description: 'Permit one real Jev judgement of this exact input. Findings and all other gates still apply.' }
      ],
      recommended: 'park', why: 'This is the only renewal allowed in this run; a new judgement may still reject the plan.'
    }] };
    const rec = askCard(repo, run, card, { from: 'architect', ...(now ? { now } : {}), standing: { skip: true } });
    // askCard takes the same lock itself. Register its immutable content afterward;
    // a crash between these steps leaves an ungrantable card, never extra credit.
    withStateLock(repo, run, () => {
      const current = readState(repo, run);
      if (current?.status !== 'awaiting-budget' || current.awaitingBudget?.inputSha256 !== digest || current.planBudgetRenewal) throw new Error('BUDGET_RENEWAL_NOT_AVAILABLE');
      current.planBudgetCard = { run, inputSha256: digest, set: rec.id, cardSha256: createHash('sha256').update(JSON.stringify(rec.card)).digest('hex') };
      saveState(join(runDir(repo, run), 'state.json'), current);
    });
    return rec;
  }
  if (!rej) throw new Error('NO_REJECTION: no Jev rejection is recorded for exactly this plan input; submit it to jev.mjs plan first (an exception only covers an input Jev really rejected)');
  const dir = runDir(repo, run); mkdirSync(dir, { recursive: true });
  const reasonsFile = join(dir, `jev-reasons-${digest}.json`);
  writeFileSync(reasonsFile, JSON.stringify({ gate: 'plan', inputSha256: digest, verdict: rej.verdict, reasons: rej.reasons, at: rej.at }, null, 2));
  return askCard(repo, run, makeCard({ item, digest, reasons: rej.reasons || [], reasonsFile, run }), { from: 'architect', ...(now ? { now } : {}), standing: { skip: true } });
}

export function grant({ repo, run, set, input }) {
  const digest = inputDigest('plan', input);
  const rec = readSets(repo, run).find(s => s.id === set);
  if (!rec) throw new Error(`SET_UNKNOWN: ${set}`);
  if (rec.card?.questions?.[0]?.options?.some(o => o.id === 'renew')) return grantPlanBudgetRenewal(repo, run, digest, set);
  if (rec.status !== 'answered') throw new Error(`EXCEPTION_NOT_GRANTED: ${set} is ${rec.status}, not answered by the user`);
  if (!['card', 'ui', 'numbered-reply'].includes(rec.answeredVia)) throw new Error(`EXCEPTION_NOT_GRANTED: ${set} was answered via ${rec.answeredVia}; only the user's own answer counts`);
  const q = rec.card?.questions?.[0];
  if (!q || q.id !== TOPIC || rec.card.questions.length !== 1 || !q.options?.some(o => o.id === 'proceed') || q.options.some(o => o.id === 'renew')) throw new Error('EXCEPTION_NOT_GRANTED: that card is not a Jev gate exception card');
  if (!String(q.question).includes(`input ${digest}`)) throw new Error('EXCEPTION_NOT_GRANTED: the card was asked for a different plan input');
  if (rec.answers?.[TOPIC] !== 'proceed') throw new Error(`EXCEPTION_NOT_GRANTED: the answer was "${rec.answers?.[TOPIC]}", not "proceed"`);
  const reasonsFile = join(runDir(repo, run), `jev-reasons-${digest}.json`);
  const refusal = existsSync(reasonsFile) ? JSON.parse(readFileSync(reasonsFile, 'utf8')) : null;
  if (refusal?.gate !== 'plan' || refusal.verdict !== 'revise' || refusal.inputSha256 !== digest) {
    throw new Error('EXCEPTION_NOT_GRANTED: the issued card must have an exact rejected input');
  }
  const entry = { reasons: refusal.reasons, refusalAt: refusal.at, at: new Date().toISOString(), gate: 'plan', inputSha256: digest, set, answeredVia: rec.answeredVia, quote: rec.answerQuote, item: q.question.slice(0, 120) };
  mkdirSync(runDir(repo, run), { recursive: true }); appendFileSync(fileOf(repo, run), `${JSON.stringify(entry)}\n`);
  return entry;
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const repo = resolve(opt('repo') || '.'); const run = opt('run');
    const input = () => loadPacketSource('plan', JSON.parse(readFileSync(resolve(opt('input')), 'utf8')), {
      requirementsFile: opt('requirements'), requirementsSha: opt('requirements-sha256'),
    });
    if (cmd === 'card') {
      const rec = ask({ repo, run, input: input(), item: opt('item'), receipts: opt('receipts') });
      const q = rec.hostCard?.questions?.[0];
      const codeDenCard = q && { header: q.header, question: q.question, multiSelect: q.multiSelect,
        options: q.options.map(({ label, description }) => ({ label: label.replace(/(?: \(Recommended\)){2,}$/, ' (Recommended)'), description })) };
      process.stdout.write(`${JSON.stringify({ set: rec.id, status: rec.status, hostCard: rec.hostCard, codeDenCard }, null, 2)}\n`);
      process.stderr.write(`GATE_EXCEPTION: ${rec.id} asked. END THE TURN; the user answers the card. Nothing is built for this item until it is granted.\n`);
    } else if (cmd === 'grant') {
      process.stdout.write(`${JSON.stringify(grant({ repo, run, set: opt('set'), input: input() }), null, 2)}\n`);
    } else if (cmd === 'list') {
      for (const e of listExceptions(repo, run)) process.stdout.write(`${e.at} plan input ${e.inputSha256} ${e.set} (${e.answeredVia}) ${e.item}\n`);
    } else throw new Error('USAGE: card|grant|list');
  } catch (e) { process.stderr.write(`GATE_EXCEPTION: ${e.message}\n`); process.exitCode = 3; }
}
