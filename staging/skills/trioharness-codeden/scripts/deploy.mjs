#!/usr/bin/env node
// TrioHarness Lean — repo-agnostic direct Azure deploy (no CI pipelines).
// All repo specifics live in <repo>/.trioharness/deploy.json (see templates/deploy.json); this script has none.
// Target types: "webapp" (App Service ZIP deploy) and "containerapp" (az acr build at the SHA + az containerapp update).
// Usage: node deploy.mjs --target <name> [--sha <sha>] [--repo .] [--dry-run] [--rollback | --stage-only | --switch-traffic <revision-or-slot> [--percent <1..100>]] [--allow-overwrite <running sha12> [--run <id> --ledger <main checkout>]]
//        [--allow-unreadable <target>]  (a person only: deploy although the running commit cannot be read)
//        [--config-from-worktree]       (a person only, bootstrap: use the working tree's deploy.json, not the default branch's)
// 2.35: the targets (and so who may deploy) come from .trioharness/deploy.json ON THE DEFAULT BRANCH, never from the branch being deployed.
// H3: this script never runs git fetch. A person runs `git fetch <remote>` first; the script compares `git ls-remote --heads --refs` with the local
//     tracking refs and refuses REMOTE_REF_STALE / REMOTE_REF_UNREADABLE. History is append-only (history.d/<NNNNNN>.json, exclusive create) and the
//     legacy history.json is read only; the webapp ZIP is written create-only and its path is recorded in the history entry.
// Exit: 0 deployed and verified · 2 refused or verification failed · 3 error
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isMain } from './is-main.mjs';
import { validRunId } from './ids.mjs';
import { gitCommonDir, readVerifiedRecord } from './running-ref-mac.mjs';
import { appendFailure } from './issues-failure-log.mjs';
import { azCommandWords, stripAzLoggerFlags, validateSettingsDecl } from './deploy-x4.mjs';
import { runX4Main } from './deploy-x4-run.mjs';

export const CONFIG_PATH = '.trioharness/deploy.json';
// Environment variables that mark an agent process. Production also requires an interactive terminal.
export const DEFAULT_AGENT_MARKERS = ['OPENCODE_CONFIG_CONTENT', 'CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'TRIOHARNESS_AGENT'];
const FORBIDDEN_BUILD = /\b(database\s+update|migrate|migration\s+apply|db\s+push)\b/i;
const SECRET_KEY = /(secret|password|pwd|connection.?string|api.?key|token|credential)/i;

export class Refusal extends Error {}

export function loadConfig(repo) {
  const file = join(repo, CONFIG_PATH);
  if (!existsSync(file)) throw new Refusal(`NO_DEPLOY_CONFIG: ${CONFIG_PATH} missing; ask the user for targets, never guess`);
  const cfg = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  validateConfig(cfg);
  return cfg;
}

// 2.35: the default branch is what origin/HEAD points at (cumulus/main, release, …), not a fixed name.
export function defaultBranchOf(git, remote = 'origin') {
  try {
    const ref = git('symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`);
    return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : null;
  } catch { return null; }
}

// 2.35: deploy rights are a recorded decision on the default branch. A deploy.json that exists only on the branch
// being deployed (or in a working tree) cannot declare a target or switch agentAllowed on. `git` is injected: (...args) -> stdout.
export function loadConfigFromRef(git, ref) {
  let text;
  try { text = git('show', `${ref}:${CONFIG_PATH}`); }
  catch { throw new Refusal(`NO_DEPLOY_CONFIG_ON_DEFAULT: ${CONFIG_PATH} does not exist on ${ref}. Deploy targets are authorized only by the default branch's deploy.json: merge it first (a person bootstrapping may pass --config-from-worktree)`); }
  let cfg;
  try { cfg = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Refusal(`CONFIG_INVALID: ${CONFIG_PATH} on ${ref} is not valid JSON`); }
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg) {
  if (cfg?.schema !== 1 || typeof cfg.targets !== 'object') throw new Refusal('CONFIG_INVALID: need {"schema":1,"targets":{...}}');
  const walk = (v, path) => {
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY.test(k)) throw new Refusal(`CONFIG_HAS_SECRET_FIELD: ${path}${k} — use az login or a service principal, never secrets in config`);
      walk(x, `${path}${k}.`);
    }
  };
  walk(cfg, '');
  const g7Targets = [];
  for (const [name, t] of Object.entries(cfg.targets)) {
    const type = t.type || 'webapp';
    if (!['webapp', 'containerapp'].includes(type)) throw new Refusal(`CONFIG_INVALID: targets.${name}.type must be webapp or containerapp`);
    if (![undefined, true, false, 'with-authorization'].includes(t.agentAllowed)) throw new Refusal(`CONFIG_INVALID: targets.${name}.agentAllowed must be true, false or "with-authorization"`);
    for (const f of ['subscription', 'resourceGroup', 'app']) if (typeof t[f] !== 'string' || !t[f]) throw new Refusal(`CONFIG_INVALID: targets.${name}.${f} required`);
    if (Object.hasOwn(t, 'revisionCleanup')) {
      const c = t.revisionCleanup;
      if (type !== 'containerapp' || !c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !['quietDays', 'keepPrevious'].includes(k)) ||
          !Number.isInteger(c.quietDays) || c.quietDays < 1 || c.quietDays > 365 ||
          (c.keepPrevious !== undefined && (!Number.isInteger(c.keepPrevious) || c.keepPrevious < 1 || c.keepPrevious > 10)))
        throw new Refusal(`CONFIG_INVALID: targets.${name}.revisionCleanup needs quietDays (1..365) and optional keepPrevious (1..10, default 2), containerapp only`);
    }
    if (type === 'webapp') {
      if (typeof t.outputDir !== 'string' || !t.outputDir) throw new Refusal(`CONFIG_INVALID: targets.${name}.outputDir required`);
      if (!Array.isArray(t.build) || !t.build.length) throw new Refusal(`CONFIG_INVALID: targets.${name}.build must list build steps`);
      for (const step of t.build) {
        if (typeof step.command !== 'string' || !Array.isArray(step.args || [])) throw new Refusal(`CONFIG_INVALID: targets.${name}.build step needs command and args[]`);
        if (FORBIDDEN_BUILD.test([step.command, ...(step.args || [])].join(' '))) throw new Refusal(`MIGRATION_IN_BUILD: targets.${name} — deploys never run database migrations`);
      }
    } else {
      for (const f of ['registry', 'image']) if (typeof t[f] !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(t[f])) throw new Refusal(`CONFIG_INVALID: targets.${name}.${f} required (letters, digits, . _ / -)`);
      if (t.container !== undefined && t.container !== null && t.container !== '' && (typeof t.container !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(t.container)))
        throw new Refusal(`CONFIG_INVALID: targets.${name}.container must match ^[a-z0-9][a-z0-9-]*$`);
      if (typeof t.build?.dockerfile !== 'string' || !t.build.dockerfile) throw new Refusal(`CONFIG_INVALID: targets.${name}.build.dockerfile required`);
      if (FORBIDDEN_BUILD.test(JSON.stringify(t.build))) throw new Refusal(`MIGRATION_IN_BUILD: targets.${name} — deploys never run database migrations`);
      if (t.build.buildArgsFromApp !== undefined && (typeof t.build.buildArgsFromApp !== 'object' || Array.isArray(t.build.buildArgsFromApp))) throw new Refusal(`CONFIG_INVALID: targets.${name}.build.buildArgsFromApp must map build args to app environment variable names`);
      for (const [arg, appVar] of Object.entries(t.build.buildArgsFromApp || {})) {
        validateBuildArgName(appVar);
        if (SECRET_KEY.test(String(appVar)) || SECRET_KEY.test(String(arg))) throw new Refusal(`BUILD_ARG_IS_SECRET: targets.${name}.build.buildArgsFromApp.${arg} ← ${appVar} names a secret; build arguments are baked into the image and logged by the registry, so they must be non-secret`);
      }
      if (Object.hasOwn(t, 'settings')) {
        validateSettingsDecl(t, name);
        if (g7Targets.some(alias => sameContainerApp(alias, t)))
          throw new Refusal(`CONFIG_INVALID: targets.${name} duplicates a G7 containerapp declaration`);
        g7Targets.push(t);
      }
      if (t.promoteFrom !== undefined && typeof t.promoteFrom !== 'string') throw new Refusal(`CONFIG_INVALID: targets.${name}.promoteFrom must be a target name`);
    }
    if (!t.health?.url || !t.health?.shaField) throw new Refusal(`CONFIG_INVALID: targets.${name}.health.url and shaField required (the app must report its commit SHA)`);
  }
}

export function isAgent(env = process.env, markers = DEFAULT_AGENT_MARKERS) {
  return markers.some(m => Object.hasOwn(env, m));
}

export const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

export function azDeployArgs(t, zipPath) {
  const args = ['webapp', 'deploy', '--subscription', t.subscription, '--resource-group', t.resourceGroup, '--name', t.app,
    '--src-path', zipPath, '--type', 'zip', '--only-show-errors'];
  if (t.slot) args.push('--slot', t.slot);
  return args;
}

const webappArgs = t => ['--subscription', t.subscription, '--resource-group', t.resourceGroup, '--name', t.app];

export function webappHostnameArgs(t, slot) {
  return ['webapp', 'show', ...webappArgs(t), ...(slot ? ['--slot', slot] : []), '--query', 'defaultHostName', '-o', 'tsv'];
}

export function webappSlotListArgs(t) {
  return ['webapp', 'deployment', 'slot', 'list', ...webappArgs(t), '--query', '[].name', '-o', 'json'];
}

export function webappSlotSwapArgs(t, slot) {
  return ['webapp', 'deployment', 'slot', 'swap', ...webappArgs(t), '--slot', slot, '--target-slot', 'production', '--only-show-errors'];
}

export function acrBuildArgs(t, sha, extraArgs = {}) {
  const args = ['acr', 'build', '--subscription', t.subscription, '--registry', t.registry, '--image', `${t.image}:${sha}`,
    '--file', t.build.dockerfile, '--no-logs', '--output', 'json'];
  for (const [k, v] of Object.entries({ ...(t.build.buildArgs || {}), ...extraArgs })) args.push('--build-arg', `${k}=${fill(v, { sha })}`);
  args.push(t.build.context || '.');
  return args;
}

// D2: the image digest is read from this build's own ACR run record (az acr build --output json), never from the mutable tag.
export function parseDigest(text) {
  const d = String(text ?? '').trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(d)) throw new Refusal('DIGEST_UNREADABLE: expected sha256:<64 hex digits>');
  return d;
}

export const pinnedImageRef = (loginServer, image, digest) => `${loginServer}/${image}@${digest}`;

export function acrRunDigest(runJsonText, { loginServer, image, sha }) {
  const unreadable = why => new Refusal(`ACR_RUN_UNREADABLE: ${why}; nothing was deployed`);
  let run;
  try { run = JSON.parse(String(runJsonText)); } catch { throw unreadable('az acr build did not return a JSON run record'); }
  if (!run || typeof run.runId !== 'string' || !run.runId) throw unreadable('the run record has no runId');
  if (run.status !== 'Succeeded') throw unreadable(`run ${run.runId} has status ${JSON.stringify(run.status)}, not Succeeded`);
  const hits = (Array.isArray(run.outputImages) ? run.outputImages : []).filter(o => o && loginServer && o.registry === loginServer && o.repository === image && o.tag === sha);
  if (hits.length !== 1) throw unreadable(`run ${run.runId} has ${hits.length} output image(s) for ${image}:${sha.slice(0, 12)}, expected exactly one`);
  let digest;
  try { digest = parseDigest(hits[0].digest); } catch { throw unreadable(`run ${run.runId} reports no valid digest for ${image}:${sha.slice(0, 12)}`); }
  return { runId: run.runId, digest };
}

export function containerappUpdateArgs(t, imageRef) {
  const args = ['containerapp', 'update', '--subscription', t.subscription, '--resource-group', t.resourceGroup, '--name', t.app, '--image', imageRef, '--only-show-errors'];
  if (t.container) args.push('--container-name', t.container);
  return args;
}

// A revision suffix must be lowercase alphanumerics/dashes; derive it from the SHA so it is traceable.
export const revisionSuffix = sha => `r${String(sha).slice(0, 8).toLowerCase()}`;

export function containerappUpdateWithRevisionArgs(t, imageRef, sha) {
  return [...containerappUpdateArgs(t, imageRef), '--revision-suffix', revisionSuffix(sha)];
}

export function containerappTrafficSetArgs(t, revisionName, percent = 100, previousRevision = null) {
  return ['containerapp', 'ingress', 'traffic', 'set', '--subscription', t.subscription, '--resource-group', t.resourceGroup,
    '--name', t.app, '--revision-weight', `${revisionName}=${percent}`,
    ...(percent < 100 ? [`${previousRevision}=${100 - percent}`] : []), '--only-show-errors'];
}

export function containerappRevisionListArgs(t) {
  return ['containerapp', 'revision', 'list', '--subscription', t.subscription, '--resource-group', t.resourceGroup,
    '--name', t.app, '--all', '--query', '[].name', '-o', 'json'];
}

function trafficWeights(trafficJson) {
  const entries = JSON.parse(trafficJson);
  return entries.map(entry => JSON.stringify([entry.revisionName, entry.label, entry.latestRevision === true, entry.weight ?? 0])).sort().join('\n');
}

// Which revision currently serves traffic, and the revision names in play.
export function containerappTrafficQueryArgs(t) {
  return ['containerapp', 'show', '--subscription', t.subscription, '--resource-group', t.resourceGroup, '--name', t.app,
    '--query', 'properties.configuration.ingress.traffic', '-o', 'json'];
}

export function servingRevision(trafficJson) {
  let traffic = [];
  try { traffic = JSON.parse(trafficJson) || []; } catch { return null; }
  const serving = traffic.filter(t => (t.weight ?? 0) > 0).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
  return serving ? (serving.revisionName || (serving.latestRevision ? 'latest' : null)) : null;
}

// D2 preflight: traffic must be pinned to exactly one explicitly named revision at 100% (zero-weight extras allowed, no latest-revision routing).
// Unlike servingRevision this refuses split, latest and unreadable traffic instead of picking the heaviest entry.
export function pinnedTrafficRevision(trafficJson) {
  const bad = why => new Refusal(`TRAFFIC_NOT_PINNED: ${why}; the app must pin 100% of traffic to one named revision (nothing was changed)`);
  let traffic;
  try { traffic = JSON.parse(trafficJson); } catch { throw bad('the traffic configuration is not readable'); }
  if (!Array.isArray(traffic) || !traffic.length || traffic.some(e => !e || typeof e !== 'object')) throw bad('the traffic configuration has no usable entries');
  if (traffic.some(e => e.latestRevision === true)) throw bad('traffic is routed to the latest revision');
  const live = traffic.filter(e => (e.weight ?? 0) !== 0);
  if (live.length !== 1 || live[0].weight !== 100) throw bad('traffic is split or not at 100% on one entry');
  if (typeof live[0].revisionName !== 'string' || !live[0].revisionName) throw bad('the entry holding traffic names no revision');
  return live[0].revisionName;
}

// D2 preflight: Multiple revisions mode and one container, read-only; settings are never changed to satisfy it.
export function containerappShapeArgs(t) {
  return ['containerapp', 'show', '--subscription', t.subscription, '--resource-group', t.resourceGroup, '--name', t.app,
    '--query', '{mode:properties.configuration.activeRevisionsMode,containers:properties.template.containers[].name}', '-o', 'json'];
}

export function checkAppShape(shapeJson, t = {}) {
  const unsafe = why => new Refusal(`APP_SHAPE_UNSAFE: ${why}; a deploy needs Multiple revisions mode and exactly one container (nothing was changed)`);
  let shape;
  try { shape = JSON.parse(shapeJson); } catch { throw unsafe('the app configuration is not readable'); }
  if (shape?.mode !== 'Multiple') throw unsafe(`revisions mode is ${JSON.stringify(shape?.mode ?? null)}`);
  const names = Array.isArray(shape.containers) ? shape.containers : [];
  if (names.length !== 1) throw unsafe(`the template has ${names.length} container(s)`);
  if (t.container && names[0] !== t.container) throw unsafe(`the template container is ${JSON.stringify(names[0])}, not ${JSON.stringify(t.container)}`);
}

// D2 promotion: the source history entry must record a digest, and the revision the source serves now (with its configured image) must be the one that entry verified.
// Called without `observed` it checks the entry alone; with { serving, image } it also compares what the source serves.
export function promotionSourceAssociation(verified, promoteFrom, sha, observed = null) {
  if (!verified?.digest) throw new Refusal(`PROMOTE_SOURCE_NO_DIGEST: the verified deploy of ${String(sha).slice(0, 12)} on ${promoteFrom} recorded no image digest (deployed before digest pinning); redeploy it there through this script first`);
  if (!observed) return verified;
  const { serving, image } = observed;
  const digestOk = (() => { try { return parseDigest(verified.digest) === verified.digest && String(verified.image).endsWith(`@${verified.digest}`); } catch { return false; } })();
  if (!digestOk || !verified.revision || serving !== verified.revision || image !== verified.image)
    throw new Refusal(`PROMOTE_SOURCE_DIGEST_MISMATCH: ${promoteFrom} serves revision ${serving} with image ${image || 'unreadable'}, but its history verified revision ${verified.revision || 'none'} with image ${verified.image}; nothing was changed`);
  return verified;
}

// D2: the new revision must be configured with exactly the pinned reference before it can get any traffic.
export function checkRevisionImage(revision, revisionImage, imageRef) {
  if (revisionImage !== imageRef) throw new Refusal(`REVISION_IMAGE_MISMATCH: ${revision} is configured with ${revisionImage || 'no readable image'}, expected ${imageRef}; traffic was never switched`);
}

// The history entry of a forward deploy or promotion, with its full provenance.
// A webapp deploy also records the absolute path of the ZIP actually written (`artifact`); rollback uses it. Other targets omit it.
export function deployHistoryEntry({ sha, imageRef, digest, runId, imageTag, previousImage, revision, previousRevision, promoteFrom, authorization, verified, at, artifact, intent, cleanup, staged }) {
  return { sha, image: imageRef, digest, runId, imageTag, previousImage, revision, previousRevision, promotedFrom: promoteFrom, authorized: authorization ? true : undefined, at, rollback: false, verified,
    ...(typeof artifact === 'string' && artifact ? { artifact } : {}), ...(intent === true ? { intent: true } : {}), ...(cleanup ? { cleanup } : {}), ...(staged === true ? { staged: true } : {}) };
}

// ---- H3: append-only history ------------------------------------------------------------------------------------------------------------------
// <artifacts>/history.json is the legacy array: read only, never opened for writing. Each new entry is its own file <artifacts>/history.d/<NNNNNN>.json
// holding a JSON array with exactly one plain object, created exclusively (flag wx) with one write and never replaced. Order: legacy array, then numeric order.
export const HISTORY_DIR = 'history.d';
export const HISTORY_NAME = /^\d{6}\.json$/;
export const HISTORY_MAX_SEQ = 999999;
export const HISTORY_COLLISION_RETRIES = 20;
export const HISTORY_WINDOW = 10;
const fsIo = { existsSync, mkdirSync, readFileSync, readdirSync, statSync, openSync, writeSync, closeSync };
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const unreadableEntry = (path, why) => new Refusal(`HISTORY_ENTRY_UNREADABLE: ${path} ${why}; nothing was changed and the entry was not skipped, repaired or removed`);

// The last ten entries, in memory only. Every entry stays on disk; the latest is still .at(-1).
export function recentHistory(entries) {
  if (!Array.isArray(entries)) throw new Refusal('HISTORY_ENTRY_UNREADABLE: the history is not a list of entries');
  const laterRevisions = new Set();
  return entries.slice().reverse().filter(entry => {
    if (!isPlainObject(entry)) throw new Refusal('HISTORY_ENTRY_UNREADABLE: a history entry is not a plain object');
    const hasRevision = typeof entry.revision === 'string' && entry.revision.length > 0;
    const superseded = entry.intent === true && hasRevision && laterRevisions.has(entry.revision);
    if (hasRevision) laterRevisions.add(entry.revision);
    return !superseded;
  }).reverse().slice(-HISTORY_WINDOW);
}

export const historyEntryName = seq => `${String(seq).padStart(6, '0')}.json`;

// Validates every name in a history.d listing and returns [{ seq, name }] in numeric order. Any other name refuses; none is skipped.
export function historySequence(names, dir = HISTORY_DIR) {
  const out = [];
  for (const name of names) {
    if (!HISTORY_NAME.test(name)) throw unreadableEntry(join(dir, String(name)), 'is not a history entry name (expected NNNNNN.json)');
    out.push({ seq: Number(name.slice(0, 6)), name });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export function nextHistorySeq(sequence) {
  const next = (sequence.length ? sequence[sequence.length - 1].seq : 0) + 1;
  if (next > HISTORY_MAX_SEQ) throw new Refusal(`HISTORY_WRITE_CONFLICT: the next history number ${next} is above ${HISTORY_MAX_SEQ}; nothing was written`);
  return next;
}

export function parseHistoryEntry(text, path) {
  let v;
  try { v = JSON.parse(String(text)); } catch { throw unreadableEntry(path, 'is empty, incomplete or not valid JSON'); }
  if (!Array.isArray(v) || v.length !== 1 || !isPlainObject(v[0])) throw unreadableEntry(path, 'is not a JSON array holding exactly one entry object');
  return v[0];
}

// All entries in order (legacy array first). Reads only; creates nothing. Apply recentHistory to select from it.
export function readHistory(artifacts, io = fsIo) {
  const out = [];
  const legacy = join(artifacts, 'history.json');
  if (io.existsSync(legacy)) {
    const list = JSON.parse(io.readFileSync(legacy, 'utf8'));
    if (!Array.isArray(list)) throw unreadableEntry(legacy, 'is not a JSON array');
    out.push(...list);
  }
  const dir = join(artifacts, HISTORY_DIR);
  if (!io.existsSync(dir)) return out;
  for (const { name } of historySequence(io.readdirSync(dir), dir)) {
    const path = join(dir, name);
    let text;
    try { text = io.readFileSync(path, 'utf8'); } catch (e) { throw unreadableEntry(path, `cannot be read (${e.code || e.message})`); }
    out.push(parseHistoryEntry(text, path));
  }
  return out;
}

// Both writers below create the file with flag wx, which fails with EEXIST instead of touching an existing file; only EEXIST moves on to the next name.
// singleWrite (history entries): exactly one writeSync call. A short write refuses HISTORY_ENTRY_UNREADABLE and the file is retained as written: no second write, nothing is deleted.
// Otherwise (artifacts) the write continues until all bytes are out, and a call that makes no progress is an error rather than an endless loop.
function writeNew(io, path, data, { singleWrite = false } = {}) {
  const fd = io.openSync(path, 'wx');
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (singleWrite) {
      const n = io.writeSync(fd, buf, 0, buf.length);
      if (n !== buf.length) throw unreadableEntry(path, `was written short (${n} of ${buf.length} bytes); it is retained as is and no second write was made`);
      return;
    }
    let off = 0;
    while (off < buf.length) {
      const n = io.writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new Error(`write to ${path} made no progress at byte ${off} of ${buf.length}`);
      off += n;
    }
  } finally { io.closeSync(fd); }
}

// Appends one entry as history.d/<NNNNNN>.json. The directory is first created here (not by reading, dry-run or a preflight refusal).
// Next number is max existing + 1; on EEXIST only it retries with the next number, at most HISTORY_COLLISION_RETRIES times. Returns the path written.
export function appendHistoryEntry(artifacts, entry, io = fsIo) {
  if (!isPlainObject(entry)) throw new Refusal('HISTORY_ENTRY_UNREADABLE: the entry to record is not a plain object');
  const dir = join(artifacts, HISTORY_DIR);
  io.mkdirSync(dir, { recursive: true });
  let seq = nextHistorySeq(historySequence(io.readdirSync(dir), dir));
  const text = JSON.stringify([entry], null, 2);
  for (let retry = 0; ; retry++) {
    const path = join(dir, historyEntryName(seq));
    try { writeNew(io, path, text, { singleWrite: true }); return path; }
    catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      if (retry >= HISTORY_COLLISION_RETRIES || seq + 1 > HISTORY_MAX_SEQ) throw new Refusal(`HISTORY_WRITE_CONFLICT: ${path} and the next ${retry} number(s) already exist; nothing was overwritten`);
      seq += 1;
    }
  }
}

// ---- App identity and read-only legacy attribution ---------------------------------------------------------------------------------------------
const normalized = value => String(value ?? '').trim().toLowerCase();
export const sameContainerApp = (a, b) =>
  normalized(a.type || 'webapp') === 'containerapp' && normalized(b.type || 'webapp') === 'containerapp' &&
  normalized(a.resourceGroup) === normalized(b.resourceGroup) && normalized(a.app) === normalized(b.app);
export const appHistoryIdentity = t => [normalized(t.type || 'webapp'), normalized(t.subscription), normalized(t.resourceGroup), normalized(t.app), normalized(t.slot || '')];
const appHistorySlug = app => app.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
export function appHistoryKey(target) {
  const identity = appHistoryIdentity(target);
  const slug = appHistorySlug(identity[3]);
  return `${slug}-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16)}`;
}
export const appHistoryDir = (target, home = homedir()) => join(home, '.trioharness-lean', 'app-history', appHistoryKey(target));

function checkHistoryIdentity(dir, target, io = fsIo) {
  const path = join(dir, 'identity.json');
  if (!io.existsSync(path)) return;
  try { if (JSON.stringify(JSON.parse(io.readFileSync(path, 'utf8'))) === JSON.stringify(appHistoryIdentity(target))) return; } catch { /* refuse unreadable identities too */ }
  throw new Refusal(`HISTORY_IDENTITY_MISMATCH: ${path} does not identify the configured app; nothing was changed`);
}

export function findRecordedX4History(target, io = fsIo) {
  if (target.type !== 'containerapp') return;
  const root = dirname(appHistoryDir(target));
  try { io.statSync(root); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    return { name: `${root} unreadable`, reason: 'unreadable' };
  }
  let folders;
  try { folders = io.readdirSync(root, { withFileTypes: true }); }
  catch { return { name: `${root} unreadable`, reason: 'unreadable' }; }
  const slug = appHistorySlug(normalized(target.app));
  for (const folder of folders) {
    const { name } = folder;
    const dir = join(root, name);
    try { if (!io.statSync(dir).isDirectory()) continue; }
    catch (error) {
      if (error?.code === 'ENOENT' && !folder.isSymbolicLink()) continue;
      return { name, reason: 'unreadable' };
    }
    let recorded;
    try { recorded = JSON.parse(io.readFileSync(join(dir, 'identity.json'), 'utf8')); }
    catch { /* identity is unknown */ }
    if (!Array.isArray(recorded) || recorded.length !== 5 || !recorded.every(part => typeof part === 'string')) {
      if (name.match(/^(.+)-[0-9a-f]{16}$/)?.[1] !== slug) continue;
      const { entries, unreadable } = readLegacyHistory(dir, io);
      if (unreadable) return { name, reason: 'unreadable' };
      if (entries.some(entry => Object.hasOwn(entry, 'op'))) return { name, reason: 'op' };
      continue;
    }
    const [type, , resourceGroup, app] = recorded;
    // Match by group and app like the alias rule, so a subscription respelling cannot bypass the refusal.
    if (!sameContainerApp({ type, resourceGroup, app }, target)) continue;
    try {
      if (readHistory(dir, io).some(entry => Object.hasOwn(entry, 'op'))) return { name, reason: 'op' };
    } catch { return { name, reason: 'unreadable' }; }
  }
}

const isForeignRevision = (revision, app) => {
  if (typeof revision !== 'string') return false;
  const parts = revision.split('--');
  return parts.length !== 2 || parts[0].toLowerCase() !== app;
};

// Pure attribution decision. Own directories need no positive revision evidence, but never absorb a foreign revision.
export function classifyLegacyHistory({ entries, own, target, commitExists, unreadable = false, identityConflict = false }) {
  const identity = appHistoryIdentity(target), container = identity[0] === 'containerapp';
  if ((!own && !container) || (!entries.length && !unreadable)) return 'unrelated';
  const revisions = entries.filter(isPlainObject).filter(e => typeof e.revision === 'string');
  if (revisions.some(e => isForeignRevision(e.revision, identity[3]))) return own ? 'ambiguous' : 'foreign-app';
  if (!own && !revisions.length) return 'unrelated';
  if ((!own && identityConflict) || unreadable || entries.some(e => !isPlainObject(e) || (Object.hasOwn(e, 'sha') && !commitExists(e.sha)))) return 'ambiguous';
  return 'attributed';
}

const migrationId = e => JSON.stringify([e.migratedFrom?.dir, e.migratedFrom?.index]);
const canonicalValue = value => Array.isArray(value) ? value.map(canonicalValue)
  : isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])])) : value;
export const legacyEntryHash = entry => createHash('sha256').update(JSON.stringify(canonicalValue(entry))).digest('hex');
const monotoneHistory = entries => {
  let last = -Infinity;
  for (const entry of entries) {
    const time = dateMs(entry.at);
    if (Number.isFinite(time)) { if (time < last) return false; last = time; }
  }
  return true;
};

// Pure view construction: source order is validated before the first migration's timestamp merge.
// Store order is never changed. Hashes refer to the ORIGINAL source entry, before artifact recovery.
export function buildHistoryView(store, sources) {
  if (store.some(e => !isPlainObject(e))) throw unreadableEntry('app history', 'contains a non-object entry');
  const present = new Map(), hashOwners = new Map(), ignored = new Map();
  let ambiguous = false, nonmonotoneSource = false;
  const reject = (source, reason) => { ambiguous = true; if (!ignored.has(source.dir)) ignored.set(source.dir, reason); };
  for (const entry of store.filter(e => e.migratedFrom)) {
    const id = migrationId(entry), { hash, dir } = entry.migratedFrom;
    if (present.has(id) && present.get(id).migratedFrom.hash !== hash) ambiguous = true;
    present.set(id, entry);
    if (hash) {
      if (hashOwners.has(hash) && hashOwners.get(hash) !== dir) ambiguous = true;
      else hashOwners.set(hash, dir);
    }
  }
  let groups = [];
  for (const source of sources) {
    if (source.classification === 'ambiguous') reject(source, source.reason || 'ambiguous');
    if (source.classification === 'foreign-app' && source.own) reject(source, 'foreign-app-own-dir');
    const records = source.entries.map((entry, index) => ({ ...entry,
      migratedFrom: { dir: source.dir, index, hash: source.hashes?.[index] || legacyEntryHash(entry) } }));
    const imported = [...present.values()].filter(e => e.migratedFrom.dir === source.dir);
    if (imported.some(e => !e.migratedFrom.hash || records[e.migratedFrom.index]?.migratedFrom.hash !== e.migratedFrom.hash)) reject(source, 'source-changed');
    if (source.classification !== 'attributed' || ignored.has(source.dir)) continue;
    if (!monotoneHistory(source.entries)) { nonmonotoneSource = true; reject(source, 'source-nonmonotone'); continue; }
    if (records.some(e => hashOwners.has(e.migratedFrom.hash) && hashOwners.get(e.migratedFrom.hash) !== source.dir)) {
      reject(source, 'duplicate-content'); continue;
    }
    for (const e of records) hashOwners.set(e.migratedFrom.hash, source.dir);
    const entries = records.filter(e => !present.has(migrationId(e)));
    if (entries.length) groups.push({ source, entries });
  }
  if (nonmonotoneSource) {
    // A multi-source sort must never turn a backwards rollback/retirement sequence into usable evidence.
    for (const group of groups) reject(group.source, 'migration-blocked');
    groups = [];
  }
  if (store.length || groups.length > 1) {
    groups = groups.filter(group => {
      if (group.entries.every(e => Number.isFinite(dateMs(e.at)))) return true;
      reject(group.source, 'invalid-time'); return false;
    });
  }
  if (store.length) {
    const last = store.slice().reverse().find(e => Number.isFinite(dateMs(e.at)));
    let floor = last ? dateMs(last.at) : -Infinity;
    groups = groups.filter(group => {
      if (group.entries.some(e => dateMs(e.at) < floor)) { reject(group.source, 'older-than-store'); return false; }
      floor = dateMs(group.entries.at(-1).at); return true;
    });
  }
  let pending = groups.flatMap(group => group.entries);
  if (!store.length && groups.length > 1) pending.sort((a, b) => dateMs(a.at) - dateMs(b.at));
  let entries = [...store, ...pending];
  if (entries.some(e => e.migratedFrom) && !monotoneHistory(entries)) {
    ambiguous = true;
    for (const group of groups) reject(group.source, 'view-nonmonotone');
    pending = []; entries = store.slice();
  }
  return { entries, pending, ambiguous, ignored: [...ignored].map(([dir, reason]) => ({ dir, reason })) };
}

// Recover readable evidence for classification, but mark the whole source ambiguous when any history file fails H3 validation.
// Also used to look for X4 entries in stores with unknown identity. History loading for the app store stays strict.
function readLegacyHistory(dir, sourceIo = fsIo) {
  let unreadable = false;
  const entries = [];
  const io = { ...sourceIo,
    readdirSync(path) {
      const names = sourceIo.readdirSync(path);
      // Keep collecting evidence from readable files, but never import this source if a name is invalid.
      return names.filter(name => { if (HISTORY_NAME.test(name)) return true; unreadable = true; return false; });
    },
    readFileSync(path, encoding) {
      try {
        const text = sourceIo.readFileSync(path, encoding), list = JSON.parse(text);
        if (!Array.isArray(list)) throw new Error();
        entries.push(...list.filter(isPlainObject));
        if (list.some(e => !isPlainObject(e)) || (HISTORY_NAME.test(basename(path)) && list.length !== 1)) throw new Error();
        return text;
      } catch { unreadable = true; return '[{}]'; }
    }
  };
  try { readHistory(dir, io); } catch { unreadable = true; }
  return { entries, unreadable };
}

export function loadAppHistory({ repo, targetName, target, cfg, git, home = homedir(), io = fsIo, log = s => process.stderr.write(s), reported = new Set() }) {
  const dir = appHistoryDir(target, home), key = appHistoryKey(target);
  checkHistoryIdentity(dir, target, io);
  const store = readHistory(dir, io);
  const identity = appHistoryIdentity(target);
  const identityConflict = Object.values(cfg.targets).some(other => {
    const theirs = appHistoryIdentity(other);
    return theirs[0] === identity[0] && theirs[3] === identity[3] && appHistoryKey(other) !== key;
  });
  const root = join(home, '.trioharness-lean', 'artifacts'), own = join(basename(repo), targetName);
  const dirs = new Set([own]);
  if (identity[0] === 'containerapp' && io.existsSync(root)) {
    for (const folder of io.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      let targets;
      try { targets = io.readdirSync(join(root, folder.name), { withFileTypes: true }); }
      catch (e) { if (folder.name === basename(repo)) throw unreadableEntry(join(root, own), 'its parent directory cannot be read'); throw e; }
      for (const t of targets.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) dirs.add(join(folder.name, t.name));
    }
  }
  const commits = new Map();
  const commitExists = sha => {
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) return false;
    if (!commits.has(sha)) {
      try { git('cat-file', '-e', `${sha}^{commit}`); commits.set(sha, true); } catch { commits.set(sha, false); }
    }
    return commits.get(sha);
  };
  const sources = [...dirs].map(rel => {
    const path = join(root, rel), isOwn = rel === own;
    let source;
    if (isOwn) {
      try {
        if (io.existsSync(path)) io.readdirSync(path); // refuse an unreadable own directory as well as unreadable entry files
        const entries = readHistory(path, io);
        if (entries.some(e => !isPlainObject(e))) throw unreadableEntry(path, 'contains a non-object entry');
        source = { entries, unreadable: false };
      } catch (e) { throw e instanceof Refusal ? e : unreadableEntry(path, 'cannot be read as valid history'); }
    } else source = readLegacyHistory(path, io);
    const classification = classifyLegacyHistory({ ...source, own: isOwn, target, commitExists, identityConflict });
    const hashes = source.entries.map(legacyEntryHash);
    const entries = source.entries.map(e => {
      if (identity[0] !== 'webapp' || Object.hasOwn(e, 'artifact') || typeof e.sha !== 'string') return e;
      const artifact = resolve(path, `${e.sha}.zip`);
      return io.existsSync(artifact) ? { ...e, artifact } : e;
    });
    const reason = isOwn && source.entries.some(e => isForeignRevision(e.revision, identity[3])) ? 'foreign-app-own-dir'
      : !isOwn && identityConflict ? 'identity-conflict' : source.unreadable ? 'unreadable' : 'sha-not-in-repo';
    return { dir: rel, own: isOwn, entries, hashes, classification, reason };
  });
  const view = buildHistoryView(store, sources);
  for (const { dir: source, reason } of view.ignored) {
    const notice = JSON.stringify([key, source, reason]);
    if (!reported.has(notice)) { reported.add(notice); log(`DEPLOY: history: ${source} not imported (${reason})\n`); }
  }
  return { ...view, dir, key, target, options: { repo, targetName, target, cfg, git, home, io, log, reported } };
}

// One append path for rollback, intent and final results. Re-read immediately before persisting pending imports.
export function appendAppHistory(state, entry, { io = state.options.io || fsIo, log = state.options.log || (s => process.stderr.write(s)) } = {}) {
  const fresh = loadAppHistory({ ...state.options, io, log });
  io.mkdirSync(fresh.dir, { recursive: true });
  const identityPath = join(fresh.dir, 'identity.json');
  try { writeNew(io, identityPath, JSON.stringify(appHistoryIdentity(fresh.target)), { singleWrite: true }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; checkHistoryIdentity(fresh.dir, fresh.target, io); }
  const counts = new Map();
  for (const pending of fresh.pending) {
    appendHistoryEntry(fresh.dir, { ...pending, appIdentity: fresh.key }, io);
    counts.set(pending.migratedFrom.dir, (counts.get(pending.migratedFrom.dir) || 0) + 1);
  }
  for (const [dir, count] of counts) log(`DEPLOY: history: imported ${count} entries from ${dir}\n`);
  return appendHistoryEntry(fresh.dir, { ...entry, appIdentity: fresh.key }, io);
}

// ---- H3: create-only build artifact ------------------------------------------------------------------------------------------------------------
export const ARTIFACT_MAX_NAMES = 50;
// <sha>.zip, then <sha>.2.zip, <sha>.3.zip ...
export const artifactName = (sha, n = 1) => (n <= 1 ? `${sha}.zip` : `${sha}.${n}.zip`);

// Writes the ZIP bytes to the first name that does not exist (at most ARTIFACT_MAX_NAMES names, EEXIST only) and returns the absolute path actually written.
export function writeArtifactExclusive(bytes, dir, sha, io = fsIo) {
  for (let n = 1; n <= ARTIFACT_MAX_NAMES; n++) {
    const path = resolve(dir, artifactName(sha, n));
    try { writeNew(io, path, bytes); return path; }
    catch (e) { if (e?.code !== 'EEXIST') throw e; }
  }
  throw new Refusal(`ARTIFACT_WRITE_CONFLICT: ${artifactName(sha, 1)} through ${artifactName(sha, ARTIFACT_MAX_NAMES)} already exist in ${dir}; nothing was overwritten`);
}

// The ZIP a webapp rollback redeploys: the path the history recorded, or <sha>.zip only for a legacy entry that has no such field. No silent fallback.
export function rollbackArtifactPath(prev, artifacts) {
  if (!Object.hasOwn(prev, 'artifact')) return join(artifacts, `${prev.sha}.zip`);
  return typeof prev.artifact === 'string' && prev.artifact ? prev.artifact : null;
}

// ---- H3: remote freshness without git fetch ------------------------------------------------------------------------------------------------
// `git ls-remote --heads --refs <remote>` is compared with the local refs/remotes/<remote>/* tips. Exact refs only; the symbolic <remote>/HEAD alias is excluded.
const unreadableRef = why => new Refusal(`REMOTE_REF_UNREADABLE: ${why}; nothing was changed`);

export function parseRemoteHeads(text, remote = 'origin') {
  const heads = new Map();
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) throw unreadableRef(`${remote} advertised no branch heads`);
  for (const line of lines) {
    const m = /^([0-9a-f]{40}|[0-9a-f]{64})\s+(refs\/heads\/\S+)$/.exec(line);
    if (!m || heads.has(m[2])) throw unreadableRef(`the advertisement from ${remote} is malformed or repeats a ref (${JSON.stringify(line.slice(0, 120))})`);
    heads.set(m[2], m[1]);
  }
  return heads;
}

export function parseTrackingRefs(text, remote = 'origin') {
  const prefix = `refs/remotes/${remote}/`, tips = new Map();
  for (const line of String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)) {
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(line);
    if (!m || !m[2].startsWith(prefix)) throw unreadableRef(`the local tracking refs of ${remote} could not be parsed (${JSON.stringify(line.slice(0, 120))})`);
    if (m[2] !== `${prefix}HEAD`) tips.set(m[2], m[1]);
  }
  return tips;
}

// Returns the advertised tip when `branch` on `remote` is advertised and the local tracking ref points at that exact commit.
export function checkRemoteRef({ remote, branch, advertised, tracking }) {
  const tip = advertised.get(`refs/heads/${branch}`);
  if (!tip) throw unreadableRef(`${remote} does not advertise refs/heads/${branch}`);
  const local = tracking.get(`refs/remotes/${remote}/${branch}`);
  if (local !== tip) throw new Refusal(`REMOTE_REF_STALE: ${remote}/${branch} is ${local || 'missing'} locally but ${tip} on the remote. This script does not fetch: run "git fetch ${remote}" yourself, then retry. Nothing was changed`);
  return tip;
}

// A commit counts as pushed only through a branch whose local tracking tip equals its advertised tip. `containing` is the output of `git branch -r --contains <sha>`.
export function shaOnFreshRemote({ containing, remote, advertised, tracking }) {
  return String(containing ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith(`${remote}/`) && !l.includes(' -> ')).some(l => {
    const b = l.slice(remote.length + 1), tip = advertised.get(`refs/heads/${b}`);
    return !!tip && tracking.get(`refs/remotes/${remote}/${b}`) === tip;
  });
}

export function readAdvertisement(git, remote) {
  let text;
  try { text = git('ls-remote', '--heads', '--refs', remote); }
  catch (e) { throw unreadableRef(`git ls-remote ${remote} failed (${String(e?.message || e).split('\n')[0]})`); }
  return parseRemoteHeads(text, remote);
}

export function readTrackingRefs(git, remote) {
  let text;
  try { text = git('for-each-ref', '--format=%(objectname) %(refname)', `refs/remotes/${remote}`); }
  catch (e) { throw unreadableRef(`git for-each-ref refs/remotes/${remote} failed (${String(e?.message || e).split('\n')[0]})`); }
  return parseTrackingRefs(text, remote);
}

export function containerappRevisionShowArgs(t, revisionName) {
  return ['containerapp', 'revision', 'show', '--subscription', t.subscription, '--resource-group', t.resourceGroup,
    '--name', t.app, '--revision', revisionName, '--query', 'properties.fqdn', '-o', 'tsv'];
}

// The image a revision is configured with (what the pinned reference must equal).
export function containerappRevisionImageArgs(t, revisionName) {
  const idx = t.container ? `[?name=='${t.container}'] | [0]` : '[0]';
  return ['containerapp', 'revision', 'show', '--subscription', t.subscription, '--resource-group', t.resourceGroup,
    '--name', t.app, '--revision', revisionName, '--query', `properties.template.containers${idx}.image`, '-o', 'tsv'];
}

export function containerappEnvQueryArgs(t, name) {
  const idx = t.container ? `[?name=='${t.container}'] | [0]` : '[0]';
  if (name !== undefined) validateBuildArgName(name);
  const containers = `properties.template.containers${idx}`;
  const query = name === undefined
    ? `${containers}.env[].{name:name,secretRef:secretRef}`
    : `${containers}.env[?name=='${name}'] | [0].value`;
  return ['containerapp', 'show', '--subscription', t.subscription, '--resource-group', t.resourceGroup, '--name', t.app,
    '--query', query, '-o', name === undefined ? 'json' : 'tsv'];
}

function validateBuildArgName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_.-][A-Za-z0-9_.-]*$/.test(name))
    throw new Refusal(`BUILD_ARG_NAME_INVALID: ${JSON.stringify(name)} is not a valid app environment variable name`);
}

// Build values that live on the running app (client ids, tenant ids) are read at deploy time, never stored in config.
export function buildArgsFromAppEnv(map, envJson, readValue = (_name, entry) => entry.value) {
  let env;
  try { env = JSON.parse(envJson) || []; } catch { /* handled below */ }
  if (!Array.isArray(env)) throw new Refusal('APP_ENV_UNREADABLE: could not read the app env for build arguments');
  const mappings = Object.entries(map || {});
  const missing = name => new Refusal(`BUILD_ARG_MISSING_ON_APP: ${name} not found in the app's environment`);
  const values = new Map();
  for (const name of new Set(mappings.map(([, name]) => name))) {
    validateBuildArgName(name);
    const matches = env.filter(entry => entry?.name === name);
    if (matches.some(entry => entry.secretRef))
      throw new Refusal(`BUILD_ARG_IS_SECRET: ${name} is a secret reference on the app; build arguments must be non-secret`);
    if (!matches.length) throw missing(name);
    values.set(name, matches[0]);
  }
  for (const [name, entry] of values) {
    const value = readValue(name, entry);
    if (value === undefined || value === null || value === '') throw missing(name);
    values.set(name, value);
  }
  return Object.fromEntries(mappings.map(([arg, name]) => [arg, values.get(name)]));
}

// Dry-run and log output never shows resolved values, only which app variable each came from.
export const maskedBuildArgs = (map, resolved) => Object.fromEntries(Object.keys(resolved || {}).map(k => [k, map?.[k] ? `<from app env ${map[k]}>` : resolved[k]]));

// Health URL for one revision, so the new revision is verified at 0% traffic before any switch.
export function revisionHealthUrl(healthUrl, fqdn) {
  const u = new URL(healthUrl);
  return `https://${fqdn}${u.pathname}${u.search}`;
}

export function containerappImageQueryArgs(t) {
  const idx = t.container ? `[?name=='${t.container}'] | [0]` : '[0]';
  return ['containerapp', 'show', '--subscription', t.subscription, '--resource-group', t.resourceGroup, '--name', t.app,
    '--query', `properties.template.containers${idx}.image`, '-o', 'tsv'];
}

export function readRunningRefResolution(repo, runId, { ledgerDir = repo, keyFile } = {}) {
  try {
    if (ledgerDir !== repo && gitCommonDir(ledgerDir) !== gitCommonDir(repo)) return null;
    return readVerifiedRecord(ledgerDir, runId, { keyFile })?.resolved ?? null;
  } catch { return null; }
}

export const shaMatches = (reported, sha) => typeof reported === 'string' && /^[0-9a-f]{40}$/i.test(reported) && typeof sha === 'string' && reported.toLowerCase() === sha.toLowerCase();
const pick = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export async function readHealthSha(health, fetchImpl = fetch) {
  const res = await fetchImpl(health.url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { ok: false, status: res.status };
  const text = await res.text();
  let value;
  // shaField "." means the endpoint returns the SHA as plain text (first line of the body).
  if (health.shaField === '.') value = String(text).trim().split(/\r?\n/)[0];
  else { try { value = pick(JSON.parse(text), health.shaField); } catch { value = undefined; } }
  return { ok: true, sha: typeof value === 'string' ? value.trim() : undefined };
}

export async function waitForSha(health, sha, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const deadline = now() + (health.timeoutSeconds || 300) * 1000;
  let last = null;
  while (now() < deadline) {
    try { last = await readHealthSha(health, fetchImpl); if (last.ok && (sha === null || (Array.isArray(sha) ? sha.some(expected => shaMatches(last.sha, expected)) : shaMatches(last.sha, sha)))) return { verified: true, reported: last.sha }; } catch (e) { last = { error: e.message }; }
    await sleep(10000);
  }
  return { verified: false, last };
}

// Pure checks — every refusal rule lives here so it can be tested without git or az.
export const authorizationPhrase = (target, sha) => `${target.app}:${String(sha).slice(0, 12)}`;

// A rollback has its own phrase so the deploy phrase cannot be reused to switch traffic: <app>:rollback:<revision, or 12-character SHA>.
export const rollbackAuthorizationPhrase = (target, revisionOrSha) => {
  const v = String(revisionOrSha);
  return `${target.app}:rollback:${/^[0-9a-f]{40}$/i.test(v) ? v.slice(0, 12) : v}`;
};

// Same agent / non-TTY rule as checkPreconditions, for a rollback on a "with-authorization" target. Other modes are unchanged.
export function checkRollbackAuthorization({ target, targetName, revision, sha, env, isTTY, authorization = null }) {
  const phrase = rollbackAuthorizationPhrase(target, revision || sha);
  if (authorization !== null && authorization !== undefined && authorization !== phrase)
    throw new Refusal(`AUTHORIZATION_REQUIRED: --authorize does not match this ${targetName} rollback`);
  if (target.agentAllowed !== 'with-authorization') return;
  if (isAgent(env, target.agentMarkers || DEFAULT_AGENT_MARKERS) && authorization !== phrase)
    throw new Refusal(`AUTHORIZATION_REQUIRED: rolling back ${targetName} needs the user's per-rollback authorization — ask them to reply with exactly "${phrase}" and pass it as --authorize`);
  if (!isAgent(env, target.agentMarkers || DEFAULT_AGENT_MARKERS) && !isTTY && authorization !== phrase)
    throw new Refusal(`AUTHORIZATION_REQUIRED: pass --authorize "${phrase}" or run at an interactive terminal`);
}

export function checkPreconditions({ target, targetName, sha, env, isTTY, shaOnRemote, shaOnDefault, sameShaOn, authorization = null, phrase = authorizationPhrase(target, sha), cleanupNames = null }) {
  const cleanupText = cleanupNames === null ? '' : `; revision cleanup: ${cleanupNames.join(', ') || '(none)'}`;
  const markers = target.agentMarkers || DEFAULT_AGENT_MARKERS;
  const mode = target.agentAllowed === true ? 'agent' : target.agentAllowed === 'with-authorization' ? 'authorized' : 'user-only';
  const agent = isAgent(env, markers);
  if (mode === 'user-only' && agent) throw new Refusal(`AGENT_NOT_ALLOWED: ${targetName} is deployed only by the user`);
  if (mode === 'user-only' && !isTTY) throw new Refusal(`INTERACTIVE_REQUIRED: ${targetName} needs a human at an interactive terminal`);
  if (mode === 'authorized' && agent && authorization !== phrase)
    throw new Refusal(`AUTHORIZATION_REQUIRED: ${targetName} needs the user's per-deploy authorization — ask them to reply with exactly "${phrase}" and pass it as --authorize${cleanupText}`);
  if (mode === 'authorized' && !agent && !isTTY && authorization !== phrase)
    throw new Refusal(`AUTHORIZATION_REQUIRED: pass --authorize "${phrase}" or run at an interactive terminal${cleanupText}`);
  // An owner-approved phrase names one plan (sha, stage or cleanup set); never run a different plan under it, in any mode.
  if (authorization !== null && authorization !== undefined && authorization !== phrase)
    throw new Refusal(`AUTHORIZATION_REQUIRED: --authorize does not match this ${targetName} deploy plan${cleanupText}`);
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Refusal('SHA_INVALID: full 40-character commit SHA required');
  if (!shaOnRemote) throw new Refusal(`SHA_NOT_PUSHED: ${sha.slice(0, 12)} is not on any remote branch — push it first`);
  if (target.requireOnDefaultBranch && !shaOnDefault) throw new Refusal(`SHA_NOT_ON_DEFAULT: ${targetName} deploys only commits on the default branch`);
  if (target.requireSameShaOn && !sameShaOn) throw new Refusal(`PREREQUISITE_TARGET_MISMATCH: ${target.requireSameShaOn} does not currently report ${sha.slice(0, 12)}`);
}

export const LEGACY_AZ_POLICY = Object.freeze({
  banned: Object.freeze([
    'keyvault secret',
    'containerapp secret',
    'containerapp job secret',
    'acr credential',
    'acr token credential',
    'staticwebapp secrets',
    'staticwebapp appsettings',
    'storage account keys',
    'storage account show-connection-string',
    'config appsettings',
    'config connection-string',
    'config storage-account',
    'webapp auth',
    'functionapp auth',
    'functionapp keys',
    'function keys',
    'list-publishing-profiles',
    'list-publishing-credentials',
    'get-access-token',
    '--expose-token',
    '--show-values',
    'invoke-action',
    'rest',
    'containerapp exec',
    'webapp ssh',
    'webapp create-remote-connection',
    'graph query',
  ]),
  queries: Object.freeze([
    'defaultHostName',
    '[].name',
    'properties.configuration.ingress.traffic',
    '{mode:properties.configuration.activeRevisionsMode,containers:properties.template.containers[].name}',
    'properties.fqdn',
    'properties.template.containers[0].image',
    'properties.template.containers[0].env[].{name:name,secretRef:secretRef}',
    '[].{name:name,active:properties.active,created:properties.createdTime,weight:properties.trafficWeight}',
    '{latest:properties.latestRevisionName,maxInactive:properties.configuration.maxInactiveRevisions}',
    '{active:properties.active,state:properties.runningState,prov:properties.provisioningState}',
    'loginServer',
  ]),
});

export function normalizeLegacyAzQuery(query) {
  return query.replace(/^properties\.template\.containers\[\?name=='[a-z0-9][a-z0-9-]*'\] \| \[0\](?=\.)/,
    'properties.template.containers[0]');
}

export function checkLegacyAzArgv(args, appEnv) {
  const refuse = () => { throw new Refusal('AZ_ARGV_REFUSED'); };
  const command = azCommandWords(args);
  if (!command) refuse();
  args = stripAzLoggerFlags(args);
  if (LEGACY_AZ_POLICY.banned.some(family => {
    if (family.startsWith('--')) return args.some(arg => arg === family || arg.startsWith(family + '='));
    const parts = family.split(' ');
    let matched = 0;
    for (const word of command) {
      if (word === parts[matched] && ++matched === parts.length) return true;
    }
    return false;
  })) refuse();

  // Only the build-arg resolver supplies this context, after checking the app's env metadata.
  if (appEnv) {
    const { target, name } = appEnv;
    if (typeof name !== 'string' || SECRET_KEY.test(name) ||
        !Object.values(target?.build?.buildArgsFromApp ?? {}).includes(name) ||
        !isDeepStrictEqual(args, containerappEnvQueryArgs(target, name))) refuse();
    return;
  }

  const queries = args.flatMap((arg, i) => arg === '--query' ? [args[i + 1]]
    : arg.startsWith('--query=') ? [arg.slice('--query='.length)] : []);
  if ((queries.length || command.includes('show') || command.includes('list')) &&
      (queries.length !== 1 || typeof queries[0] !== 'string' ||
        !LEGACY_AZ_POLICY.queries.includes(normalizeLegacyAzQuery(queries[0])))) refuse();
}

function sh(cmd, args, opts, appEnv) {
  if (cmd === 'az') checkLegacyAzArgv(args, appEnv);
  return execCommand(cmd, args, opts);
}

function execCommand(cmd, args, opts = {}) {
  if (cmd === 'az') opts = { ...opts, env: { ...(opts.env ?? process.env), AZURE_LOGGING_ENABLE_LOG_FILE: 'no' } };
  const win = process.platform === 'win32';
  const q = a => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return win
    ? execFileSync([cmd, ...args].map(q).join(' '), { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024, ...opts })
    : execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024, ...opts });
}
function zipDir(dir, zipPath) {
  if (process.platform === 'win32') sh('tar', ['-a', '-c', '-f', zipPath, '-C', dir, '.']);
  else sh('zip', ['-q', '-r', zipPath, '.'], { cwd: dir });
}

async function confirmInteractive(app) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`Type the app name "${app}" to deploy to production: `);
  rl.close();
  if (answer.trim() !== app) throw new Refusal('CONFIRMATION_MISMATCH');
}

// 2.31: a deploy must never silently replace code the target runs that is not part of the SHA being deployed
// (an unmerged branch put on QA by hand, a hotfix, a build from a deleted branch). `git` is injected: (args[]) -> stdout.
// A person may override with --allow-overwrite <first 12 chars of the running SHA> (so a blind flag cannot be reused);
// an agent process additionally needs the user's recorded answer from the running-ref card for this very target and SHA.
export function overwriteRefusal({ targetName, liveSha, sha, git, allow = null, agent = false, resolution = null }) {
  if (typeof liveSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(liveSha.trim())) return null; // nothing usable is reported: verification handles it
  const live = liveSha.trim().toLowerCase();
  let full = null;
  try { full = git(['rev-parse', '--verify', '--quiet', `${live}^{commit}`]).trim() || null; } catch { /* unknown to this repository */ }
  let note;
  if (full) {
    if (full === sha) return null;
    try { git(['merge-base', '--is-ancestor', full, sha]); return null; } catch { /* not an ancestor: the running code would disappear */ }
    let n = '?'; try { n = git(['rev-list', '--count', `${sha}..${full}`]).trim(); } catch { /* informational */ }
    note = `${targetName} runs ${live.slice(0, 12)}, which is not part of ${sha.slice(0, 12)} (${n} commit(s) exist only in what runs there)`;
  } else note = `${targetName} runs ${live.slice(0, 12)}, a commit found in no branch of this repository`;
  const allowed = typeof allow === 'string' && allow.toLowerCase() === live.slice(0, 12);
  if (!allowed) return `WOULD_OVERWRITE_UNMERGED: ${note}. Deploying would replace it. Merge or promote that code first, or the user overrides with --allow-overwrite ${live.slice(0, 12)}`;
  if (agent && !(resolution?.choice === 'overwrite-ok' && (resolution.envs || []).includes(targetName) && resolution.shas?.[targetName] === live.slice(0, 12))) {
    return `OVERWRITE_NOT_AUTHORIZED: ${note}. An agent may override only after the user answered the running-ref card with "accept replacing it" for this target (running-ref.mjs resolve), recorded for this exact commit`;
  }
  return null;
}

// 2.35: when the target does not report a usable running commit, the overwrite check above cannot run, and a deploy
// would silently replace whatever is there (this is how an unmerged branch ended up in production unnoticed).
// So the deploy stops. Only a person may override, naming the target; an agent stops and asks the user.
const usableSha = v => typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v.trim());
export function unreadableRefusal({ targetName, live, allow = null, agent = false }) {
  if (live?.ok && usableSha(live.sha)) return null;
  const why = !live || live.error || (live.ok === undefined) ? 'its health endpoint is not reachable'
    : !live.ok ? `its health endpoint answered ${live.status ?? 'an error'}`
    : 'its health endpoint reports no commit SHA';
  if (!agent && allow === targetName) return null;
  const how = agent
    ? 'An agent must stop here and ask the user (a card): they can run the deploy themselves with --allow-unreadable, or fix the health endpoint first.'
    : `A person may deploy anyway with --allow-unreadable ${targetName}.`;
  return `RUNNING_REF_UNREADABLE: ${targetName}: ${why}, so the code running there cannot be compared with the SHA being deployed and might be replaced unseen. Nothing was changed. ${how}`;
}

const revisionNameOk = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
const cleanupConfig = cfg => ({ quietDays: cfg.quietDays, keepPrevious: cfg.keepPrevious ?? 2 });
const dateMs = value => typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
const cleanupRefused = reason => `REVISION_CLEANUP_REFUSED:${reason}`;

// Pure, deterministic planning. Full history proves retirement; only its newest window protects rollback identities.
export function planRevisionCleanup({ revisions, trafficEntries, serving, latest, history, protectedNames = [], previousRevision = null, now, cfg, maxInactive }) {
  const refuse = code => ({ deactivate: [], kept: [], refusal: code });
  if (!Number.isFinite(now) || !Array.isArray(revisions) || !Array.isArray(history) || history.some(h => !isPlainObject(h)) ||
      !Array.isArray(trafficEntries) || !revisionNameOk(serving) || !revisionNameOk(latest) ||
      trafficEntries.some(e => !isPlainObject(e) || !revisionNameOk(e.revisionName) || (e.weight !== undefined && (!Number.isFinite(e.weight) || e.weight < 0 || e.weight > 100)) ||
        (e.label != null && typeof e.label !== 'string') || e.latestRevision === true)) return refuse(cleanupRefused('snapshot'));
  if (!Number.isInteger(maxInactive) || maxInactive < 0) return refuse(cleanupRefused('maxInactiveRevisions'));
  const names = new Set();
  for (const r of revisions) {
    if (!isPlainObject(r) || !revisionNameOk(r.name) || names.has(r.name) || typeof r.active !== 'boolean' || !Number.isFinite(dateMs(r.created)) ||
        !Number.isFinite(r.weight) || r.weight < 0 || r.weight > 100) return refuse(cleanupRefused('inventory'));
    names.add(r.name);
  }
  const { quietDays, keepPrevious } = cleanupConfig(cfg), quietMs = quietDays * 86400000;
  const previous = new Set();
  for (const h of history.slice().reverse()) {
    if (previous.size >= keepPrevious) break;
    if (revisionNameOk(h.previousRevision)) previous.add(h.previousRevision);
  }
  if (revisionNameOk(previousRevision)) previous.add(previousRevision);
  const protectedSet = new Set([...protectedNames, ...previous]);
  for (const h of history.slice(Math.max(0, history.length - HISTORY_WINDOW)))
    for (const name of [h.revision, h.previousRevision]) if (revisionNameOk(name)) protectedSet.add(name);
  const labelled = new Set(trafficEntries.filter(e => e.label).map(e => e.revisionName));
  const traffic = new Set(trafficEntries.filter(e => e.weight > 0).map(e => e.revisionName));
  const kept = [], deactivate = [];
  for (const r of revisions.slice().sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    let reason = r.name === serving ? 'serving' : previous.has(r.name) ? 'previous' : r.name === latest ? 'latest'
      : labelled.has(r.name) ? 'labelled' : traffic.has(r.name) || r.weight > 0 ? 'traffic'
        : protectedSet.has(r.name) ? 'recorded-target' : now - dateMs(r.created) < quietMs ? 'young-created' : null;
    if (!reason) {
      let retired = NaN, retirementIndex = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (h.previousRevision === r.name && h.verified === true && h.rollback !== true && h.intent !== true && h.staged !== true && (!h.switched || h.percent === 100)) {
          retired = dateMs(h.at); retirementIndex = i; break;
        }
      }
      if (retirementIndex >= 0) {
        // Serving again invalidates this stop time. Only a newer verified forward retirement
        // (selected above) establishes new evidence; other previousRevision mentions only extend it.
        for (const h of history.slice(retirementIndex + 1)) {
          if (h.revision === r.name) retired = NaN;
          else if (h.previousRevision === r.name) retired = Math.max(retired, dateMs(h.at));
        }
      } else {
        const mentions = history.filter(h => h.revision === r.name || h.previousRevision === r.name);
        // Only verified stage destinations with no evidence of traffic can retire from their stage time.
        if (mentions.length && mentions.every(h => h.revision === r.name && h.previousRevision !== r.name &&
          h.staged === true && h.verified === true && !h.switched && !h.rollback && !h.intent)) {
          retired = mentions.reduce((latestStage, h) => Math.max(latestStage, dateMs(h.at)), -Infinity);
        } else if (!mentions.length) {
          const oldest = history[0], at = dateMs(oldest?.at);
          // An unfinished intent has not proved a switch away from a pre-history revision.
          if (oldest?.verified === true && oldest.rollback !== true && oldest.intent !== true && oldest.staged !== true && (!oldest.switched || oldest.percent === 100) && revisionNameOk(oldest.revision) && dateMs(r.created) < at) retired = at;
        }
      }
      reason = !Number.isFinite(retired) || retired > now ? 'retirement-unproven' : now - retired < quietMs ? 'young-retired' : null;
    }
    if (!r.active && !reason) reason = 'already-inactive';
    if (reason) kept.push({ name: r.name, reason }); else deactivate.push(r.name);
  }
  const inactive = revisions.filter(r => !r.active || deactivate.includes(r.name)).sort((a, b) => dateMs(a.created) - dateMs(b.created));
  const purgeCount = inactive.length - maxInactive;
  if (deactivate.length && purgeCount > 0) {
    const cutoff = dateMs(inactive[purgeCount - 1].created);
    if (inactive.some(r => dateMs(r.created) <= cutoff && protectedSet.has(r.name))) return { deactivate: [], kept, refusal: 'REVISION_CLEANUP_WOULD_PURGE_ROLLBACK_TARGET' };
  }
  return { deactivate, kept, refusal: null };
}

// The trusted placement (~/.config/trioharness/azure-targets.json prd.apps) for an app; a deploy that names another
// subscription or resource group for a pinned app is refused before any change.
// --authorize as supplied: null when absent; a present but empty value is refused, never treated as absent.
export function authorizeArgument(argv) {
  const i = argv.indexOf('--authorize');
  if (i < 0) return null;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new Refusal('AUTHORIZATION_REQUIRED: --authorize needs a non-empty value');
  return value;
}

export function checkTrustedPlacement(target, file = join(userInfo().homedir, '.config', 'trioharness', 'azure-targets.json')) {
  let pins;
  try { pins = JSON.parse(readFileSync(file, 'utf8')).prd?.apps; } catch { pins = null; }
  if (!Array.isArray(pins)) {
    if (target.agentAllowed === 'with-authorization') throw new Refusal(`PLACEMENT_UNVERIFIED: ${file} is unreadable or has no prd.apps; a protected target cannot be checked`);
    return;
  }
  const pin = pins.find(app => String(app?.name).toLowerCase() === String(target.app).toLowerCase());
  if (pin && (!pin.subscription || !pin.resourceGroup)) throw new Refusal(`PLACEMENT_UNVERIFIED: ${target.app}'s pin in ${file} lacks its subscription or resource group`);
  if (pin && (pin.subscription !== target.subscription || pin.resourceGroup !== target.resourceGroup))
    throw new Refusal(`PLACEMENT_MISMATCH: ${target.app} is pinned to ${pin.subscription}/${pin.resourceGroup} in azure-targets.json; the deploy target names ${target.subscription}/${target.resourceGroup}`);
}

export function revisionCleanupPhrase(targetName, target, sha, names) {
  const canonical = JSON.stringify({ target: targetName, app: target.app, subscription: target.subscription, resourceGroup: target.resourceGroup, revisionCleanup: cleanupConfig(target.revisionCleanup), deactivate: [...names].sort() });
  return `${authorizationPhrase(target, sha)}:cleanup-${createHash('sha256').update(canonical).digest('hex')}`;
}

const cleanupAppArgs = t => ['--subscription', t.subscription, '--resource-group', t.resourceGroup, '--name', t.app];
export const revisionCleanupListArgs = t => ['containerapp', 'revision', 'list', ...cleanupAppArgs(t), '--query', '[].{name:name,active:properties.active,created:properties.createdTime,weight:properties.trafficWeight}', '-o', 'json'];
export const revisionCleanupAppArgs = t => ['containerapp', 'show', ...cleanupAppArgs(t), '--query', '{latest:properties.latestRevisionName,maxInactive:properties.configuration.maxInactiveRevisions}', '-o', 'json'];
export const rollbackRevisionStateArgs = (t, revision) => ['containerapp', 'revision', 'show', ...cleanupAppArgs(t), '--revision', revision, '--query', '{active:properties.active,state:properties.runningState,prov:properties.provisioningState}', '-o', 'json'];
export function revisionActionArgs(t, action, revision) {
  if (action !== 'activate' && action !== 'deactivate') throw new Refusal('AZ_ARGV_REFUSED');
  return ['containerapp', 'revision', action, ...cleanupAppArgs(t), '--revision', revision, '--only-show-errors'];
}

// Never echo either stream, even when az fails. Only a boolean classification survives the captured error.
function capturedAz(args, { deadline = Date.now() + 120000, notFound = false } = {}) {
  checkLegacyAzArgv(args);
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error();
    return execCommand('az', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.min(120000, remaining) });
  } catch (e) {
    throw new Refusal(notFound && /ResourceNotFound|could not be found|not found/i.test(String(e.stderr || '') + String(e.stdout || '')) ? 'ROLLBACK_TARGET_PURGED' : cleanupRefused('az'));
  }
}

function readCleanupSnapshot(target, deadline) {
  try {
    const trafficText = capturedAz(containerappTrafficQueryArgs(target), { deadline });
    const trafficEntries = JSON.parse(trafficText), serving = pinnedTrafficRevision(trafficText);
    const revisions = JSON.parse(capturedAz(revisionCleanupListArgs(target), { deadline }));
    const app = JSON.parse(capturedAz(revisionCleanupAppArgs(target), { deadline }));
    if (!isPlainObject(app) || !revisionNameOk(app.latest)) throw new Error();
    if (!Number.isInteger(app.maxInactive) || app.maxInactive < 0) throw new Refusal(cleanupRefused('maxInactiveRevisions'));
    return { revisions, trafficEntries, serving, latest: app.latest, maxInactive: app.maxInactive };
  } catch (e) { throw new Refusal(e.message === cleanupRefused('maxInactiveRevisions') ? e.message : cleanupRefused('snapshot')); }
}

function runRevisionCleanup({ target, loadHistory, revision, previousRevision, preview }) {
  const out = { status: 'done', deactivated: [], kept: [], failed: [], at: new Date().toISOString() };
  const finish = (status, code) => {
    out.status = status;
    if (code) { out.code = code; process.stderr.write(`DEPLOY: ${code}\n`); }
    return out;
  };
  const deadline = Date.now() + 15 * 60 * 1000;
  let candidates = [];
  try {
    const history = loadHistory();
    if (history.entries.some(entry => Object.hasOwn(entry, 'op'))) return finish('refused', 'X4_HISTORY_PRESENT');
    if (target.agentAllowed === 'with-authorization' && preview?.refusal === 'REVISION_CLEANUP_PREVIEW_UNAVAILABLE')
      return finish('skipped', 'REVISION_CLEANUP_PREVIEW_UNAVAILABLE');
    const plan = snap => {
      const history = loadHistory();
      if (history.entries.some(entry => Object.hasOwn(entry, 'op')))
        return { deactivate: [], kept: [], refusal: 'X4_HISTORY_PRESENT' };
      return history.ambiguous ? { deactivate: [], kept: [], refusal: cleanupRefused('history-ambiguous') }
        : planRevisionCleanup({ ...snap, history: withoutX4(history.entries), previousRevision, now: Date.now(), cfg: target.revisionCleanup });
    };
    if (history.ambiguous) return finish('refused', cleanupRefused('history-ambiguous'));
    const snapshot = readCleanupSnapshot(target, deadline);
    const initial = plan(snapshot); out.kept = initial.kept;
    if (initial.refusal) return finish('refused', initial.refusal);
    if (snapshot.serving !== revision) return finish('refused', cleanupRefused('serving-changed'));
    candidates = initial.deactivate;
    if (target.agentAllowed === 'with-authorization') {
      out.kept.push(...candidates.filter(n => !preview.deactivate.includes(n)).map(name => ({ name, reason: 'not-in-authorized-list' })));
      candidates = candidates.filter(n => preview.deactivate.includes(n));
    }
    if (!candidates.length) return out;
    // Immediately before the first mutation: refresh labels, traffic, inventory, limit and full history.
    const refuseRevalidation = code => {
      out.kept.push(...candidates.map(name => ({ name, reason: 'revalidation-refused' })));
      return finish('refused', code);
    };
    let fresh, checked;
    try { fresh = readCleanupSnapshot(target, deadline); checked = plan(fresh); }
    catch (e) { return refuseRevalidation(e.message === cleanupRefused('maxInactiveRevisions') ? e.message : cleanupRefused('snapshot')); }
    if (checked.refusal) return refuseRevalidation(checked.refusal);
    const labels = s => JSON.stringify(s.trafficEntries.filter(e => e.label).map(e => [e.revisionName, e.label]).sort());
    if (fresh.serving !== revision || labels(snapshot) !== labels(fresh)) return refuseRevalidation(cleanupRefused('traffic-changed'));
    const allowed = candidates.filter(n => checked.deactivate.includes(n));
    out.kept.push(...checked.kept.filter(k => candidates.includes(k.name)));
    out.kept.push(...candidates.filter(n => !allowed.includes(n) && !checked.kept.some(k => k.name === n)).map(name => ({ name, reason: 'snapshot-changed' })));
    candidates = allowed;
    for (let i = 0; i < candidates.length; i++) {
      const name = candidates[i];
      try { capturedAz(revisionActionArgs(target, 'deactivate', name), { deadline }); out.deactivated.push(name); }
      catch {
        out.failed.push(name);
        out.kept.push(...candidates.slice(i + 1).map(name => ({ name, reason: 'not-attempted' })));
        return finish('failed', 'REVISION_CLEANUP_FAILED');
      }
    }
    return out;
  } catch (e) {
    out.kept.push(...candidates.filter(n => !out.deactivated.includes(n)).map(name => ({ name, reason: 'not-attempted' })));
    return finish('refused', e.message === cleanupRefused('maxInactiveRevisions') ? e.message : cleanupRefused('snapshot'));
  }
}

// Scale-to-zero is healthy: Provisioned+active permits the FQDN health request to wake the revision.
export async function verifyRollbackRevision(target, revision, sha, { sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, fetchImpl = fetch } = {}) {
  if (!revisionNameOk(revision)) throw new Refusal('ROLLBACK_TARGET_UNVERIFIED');
  const deadline = now() + 300000, callDeadline = Date.now() + 300000;
  try {
    const state = () => {
      const s = JSON.parse(capturedAz(rollbackRevisionStateArgs(target, revision), { notFound: true, deadline: callDeadline }));
      if (!isPlainObject(s) || typeof s.active !== 'boolean' || typeof s.prov !== 'string') throw new Error();
      return s;
    };
    let s = state();
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error();
    if (!s.active) {
      capturedAz(revisionActionArgs(target, 'activate', revision), { deadline: callDeadline });
      for (let attempt = 0; attempt < 30; attempt++) {
        s = state();
        if (s.active && s.prov === 'Provisioned') break;
        if (now() >= deadline || attempt === 29) throw new Error();
        await sleep(10000);
      }
    }
    if (!s.active || s.prov !== 'Provisioned') throw new Error();
    const fqdn = capturedAz(containerappRevisionShowArgs(target, revision), { deadline: callDeadline }).trim();
    if (!/^[A-Za-z0-9.-]+$/.test(fqdn)) throw new Error();
    const result = await waitForSha({ ...target.health, url: revisionHealthUrl(target.health.url, fqdn) }, sha, { sleep, now, fetchImpl });
    if (!result.verified) throw new Error();
  } catch (e) {
    throw new Refusal(`${e.message === 'ROLLBACK_TARGET_PURGED' ? 'ROLLBACK_TARGET_PURGED' : 'ROLLBACK_TARGET_UNVERIFIED'}: ${revision}`);
  }
}

const nonProductionSlot = slot => typeof slot === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(slot) && slot.toLowerCase() !== 'production';
const trafficCommand = (target, destination) => `node deploy.mjs --target ${target} --switch-traffic ${destination}`;

function healthAtHostname(target, args) {
  const hostname = sh('az', args).trim();
  if (!/^[A-Za-z0-9.-]+$/.test(hostname)) throw new Refusal('HEALTH_HOSTNAME_UNAVAILABLE: Azure did not report a usable hostname');
  return { ...target.health, url: revisionHealthUrl(target.health.url, hostname) };
}

async function switchDestination(target, type, destination, switchPolicy) {
  let health, liveHealth = target.health;
  if (type === 'containerapp') {
    let revisions;
    try { revisions = JSON.parse(sh('az', containerappRevisionListArgs(target))); } catch { /* unreadable */ }
    if (!Array.isArray(revisions) || !revisions.includes(destination))
      throw new Refusal(`UNKNOWN_REVISION: ${destination} is not a revision of ${target.app}`);
    health = healthAtHostname(target, containerappRevisionShowArgs(target, destination));
  } else {
    let slots;
    try { slots = JSON.parse(sh('az', webappSlotListArgs(target))); } catch { /* unreadable */ }
    if (!Array.isArray(slots) || !slots.includes(destination))
      throw new Refusal(`UNKNOWN_SLOT: ${destination} is not a slot of ${target.app}`);
    health = healthAtHostname(target, webappHostnameArgs(target, destination));
    liveHealth = healthAtHostname(switchPolicy, webappHostnameArgs(switchPolicy));
  }
  const reported = await readHealthSha(health).catch(() => ({ ok: false }));
  if (!reported.ok || !shaMatches(reported.sha, reported.sha))
    throw new Refusal(`UNVERIFIED_DESTINATION: ${destination} must report a full commit SHA`);
  return { health, liveHealth, sha: reported.sha.toLowerCase() };
}

const switchAuthorizationPhrase = (target, destination, percent) => `${target.app}:switch:${destination}:${percent}`;
const commandText = args => args.map(arg => /^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');

function verifiedDestination(history, destination, sha, recordedSlot) {
  return history.slice().reverse().find(h => h.verified === true && h.intent !== true &&
    (h.slot ?? h.revision ?? recordedSlot) === destination && (sha === undefined || shaMatches(h.sha, sha)));
}

function productionSlotPolicy(cfg, target) {
  const identity = appHistoryKey({ ...target, slot: null });
  const matches = Object.entries(cfg.targets).filter(([, candidate]) => appHistoryKey(candidate) === identity);
  if (matches.length !== 1)
    throw new Refusal(`PRODUCTION_TARGET_REQUIRED: configure one production target for ${target.app}`);
  const [name, policy] = matches[0];
  if (isAgent(process.env, DEFAULT_AGENT_MARKERS) || [policy, target].some(t => isAgent(process.env, t.agentMarkers || [])))
    throw new Refusal(`AGENT_NOT_ALLOWED: ${name} is deployed only by the user`);
  if (!process.stdin.isTTY)
    throw new Refusal(`INTERACTIVE_REQUIRED: ${name} needs a human at an interactive terminal`);
  return { name, policy: { ...policy, agentAllowed: policy.agentAllowed === 'with-authorization' ? 'with-authorization' : false } };
}

function checkStagedTraffic(target, beforeTraffic, previousRevision, revision) {
  let unchanged = false;
  try {
    const afterTraffic = sh('az', containerappTrafficQueryArgs(target));
    unchanged = trafficWeights(beforeTraffic) === trafficWeights(afterTraffic);
  } catch { /* unreadable */ }
  if (!unchanged) {
    const restore = commandText(['az', ...containerappTrafficSetArgs(target, previousRevision)]);
    throw new Refusal(`STAGE_TRAFFIC_CHANGED: ${target.app} traffic changed or could not be verified while staging ${revision}. Restore with: ${restore}`);
  }
}

async function switchTraffic({ target, type, plan, repo, liveHealth, destinationHealth, liveSha, allHistory, candidate, authorization, switchPolicy, appendHistoryEntry }) {
  const { target: targetName, destination, percent, sha } = plan;
  let previousRevision = destination, previousSha = liveSha;
  if (type === 'containerapp') {
    checkAppShape(sh('az', containerappShapeArgs(target)), target);
    let traffic;
    try { traffic = JSON.parse(sh('az', containerappTrafficQueryArgs(target))); } catch { /* unreadable */ }
    const active = Array.isArray(traffic) ? traffic.filter(t => t?.weight > 0) : [];
    if (!active.length || active.some(t => t.latestRevision || !revisionNameOk(t.revisionName) || t.revisionName === 'latest'))
      throw new Refusal('TRAFFIC_NOT_PINNED: traffic must use named revisions');
    previousRevision = active.filter(t => t.revisionName !== destination).sort((a, b) => b.weight - a.weight)[0]?.revisionName;
    if (!previousRevision) {
      if (percent < 100) throw new Refusal('TRAFFIC_REMAINDER_UNAVAILABLE: no other active revision can receive the remaining traffic');
      throw new Refusal(`TRAFFIC_ALREADY_SWITCHED: ${destination} already receives all traffic`);
    }
    const previousEntry = verifiedDestination(allHistory, previousRevision);
    previousSha = previousEntry?.sha ?? (active.length === 1 ? liveSha : null);
    if (!shaMatches(previousSha, previousSha)) {
      previousSha = null;
      try {
        const previousHealth = healthAtHostname(target, containerappRevisionShowArgs(target, previousRevision));
        const reported = await readHealthSha(previousHealth);
        if (reported.ok && shaMatches(reported.sha, reported.sha)) previousSha = reported.sha;
      } catch { /* the rollback baseline is still unreadable */ }
    }
    if (!shaMatches(previousSha, previousSha))
      throw new Refusal(`ROLLBACK_BASELINE_UNREADABLE: ${previousRevision} has no verified full commit; a switch without a rollback baseline is refused`);
  }
  const rollbackPhrase = switchPolicy.agentAllowed === 'with-authorization'
    ? rollbackAuthorizationPhrase(switchPolicy, previousRevision) : null;
  const rollbackCommand = commandText(['node', fileURLToPath(import.meta.url), '--repo', repo, '--target', targetName,
    '--rollback', '--allow-overwrite', sha.slice(0, 12)]);
  const append = verified => appendHistoryEntry({
    ...deployHistoryEntry({ sha, imageRef: candidate.image, digest: candidate.digest, runId: candidate.runId, imageTag: candidate.imageTag,
      revision: destination, previousRevision, promoteFrom: candidate.promotedFrom, authorization, verified,
      intent: !verified, at: new Date().toISOString(), artifact: candidate.artifact }),
    ...(type === 'webapp' ? { slot: destination } : {}), previousSha, percent, switched: true,
  });
  append(false);
  if (type === 'containerapp') sh('az', containerappTrafficSetArgs(target, destination, percent, previousRevision));
  else sh('az', webappSlotSwapArgs(target, destination));

  const result = await waitForSha(liveHealth, percent < 100 ? [sha, previousSha].filter(Boolean) : sha);
  const destinationResult = percent < 100 ? await waitForSha(destinationHealth, sha) : result;
  if (!result.verified || !destinationResult.verified)
    throw new Refusal(`VERIFY_FAILED: ${destination} did not verify after switching traffic. To restore ${previousRevision}: ${rollbackCommand}` +
      (rollbackPhrase ? `. Supply --authorize with "${rollbackPhrase}".` : ''));
  append(true);
  return { switched: true, plan, previousRevision, ...(type === 'webapp' ? { slot: destination } : {}), rollbackCommand,
    ...(rollbackPhrase ? { rollbackAuthorizationPhrase: rollbackPhrase } : {}), reported: result.reported };
}

// X4 captures no write body except the exact ACR run record. Discard stderr
// entirely rather than forwarding even a masked diagnostic from Azure.
function shQuiet(args, timeout, { env }) {
  try { execCommand('az', args, { timeout, env, stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (error) {
    const refusal = new Refusal('AZ_WRITE_FAILED');
    if (error?.status === null && error.signal === null &&
        ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE'].includes(error.code)) {
      refusal.processStarted = false;
    }
    throw refusal;
  }
}

const withoutX4 = entries => entries.filter(entry => !Object.hasOwn(entry, 'op'));

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--test-fence-receipt')) throw new Refusal('TEST_FENCE_UNSUPPORTED');
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const authorizeArg = () => authorizeArgument(argv);
  const repo = resolve(opt('repo') || '.');
  const targetName = opt('target');
  if (!targetName) throw new Refusal('USAGE: --target <name> [--sha <sha>] [--repo .] [--dry-run] [--rollback]');
  const git = (...a) => sh('git', ['-C', repo, ...a]).trim();
  const remote0 = opt('remote') || 'origin';
  const worktreePersonOnly = 'CONFIG_FROM_WORKTREE_PERSON_ONLY: an agent may not use a deploy.json that is not on the default branch';
  // No git fetch here (H3). One advertisement is read per remote and reused only for that same remote; local tracking refs are read at each check.
  const advertisements = new Map();
  const freshness = (r, b, readGit = git) => {
    if (!advertisements.has(r)) advertisements.set(r, readAdvertisement(readGit, r));
    const advertised = advertisements.get(r), tracking = readTrackingRefs(readGit, r);
    checkRemoteRef({ remote: r, branch: b, advertised, tracking });
    return { advertised, tracking };
  };
  const x4 = argv.includes('--action') || argv.includes('--status');
  if (!x4 && ['--op', '--retire-revision', '--to-revision', '--revision-input',
    '--authority-receipt'].some(flag => argv.includes(flag))) throw new Refusal('DEPLOY_MODE_CONFLICT');
  if (x4 && argv.includes('--config-from-worktree')) throw new Refusal('X4_DEFAULT_BRANCH_ONLY');
  let cfg, configSource;
  if (argv.includes('--config-from-worktree')) {
    if (isAgent(process.env)) throw new Refusal(worktreePersonOnly);
    cfg = loadConfig(repo); configSource = 'worktree';
  } else {
    const branch0 = defaultBranchOf(git, remote0) || opt('default') || 'main';
    const ref = `${remote0}/${branch0}`;
    freshness(remote0, branch0); // the config-source ref is exact before its deploy.json is trusted
    const fullRef = `refs/remotes/${remote0}/${branch0}`; // the very ref that was just validated: a tag or branch with the short name cannot shadow it
    cfg = loadConfigFromRef(git, fullRef); configSource = ref;
    try { // tell the person when the file being edited is not the one that governs
      const local = readFileSync(join(repo, CONFIG_PATH), 'utf8').replace(/^\uFEFF/, '');
      const live = git('show', `${fullRef}:${CONFIG_PATH}`).replace(/^\uFEFF/, '');
      if (local.trim() !== live.trim()) process.stderr.write(`DEPLOY: note: ${CONFIG_PATH} here differs from ${ref}; using ${ref}\n`);
    } catch { /* no local copy */ }
  }
  const target = cfg.targets[targetName];
  if (!target) throw new Refusal(`UNKNOWN_TARGET: ${targetName} is not declared in ${CONFIG_PATH} on ${configSource}`);
  checkTrustedPlacement(target);
  const dryRun = argv.includes('--dry-run');
  let defaultG7Alias = false;
  let defaultCfg = configSource === 'worktree' ? null : cfg;
  if (configSource === 'worktree' && target.type === 'containerapp') {
    // The bootstrap override cannot remove the G7 declaration of an existing app.
    const gitQuiet = (...a) => sh('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let branch0 = defaultBranchOf(gitQuiet, remote0);
    if (!dryRun) {
      if (!branch0) throw new Refusal(`G7_DEFAULT_UNKNOWN: run git remote set-head ${remote0} --auto`);
      try { freshness(remote0, branch0, gitQuiet); }
      catch { throw new Refusal('G7_USE_ACTION'); }
    }
    branch0 ||= opt('default') || 'main';
    const defaultRef = `refs/remotes/${remote0}/${branch0}`;
    try { defaultCfg = loadConfigFromRef(gitQuiet, defaultRef); }
    catch (error) {
      if (!dryRun) {
        if (!error.message.startsWith('NO_DEPLOY_CONFIG_ON_DEFAULT:')) throw new Refusal('G7_USE_ACTION');
        // A failed show can also mean the file exists but could not be read.
        try {
          if (gitQuiet('ls-tree', '--full-tree', '--name-only', defaultRef, '--', CONFIG_PATH)) throw new Refusal('G7_USE_ACTION');
        } catch { throw new Refusal('G7_USE_ACTION'); }
      }
    }
    const defaultTargets = Object.values(defaultCfg?.targets ?? {});
    if (defaultTargets.some(alias => sameContainerApp(alias, target) && isAgent(process.env, alias.agentMarkers || []))) throw new Refusal(worktreePersonOnly);
    defaultG7Alias = !dryRun && defaultTargets.some(alias => alias.settings && sameContainerApp(alias, target));
  }
  const remote = cfg.remote || remote0, branch = cfg.defaultBranch || defaultBranchOf(git, remote) || opt('default') || 'main';
  const fresh = freshness(remote, branch); // the effective remote and branch, unconditionally, before any SHA selection or rollback planning
  const historyNotices = new Set();
  const loadHistory = (name = targetName) => loadAppHistory({ repo, targetName: name, target: cfg.targets[name], cfg, git, reported: historyNotices });
  const type = target.type || 'webapp';
  if (x4 &&
      ['--rollback', '--stage-only', '--switch-traffic', '--promote-from', '--allow-overwrite', '--allow-unreadable',
        ...(['switch', 'rollback', 'recover'].includes(opt('action')) ? [] : ['--run', '--ledger', '--key'])].some(flag => argv.includes(flag))) throw new Refusal('DEPLOY_MODE_CONFLICT');
  if (!x4 && !dryRun && type === 'containerapp' &&
      (defaultG7Alias ||
       Object.values(cfg.targets).some(alias => alias.settings && sameContainerApp(alias, target)))) throw new Refusal('G7_USE_ACTION');
  const legacyHistoryGuard = !x4 && (argv.includes('--rollback') ||
    (target.revisionCleanup && !argv.includes('--stage-only') && !argv.includes('--switch-traffic')));
  const historyStore = loadHistory(), artifacts = historyStore.dir;
  const recordedX4Store = legacyHistoryGuard && findRecordedX4History(target);
  if (recordedX4Store) throw new Refusal(`X4_HISTORY_PRESENT: ${recordedX4Store.name}`);
  const appendHistoryEntry = (_dir, entry) => appendAppHistory(historyStore, entry);
  if (x4) {
    if (type !== 'containerapp') throw new Refusal('G7_NOT_DECLARED');
    if (!target.settings && !historyStore.entries.some(entry => Object.hasOwn(entry, 'op'))) {
      const restoring = argv.includes('--status') || ['rollback', 'withdraw', 'recover'].includes(opt('action'));
      const match = restoring && findRecordedX4History(target);
      if (match?.reason === 'unreadable') throw new Refusal(`X4_HISTORY_PRESENT: ${match.name}`);
      throw new Refusal(match ? 'STAGE_POLICY_CHANGED' : 'G7_NOT_DECLARED');
    }
    if (argv.includes('--percent') && opt('action') !== 'switch') throw new Refusal('DEPLOY_MODE_CONFLICT');
    return runX4Main({ argv, repo, targetName, target, cfg, git, remote, branch, loadHistory, historyStore, sha: opt('sha'), sh: execCommand, shQuiet, confirm: confirmInteractive });
  }
  const allHistory = withoutX4(historyStore.entries);
  if (legacyHistoryGuard &&
      (historyStore.entries.some(entry => Object.hasOwn(entry, 'op')) ||
       Object.entries(defaultCfg?.targets ?? {}).some(([name, alias]) =>
         alias !== target && sameContainerApp(alias, target) &&
         loadAppHistory({ repo, targetName: name, target: alias, cfg: defaultCfg, git, reported: historyNotices })
           .entries.some(entry => Object.hasOwn(entry, 'op'))))) throw new Refusal('X4_HISTORY_PRESENT');
  const history = recentHistory(allHistory.filter(h => type !== 'containerapp' || h.staged !== true));

  const rollback = argv.includes('--rollback');
  const stage = argv.includes('--stage-only'), switching = argv.includes('--switch-traffic');
  const destination = opt('switch-traffic');
  const hasPercent = argv.includes('--percent'), percentArg = opt('percent');
  if ((stage && (switching || rollback)) || (switching && rollback))
    throw new Refusal('DEPLOY_MODE_CONFLICT: choose one of --stage-only, --switch-traffic or --rollback');
  if (switching && type === 'webapp' && hasPercent)
    throw new Refusal('PERCENT_UNSUPPORTED: webapp slot swaps always switch all production traffic');
  if (hasPercent && (!switching || !/^(?:[1-9][0-9]?|100)$/.test(percentArg || '')))
    throw new Refusal('PERCENT_INVALID: --percent requires --switch-traffic and an integer from 1 to 100');
  if (stage && type === 'webapp' && !nonProductionSlot(target.slot))
    throw new Refusal('STAGE_NEEDS_SLOT: configure a non-production slot for this webapp target');
  if (switching && !(type === 'webapp' ? nonProductionSlot(destination) : revisionNameOk(destination)))
    throw new Refusal(type === 'webapp' ? 'SLOT_INVALID: pass a non-production slot name' : 'UNKNOWN_REVISION: pass a revision name');
  const percent = hasPercent ? Number(percentArg) : 100;
  const webSwitch = switching && type === 'webapp';
  if (webSwitch && destination !== target.slot)
    throw new Refusal(`UNKNOWN_SLOT: ${destination} does not match the configured slot of ${targetName}`);
  const production = webSwitch ? productionSlotPolicy(cfg, target) : null;
  const switchPolicy = production?.policy ?? target;
  const switchPhrase = switching ? switchAuthorizationPhrase(target, destination, percent) : null;
  let destinationHealth, liveHealth = target.health, liveSha, switchEntry;
  let sha, zipPath, rollbackImage = null, rollbackRevision = null;
  if (rollback) {
    const last = history.at(-1);
    const prev = history.slice(0, -1).reverse().find(h => h.verified !== false && !h.rollback);
    if (last?.switched === true && (last.verified === true || last.intent === true)) {
      rollbackRevision = last.previousRevision;
      sha = last.previousSha || null;
      if (!shaMatches(sha, sha) || !rollbackRevision)
        throw new Refusal('ROLLBACK_TARGET_UNVERIFIED: the previous traffic destination is not recorded with a verified SHA');
      if (type === 'webapp') {
        const slotKey = appHistoryKey({ ...target, slot: rollbackRevision });
        const slotTargetName = target.slot === rollbackRevision ? targetName : !target.slot
          ? Object.keys(cfg.targets).find(name => appHistoryKey(cfg.targets[name]) === slotKey) : null;
        if (!nonProductionSlot(rollbackRevision) || last.slot !== rollbackRevision || !slotTargetName)
          throw new Refusal('ROLLBACK_TARGET_UNVERIFIED: the previous slot does not match a configured slot');
        const { name: productionName, policy } = productionSlotPolicy(cfg, cfg.targets[slotTargetName]);
        const phrase = rollbackAuthorizationPhrase(policy, rollbackRevision);
        const plan = { target: targetName, type, app: target.app, rollback: true, sha, slot: rollbackRevision,
          ...(policy.agentAllowed === 'with-authorization' ? { authorizationPhrase: phrase } : {}) };
        if (argv.includes('--dry-run')) return { dryRun: true, plan };
        if (policy.agentAllowed === 'with-authorization' && opt('authorize') !== phrase)
          throw new Refusal(`AUTHORIZATION_REQUIRED: pass --authorize "${phrase}"`);
        const slotTarget = cfg.targets[slotTargetName];
        const slotHealth = healthAtHostname(slotTarget, webappHostnameArgs(slotTarget, rollbackRevision));
        const prior = await readHealthSha(slotHealth).catch(() => ({ ok: false }));
        if (!prior.ok || !shaMatches(prior.sha, sha))
          throw new Refusal(`ROLLBACK_TARGET_UNVERIFIED: ${rollbackRevision} no longer reports ${sha}`);
        const otherHistory = loadHistory(targetName === productionName ? slotTargetName : productionName);
        const productionHealth = healthAtHostname(policy, webappHostnameArgs(policy));
        const live = await readHealthSha(productionHealth).catch(e => ({ ok: false, error: e.message }));
        if (!live.ok || !usableSha(live.sha))
          throw new Refusal(`RUNNING_REF_UNREADABLE: ${productionName} did not report its running commit; nothing was changed`);
        if (!shaMatches(live.sha, live.sha))
          throw new Refusal(`HEALTH_SHA_NOT_FULL: ${productionName} must report exactly 40 hexadecimal characters; nothing was changed`);
        const expectedOverride = live.sha.slice(0, 12).toLowerCase();
        if (!shaMatches(live.sha, last.sha) && opt('allow-overwrite')?.toLowerCase() !== expectedOverride) {
          const refusal = overwriteRefusal({ targetName: productionName, liveSha: live.sha, sha: last.sha, git: a => git(...a) });
          throw new Refusal(refusal || `WOULD_OVERWRITE_UNMERGED: ${productionName} no longer runs the switched SHA. Pass --allow-overwrite ${expectedOverride} to replace what is live.`);
        }
        await confirmInteractive(target.app);
        sh('az', webappSlotSwapArgs(target, rollbackRevision));
        const result = await waitForSha(productionHealth, sha);
        if (!result.verified) throw new Refusal(`ROLLBACK_VERIFY_FAILED: ${productionHealth.url}`);
        const entry = { sha, slot: rollbackRevision, at: new Date().toISOString(), rollback: true };
        appendHistoryEntry(artifacts, entry);
        appendAppHistory(otherHistory, entry);
        return { rolledBack: true, plan, reported: result.reported };
      }
      rollbackImage = verifiedDestination(allHistory, rollbackRevision, sha)?.image ?? null;
    } else if (type === 'containerapp') {
      // A traffic switch back to the previously serving revision is instant and rebuilds nothing.
      if (last?.previousRevision) { rollbackRevision = last.previousRevision; sha = prev?.sha ?? null; }
      if (prev) { sha = prev.sha; rollbackImage = prev.image; }
      else if (last?.previousImage) { sha = sha ?? null; rollbackImage = last.previousImage; }
      if (target.revisionCleanup && rollbackRevision) {
        const match = allHistory.slice().reverse().find(h => h.revision === rollbackRevision && h.verified !== false && !h.rollback && h.intent !== true && h.staged !== true);
        sha = match?.sha && /^[0-9a-f]{40}$/i.test(match.sha) ? match.sha : null;
        rollbackImage = match?.image ?? last?.previousImage ?? null;
      }
      if (!rollbackRevision && !rollbackImage) throw new Refusal('NO_ROLLBACK_TARGET: no recorded previous revision or image — deploy once through this script first, or switch traffic yourself');
    } else {
      if (!prev) throw new Refusal('NO_ROLLBACK_ARTIFACT: fewer than two recorded deploys');
      if (target.slot && history.slice(history.indexOf(prev)).some(h => h.switched === true || (h.rollback === true && h.slot)))
        throw new Refusal(`ROLLBACK_TARGET_UNVERIFIED: ${target.slot} content changed by a slot swap; redeploy the slot instead`);
      sha = prev.sha; zipPath = rollbackArtifactPath(prev, artifacts);
      if (!zipPath || !existsSync(zipPath)) throw new Refusal(`ROLLBACK_ARTIFACT_MISSING: ${zipPath || `the history entry for ${sha} records no usable artifact path`}`);
    }
  } else if (switching) {
    const candidate = await switchDestination(target, type, destination, switchPolicy);
    ({ sha, liveHealth, health: destinationHealth } = candidate);
    // This history store already identifies the slot for older webapp records.
    switchEntry = verifiedDestination(allHistory, destination, sha, webSwitch ? target.slot : undefined);
    if (!switchEntry) throw new Refusal(`UNVERIFIED_DESTINATION: ${destination} has no verified history entry for ${sha}`);
    if (opt('sha') && git('rev-parse', `${opt('sha')}^{commit}`) !== sha)
      throw new Refusal(`SWITCH_SHA_MISMATCH: ${destination} reports ${sha}`);
  } else {
    sha = git('rev-parse', `${opt('sha') || (target.requireOnDefaultBranch ? `${remote}/${branch}` : 'HEAD')}^{commit}`);
  }
  if (rollback && target.agentAllowed !== true && target.agentAllowed !== 'with-authorization' && isAgent(process.env, target.agentMarkers || DEFAULT_AGENT_MARKERS)) throw new Refusal(`AGENT_NOT_ALLOWED: ${targetName} is deployed only by the user`);
  if (rollback) {
    const rollbackTo = rollbackRevision || sha || String(rollbackImage).split(':').pop();
    const plan = { target: targetName, type, app: target.app, rollback: true, sha, image: rollbackImage, revision: rollbackRevision,
      ...(target.agentAllowed === 'with-authorization' ? { authorizationPhrase: rollbackAuthorizationPhrase(target, rollbackTo) } : {}),
      ...(target.revisionCleanup && !sha ? { willRefuse: 'ROLLBACK_TARGET_UNVERIFIED' } : {}) };
    if (argv.includes('--dry-run')) return { dryRun: true, plan };
    if (plan.willRefuse) throw new Refusal(plan.willRefuse);
    checkRollbackAuthorization({ target, targetName, revision: rollbackRevision, sha: sha || rollbackTo, env: process.env, isTTY: !!process.stdin.isTTY, authorization: authorizeArg() });
    if (target.agentAllowed !== true && target.agentAllowed !== 'with-authorization') await confirmInteractive(target.app);
    if (type === 'containerapp') {
      if (rollbackRevision) {
        if (target.revisionCleanup) await verifyRollbackRevision(target, rollbackRevision, sha);
        sh('az', containerappTrafficSetArgs(target, rollbackRevision));
      }
      else sh('az', containerappUpdateWithRevisionArgs(target, rollbackImage, sha || 'rollback'));
    } else sh('az', azDeployArgs(target, zipPath));
    // Never accept "something healthy": verify the rolled-back revision is actually the one serving.
    const result = await waitForSha(target.health, sha);
    if (type === 'containerapp' && rollbackRevision) {
      const nowServing = servingRevision(sh('az', containerappTrafficQueryArgs(target)));
      if (nowServing !== rollbackRevision) throw new Refusal(`ROLLBACK_REVISION_MISMATCH: ${nowServing} is serving, expected ${rollbackRevision}`);
    }
    if (!result.verified) throw new Refusal(`ROLLBACK_VERIFY_FAILED: ${target.health.url} (last: ${JSON.stringify(result.last)}) — report to the user now`);
    appendHistoryEntry(artifacts, { sha, image: rollbackImage, revision: rollbackRevision, at: new Date().toISOString(), rollback: true });
    return { rolledBack: true, plan, reported: result.reported };
  }
  const shaOnRemote = shaOnFreshRemote({ containing: git('branch', '-r', '--contains', sha), remote, advertised: fresh.advertised, tracking: fresh.tracking });
  let shaOnDefault = false;
  try { git('merge-base', '--is-ancestor', sha, `${remote}/${branch}`); shaOnDefault = true; } catch { /* not on default */ }
  let sameShaOn = true;
  if (switchPolicy.requireSameShaOn) {
    const pre = cfg.targets[switchPolicy.requireSameShaOn];
    const h = pre ? await readHealthSha(pre.health).catch(() => ({ ok: false })) : { ok: false };
    sameShaOn = !!(h.ok && shaMatches(h.sha, sha));
  }
  const authorization = authorizeArg();
  let cleanupPreview = null;
  if (!switching && !stage && target.revisionCleanup) {
    if (historyStore.ambiguous) cleanupPreview = { deactivate: [], kept: [], refusal: cleanupRefused('history-ambiguous') };
    else try {
      const snapshot = readCleanupSnapshot(target);
      cleanupPreview = planRevisionCleanup({ ...snapshot, history: allHistory, previousRevision: snapshot.serving, now: Date.now(), cfg: target.revisionCleanup });
      if (cleanupPreview.refusal?.startsWith('REVISION_CLEANUP_REFUSED:')) throw new Error();
    } catch { cleanupPreview = { deactivate: [], kept: [], refusal: 'REVISION_CLEANUP_PREVIEW_UNAVAILABLE' }; }
  }
  const cleanupPhrase = cleanupPreview && cleanupPreview.refusal !== 'REVISION_CLEANUP_PREVIEW_UNAVAILABLE'
    ? revisionCleanupPhrase(targetName, target, sha, cleanupPreview.deactivate) : authorizationPhrase(target, sha);
  const stagePhrase = stage ? `${target.app}:stage:${sha.slice(0, 12)}` : null;
  if (webSwitch && switchPolicy.agentAllowed === 'with-authorization' && authorization !== switchPhrase)
    throw new Refusal(`AUTHORIZATION_REQUIRED: pass --authorize "${switchPhrase}"`);
  checkPreconditions({ target: switchPolicy, targetName, sha, env: process.env, isTTY: !!process.stdin.isTTY, shaOnRemote, shaOnDefault, sameShaOn, authorization,
    ...(switching ? { phrase: switchPhrase } : stage ? { phrase: stagePhrase } : cleanupPreview ? { phrase: cleanupPhrase, cleanupNames: cleanupPreview.deactivate } : {}) });
  {
    let live = { ok: false };
    const retryMs = Number(opt('live-retry-ms') ?? 5000);
    for (let attempt = 0; attempt < 3; attempt++) { // absorb a restart or a network blip before refusing
      live = await readHealthSha(liveHealth).catch(e => ({ ok: false, error: e.message }));
      if (live.ok && usableSha(live.sha)) break;
      if (attempt < 2) await new Promise(r => setTimeout(r, retryMs));
    }
    if (!webSwitch && live.ok && typeof live.sha === 'string' && /^[0-9a-f]{1,39}$/i.test(live.sha))
      throw new Refusal(`HEALTH_SHA_NOT_FULL: ${targetName} must report exactly 40 hexadecimal characters; nothing was changed`);
    const agent = isAgent(process.env, switchPolicy.agentMarkers || DEFAULT_AGENT_MARKERS);
    const resolution = agent && opt('run')
      ? readRunningRefResolution(repo, opt('run'), { ledgerDir: resolve(opt('ledger') || repo) })
      : null;
    const liveTargetName = production?.name ?? targetName;
    const hasRollbackBaseline = live.ok && shaMatches(live.sha, live.sha);
    const refusal = (webSwitch ? hasRollbackBaseline : live.ok && usableSha(live.sha))
      ? overwriteRefusal({ targetName: liveTargetName, liveSha: live.sha, sha, git: a => git(...a), allow: opt('allow-overwrite') || null, agent, resolution })
      : unreadableRefusal({ targetName: liveTargetName, live, allow: opt('allow-unreadable') || null, agent });
    if (refusal) throw new Refusal(refusal);
    if (webSwitch && !hasRollbackBaseline)
      throw new Refusal(`ROLLBACK_BASELINE_UNREADABLE: ${production.name} did not report a full running commit; a swap without a rollback baseline is refused`);
    liveSha = live.sha;
  }

  // Promotion: reuse the exact immutable image already verified on the prerequisite target; never rebuild for prod.
  const promoteFrom = opt('promote-from') || target.promoteFrom || null;
  let promotedImage = null, promotedEntry = null;
  if (promoteFrom) {
    if (type !== 'containerapp') throw new Refusal('PROMOTE_UNSUPPORTED: promotion applies to containerapp targets');
    const src = cfg.targets[promoteFrom];
    if (!src) throw new Refusal(`UNKNOWN_PROMOTE_SOURCE: ${promoteFrom}`);
    const sourceHistory = loadAppHistory({ repo, targetName: promoteFrom, target: src, cfg, git, reported: historyNotices });
    const srcHistory = recentHistory(withoutX4(sourceHistory.entries));
    const verified = srcHistory.slice().reverse().find(h => h.sha === sha && h.verified !== false && h.image);
    if (!verified) throw new Refusal(`PROMOTE_SOURCE_NOT_VERIFIED: ${promoteFrom} has no verified deploy of ${sha.slice(0, 12)}; deploy and verify it there first`);
    promotionSourceAssociation(verified, promoteFrom, sha);
    const live = await readHealthSha(src.health).catch(() => ({ ok: false }));
    if (!(live.ok && shaMatches(live.sha, sha))) throw new Refusal(`PROMOTE_SOURCE_MISMATCH: ${promoteFrom} is not currently running ${sha.slice(0, 12)}`);
    // The source must itself be a safe app shape (Multiple mode, one container of the expected name) before any of its traffic, revision or image is accepted.
    checkAppShape(sh('az', containerappShapeArgs(src)), src);
    // The bytes that run on the source now must be the bytes its history says were verified: same revision, same pinned image.
    const srcServing = pinnedTrafficRevision(sh('az', containerappTrafficQueryArgs(src)));
    const srcImage = sh('az', containerappRevisionImageArgs(src, srcServing)).trim();
    promotionSourceAssociation(verified, promoteFrom, sha, { serving: srcServing, image: srcImage });
    promotedImage = verified.image; promotedEntry = verified;
  }
  if (switching) {
    const plan = { target: targetName, type, app: target.app, sha, destination, percent,
      ...(switchPolicy.agentAllowed === 'with-authorization' ? { authorizationPhrase: switchPhrase } : {}) };
    if (argv.includes('--dry-run')) return { dryRun: true, plan };
    if (webSwitch || (target.agentAllowed !== true && target.agentAllowed !== 'with-authorization')) await confirmInteractive(target.app);
    const productionHistory = production ? loadHistory(production.name) : null;
    return switchTraffic({ target, type, plan, repo, liveHealth, destinationHealth, liveSha, allHistory, candidate: switchEntry, authorization, switchPolicy,
      appendHistoryEntry: entry => {
        appendHistoryEntry(artifacts, entry);
        if (productionHistory) appendAppHistory(productionHistory, entry);
      } });
  }

  const appEnvMap = type === 'containerapp' ? (target.build.buildArgsFromApp || null) : null;
  const plan = { target: targetName, type, app: target.app, slot: target.slot || null, sha, rollback: false,
    promoteFrom, promotedImage, ...(stage ? { staged: true } : {}),
    ...(stage && target.agentAllowed === 'with-authorization' ? { authorizationPhrase: stagePhrase } : {}),
    ...(cleanupPreview ? { revisionCleanup: { deactivate: cleanupPreview.deactivate, kept: cleanupPreview.kept, ...(cleanupPreview.refusal ? { code: cleanupPreview.refusal } : {}) }, authorizationPhrase: cleanupPhrase } : {}),
    ...(promotedEntry ? { promotedRevision: promotedEntry.revision, promotedDigest: promotedEntry.digest, promotedRunId: promotedEntry.runId ?? null } : {}),
    build: promotedImage ? '(promotion: no build)'
      : type === 'containerapp' ? ['az', ...acrBuildArgs(target, sha, maskedBuildArgs(appEnvMap, Object.fromEntries(Object.keys(appEnvMap || {}).map(k => [k, '']))))].join(' ')
      : target.build.map(s => [s.command, ...(s.args || [])].join(' ')) };
  if (argv.includes('--dry-run')) return { dryRun: true, plan };
  if (target.agentAllowed !== true && target.agentAllowed !== 'with-authorization') await confirmInteractive(target.app);

  const stageSlotHealth = stage && type === 'webapp' ? healthAtHostname(target, webappHostnameArgs(target, target.slot)) : null;
  mkdirSync(artifacts, { recursive: true });
  // Nothing in this script removes the build directory or a worktree: the person decides when to delete `buildDir`. A promotion builds nothing, so it has none.
  const work = promotedImage ? null : mkdtempSync(join(tmpdir(), 'trio-deploy-'));
  const wt = work && join(work, 'src'), out = work && join(work, 'out');
  let imageRef = null, previousImage = null, digest = null, runId = null, imageTag = null;
  try {
    if (type === 'containerapp') {
      if (promotedImage) { imageRef = promotedImage; ({ digest, runId = null, imageTag = null } = promotedEntry); }
      else {
        // Export the exact commit as a byte-safe tar file (never through sh()'s utf8 stdout), then extract it: no worktree is registered.
        const tarFile = join(work, 'src.tar');
        mkdirSync(wt);
        try {
          execFileSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tarFile, sha], { stdio: ['ignore', 'ignore', 'pipe'] });
          execFileSync('tar', ['-xf', tarFile, '-C', wt], { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (e) { throw new Refusal(`SOURCE_EXPORT_FAILED: ${String(e.stderr || e.message || e).trim().split('\n')[0]}`); }
        // Build in Azure from the exported source at the exact SHA; no local Docker needed.
        const resolved = appEnvMap ? buildArgsFromAppEnv(appEnvMap, sh('az', containerappEnvQueryArgs(target)),
          name => sh('az', containerappEnvQueryArgs(target, name), undefined, { target, name }).replace(/\r?\n$/, '')) : {};
        // az's own stderr is captured (not inherited) so a failing build cannot echo resolved values.
        const maskAll = text => { let t = String(text || ''); for (const [arg, v] of Object.entries(resolved)) if (v && String(v).length >= 4) t = t.split(String(v)).join(`<from app env ${appEnvMap[arg]}>`); return t; };
        let runText;
        try { runText = sh('az', acrBuildArgs(target, sha, resolved), { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) {
          process.stderr.write(maskAll(e.stderr).slice(-4000));
          throw new Refusal(`ACR_BUILD_FAILED: ${maskAll(e.message || e).split('\n')[0]}`);
        }
        const loginServer = target.loginServer || sh('az', ['acr', 'show', '--subscription', target.subscription, '--name', target.registry, '--query', 'loginServer', '-o', 'tsv']).trim();
        // Digest and run id come from this build's own run record; the mutable tag is never read back as provenance.
        ({ runId, digest } = acrRunDigest(runText, { loginServer, image: target.image, sha }));
        imageTag = `${loginServer}/${target.image}:${sha}`;
        imageRef = pinnedImageRef(loginServer, target.image, digest);
      }
      previousImage = sh('az', containerappImageQueryArgs(target)).trim() || null;
    }
    if (type !== 'containerapp') {
      git('worktree', 'add', '--detach', wt, sha); // registered and retained
      const vars = { sha, out, worktree: wt };
      for (const step of target.build) execCommand(fill(step.command, vars), (step.args || []).map(a => fill(a, vars)), { cwd: join(wt, step.cwd || '.'), env: { ...process.env, TRIO_BUILD_SHA: sha } });
      const outDir = resolve(wt, fill(target.outputDir, vars));
      if (!existsSync(outDir)) throw new Error(`BUILD_OUTPUT_MISSING: ${outDir}`);
      const tmpZip = join(work, 'deploy.zip');
      zipDir(outDir, tmpZip);
      zipPath = writeArtifactExclusive(readFileSync(tmpZip), artifacts, sha);
    }
    let revision = null, previousRevision = null, canary = null;
    if (type === 'containerapp') {
      // The new revision is created, verified on its own hostname at 0% traffic, and only then given traffic.
      // Read-only preflight, fail closed: Multiple mode, one container, traffic pinned to one named revision. A violation changes nothing.
      checkAppShape(sh('az', containerappShapeArgs(target)), target);
      const beforeTraffic = sh('az', containerappTrafficQueryArgs(target));
      previousRevision = pinnedTrafficRevision(beforeTraffic);
      revision = `${target.app}--${revisionSuffix(sha)}`;
      if (stage && previousRevision === revision)
        throw new Refusal(`STAGE_REVISION_SERVING: ${revision} already serves traffic`);
      sh('az', containerappUpdateWithRevisionArgs(target, imageRef, sha));
      if (stage) checkStagedTraffic(target, beforeTraffic, previousRevision, revision);
      // The revision must run exactly the pinned image before it can get any traffic (the old revision keeps serving until then).
      const revisionImage = sh('az', containerappRevisionImageArgs(target, revision)).trim();
      checkRevisionImage(revision, revisionImage, imageRef);
      if (!stage) sh('az', containerappTrafficSetArgs(target, previousRevision)); // keep the old revision serving
      const fqdn = sh('az', containerappRevisionShowArgs(target, revision)).trim();
      if (!fqdn) throw new Refusal(`REVISION_FQDN_MISSING: ${revision}`);
      const canaryHealth = { ...target.health, url: revisionHealthUrl(target.health.url, fqdn) };
      try {
        canary = await waitForSha(canaryHealth, sha);
      } finally {
        if (stage) checkStagedTraffic(target, beforeTraffic, previousRevision, revision);
      }
      if (!canary.verified) throw new Refusal(`CANARY_FAILED: ${revision} did not report ${sha.slice(0, 12)} at 0% traffic (last: ${JSON.stringify(canary.last)}); traffic was never switched, nothing to roll back`);
      if (!stage) {
        appendHistoryEntry(artifacts, deployHistoryEntry({ sha, imageRef, digest, runId, imageTag, previousImage, revision, previousRevision, promoteFrom, authorization, verified: false, intent: true, at: new Date().toISOString() }));
        sh('az', containerappTrafficSetArgs(target, revision));
      }
    } else sh('az', azDeployArgs(target, zipPath));
    if (stage) {
      const verified = canary || await waitForSha(stageSlotHealth, sha);
      const destination = revision || target.slot;
      if (!verified.verified) throw new Refusal(`STAGE_VERIFY_FAILED: ${destination} did not report ${sha.slice(0, 12)} (last: ${JSON.stringify(verified.last)})`);
      appendHistoryEntry(artifacts, { ...deployHistoryEntry({ sha, imageRef, digest, runId, imageTag, previousImage, revision, previousRevision,
        promoteFrom, authorization, verified: true, at: new Date().toISOString(), artifact: zipPath, staged: true }), ...(type === 'webapp' ? { slot: target.slot } : {}) });
      const promoteCommand = trafficCommand(targetName, destination) + (revision ? ' [--percent <n>]' : '');
      return { staged: true, plan, buildDir: work, ...(revision ? { revision } : { slot: target.slot }), promoteCommand, reported: verified.reported };
    }
    const result = await waitForSha(target.health, sha);
    const cleanup = target.revisionCleanup && result.verified
      ? runRevisionCleanup({ target, loadHistory, revision, previousRevision, preview: cleanupPreview }) : null;
    appendHistoryEntry(artifacts, deployHistoryEntry({ sha, imageRef, digest, runId, imageTag, previousImage, revision, previousRevision, promoteFrom, authorization, cleanup, verified: result.verified, at: new Date().toISOString(), artifact: type === 'containerapp' ? undefined : zipPath }));
    if (!result.verified) throw new Refusal(`VERIFY_FAILED: ${target.health.url} did not report ${sha.slice(0, 12)} (last: ${JSON.stringify(result.last)}); run --rollback now`);
    return { deployed: true, plan, buildDir: work, image: imageRef, revision, previousRevision, canaryVerified: canary ? true : null, reported: result.reported, ...(cleanup ? { cleanup } : {}) };
  } catch (e) {
    if (work && e instanceof Error) e.message = `${e.message}; buildDir ${work}`;
    throw e;
  }
}
// The host result is printed and its exit code fixed before the best-effort issue hook.
export async function runCli(argv = process.argv.slice(2), { run = main, loadIssues = () => import('./issues.mjs'), stdout = s => process.stdout.write(s), stderr = s => process.stderr.write(s) } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    const usage = readFileSync(new URL(import.meta.url), 'utf8').match(/^\/\/ Usage:[^\r\n]*(?:\r?\n\/\/ {2,}[^\r\n]*)*/m)[0];
    stdout(usage.replace(/^\/\/ /gm, '') + '\n');
    return 0;
  }
  let result;
  try {
    result = await run(argv);
    stdout(`${JSON.stringify(result)}\n`);
  } catch (e) {
    stderr(`DEPLOY: ${e.message}\n`);
    return e instanceof Refusal ? 2 : 3;
  }
  const code = 0;
  try {
    const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const authorizeArg = () => authorizeArgument(argv);
    const runId = opt('run'), target = opt('target');
    const repo = resolve(opt('repo') || '.'), ledger = resolve(opt('ledger') || repo);
    const dir = validRunId(runId) ? join(ledger, '.trioharness-direct', 'runs', runId) : null;
    const fullSwitch = result?.switched === true && (result.percent ?? result.plan?.percent) === 100;
    if ((result?.deployed === true || result?.rolledBack === true || fullSwitch) && ['qa', 'prod'].includes(target) && dir && existsSync(join(dir, 'state.json'))) {
      const event = result.rolledBack === true ? 'rollback' : `deployed-${target}`;
      const key = typeof opt('key') === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(opt('key')) ? opt('key') : undefined;
      let category = 'IMPORT_FAILED';
      try {
        const mod = await loadIssues();
        category = 'OTHER';
        await mod.transitionForEvent(event, {
          repo, ledger, run: runId, target,
          sha: fullSwitch ? result.sha ?? result.plan?.sha : result.plan?.sha,
          revision: result.revision ?? result.plan?.revision ?? (fullSwitch && result.plan?.type === 'containerapp' ? result.plan.destination : undefined),
          toSha: result.rolledBack === true ? result.plan?.sha : undefined,
          toRevision: result.rolledBack === true ? result.plan?.revision : undefined,
          ...(key ? { key } : {}),
        });
      } catch {
        appendFailure({ ledger, run: runId, event, category, key });
      }
    }
  } catch { /* no issue integration failure can change a successful host result */ }
  return code;
}
if (isMain(import.meta.url)) runCli().then(code => { process.exitCode = code; });
