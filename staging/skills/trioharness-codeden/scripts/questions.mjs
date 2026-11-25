#!/usr/bin/env node
// TrioHarness Lean — question cards. A blocking question is asked ONLY as a card (options + one recommended option
// per question, no free text) and STOPS the run: while a card is open, no gate advances, no worker is dispatched,
// no job is started and the run cannot finish (run-state.mjs and jobs.mjs enforce this through openQuestionsReason).
// The answer is the option id the user selected on the card; an interpreted free-text reply is not an answer.
// Honest limit: these are files an agent could edit. The gate makes skipping a card a recorded, reviewable act
// (who answered, how, quoting what), not an impossible one; the app (PandaCode cards) holds the real stop.
// Usage:
//   node questions.mjs ask    --repo . --run <id> --file <card.json> [--from <role>]   validate, record, print the host card; then END THE TURN
//   node questions.mjs render --repo . --run <id> --set Q-1   numbered-text form for a host with no card tool
//   node questions.mjs answer --repo . --run <id> --set Q-1 --answers '{"q1":"a","q2":["b","c"]}' --via card|ui|numbered-reply --quote "<what the user selected or replied>"
//   node questions.mjs check  --repo . --run <id>        exit 2 while any card is open (turn-end gate)
//   node questions.mjs list|show --repo . --run <id> [--set Q-1]
//   node questions.mjs cancel --repo . --run <id> --set Q-1 --reason "<why it is moot>" --by user|architect
// Unattended runs (a scheduler or the user writes the marker file <repo>/.trioharness-direct/UNATTENDED or
// runs/<id>/UNATTENDED): `ask` records the card as `assumed` with the recommended options and does not stop; the
// assumption must be reported in the final report and nothing irreversible may rest on it.
// Autopilot (2.36): the user asks for it in their own words (`autopilot --on --quote "<their words>"`). Then a card of
// EXECUTION questions is answered with the recommended options, recorded as `assumed` (via autopilot) and the run
// continues; a card of GATE questions (merge, deploy, production, secrets, settings, purge, roles, migrations,
// exceptions: forced by the wording whatever the Architect labels it) is recorded as `deferred`, nothing gated is done,
// and the run goes on with independent work. At the end `promote` turns every deferred gate into ONE real card and
// the run reports once. A card may not mix the two kinds in autopilot (split it).
//   node questions.mjs autopilot --repo . --run <id> --on --quote "<the user's words>" | --off | --status
//   node questions.mjs deferred  --repo . --run <id>          the gates parked so far
//   node questions.mjs promote   --repo . --run <id>          merge the deferred gates (up to 4 questions) into one open card; the answer settles each of them
// Card file: { "questions": [ { "id": "q1", "header": "Scope", "question": "…?", "multiSelect": false,
//   "options": [ { "id": "a", "label": "…", "description": "…" }, … 2–4 ], "recommended": "a" | ["a","b"], "why": "one line" } ] }
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openJobsReason } from './jobs.mjs';
import { withStateLock } from './run-state.mjs';
import { findSecrets } from './secret-patterns.mjs';
import { validRunId } from './ids.mjs';
import { loadOrders, matchCard, CATALOG, NEVER_RE } from './standing-orders.mjs';
import { isMain } from './is-main.mjs';

const dirOf = (repo, run) => join(repo, '.trioharness-direct', 'runs', run, 'questions');
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const SET_RE = /^Q-\d{1,4}$/;
const VIA = ['card', 'ui', 'numbered-reply'];
const FREE_TEXT_LABEL = /^\s*(other|something else|none of (these|the above)|custom|free[ -]?text|type (it|my own)|your own|n\/a)\b/i;

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  for (let i = 0; ; i++) { // an editor, a scanner or the UI may briefly hold the file (Windows)
    try { renameSync(tmp, file); return; } catch (e) {
      if (i < 4 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { const t = Date.now() + 50 * (i + 1); while (Date.now() < t) { /* brief wait */ } continue; }
      try { unlinkSync(tmp); } catch { /* gone */ }
      throw e;
    }
  }
}
const strings = card => card.questions.flatMap(q => [q.header, q.question, q.why, q.receipt, ...q.options.flatMap(o => [o.label, o.description])]);
const noSecrets = (text, what) => { if (findSecrets(String(text || '')).length) throw new Error(`QUESTION_SECRET: ${what} looks like it contains a secret (rule names only, text not shown); remove it`); };

// Throws QUESTION_CARD_INVALID with every problem; never echoes card text (it could be a secret).
export function validateCard(card) {
  const problems = [];
  const bad = m => problems.push(m);
  if (!card || typeof card !== 'object' || !Array.isArray(card.questions)) throw new Error('QUESTION_CARD_INVALID: {"questions":[…]} required');
  if (card.questions.length < 1 || card.questions.length > 4) bad('1 to 4 questions per card');
  const qids = new Set();
  card.questions.forEach((q, i) => {
    const at = `q[${i}]`;
    if (!q || typeof q !== 'object') { bad(`${at}: not an object`); return; }
    if (!ID_RE.test(q.id || '')) bad(`${at}: id required (letters, digits, _ -; max 24)`);
    else if (qids.has(q.id)) bad(`${at}: duplicate id`); else qids.add(q.id);
    if (typeof q.header !== 'string' || !q.header.trim() || q.header.length > 12) bad(`${at}: header 1-12 characters`);
    if (typeof q.question !== 'string' || !q.question.trim().endsWith('?') || q.question.length > 400) bad(`${at}: question must be a sentence ending in "?" (max 400)`);
    if (typeof q.why !== 'string' || q.why.trim().length < 8 || q.why.length > 300) bad(`${at}: why (the one-line reason for the recommendation) required, 8-300 characters`);
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') bad(`${at}: multiSelect must be a boolean`);
    if (q.kind !== undefined && !['execution', 'gate'].includes(q.kind)) bad(`${at}: kind must be "execution" or "gate"`);
    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length < 2 || opts.length > 4) { bad(`${at}: 2 to 4 options`); return; }
    const oids = new Set();
    opts.forEach((o, j) => {
      const oa = `${at}.options[${j}]`;
      if (!o || typeof o !== 'object') { bad(`${oa}: not an object`); return; }
      if (!ID_RE.test(o.id || '')) bad(`${oa}: id required`); else if (oids.has(o.id)) bad(`${oa}: duplicate id`); else oids.add(o.id);
      if (typeof o.label !== 'string' || !o.label.trim() || o.label.length > 60) bad(`${oa}: label 1-60 characters`);
      else if (FREE_TEXT_LABEL.test(o.label)) bad(`${oa}: a free-text style option is not allowed; cards are fixed choices only (re-frame the options)`);
      if (typeof o.description !== 'string' || o.description.trim().length < 4 || o.description.length > 240) bad(`${oa}: description (the consequence of choosing it) 4-240 characters`);
    });
    const unchecked = q.recommended === null && q.unchecked === true;
    if (q.unchecked === true && Object.hasOwn(q, 'receipt')) bad(`${at}: unchecked questions cannot carry a receipt`);
    if (q.unchecked !== undefined && (typeof q.unchecked !== 'boolean' || (q.unchecked && !unchecked))) bad(`${at}: unchecked requires recommended: null`);
    if (q.receipt !== undefined && (typeof q.receipt !== 'string' || !q.receipt.trim() || q.receipt.length > 200)) bad(`${at}: receipt must be a nonempty id, max 200 characters`);
    const rec = q.recommended === undefined ? [] : Array.isArray(q.recommended) ? q.recommended : [q.recommended];
    if (unchecked) return;
    if (!rec.length) bad(`${at}: recommended option required`);
    if (rec.some(r => !oids.has(r))) bad(`${at}: recommended must name option ids of this question`);
    if (new Set(rec).size !== rec.length) bad(`${at}: recommended lists an option twice`);
    if (!q.multiSelect && rec.length !== 1) bad(`${at}: exactly one recommended option unless multiSelect`);
    if (q.multiSelect && rec.length >= opts.length) bad(`${at}: with multiSelect, recommending every option is no recommendation`);
  });
  if (!problems.length && findSecrets(strings(card).join('\n')).length) bad('card text looks like it contains a secret (rule names only; text not shown); remove it');
  if (problems.length) throw new Error(`QUESTION_CARD_INVALID: ${problems.join('; ')}`);
  return true;
}

// The card in the shape host question tools take (Claude Code AskUserQuestion, PandaCode rich questions):
// the recommended option first, marked "(Recommended)", with the reason in its description. No free-text field.
export function hostCard(card) {
  return {
    questions: card.questions.map(q => {
      const rec = new Set(Array.isArray(q.recommended) ? q.recommended : [q.recommended]);
      const mark = o => rec.has(o.id) ? { label: `${o.label} (Recommended)`.slice(0, 80), description: `${o.description} Why: ${q.why}${q.receipt ? ` Receipt: ${q.receipt}` : ''}`, id: o.id } : { label: o.label, description: o.description, id: o.id };
      const opts = [...q.options.filter(o => rec.has(o.id)), ...q.options.filter(o => !rec.has(o.id))].map(mark);
      return { id: q.id, header: q.header, question: q.unchecked ? `${q.question}\nNot recommended (unchecked): ${q.why}` : q.question, multiSelect: !!q.multiSelect, allowFreeText: false, options: opts };
    })
  };
}

// Fallback for a host with NO card tool (plain terminal, Bambooed): the same fixed choices as numbered text. The
// reply must be option numbers; nothing else is an answer. This is still a stop, never a question-and-continue.
export function renderText(setId, card) {
  const lines = [`QUESTION CARD ${setId} — the run is stopped until you answer. Reply with the option numbers only (e.g. "1: 2, 2: 1").`];
  card.questions.forEach((q, qi) => {
    const rec = new Set(Array.isArray(q.recommended) ? q.recommended : [q.recommended]);
    lines.push('', `${qi + 1}) [${q.header}] ${q.question}${q.multiSelect ? ' (choose one or more)' : ''}`);
    q.options.forEach((o, oi) => lines.push(`   ${oi + 1}. ${o.label}${rec.has(o.id) ? `  (Recommended)${q.receipt ? ` [${q.receipt}]` : ''}` : ''} — ${o.description}`));
    lines.push(`   ${q.unchecked ? 'Not recommended (unchecked)' : 'Recommended because'}: ${q.why}`);
  });
  lines.push('', 'Waiting for your answer; nothing else is running.');
  return lines.join('\n');
}

export function readSets(repo, run) {
  const dir = dirOf(repo, run);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^Q-\d+\.json$/.test(f)).sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10)).map(f => {
    try { const r = JSON.parse(readFileSync(join(dir, f), 'utf8')); return r && typeof r === 'object' ? r : { id: f.replace('.json', ''), status: 'unreadable' }; } catch { return { id: f.replace('.json', ''), status: 'unreadable' }; }
  });
}
const CLOSED = new Set(['answered', 'cancelled', 'assumed']);
// A card is closed only by a record that says so. Anything else (damaged, empty, unknown status) is OPEN: it must never read as answered.
// `deferred` (autopilot, a gate parked for the final approval) neither blocks the run nor counts as an answer.
export const openSets = (repo, run) => readSets(repo, run).filter(s => !CLOSED.has(s.status) && s.status !== 'deferred');
export const deferredSets = (repo, run) => readSets(repo, run).filter(s => s.status === 'deferred');

// Wording that always makes a question a GATE in autopilot, whatever kind the Architect wrote: a floor, not a label.
// Whole words only, so "display the order number?" or "foreign key naming?" is a normal execution question.
export const GATE_WORDS = /\b(merge[sd]?|deploy(s|ed|ing|ment|ments)?|secrets?|credentials?|passwords?|tokens?|(api|access|private|signing|encryption|master) keys?|key ?vault|prd|prod|production|live|release[sd]?|publish(es|ed|ing)?|delete[sd]?|deletion|remove all|force[- ]push|force|spend(ing)?|payments?|billing|licen[cs]es?|subscriptions?|rotat(e|es|ed|ion)|purge[sd]?|permissions?|roles?|rulesets?|branch protection|(github|azure|repo(sitory)?|branch|security|environment) settings?|firewall|migrat(e|es|ed|ion|ions)|guard (exceptions?|allowlist)|allow-?list|secret-scan|jev|gate exceptions?|approv(e|al|als)|service ?layer|app[- ]path|hybrid connections?|customer (systems?|databases?)|(sql|database|db) writes?)\b/i;
export function questionKind(q) {
  if (q.unchecked === true && q.recommended === null) return 'gate';
  if (CATALOG[q.id]) return 'execution'; // the skill's own routine topics (running environment, superseded PRs, ...)
  if (q.kind === 'gate') return 'gate';
  const text = [q.header, q.question, ...(q.options || []).map(o => o.label)].join(' ');
  return GATE_WORDS.test(text) ? 'gate' : 'execution';
}
export function cardKind(card) {
  const kinds = new Set(card.questions.map(questionKind));
  return kinds.size > 1 ? 'mixed' : [...kinds][0];
}
const autopilotFiles = (repo, run) => [join(repo, '.trioharness-direct', 'AUTOPILOT'), join(repo, '.trioharness-direct', 'runs', run, 'AUTOPILOT')];
export const isAutopilot = (repo, run) => validRunId(run) && autopilotFiles(repo, run).some(f => existsSync(f));
export function setAutopilot(repo, run, on, { quote, now = new Date().toISOString() } = {}) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  const f = autopilotFiles(repo, run)[1];
  if (!on) { try { unlinkSync(f); } catch { /* not on */ } return { run, autopilot: isAutopilot(repo, run) }; }
  if (typeof quote !== 'string' || !quote.trim() || quote.length > 300) throw new Error('AUTOPILOT_PROVENANCE: --quote "<the user\'s own words asking for autopilot, max 300>" is required; never turn autopilot on from your own judgement');
  noSecrets(quote, '--quote');
  mkdirSync(dirname(f), { recursive: true });
  atomicWrite(f, `${JSON.stringify({ on: true, at: now, quote: quote.trim() }, null, 2)}\n`);
  return { run, autopilot: true };
}
export function openQuestionsReason(repo, run) {
  if (!validRunId(run)) return null;
  const open = openSets(repo, run);
  return open.length ? `question card(s) ${open.map(s => s.id).join(', ')} are open: the run is waiting for the user's answer (nothing may advance, be dispatched, be started or finish)` : null;
}
export const isUnattended = (repo, run) => existsSync(join(repo, '.trioharness-direct', 'UNATTENDED')) || (validRunId(run) && existsSync(join(repo, '.trioharness-direct', 'runs', run, 'UNATTENDED')));

function assertJobsSettled(repo, run) {
  const reason = openJobsReason(repo, run);
  if (reason) throw new Error(`JOBS_OPEN: ${reason}; settle them before asking (a card ends the turn)`);
}

export function askCard(repo, run, ...args) {
  return withStateLock(repo, run, () => askCardUnlocked(repo, run, ...args));
}
function askCardUnlocked(repo, run, card, { from = 'architect', now = new Date().toISOString(), standing = {} } = {}) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  validateCard(card);
  assertJobsSettled(repo, run);
  const dir = dirOf(repo, run); mkdirSync(dir, { recursive: true });
  const open = openSets(repo, run);
  if (open.length) throw new Error(`QUESTIONS_ALREADY_OPEN: ${open.map(s => s.id).join(', ')} is still waiting; one card at a time. Stop and wait for the answer.`);
  // A card made only of questions the user has already decided (standing orders) is answered from the order, recorded
  // as such, and does not stop the run. One unmatched question and the whole card is asked as usual.
  const unchecked = card.questions.some(q => q.unchecked === true);
  if (!standing.skip && !unchecked) {
    const { orders } = loadOrders(repo, { home: standing.home });
    const m = matchCard(card, orders);
    if (m) {
      for (let n = readSets(repo, run).length + 1; n < 10000; n++) {
        const id = `Q-${n}`; const file = join(dir, `${id}.json`);
        const record = { id, status: 'answered', askedAt: now, answeredAt: now, from, card, answers: m.answers, answeredVia: 'standing-order', answerQuote: `standing order ${m.applied.map(a => a.order).join(', ')}`, standingOrders: m.applied };
        try { writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
        return { ...record, hostCard: null, unattended: false, standing: true };
      }
    }
  }
  if (isAutopilot(repo, run)) {
    const kind = unchecked ? 'gate' : cardKind(card);
    if (kind === 'mixed') throw new Error('AUTOPILOT_MIXED_CARD: execution and gate questions are on one card; split them (execution questions are answered by autopilot, gates are parked for the final approval)');
    for (let n = readSets(repo, run).length + 1; n < 10000; n++) {
      const id = `Q-${n}`; const file = join(dir, `${id}.json`);
      const record = kind === 'execution'
        ? { id, status: 'assumed', askedAt: now, assumedAt: now, from, card, answers: Object.fromEntries(card.questions.map(q => [q.id, q.multiSelect ? [...q.recommended] : (Array.isArray(q.recommended) ? q.recommended[0] : q.recommended)])), answeredVia: 'autopilot', note: 'autopilot: the recommended options were taken and the run continued; list this in the final report' }
        : { id, status: 'deferred', askedAt: now, deferredAt: now, from, card, note: 'autopilot gate: nothing gated was done; it is settled by one card at the end of the run (questions.mjs promote)' };
      try { writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
      return { ...record, hostCard: null, unattended: false, autopilot: kind };
    }
  }
  const unattended = isUnattended(repo, run) && !unchecked;
  const assumed = unattended ? Object.fromEntries(card.questions.map(q => [q.id, q.multiSelect ? [...q.recommended] : (Array.isArray(q.recommended) ? q.recommended[0] : q.recommended)])) : {};
  for (let n = readSets(repo, run).length + 1; n < 10000; n++) {
    const id = `Q-${n}`; const file = join(dir, `${id}.json`);
    const record = unattended ? { id, status: 'assumed', askedAt: now, assumedAt: now, from, card, answers: assumed, note: 'unattended run: recommended options taken; report this and do nothing irreversible on it' } : { id, status: 'open', askedAt: now, from, card };
    try { writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    if (!unattended) { // two asks racing: the higher-numbered card withdraws, so at most one card is ever open
      const rival = openSets(repo, run).find(s => s.id !== id && parseInt(s.id.slice(2), 10) < n);
      if (rival) { try { unlinkSync(file); } catch { /* gone */ } throw new Error(`QUESTIONS_ALREADY_OPEN: ${rival.id} is still waiting; one card at a time. Stop and wait for the answer.`); }
    }
    return { ...record, hostCard: hostCard(card), unattended };
  }
  throw new Error('QUESTION_SETS_EXHAUSTED');
}

export function answerCard(repo, run, setId, answers, { via, quote, now = new Date().toISOString() } = {}) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  if (!SET_RE.test(setId || '')) throw new Error('SET_INVALID: Q-<n>');
  if (!VIA.includes(via)) throw new Error(`ANSWER_PROVENANCE: --via ${VIA.join('|')} is required (how the answer reached you)`);
  if (typeof quote !== 'string' || !quote.trim() || quote.length > 300) throw new Error('ANSWER_PROVENANCE: --quote "<what the user selected or replied, verbatim, max 300>" is required');
  noSecrets(quote, '--quote');
  const file = join(dirOf(repo, run), `${setId}.json`);
  if (!existsSync(file)) throw new Error(`SET_UNKNOWN: ${setId}`);
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  if (rec.status === 'assumed') throw new Error(`SET_NOT_OPEN: ${setId} was assumed (${rec.answeredVia === 'autopilot' ? 'autopilot' : 'unattended run'})`);
  if (CLOSED.has(rec.status) || !rec.card) throw new Error(`SET_NOT_OPEN: ${setId} is ${rec.status}`);
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('ANSWERS_INVALID: {"<question id>": "<option id>" | ["<option id>", …]}');
  const known = new Set(rec.card.questions.map(q => q.id));
  for (const k of Object.keys(answers)) if (!known.has(k)) throw new Error('ANSWER_UNKNOWN_QUESTION: an id that is not on the card');
  const out = {};
  for (const q of rec.card.questions) {
    if (!Object.hasOwn(answers, q.id)) throw new Error(`ANSWER_MISSING: ${q.id} (every question on the card must be answered; the card stays open)`);
    const ids = new Set(q.options.map(o => o.id));
    const a = answers[q.id];
    const list = Array.isArray(a) ? a : [a];
    if (!q.multiSelect && list.length !== 1) throw new Error(`ANSWER_INVALID: ${q.id} takes exactly one option`);
    if (q.multiSelect && !list.length) throw new Error(`ANSWER_INVALID: ${q.id} needs at least one option`);
    if (list.some(x => typeof x !== 'string' || !ids.has(x)) || new Set(list).size !== list.length) throw new Error(`ANSWER_INVALID: ${q.id} must be option id(s) of the card (free text is not an answer; ask the user to pick on the card)`);
    out[q.id] = q.multiSelect ? list : list[0];
  }
  const done = { ...rec, status: 'answered', answeredAt: now, answers: out, answeredVia: via, answerQuote: quote.trim() };
  atomicWrite(file, JSON.stringify(done, null, 2));
  // A promoted card settles the deferred gates it was built from, each with its own answers.
  for (const m of rec.merges || []) {
    const sf = join(dirOf(repo, run), `${m.set}.json`);
    if (!existsSync(sf)) continue;
    const src = JSON.parse(readFileSync(sf, 'utf8'));
    if (src.status !== 'deferred') continue;
    const mine = Object.fromEntries(m.questions.map(([orig, merged]) => [orig, out[merged]]));
    atomicWrite(sf, JSON.stringify({ ...src, status: 'answered', answeredAt: now, answers: mine, answeredVia: via, answerQuote: `${quote.trim()} (via final approval card ${setId})`, settledBy: setId }, null, 2));
  }
  return done;
}

// Turn the gates autopilot parked into ONE real card (4 questions at most; the rest wait for the next promote).
export function promoteDeferred(repo, run, ...args) {
  return withStateLock(repo, run, () => promoteDeferredUnlocked(repo, run, ...args));
}
function promoteDeferredUnlocked(repo, run, { now = new Date().toISOString() } = {}) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  const open = openSets(repo, run);
  if (open.length) throw new Error(`QUESTIONS_ALREADY_OPEN: ${open.map(s => s.id).join(', ')} is still waiting; one card at a time.`);
  const deferred = deferredSets(repo, run).filter(s => s.card);
  if (!deferred.length) return null;
  assertJobsSettled(repo, run);
  const questions = []; const merges = [];
  for (const d of deferred) {
    const take = [];
    for (const q of d.card.questions) { if (questions.length >= 4) break; const id = `${d.id.replace('-', '')}_${q.id}`.slice(0, 24); questions.push({ ...q, id }); take.push([q.id, id]); }
    if (take.length === d.card.questions.length) merges.push({ set: d.id, questions: take });
    else if (take.length) { questions.length -= take.length; break; } // never split one parked card across two final cards
    if (questions.length >= 4) break;
  }
  const card = { questions };
  validateCard(card);
  const dir = dirOf(repo, run);
  for (let n = readSets(repo, run).length + 1; n < 10000; n++) {
    const id = `Q-${n}`; const file = join(dir, `${id}.json`);
    const record = { id, status: 'open', askedAt: now, from: 'architect', card, merges, note: 'final approval: the gates parked by autopilot' };
    try { writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    return { ...record, hostCard: hostCard(card) };
  }
  throw new Error('QUESTION_SETS_EXHAUSTED');
}

// For the final report: what autopilot decided and what is still waiting.
export function autopilotReport(repo, run) {
  const sets = readSets(repo, run);
  return {
    assumed: sets.filter(s => s.status === 'assumed' && s.answeredVia === 'autopilot').map(s => ({ set: s.id, questions: s.card.questions.map(q => ({ question: q.question, took: s.answers[q.id] })) })),
    deferred: sets.filter(s => s.status === 'deferred').map(s => ({ set: s.id, questions: s.card.questions.map(q => q.question) }))
  };
}

export function cancelCard(repo, run, setId, reason, { by, now = new Date().toISOString() } = {}) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  if (!SET_RE.test(setId || '')) throw new Error('SET_INVALID: Q-<n>');
  if (!['user', 'architect'].includes(by)) throw new Error('CANCEL_PROVENANCE: --by user|architect is required (who decided the card is moot)');
  if (!reason || reason.trim().length < 8 || reason.length > 300) throw new Error('REASON_REQUIRED: 8-300 characters');
  noSecrets(reason, '--reason');
  const file = join(dirOf(repo, run), `${setId}.json`);
  if (!existsSync(file)) throw new Error(`SET_UNKNOWN: ${setId}`);
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  if (CLOSED.has(rec.status)) throw new Error(`SET_NOT_OPEN: ${setId} is ${rec.status}`);
  const done = { ...rec, status: 'cancelled', cancelledAt: now, cancelledBy: by, cancelReason: reason.trim() };
  atomicWrite(file, JSON.stringify(done, null, 2));
  return done;
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = resolve(opt('repo') || '.'); const run = opt('run');
  try {
    if (!validRunId(run)) throw new Error('RUN_ID_INVALID: --run <id> is required (letters, digits, . _ -)');
    if (cmd === 'ask') {
      if (!opt('file')) throw new Error('USAGE: ask --repo . --run <id> --file <card.json>');
      const rec = askCard(repo, run, JSON.parse(readFileSync(resolve(opt('file')), 'utf8')), { from: opt('from') || 'architect' });
      process.stdout.write(`${JSON.stringify({ set: rec.id, status: rec.status, hostCard: rec.hostCard, ...(rec.unattended || rec.standing || rec.autopilot === 'execution' ? { answers: rec.answers } : {}), ...(rec.standing ? { standingOrders: rec.standingOrders } : {}) }, null, 2)}\n`);
      if (rec.autopilot === 'execution') process.stderr.write(`QUESTIONS: ${rec.id} was answered by AUTOPILOT with the recommended options. Continue; do not stop; list it in the final report.\n`);
      else if (rec.autopilot === 'gate') process.stderr.write(`QUESTIONS: ${rec.id} is a GATE parked by autopilot. Do NOT do the gated action and do not wait: carry on with independent work; it is settled by one card at the end (questions.mjs promote).\n`);
      else if (rec.standing) process.stderr.write(`QUESTIONS: ${rec.id} was answered by standing order ${rec.standingOrders.map(a => a.order).join(', ')} (${rec.standingOrders.map(a => `${a.topic}: ${a.label}`).join('; ')}). Continue; do not ask the user; list the applied order(s) in the final report.\n`);
      else if (rec.unattended) process.stderr.write(`QUESTIONS: ${rec.id} was ASSUMED (unattended run): the recommended options are recorded. Continue, report the assumption in the final report, and do nothing irreversible on it.\n`);
      else process.stderr.write(`QUESTIONS: ${rec.id} is open. Present hostCard with the host's question-card tool (no free-text field), record the run gate as blocked, then END THIS TURN. Do nothing else, start no work and assume no answer.\n`);
    } else if (cmd === 'render') {
      const rec = readSets(repo, run).find(s => s.id === opt('set'));
      if (!rec?.card) throw new Error(`SET_UNKNOWN: ${opt('set')}`);
      process.stdout.write(`${renderText(rec.id, rec.card)}\n`);
    } else if (cmd === 'answer') {
      process.stdout.write(`${JSON.stringify(answerCard(repo, run, opt('set'), JSON.parse(opt('answers') || 'null'), { via: opt('via'), quote: opt('quote') }), null, 2)}\n`);
    } else if (cmd === 'cancel') {
      process.stdout.write(`${JSON.stringify(cancelCard(repo, run, opt('set'), opt('reason'), { by: opt('by') }), null, 2)}\n`);
    } else if (cmd === 'autopilot') {
      const on = argv.includes('--on'); const off = argv.includes('--off');
      if (!on && !off) process.stdout.write(`${JSON.stringify({ run, autopilot: isAutopilot(repo, run), ...autopilotReport(repo, run) }, null, 2)}\n`);
      else process.stdout.write(`${JSON.stringify(setAutopilot(repo, run, on, { quote: opt('quote') }), null, 2)}\n`);
    } else if (cmd === 'deferred') {
      process.stdout.write(`${JSON.stringify(deferredSets(repo, run).map(s => ({ id: s.id, questions: s.card.questions.map(q => q.question) })), null, 2)}\n`);
    } else if (cmd === 'promote') {
      const rec = promoteDeferred(repo, run);
      if (!rec) process.stdout.write(`${JSON.stringify({ run, promoted: null, note: 'no deferred gates' })}\n`);
      else { process.stdout.write(`${JSON.stringify({ set: rec.id, status: rec.status, merges: rec.merges, hostCard: rec.hostCard }, null, 2)}\n`); process.stderr.write(`QUESTIONS: ${rec.id} is the FINAL APPROVAL card. Present hostCard, then END THIS TURN with the final report.\n`); }
    } else if (cmd === 'check') {
      const open = openSets(repo, run);
      process.stdout.write(`${JSON.stringify({ run, open: open.map(s => s.id) })}\n`);
      if (open.length) { process.stderr.write(`QUESTIONS: ${open.map(s => s.id).join(', ')} still open. STOP: end the turn now; the run resumes at the recorded gate when the user answers the card.\n`); process.exitCode = 2; }
    } else if (cmd === 'list') {
      process.stdout.write(`${JSON.stringify(readSets(repo, run).map(s => ({ id: s.id, status: s.status, askedAt: s.askedAt, from: s.from, questions: s.card?.questions?.length })), null, 2)}\n`);
    } else if (cmd === 'show') {
      const sets = readSets(repo, run).filter(s => !opt('set') || s.id === opt('set'));
      process.stdout.write(`${JSON.stringify(sets, null, 2)}\n`);
    } else throw new Error('USAGE: ask|render|answer|check|list|show|cancel|autopilot|deferred|promote');
  } catch (e) { process.stderr.write(`QUESTIONS: ${e.message}\n`); process.exitCode = 3; }
}
