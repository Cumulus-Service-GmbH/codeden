import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

export const ENVIRONMENTS_PATH = '.trioharness/environments.json';
const DEPLOY_PATH = '.trioharness/deploy.json';
const SECRET_KEY = /(secret|password|pwd|connection.?string|api.?key|token|credential)/i;
function checkHealth(name, health) {
  if (!health || typeof health.url !== 'string' || typeof health.shaField !== 'string' || !health.shaField) throw new Error(`ENVIRONMENTS_INVALID: ${name}.health.url and shaField required`);
  let u; try { u = new URL(health.url); } catch { throw new Error(`ENVIRONMENTS_INVALID: ${name}.health.url is not a URL`); }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) throw new Error(`ENVIRONMENTS_INVALID: ${name}.health.url must be http(s)`);
  if (u.username || u.password) throw new Error(`ENVIRONMENTS_INVALID: ${name}.health.url must not carry credentials`);
  return { url: health.url, shaField: health.shaField };
}

// Pure reader: { name -> { name, health:{url,shaField}, note, source } }. Throws on a malformed file (never guesses).
const workingTreeReader = repo => rel => { const p = join(repo, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; };
const parseJsonText = text => JSON.parse(String(text).replace(/^\uFEFF/, ''));
function loadManifestEntries(read) {
  const entries = [];
  const apps = new Map();
  const depText = read(DEPLOY_PATH);
  if (depText !== null) {
    let cfg; try { cfg = parseJsonText(depText); } catch { throw new Error(`ENVIRONMENTS_INVALID: ${DEPLOY_PATH} is not valid JSON`); }
    for (const [name, t] of Object.entries(cfg?.targets || {})) {
      if (typeof t?.app === 'string') apps.set(name, t.app);
      if (t?.health && Object.hasOwn(t.health, 'url')) entries.push({ name, health: checkHealth(name, t.health), note: null, source: 'deploy.json' });
    }
  }
  const envText = read(ENVIRONMENTS_PATH);
  if (envText !== null) {
    let cfg; try { cfg = parseJsonText(envText); } catch { throw new Error(`ENVIRONMENTS_INVALID: ${ENVIRONMENTS_PATH} is not valid JSON`); }
    if (cfg?.schema !== 1 || !cfg.environments || typeof cfg.environments !== 'object' || Array.isArray(cfg.environments)) throw new Error(`ENVIRONMENTS_INVALID: need {"schema":1,"environments":{"<name>":{"health":{"url":"…","shaField":"…"}}}}`);
    const walk = (v, path) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (SECRET_KEY.test(k)) throw new Error(`ENVIRONMENTS_HAS_SECRET_FIELD: ${path}${k} — environments hold names and public URLs only`); walk(x, `${path}${k}.`); } };
    walk(cfg, '');
    for (const [name, e] of Object.entries(cfg.environments)) {
      if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) throw new Error(`ENVIRONMENTS_INVALID: environment name "${name}" (letters, digits, _ -, max 24)`);
      entries.push({ name, health: checkHealth(name, e?.health), note: typeof e?.note === 'string' ? e.note.slice(0, 200) : null, source: 'environments.json' });
    }
  }
  return { entries, apps };
}

function mergeEnvironments(entries) {
  return Object.assign(Object.create(null), Object.fromEntries(entries.map(entry => [entry.name, entry])));
}

export function loadEnvironments(repo, { read = workingTreeReader(repo) } = {}) {
  return mergeEnvironments(loadManifestEntries(read).entries);
}

export const environmentsConfigured = repo => {
  try { return Object.keys(loadEnvironments(repo)).length > 0; } catch { return true; } // a broken declaration still requires the check (it will fail loudly)
};

const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000 });
export const withoutReplacements = git => args => git(args[0] === '--no-replace-objects' ? args : ['--no-replace-objects', ...args]);
export const gitIn = cwd => withoutReplacements(args => run(cwd, args));

export const DEFAULT_REF = 'refs/running-ref/default';
export function resolveRemoteDefault(git, remote = 'origin', expectedBranch) {
  if (remote !== 'origin') throw new Error(`RUNNING_REF_REMOTE_FIXED: expected origin, got ${remote}`);
  git = withoutReplacements(git);
  let out; try { out = git(['ls-remote', '--symref', remote, 'HEAD']); } catch { throw new Error(`RUNNING_REF_REMOTE_UNREADABLE: git ls-remote --symref ${remote} HEAD failed; the default branch cannot be established`); }
  const branch = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m)?.[1];
  const sha = out.match(/^([0-9a-f]{40})\s+HEAD$/m)?.[1];
  if (!branch || !sha) throw new Error(`RUNNING_REF_REMOTE_UNREADABLE: ${remote} did not report its default branch (ls-remote --symref HEAD)`);
  try { git(['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${branch}:${DEFAULT_REF}`]); } catch { throw new Error(`RUNNING_REF_FETCH_FAILED: could not fetch ${remote}/${branch}; the default branch cannot be established`); }
  let fetched; try { fetched = git(['rev-parse', '--verify', `${DEFAULT_REF}^{commit}`]).trim(); } catch { throw new Error('RUNNING_REF_FETCH_FAILED: the fetched default branch is unreadable'); }
  if (fetched !== sha) throw new Error(`RUNNING_REF_DEFAULT_MISMATCH: ls-remote reports ${branch}@${sha.slice(0, 12)} but the fetch gave ${fetched.slice(0, 12)}; retry`);
  if (expectedBranch !== undefined && expectedBranch !== branch) {
    throw new Error(`RUNNING_REF_DEFAULT_MISMATCH: expected ${expectedBranch}, origin reports ${branch}`);
  }
  return { remote, branch, sha };
}
// Reads <rel> at <sha>: null only when the path is absent there; any other failure throws (fail closed). Git replacement
// objects are ignored, so local refs/replace/* cannot change what the advertised commit contains.
export const shaReader = (git, sha) => rel => {
  let listed; try { listed = git(['--no-replace-objects', 'ls-tree', '--full-tree', '--name-only', sha, '--', rel]).trim(); } catch { throw new Error(`RUNNING_REF_DEFAULT_UNREADABLE: cannot list ${rel} at ${sha.slice(0, 12)}`); }
  if (!listed) return null;
  try { return git(['--no-replace-objects', 'show', `${sha}:${rel}`]); } catch { throw new Error(`RUNNING_REF_DEFAULT_UNREADABLE: cannot read ${rel} at ${sha.slice(0, 12)}`); }
};
// Return the selected names in configuration order, with duplicates removed.
export function selectEnvironments(envs, names) {
  const known = Object.keys(envs);
  if (names === undefined) return known;
  const requested = new Set(names.map(name => name.trim()));
  const unknown = [...requested].filter(name => !name || !Object.hasOwn(envs, name))
    .map(name => name || '(empty)');
  if (!requested.size || unknown.length) {
    throw new Error(`RUNNING_REF_UNKNOWN_TARGET: ${unknown.join(', ') || '(empty)'}; known targets: ${known.join(', ')}`);
  }
  return known.filter(name => requested.has(name));
}

const azureFile = () => join(userInfo().homedir, '.config', 'trioharness', 'azure-targets.json');
const CLASS_NAMES = ['apps', 'resources', 'resourceGroups', 'deployTargets'];
const NONPRD_KEYS = [...CLASS_NAMES, 'databases', 'comment'];
const SECTION_KEYS = {
  qa: NONPRD_KEYS, test: NONPRD_KEYS,
  prd: [...CLASS_NAMES, 'patterns', 'databaseServers', 'comment',
    'grantPrincipals', 'allowedCreates', 'evidencePublisherGrants', 'evidencePublisherPrincipalId'],
  shared: ['resourceGroups', 'subscriptions', 'resources', 'comment']
};

function validateObject(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path || 'root'} must be an object`);
  for (const key of Object.keys(value)) {
    const field = path ? `${path}.${key}` : key;
    if (!keys.includes(key)) throw new Error(`unknown key "${field}"`);
    if (key === 'comment' && typeof value[key] !== 'string') throw new Error(`${field} must be a string`);
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateGuid(value, path) {
  if (typeof value !== 'string' || !GUID.test(value)) throw new Error(`${path} must be a GUID`);
}

function validateNonEmptyString(value, path) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
}

function validateGrant(entry, path, hasPrincipal) {
  validateObject(entry, hasPrincipal ? ['principalId', 'role', 'scope'] : ['role', 'scope'], path);
  if (hasPrincipal) validateGuid(entry.principalId, `${path}.principalId`);
  validateNonEmptyString(entry.role, `${path}.role`);
  if (typeof entry.scope !== 'string' || !entry.scope.startsWith('/')) throw new Error(`${path}.scope must be a string starting with /`);
}

function validateEntry(entry, path, pattern, app) {
  const required = pattern ? ['regex', 'scope'] : ['name'];
  const keys = [...required, 'source', 'comment', ...(pattern ? [] : ['server']), ...(app ? ['subscription', 'resourceGroup'] : [])];
  validateObject(entry, keys, path);
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'subscription') {
      if (typeof value !== 'string' || !GUID.test(value)) throw new Error(`${path}.subscription must be a subscription GUID`);
      continue;
    }
    if (typeof value !== 'string') throw new Error(`${path}.${key} must be a string`);
  }
  for (const key of [...required, ...(Object.hasOwn(entry, 'resourceGroup') ? ['resourceGroup'] : [])]) {
    if (!entry[key]?.trim()) throw new Error(`${path}.${key} must be a non-empty string`);
  }
  if (pattern) {
    try { new RegExp(entry.regex, 'i'); } catch { throw new Error(`${path}.regex must compile`); }
  }
}

export function readAzureTargets(file = azureFile()) {
  try {
    const config = parseJsonText(readFileSync(file, 'utf8'));
    validateObject(config, ['version', 'comment', 'runningRefStaging', ...Object.keys(SECTION_KEYS)], '');
    if (config.version !== 1) throw new Error('version must be 1');
    if (Object.hasOwn(config, 'runningRefStaging')) {
      if (!Array.isArray(config.runningRefStaging)) throw new Error('runningRefStaging must be a list');
      for (const [i, entry] of config.runningRefStaging.entries()) {
        const field = `runningRefStaging[${i}]`;
        validateObject(entry, ['name', 'url'], field);
        validateNonEmptyString(entry.name, `${field}.name`);
        checkHealth(field, { url: entry.url, shaField: '.' });
        const url = new URL(entry.url);
        if (url.protocol !== 'https:' || url.pathname !== '/build-info.txt' || /[?#]/.test(url.href)) {
          throw new Error(`${field}.url must be an HTTPS /build-info.txt URL without a query or fragment`);
        }
      }
    }
    for (const [section, keys] of Object.entries(SECTION_KEYS)) {
      if (!Object.hasOwn(config, section)) continue;
      validateObject(config[section], keys, section);
      for (const [key, list] of Object.entries(config[section])) {
        if (key === 'comment') continue;
        const path = `${section}.${key}`;
        if (key === 'evidencePublisherPrincipalId') {
          if (list !== null) validateGuid(list, path);
          continue;
        }
        if (!Array.isArray(list)) throw new Error(`${path} must be a list`);
        for (const [i, entry] of list.entries()) {
          const entryPath = `${path}[${i}]`;
          if (key === 'allowedCreates') validateNonEmptyString(entry, entryPath);
          else if (key === 'grantPrincipals' || key === 'evidencePublisherGrants') validateGrant(entry, entryPath, key === 'grantPrincipals');
          else validateEntry(entry, entryPath, key === 'patterns', key === 'apps');
        }
      }
    }
    return config;
  } catch (error) {
    throw new Error(`RUNNING_REF_CLASSIFICATION_UNREADABLE: ${file}: ${error.code === 'ENOENT' ? 'missing' : error.message}`);
  }
}

const normalize = name => name.trim().toLowerCase();
const namesIn = (section, keys) => keys.flatMap(key => (section?.[key] || []).map(entry => normalize(entry.name)));
export const isProtectedClass = kind => kind === 'prd' || kind === 'conflict';
const RESTRICTED_PROBE_PATHS = ['/health', '/api/health', '/build-info'];

function classifyTargets(entries, apps, config) {
  const prd = new Set(namesIn(config.prd, CLASS_NAMES));
  const nonprd = new Set([...namesIn(config.qa, CLASS_NAMES), ...namesIn(config.test, CLASS_NAMES)]);
  const shared = new Set(namesIn(config.shared, ['resources', 'resourceGroups']));
  const patterns = (config.prd?.patterns || []).map(({ regex, scope }) => ({
    regex: new RegExp(regex, 'i'), scope
  }));
  return new Map(entries.map(({ name }) => {
    const app = apps.get(name);
    const appKey = typeof app === 'string' ? normalize(app) : null;
    const nameKey = normalize(name);
    const keys = appKey === null ? [nameKey] : [nameKey, appKey];
    const staging = (config.runningRefStaging || []).some(entry =>
      normalize(entry.name) === appKey && entries.every(declaration =>
        declaration.name !== name || declaration.health.url === entry.url));
    const prodHit = keys.some(key => prd.has(key)) || patterns.some(({ regex, scope }) =>
      regex.test(nameKey) || (appKey !== null && !(staging && scope === 'unlisted-names') && regex.test(appKey)));
    const nonprodHit = staging || keys.some(key => nonprd.has(key));
    const conflict = keys.some(key => shared.has(key)) || (prodHit && nonprodHit);
    return [name, conflict ? 'conflict' : prodHit ? 'prd' : nonprodHit ? 'nonprd' : 'unknown'];
  }));
}

function hostname(url) {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return host;
  const hi = Number.parseInt(mapped[1], 16);
  const lo = Number.parseInt(mapped[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

function refusePrdHosts(entries, envs, classes, names, selected, config) {
  const prdHosts = new Map(entries.filter(e => isProtectedClass(classes.get(e.name)))
    .map(e => [hostname(e.health.url), e.name]));
  const prdNames = new Set(namesIn(config.prd, ['apps', 'resources', 'deployTargets', 'databaseServers']));
  for (const name of names) {
    if (!selected && isProtectedClass(classes.get(name))) continue;
    const host = hostname(envs[name].health.url);
    const rawTarget = prdHosts.get(host);
    const prdName = [host, host.split('.')[0]].find(key => prdNames.has(key));
    if (rawTarget !== undefined || prdName !== undefined) {
      throw new Error(`RUNNING_REF_PRD_HOST: ${name} probes the same host as ${rawTarget !== undefined ? `prd target ${rawTarget}` : `prd name ${prdName}`}`);
    }
  }
}

export function probePlan(read, targets, azureTargetsFile) {
  const { entries, apps } = loadManifestEntries(read);
  const envs = mergeEnvironments(entries);
  const names = selectEnvironments(envs, targets);
  if (!names.length) return { envs, names, classes: new Map(), declared: [], omitted: [] };
  const config = readAzureTargets(azureTargetsFile);
  const classes = classifyTargets(entries, apps, config);
  const selected = targets !== undefined;
  const declared = Object.keys(envs);
  const omitted = declared.filter(name => !names.includes(name));
  if (selected) {
    const disallowed = (list, kind) => list.filter(name => classes.get(name) !== kind)
      .map(name => `${name} (${classes.get(name)})`);
    const badSelected = disallowed(names, 'nonprd');
    const badOmitted = disallowed(omitted, 'prd');
    const reasons = [];
    if (badSelected.length) reasons.push(`RUNNING_REF_SELECTED_NOT_NONPRD: ${badSelected.join(', ')}`);
    if (badOmitted.length) reasons.push(`RUNNING_REF_OMITTED_NOT_PRD: ${badOmitted.join(', ')}`);
    if (reasons.length) throw new Error(reasons.join(' | '));
  }
  refusePrdHosts(entries, envs, classes, names, selected, config);
  for (const name of names) {
    const kind = classes.get(name);
    if (kind !== 'unknown' && !isProtectedClass(kind)) continue;
    const { url } = envs[name].health;
    const parsed = new URL(url);
    // The serialized URL also retains empty query and fragment delimiters.
    if (!RESTRICTED_PROBE_PATHS.includes(parsed.pathname) || /[?#]/.test(parsed.href)) {
      if (kind === 'unknown') {
        throw new Error(`RUNNING_REF_UNCLASSIFIED_PATH: ${name} probes ${url}; unclassified targets may only GET /health, /api/health or /build-info (classify it in ~/.config/trioharness/azure-targets.json to probe another path)`);
      }
      throw new Error(`RUNNING_REF_PRD_PATH: ${name} probes ${url}; prd probes may only GET /health, /api/health or /build-info`);
    }
  }
  return { envs, classes, names, declared, omitted };
}
