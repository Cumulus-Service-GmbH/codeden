import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { addOrder, removeOrder, loadOrders, matchCard, validateOrder, ORDERS_FILE } from './standing-orders.mjs';
import { askCard, readSets, openSets } from './questions.mjs';
import { buildCard } from './running-ref.mjs';

const mk = () => ({ repo: mkdtempSync(join(tmpdir(), 'thl-so-')), home: mkdtempSync(join(tmpdir(), 'thl-sohome-')) });
const card = (id, opts = ['a', 'b']) => ({ questions: [{ id, header: 'Test', question: 'Which one?', options: opts.map(o => ({ id: o, label: `Option ${o}`, description: `option ${o} text` })), recommended: opts[0], why: 'because of this' }] });

test('add validates: never for merges/deploys/secrets/prd/guard, catalog choices only, quote and reason required', () => {
  const { repo, home } = mk();
  for (const topic of ['mergepr', 'deployqa', 'secretneeded', 'prdaction', 'guardhit', 'rotatekeys']) assert.throws(() => addOrder(repo, { topic, choice: 'a', reason: 'because reasons', quote: 'always do that', home }), /never answered|STANDING_ORDER_INVALID/, topic);
  assert.throws(() => addOrder(repo, { topic: 'runningref', choice: 'c', reason: 'because reasons', quote: 'say so', home }), /not an allowed option/);
  assert.throws(() => addOrder(repo, { topic: 'runningref', choice: 'a', reason: 'short', quote: 'x', home }), /reason/);
  assert.throws(() => addOrder(repo, { topic: 'runningref', choice: 'a', reason: 'because reasons', quote: '', home }), /quote/);
  const r = addOrder(repo, { topic: 'runningref', choice: 'a', reason: 'qa stays untouched until slices merge', quote: 'base on main, leave qa alone', home });
  assert.equal(r.order.id, 'SO-1');
  const r2 = addOrder(repo, { topic: 'supersede', choice: 'a', reason: 'same pattern as S2 and S3', quote: 'new slice PR supersedes', home });
  assert.equal(r2.order.id, 'SO-2');
  assert.equal(loadOrders(repo, { home }).orders.length, 2);
  assert.equal(removeOrder(repo, { id: 'SO-1' }).removed, 'SO-1');
  assert.throws(() => removeOrder(repo, { id: 'SO-9' }), /STANDING_ORDER_UNKNOWN/);
});

test('expired and hand-edited invalid orders are ignored, and reported; repo wins over user', () => {
  const { repo, home } = mk();
  mkdirSync(join(repo, '.trioharness'), { recursive: true });
  writeFileSync(join(repo, ORDERS_FILE), JSON.stringify({ version: 1, orders: [
    { id: 'SO-1', topic: 'runningref', choice: 'a', reason: 'valid reason here', quote: 'q', expires: '2020-01-01' },
    { id: 'SO-2', topic: 'mergeall', choice: 'a', reason: 'valid reason here', quote: 'q' },
    { id: 'SO-3', topic: 'supersede', choice: 'a', reason: 'valid reason here', quote: 'q' }] }));
  const l = loadOrders(repo, { home, today: '2026-10-27' });
  assert.deepEqual(l.orders.map(o => o.id), ['SO-3']); assert.ok(l.problems.some(p => /never answered/.test(p)));
  writeFileSync(join(home, 'standing-orders.json'), JSON.stringify({ version: 1, orders: [{ id: 'SO-1', topic: 'supersede', choice: 'a', reason: 'user level order', quote: 'q' }] }));
  assert.equal(loadOrders(repo, { home }).orders.find(o => o.topic === 'supersede').scope, 'repo');
});

test('matchCard needs every question covered and the option present; multi-select and unknown topics never match', () => {
  const orders = [{ id: 'SO-1', topic: 'supersede', choice: 'a', scope: 'repo', reason: 'r' }];
  assert.ok(matchCard(card('supersede'), orders));
  assert.equal(matchCard(card('other'), orders), null);
  assert.equal(matchCard(card('supersede', ['b', 'c']), orders), null);
  const two = card('supersede'); two.questions.push(card('other').questions[0]);
  assert.equal(matchCard(two, orders), null, 'one unmatched question and the whole card is asked');
});

test('askCard answers from a standing order, records it, does not stop the run; a card with no order still opens', () => {
  const { repo, home } = mk();
  addOrder(repo, { topic: 'supersede', choice: 'a', reason: 'same pattern as S2 and S3', quote: 'new slice PR supersedes', home });
  const r = askCard(repo, 'run1', card('supersede'), { standing: { home } });
  assert.equal(r.status, 'answered'); assert.equal(r.standing, true); assert.deepEqual(r.answers, { supersede: 'a' });
  assert.equal(openSets(repo, 'run1').length, 0);
  const rec = readSets(repo, 'run1')[0];
  assert.equal(rec.answeredVia, 'standing-order'); assert.match(rec.answerQuote, /SO-1/); assert.equal(rec.standingOrders[0].topic, 'supersede');
  const open = askCard(repo, 'run1', card('somethingnew'), { standing: { home } });
  assert.equal(open.status, 'open'); assert.equal(openSets(repo, 'run1').length, 1);
  // and a user can still force a real card
  const { repo: r2, home: h2 } = mk(); addOrder(r2, { topic: 'supersede', choice: 'a', reason: 'same pattern as S2 and S3', quote: 'q', home: h2 });
  assert.equal(askCard(r2, 'run2', card('supersede'), { standing: { home: h2, skip: true } }).status, 'open');
});

test('the CLI adds and lists; merge-like topics are refused', () => {
  const { repo, home } = mk();
  const S = join(import.meta.dirname, 'standing-orders.mjs');
  const run = (...a) => execFileSync(process.execPath, [S, ...a, '--repo', repo], { encoding: 'utf8', env: { ...process.env, TRIOHARNESS_HOME: home } });
  assert.match(run('add', '--topic', 'defect', '--choice', 'b', '--reason', 'defects become blocking issues', '--quote', 'merge as-is, issue with blocking deploy'), /recorded SO-1/);
  assert.match(run('list'), /SO-1 \[repo\] defect -> b/);
  assert.throws(() => run('add', '--topic', 'mergepr', '--choice', 'a', '--reason', 'because reasons', '--quote', 'q'));
});
