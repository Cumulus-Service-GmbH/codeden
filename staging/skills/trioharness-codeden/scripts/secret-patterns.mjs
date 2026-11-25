import { createHash } from 'node:crypto';
// TrioHarness Lean — the ONE list of what a secret looks like, shared by guard (candidate scan and
// history scan), jev (evidence redaction), reclaim (archive scan), secrets (output masking) and the
// pre-push hook (generated from these). Matches report a rule name and a location, never the text.

// File names that carry credentials by convention. A candidate that adds or changes one is rejected,
// unless its exact path has a reviewed default-branch name allowance. Content and binary checks still apply.
export const SECRET_FILE_PATTERNS = [
  ['dotenv', /(^|\/)\.env(?!\.(example|sample|template|dist|schema|defaults)$)(\.[^/]+)?$/i],
  ['npmrc', /(^|\/)\.npmrc$/i],
  ['pypirc', /(^|\/)\.pypirc$/i],
  ['netrc', /(^|\/)\.netrc$/i],
  ['key-material', /\.(pfx|p12|pem|key|jks|keystore|publishsettings|asc|gpg|ppk)$/i],
  ['ssh-key', /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i],
  ['secrets-json', /(^|\/)secrets?\.(json|ya?ml|toml)$/i],
  ['credentials', /(^|\/)credentials?(\.[^/]+)?$/i],
  ['local-settings', /(^|\/)local\.settings\.json$/i],
  ['cloud-cli-credentials', /(^|\/)\.(aws\/credentials|kube\/config|azure\/(accessTokens|msal_token_cache|service_principal_entries)[^/]*|gcloud\/(credentials|access_tokens|legacy_credentials)[^/]*)$/i],
  ['terraform-state', /\.tfstate(\.backup)?$/i]
];
// The secrets MANIFEST (names and rules only, never values) is the one file called secrets.json that is meant to be
// committed. It is exempt by exact path; its lines still go through the secret-shaped content scan like any other file.
export const MANIFEST_PATH = /(^|\/)\.trioharness\/secrets\.json$/;
export const isSecretFile = path => { const p = String(path).replace(/\\/g, '/'); return MANIFEST_PATH.test(p) ? null : (SECRET_FILE_PATTERNS.find(([, re]) => re.test(p))?.[0] || null); };
// Files that often carry secrets but legitimately exist without them (every ASP.NET repo tracks
// appsettings.Development.json): rejected only when their ADDED lines hit a value pattern.
export const CONTENT_GATED_FILE_PATTERNS = [
  ['appsettings-env', /(^|\/)appsettings\.(?!json$)[^/]+\.json$/i],
  ['azure-dir', /(^|\/)\.azure\//i],
  ['docker-compose', /(^|\/)(docker-)?compose(\.[^/]+)?\.ya?ml$/i]
];
export const isContentGatedFile = path => CONTENT_GATED_FILE_PATTERNS.find(([, re]) => re.test(String(path).replace(/\\/g, '/')))?.[0] || null;

// Values. Each regex matches a line of text; the match is never printed.
export const SECRET_VALUE_PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['stripe-key', /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['azure-account-key', /\b(AccountKey|SharedAccessKey|SharedAccessSignature)\s*=\s*[A-Za-z0-9+/=%]{20,}/i],
  ['sas-signature', /[?&]sig=[A-Za-z0-9%+/=]{20,}/],
  ['url-credentials', /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]{4,}@/i],
  ['basic-auth-header', /Authorization:\s*Basic\s+[A-Za-z0-9+/=]{8,}/i],
  ['bearer-header', /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{16,}/i],
  ['npm-auth-token', /_authToken\s*=\s*\S{8,}/i],
  ['client-secret', /\b(client|app|application)[_-]?secret\b["']?\s*[:=]\s*["']?[^\s"',;}]{8,}/i],
  // Connection-string password: a literal value terminated by ; quote or EOL — not an identifier or expression.
  ['conn-string-password', /(?:Password|Pwd)\s*=\s*(?!<|process\.|os\.|env\.|\$\{|\$\(|\$[A-Za-z_]|%[A-Za-z_])[^;"'\s$(){}<>]{4,}(?=[;"'\s]|$)/i],
  ['aws-secret-line', /\baws_secret_access_key\s*=\s*\S{16,}/i],
  ['powershell-secure-string', /ConvertTo-SecureString\s+["'][^"']{6,}["']/i],
  // key = "literal" in code/config (quoted), and KEY=literal in dotenv/compose/yaml-ish lines (unquoted).
  ['assigned-secret', /(?:api[_-]?key|secret|token|password|passwd|pwd|sas)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ['dotenv-secret', /^\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|SAS|CONNECTION(?:_?STRING)?|CREDENTIALS?)\s*=\s*(?!\s*$)(?!["']?\s*(?:<|\$\{|\$[A-Za-z_]|%[A-Za-z_]|process\.|os\.))\S{8,}/],
  ['yaml-password', /^\s*(?:password|passwd|secret|api[_-]?key|token)\s*:\s+(?!["']?\s*(?:<|\$\{|\$[A-Za-z_]|%|\{\{))\S{8,}\s*$/i]
];

// Environment variable names that never reach a child the harness spawns for a worker, a reviewer, a
// proof command or a repo-defined script. The Jev key and the deploy tokens are read on demand by the
// scripts that need them, under `secrets.mjs require`, never inherited.
export const SCRUB_ENV_NAME = /(API[_-]?KEY|SECRET|SECRETS|TOKEN|PASSWORD|PASSWD|PWD|PASS|CREDENTIALS?|CONNECTION[_-]?STRING|PRIVATE[_-]?KEY|AUTH|KEY|PAT|SAS)$|^(JEV_|TYPESAFE_|DEEPSEEK_|OPENAI_API|ANTHROPIC_API|OPENAI_ORG|GH_TOKEN$|GITHUB_TOKEN$|GITHUB_PAT$|NPM_TOKEN$|AZURE_CLIENT_SECRET$|AZURE_CREDENTIALS$|AWS_SECRET|HEADROOM_API|CONNECTIONSTRINGS__|APPSETTING_)/i;
// Proxy routing is deliberately kept: OPENAI_BASE_URL / ANTHROPIC_BASE_URL carry no credential and the
// Headroom proxy (SKILL "never reconfigure the proxy") needs them. Values are scrubbed too: a variable
// with an innocent name whose value is a connection string or token is stripped on the value.
export const SCRUB_ENV_KEEP = /^(OPENAI_BASE_URL|ANTHROPIC_BASE_URL|OPENAI_API_BASE|ANTHROPIC_API_BASE|HEADROOM_MODE|HEADROOM_BEACON|PATH|HOME|USERPROFILE|TEMP|TMP|TMPDIR|SystemRoot|ComSpec|PATHEXT|LANG|LC_ALL|TERM)$/i;
// Variables the host sets to mark an agent shell. The pre-push ref policy keys on them, so scrubbing a
// secret-bearing marker (OpenCode's OPENCODE_CONFIG_CONTENT carries provider keys) must never switch the
// policy off in the child: the marker is replaced by TRIOHARNESS_AGENT=1, which the hook also honours.
export const AGENT_MARKERS = ['OPENCODE_CONFIG_CONTENT', 'CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'TRIOHARNESS_AGENT'];
export function scrubEnv(env = process.env, { keep = [] } = {}) {
  const out = {}, stripped = [], strippedByValue = [];
  for (const [k, v] of Object.entries(env)) {
    if (keep.includes(k) || SCRUB_ENV_KEEP.test(k)) { out[k] = v; continue; }
    if (SCRUB_ENV_NAME.test(k)) { stripped.push(k); continue; }
    if (v && String(v).length >= 8 && findSecrets(`${k}=${String(v).split('\n')[0]}`).length) { strippedByValue.push(k); continue; }
    out[k] = v;
  }
  if (AGENT_MARKERS.some(m => Object.prototype.hasOwnProperty.call(env, m))) out.TRIOHARNESS_AGENT = '1';
  return { env: out, stripped: stripped.sort(), strippedByValue: strippedByValue.sort() };
}

// Find value-pattern hits in a text. Returns [{rule, line}] — never the matched text.
export function findSecrets(text) {
  const hits = [];
  String(text || '').split('\n').forEach((line, i) => {
    for (const [rule, re] of SECRET_VALUE_PATTERNS) if (re.test(line)) { hits.push({ rule, line: i + 1 }); break; }
  });
  return hits;
}

// Redact a plain string (NOT a JSON-encoded one: redact each string value before serialising).
export function redactText(text) {
  let t = String(text);
  t = t.replace(/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/g, '[REDACTED_KEY]');
  t = t.replace(/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----[\s\S]*$/g, '[REDACTED_KEY]');
  t = t.replace(/((?:api[_-]?key|secret|token|password|passwd|pwd|sas|client[_-]?secret|AccountKey|SharedAccessKey|SharedAccessSignature|_authToken)["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi, '$1[REDACTED]');
  t = t.replace(/^(\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|SAS|CONNECTION(?:_?STRING)?|CREDENTIALS?)\s*=\s*)\S+/gm, '$1[REDACTED]');
  t = t.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|[sr]k_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]');
  t = t.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
  t = t.replace(/([?&]sig=)[A-Za-z0-9%+/=]{20,}/g, '$1[REDACTED]');
  t = t.replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]{4,}(@)/gi, '$1[REDACTED]$2');
  t = t.replace(/(Authorization:\s*(?:Basic|Bearer)\s+)\S+/gi, '$1[REDACTED]');
  t = t.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/g, '$1[REDACTED]');
  return t;
}

// Redact every string inside a JSON-able value (objects, arrays, strings), keeping its shape.
export function redactDeep(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') { const o = {}; for (const [k, v] of Object.entries(value)) o[k] = redactDeep(v); return o; }
  return value;
}

// ---------------------------------------------------------------- exact-line allowlist
// A secret-shaped line that is NOT a secret and cannot be removed (it sits in commits that are being
// brought into the default branch, e.g. a config KEY NAME such as "ClientSecret" or a redaction regex)
// may be accepted by exact content: `<path> <git blob hash of the exact line> # reason`. The hash is what
// `printf '%s' "$line" | git hash-object --stdin` prints, so the file itself never contains the text and
// is not flagged by the scanners. No wildcards, no patterns. The list is read from the DEFAULT branch
// (guard and hook: the verified default-branch SHA), never from the candidate, so a change cannot accept
// its own hits: entries take effect once a reviewed change containing them is merged.
export const ALLOW_FILE = '.trioharness/secret-allow.txt';
export function lineFingerprint(line) {
  const body = Buffer.from(String(line), 'utf8');
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex');
}
// -> { entries: Map(path -> Set(fingerprint)), names: Set(exact path), errors: [] }
export function parseAllow(text) {
  const entries = new Map(), names = new Set(), errors = [];
  String(text || '').replace(/^\uFEFF/, '').split('\n').forEach((raw, i) => {
    raw = raw.replace(/\r$/, '');
    if (raw.includes('\r')) { errors.push(`ALLOW_ENTRY_INVALID: line ${i + 1} contains a mid-row carriage return`); return; }
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const [path, fp, ...extra] = line.split(/\s+/);
    if (extra.length || !path || !fp || (fp !== 'name' && !/^[0-9a-f]{40}$/.test(fp)) || path.startsWith('/') || (fp === 'name' && (/^[A-Za-z]:/.test(path) || path.startsWith('./') || /[^\x20-\x7e]|"/.test(path))) || path.includes('..') || path.includes('\\') || /[*?\[\]]/.test(path)) { errors.push(`ALLOW_ENTRY_INVALID: line ${i + 1} must be "<repo-relative path> <40-hex fingerprint|name> # reason" (exact paths, no wildcards)`); return; }
    if (fp === 'name') { names.add(path); return; }
    if (!entries.has(path)) entries.set(path, new Set());
    entries.get(path).add(fp);
  });
  return { entries, names, errors };
}
export const isAllowedLine = (allow, path, line) => !!allow?.entries?.get(path)?.has(lineFingerprint(line));

export const isNameAllowed = (allow, path) => !!allow?.names?.has(path);
