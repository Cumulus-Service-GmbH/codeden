// TrioHarness Lean — where a repository's secrets live and how they are handed out.
//
// This module holds the pieces `secrets.mjs` composes: the per-repo manifest (names and rules, never
// values), the macOS Keychain store, the masked "type it once" dialog, the Azure Key Vault source, output
// scrubbing, the audit line and the command guard. Everything that touches the OS takes an injectable
// `exec`, so the tests run on any machine and the real calls never put a value in argv.
//
// Honest limits (also in SKILL.md and CHANGELOG): an item written through the `security` tool can be read
// back by any process of the same macOS user that calls `security` — it keeps secrets out of files,
// transcripts, packets and git, not out of reach of a hostile process running as you. Real isolation needs
// the item owned by the desktop app (planned, see CHANGELOG). A command that is handed a secret can still
// send it somewhere; hand test and QA values with least privilege to workers, never production.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findSecrets } from './secret-patterns.mjs';

export const NAME_RE = /^[A-Z][A-Z0-9_]{0,80}$/;
export const MANIFEST_FILE = '.trioharness/secrets.json';
export const AUDIT_FILE = '.trioharness-direct/secrets-audit.jsonl';
export const MIN_VALUE_LENGTH = 6;
export const MAX_VALUE_BYTES = 16 * 1024;

const ENVS = new Set(['dev', 'qa', 'prd']);
const DELEGATES = new Set(['none', 'architect', 'worker']);
const STORES = new Set(['auto', 'keychain', 'file', 'keyvault']);
const SCOPE_RE = /^[a-z][a-z0-9-]{0,40}$/;
const ENTRY_FIELDS = new Set(['name', 'purpose', 'env', 'store', 'keyvault', 'scopes', 'delegate', 'required', 'rotateDays']);

// ---------------------------------------------------------------- manifest

// Pure. Returns { ok, errors[], secrets: Map(name -> normalised entry) }. A manifest holds names and rules,
// never values: unknown fields (value, secret, password …) and value-shaped text are refused.
export function validateManifest(m) {
  const errors = [];
  const secrets = new Map();
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['SECRETS_MANIFEST_INVALID: the file must be a JSON object'], secrets };
  if (m.version !== 1) errors.push('SECRETS_MANIFEST_INVALID: "version" must be 1');
  for (const k of Object.keys(m)) if (!['version', 'secrets'].includes(k)) errors.push(`SECRETS_MANIFEST_INVALID: unknown top-level field "${k}"`);
  if (!Array.isArray(m.secrets)) { errors.push('SECRETS_MANIFEST_INVALID: "secrets" must be an array'); return { ok: false, errors, secrets }; }
  for (const [i, e] of m.secrets.entries()) {
    const at = `secrets[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(`SECRETS_MANIFEST_INVALID: ${at} must be an object`); continue; }
    for (const k of Object.keys(e)) if (!ENTRY_FIELDS.has(k)) errors.push(`SECRETS_MANIFEST_INVALID: ${at} has unknown field "${k}" — a manifest holds names and rules, never values`);
    if (typeof e.name !== 'string' || !NAME_RE.test(e.name)) { errors.push(`SECRETS_MANIFEST_INVALID: ${at}.name must be UPPER_SNAKE_CASE`); continue; }
    if (secrets.has(e.name)) { errors.push(`SECRETS_MANIFEST_INVALID: ${e.name} is declared twice`); continue; }
    const purpose = e.purpose;
    if (typeof purpose !== 'string' || !purpose.trim() || purpose.length > 200) errors.push(`SECRETS_MANIFEST_INVALID: ${e.name}.purpose must be 1–200 characters`);
    const env = e.env ?? 'dev';
    if (!ENVS.has(env)) errors.push(`SECRETS_MANIFEST_INVALID: ${e.name}.env must be dev, qa or prd`);
    const store = e.store ?? 'auto';
    if (!STORES.has(store)) errors.push(`SECRETS_MANIFEST_INVALID: ${e.name}.store must be auto, keychain, file or keyvault`);
    let keyvault = null;
    if (store === 'keyvault') {
      const kv = e.keyvault && { vault: e.keyvault.vault, secret: e.keyvault.secretName ?? e.keyvault.secret };
      if (!kv || typeof kv.vault !== 'string' || typeof kv.secret !== 'string' || !/^[A-Za-z0-9-]{3,24}$/.test(kv.vault) || !/^[A-Za-z0-9-]{1,127}$/.test(kv.secret)) errors.push(`SECRETS_MANIFEST_INVALID: ${e.name}.keyvault needs {vault, secret} (vault 3–24 chars, letters, digits, dashes)`);
      else keyvault = { vault: kv.vault, secret: kv.secret };
    } else if (e.keyvault !== undefined) errors.push(`SECRETS_MANIFEST_INVALID: ${e.name}.keyvault is only valid with store "keyvault"`);
    const scopes = e.scopes ?? ['proof'];
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > 10 || scopes.some(s => typeof s !== 'string' || !SCOPE_RE.test(s))) errors.push(`SECRETS_MANIFEST_INVALID: ${e.name}.scopes must be 1–10 lowercase labels such as "proof" or "deploy-qa"`);
    const delegate = e.delegate ?? 'architect';
    if (!DELEGATES.has(delegate)) errors.push(`SECRETS_MANIFEST_INVALID: ${e.name}.delegate must be none, architect or worker`);
    if (env === 'prd' && delegate === 'worker') errors.push(`SECRETS_MANIFEST_INVALID: ${e.name} is a production secret; it can never be delegated to a worker`);
    const required = e.required ?? true;
    if (typeof required !== 'boolean') errors.push(`SECRETS_MANIFEST_INVALID: ${e.name}.required must be true or false`);
    if (e.rotateDays !== undefined && (!Number.isInteger(e.rotateDays) || e.rotateDays < 1 || e.rotateDays > 3650)) errors.push(`SECRETS_MANIFEST_INVALID: ${e.name}.rotateDays must be a whole number of days (1–3650)`);
    secrets.set(e.name, { name: e.name, purpose: String(purpose || ''), env, store, keyvault, scopes: Array.isArray(scopes) ? [...scopes] : ['proof'], delegate, required: required === true, rotateDays: e.rotateDays });
  }
  // Belt and braces: nothing value-shaped may sit in the file, whatever field it hides in.
  if (findSecrets(JSON.stringify(m, null, 2)).length) errors.push('SECRETS_MANIFEST_INVALID: the file contains secret-shaped text — a manifest holds names and rules, never values');
  return { ok: errors.length === 0, errors, secrets };
}

export function loadManifest(repo) {
  const file = join(repo, MANIFEST_FILE);
  if (!existsSync(file)) return { exists: false, file, secrets: new Map() };
  let json;
  try { json = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`SECRETS_MANIFEST_INVALID: ${MANIFEST_FILE} is not valid JSON (${String(e.message).split('\n')[0]})`); }
  const v = validateManifest(json);
  if (!v.ok) throw new Error(v.errors.slice(0, 6).join('; '));
  return { exists: true, file, secrets: v.secrets };
}

export function writeManifest(repo, entries) {
  const list = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)).map(e => {
    const o = { name: e.name, purpose: e.purpose, env: e.env, store: e.store, scopes: e.scopes, delegate: e.delegate, required: e.required };
    // On disk the field is "secretName": a key called "secret" with a value looks like an assigned secret to every scanner.
    if (e.keyvault) o.keyvault = { vault: e.keyvault.vault, secretName: e.keyvault.secret };
    if (e.rotateDays !== undefined) o.rotateDays = e.rotateDays;
    return o;
  });
  const doc = { version: 1, secrets: list };
  const v = validateManifest(doc);
  if (!v.ok) throw new Error(v.errors.slice(0, 6).join('; '));
  const file = join(repo, MANIFEST_FILE);
  mkdirSync(join(repo, '.trioharness'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------- repository identity

// One Keychain service per repository, stable across worktrees: the GitHub owner/repo of `origin`.
export function slugFromRemote(url) {
  const m = String(url || '').trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
export function repoSlugOf(repo, { exec = execFileSync } = {}) {
  try {
    const url = exec('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const s = slugFromRemote(url);
    if (s) return s;
  } catch { /* no origin */ }
  return `local/${basename(repo).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 60) || 'repo'}`;
}
export const serviceFor = slug => `trioharness/${slug}`;

// ---------------------------------------------------------------- macOS Keychain

const kcValue = out => Buffer.from(String(out).trim(), 'base64').toString('utf8');

// Values are stored base64-encoded: no quoting problems, nothing special for `security -i` to parse. The
// write goes through `security -i` on stdin, so the value is never in argv (visible in `ps`).
export function keychainBackend({ exec = execFileSync, bin = 'security', platform = process.platform } = {}) {
  const safe = s => /^[A-Za-z0-9_./:-]+$/.test(s);
  const assertSafe = (service, account) => { if (!safe(service) || !safe(account)) throw new Error('KEYCHAIN_NAME_INVALID: service and account use letters, digits and _ . / : -'); };
  const run = (args, opts = {}) => exec(bin, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 60000, ...opts });
  const b = {
    kind: 'keychain',
    available: () => platform === 'darwin',
    get(service, account) {
      assertSafe(service, account);
      try { return kcValue(run(['find-generic-password', '-s', service, '-a', account, '-w'])); }
      catch (e) { if (e.status === 44) return null; throw new Error(`KEYCHAIN_READ_FAILED: exit ${e.status ?? 'unknown'}`); }
    },
    set(service, account, value) {
      assertSafe(service, account);
      const b64 = Buffer.from(String(value), 'utf8').toString('base64');
      // `security -i` ends at end of input; some macOS versions exit 1 after the last command even when it worked,
      // and others exit 0 after an error. So its exit status is not trusted either way: the write is proven by reading it back.
      try { run(['-i'], { input: `add-generic-password -U -s "${service}" -a "${account}" -j "trioharness" -w "${b64}"\n` }); }
      catch (e) { if (e.code === 'ENOENT' || e.code === 'EACCES') throw new Error('KEYCHAIN_WRITE_FAILED: the security tool could not be started'); }
      if (b.get(service, account) !== String(value)) throw new Error('KEYCHAIN_WRITE_FAILED: the item could not be read back after writing');
    },
    delete(service, account) {
      assertSafe(service, account);
      try { run(['delete-generic-password', '-s', service, '-a', account]); return true; }
      catch (e) { if (e.status === 44) return false; throw new Error(`KEYCHAIN_DELETE_FAILED: exit ${e.status ?? 'unknown'}`); }
    },
    // Existence and last-modified time without reading the value (no -w / -g, so no access prompt).
    info(service, account) {
      assertSafe(service, account);
      try {
        const out = String(run(['find-generic-password', '-s', service, '-a', account]));
        const m = out.match(/"mdat"<timedate>=(?:0x[0-9A-Fa-f]+\s+)?"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/);
        return { exists: true, modified: m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null };
      } catch (e) { if (e.status === 44) return { exists: false, modified: null }; throw new Error(`KEYCHAIN_READ_FAILED: exit ${e.status ?? 'unknown'}`); }
    }
  };
  return b;
}

// ---------------------------------------------------------------- the masked dialog

// A native macOS dialog with a hidden answer: you type or paste the value once, it goes straight from the
// dialog into the Keychain write. Not in argv, not in chat, not in a file. Cancel or empty → null.
export function hiddenPrompt(label, { exec = execFileSync, bin = 'osascript', platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('PROMPT_UNAVAILABLE: the masked dialog needs macOS; use `set --stdin` or fill the repository secrets file');
  if (!/^[A-Za-z0-9 _./:(),-]{1,200}$/.test(label)) throw new Error('PROMPT_LABEL_INVALID');
  const script = `text returned of (display dialog "${label}" default answer "" with hidden answer with title "TrioHarness" buttons {"Cancel", "Save"} default button "Save" with icon note)`;
  let out;
  try { out = exec(bin, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (e) {
    if (/-128|User canceled/i.test(`${e.stderr || ''}${e.message || ''}`)) return null;
    throw new Error('PROMPT_FAILED: the dialog could not be shown');
  }
  const v = String(out).replace(/\r?\n$/, '');
  return v.length ? v : null;
}

// ---------------------------------------------------------------- Azure Key Vault source

export function keyvaultBackend({ exec = execFileSync, platform = process.platform } = {}) {
  return {
    kind: 'keyvault',
    get({ vault, secret }) {
      try {
        const out = exec('az', ['keyvault', 'secret', 'show', '--vault-name', vault, '--name', secret, '--query', 'value', '-o', 'tsv'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 4 * 1024 * 1024, shell: platform === 'win32' });
        const v = String(out).replace(/\r?\n$/, '');
        return v.length ? v : null;
      } catch { throw new Error(`KEYVAULT_READ_FAILED: ${vault}/${secret} could not be read with the current az login`); }
    }
  };
}

// ---------------------------------------------------------------- value hygiene

export function validateValue(value) {
  const v = String(value ?? '');
  if (v.length < MIN_VALUE_LENGTH) return `SECRET_TOO_SHORT: values shorter than ${MIN_VALUE_LENGTH} characters cannot be masked reliably in output`;
  if (Buffer.byteLength(v, 'utf8') > MAX_VALUE_BYTES) return `SECRET_TOO_LONG: more than ${MAX_VALUE_BYTES} bytes`;
  if (v.includes('\0')) return 'SECRET_INVALID: the value contains a NUL character';
  return null;
}

// The forms a value can take in output: itself, base64 (standard and URL-safe), percent-encoded, JSON-escaped.
export function scrubVariants(values) {
  const out = new Set();
  for (const raw of values) {
    const v = String(raw ?? '');
    if (v.length < 4) continue;
    out.add(v);
    const b64 = Buffer.from(v, 'utf8').toString('base64');
    out.add(b64); out.add(b64.replace(/=+$/, ''));
    out.add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    out.add(encodeURIComponent(v));
    out.add(JSON.stringify(v).slice(1, -1));
    for (const line of v.split(/\r?\n/)) if (line.trim().length >= 6) out.add(line.trim());
  }
  return [...out].filter(s => s.length >= 4).sort((a, b) => b.length - a.length);
}
export function scrubOutput(text, values, token = '<secret>') {
  let t = String(text ?? '');
  for (const s of scrubVariants(values)) t = t.split(s).join(token);
  return t;
}

// ---------------------------------------------------------------- command guard

// An accident guard, not a security boundary: refuse the obvious ways to dump an environment or read the
// Keychain through the broker. A determined hostile command can still do harm — see the limits above.
const REFUSED_BINS = new Set(['env', 'printenv', 'set', 'security', 'osascript', 'cmdkey', 'vaultcmd', 'keychain', 'launchctl']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const DUMP_RE = /(^|[\s;|&(`])(env|printenv|security|osascript)(\s*$|\s*[;|&)`]|\s+-|\s+find-)|(^|[\s;|&(`])export\s*($|[;|&])|\$env:|get-childitem\s+env|gci\s+env|\/proc\/[^\s]*environ/i;
export function commandRefusal(command) {
  const bin = basename(String(command?.[0] || '')).toLowerCase();
  if (!bin) return 'SECRET_COMMAND_EMPTY: no command given';
  if (REFUSED_BINS.has(bin)) return `SECRET_COMMAND_REFUSED: ${bin} can print the environment or read the Keychain`;
  if (SHELLS.has(bin) && DUMP_RE.test(command.slice(1).join(' '))) return 'SECRET_COMMAND_REFUSED: the shell script looks like it dumps the environment or reads the Keychain';
  return null;
}

// ---------------------------------------------------------------- audit

// One line per use: when, what, who, under which scope, a hash of the command. Never a value.
export function auditAppend(repo, rec) {
  const names = (rec.names || []).filter(n => NAME_RE.test(n));
  const line = {
    at: rec.at || new Date().toISOString(), action: rec.action, names,
    ...(rec.scope ? { scope: rec.scope } : {}), ...(rec.role ? { role: rec.role } : {}), ...(rec.run ? { run: rec.run } : {}),
    ...(rec.command ? { command: { bin: basename(String(rec.command[0] || '')), args: rec.command.length - 1, sha256: createHash('sha256').update(JSON.stringify(rec.command)).digest('hex').slice(0, 16) } } : {}),
    ...(rec.exit !== undefined ? { exit: rec.exit } : {}), ...(rec.sources ? { sources: rec.sources } : {}), ...(rec.note ? { note: String(rec.note).slice(0, 160) } : {})
  };
  const file = join(repo, AUDIT_FILE);
  mkdirSync(join(repo, '.trioharness-direct'), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  return line;
}
export function auditTail(repo, n = 20) {
  const file = join(repo, AUDIT_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n).map(l => { try { return JSON.parse(l); } catch { return { unreadable: true }; } });
}
