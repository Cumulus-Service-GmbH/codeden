#!/usr/bin/env node
// TrioHarness Lean — per-repository secrets, used on demand and never printed.
//
// Two layers, one command:
//   LEGACY (no manifest): each repository has ONE git-ignored secrets file (default <repo>/.env). The repo
//   AGENTS.md lists the secret NAMES the harness needs; values live only in that file. A missing name is
//   SEEDED as `NAME=`, the run stops with exit 2, and the user fills the file. Mode 0600, never tracked.
//   MANIFEST (`.trioharness/secrets.json`, names and rules, never values): each secret declares where it
//   lives (macOS Keychain, Azure Key Vault, or the file), which scopes may use it and whether a worker may.
//   - You type a value ONCE into a masked dialog (`set`); it goes straight into the Keychain, never through
//     chat, argv, a file or a packet, and is reused by every later run (no asking again).
//   - A value is handed only to the environment of ONE child command (`require … -- <cmd>`), the child's
//     output is scrubbed of every form of it, and each use leaves an audit line without a value.
//   - A secret that is not set stops the run with a question card (`card`); `set` is the answer.
//
// Usage (repo defaults to .):
//   node secrets.mjs check   --repo <repo> --need NAME[,NAME…] [--file .env]        0 all present | 2 missing
//   node secrets.mjs require --repo <repo> --need NAME[,NAME…] [--scope proof] [--role architect|worker] [--run <id>] -- <command …>
//   node secrets.mjs list    --repo <repo> [--file .env]                             legacy file: names and set/empty
//   node secrets.mjs seed    --repo <repo> --need NAME[,NAME…] [--file .env]         legacy file: add names
//   node secrets.mjs declare --repo <repo> --name N --purpose "…" [--env dev|qa|prd] [--store auto|keychain|file|keyvault]
//                            [--keyvault <vault>/<secret>] [--scopes proof,deploy-qa] [--delegate none|architect|worker] [--required true|false] [--rotate-days N]
//   node secrets.mjs import-names --repo <repo>                                      declare the names listed under "## Secrets" in AGENTS.md
//   node secrets.mjs status  --repo <repo> [--check] [--strict] [--json]             set / not set per name, rotation due; never values
//   node secrets.mjs set     --repo <repo> --name N [--stdin]                        masked dialog (or stdin) → Keychain
//   node secrets.mjs forget  --repo <repo> --name N                                  remove from the Keychain
//   node secrets.mjs migrate --repo <repo> [--clear]                                 move values from the file into the Keychain
//   node secrets.mjs card    --repo <repo> --need NAME[,NAME…]                       the question card to ask when a secret is missing
//   node secrets.mjs audit   --repo <repo> [--tail 20]                               who used what, when (no values)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scrubEnv } from './secret-patterns.mjs';
import { lockNameFor, release, tryAcquire } from './run-lock.mjs';
import {
  NAME_RE, MANIFEST_FILE, MIN_VALUE_LENGTH, loadManifest, writeManifest, repoSlugOf, serviceFor, keychainBackend, keyvaultBackend,
  hiddenPrompt, validateValue, scrubOutput, commandRefusal, auditAppend, auditTail
} from './secret-store.mjs';
import { validateCard } from './questions.mjs';
import { isMain } from './is-main.mjs';
export const promptLabel = (name, slug) => `Enter ${name} for ${slug} (stored in the macOS Keychain, reused by every run)`;

export { NAME_RE };
export const DEFAULT_FILE = '.env';

// Parse dotenv-style text: KEY=value, optional quotes, # comments, `export ` prefix. Values are returned
// but callers must never print them; `empty` names are seeded placeholders waiting for the user.
export function parseEnv(text) {
  const values = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else { const hash = v.indexOf(' #'); if (hash >= 0) v = v.slice(0, hash).trim(); }
    values.set(m[1], v);
  }
  return values;
}

// Pure: which needed names are present (non-empty, from env or file), empty (seeded, unfilled), absent.
export function classifyNeeds(need, fileValues, env = {}) {
  const present = [], empty = [], absent = [], invalid = [];
  for (const n of need) {
    if (!NAME_RE.test(n)) { invalid.push(n); continue; }
    if (env[n] && String(env[n]).length) { present.push(n); continue; }
    if (!fileValues.has(n)) absent.push(n);
    else if (!String(fileValues.get(n)).length) empty.push(n);
    else present.push(n);
  }
  return { present, empty, absent, invalid };
}

// Mask anything that could be a value in text destined for stdout/stderr/ledger.
export function mask(text, values) {
  let out = String(text);
  for (const v of values) if (v && v.length >= 4) out = out.split(v).join('<secret>');
  return out;
}

export function isIgnored(repo, file) {
  const rel = relative(repo, file).replace(/\\/g, '/');
  try { execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--', rel], { stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch { return false; }
}
export function isTracked(repo, file) {
  const rel = relative(repo, file).replace(/\\/g, '/');
  try { return execFileSync('git', ['-C', repo, 'ls-files', '--', rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().length > 0; } catch { return false; }
}

// Make sure the secrets file can never be committed: tracked → refuse; not ignored → add to .git/info/exclude.
export function ensureSafeFile(repo, file) {
  if (isTracked(repo, file)) throw new Error(`SECRETS_FILE_TRACKED: ${relative(repo, file)} is tracked by git — untrack it (git rm --cached) before the harness will touch it`);
  if (!isIgnored(repo, file)) {
    try {
      const common = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const exclude = join(common, 'info', 'exclude');
      const rel = relative(repo, file).replace(/\\/g, '/');
      const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (!cur.split(/\r?\n/).includes(rel)) appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}${rel}\n`);
    } catch (e) { throw new Error(`SECRETS_FILE_NOT_IGNORED: ${relative(repo, file)} is not git-ignored and the exclude file could not be written (${String(e.message).split('\n')[0]})`); }
    if (!isIgnored(repo, file)) throw new Error(`SECRETS_FILE_NOT_IGNORED: ${relative(repo, file)} is still not ignored by git`);
  }
}

export function readFile(file) {
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8');
}

// Append `NAME=` lines for names the file does not carry. Names only. Creates the file with mode 0600.
export function seed(file, names) {
  // Append-only, under a lock named after the file so two parallel runs cannot lose each other's names.
  // Multi-line quoted values are refused: this file is line-based by contract.
  let held = null;
  try { held = tryAcquire(`secrets-${lockNameFor(file)}`.slice(0, 120), { note: 'secrets seed' }); } catch { held = null; }
  try {
    const text = readFile(file);
    if (/=\s*"[^"\n]*$/m.test(text) && !/=\s*"[^"\n]*"\s*$/m.test(text)) throw new Error('SECRETS_VALUE_MULTILINE: a quoted value spans lines; keep one value per line (base64-encode PEM material)');
    const have = parseEnv(text);
    const add = names.filter(n => !have.has(n));
    if (!add.length) return [];
    const created = !existsSync(file);
    const lines = add.map(n => `${n}=`).join('\n');
    const mode = created ? 0o600 : undefined;
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${created ? '# TrioHarness Lean secrets — fill the empty values; this file is git-ignored and never printed\n' : ''}${lines}\n`, mode ? { mode } : undefined);
    if (created) { try { chmodSync(file, 0o600); } catch { /* Windows */ } }
    return add;
  } finally { if (held?.acquired) release(held.file); }
}

export function resolveFile(repo, file) {
  const f = file || DEFAULT_FILE;
  return isAbsolute(f) ? f : join(repo, f);
}

// Check needs; seed what is missing; return the report (names only). Never returns values.
export function check(repo, need, { file, env = process.env } = {}) {
  const path = resolveFile(repo, file);
  ensureSafeFile(repo, path);
  const values = parseEnv(readFile(path));
  const c = classifyNeeds(need, values, env);
  if (c.invalid.length) throw new Error(`SECRET_NAME_INVALID: ${c.invalid.join(', ')} — names are UPPER_SNAKE_CASE`);
  const seeded = seed(path, [...c.absent]);
  const missing = [...c.absent, ...c.empty];
  return { file: path, present: c.present, missing, seeded, ok: missing.length === 0 };
}


// ---------------------------------------------------------------- manifest mode

export const ROLES = ['architect', 'worker'];
export const effectiveStores = (entry, platform = process.platform) => entry.store === 'auto' ? (platform === 'darwin' ? ['keychain', 'file'] : ['file']) : [entry.store];

// Who may use a declared secret, for which scope. A guard rail for the Architect's own calls (the role is
// what the caller says it is); the hard limits are in the manifest rules and in SKILL.md.
export function accessRefusal(entry, { scope, role }) {
  if (entry.delegate === 'none') return `SECRET_NOT_DELEGABLE: ${entry.name} is user-only (delegate: none); an agent may not use it`;
  if (role === 'worker' && entry.delegate !== 'worker') return `SECRET_NOT_FOR_WORKERS: ${entry.name} is declared for the ${entry.delegate} only`;
  if (!entry.scopes.includes(scope)) return `SECRET_SCOPE: ${entry.name} is not allowed for scope "${scope}" (declared: ${entry.scopes.join(', ')})`;
  return null;
}

// Where a declared value comes from: the process environment (CI) first, then the declared store(s).
export function resolveSecret(entry, ctx) {
  const env = ctx.env || {};
  if (env[entry.name]) return { value: String(env[entry.name]), from: 'env' };
  for (const src of effectiveStores(entry, ctx.platform)) {
    if (src === 'keyvault') { const v = ctx.kv.get(entry.keyvault); if (v) return { value: v, from: 'keyvault' }; }
    else if (src === 'keychain') {
      if (!ctx.kc.available()) { if (entry.store === 'keychain') throw new Error(`KEYCHAIN_UNAVAILABLE: ${entry.name} is declared for the Keychain, which needs macOS`); continue; }
      const v = ctx.kc.get(ctx.service, entry.name); if (v) return { value: v, from: 'keychain' };
    } else { const v = ctx.fileValues.get(entry.name); if (v) return { value: v, from: 'file' }; }
  }
  return null;
}

const daysSince = iso => iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null;

// Never reads a value for display: existence and modification time only (Keychain info, file presence).
export function secretState(entry, ctx, { check = false } = {}) {
  const row = { name: entry.name, env: entry.env, store: entry.store, scopes: entry.scopes, delegate: entry.delegate, required: entry.required, state: 'not set', source: null, modified: null, rotationDue: false };
  if (ctx.env?.[entry.name]) { row.state = 'set'; row.source = 'env'; return row; }
  for (const src of effectiveStores(entry, ctx.platform)) {
    if (src === 'keychain' && ctx.kc.available()) {
      const info = ctx.kc.info(ctx.service, entry.name);
      if (info.exists) { row.state = 'set'; row.source = 'keychain'; row.modified = info.modified; break; }
    } else if (src === 'file') {
      if (ctx.fileValues.get(entry.name)) { row.state = 'set'; row.source = 'file'; break; }
    } else if (src === 'keyvault') {
      if (!check) { row.state = 'in Key Vault (checked when used)'; row.source = 'keyvault'; break; }
      try { if (ctx.kv.get(entry.keyvault)) { row.state = 'set'; row.source = 'keyvault'; } else row.state = 'empty in Key Vault'; } catch { row.state = 'not readable with the current az login'; }
      break;
    }
  }
  if (entry.rotateDays && row.modified && daysSince(row.modified) > entry.rotateDays) row.rotationDue = true;
  return row;
}

// Blank the value of NAME in a dotenv-style file, keeping every other line. Names only in the report.
export function blankValues(file, names) {
  const text = readFile(file);
  const set = new Set(names);
  const changed = [];
  const lines = text.split('\n').map(l => {
    const m = l.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m && set.has(m[2]) && m[3].trim().length) { changed.push(m[2]); return `${m[1]}${m[2]}=`; }
    return l;
  });
  if (changed.length) writeFileSync(file, lines.join('\n'));
  return changed;
}

// "## Secrets" bullets of AGENTS.md → [{name, purpose}]
export function namesFromAgents(text) {
  const m = String(text || '').match(/^##\s+Secrets\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  if (!m) return [];
  const out = [];
  for (const l of m[1].split('\n')) {
    const b = l.match(/^\s*[-*]\s+`?([A-Z][A-Z0-9_]{0,80})`?\s*(?:[—–:-]+\s*(.+))?$/);
    if (b) out.push({ name: b[1], purpose: (b[2] || 'declared from AGENTS.md').replace(/`/g, '').trim().slice(0, 200) });
  }
  return out;
}

export function secretCard(slug, names) {
  const list = names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : '');
  const card = { questions: [{
    id: 'secretneeded', header: 'Secret', multiSelect: false,
    question: `${list} ${names.length === 1 ? 'is' : 'are'} not set for ${slug}. A masked dialog opens on your Mac and the value goes straight into the Keychain, never through chat. How should the run continue?`.slice(0, 399).replace(/[.?!]*$/, '') + '?',
    options: [
      { id: 'a', label: 'Set now', description: 'A masked dialog opens on your Mac for each missing value. It is kept and reused by every later run.' },
      { id: 'b', label: 'Skip it for this task', description: 'The task continues without it; anything that needs it is reported as not run, never as passed.' },
      { id: 'c', label: 'Stop the run', description: 'Nothing continues until the secret is set; resume in a new task.' }
    ],
    recommended: 'a',
    why: 'Set once, kept in the Keychain and never asked for again.'
  }] };
  validateCard(card);
  return card;
}

function makeCtx(repo, deps, opt) {
  const platform = deps.platform || process.platform;
  const file = resolveFile(repo, opt('file'));
  if (existsSync(file)) ensureSafeFile(repo, file);
  return {
    repo, platform, file, env: deps.env || process.env,
    kc: deps.kc || keychainBackend({ platform }), kv: deps.kv || keyvaultBackend({ platform }),
    service: serviceFor(repoSlugOf(repo)), slug: repoSlugOf(repo), fileValues: parseEnv(readFile(file))
  };
}

// ---------------------------------------------------------------- command line

export function runCli(argv, io, deps = {}) {
  const [cmd, ...rest] = argv;
  const dash = rest.indexOf('--');
  const args = dash >= 0 ? rest.slice(0, dash) : rest;
  const command = dash >= 0 ? rest.slice(dash + 1) : [];
  const opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const flag = n => args.includes(`--${n}`);
  const repo = resolve(opt('repo') || '.');
  const need = (opt('need') || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = t => io.stdout(t), err = t => io.stderr(t);
  try {
    if (cmd === 'list') {
      const path = resolveFile(repo, opt('file'));
      const values = parseEnv(readFile(path));
      for (const [k, v] of values) out(`${k}: ${v.length ? 'set' : 'EMPTY'}\n`);
      out(`${values.size} name(s) in ${relative(repo, path)}; values never shown\n`);
      return 0;
    }
    if (cmd === 'seed') {
      if (!need.length) throw new Error('USAGE: seed --need NAME[,NAME…]');
      const path = resolveFile(repo, opt('file'));
      ensureSafeFile(repo, path);
      const added = seed(path, need.filter(n => NAME_RE.test(n)));
      out(`seeded ${added.length} name(s) into ${relative(repo, path)}: ${added.join(', ') || '(none new)'}\n`);
      return 0;
    }
    if (cmd === 'check' || cmd === 'require') {
      if (!need.length) throw new Error(`USAGE: ${cmd} --need NAME[,NAME…]${cmd === 'require' ? ' -- <command>' : ''}`);
      const manifest = loadManifest(repo);
      if (manifest.exists) return manifestUse(cmd);
      return legacyUse(cmd);
    }
    if (cmd === 'declare') {
      const name = opt('name');
      if (!name || !opt('purpose')) throw new Error('USAGE: declare --name NAME --purpose "…" [--env] [--store] [--keyvault vault/secret] [--scopes a,b] [--delegate] [--required] [--rotate-days N]');
      const manifest = loadManifest(repo);
      const entries = new Map(manifest.secrets);
      const kv = opt('keyvault');
      const entry = {
        name, purpose: opt('purpose'), env: opt('env') || entries.get(name)?.env || 'dev',
        store: opt('store') || (kv ? 'keyvault' : entries.get(name)?.store || 'auto'),
        keyvault: kv ? { vault: kv.split('/')[0], secret: kv.split('/').slice(1).join('/') } : (entries.get(name)?.keyvault || null),
        scopes: opt('scopes') ? opt('scopes').split(',').map(s => s.trim()).filter(Boolean) : (entries.get(name)?.scopes || ['proof']),
        delegate: opt('delegate') || entries.get(name)?.delegate || 'architect',
        required: opt('required') !== undefined ? opt('required') !== 'false' : (entries.get(name)?.required ?? true),
        rotateDays: opt('rotate-days') ? +opt('rotate-days') : entries.get(name)?.rotateDays
      };
      if (entry.store !== 'keyvault') entry.keyvault = null;
      entries.set(name, entry);
      writeManifest(repo, entries);
      out(`declared ${name} (${entry.env}, ${entry.store}) in ${MANIFEST_FILE}\n`);
      return 0;
    }
    if (cmd === 'import-names') {
      const agents = join(repo, 'AGENTS.md');
      if (!existsSync(agents)) throw new Error('AGENTS.md not found');
      const found = namesFromAgents(readFileSync(agents, 'utf8'));
      if (!found.length) throw new Error('no secret names under "## Secrets" in AGENTS.md (bullets like "- NAME — purpose")');
      const manifest = loadManifest(repo);
      const entries = new Map(manifest.secrets);
      const added = [];
      for (const f of found) if (!entries.has(f.name)) { entries.set(f.name, { name: f.name, purpose: f.purpose, env: 'dev', store: 'auto', keyvault: null, scopes: ['proof'], delegate: 'architect', required: true }); added.push(f.name); }
      if (added.length) writeManifest(repo, entries);
      out(`declared ${added.length} name(s) from AGENTS.md: ${added.join(', ') || '(none new)'}\n`);
      return 0;
    }
    if (cmd === 'status') {
      const manifest = loadManifest(repo);
      if (!manifest.exists) throw new Error(`no ${MANIFEST_FILE}: declare the repository's secrets first (declare, or import-names from AGENTS.md)`);
      const ctx = makeCtx(repo, deps, opt);
      const rows = [...manifest.secrets.values()].map(e => secretState(e, ctx, { check: flag('check') }));
      if (flag('json')) out(`${JSON.stringify(rows, null, 2)}\n`);
      else {
        for (const r of rows) out(`${r.name}  ${r.env}  ${r.state}${r.source ? ` (${r.source})` : ''}${r.modified ? `  updated ${r.modified.slice(0, 10)}` : ''}  scopes=${r.scopes.join('+')}  delegate=${r.delegate}${r.rotationDue ? '  ROTATION DUE' : ''}\n`);
        out(`${rows.length} secret(s) for ${ctx.slug}; values never shown\n`);
      }
      return flag('strict') && rows.some(r => r.required && r.state === 'not set') ? 2 : 0;
    }
    if (cmd === 'set') {
      const manifest = loadManifest(repo);
      const name = opt('name');
      const entry = manifest.secrets.get(name);
      if (!entry) throw new Error(`SECRET_NOT_DECLARED: ${name || '(no --name)'} — declare it first`);
      if (entry.store === 'keyvault') throw new Error(`SECRET_SOURCE_KEYVAULT: ${name} lives in Azure Key Vault (${entry.keyvault.vault}/${entry.keyvault.secret}); set it there`);
      if (entry.store === 'file') throw new Error(`SECRET_SOURCE_FILE: ${name} is declared for the repository secrets file; fill it there`);
      const ctx = makeCtx(repo, deps, opt);
      if (!ctx.kc.available()) throw new Error('KEYCHAIN_UNAVAILABLE: the Keychain needs macOS; declare this secret with --store file on this machine');
      let value;
      if (flag('stdin')) value = String(io.stdin()).replace(/\r?\n$/, '');
      else value = (deps.prompt || hiddenPrompt)(promptLabel(name, ctx.slug), { platform: ctx.platform });
      if (value === null || value === undefined || value === '') { err(`SECRET_NOT_SET: no value entered for ${name}; nothing was stored\n`); auditAppend(repo, { action: 'set-cancelled', names: [name], note: 'no value entered' }); return 2; }
      const bad = validateValue(value);
      if (bad) throw new Error(bad);
      ctx.kc.set(ctx.service, name, value);
      auditAppend(repo, { action: 'set', names: [name], sources: { [name]: 'keychain' } });
      out(`${name} stored in the Keychain for ${ctx.slug}; later runs reuse it and nothing shows it\n`);
      return 0;
    }
    if (cmd === 'forget') {
      const manifest = loadManifest(repo);
      const name = opt('name');
      const entry = manifest.secrets.get(name);
      if (!entry) throw new Error(`SECRET_NOT_DECLARED: ${name || '(no --name)'}`);
      const ctx = makeCtx(repo, deps, opt);
      const removed = ctx.kc.available() ? ctx.kc.delete(ctx.service, name) : false;
      auditAppend(repo, { action: 'forget', names: [name] });
      out(`${name}: ${removed ? 'removed from the Keychain' : 'was not in the Keychain'}${ctx.fileValues.get(name) ? '; the repository secrets file still holds a value (clear it with migrate --clear or by hand)' : ''}\n`);
      return 0;
    }
    if (cmd === 'migrate') {
      const manifest = loadManifest(repo);
      if (!manifest.exists) throw new Error(`no ${MANIFEST_FILE}: declare the secrets first`);
      const ctx = makeCtx(repo, deps, opt);
      if (!ctx.kc.available()) throw new Error('KEYCHAIN_UNAVAILABLE: migrating into the Keychain needs macOS');
      const moved = [], skipped = [], already = [];
      for (const e of manifest.secrets.values()) {
        if (!effectiveStores(e, ctx.platform).includes('keychain')) continue;
        const fv = ctx.fileValues.get(e.name);
        if (!fv) continue;
        if (ctx.kc.info(ctx.service, e.name).exists) { already.push(e.name); continue; }
        const bad = validateValue(fv);
        if (bad) { skipped.push(`${e.name} (${bad.split(':')[0]})`); continue; }
        ctx.kc.set(ctx.service, e.name, fv); moved.push(e.name);
      }
      let cleared = [];
      if (flag('clear') && (moved.length || already.length)) cleared = blankValues(ctx.file, [...moved, ...already]);
      auditAppend(repo, { action: 'migrate', names: moved, note: `cleared ${cleared.length}` });
      out(`moved ${moved.length} to the Keychain: ${moved.join(', ') || '(none)'}${already.length ? `; already there: ${already.join(', ')}` : ''}${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}${cleared.length ? `; blanked in the file: ${cleared.join(', ')}` : ''}. Values never shown.\n`);
      return 0;
    }
    if (cmd === 'card') {
      const manifest = loadManifest(repo);
      if (!need.length) throw new Error('USAGE: card --need NAME[,NAME…]');
      const undeclared = need.filter(n => !manifest.secrets.has(n));
      if (undeclared.length) throw new Error(`SECRET_NOT_DECLARED: ${undeclared.join(', ')}`);
      out(`${JSON.stringify(secretCard(repoSlugOf(repo), need), null, 2)}\n`);
      return 0;
    }
    if (cmd === 'audit') {
      for (const l of auditTail(repo, opt('tail') ? Math.max(1, Math.min(500, +opt('tail'))) : 20)) out(`${JSON.stringify(l)}\n`);
      return 0;
    }
    throw new Error('USAGE: check|require|list|seed|declare|import-names|status|set|forget|migrate|card|audit');
  } catch (e) { err(`SECRETS: ${e.message}\n`); return 3; }

  // Legacy: the repository's git-ignored secrets file, as before.
  function legacyUse(c) {
    const r = check(repo, need, { file: opt('file') });
    if (!r.ok) {
      err(`SECRETS_MISSING: fill ${r.missing.join(', ')} in ${relative(repo, r.file)} (names were seeded; values are read from the file and never shown). Blocking question for the user; do not continue until the file carries the values.\n`);
      return 2;
    }
    if (c === 'check') { out(`secrets present: ${r.present.join(', ')}\n`); return 0; }
    if (!command.length) throw new Error('USAGE: require --need NAME[,NAME…] -- <command>');
    // On-demand use: the child gets the Architect's environment with every secret-shaped variable
    // stripped, plus exactly the names asked for — and nothing else. Chain order with run-lock is
    // `run-lock run -- node secrets.mjs require … -- <cmd>`; the reverse would strip the names again.
    const values = parseEnv(readFile(r.file));
    const env = scrubEnv(deps.env || process.env, { keep: need }).env;
    for (const n of need) if (!env[n]) env[n] = values.get(n);
    const secretValues = need.map(n => env[n]).filter(Boolean);
    const child = (deps.spawn || spawnSync)(command[0], command.slice(1), { cwd: repo, env, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command[0]) });
    out(mask(child.stdout || '', secretValues));
    err(mask(child.stderr || '', secretValues));
    return child.status === null ? 3 : child.status;
  }

  // Manifest: declared names, scopes and roles; Keychain / Key Vault / file; scrubbed output; audit line.
  function manifestUse(c) {
    const manifest = loadManifest(repo);
    const role = opt('role') || 'architect';
    if (!ROLES.includes(role)) throw new Error(`ROLE_INVALID: --role ${ROLES.join('|')}`);
    const scope = opt('scope') || 'proof';
    const run = opt('run');
    const undeclared = need.filter(n => !manifest.secrets.has(n));
    if (undeclared.length) throw new Error(`SECRET_NOT_DECLARED: ${undeclared.join(', ')} — declare it in ${MANIFEST_FILE} first (declare, or import-names)`);
    const entries = need.map(n => manifest.secrets.get(n));
    for (const e of entries) {
      const why = accessRefusal(e, { scope, role });
      if (why) { auditAppend(repo, { action: 'refused', names: [e.name], scope, role, run, note: why.split(':')[0] }); err(`SECRETS: ${why}\n`); return 3; }
    }
    if (c === 'require') {
      if (!command.length) throw new Error('USAGE: require --need NAME[,NAME…] -- <command>');
      const why = commandRefusal(command);
      if (why) { auditAppend(repo, { action: 'refused', names: need, scope, role, run, command, note: why.split(':')[0] }); err(`SECRETS: ${why}\n`); return 3; }
    }
    const ctx = makeCtx(repo, deps, opt);
    const values = new Map(), sources = {}, missing = [];
    for (const e of entries) {
      const r = resolveSecret(e, ctx);
      if (r) { values.set(e.name, r.value); sources[e.name] = r.from; } else missing.push(e.name);
    }
    if (missing.length) {
      const fileOnly = entries.filter(e => missing.includes(e.name) && effectiveStores(e, ctx.platform).includes('file')).map(e => e.name);
      if (fileOnly.length) { ensureSafeFile(repo, ctx.file); seed(ctx.file, fileOnly); }
      auditAppend(repo, { action: 'missing', names: missing, scope, role, run });
      err(`SECRETS_MISSING: ${missing.join(', ')} not set for ${ctx.slug}. Blocking question for the user: build the card with \`node secrets.mjs card --repo <repo> --need ${missing.join(',')}\`, ask it with questions.mjs and end the turn; on "Set now" run \`node secrets.mjs set --repo <repo> --name <NAME>\` (a masked dialog opens on the user's screen). Never ask for a value in chat.\n`);
      return 2;
    }
    if (c === 'check') { out(`secrets present: ${need.join(', ')}\n`); return 0; }
    const env = scrubEnv(deps.env || process.env, { keep: need }).env;
    for (const [n, v] of values) env[n] = v;
    const child = (deps.spawn || spawnSync)(command[0], command.slice(1), { cwd: repo, env, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command[0]) });
    const secretValues = [...values.values()];
    out(scrubOutput(child.stdout || '', secretValues));
    err(scrubOutput(child.stderr || '', secretValues));
    const code = child.status === null ? 3 : child.status;
    auditAppend(repo, { action: 'run', names: need, scope, role, run, command, exit: code, sources });
    return code;
  }
}

if (isMain(import.meta.url)) {
  const io = {
    stdout: t => process.stdout.write(t), stderr: t => process.stderr.write(t),
    stdin: () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } }
  };
  process.exitCode = runCli(process.argv.slice(2), io);
}
