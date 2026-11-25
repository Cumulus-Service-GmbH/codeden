#!/usr/bin/env node
// TrioHarness Lean — standing orders: decisions the user has already made, recorded once, applied without a card.
// A standing order answers ONE kind of question card (by its question id, the "topic") with ONE option id. It is
// applied only when a card is made of questions that ALL have an order; the card is then recorded as answered
// (via "standing-order", quoting the order id and reason) and the run continues. The decision stays visible: the set
// record names the order, and the final report lists every order that was applied.
// Never automatic, whatever is recorded: merges, deploys, secrets, production actions, deletions, force operations,
// guard-hit exceptions, spending. Those topics are refused when an order is added and ignored when one is found.
// Orders live in two files: <repo>/.trioharness/standing-orders.json (committed with the repo, reviewed like code, so
// adding one is a normal pull request) and the user-level ~/.config/trioharness/standing-orders.json (all repos).
// Usage:
//   node standing-orders.mjs list  --repo .
//   node standing-orders.mjs add   --repo . --topic runningref --choice a --reason "<why>" --quote "<the user's words, verbatim>" [--scope repo|user] [--expires 2027-01-31]
//   node standing-orders.mjs remove --repo . --id SO-1 [--scope repo|user]
//   node standing-orders.mjs match --repo . --file <card.json>      prints which questions an order would answer
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findSecrets } from './secret-patterns.mjs';
import { isMain } from './is-main.mjs';

export const ORDERS_FILE = '.trioharness/standing-orders.json';
export const TOPIC_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const ID_RE = /^SO-\d{1,4}$/;
// Substring test on the topic: anything that smells like these is never answered by an order.
export const NEVER_RE = /merge|deploy|secret|prd|prod|delete|remove|force|spend|pay|guard|allow|rotate|credential|password|token|key|jev|exception|gate/i;
// Topics the skill builds itself, with the option ids an order may pick.
export const CATALOG = {
  runningref: { a: 'base on main, leave the environment alone' },
  supersede: { a: 'the new slice PR supersedes the older PRs' },
  closesuper: { a: 'close the superseded PR with a comment linking the new one' },
  defect: { a: 'fix the defect inside the slice', b: 'merge as-is and file a blocking-deploy issue' },
  skips: { a: 'accept the recorded skipped tests as exceptions' }
};

export const userFile = (home = process.env.TRIOHARNESS_HOME || join(homedir(), '.config', 'trioharness')) => join(home, 'standing-orders.json');
const repoFile = repo => join(repo, ORDERS_FILE);

function read(file) {
  if (!existsSync(file)) return { version: 1, orders: [] };
  let j; try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`STANDING_ORDERS_INVALID: ${file} is not valid JSON`); }
  if (!j || j.version !== 1 || !Array.isArray(j.orders)) throw new Error(`STANDING_ORDERS_INVALID: ${file} must be {"version":1,"orders":[…]}`);
  return j;
}
function write(file, doc) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`); renameSync(tmp, file);
}

export function validateOrder(o) {
  const errors = [];
  if (!o || typeof o !== 'object') return ['order must be an object'];
  if (!ID_RE.test(o.id || '')) errors.push('id must look like SO-1');
  if (!TOPIC_RE.test(o.topic || '')) errors.push('topic: lowercase letters, digits, _ -, max 24');
  else if (NEVER_RE.test(o.topic)) errors.push(`topic "${o.topic}" is never answered by a standing order (merges, deploys, secrets, production, deletions, guard exceptions, spending)`);
  if (typeof o.choice !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(o.choice)) errors.push('choice: an option id');
  else if (CATALOG[o.topic] && !CATALOG[o.topic][o.choice]) errors.push(`choice "${o.choice}" is not an allowed option for ${o.topic} (allowed: ${Object.keys(CATALOG[o.topic]).join(', ')})`);
  if (typeof o.reason !== 'string' || o.reason.trim().length < 8 || o.reason.length > 300) errors.push('reason: 8-300 characters');
  if (typeof o.quote !== 'string' || !o.quote.trim() || o.quote.length > 300) errors.push('quote: the user\'s own words, verbatim, max 300');
  if (o.expires !== undefined && (typeof o.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.expires))) errors.push('expires: YYYY-MM-DD');
  if (findSecrets(`${o.reason} ${o.quote}`).length) errors.push('reason/quote look like they contain a secret');
  return errors;
}

// All valid, unexpired orders from the repo file and the user file; the repo file wins on a topic clash.
export function loadOrders(repo, { home, today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = new Map(); const problems = [];
  for (const [scope, file] of [['user', userFile(home)], ['repo', repoFile(repo)]]) {
    let doc; try { doc = read(file); } catch (e) { problems.push(e.message); continue; }
    for (const o of doc.orders) {
      const errs = validateOrder(o);
      if (errs.length) { problems.push(`${scope} ${o?.id || '?'}: ${errs.join('; ')}`); continue; }
      if (o.expires && o.expires < today) continue;
      out.set(o.topic, { ...o, scope });
    }
  }
  return { orders: [...out.values()], problems };
}

// For a card: { answers, applied } when EVERY question has an order whose option exists on the card; else null.
export function matchCard(card, orders) {
  if (!card?.questions?.length || !orders?.length) return null;
  const byTopic = new Map(orders.map(o => [o.topic, o]));
  const answers = {}, applied = [];
  for (const q of card.questions) {
    const o = byTopic.get(q.id);
    if (!o || q.multiSelect || !q.options.some(x => x.id === o.choice)) return null;
    answers[q.id] = o.choice;
    applied.push({ order: o.id, scope: o.scope, topic: o.topic, choice: o.choice, label: q.options.find(x => x.id === o.choice).label, reason: o.reason });
  }
  return { answers, applied };
}

export function addOrder(repo, { topic, choice, reason, quote, scope = 'repo', expires, home }) {
  if (!['repo', 'user'].includes(scope)) throw new Error('scope: repo|user');
  const file = scope === 'user' ? userFile(home) : repoFile(repo);
  const doc = read(file);
  const n = doc.orders.reduce((m, o) => Math.max(m, parseInt(String(o.id).slice(3), 10) || 0), 0) + 1;
  const order = { id: `SO-${n}`, topic, choice, reason, quote, ...(expires ? { expires } : {}), recordedAt: new Date().toISOString().slice(0, 10) };
  const errs = validateOrder(order);
  if (errs.length) throw new Error(`STANDING_ORDER_INVALID: ${errs.join('; ')}`);
  doc.orders = doc.orders.filter(o => o.topic !== topic); doc.orders.push(order);
  write(file, doc);
  return { order, file, scope };
}
export function removeOrder(repo, { id, scope = 'repo', home }) {
  const file = scope === 'user' ? userFile(home) : repoFile(repo);
  const doc = read(file); const before = doc.orders.length;
  doc.orders = doc.orders.filter(o => o.id !== id);
  if (doc.orders.length === before) throw new Error(`STANDING_ORDER_UNKNOWN: ${id} in the ${scope} file`);
  write(file, doc); return { removed: id, file };
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = resolve(opt('repo') || '.');
  try {
    if (cmd === 'list') {
      const { orders, problems } = loadOrders(repo);
      for (const o of orders) process.stdout.write(`${o.id} [${o.scope}] ${o.topic} -> ${o.choice}  ${o.reason}${o.expires ? `  (until ${o.expires})` : ''}\n`);
      if (!orders.length) process.stdout.write('no standing orders\n');
      for (const p of problems) process.stderr.write(`STANDING_ORDERS: ignored: ${p}\n`);
    } else if (cmd === 'add') {
      const r = addOrder(repo, { topic: opt('topic'), choice: opt('choice'), reason: opt('reason'), quote: opt('quote'), scope: opt('scope') || 'repo', expires: opt('expires') });
      process.stdout.write(`recorded ${r.order.id} (${r.scope}): ${r.order.topic} -> ${r.order.choice} in ${r.file}${r.scope === 'repo' ? '; commit it through a pull request like any change under .trioharness/' : ''}\n`);
    } else if (cmd === 'remove') {
      process.stdout.write(`${JSON.stringify(removeOrder(repo, { id: opt('id'), scope: opt('scope') || 'repo' }))}\n`);
    } else if (cmd === 'match') {
      const m = matchCard(JSON.parse(readFileSync(resolve(opt('file')), 'utf8')), loadOrders(repo).orders);
      process.stdout.write(`${JSON.stringify(m || { answers: null }, null, 2)}\n`);
    } else throw new Error('USAGE: list|add|remove|match');
  } catch (e) { process.stderr.write(`STANDING_ORDERS: ${e.message}\n`); process.exitCode = 3; }
}
