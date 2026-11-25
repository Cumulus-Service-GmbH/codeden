#!/usr/bin/env node
// TrioHarness Lean — per-repo knowledge base: what earlier runs verified, so the next run does not re-investigate it.
// Lives in the repo at docs/agent-knowledge/ (INDEX.md generated; entries/<id>.md one per fact). Agents only PROPOSE;
// the user approves (PandaCode Knowledge tab, or a human terminal). Entries are never deleted: a changed fact is a new
// entry that supersedes the old one. No secrets, ever (scanned on add, approve and check; matches are never printed).
// Usage:
//   node knowledge.mjs init   --repo .
//   node knowledge.mjs find   --repo . [--files a,b] [--q "task words"] [--limit 8] [--all]      start-of-run lookup (approved only by default)
//   node knowledge.mjs add    --repo . --run <id> --title "<t>" --topic build|test|env|deploy|fix|pitfall|decision|protocol --risk low|high
//                             --symptom "<s>" [--cause "<c>"] --fix "<f>" --evidence "<proof: command output or path:line>" [--files a,b] [--verify "<cmd>"] [--author <name>]
//   node knowledge.mjs list   --repo . [--status proposed|approved|rejected|superseded]
//   node knowledge.mjs show   --repo . --id K-…
//   node knowledge.mjs confirm --repo . --id K-…                a run re-proved an approved entry: stamps last_confirmed
//   node knowledge.mjs approve|reject --repo . --id K-… --by <name> [--reason "<r>"]     HUMAN ONLY (terminal) — agents never approve
//   node knowledge.mjs supersede --repo . --id <old> --with <new> --by <name>               HUMAN ONLY
//   node knowledge.mjs reindex | verify-index | check [--base <git-ref>] --repo .
//   node knowledge.mjs gate   --repo . --run <id> [--none "<why this run learned nothing new, 20+ chars>"]   the `learnings` gate's proof
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findSecrets } from './secret-patterns.mjs';
import { validRunId } from './ids.mjs';
import { isMain } from './is-main.mjs';

export const TOPICS = ['build', 'test', 'env', 'deploy', 'fix', 'pitfall', 'decision', 'protocol'];
export const STATUSES = ['proposed', 'approved', 'rejected', 'superseded'];
export const RISKS = ['low', 'high'];
export const INDEX_MAX_LINES = 150;
const KEYS = ['id', 'title', 'topic', 'status', 'risk', 'created', 'run', 'author', 'approved_by', 'approved_at', 'last_confirmed', 'superseded_by', 'files', 'verify'];
const SECTIONS = ['Symptom', 'Cause', 'Fix', 'Evidence'];
const ID_RE = /^K-\d{8}-[a-z0-9][a-z0-9-]{0,39}(-\d{1,3})?$/;
const root = repo => join(repo, 'docs', 'agent-knowledge');
const entriesDir = repo => join(root(repo), 'entries');
const today = (now = new Date()) => now.toISOString().slice(0, 10);

export const knowledgeEnabled = repo => existsSync(root(repo));

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}
function createExclusive(file, text) { // atomic create that never replaces an existing entry
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try { linkSync(tmp, file); } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
}

// ---- format: single-line JSON-valued frontmatter, four fixed body sections --------------------------------------
export function serialize(e) {
  const fm = KEYS.map(k => `${k}: ${JSON.stringify(e[k] ?? (k === 'files' ? [] : ''))}`).join('\n');
  const body = SECTIONS.map(s => `## ${s}\n${(e[s.toLowerCase()] || '').trim()}\n`).join('\n');
  return `---\n${fm}\n---\n\n${body}`;
}
export function parse(text, file = '') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`ENTRY_FORMAT: ${file} has no frontmatter`);
  const e = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(':'); if (i < 1) throw new Error(`ENTRY_FORMAT: ${file}: bad frontmatter line`);
    const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
    try { e[k] = JSON.parse(v); } catch { throw new Error(`ENTRY_FORMAT: ${file}: value of ${k} is not JSON`); }
  }
  const parts = m[2].split(/^## (Symptom|Cause|Fix|Evidence)\s*$/m);
  for (let i = 1; i < parts.length; i += 2) e[parts[i].toLowerCase()] = (parts[i + 1] || '').trim();
  return e;
}
const fileOf = (repo, id) => join(entriesDir(repo), `${id}.md`);

export function readAll(repo) {
  const dir = entriesDir(repo);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    try { out.push({ ...parse(readFileSync(join(dir, f), 'utf8'), f), _file: f }); } catch (err) { out.push({ id: f.replace(/\.md$/, ''), _file: f, _error: err.message }); }
  }
  return out;
}
export const getEntry = (repo, id) => { if (!ID_RE.test(id || '')) throw new Error('ID_INVALID: K-YYYYMMDD-<slug>'); const f = fileOf(repo, id); if (!existsSync(f)) throw new Error(`ENTRY_UNKNOWN: ${id}`); return parse(readFileSync(f, 'utf8'), id); };

const slug = t => String(t).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'entry';
const textOf = e => [e.title, e.symptom, e.cause, e.fix, e.evidence, e.verify, e.author, e.run, e.approved_by, e.id, e.superseded_by, ...(e.files || [])].filter(x => x !== undefined && x !== null).join('\n');
const assertNoSecrets = (e, what) => { if (findSecrets(textOf(e)).length) throw new Error(`KNOWLEDGE_SECRET: ${what} looks like it contains a secret (rule names only, text not shown); remove it. Knowledge never stores secrets.`); };
const safeFiles = list => list.every(f => typeof f === 'string' && f.length && f.length <= 200 && !/^([a-z]:)?[\\/]/i.test(f) && !f.split(/[\\/]/).includes('..'));

export function init(repo) {
  mkdirSync(entriesDir(repo), { recursive: true });
  const readme = join(root(repo), 'README.md');
  if (!existsSync(readme)) writeFileSync(readme, README);
  reindex(repo);
  return { root: root(repo) };
}
const README = `# Agent knowledge

What earlier agent runs verified about this repo, so later runs do not re-investigate it.

- One file per fact in \`entries/\`, id \`K-YYYYMMDD-<slug>\`. \`INDEX.md\` is generated (approved entries only); never edit it by hand.
- Agents only **propose** entries (status \`proposed\`). A person approves or rejects them (PandaCode Knowledge tab or \`knowledge.mjs approve|reject\` in a terminal).
- Entries are never deleted. A fact that changed becomes a new entry that supersedes the old one.
- Frontmatter values are single-line JSON. Body sections: Symptom, Cause, Fix, Evidence. No secrets.
- Topics: build, test, env, deploy, fix, pitfall, decision, protocol. Risk: low or high (high = needs a human look before an agent relies on it).
`;

export function add(repo, a, now = new Date()) {
  if (!knowledgeEnabled(repo)) throw new Error('KNOWLEDGE_NOT_INITIALISED: run `knowledge.mjs init` first (user-approved)');
  const need = (k, v) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`FIELD_REQUIRED: ${k}`); return v.trim(); };
  const title = need('title', a.title); if (title.length > 100) throw new Error('FIELD_INVALID: title max 100 characters');
  if (!TOPICS.includes(a.topic)) throw new Error(`FIELD_INVALID: topic one of ${TOPICS.join(', ')}`);
  if (!RISKS.includes(a.risk)) throw new Error(`FIELD_INVALID: risk one of ${RISKS.join(', ')}`);
  if (!/^[A-Za-z0-9._-]+$/.test(a.run || '')) throw new Error('RUN_ID_INVALID');
  const files = a.files || [];
  if (!Array.isArray(files) || !safeFiles(files)) throw new Error('FIELD_INVALID: files must be repo-relative paths (no absolute paths, no ..)');
  const e = {
    id: '', title, topic: a.topic, status: 'proposed', risk: a.risk, created: today(now), run: a.run, author: (a.author || 'agent').trim().slice(0, 60),
    approved_by: '', approved_at: '', last_confirmed: '', superseded_by: '', files, verify: (a.verify || '').trim(),
    symptom: need('symptom', a.symptom), cause: (a.cause || 'not established').trim(), fix: need('fix', a.fix), evidence: need('evidence', a.evidence)
  };
  if (e.verify.length > 300) throw new Error('FIELD_INVALID: verify max 300 characters (one command)');
  assertNoSecrets(e, 'the entry');
  const live = readAll(repo).filter(x => !x._error && ['proposed', 'approved'].includes(x.status) && slug(x.title) === slug(title));
  if (live.length) throw new Error(`ENTRY_DUPLICATE: ${live[0].id} already covers "${title}" (${live[0].status}); use \`confirm\`, or propose a differently-titled entry that supersedes it`);
  const base = `K-${today(now).replace(/-/g, '')}-${slug(title)}`;
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    try { createExclusive(fileOf(repo, id), serialize({ ...e, id })); return { ...e, id }; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  throw new Error('ID_EXHAUSTED');
}

const words = s => new Set(String(s || '').toLowerCase().match(/[a-z0-9_.-]{3,}/g) || []);
export function find(repo, { files = [], q = '', limit = 8, all = false } = {}) {
  const qw = words(q); const fl = files.map(f => f.replace(/\\/g, '/'));
  const rows = readAll(repo).filter(e => !e._error && (all ? e.status !== 'superseded' && e.status !== 'rejected' : e.status === 'approved')).map(e => {
    let score = 0;
    for (const ef of e.files || []) for (const f of fl) if (f === ef || f.startsWith(ef.replace(/\/$/, '') + '/') || ef.startsWith(f.replace(/\/$/, '') + '/')) score += 5;
    const tw = words(`${e.title} ${e.symptom} ${e.fix} ${(e.files || []).join(' ')}`);
    for (const w of qw) if (tw.has(w)) score += 1;
    if (['protocol', 'env', 'build', 'test', 'deploy'].includes(e.topic) && !(e.files || []).length) score += 1; // repo-wide how-to facts
    return { id: e.id, title: e.title, topic: e.topic, risk: e.risk, status: e.status, files: e.files || [], verify: e.verify, fix: e.fix, last_confirmed: e.last_confirmed, score };
  }).filter(r => r.score > 0);
  return rows.sort((a, b) => b.score - a.score || (a.risk === 'high' ? -1 : 1) - (b.risk === 'high' ? -1 : 1) || a.id.localeCompare(b.id)).slice(0, limit);
}

export function confirm(repo, id, now = new Date()) {
  const e = getEntry(repo, id);
  if (e.status !== 'approved') throw new Error(`NOT_APPROVED: ${id} is ${e.status}; only approved entries are confirmed`);
  e.last_confirmed = today(now);
  atomicWrite(fileOf(repo, id), serialize(e));
  return e;
}

// Human gate: a person at a terminal (or the PandaCode UI, which writes the same format). A script, an agent shell or a
// pipe has no TTY, so it cannot approve. THL_KNOWLEDGE_APPROVER=human exists for the test suite and for the UI's helper.
export const humanPresent = () => process.env.THL_KNOWLEDGE_APPROVER === 'human' || (process.stdin.isTTY && process.stdout.isTTY);
function requireHuman(by) {
  if (!humanPresent()) throw new Error('HUMAN_ONLY: approving, rejecting or superseding knowledge is the user\'s decision (PandaCode Knowledge tab, or a terminal you are typing in). Agents only propose.');
  if (!by || !by.trim() || /^(agent|claude|codex|gpt|kimi|architect|writer|reviewer|bot)\b/i.test(by.trim())) throw new Error('APPROVER_REQUIRED: --by <your name>');
}
export function decide(repo, id, verdict, { by, reason = '' }, now = new Date()) {
  requireHuman(by);
  const e = getEntry(repo, id);
  if (e.status !== 'proposed') throw new Error(`NOT_PROPOSED: ${id} is ${e.status}`);
  assertNoSecrets(e, 'the entry');
  if (verdict === 'approve') Object.assign(e, { status: 'approved', approved_by: by.trim(), approved_at: now.toISOString(), last_confirmed: today(now) });
  else { Object.assign(e, { status: 'rejected', approved_by: by.trim(), approved_at: now.toISOString() }); if (reason) e.evidence = `${e.evidence}\n\nRejected: ${reason.trim().slice(0, 300)}`; }
  atomicWrite(fileOf(repo, id), serialize(e));
  reindex(repo);
  return e;
}
export function supersede(repo, oldId, newId, { by }, now = new Date()) {
  requireHuman(by);
  const o = getEntry(repo, oldId); const n = getEntry(repo, newId);
  if (o.status !== 'approved') throw new Error(`NOT_APPROVED: ${oldId} is ${o.status}`);
  if (n.status !== 'approved') throw new Error(`NOT_APPROVED: approve ${newId} first`);
  if (oldId === newId) throw new Error('SUPERSEDE_SELF');
  Object.assign(o, { status: 'superseded', superseded_by: newId });
  atomicWrite(fileOf(repo, oldId), serialize(o));
  reindex(repo);
  return o;
}

export function renderIndex(repo) {
  const rows = readAll(repo).filter(e => !e._error && e.status === 'approved').sort((a, b) => a.topic.localeCompare(b.topic) || a.id.localeCompare(b.id));
  const head = ['# Agent knowledge index — approved entries only; generated by knowledge.mjs reindex, do not edit by hand', 'Read the entry file (entries/<id>.md) before relying on it. High-risk entries: confirm with the user first.'];
  const lines = rows.map(e => `- ${e.id} [${e.topic}|${e.risk}] ${e.title}${(e.files || []).length ? ` — files: ${e.files.slice(0, 4).join(', ')}` : ''}${e.verify ? ` — verify: ${e.verify}` : ''}`);
  const out = [...head, ...lines];
  if (out.length > INDEX_MAX_LINES) throw new Error(`INDEX_TOO_LARGE: ${out.length} lines (max ${INDEX_MAX_LINES}); supersede or merge entries`);
  return `${out.join('\n')}\n`;
}
export function reindex(repo) { mkdirSync(root(repo), { recursive: true }); atomicWrite(join(root(repo), 'INDEX.md'), renderIndex(repo)); }
export function verifyIndex(repo) {
  const f = join(root(repo), 'INDEX.md');
  return existsSync(f) && readFileSync(f, 'utf8').replace(/\r\n/g, '\n') === renderIndex(repo);
}

const IMMUTABLE_AFTER_APPROVAL = ['id', 'title', 'topic', 'risk', 'created', 'run', 'author', 'approved_by', 'approved_at', 'files', 'verify', 'symptom', 'cause', 'fix', 'evidence'];
export function check(repo, { base = null } = {}) {
  const problems = [];
  if (!knowledgeEnabled(repo)) return { ok: true, enabled: false, problems };
  const all = readAll(repo);
  for (const e of all) {
    const at = e._file;
    if (e._error) { problems.push(`${at}: ${e._error}`); continue; }
    if (!ID_RE.test(e.id || '') || `${e.id}.md` !== at) problems.push(`${at}: id does not match the file name`);
    for (const k of KEYS) if (!(k in e)) problems.push(`${at}: missing ${k}`);
    if (!STATUSES.includes(e.status)) problems.push(`${at}: bad status`);
    if (!TOPICS.includes(e.topic)) problems.push(`${at}: bad topic`);
    if (!RISKS.includes(e.risk)) problems.push(`${at}: bad risk`);
    if (!Array.isArray(e.files) || !safeFiles(e.files)) problems.push(`${at}: files must be repo-relative paths`);
    for (const s of ['symptom', 'fix', 'evidence']) if (!e[s]) problems.push(`${at}: empty ${s}`);
    if (['approved', 'rejected'].includes(e.status) && (!e.approved_by || !e.approved_at)) problems.push(`${at}: ${e.status} without approved_by/approved_at (agents only propose)`);
    if (e.status === 'proposed' && (e.approved_by || e.approved_at)) problems.push(`${at}: proposed entry carries an approval`);
    if (e.status === 'superseded' && !e.superseded_by) problems.push(`${at}: superseded without superseded_by`);
    if (findSecrets(textOf(e)).length) problems.push(`${at}: looks like it contains a secret (text not shown)`);
  }
  const ids = new Set(all.map(e => e.id));
  for (const e of all) if (e.superseded_by && !ids.has(e.superseded_by)) problems.push(`${e._file}: superseded_by ${e.superseded_by} does not exist`);
  try { if (!verifyIndex(repo)) problems.push('INDEX.md is out of date (run reindex)'); } catch (err) { problems.push(err.message); }
  if (base) { // history rule: an entry approved at <base> may only be confirmed or superseded, never rewritten, never deleted
    let names = [];
    try { names = execFileSync('git', ['-C', repo, 'ls-tree', '--name-only', base, 'docs/agent-knowledge/entries/'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { problems.push(`--base ${base} could not be read`); }
    for (const n of names) {
      let old; try { old = parse(execFileSync('git', ['-C', repo, 'show', `${base}:${n}`], { encoding: 'utf8' }), n); } catch { continue; }
      if (old.status === 'proposed') continue;
      const cur = all.find(e => e._file === n.split('/').pop());
      if (!cur) { problems.push(`${n}: entry existed at ${base} and was deleted (entries are never deleted)`); continue; }
      if (cur._error) continue;
      if (old.status === 'approved') for (const k of IMMUTABLE_AFTER_APPROVAL) if (JSON.stringify(old[k]) !== JSON.stringify(cur[k])) problems.push(`${n}: approved entry changed ${k} (supersede it with a new entry instead)`);
      if (['rejected', 'superseded'].includes(old.status) && old.status !== cur.status) problems.push(`${n}: ${old.status} entry changed status`);
    }
  }
  return { ok: !problems.length, enabled: true, problems, entries: all.length };
}

// The proof the `learnings` gate needs: at least one entry written by this run, or a justified "nothing new".
export function recordLearnings(repo, run, { none = '' } = {}, now = new Date().toISOString()) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  const mine = knowledgeEnabled(repo) ? readAll(repo).filter(e => !e._error && e.run === run).map(e => e.id) : [];
  if (!mine.length && (!none || none.trim().length < 20)) throw new Error('LEARNINGS_NOT_RECORDED: propose at least one entry (knowledge.mjs add) or pass --none "<why nothing new was learned, 20+ characters>"');
  if (none && findSecrets(none).length) throw new Error('KNOWLEDGE_SECRET: --none text looks like it contains a secret');
  const dir = join(repo, '.trioharness-direct', 'runs', run); mkdirSync(dir, { recursive: true });
  const rec = { at: now, entries: mine, ...(mine.length ? {} : { none: none.trim() }) };
  atomicWrite(join(dir, 'learnings.json'), JSON.stringify(rec, null, 2));
  return rec;
}
// Used by run-state: in a repo that keeps knowledge, the learnings gate cannot pass without that proof.
export function learningsReason(repo, run) {
  if (!knowledgeEnabled(repo)) return null;
  const f = join(repo, '.trioharness-direct', 'runs', run, 'learnings.json');
  return existsSync(f) ? null : 'this repo keeps agent knowledge: run `knowledge.mjs gate --run <id>` (entries proposed, or --none "<reason>") before the learnings gate';
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const list = v => v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
  const repo = resolve(opt('repo') || '.');
  const out = v => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  try {
    if (cmd === 'init') out(init(repo));
    else if (cmd === 'find') out(find(repo, { files: list(opt('files')), q: opt('q') || '', limit: Number(opt('limit') || 8), all: argv.includes('--all') }));
    else if (cmd === 'add') out(add(repo, { run: opt('run'), title: opt('title'), topic: opt('topic'), risk: opt('risk'), symptom: opt('symptom'), cause: opt('cause'), fix: opt('fix'), evidence: opt('evidence'), files: list(opt('files')), verify: opt('verify'), author: opt('author') }));
    else if (cmd === 'list') out(readAll(repo).filter(e => !opt('status') || e.status === opt('status')).map(e => ({ id: e.id, status: e.status, topic: e.topic, risk: e.risk, title: e.title, error: e._error })));
    else if (cmd === 'show') out(getEntry(repo, opt('id')));
    else if (cmd === 'confirm') out(confirm(repo, opt('id')));
    else if (cmd === 'approve' || cmd === 'reject') out(decide(repo, opt('id'), cmd, { by: opt('by'), reason: opt('reason') }));
    else if (cmd === 'supersede') out(supersede(repo, opt('id'), opt('with'), { by: opt('by') }));
    else if (cmd === 'reindex') { reindex(repo); out({ ok: true }); }
    else if (cmd === 'verify-index') { const ok = verifyIndex(repo); out({ ok }); if (!ok) process.exitCode = 1; }
    else if (cmd === 'check') { const r = check(repo, { base: opt('base') || null }); out(r); if (!r.ok) process.exitCode = 1; }
    else if (cmd === 'gate') out(recordLearnings(repo, opt('run'), { none: opt('none') || '' }));
    else throw new Error('USAGE: init|find|add|list|show|confirm|approve|reject|supersede|reindex|verify-index|check|gate');
  } catch (e) { process.stderr.write(`KNOWLEDGE: ${e.message}\n`); process.exitCode = 3; }
}
