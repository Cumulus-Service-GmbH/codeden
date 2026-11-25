import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Refusal, revisionSuffix } from './deploy.mjs';

const invalid = detail => new Refusal(`INPUT_INVALID: ${detail}`);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const matches = (pattern, value) => typeof value === 'string' && value.match(pattern)?.[0] === value;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byName = (a, b) => compare(a.name, b.name);
const sortedEnv = entries => [...entries].sort(byName);
const hex40 = /^[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;
const envName = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const armSegment = /^(?!\.{1,2}$)[A-Za-z0-9._()-]+$/;
const subscriptionGuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const formats = new Set(['hex64', 'hex40', 'generation', 'webPin']);
const secretName = /(secret|password|pwd|connection.?string|api.?key|token|credential)/i;
const exactKeys = (value, keys, optional = []) => object(value) &&
  keys.every(key => own(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));

export function parseStrictJson(input) {
  let text = input;
  if (Buffer.isBuffer(input)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      throw invalid('invalid UTF-8');
    }
  }
  if (typeof text !== 'string' || text.startsWith('\uFEFF')) throw invalid('invalid JSON encoding');

  const token = /[ \t\r\n]+|"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/y;
  let offset = 0;
  function next() {
    while (offset < text.length) {
      token.lastIndex = offset;
      const match = text.match(token);
      if (!match) throw invalid('invalid JSON token');
      offset = token.lastIndex;
      if (!/^[ \t\r\n]/.test(match[0])) return match[0];
    }
    return undefined;
  }

  let current = next();
  function take(expected) {
    if (current !== expected) throw invalid('invalid JSON structure');
    current = next();
  }

  function readValue() {
    if (current === '{') {
      take('{');
      const keys = new Set();
      if (current !== '}') {
        while (true) {
          if (!current?.startsWith('"')) throw invalid('invalid JSON object key');
          const key = JSON.parse(current);
          if (keys.has(key)) throw invalid('duplicate JSON key');
          keys.add(key);
          current = next();
          take(':');
          readValue();
          if (current !== ',') break;
          take(',');
        }
      }
      take('}');
    } else if (current === '[') {
      take('[');
      if (current !== ']') {
        readValue();
        while (current === ',') {
          take(',');
          readValue();
        }
      }
      take(']');
    } else {
      if (!current || /^[}\]:,]$/.test(current)) throw invalid('invalid JSON value');
      current = next();
    }
  }
  try {
    readValue();
    if (current !== undefined) throw invalid('trailing JSON data');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (error instanceof RangeError) throw invalid('JSON nesting exceeds parser capacity');
    throw invalid('invalid JSON');
  }
}

export function canonicalJson(value) {
  const ancestors = new Set();
  function serialize(data) {
    if (data === null || typeof data === 'boolean' || Number.isInteger(data)) return JSON.stringify(data);
    if (typeof data === 'string') {
      if (/[\uD800-\uDFFF]/u.test(data)) throw invalid('unpaired surrogate in canonical JSON');
      return JSON.stringify(data);
    }
    if ((!object(data) && !Array.isArray(data)) || ancestors.has(data)) throw invalid('unsupported canonical JSON value');
    ancestors.add(data);
    let result;
    if (Array.isArray(data)) {
      result = '[' + Array.from(data, serialize).join(',') + ']';
    } else {
      const prototype = Object.getPrototypeOf(data);
      if (prototype !== Object.prototype && prototype !== null) throw invalid('unsupported canonical JSON object');
      result = '{' + Object.keys(data).sort().map(key => serialize(key) + ':' + serialize(data[key])).join(',') + '}';
    }
    ancestors.delete(data);
    return result;
  }
  return serialize(value);
}

export const sha256Hex = data => createHash('sha256').update(data).digest('hex');

const volumeDeclKeys = ['name', 'aliasPrefix', 'vaultHost', 'vaultItem', 'identity', 'mountPath', 'path'];
const identityId = /^\/subscriptions\/[A-Za-z0-9._()-]+\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9._()-]+$/i;
const absolutePath = /^\/[^\0]*$/;
const fileName = /^(?!\.{1,2}$)[^/\\\0]+$/;
const webPin = target => target.build?.buildArgs?.WEB_BASE_SHA;
const healthPath = /^[^.\s]+(?:\.[^.\s]+)*$/;

function anchoredRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('^') || !pattern.endsWith('$')) return false;
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  // Only an unescaped outer anchor at each end guarantees anchoring across alternatives.
  let depth = 0;
  let inClass = false;
  for (let i = 1; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      i++;
      if (i === pattern.length - 1) return false;
    } else if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') inClass = true;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === '|' && depth === 0) return false;
  }
  return !inClass;
}

export function validateSettingsDecl(target, name) {
  const fail = detail => { throw new Refusal(`CONFIG_INVALID: ${name}: ${detail}`); };
  if (target?.type === 'containerapp' && own(target, 'slot')) fail('slot is not allowed for G7 containerapps');
  if (!matches(subscriptionGuid, target?.subscription)) fail('subscription must be a GUID');
  const settings = target?.settings;
  if (!exactKeys(settings, ['generationEnv', 'revocationEnv', 'env', 'envRefs', 'authorityVolume'], ['minExpiryHeadroomSeconds']) ||
      !Array.isArray(settings.env) || !Array.isArray(settings.envRefs)) fail('invalid settings shape');

  const names = new Set();
  function register(entry) {
    if (!matches(envName, entry.name) || names.has(entry.name.toLowerCase())) fail('invalid or duplicate env name');
    names.add(entry.name.toLowerCase());
  }
  for (const entry of settings.env) {
    if (!exactKeys(entry, ['name', 'format']) && !exactKeys(entry, ['name', 'equals'])) fail('invalid env validator shape');
    register(entry);
    if (secretName.test(entry.name)) fail('secret-like plain env name');
    if (own(entry, 'format') ? !formats.has(entry.format) : typeof entry.equals !== 'string') fail('invalid env validator');
    if (entry.format === 'webPin' && !matches(/^[0-9a-f]{40}$/i, webPin(target))) fail('invalid build web pin');
  }
  for (const entry of settings.envRefs) {
    if (!exactKeys(entry, ['name', 'aliasPattern']) || !anchoredRegex(entry.aliasPattern)) fail('invalid envRef validator');
    register(entry);
  }
  if (!settings.env.some(entry => entry.name === settings.generationEnv && entry.format === 'generation')) {
    fail('invalid generationEnv');
  }
  if (settings.revocationEnv === settings.generationEnv ||
      !settings.env.some(entry => entry.name === settings.revocationEnv && entry.format === 'generation')) {
    fail('invalid revocationEnv');
  }
  const vol = settings.authorityVolume;
  if (!exactKeys(vol, volumeDeclKeys) ||
      ![vol.name, vol.aliasPrefix].every(value => typeof value === 'string' && value.length > 0) ||
      !matches(/^[a-z0-9-]+\.vault\.azure\.net$/, vol.vaultHost) ||
      !matches(/^[A-Za-z0-9-]+$/, vol.vaultItem) || !matches(identityId, vol.identity) ||
      !matches(absolutePath, vol.mountPath) || !matches(fileName, vol.path)) fail('invalid authorityVolume');
  if (own(settings, 'minExpiryHeadroomSeconds')) {
    const seconds = settings.minExpiryHeadroomSeconds;
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) fail('invalid minExpiryHeadroomSeconds');
  }
  for (const key of ['expect', 'rollbackExpect']) {
    if (!target.health || !own(target.health, key)) continue;
    const map = target.health[key];
    if (!object(map) || Object.entries(map).some(([path, value]) =>
      !matches(healthPath, path) || typeof value !== 'string')) fail(`invalid health.${key}`);
  }
}

const isGeneration = value => matches(/^[1-9][0-9]{0,18}$/, value) && BigInt(value) <= 9223372036854775807n;
const envValidators = {
  hex40: value => matches(hex40, value),
  hex64: value => matches(hex64, value),
  generation: isGeneration,
  webPin: (value, target) => value === webPin(target),
};

function checkVolume(volume, decl, generation) {
  if (volume.alias !== decl.aliasPrefix + generation ||
      ['name', 'identity', 'mountPath', 'path'].some(key => volume[key] !== decl[key])) {
    throw invalid('secretVolume differs from declaration');
  }
  let uri;
  try {
    if (typeof volume.kvVersionedUri === 'string') uri = new URL(volume.kvVersionedUri);
  } catch {
    // An absent parsed URL fails the exact comparison below.
  }
  const version = uri?.pathname.split('/').at(-1);
  const expected = `https://${decl.vaultHost}/secrets/${decl.vaultItem}/${version}`;
  if (!matches(/^[0-9a-f]{32}$/, version) || uri.href !== expected || volume.kvVersionedUri !== expected) {
    throw invalid('invalid versioned vault URI');
  }
}

function checkExpiry(value, now, seconds) {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  const time = matches(pattern, value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw invalid('invalid expiry timestamp');
  }
  const current = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(current)) throw invalid('invalid current time');
  if (time < current + seconds * 1000) throw new Refusal('EXPIRY_HEADROOM');
}

export function parseRevisionInput(bytes, target, { now }) {
  const input = parseStrictJson(bytes);
  if (!exactKeys(input, ['schema', 'sourceSha', 'image', 'revisionSuffix', 'env', 'envRefs', 'secretVolume',
    'authorityReceiptSha256', 'expiresAtUtc']) || input.schema !== 1 ||
    !matches(hex40, input.sourceSha) || !exactKeys(input.image, ['digest']) ||
    !matches(/^sha256:[0-9a-f]{64}$/, input.image.digest) || !matches(hex64, input.authorityReceiptSha256) ||
    !Array.isArray(input.env) || !Array.isArray(input.envRefs) ||
    !exactKeys(input.secretVolume, ['name', 'alias', 'kvVersionedUri', 'identity', 'mountPath', 'path'])) {
    throw invalid('invalid revision input schema');
  }
  const settings = target.settings;
  const seen = new Set();
  for (const [entries, key] of [[input.env, 'value'], [input.envRefs, 'appRef']]) {
    for (const entry of entries) {
      if (!exactKeys(entry, ['name', key]) || !matches(envName, entry.name) || typeof entry[key] !== 'string') {
        throw invalid('invalid env entry');
      }
      const folded = entry.name.toLowerCase();
      if (seen.has(folded)) throw invalid('duplicate env name');
      seen.add(folded);
    }
  }
  for (const { name, value } of input.env) {
    if (/secretref:/i.test(value)) throw new Refusal('ENV_VALUE_RESERVED');
    const decl = settings.env.find(entry => entry.name === name);
    if (!decl) throw new Refusal('INPUT_NOT_DECLARED');
    const valid = own(decl, 'equals') ? decl.equals === value : envValidators[decl.format](value, target);
    if (!valid) throw invalid('env validator failed');
  }
  for (const { name, appRef } of input.envRefs) {
    const decl = settings.envRefs.find(entry => entry.name === name);
    if (!decl) throw new Refusal('INPUT_NOT_DECLARED');
    if (!matches(new RegExp(decl.aliasPattern), appRef)) throw invalid('envRef validator failed');
  }
  if (settings.env.some(({ name }) => !input.env.some(entry => entry.name === name))) {
    throw new Refusal('INPUT_INCOMPLETE');
  }
  const generation = input.env.find(entry => entry.name === settings.generationEnv)?.value;
  if (!isGeneration(generation) || input.revisionSuffix !== `${revisionSuffix(input.sourceSha)}-g${generation}`) {
    throw invalid('invalid generation or revision suffix');
  }
  checkVolume(input.secretVolume, settings.authorityVolume, generation);
  checkExpiry(input.expiresAtUtc, now, settings.minExpiryHeadroomSeconds ?? 3600);
  const normalized = { ...input, env: sortedEnv(input.env), envRefs: sortedEnv(input.envRefs) };
  return { input: normalized, generation, inputSha256: sha256Hex(canonicalJson(normalized)) };
}

export function checkAuthorityReceipt(receiptBytes, input) {
  const mismatch = () => { throw new Refusal('AUTHORITY_RECEIPT_MISMATCH'); };
  if (sha256Hex(receiptBytes) !== input.authorityReceiptSha256) mismatch();
  let receipt;
  try {
    const text = Buffer.isBuffer(receiptBytes) ? new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes) : receiptBytes;
    receipt = JSON.parse(text, (key, value, context) => {
      if (key !== 'generation' || typeof value !== 'number' || Number.isSafeInteger(value)) return value;
      // Preserve the exact integer lexeme when JSON numbers exceed the safe integer range.
      return context?.source ?? null;
    });
  } catch {
    return;
  }
  if (!object(receipt)) return;
  const generation = input.revisionSuffix.split('-g').at(-1);
  if (own(receipt, 'expiresAtUtc') && receipt.expiresAtUtc !== input.expiresAtUtc) mismatch();
  if (own(receipt, 'generation') &&
      (!['string', 'number'].includes(typeof receipt.generation) || String(receipt.generation) !== generation)) mismatch();
}

function resourceId(t) {
  return `/subscriptions/${t.subscription}/resourceGroups/${t.resourceGroup}/providers/Microsoft.App/containerApps/${t.app}`;
}

export function targetIdentity(target, name, _policyText) {
  return { name, resourceId: resourceId(target), containerName: target.container ?? null,
    policySha256: sha256Hex(canonicalJson(target)) };
}

export function normalizeTraffic(trafficJson) {
  const traffic = typeof trafficJson === 'string' ? parseStrictJson(trafficJson) : trafficJson;
  if (!Array.isArray(traffic)) throw invalid('traffic must be an array');
  return traffic.map(entry => {
    if (!object(entry)) throw invalid('invalid traffic entry');
    const { revisionName = null, label = null, latestRevision = false, weight = 0 } = entry;
    if ((revisionName !== null && typeof revisionName !== 'string') ||
        (label !== null && typeof label !== 'string') || typeof latestRevision !== 'boolean' ||
        !Number.isInteger(weight)) throw invalid('invalid traffic entry');
    return { revisionName, label, latestRevision, weight };
  }).sort((a, b) => compare(a.revisionName ?? '', b.revisionName ?? '') || compare(a.label ?? '', b.label ?? ''));
}

export const trafficEquals = (a, b) => isDeepStrictEqual(normalizeTraffic(a), normalizeTraffic(b));
export const plannedTraffic = name => [{ revisionName: name, label: null, latestRevision: false, weight: 100 }];

export function matchesPlannedTraffic(observed, planned, before) {
  const map = normalizeTraffic(observed);
  const destination = planned[0]?.revisionName;
  return trafficEquals(map.filter(item => item.weight > 0), planned) &&
    map.every(item => item.label === null && !item.latestRevision &&
      (item.weight > 0 || (item.weight === 0 && item.revisionName &&
        (item.revisionName === destination || before.some(prior => prior.revisionName === item.revisionName)))));
}

export function envelope({ action, opId, target, expected, args }) {
  const normalizedExpected = { ...expected, traffic: normalizeTraffic(expected.traffic) };
  if (own(expected, 'activeRevisions')) normalizedExpected.activeRevisions = [...expected.activeRevisions].sort();
  const normalizedArgs = { ...args };
  if (Array.isArray(args.resultingTraffic)) normalizedArgs.resultingTraffic = normalizeTraffic(args.resultingTraffic);
  for (const key of ['protectedRevisions', 'revisions']) {
    if (Array.isArray(args[key])) normalizedArgs[key] = [...args[key]].sort();
  }
  if (args.input) {
    normalizedArgs.input = { ...args.input, env: sortedEnv(args.input.env), envRefs: sortedEnv(args.input.envRefs) };
  }
  return { schema: 1, action, ...(opId === undefined ? {} : { opId }), target, expected: normalizedExpected, args: normalizedArgs };
}

export const actionP64 = env => sha256Hex(canonicalJson(env));
export function planIds({ opId: _opId, ...withoutOpId }) {
  const opId = 'op-' + actionP64(withoutOpId).slice(0, 12);
  const withId = { ...withoutOpId, opId };
  return { opId, p64: actionP64(withId), envelope: withId };
}
export const x4Phrase = (app, action, opId, p64) => `${app}:${action}:${opId}:${p64}`;

const volumeKeys = ['storageType', 'storageName', 'mountOptions', 'secrets'];
const volumeMapping = (decl, alias) => [{ secretRef: alias, path: decl.path }];
const omitNulls = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));

export function normalizeVolumes(volumes) {
  if (!Array.isArray(volumes)) return volumes;
  return volumes.map(volume => {
    const copy = omitNulls(volume);
    if (Array.isArray(copy.secrets)) {
      copy.secrets = copy.secrets.map(omitNulls).sort((a, b) =>
        compare(a.path ?? '', b.path ?? '') || compare(a.secretRef ?? '', b.secretRef ?? ''));
    }
    return copy;
  }).sort(byName);
}

export function volumePatchBody(existingVolumes, decl, alias, candidateSuffix) {
  const fail = () => { throw new Refusal('VOLUME_SHAPE_UNKNOWN'); };
  if (!Array.isArray(existingVolumes)) fail();
  const names = new Set();
  const volumes = [];
  for (const vol of existingVolumes) {
    if (!exactKeys(vol, ['name'], volumeKeys) || typeof vol.name !== 'string' || names.has(vol.name)) fail();
    names.add(vol.name);
    for (const [key, value] of Object.entries(vol)) {
      if (key === 'secrets') {
        if (value !== null && (!Array.isArray(value) || value.some(item => !exactKeys(item, ['secretRef', 'path']) ||
          Object.values(item).some(field => field !== null && typeof field !== 'string')))) fail();
      } else if (value !== null && typeof value !== 'string') fail();
    }
    if (vol.name !== decl?.name) volumes.push(vol);
  }
  if (decl) volumes.push({ name: decl.name, storageType: 'Secret', secrets: volumeMapping(decl, alias) });
  return { properties: { template: { revisionSuffix: candidateSuffix + '-v', volumes: normalizeVolumes(volumes) } } };
}

export function volumePatchNeeded(existingVolumes, decl, alias) {
  const vol = existingVolumes.find(entry => entry.name === decl.name);
  return !isDeepStrictEqual(vol?.secrets, volumeMapping(decl, alias));
}

export const X4_ARM_API_VERSION = '2025-07-01';

export function volumePatchArgs(target, bodyFile) {
  if (!matches(subscriptionGuid, target.subscription) ||
      ![target.resourceGroup, target.app].every(segment => matches(armSegment, segment)) ||
      !matches(/^\/[^\s@\0]+$/, bodyFile)) throw invalid('invalid patch target or body path');
  return ['rest', '--method', 'PATCH', '--url', `https://management.azure.com${resourceId(target)}?api-version=${X4_ARM_API_VERSION}`,
    '--body', '@' + bodyFile, '-o', 'none', '--only-show-errors'];
}

const appArgs = t => ['--subscription', t.subscription, '--resource-group', t.resourceGroup, '--name', t.app];

export function x4UpdateArgs(target, imageRef, suffix, input) {
  return ['containerapp', 'update', ...appArgs(target), '--image', imageRef, '--revision-suffix', suffix, '--set-env-vars',
    ...sortedEnv(input.env).map(({ name, value }) => `${name}=${value}`),
    ...sortedEnv(input.envRefs).map(({ name, appRef }) => `${name}=secretref:${appRef}`),
    ...(target.container ? ['--container-name', target.container] : []), '-o', 'none', '--only-show-errors'];
}

function containerPath(t) {
  if (t.container && !matches(/^[A-Za-z0-9_.-]+$/, t.container)) throw new Refusal('CONFIG_INVALID: invalid container name');
  return `properties.template.containers${t.container ? `[?name=='${t.container}'] | [0]` : '[0]'}`;
}

const mountProjection = path => path + '.volumeMounts[].{volumeName:volumeName,mountPath:mountPath}';
const queryArgs = query => ['--query', query, '-o', 'json'];
const appQuery = (t, query) => ['containerapp', 'show', ...appArgs(t), '--query', query, '-o', 'json'];
export const appVaultRefsArgs = t => appQuery(t, 'properties.configuration.secrets[].{name:name,keyVaultUrl:keyVaultUrl,identity:identity}');
export const appVolumesArgs = t => appQuery(t, 'properties.template.volumes');
export const appMountsArgs = t => appQuery(t, mountProjection(containerPath(t)));
export const appLatestArgs = t => appQuery(t, '{latest:properties.latestRevisionName}');

export function revisionMetaArgs(t, rev) {
  const path = containerPath(t);
  const query = `{image:${path}.image,env:${path}.env[].{name:name,secretRef:secretRef},volumes:properties.template.volumes,mounts:${mountProjection(path)},active:properties.active,prov:properties.provisioningState,fqdn:properties.fqdn}`;
  return ['containerapp', 'revision', 'show', ...appArgs(t), '--revision', rev, ...queryArgs(query)];
}

export const revisionListArgs = t => ['containerapp', 'revision', 'list', ...appArgs(t), '--all',
  ...queryArgs('[].{name:name,active:properties.active,weight:properties.trafficWeight}')];

// Named container selectors are validated against the target's exact argv.
export const X4_ALLOWED_QUERIES = new Set([
  'properties.configuration.ingress.traffic',
  '{mode:properties.configuration.activeRevisionsMode,containers:properties.template.containers[].name}',
  'properties.template.containers[0].image',
  ...[appVaultRefsArgs, appVolumesArgs, appMountsArgs, appLatestArgs, revisionMetaArgs, revisionListArgs]
    .map(builder => { const args = builder({}, 'revision'); return args[args.indexOf('--query') + 1]; }),
]);

function aliasMatches(vaultRefs, input) {
  const { alias, kvVersionedUri, identity } = input.secretVolume;
  return Array.isArray(vaultRefs) && vaultRefs.some(entry =>
    entry.name === alias && entry.keyVaultUrl === kvVersionedUri && entry.identity === identity);
}

function mountMatches(mounts, decl) {
  return Array.isArray(mounts) && mounts.some(mount =>
    mount.volumeName === decl.name && mount.mountPath === decl.mountPath);
}

export function checkAlias(vaultRefs, input) {
  if (!aliasMatches(vaultRefs, input)) throw new Refusal('ALIAS_NOT_PROVISIONED');
}

export function checkMount(mounts, decl) {
  if (!mountMatches(mounts, decl)) throw new Refusal('VOLUME_MOUNT_NOT_PROVISIONED');
}

export function checkEnvCase(existingEnvNames, input) {
  const names = new Map([...input.env, ...input.envRefs].map(entry => [entry.name.toLowerCase(), entry.name]));
  for (const existing of existingEnvNames) {
    const name = names.get(existing.toLowerCase());
    if (name !== undefined && name !== existing) throw new Refusal('ENV_NAME_CASE_COLLISION');
  }
}

export function checkRevisionSettings({ before, after, input, decl, imageRef, expectedVolumes, vaultBefore, vaultAfter }) {
  const mismatch = new Set();
  const env = new Map((after.env ?? []).map(entry => [entry.name, entry]));
  if (after.image !== imageRef) mismatch.add('image');
  const declared = new Set([...input.env, ...input.envRefs].map(({ name }) => name));
  for (const { name } of input.env) if (!env.has(name) || env.get(name).secretRef != null) mismatch.add(name);
  for (const { name, appRef } of input.envRefs) if (env.get(name)?.secretRef !== appRef) mismatch.add(name);
  for (const { name, secretRef } of before.env ?? []) {
    if (!declared.has(name) && (!env.has(name) || (secretRef != null && env.get(name).secretRef !== secretRef))) mismatch.add(name);
  }
  if (!isDeepStrictEqual(normalizeVolumes(after.volumes), normalizeVolumes(expectedVolumes))) mismatch.add('volumes');
  if (!mountMatches(after.mounts, decl)) mismatch.add(decl.name);
  for (const entry of vaultBefore) {
    if (!vaultAfter.some(current => isDeepStrictEqual(current, entry))) mismatch.add(entry.name);
  }
  if (!aliasMatches(vaultAfter, input)) mismatch.add(input.secretVolume.alias);
  if (mismatch.size) throw new Refusal('REVISION_SETTINGS_MISMATCH: ' + [...mismatch].sort().join(', '));
}

export function checkHealthExpect(body, expectMap = {}, vars = {}) {
  for (const [path, template] of Object.entries(expectMap)) {
    const value = path.split('.').reduce((current, key) =>
      current && typeof current === 'object' && own(current, key) ? current[key] : undefined, body);
    const expected = template.replaceAll('{webPin}', () => vars.webPin ?? '{webPin}');
    if (value !== expected) throw new Refusal(`HEALTH_EXPECT_MISMATCH: ${path}`);
  }
}

export const X4_STEPS = Object.freeze([
  'intent', 'built', 'intermediate', 'revision-created', 'verified', 'deactivated',
  'switched', 'rolled-back', 'withdrawn', 'cleaned', 'recovered', 'failed',
]);

export const X4_STATES = Object.freeze([
  'intermediate-only', 'staged-unverified', 'intermediate-left', 'switch-applied-unrecorded',
  'switch-not-applied', 'deactivate-pending', 'deactivate-done-unrecorded',
  'rollback-applied-unrecorded', 'rollback-not-applied', 'drift', 'staged', 'switched',
  'withdrawn', 'cleaned', 'rolled-back', 'failed-before-write', 'built', 'deactivated',
  'recovered', 'failed', 'intent', 'verified',
]);

export function reconcile({ entries, observed, op }) {
  const drift = () => ({ state: 'drift', step: null, revisions: [] });
  const result = (state, step = null, ...names) => X4_STATES.includes(state)
    ? { state, step, revisions: [...new Set(names.filter(Boolean))].sort() } : drift();
  const entry = entries.at(-1);
  const { args, expected } = op;
  const planned = args.resultingTraffic;
  if (!observed.readable || !entry || !Array.isArray(observed.traffic) || !object(observed.revisions) ||
      (Array.isArray(observed.labels) ? observed.labels.length : observed.labels) ||
      observed.traffic.some(item => !object(item) || item.label != null)) return drift();
  const beforeTraffic = trafficEquals(observed.traffic, expected.traffic);
  const afterTraffic = Array.isArray(planned) && matchesPlannedTraffic(observed.traffic, planned, expected.traffic);
  if (!beforeTraffic && !afterTraffic) return drift();

  const { action, step, write } = entry;
  const { candidateRevision, intermediateRevision, restoreRevision, retireRevision } = args;
  const revision = name => name && own(observed.revisions, name) ? observed.revisions[name] : {};
  const intermediate = revision(intermediateRevision);
  const candidate = revision(candidateRevision);
  const exactLatest = intermediate.exists && intermediate.matchesExpected && intermediate.latest;
  const stage = action === 'stage' || action === 'renew-authority';
  const finishStage = () => result('intermediate-only', 'finish-stage', intermediateRevision, candidateRevision);
  const reverify = () => result('staged-unverified', 'reverify-stage', candidateRevision, intermediateRevision);
  const intent = step === 'intent';
  const lastVerified = entries.findLastIndex(item => item.step === 'verified');
  if (step === 'failed' && !entries.slice(lastVerified + 1).some(item => item.write)) return result('failed-before-write');
  if (intent && stage && write === 'volume-patch') {
    if (!intermediate.exists) {
      const beforeLatest = entry.beforeLatest ?? entry.before?.latest;
      return entry.azReturned === false && beforeTraffic && beforeLatest && observed.latest === beforeLatest
        ? result('failed-before-write') : drift();
    }
    return exactLatest && intermediate.weight === 0 ? finishStage() : drift();
  }
  if (step === 'intermediate' || (intent && write === 'update')) {
    if (candidate.exists) return reverify();
    if (intent && stage && !intermediateRevision && entry.azReturned === false && beforeTraffic && entry.before?.latest && observed.latest === entry.before.latest)
      return result('failed-before-write');
    return exactLatest ? finishStage() : drift();
  }
  if (step === 'revision-created') return reverify();
  if ((step === 'verified' && stage) || (intent && stage && write === 'deactivate')) {
    return intermediate.active
      ? result('intermediate-left', 'deactivate-intermediate', intermediateRevision)
      : result('staged');
  }
  if (step === 'switch-intent' || (intent && action === 'switch' && write === 'traffic')) {
    if (afterTraffic && observed.candidateHealthy) return result('switch-applied-unrecorded', 'record-switch', candidateRevision);
    return beforeTraffic ? result('switch-not-applied') : drift();
  }
  if (step === 'rollback-intent' || (intent && action === 'rollback' && write === 'traffic')) {
    if (afterTraffic && observed.restoreHealthy) return result('rollback-applied-unrecorded', 'record-rollback', restoreRevision);
    return beforeTraffic ? result('rollback-not-applied') : drift();
  }
  if (intent && (action === 'withdraw' || action === 'cleanup')) {
    const retire = revision(retireRevision);
    if (retire.active === true && retire.weight === 0) return result('deactivate-pending', 'retry-deactivate', retireRevision);
    if (retire.active === false) return result('deactivate-done-unrecorded', 'record-deactivated', retireRevision);
    return drift();
  }
  return result(step);
}

export function hasAzDiagnosticFlags(args) {
  return args.some(arg => /^--(?:debug|verbose)(?:=|$)/.test(arg));
}

export function stripAzLoggerFlags(args) {
  return args.filter(arg => arg !== '--only-show-errors');
}


const azValueOptions = new Set([
  '--body', '--build-arg', '--container-name', '--file', '--image', '--method', '--name',
  '-o', '--output', '--registry', '--resource-group', '--revision', '--revision-suffix',
  '--revision-weight', '--set-env-vars', '--slot', '--src-path', '--subscription', '--target-slot', '--type', '--url', '--query',
]);

export function azCommandWords(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string') || hasAzDiagnosticFlags(args)) return null;
  const firstOption = args.findIndex(arg => arg.startsWith('-'));
  if (!args.length || firstOption === 0) return null;
  if (firstOption === -1) return args;
  const command = args.slice(0, firstOption);
  for (let i = firstOption + 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-') || arg.includes('=') || azValueOptions.has(args[i - 1])) continue;
    // ACR build takes one trailing source context after the output format or final build argument.
    if (i === args.length - 1 && command.length === 2 && command[0] === 'acr' && command[1] === 'build' &&
        ((args[i - 2] === '--build-arg' && args[i - 1].includes('=')) ||
         (args[i - 2] === '--output' && args[i - 1] === 'json'))) continue;
    return null;
  }
  return command;
}
