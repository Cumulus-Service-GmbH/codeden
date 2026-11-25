// 2.35 deploy guard: the pre-push hook and `guard --base live` on a repo whose default branch is not "main",
// deploy.json read from the default branch, and a deploy that refuses when the running commit cannot be read.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_MAX_NAMES, HISTORY_COLLISION_RETRIES, Refusal, appendHistoryEntry, artifactName, checkRemoteRef, defaultBranchOf, historySequence, loadConfigFromRef, main, nextHistorySeq,
  parseHistoryEntry, parseRemoteHeads, parseTrackingRefs, readHistory as readAllHistory, recentHistory, rollbackArtifactPath, shaOnFreshRemote, unreadableRefusal, writeArtifactExclusive } from './deploy.mjs';
import { guard } from './guard.mjs';
import { resolveTrustedDefault } from './default-ref.mjs';
import { AGENT_MARKERS as SHARED_MARKERS, lineFingerprint, ALLOW_FILE } from './secret-patterns.mjs';
import { DEFAULT_AGENT_MARKERS } from './deploy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'templates', 'repo', 'pre-push');
const AGENT_MARKERS = ['OPENCODE_CONFIG_CONTENT', 'CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'TRIOHARNESS_AGENT'];
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } }).trim();
const tmp = p => mkdtempSync(join(tmpdir(), `thl-${p}-`));
const write = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const commit = (dir, rel, text, msg) => { write(dir, rel, text); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };

// A bare origin whose default branch is `branch`, seeded with `files`, and a clone of it (origin/HEAD = that branch).
function makeOrigin(branch, files) {
  const bare = tmp('bare');
  git(bare, 'init', '-q', '--bare');
  git(bare, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  const seed = tmp('seed');
  git(seed, 'init', '-q'); git(seed, 'checkout', '-q', '-b', branch);
  let sha;
  for (const [rel, text] of Object.entries(files)) sha = commit(seed, rel, text, `add ${rel}`);
  git(seed, 'remote', 'add', 'origin', bare); git(seed, 'push', '-q', 'origin', branch);
  const clone = tmp('clone');
  execFileSync('git', ['clone', '-q', bare, clone], { env: { ...process.env, ...GIT_ENV } });
  return { bare, seed, clone, sha, branch };
}

function withEnv(set, fn) {
  const saved = {};
  for (const m of AGENT_MARKERS) { saved[m] = process.env[m]; delete process.env[m]; }
  for (const [k, v] of Object.entries(set)) process.env[k] = v;
  const restore = () => { for (const m of AGENT_MARKERS) { if (saved[m] === undefined) delete process.env[m]; else process.env[m] = saved[m]; } };
  try { const r = fn(); if (r && typeof r.then === 'function') return r.finally(restore); restore(); return r; } catch (e) { restore(); throw e; }
}

function pushWithHook(clone, ref) {
  mkdirSync(join(clone, '.git', 'hooks'), { recursive: true });
  const hook = join(clone, '.git', 'hooks', 'pre-push');
  copyFileSync(HOOK, hook); chmodSync(hook, 0o755);
  const env = { ...process.env, ...GIT_ENV }; for (const m of AGENT_MARKERS) delete env[m]; env.CLAUDECODE = '1';
  return spawnSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`], { cwd: clone, encoding: 'utf8', env });
}

// ---------------------------------------------------------------- pre-push hook
test('hook: a repo whose default branch is cumulus/main pushes a clean task branch (upstream file names are not scanned)', () => {
  // upstream history already holds a file that is merely NAMED like a credential file
  const o = makeOrigin('cumulus/main', { 'cloud_agents/credentials.rs': 'pub fn creds() {}\n', 'README.md': 'x\n' });
  assert.equal(defaultBranchOf((...a) => git(o.clone, ...a)), 'cumulus/main');
  git(o.clone, 'checkout', '-q', '-b', 'trio/clean');
  commit(o.clone, 'src/new.txt', 'hello\n', 'a clean change');
  const r = pushWithHook(o.clone, 'trio/clean');
  assert.equal(r.status, 0, `push must pass: ${r.stderr}`);
});

test('hook: on that repo a task branch that adds a credential file is still blocked', () => {
  const o = makeOrigin('cumulus/main', { 'README.md': 'x\n' });
  git(o.clone, 'checkout', '-q', '-b', 'trio/bad');
  commit(o.clone, '.env', 'A=1\n', 'oops');
  const r = pushWithHook(o.clone, 'trio/bad');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /credential file/);
});

test('hook: a conventional default branch (main) behaves as before', () => {
  const o = makeOrigin('main', { 'README.md': 'x\n' });
  git(o.clone, 'checkout', '-q', '-b', 'trio/clean');
  commit(o.clone, 'a.txt', 'a\n', 'ok');
  assert.equal(pushWithHook(o.clone, 'trio/clean').status, 0);
  git(o.clone, 'checkout', '-q', '-b', 'trio/bad2');
  commit(o.clone, 'config/secrets.json', '{}\n', 'bad');
  const r = pushWithHook(o.clone, 'trio/bad2');
  assert.notEqual(r.status, 0);
});

// ---------------------------------------------------------------- guard --base live
test('guard: --base live accepts the branch origin/HEAD points at, still refuses an arbitrary branch', () => {
  const o = makeOrigin('cumulus/main', { 'src.txt': 'one\n' });
  git(o.clone, 'checkout', '-q', '-b', 'trio/work');
  commit(o.clone, 'src.txt', 'two\n', 'candidate');
  const opts = { repo: o.clone, owned: ['src.txt'], remote: 'origin/cumulus/main', tier: 'lean', allowMainWorktree: true, maxBehind: 0 };
  const r = guard({ ...opts, base: 'live' });
  assert.equal(r.clean, true, JSON.stringify(r.violations));
  assert.equal(r.base, git(o.clone, 'rev-parse', 'origin/cumulus/main'));
  git(o.clone, 'push', '-q', 'origin', 'trio/work');
  git(o.clone, 'fetch', '-q', 'origin');
  assert.throws(() => guard({ ...opts, base: 'live', remote: 'origin/trio/work' }), /BASE_LIVE_NOT_DEFAULT/);
});

// ---------------------------------------------------------------- pure pieces of deploy.mjs
test('deploy: default branch comes from origin/HEAD; unknown gives null', () => {
  assert.equal(defaultBranchOf(() => 'origin/cumulus/main'), 'cumulus/main');
  assert.equal(defaultBranchOf(() => 'origin/main'), 'main');
  assert.equal(defaultBranchOf(() => { throw new Error('no'); }), null);
});

const goodCfg = JSON.stringify({ schema: 1, targets: { qa: { subscription: 's', resourceGroup: 'rg', app: 'app', outputDir: 'out', build: [{ command: 'node', args: ['-e', '0'] }], health: { url: 'https://x.invalid/h', shaField: 'sha' }, agentAllowed: true } } });
test('deploy: config is read from the given ref and validated; a missing file is a refusal', () => {
  const cfg = loadConfigFromRef(() => goodCfg, 'origin/main');
  assert.ok(cfg.targets.qa);
  assert.throws(() => loadConfigFromRef(() => { throw new Error('fatal'); }, 'origin/main'), e => e instanceof Refusal && /NO_DEPLOY_CONFIG_ON_DEFAULT/.test(e.message));
  assert.throws(() => loadConfigFromRef(() => '{not json', 'origin/main'), /CONFIG_INVALID/);
  assert.throws(() => loadConfigFromRef(() => JSON.stringify({ schema: 1, targets: { qa: { ...JSON.parse(goodCfg).targets.qa, apiKey: 'x' } } }), 'origin/main'), /CONFIG_HAS_SECRET_FIELD/);
});

test('deploy: an unreadable running commit stops the deploy; only a person naming the target may override', () => {
  const ok = { ok: true, sha: 'a'.repeat(40) };
  assert.equal(unreadableRefusal({ targetName: 'prd', live: ok }), null);
  for (const live of [{ ok: false, status: 403 }, { ok: false }, { ok: true, sha: undefined }, { ok: false, error: 'ENOTFOUND' }, undefined]) {
    assert.match(unreadableRefusal({ targetName: 'prd', live }), /RUNNING_REF_UNREADABLE/);
  }
  assert.match(unreadableRefusal({ targetName: 'prd', live: { ok: false, status: 403 } }), /answered 403/);
  assert.equal(unreadableRefusal({ targetName: 'prd', live: { ok: false }, allow: 'prd' }), null, 'a person naming the target');
  assert.match(unreadableRefusal({ targetName: 'prd', live: { ok: false }, allow: 'qa' }), /RUNNING_REF_UNREADABLE/, 'another target does not count');
  assert.match(unreadableRefusal({ targetName: 'prd', live: { ok: false }, allow: 'prd', agent: true }), /agent must stop/, 'an agent never overrides');
});

// ---------------------------------------------------------------- main() end to end (dry run, real git, local health server)
async function startHealth() {
  const state = { mode: 'sha', sha: '' };
  const server = http.createServer((req, res) => {
    if (state.mode === 'down') { res.statusCode = 503; res.end('down'); return; }
    if (state.mode === 'forbidden') { res.statusCode = 403; res.end('blocked'); return; }
    if (state.mode === 'plain') { res.setHeader('content-type', 'text/plain'); res.end(`${state.sha}\n`); return; }
    if (state.mode === 'nosha') { res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sha: state.sha }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}/health`, close: () => new Promise(r => server.close(r)) };
}
const deployJson = (url, extra = {}) => JSON.stringify({ schema: 1, targets: {
  qa: { subscription: 's', resourceGroup: 'rg', app: 'app-qa', outputDir: 'out', build: [{ command: 'node', args: ['-e', '0'] }], health: { url, shaField: 'sha', timeoutSeconds: 1 }, agentAllowed: true },
  prd: { subscription: 's', resourceGroup: 'rg', app: 'app-prd', outputDir: 'out', build: [{ command: 'node', args: ['-e', '0'] }], health: { url, shaField: 'sha', timeoutSeconds: 1 }, agentAllowed: false } }, ...extra });
const run = (clone, target, ...more) => main(['--repo', clone, '--target', target, '--dry-run', '--live-retry-ms', '1', ...more]);

test('deploy main(): targets and agentAllowed come from the default branch, not from the working tree', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': deployJson(h.url), 'a.txt': 'a\n' });
    h.state.sha = o.sha;
    // a person (no agent markers) gets a dry run
    const plan = await withEnv({}, () => run(o.clone, 'qa'));
    assert.equal(plan.dryRun, true);
    // the working tree is edited to switch production on for agents: ignored, the agent is refused
    write(o.clone, '.trioharness/deploy.json', deployJson(h.url).replace('"agentAllowed":false', '"agentAllowed":true'));
    await assert.rejects(withEnv({ CLAUDECODE: '1' }, () => run(o.clone, 'prd')), /AGENT_NOT_ALLOWED/);
    // a target that exists only in the working tree is unknown
    const evil = JSON.parse(deployJson(h.url)); evil.targets.evil = evil.targets.qa;
    write(o.clone, '.trioharness/deploy.json', JSON.stringify(evil));
    await assert.rejects(withEnv({}, () => run(o.clone, 'evil')), /UNKNOWN_TARGET/);
    // --config-from-worktree is a person's bootstrap tool, never an agent's
    assert.equal((await withEnv({}, () => run(o.clone, 'evil', '--config-from-worktree'))).dryRun, true);
    await assert.rejects(withEnv({ CLAUDECODE: '1' }, () => run(o.clone, 'evil', '--config-from-worktree')), /CONFIG_FROM_WORKTREE_PERSON_ONLY/);
  } finally { await h.close(); }
});

test('deploy main(): a default branch without deploy.json refuses; a non-main default branch works', async () => {
  const h = await startHealth();
  try {
    const bare = makeOrigin('main', { 'a.txt': 'a\n' });
    await assert.rejects(withEnv({}, () => run(bare.clone, 'qa')), /NO_DEPLOY_CONFIG_ON_DEFAULT/);
    const o = makeOrigin('cumulus/main', { '.trioharness/deploy.json': deployJson(h.url), 'a.txt': 'a\n' });
    h.state.sha = o.sha;
    assert.equal((await withEnv({}, () => run(o.clone, 'qa'))).dryRun, true);
  } finally { await h.close(); }
});

test('deploy main(): the running commit cannot be read → stop; a person may override by naming the target, an agent never', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': deployJson(h.url), 'a.txt': 'a\n' });
    for (const mode of ['forbidden', 'down', 'nosha']) {
      h.state.mode = mode;
      await assert.rejects(withEnv({}, () => run(o.clone, 'qa')), /RUNNING_REF_UNREADABLE/, mode);
      await assert.rejects(withEnv({ CLAUDECODE: '1' }, () => run(o.clone, 'qa', '--allow-unreadable', 'qa')), /RUNNING_REF_UNREADABLE/, `${mode}: agent`);
      await assert.rejects(withEnv({}, () => run(o.clone, 'qa', '--allow-unreadable', 'prd')), /RUNNING_REF_UNREADABLE/, `${mode}: wrong target`);
      assert.equal((await withEnv({}, () => run(o.clone, 'qa', '--allow-unreadable', 'qa'))).dryRun, true, `${mode}: person`);
    }
  } finally { await h.close(); }
});

test('deploy main(): replacing unmerged running code is still refused (2.31 behaviour kept)', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': deployJson(h.url), 'a.txt': 'a\n' });
    git(o.clone, 'checkout', '-q', '-b', 'feature/x'); const f = commit(o.clone, 'f.txt', 'f\n', 'feature only'); git(o.clone, 'push', '-q', 'origin', 'feature/x');
    git(o.clone, 'checkout', '-q', 'main');
    h.state.sha = f; // production runs the unmerged feature
    await assert.rejects(withEnv({}, () => run(o.clone, 'qa')), /WOULD_OVERWRITE_UNMERGED/);
    h.state.sha = o.sha; // running code is the tip: fine
    assert.equal((await withEnv({}, () => run(o.clone, 'qa'))).dryRun, true);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- the CI template (workflows that deploy outside the harness)
const CHECK = join(here, '..', 'templates', 'repo', 'github', 'pre-deploy-ancestor-check.sh');
// async on purpose: the health server lives in this process, so a blocking spawnSync would starve it
const runCheck = (clone, env) => new Promise(resolve => {
  const c = spawn('sh', [CHECK], { cwd: clone, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...GIT_ENV, ...env } });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  c.on('close', status => resolve({ status, stdout: out, stderr: '' }));
});
const check = runCheck;

test('ci template: deploys only when the running commit is part of the commit being deployed', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { 'a.txt': 'one\n' });
    const older = o.sha;
    const tip = commit(o.seed, 'a.txt', 'two\n', 'second'); git(o.seed, 'push', '-q', 'origin', 'main'); git(o.clone, 'pull', '-q', 'origin', 'main');
    git(o.clone, 'checkout', '-q', '-b', 'feature/x'); const f = commit(o.clone, 'f.txt', 'f\n', 'feature only'); git(o.clone, 'push', '-q', 'origin', 'feature/x'); git(o.clone, 'checkout', '-q', 'main');
    const env = { HEALTH_URL: h.url, TARGET_SHA: tip, SHA_FIELD: 'sha' };
    h.state.mode = 'sha';
    h.state.sha = tip; assert.equal((await check(o.clone, env)).status, 0, 'running = tip');
    h.state.sha = older; assert.equal((await check(o.clone, env)).status, 0, 'running is an ancestor');
    h.state.sha = older.slice(0, 12); assert.equal((await check(o.clone, env)).status, 0, 'a 12-character SHA works');
    h.state.sha = f; const r = await check(o.clone, env); assert.equal(r.status, 1, 'unmerged running code'); assert.match(r.stdout + r.stderr, /not an ancestor/);
    h.state.sha = 'deadbeef'.repeat(5); const u = await check(o.clone, env); assert.equal(u.status, 1, 'a commit in no branch'); assert.match(u.stdout + u.stderr, /no branch/);
    for (const mode of ['forbidden', 'down', 'nosha']) {
      h.state.mode = mode;
      const x = await check(o.clone, env); assert.equal(x.status, 1, mode); assert.match(x.stdout + x.stderr, /cannot read the running commit/);
      assert.equal((await check(o.clone, { ...env, ALLOW_UNREADABLE: h.url })).status, 0, `${mode}: a person's override`);
      assert.equal((await check(o.clone, { ...env, ALLOW_UNREADABLE: 'http://other' })).status, 1, `${mode}: override for another URL`);
    }
    h.state.mode = 'plain'; h.state.sha = older; assert.equal((await check(o.clone, { ...env, SHA_FIELD: '.' })).status, 0, 'plain-text endpoint');
    assert.notEqual(spawnSync('sh', [CHECK], { cwd: o.clone, encoding: 'utf8', env: { PATH: process.env.PATH } }).status, 0, 'missing HEALTH_URL stops');
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- H1: rollback authorization, build source, run-state flags
// A fake `az` on PATH records every call (args and cwd) and answers the few queries deploy.mjs makes. HOME and USERPROFILE point at a
// fresh temp dir, so deploy history never touches the real ~/.trioharness-lean. Nothing here removes a worktree or a directory.
const OLD_REV = 'app-prd--rold', NEW_SHA = 'b'.repeat(40);
// H2: the digest the fake ACR run record reports (RUN_DIGEST), a different one that the mutable tag would resolve to (TAG_DIGEST), and a third for mismatches.
const RUN_DIGEST = `sha256:${'c'.repeat(64)}`, TAG_DIGEST = `sha256:${'d'.repeat(64)}`, OTHER_DIGEST = `sha256:${'e'.repeat(64)}`;
const pinned = d => `x.azurecr.io/web@${d}`;
// H2r1: promotion scenarios give the source app (SRC_APP) and the destination app (DST_APP) distinct names, so the fake az can answer each shape query on its own.
const SRC_APP = 'ca-src', DST_APP = 'app-prd';
function fakeAz() {
  const dir = tmp('az'), log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'az'), `#!/bin/sh
printf '%s | %s\\n' "$*" "$(pwd)" >> "$FAKE_AZ_LOG"
case "$*" in
  *"revision list"*"[].{name:name,active:properties.active,created:properties.createdTime,weight:properties.trafficWeight}"*)
    n=0; [ -f "$FAKE_AZ_LOG.count" ] && n=$(cat "$FAKE_AZ_LOG.count"); n=$((n+1)); echo "$n" > "$FAKE_AZ_LOG.count"
    if [ "$n" -ge 3 ] && [ -n "$FAKE_CLEAN_REVALIDATE" ]; then echo "$FAKE_CLEAN_REVALIDATE"
    elif [ -f "$FAKE_AZ_LOG.switched" ] && [ -n "$FAKE_CLEAN_POST" ]; then echo "$FAKE_CLEAN_POST"; else echo "$FAKE_CLEAN_LIST"; fi ;;
  *"{latest:properties.latestRevisionName,maxInactive:properties.configuration.maxInactiveRevisions}"*) echo "$FAKE_CLEAN_APP" ;;
  *"{active:properties.active,state:properties.runningState,prov:properties.provisioningState}"*)
    [ -n "$FAKE_CLEAN_SHOW_ERROR" ] && { echo "$FAKE_CLEAN_SHOW_ERROR" >&2; exit 1; }
    if [ -f "$FAKE_AZ_LOG.activated" ]; then echo "$FAKE_CLEAN_READY"; else echo "$FAKE_CLEAN_SHOW"; fi ;;
  *"revision deactivate"*) echo 'AZ_OUTPUT_SENTINEL'; echo 'AZ_OUTPUT_SENTINEL' >&2
    [ -n "$FAKE_CLEAN_FAIL" ] && exit 1 ;;
  *"revision activate"*) echo 'AZ_OUTPUT_SENTINEL'; echo 'AZ_OUTPUT_SENTINEL' >&2
    [ -n "$FAKE_CLEAN_FAIL" ] && exit 1
    touch "$FAKE_AZ_LOG.activated" ;;
  *"ingress traffic set"*) if [ -n "$FAKE_CLEAN_LIST$FAKE_SWITCH_REVISIONS" ]; then revision=$(printf '%s' "$*" | sed -n 's/.*--revision-weight \\([^=]*\\)=100.*/\\1/p'); [ -n "$revision" ] && printf '%s' "$revision" > "$FAKE_AZ_LOG.switched"; fi ;;
  *"revision list"*"--query [].name"*) echo "$FAKE_SWITCH_REVISIONS" ;;
  *"webapp deployment slot list"*) echo "$FAKE_SWITCH_SLOTS" ;;
  *"webapp show"*"--slot"*) echo 'canary.test' ;;
  *"webapp show"*) echo 'production.test' ;;
  *"acr build"*) [ -n "$FAKE_AZ_FAIL_BUILD" ] && { echo "build failed" >&2; exit 1; }
    if [ -n "$FAKE_AZ_RUN_JSON" ]; then printf '%s\\n' "$FAKE_AZ_RUN_JSON"; else
      tag=$(printf '%s' "$*" | sed -n 's/.*--image web:\\([0-9a-f]*\\).*/\\1/p')
      printf '{"runId":"cb1","status":"Succeeded","outputImages":[{"registry":"x.azurecr.io","repository":"web","tag":"%s","digest":"%s"}]}\\n' "$tag" "$FAKE_AZ_RUN_DIGEST"
    fi; exit 0 ;;
  *"acr show"*) echo "x.azurecr.io" ;;
  *"acr repository show"*) echo "$FAKE_AZ_TAG_DIGEST" ;;
  *"activeRevisionsMode"*) app=$(printf '%s' "$*" | sed -n 's/.*--name \\([^ ]*\\).*/\\1/p')
    if [ "$app" = "${SRC_APP}" ] && [ -n "$FAKE_AZ_SHAPE_SRC" ]; then echo "$FAKE_AZ_SHAPE_SRC"
    elif [ "$app" = "${DST_APP}" ] && [ -n "$FAKE_AZ_SHAPE_DST" ]; then echo "$FAKE_AZ_SHAPE_DST"
    elif [ -n "$FAKE_AZ_SHAPE" ]; then echo "$FAKE_AZ_SHAPE"; else echo '{"mode":"Multiple","containers":["web"]}'; fi ;;
  *"revision show"*"].image"*) if [ -n "$FAKE_AZ_REV_IMAGE" ]; then echo "$FAKE_AZ_REV_IMAGE"; else echo "x.azurecr.io/web@$FAKE_AZ_RUN_DIGEST"; fi ;;
  *"revision show"*"properties.fqdn"*) [ -n "$FAKE_AZ_FQDN" ] && echo "$FAKE_AZ_FQDN" ;;
  *"containerapp update"*) if [ -n "$FAKE_STAGE_AFTER_TRAFFIC" ]; then touch "$FAKE_AZ_LOG.updated"; fi ;;
  *"properties.configuration.ingress.traffic"*) if [ -f "$FAKE_AZ_LOG.updated" ]; then echo "$FAKE_STAGE_AFTER_TRAFFIC"; elif [ -n "$FAKE_CLEAN_TRAFFIC_REVALIDATE" ] && [ -f "$FAKE_AZ_LOG.count" ] && [ "$(cat "$FAKE_AZ_LOG.count")" -ge 2 ]; then echo "$FAKE_CLEAN_TRAFFIC_REVALIDATE"; elif [ -f "$FAKE_AZ_LOG.switched" ]; then echo "[{\\\"revisionName\\\":\\\"$(cat "$FAKE_AZ_LOG.switched")\\\",\\\"weight\\\":100}]"; elif [ -n "$FAKE_AZ_TRAFFIC" ]; then echo "$FAKE_AZ_TRAFFIC"; else echo "[{\\"revisionName\\":\\"$FAKE_AZ_SERVING\\",\\"weight\\":100}]"; fi ;;
  *".env[].{name:name,secretRef:secretRef}"*) printf '%s\\n' "$FAKE_BUILD_ENV_METADATA" ;;
  *".env[?name=='NEXT.PUBLIC-ID'] | [0].value"*) printf '%s\\n' 'fixture-client-id' ;;
  *"].image"*) echo "x.azurecr.io/web:old" ;;
esac
exit 0
`);
  chmodSync(join(dir, 'az'), 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  const mutations = () => calls().filter(c => /containerapp update|ingress traffic set|webapp deploy |slot swap|acr build|revision deactivate|revision activate/.test(c));
  return { dir, log, calls, mutations };
}
// Runs fn with the fake az first on PATH, a fresh HOME, and the given extra env; restores everything afterwards.
async function withFake(az, env, fn) {
  const cleanKeys = ['FAKE_BUILD_ENV_METADATA', 'FAKE_STAGE_AFTER_TRAFFIC', 'FAKE_SWITCH_SLOTS', 'FAKE_SWITCH_REVISIONS', 'FAKE_CLEAN_TRAFFIC_REVALIDATE', 'FAKE_CLEAN_LIST', 'FAKE_CLEAN_POST', 'FAKE_CLEAN_REVALIDATE', 'FAKE_CLEAN_APP', 'FAKE_CLEAN_SHOW', 'FAKE_CLEAN_READY', 'FAKE_CLEAN_SHOW_ERROR', 'FAKE_CLEAN_FAIL'];
  const home = tmp('home'), keys = [...cleanKeys, 'PATH', 'HOME', 'USERPROFILE', 'FAKE_AZ_LOG', 'FAKE_AZ_SERVING', 'FAKE_AZ_FAIL_BUILD', 'FAKE_AZ_RUN_DIGEST', 'FAKE_AZ_TAG_DIGEST', 'FAKE_AZ_RUN_JSON', 'FAKE_AZ_REV_IMAGE', 'FAKE_AZ_SHAPE', 'FAKE_AZ_SHAPE_SRC', 'FAKE_AZ_SHAPE_DST', 'FAKE_AZ_TRAFFIC', 'FAKE_AZ_FQDN'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PATH: `${az.dir}:${process.env.PATH}`, HOME: home, USERPROFILE: home, FAKE_AZ_LOG: az.log, FAKE_AZ_SERVING: OLD_REV, FAKE_AZ_RUN_DIGEST: RUN_DIGEST, FAKE_AZ_TAG_DIGEST: TAG_DIGEST });
  for (const k of [...cleanKeys, 'FAKE_AZ_FAIL_BUILD', 'FAKE_AZ_RUN_JSON', 'FAKE_AZ_REV_IMAGE', 'FAKE_AZ_SHAPE', 'FAKE_AZ_SHAPE_SRC', 'FAKE_AZ_SHAPE_DST', 'FAKE_AZ_TRAFFIC', 'FAKE_AZ_FQDN']) delete process.env[k];
  try { return await withEnv(env, () => fn(home)); }
  finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const caTarget = (url, extra = {}) => ({ type: 'containerapp', subscription: 's', resourceGroup: 'rg', app: 'app-prd', registry: 'myacr', image: 'web', build: { dockerfile: 'Dockerfile' },
  health: { url, shaField: 'sha', timeoutSeconds: 1 }, agentAllowed: 'with-authorization', ...extra });

test('deploy config validates container names before any Azure calls', async t => {
  const url = 'https://health.invalid/health';
  const target = container => caTarget(url, { container, agentAllowed: true });
  const invalid = makeBuildOrigin({ qa: target("bad'name") });
  const valid = makeBuildOrigin({ web: target('web'), api: target('api-1') });
  const az = fakeAz();
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ sha: valid.sha })));
  await withFake(az, {}, async () => {
    await assert.rejects(run(invalid.clone, 'qa'), error => error instanceof Refusal &&
      error.message === 'CONFIG_INVALID: targets.qa.container must match ^[a-z0-9][a-z0-9-]*$');
    assert.equal(fetch.mock.callCount(), 0);
    for (const name of ['web', 'api']) assert.equal((await run(valid.clone, name)).dryRun, true);
    assert.deepEqual(az.calls(), []);
  });
});

const historyPath = (home, repo, target) => join(appHistory.appHistoryDir(JSON.parse(git(repo, 'show', 'refs/remotes/origin/HEAD:.trioharness/deploy.json')).targets[target], home), 'history.json');
// H3: history.json is the legacy input only (fixtures write it, deploy.mjs never does). New entries are history.d/<NNNNNN>.json, one-element arrays.
const artifactsOf = (home, repo, target) => dirname(historyPath(home, repo, target));
const historyDirOf = (home, repo, target) => join(artifactsOf(home, repo, target), 'history.d');
const historyFiles = (home, repo, target) => { const d = historyDirOf(home, repo, target); return existsSync(d) ? readdirSync(d).sort() : []; };
const OLD_SHA = 'a'.repeat(40);
// A source-history entry as this script writes it after a digest-pinned deploy.
const verifiedEntry = (sha, over = {}) => ({ sha, image: pinned(RUN_DIGEST), digest: RUN_DIGEST, runId: 'cb1', imageTag: `x.azurecr.io/web:${sha}`, revision: OLD_REV, verified: true, rollback: false, ...over });

// History as the script writes it after one deploy: the last entry knows its previous revision (instant traffic switch) or only its previous image.
function seedHistory(home, repo, target, { withRevision }) {
  const f = historyPath(home, repo, target);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify([
    { sha: OLD_SHA, image: `x.azurecr.io/web:${OLD_SHA}`, revision: OLD_REV, at: '2026-01-01T00:00:00.000Z', rollback: false, verified: true },
    { sha: NEW_SHA, image: `x.azurecr.io/web:${NEW_SHA}`, previousImage: `x.azurecr.io/web:${OLD_SHA}`, ...(withRevision ? { previousRevision: OLD_REV } : {}), at: '2026-01-02T00:00:00.000Z', rollback: false, verified: true },
  ]));
  return f;
}
const rollbackRun = (clone, ...more) => main(['--repo', clone, '--target', 'prd', '--rollback', '--live-retry-ms', '1', ...more]);

for (const kind of ['revision', 'image']) {
  test(`deploy main(): a ${kind} rollback on a with-authorization target needs the per-rollback phrase (no az mutation, no history write without it)`, async () => {
    const h = await startHealth();
    try {
      const o = makeOrigin('main', { '.trioharness/deploy.json': JSON.stringify({ schema: 1, targets: { prd: caTarget(h.url) } }), 'a.txt': 'a\n' });
      h.state.sha = OLD_SHA; // the rolled-back code is what must end up reported
      const phrase = kind === 'revision' ? `app-prd:rollback:${OLD_REV}` : `app-prd:rollback:${OLD_SHA.slice(0, 12)}`;
      const deployPhrase = `app-prd:${OLD_SHA.slice(0, 12)}`;
      const az = fakeAz();
      await withFake(az, { CLAUDECODE: '1' }, async home => {
        const f = seedHistory(home, o.clone, 'prd', { withRevision: kind === 'revision' });
        const before = readFileSync(f, 'utf8');
        for (const [why, extra] of [['missing', []], ['wrong', ['--authorize', 'wrong']], ['the deploy phrase', ['--authorize', deployPhrase]], ['another revision', ['--authorize', 'app-prd:rollback:app-prd--rzzz']]]) {
          await assert.rejects(rollbackRun(o.clone, ...extra), /AUTHORIZATION_REQUIRED/, why);
          assert.deepEqual(az.mutations(), [], `${why}: no az mutation`);
          assert.equal(readFileSync(f, 'utf8'), before, `${why}: no history write`);
          assert.ok(!existsSync(historyDirOf(home, o.clone, 'prd')), `${why}: no history.d was created (A6)`);
        }
        // dry run is allowed without the phrase and prints it
        const dry = await rollbackRun(o.clone, '--dry-run');
        assert.equal(dry.dryRun, true);
        assert.ok(JSON.stringify(dry.plan).includes(phrase), `dry-run plan carries ${phrase}: ${JSON.stringify(dry.plan)}`);
        assert.deepEqual(az.mutations(), []);
        assert.equal(readFileSync(f, 'utf8'), before);
        assert.ok(!existsSync(historyDirOf(home, o.clone, 'prd')), 'a dry run creates no history.d (A6)');
        // the exact phrase proceeds
        const r = await rollbackRun(o.clone, '--authorize', phrase);
        assert.equal(r.rolledBack, true);
        const muts = az.mutations();
        assert.equal(muts.length, 1, muts.join('\n'));
        assert.match(muts[0], kind === 'revision' ? /ingress traffic set .*--revision-weight app-prd--rold=100/ : /containerapp update .*--image x\.azurecr\.io\/web:a{40}/);
        // H3 (A1, A2): the legacy file keeps its two entries byte for byte; the rollback entry is the third logical entry, in its own new file.
        assert.equal(readFileSync(f, 'utf8'), before, 'the legacy history.json is read only');
        assert.equal(readAllHistory(artifactsOf(home, o.clone, 'prd')).length, 3, 'history gained the rollback entry');
        assert.deepEqual(historyFiles(home, o.clone, 'prd'), ['000001.json']);
        const added = JSON.parse(readFileSync(join(historyDirOf(home, o.clone, 'prd'), '000001.json'), 'utf8'));
        assert.ok(Array.isArray(added) && added.length === 1 && added[0].rollback === true, 'one-element array holding the rollback entry');
        assert.equal(readAllHistory(artifactsOf(home, o.clone, 'prd')).at(-1).rollback, true, 'the new entry is the latest');
      });
    } finally { await h.close(); }
  });
}

test('deploy main(): an image-only rollback with no recorded SHA takes its phrase from the image tag', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': JSON.stringify({ schema: 1, targets: { prd: caTarget(h.url) } }), 'a.txt': 'a\n' });
    h.state.sha = OLD_SHA;
    const phrase = `app-prd:rollback:${OLD_SHA.slice(0, 12)}`;
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async home => {
      const f = historyPath(home, o.clone, 'prd'); mkdirSync(dirname(f), { recursive: true });
      // one recorded deploy that only knows its previous image: no previous revision, no earlier verified entry → sha is unknown
      writeFileSync(f, JSON.stringify([{ sha: NEW_SHA, image: `x.azurecr.io/web:${NEW_SHA}`, previousImage: `x.azurecr.io/web:${OLD_SHA}`, at: '2026-01-02T00:00:00.000Z', rollback: false, verified: true }]));
      const before = readFileSync(f, 'utf8');
      for (const [why, extra] of [['missing', []], ['wrong', ['--authorize', 'wrong']], ['the deploy phrase', ['--authorize', `app-prd:${NEW_SHA.slice(0, 12)}`]], ['the "null" phrase', ['--authorize', 'app-prd:rollback:null']]]) {
        await assert.rejects(rollbackRun(o.clone, ...extra), /AUTHORIZATION_REQUIRED/, why);
        assert.deepEqual(az.mutations(), [], `${why}: no az mutation`);
        assert.equal(readFileSync(f, 'utf8'), before, `${why}: no history write`);
      }
      const dry = await rollbackRun(o.clone, '--dry-run');
      assert.equal(dry.plan.sha, null);
      assert.equal(dry.plan.authorizationPhrase, phrase);
      assert.equal((await rollbackRun(o.clone, '--authorize', phrase)).rolledBack, true);
      assert.equal(az.mutations().length, 1);
      assert.match(az.mutations()[0], /containerapp update .*--image x\.azurecr\.io\/web:a{40}/);
    });
  } finally { await h.close(); }
});

test('deploy main(): a rollback on an agent-allowed target needs no phrase', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': JSON.stringify({ schema: 1, targets: { prd: caTarget(h.url, { agentAllowed: true }) } }), 'a.txt': 'a\n' });
    h.state.sha = OLD_SHA;
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async home => {
      seedHistory(home, o.clone, 'prd', { withRevision: true });
      assert.equal((await rollbackRun(o.clone)).rolledBack, true);
      assert.equal(az.mutations().length, 1);
    });
  } finally { await h.close(); }
});

// A repo whose tracked files include non-UTF-8 bytes and an executable, to prove the extract is byte- and mode-exact.
const BIN = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0d, 0x0a, 0xc3, 0x28, 0x7f]);
function makeBuildOrigin(targets) {
  const o = makeOrigin('main', { '.trioharness/deploy.json': JSON.stringify({ schema: 1, targets }), 'Dockerfile': 'FROM scratch\n', 'a.txt': 'a\n' });
  writeFileSync(join(o.clone, 'bin.dat'), BIN);
  writeFileSync(join(o.clone, 'run.sh'), '#!/bin/sh\necho hi\n'); chmodSync(join(o.clone, 'run.sh'), 0o755);
  git(o.clone, 'add', '-A'); git(o.clone, 'commit', '-q', '-m', 'binary and executable'); git(o.clone, 'push', '-q', 'origin', 'main');
  return { ...o, sha: git(o.clone, 'rev-parse', 'HEAD') };
}
const worktreeEntries = clone => { const d = join(clone, '.git', 'worktrees'); return existsSync(d) ? readdirSync(d) : []; };
const buildDirOf = text => { const m = /buildDir (\S+)/.exec(String(text)); assert.ok(m, `no buildDir in: ${text}`); return m[1]; };

test('deploy main(): a containerapp build exports the commit with git archive, registers no worktree and keeps the build dir', async () => {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
    h.state.sha = o.sha;
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async () => {
      process.env.FAKE_AZ_FAIL_BUILD = '1'; // the build fails, which is exactly when the dir must be kept and reported
      let msg = '';
      await assert.rejects(main(['--repo', o.clone, '--target', 'qa', '--sha', o.sha, '--live-retry-ms', '1']), e => { msg = e.message; return e instanceof Refusal && /ACR_BUILD_FAILED/.test(e.message); });
      const dir = buildDirOf(msg);
      const src = join(dir, 'src');
      assert.ok(existsSync(src), 'the extracted source is kept');
      assert.ok(existsSync(join(dir, 'src.tar')), 'the archive is kept');
      assert.deepEqual(readFileSync(join(src, 'bin.dat')), BIN, 'bytes survive the archive');
      assert.ok(statSync(join(src, 'run.sh')).mode & 0o100, 'the executable bit survives');
      assert.ok(!existsSync(join(src, '.git')), 'a plain extract, not a checkout');
      assert.deepEqual(worktreeEntries(o.clone), [], 'no worktree was registered');
      const build = az.calls().find(c => /acr build/.test(c));
      assert.ok(build, 'acr build ran');
      assert.ok(build.endsWith(` | ${realpathSync(src)}`) || build.endsWith(` | ${src}`), `acr build ran in the extract: ${build}`);
    });
  } finally { await h.close(); }
});

test('deploy main(): a failure after the build still reports the kept build dir (REVISION_FQDN_MISSING keeps its code)', async () => {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
    h.state.sha = o.sha;
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async () => {
      let err;
      // the fake az builds fine but answers no hostname for the new revision
      await assert.rejects(main(['--repo', o.clone, '--target', 'qa', '--sha', o.sha, '--live-retry-ms', '1']), e => { err = e; return true; });
      assert.ok(err instanceof Refusal && /^REVISION_FQDN_MISSING/.test(err.message), err.message);
      const dir = buildDirOf(err.message);
      assert.ok(existsSync(join(dir, 'src', 'a.txt')), 'the extracted source is still there');
      assert.ok(az.calls().some(c => /acr build/.test(c)) && az.calls().some(c => /containerapp update/.test(c)), 'the failure came after the build and the update');
      assert.deepEqual(worktreeEntries(o.clone), []);
    });
  } finally { await h.close(); }
});

test('deploy main(): a promotion makes no source at all', async () => {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }), prd: caTarget(h.url, { agentAllowed: true, promoteFrom: 'qa', requireSameShaOn: 'qa' }) });
    h.state.sha = o.sha;
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async home => {
      const f = historyPath(home, o.clone, 'qa'); mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify([verifiedEntry(o.sha)]));
      // revision query returns no hostname → the run stops after the (skipped) build block; what matters is that no build and no source happened
      const scratch = tmp('tmpdir'), savedTmp = process.env.TMPDIR;
      process.env.TMPDIR = scratch; // os.tmpdir() is read at call time: any work dir deploy.mjs allocates lands here
      try {
        let msg = '';
        await assert.rejects(main(['--repo', o.clone, '--target', 'prd', '--sha', o.sha, '--live-retry-ms', '1']), e => { msg = e.message; return /REVISION_FQDN_MISSING/.test(msg); });
        assert.ok(!/buildDir/.test(msg), `a promotion has no build dir: ${msg}`);
        assert.deepEqual(readdirSync(scratch).filter(n => n.startsWith('trio-deploy-')), [], 'no trio-deploy-* source dir was created');
      } finally { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; }
      assert.ok(!az.calls().some(c => /acr build/.test(c)), 'no build');
      assert.deepEqual(worktreeEntries(o.clone), []);
    });
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- H2: digest-pinned deploy and promotion (written, not executed)
test('deploy main(): the update uses the digest from this build\'s ACR run record, never the mutable tag\'s digest', async () => {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
    h.state.sha = o.sha;
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async () => {
      // the fake tag now resolves to TAG_DIGEST while the run record says RUN_DIGEST; the new revision runs the pinned run digest
      await assert.rejects(main(['--repo', o.clone, '--target', 'qa', '--sha', o.sha, '--live-retry-ms', '1']), e => e instanceof Refusal && /^REVISION_FQDN_MISSING/.test(e.message));
      const build = az.calls().find(c => /acr build/.test(c));
      assert.match(build, /--output json/, 'the build asks for its run record');
      const update = az.calls().find(c => /containerapp update/.test(c));
      assert.ok(update, 'the update ran');
      assert.ok(update.includes(`--image ${pinned(RUN_DIGEST)} `), `the update is pinned to the run digest: ${update}`);
      assert.ok(!update.includes(TAG_DIGEST) && !update.includes(`web:${o.sha}`), 'neither the tag nor the tag digest is used');
      assert.ok(!az.calls().some(c => /acr repository show/.test(c)), 'the mutable tag is never read as provenance');
    });
  } finally { await h.close(); }
});

test('deploy main(): a missing, failed, ambiguous or digest-less ACR run record refuses ACR_RUN_UNREADABLE before any update', async () => {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
    h.state.sha = o.sha;
    const img = (over = {}) => ({ registry: 'x.azurecr.io', repository: 'web', tag: o.sha, digest: RUN_DIGEST, ...over });
    const records = {
      'not json': 'build ok',
      'no runId': JSON.stringify({ status: 'Succeeded', outputImages: [img()] }),
      'failed run': JSON.stringify({ runId: 'cb1', status: 'Failed', outputImages: [img()] }),
      'no output for this tag': JSON.stringify({ runId: 'cb1', status: 'Succeeded', outputImages: [img({ tag: 'other' })] }),
      'another repository': JSON.stringify({ runId: 'cb1', status: 'Succeeded', outputImages: [img({ repository: 'api' })] }),
      'ambiguous': JSON.stringify({ runId: 'cb1', status: 'Succeeded', outputImages: [img(), img()] }),
      'invalid digest': JSON.stringify({ runId: 'cb1', status: 'Succeeded', outputImages: [img({ digest: 'sha256:xyz' })] }),
    };
    for (const [why, record] of Object.entries(records)) {
      const az = fakeAz();
      await withFake(az, { CLAUDECODE: '1' }, async () => {
        process.env.FAKE_AZ_RUN_JSON = record;
        let msg = '';
        await assert.rejects(main(['--repo', o.clone, '--target', 'qa', '--sha', o.sha, '--live-retry-ms', '1']), e => { msg = e.message; return e instanceof Refusal && /^ACR_RUN_UNREADABLE/.test(e.message); }, why);
        assert.ok(existsSync(join(buildDirOf(msg), 'src', 'a.txt')), `${why}: the build dir is kept`);
        assert.ok(!az.calls().some(c => /containerapp update|ingress traffic set/.test(c)), `${why}: no update and no traffic switch`);
      });
    }
  } finally { await h.close(); }
});

test('deploy main(): a new revision whose image is not the pinned reference refuses REVISION_IMAGE_MISMATCH and never gets traffic', async () => {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
    h.state.sha = o.sha;
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async () => {
      process.env.FAKE_AZ_REV_IMAGE = pinned(OTHER_DIGEST); // the revision runs other bytes than the build produced
      let err;
      await assert.rejects(main(['--repo', o.clone, '--target', 'qa', '--sha', o.sha, '--live-retry-ms', '1']), e => { err = e; return true; });
      assert.ok(err instanceof Refusal && /^REVISION_IMAGE_MISMATCH/.test(err.message), err.message);
      assert.ok(az.calls().some(c => /containerapp update/.test(c)), 'the revision was created');
      assert.ok(!az.calls().some(c => /ingress traffic set/.test(c)), 'no traffic switch at all, not even the keep-old-revision call');
      assert.ok(!az.calls().some(c => /properties\.fqdn/.test(c)), 'the canary was never started');
    });
  } finally { await h.close(); }
});

// A promotion from qa to prd with the source history entry `entry`; the fake az reports what qa serves.
async function promoteScenario({ entry, servingImage, extra = [], env = {}, seed = null }, check) {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ qa: caTarget(h.url, { app: SRC_APP, agentAllowed: true, container: 'web' }), prd: caTarget(h.url, { app: DST_APP, agentAllowed: true, container: 'web', promoteFrom: 'qa', requireSameShaOn: 'qa' }) });
    h.state.sha = o.sha;
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async home => {
      const f = historyPath(home, o.clone, 'qa'); mkdirSync(dirname(f), { recursive: true });
      if (seed) seed({ artifacts: dirname(f), legacy: f, sha: o.sha }); // H3: a test may lay out a longer or mixed legacy + history.d source history itself
      else writeFileSync(f, JSON.stringify([entry(o.sha)]));
      if (servingImage) process.env.FAKE_AZ_REV_IMAGE = servingImage;
      Object.assign(process.env, env);
      const run = (...more) => main(['--repo', o.clone, '--target', 'prd', '--sha', o.sha, '--live-retry-ms', '1', ...extra, ...more]);
      await check({ az, run, o, home, h });
    });
  } finally { await h.close(); }
}

// Makes the canary reachable: the fake az answers a revision hostname, and fetch sends that hostname to a second local health server whose
// reported SHA the test controls (the public health server stays separate). fetch and FAKE_AZ_FQDN are restored afterwards.
async function withCanary(canarySha, fn) {
  const c = await startHealth(); c.state.sha = canarySha;
  const real = globalThis.fetch, hits = { canary: 0, other: 0 };
  globalThis.fetch = (u, init) => { const isCanary = new URL(String(u)).host === 'canary.test'; hits[isCanary ? 'canary' : 'other']++; return real(isCanary ? c.url : String(u), init); };
  process.env.FAKE_AZ_FQDN = 'canary.test';
  try { return await fn({ canary: c, hits }); }
  finally { globalThis.fetch = real; delete process.env.FAKE_AZ_FQDN; await c.close(); }
}
const destMutations = az => az.calls().filter(c => /containerapp update|ingress traffic set/.test(c));
// H3: the logical history is the legacy array (if any) followed by history.d, exactly as deploy.mjs reads it.
const readHistory = (home, repo, target) => readAllHistory(artifactsOf(home, repo, target));

// main has no fetch injection parameter. Pure guard tests pin only their exact fixture health URL;
// other URLs and the real-HTTP tests retain the original fetch implementation.
async function withFixtureHealthSha(healthUrl, sha, check) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => String(url) === healthUrl
    ? Promise.resolve(new Response(JSON.stringify({ sha }), { status: 200 }))
    : realFetch(url, init);
  try { return await check(); }
  finally { globalThis.fetch = realFetch; }
}

test('deploy main(): a promotion refuses when qa serves a different digest than its history verified (dry run too, zero mutations)', async () => {
  await promoteScenario({ entry: sha => verifiedEntry(sha), servingImage: pinned(OTHER_DIGEST) }, async ({ az, run, o, h }) => {
    await withFixtureHealthSha(h.url, o.sha, async () => {
      await assert.rejects(run('--dry-run'), e => e instanceof Refusal && /^PROMOTE_SOURCE_DIGEST_MISMATCH/.test(e.message));
      await assert.rejects(run(), e => e instanceof Refusal && /^PROMOTE_SOURCE_DIGEST_MISMATCH/.test(e.message));
      assert.deepEqual(az.mutations(), [], 'nothing was changed on the destination');
    });
  });
});

test('deploy main(): a promotion refuses when qa serves another revision than its history verified', async () => {
  await promoteScenario({ entry: sha => verifiedEntry(sha, { revision: 'app-prd--rzzz' }) }, async ({ az, run, o, h }) => {
    await withFixtureHealthSha(h.url, o.sha, async () => {
      await assert.rejects(run('--dry-run'), e => e instanceof Refusal && /^PROMOTE_SOURCE_DIGEST_MISMATCH/.test(e.message));
      await assert.rejects(run(), e => e instanceof Refusal && /^PROMOTE_SOURCE_DIGEST_MISMATCH/.test(e.message));
      assert.deepEqual(az.mutations(), []);
    });
  });
});

test('deploy main(): a promotion from a legacy history entry without a digest refuses PROMOTE_SOURCE_NO_DIGEST (dry run too, zero mutations)', async () => {
  await promoteScenario({ entry: sha => ({ sha, image: `x.azurecr.io/web:${sha}`, verified: true, rollback: false, revision: OLD_REV }) }, async ({ az, run, o, h }) => {
    await withFixtureHealthSha(h.url, o.sha, async () => {
      await assert.rejects(run('--dry-run'), e => e instanceof Refusal && /^PROMOTE_SOURCE_NO_DIGEST/.test(e.message));
      await assert.rejects(run(), e => e instanceof Refusal && /^PROMOTE_SOURCE_NO_DIGEST/.test(e.message));
      assert.deepEqual(az.mutations(), []);
    });
  });
});

test('deploy main(): a matching promotion plans the source revision, digest and run, then updates with the pinned digest', async () => {
  await promoteScenario({ entry: sha => verifiedEntry(sha) }, async ({ az, run, o, h }) => {
    await withFixtureHealthSha(h.url, o.sha, async () => {
      const dry = await run('--dry-run');
      assert.equal(dry.dryRun, true);
      assert.equal(dry.plan.promotedImage, pinned(RUN_DIGEST));
      assert.equal(dry.plan.promotedRevision, OLD_REV);
      assert.equal(dry.plan.promotedDigest, RUN_DIGEST);
      assert.equal(dry.plan.promotedRunId, 'cb1');
      assert.deepEqual(az.mutations(), [], 'a dry run mutates nothing');
      // the fake gives the new revision no hostname, so the run stops there; the update must already carry the source digest and no build ran
      await assert.rejects(run(), e => e instanceof Refusal && /^REVISION_FQDN_MISSING/.test(e.message));
      const update = az.calls().find(c => /containerapp update/.test(c));
      assert.ok(update && update.includes(`--image ${pinned(RUN_DIGEST)} `), `pinned to the source digest: ${update}`);
      assert.ok(!az.calls().some(c => /acr build/.test(c)), 'no build');
    });
  });
});

test('deploy main(): a full digest-pinned deploy persists the run digest, runId, tag, full sha and revision, with the image guard before any traffic call', async () => {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true, container: 'web' }) });
    h.state.sha = o.sha;
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async home => {
      await withCanary(o.sha, async ({ hits }) => {
        const r = await main(['--repo', o.clone, '--target', 'qa', '--sha', o.sha, '--live-retry-ms', '1']);
        assert.equal(r.deployed, true);
        assert.equal(r.canaryVerified, true);
        assert.ok(hits.canary > 0, 'the canary was read on the revision hostname');
        const rev = `app-prd--r${o.sha.slice(0, 8)}`;
        const history = readHistory(home, o.clone, 'qa');
        assert.equal(history.length, 2, 'the intent precedes the final verified entry');
        const [intent, entry] = history;
        assert.deepEqual(intent, { ...entry, verified: false, intent: true, at: intent.at }, 'the intent carries the same revision and full provenance');
        assert.ok(!Object.hasOwn(entry, 'intent'), 'the final entry is not an intent');
        assert.equal(entry.sha, o.sha, 'the full 40-character sha');
        assert.equal(entry.digest, RUN_DIGEST, 'the digest of this build\'s run, not the tag\'s');
        assert.equal(entry.runId, 'cb1');
        assert.equal(entry.image, pinned(RUN_DIGEST));
        assert.equal(entry.imageTag, `x.azurecr.io/web:${o.sha}`);
        assert.equal(entry.revision, rev);
        assert.equal(entry.previousRevision, OLD_REV);
        assert.equal(entry.verified, true);
        // H3 (A1, A2, B2), S2-C2: no legacy file is created; intent and final entries use successive files, with no container artifact.
        assert.ok(!existsSync(historyPath(home, o.clone, 'qa')), 'history.json is never created');
        assert.deepEqual(historyFiles(home, o.clone, 'qa'), ['000001.json', '000002.json']);
        assert.ok(!Object.hasOwn(entry, 'artifact'), 'a containerapp entry has no artifact field');
        const calls = az.calls();
        const at = re => calls.findIndex(c => re.test(c));
        assert.ok(at(/activeRevisionsMode/) >= 0 && at(/activeRevisionsMode/) < at(/containerapp update/), 'the shape preflight precedes the update');
        const update = calls.find(c => /containerapp update/.test(c));
        assert.ok(update.includes(`--image ${pinned(RUN_DIGEST)} `) && update.includes('--container-name web'), update);
        const imageRead = calls.findIndex(c => /revision show .*--revision .*].image/.test(c));
        const firstTraffic = at(/ingress traffic set/);
        assert.ok(imageRead > at(/containerapp update/) && imageRead < firstTraffic, 'the revision image is read after the update and before any traffic call');
        const traffic = calls.filter(c => /ingress traffic set/.test(c));
        assert.equal(traffic.length, 2);
        assert.match(traffic[0], new RegExp(`--revision-weight ${OLD_REV}=100`));
        assert.match(traffic[1], new RegExp(`--revision-weight ${rev}=100`));
        assert.ok(calls.some(c => /containers\[\?name=='web'\] \| \[0\]\.image/.test(c) && !/revision show/.test(c)), 'the named-container image query ran');
      });
    });
  } finally { await h.close(); }
});

test('deploy main(): a full promotion keeps the source provenance and rebuilds nothing', async () => {
  await promoteScenario({ entry: sha => verifiedEntry(sha, { at: '2026-01-01T00:00:00.000Z' }) }, async ({ az, run, o, home }) => {
    await withCanary(o.sha, async ({ hits }) => {
      const r = await run();
      assert.equal(r.deployed, true);
      assert.equal(r.canaryVerified, true);
      assert.ok(hits.canary > 0);
      const rev = `app-prd--r${o.sha.slice(0, 8)}`;
      const history = readHistory(home, o.clone, 'prd');
      assert.equal(history.length, 2, 'the promotion intent precedes the final verified entry');
      const [intent, entry] = history;
      assert.deepEqual(intent, { ...entry, verified: false, intent: true, at: intent.at }, 'the promotion intent carries the source provenance and destination revision');
      assert.ok(!Object.hasOwn(entry, 'intent'), 'the final promotion entry is not an intent');
      assert.equal(entry.sha, o.sha);
      assert.equal(entry.promotedFrom, 'qa');
      assert.equal(entry.digest, RUN_DIGEST, 'the source digest is kept');
      assert.equal(entry.runId, 'cb1', 'the source run is kept');
      assert.equal(entry.imageTag, `x.azurecr.io/web:${o.sha}`);
      assert.equal(entry.image, pinned(RUN_DIGEST));
      assert.equal(entry.revision, rev);
      assert.equal(entry.verified, true);
      assert.ok(!az.calls().some(c => /acr build/.test(c)), 'no build');
      const update = az.calls().find(c => /containerapp update/.test(c));
      assert.ok(update.includes(`--image ${pinned(RUN_DIGEST)} `), update);
      assert.deepEqual(readHistory(home, o.clone, 'qa'), [verifiedEntry(o.sha, { at: '2026-01-01T00:00:00.000Z' })], 'the source history is untouched');
      assert.deepEqual(historyFiles(home, o.clone, 'qa'), [], 'H3: the promotion source gained no history file');
      assert.deepEqual(historyFiles(home, o.clone, 'prd'), ['000001.json', '000002.json'], 'H3, S2-C2: the destination intent and verified entry have successive new files');
      assert.ok(!existsSync(historyPath(home, o.clone, 'prd')), 'H3: no legacy history.json was created for the destination');
    });
  });
});

const SPLIT = JSON.stringify([{ revisionName: OLD_REV, weight: 60 }, { revisionName: 'app-prd--rnew', weight: 40 }]);
const LATEST = JSON.stringify([{ latestRevision: true, weight: 100 }]);
for (const [why, traffic] of [['split', SPLIT], ['latest-revision', LATEST], ['malformed', 'not json'], ['empty', '[]']]) {
  test(`deploy main(): a promotion refuses ${why} source traffic with TRAFFIC_NOT_PINNED (dry run too, zero destination mutations)`, async () => {
    await promoteScenario({ entry: sha => verifiedEntry(sha), env: { FAKE_AZ_TRAFFIC: traffic } }, async ({ az, run }) => {
      await assert.rejects(run('--dry-run'), e => e instanceof Refusal && /^TRAFFIC_NOT_PINNED/.test(e.message));
      await assert.rejects(run(), e => e instanceof Refusal && /^TRAFFIC_NOT_PINNED/.test(e.message));
      assert.deepEqual(az.mutations(), [], 'no destination mutation');
    });
  });
}

const UNSAFE_SHAPES = {
  'Single revisions mode': JSON.stringify({ mode: 'Single', containers: ['web'] }),
  'two containers': JSON.stringify({ mode: 'Multiple', containers: ['web', 'sidecar'] }),
  'a different container than the target names': JSON.stringify({ mode: 'Multiple', containers: ['api'] }),
  'an unreadable shape': 'not json',
};
for (const [why, shape] of Object.entries(UNSAFE_SHAPES)) {
  test(`deploy main(): a build deploy onto an app with ${why} refuses APP_SHAPE_UNSAFE before any update or traffic call`, async () => {
    const h = await startHealth();
    try {
      const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true, container: 'web' }) });
      h.state.sha = o.sha;
      const az = fakeAz();
      await withFake(az, { CLAUDECODE: '1' }, async () => {
        process.env.FAKE_AZ_SHAPE = shape;
        await assert.rejects(main(['--repo', o.clone, '--target', 'qa', '--sha', o.sha, '--live-retry-ms', '1']), e => e instanceof Refusal && /^APP_SHAPE_UNSAFE/.test(e.message));
        assert.deepEqual(destMutations(az), [], 'no update and no traffic call');
      });
    } finally { await h.close(); }
  });
}

test('deploy main(): a promotion onto a Single-mode or two-container destination refuses APP_SHAPE_UNSAFE with zero destination mutations', async () => {
  for (const shape of [UNSAFE_SHAPES['Single revisions mode'], UNSAFE_SHAPES['two containers']]) {
    // H2r1: the source shape is pinned valid and only the destination is unsafe, so this still exercises the destination guard.
    await promoteScenario({ entry: sha => verifiedEntry(sha), env: { FAKE_AZ_SHAPE_DST: shape } }, async ({ az, run }) => {
      await assert.rejects(run(), e => e instanceof Refusal && /^APP_SHAPE_UNSAFE/.test(e.message));
      assert.deepEqual(az.mutations(), []);
      assert.ok(shapeQueries(az, SRC_APP).length > 0 && shapeQueries(az, DST_APP).length > 0, 'the source passed its shape check and the destination guard fired');
      assert.deepEqual(destMutations(az), [], 'the destination guard refused before the update');
    });
  }
});

// H2r1: the source app must itself be Multiple-mode with one container of the expected name; refused before any source traffic, revision or image is accepted.
const appCalls = (az, app) => az.calls().filter(c => c.includes(` --name ${app} `));
const shapeQueries = (az, app) => appCalls(az, app).filter(c => /activeRevisionsMode/.test(c));
for (const [why, shape] of Object.entries(UNSAFE_SHAPES)) {
  test(`deploy main(): a promotion from a source app with ${why} refuses APP_SHAPE_UNSAFE before any source traffic or image read (dry run too, zero mutations)`, async () => {
    // the destination shape is pinned valid and only the source is unsafe
    await promoteScenario({ entry: sha => verifiedEntry(sha), env: { FAKE_AZ_SHAPE_SRC: shape, FAKE_AZ_SHAPE_DST: JSON.stringify({ mode: 'Multiple', containers: ['web'] }) } }, async ({ az, run, o, h }) => {
      await withFixtureHealthSha(h.url, o.sha, async () => {
        await assert.rejects(run('--dry-run'), e => e instanceof Refusal && /^APP_SHAPE_UNSAFE/.test(e.message));
        await assert.rejects(run(), e => e instanceof Refusal && /^APP_SHAPE_UNSAFE/.test(e.message));
        assert.ok(shapeQueries(az, SRC_APP).length >= 2, 'the source shape was read in both modes');
        assert.deepEqual(appCalls(az, SRC_APP).filter(c => /ingress\.traffic|revision show/.test(c)), [], 'no source traffic, revision or image read');
        assert.deepEqual(appCalls(az, DST_APP), [], 'the destination was never touched');
        assert.deepEqual(az.mutations(), [], 'nothing was changed');
      });
    });
  });
}

test('deploy main(): a promotion reads the source shape before the source traffic and the source revision image', async () => {
  await promoteScenario({ entry: sha => verifiedEntry(sha) }, async ({ az, run }) => {
    const dry = await run('--dry-run');
    assert.equal(dry.dryRun, true);
    const src = appCalls(az, SRC_APP);
    const at = re => src.findIndex(c => re.test(c));
    assert.ok(at(/activeRevisionsMode/) >= 0, 'the source shape was read');
    assert.ok(at(/activeRevisionsMode/) < at(/ingress\.traffic/), 'the source shape precedes the source traffic read');
    assert.ok(at(/ingress\.traffic/) < at(/revision show/), 'the source traffic precedes the source revision image read');
    assert.deepEqual(appCalls(az, DST_APP), [], 'a dry run reads nothing from the destination');
  });
});

for (const [why, traffic] of [['split', SPLIT], ['latest-revision', LATEST], ['malformed', 'not json']]) {
  test(`deploy main(): a deploy onto an app whose traffic is ${why} refuses TRAFFIC_NOT_PINNED before any update or traffic call`, async () => {
    const h = await startHealth();
    try {
      const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true, container: 'web' }) });
      h.state.sha = o.sha;
      const az = fakeAz();
      await withFake(az, { CLAUDECODE: '1' }, async () => {
        process.env.FAKE_AZ_TRAFFIC = traffic;
        await assert.rejects(main(['--repo', o.clone, '--target', 'qa', '--sha', o.sha, '--live-retry-ms', '1']), e => e instanceof Refusal && /^TRAFFIC_NOT_PINNED/.test(e.message));
        assert.deepEqual(destMutations(az), []);
      });
    } finally { await h.close(); }
  });
}

test('deploy main(): a non-container build keeps its detached worktree and reports the build dir', async () => {
  const h = await startHealth();
  try {
    const target = { subscription: 's', resourceGroup: 'rg', app: 'app-web', outputDir: '{out}', agentAllowed: true, health: { url: h.url, shaField: 'sha', timeoutSeconds: 5 },
      build: [{ command: 'node', args: ['-e', "const fs=require('fs');fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+'/i.txt','x')", '{out}'] }] };
    const o = makeBuildOrigin({ web: target });
    h.state.sha = o.sha;
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async home => {
      const r = await main(['--repo', o.clone, '--target', 'web', '--sha', o.sha, '--live-retry-ms', '1']);
      assert.equal(r.deployed, true);
      assert.ok(existsSync(r.buildDir), 'the build dir is reported and still exists');
      assert.ok(existsSync(join(r.buildDir, 'src', 'a.txt')), 'the worktree checkout is kept');
      assert.equal(worktreeEntries(o.clone).length, 1, 'the detached worktree stays registered');
      // H3 (B1, B2): the ZIP is written create-only and its absolute path is recorded in the one new history file
      const zip = join(artifactsOf(home, o.clone, 'web'), `${o.sha}.zip`);
      assert.ok(existsSync(zip), 'the artifact exists');
      assert.equal(readHistory(home, o.clone, 'web').at(-1).artifact, zip, 'the history entry records the artifact path');
      assert.deepEqual(historyFiles(home, o.clone, 'web'), ['000001.json']);
    });
  } finally { await h.close(); }
});

test('deploy.mjs: no path removes a worktree or a directory', () => {
  const text = readFileSync(join(here, 'deploy.mjs'), 'utf8');
  assert.ok(!/\brmSync\b/.test(text), 'no rmSync');
  assert.ok(!/'worktree',\s*'remove'/.test(text), 'no git worktree remove');
});

// ---------------------------------------------------------------- H3: append-only history, create-only artifacts, no git fetch (authored, not executed)
// One regression per criterion: A1-A6 history, B1-B3 artifacts, C1-C4 freshness. Disk cases run in fresh temp directories or a fresh HOME; none removes anything.
const rejectsCode = (fn, code, why = code) => assert.throws(fn, e => e instanceof Refusal && e.message.startsWith(`${code}:`), why);
const eexist = () => Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
const realIo = { existsSync, mkdirSync, readFileSync, readdirSync, openSync, writeSync, closeSync };
const histName = n => `${String(n).padStart(6, '0')}.json`;
const e1 = (i, over = {}) => ({ sha: String(i).padStart(40, 'c'), image: `x.azurecr.io/web:${i}`, at: '2026-01-01T00:00:00.000Z', rollback: false, verified: true, ...over });
// Lays out `entries` as the first `legacyCount` in history.json and the rest as one-element files history.d/000001.json ...
function layoutHistory(dir, entries, legacyCount = 0) {
  mkdirSync(dir, { recursive: true });
  if (legacyCount) writeFileSync(join(dir, 'history.json'), JSON.stringify(entries.slice(0, legacyCount)));
  const rest = entries.slice(legacyCount);
  if (rest.length) mkdirSync(join(dir, 'history.d'), { recursive: true });
  rest.forEach((e, i) => writeFileSync(join(dir, 'history.d', histName(i + 1)), JSON.stringify([e])));
}
const webTarget = (url, extra = {}) => ({ subscription: 's', resourceGroup: 'rg', app: 'app-web', outputDir: '{out}', agentAllowed: true, health: { url, shaField: 'sha', timeoutSeconds: 5 },
  build: [{ command: 'node', args: ['-e', "const fs=require('fs');fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+'/i.txt','x')", '{out}'] }], ...extra });

test('H3 A1/A2: every append is its own exclusive file in order; the legacy history.json is read, never opened for writing', () => {
  const dir = tmp('hist1');
  const legacy = join(dir, 'history.json'), legacyText = JSON.stringify([e1(1), e1(2)]);
  writeFileSync(legacy, legacyText);
  const p1 = appendHistoryEntry(dir, e1(3)), p2 = appendHistoryEntry(dir, e1(4));
  assert.deepEqual([p1, p2].map(p => p.split(/[\\/]/).pop()), ['000001.json', '000002.json']);
  assert.equal(readFileSync(legacy, 'utf8'), legacyText, 'the legacy bytes are unchanged');
  assert.deepEqual(readAllHistory(dir).map(e => e.sha), [1, 2, 3, 4].map(i => e1(i).sha), 'legacy array first, then numeric order');
  for (const p of [p1, p2]) { const v = JSON.parse(readFileSync(p, 'utf8')); assert.ok(Array.isArray(v) && v.length === 1, 'a one-element array'); }
  assert.deepEqual(readdirSync(dir).sort(), ['history.d', 'history.json'], 'no temp or other file');
  assert.deepEqual(readdirSync(join(dir, 'history.d')).sort(), ['000001.json', '000002.json']);
  // without a legacy file none is created, and a non-object entry is refused before history.d exists
  const fresh = tmp('hist1b');
  appendHistoryEntry(fresh, e1(1));
  assert.ok(!existsSync(join(fresh, 'history.json')), 'history.json is never created');
  for (const bad of [null, [e1(1)], 'x', 7, undefined]) rejectsCode(() => appendHistoryEntry(tmp('hist1c'), bad), 'HISTORY_ENTRY_UNREADABLE', String(bad));
});

test('H3 A3: bad names and bad entry files refuse and name the path; nothing is skipped, repaired or removed; gaps are allowed; overflow refuses', () => {
  for (const bad of ['1.json', '0000001.json', '00000a.json', '000001.json.tmp', '000001.JSON', '.DS_Store', '000001']) rejectsCode(() => historySequence([bad], '/h/history.d'), 'HISTORY_ENTRY_UNREADABLE', bad);
  assert.throws(() => historySequence(['x.json'], '/h/history.d'), e => e instanceof Refusal && e.message.includes(join('/h/history.d', 'x.json')));
  assert.deepEqual(historySequence(['000010.json', '000002.json']).map(s => s.seq), [2, 10], 'numeric order');
  assert.equal(nextHistorySeq(historySequence(['000001.json', '000005.json'])), 6, 'a gap is allowed: max + 1');
  assert.equal(nextHistorySeq([]), 1);
  rejectsCode(() => nextHistorySeq(historySequence(['999999.json'])), 'HISTORY_WRITE_CONFLICT', 'a next number above 999999');
  const p = join('/h/history.d', '000001.json'), ok = e1(1);
  assert.deepEqual(parseHistoryEntry(JSON.stringify([ok]), p), ok);
  for (const [why, text] of Object.entries({ empty: '', 'in progress': '[\n  {"sha": "ccc', 'not json': 'nope', 'an object, not an array': JSON.stringify(ok), 'an empty array': '[]', 'two elements': JSON.stringify([ok, ok]), 'a null element': '[null]', 'a string element': '["x"]', 'a nested array': '[[1]]' }))
    assert.throws(() => parseHistoryEntry(text, p), e => e instanceof Refusal && /^HISTORY_ENTRY_UNREADABLE/.test(e.message) && e.message.includes(p), why);
  // on disk: an in-progress entry makes the reader refuse; the file keeps its bytes and the listing is unchanged
  const dir = tmp('hist3'); appendHistoryEntry(dir, e1(1));
  const partial = join(dir, 'history.d', '000002.json'), partialText = '[\n  {"sha": "ccc';
  writeFileSync(partial, partialText);
  assert.throws(() => readAllHistory(dir), e => e instanceof Refusal && /^HISTORY_ENTRY_UNREADABLE/.test(e.message) && e.message.includes(partial));
  assert.equal(readFileSync(partial, 'utf8'), partialText, 'not repaired');
  assert.deepEqual(readdirSync(join(dir, 'history.d')).sort(), ['000001.json', '000002.json'], 'not removed');
  // a non-canonical name refuses the reader and the appender alike, before anything is written
  const odd = tmp('hist3b'); appendHistoryEntry(odd, e1(1)); writeFileSync(join(odd, 'history.d', 'notes.txt'), 'x');
  rejectsCode(() => readAllHistory(odd), 'HISTORY_ENTRY_UNREADABLE');
  rejectsCode(() => appendHistoryEntry(odd, e1(2)), 'HISTORY_ENTRY_UNREADABLE');
  assert.deepEqual(readdirSync(join(odd, 'history.d')).sort(), ['000001.json', 'notes.txt']);
});

test('H3 A4: EEXIST moves to the next number at most 20 times; other errors propagate; an existing or partial file is never touched', () => {
  const attempts = [];
  const failFirst = k => ({ ...realIo, openSync: (p, flag) => { attempts.push(p); if (attempts.length <= k) throw eexist(); return openSync(p, flag); } });
  const ok = tmp('hist4a');
  const written = appendHistoryEntry(ok, e1(1), failFirst(HISTORY_COLLISION_RETRIES));
  assert.equal(attempts.length, HISTORY_COLLISION_RETRIES + 1, 'the first try plus twenty retries');
  assert.ok(written.endsWith(histName(HISTORY_COLLISION_RETRIES + 1)), written);
  attempts.length = 0;
  const full = tmp('hist4b');
  rejectsCode(() => appendHistoryEntry(full, e1(1), failFirst(HISTORY_COLLISION_RETRIES + 1)), 'HISTORY_WRITE_CONFLICT');
  assert.equal(attempts.length, HISTORY_COLLISION_RETRIES + 1, 'no further retry');
  assert.deepEqual(readdirSync(join(full, 'history.d')), [], 'nothing was written');
  // an I/O error that is not EEXIST propagates unchanged and is not retried
  const denied = Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
  let n = 0;
  assert.throws(() => appendHistoryEntry(tmp('hist4c'), e1(1), { ...realIo, openSync: () => { n++; throw denied; } }), e => e === denied);
  assert.equal(n, 1);
  // A2: a history entry is written with exactly one write call; a short write refuses, keeps the file as written and is neither retried nor deleted
  const shortDir = tmp('hist4e'); let calls = 0, opens = 0;
  const shortIo = { ...realIo, openSync: (p, flag) => { opens++; return openSync(p, flag); }, writeSync: (fd, buf, off, len) => { calls++; return writeSync(fd, buf, off, Math.min(3, len)); } };
  assert.throws(() => appendHistoryEntry(shortDir, e1(1), shortIo), e => e instanceof Refusal && /^HISTORY_ENTRY_UNREADABLE/.test(e.message) && e.message.includes('000001.json'));
  assert.equal(calls, 1, 'exactly one write call'); assert.equal(opens, 1, 'no retry with another number');
  assert.deepEqual(readdirSync(join(shortDir, 'history.d')), ['000001.json'], 'the short file is retained, nothing else was created');
  assert.equal(readFileSync(join(shortDir, 'history.d', '000001.json'), 'utf8').length, 3, 'its bytes are what was written');
  // artifacts keep full-write handling, but a write that makes no progress is an error, not an endless loop
  const stuck = tmp('art4f');
  assert.throws(() => writeArtifactExclusive(Buffer.from('zip bytes'), stuck, 'e'.repeat(40), { ...realIo, writeSync: () => 0 }), e => !(e instanceof Refusal) && /no progress/.test(e.message));
  // a stale listing makes the writer aim at an existing, partial file: the real exclusive open refuses it and the next number is used
  const stale = tmp('hist4d'); mkdirSync(join(stale, 'history.d'));
  const existing = join(stale, 'history.d', '000001.json'); writeFileSync(existing, '[{"sha":"partial');
  const p = appendHistoryEntry(stale, e1(2), { ...realIo, readdirSync: () => [] });
  assert.ok(p.endsWith('000002.json'), p);
  assert.equal(readFileSync(existing, 'utf8'), '[{"sha":"partial', 'the existing file keeps its bytes');
});

test('H3 A5: recentHistory keeps the last ten in memory only; all files stay on disk; both selection consumers use the window', async () => {
  const list = Array.from({ length: 12 }, (_, i) => e1(i + 1)), snapshot = JSON.stringify(list);
  const r = recentHistory(list);
  assert.deepEqual(r, list.slice(2)); assert.equal(r.length, 10); assert.equal(r.at(-1), list.at(-1), 'the latest is still .at(-1)');
  assert.equal(JSON.stringify(list), snapshot, 'the input is not changed');
  assert.deepEqual(recentHistory(list.slice(0, 3)), list.slice(0, 3)); assert.deepEqual(recentHistory([]), []);
  rejectsCode(() => recentHistory({}), 'HISTORY_ENTRY_UNREADABLE');
  const dir = tmp('hist5'); for (const e of list) appendHistoryEntry(dir, e);
  assert.equal(readdirSync(join(dir, 'history.d')).length, 12, 'every entry stays on disk');
  assert.equal(readAllHistory(dir).length, 12);
  // rollback selection: the one earlier verified deploy is entry 0, so it is inside a ten-entry window and outside an eleven-entry one
  for (const total of [11, 10]) {
    const h = await startHealth();
    try {
      const o = makeOrigin('main', { '.trioharness/deploy.json': JSON.stringify({ schema: 1, targets: { prd: caTarget(h.url) } }), 'a.txt': 'a\n' });
      h.state.sha = OLD_SHA;
      await withFake(fakeAz(), { CLAUDECODE: '1' }, async home => {
        const entries = [{ sha: OLD_SHA, image: `x.azurecr.io/web:${OLD_SHA}`, revision: OLD_REV, at: '2026-01-01T00:00:00.000Z', rollback: false, verified: true },
          ...Array.from({ length: total - 1 }, (_, i) => e1(i + 1, { verified: false }))];
        layoutHistory(artifactsOf(home, o.clone, 'prd'), entries, 6); // six in the legacy file, the rest in history.d: both are read
        if (total === 11) await assert.rejects(rollbackRun(o.clone, '--dry-run'), e => e instanceof Refusal && /^NO_ROLLBACK_TARGET/.test(e.message), 'entry 0 is outside the window');
        else assert.equal((await rollbackRun(o.clone, '--dry-run')).plan.sha, OLD_SHA, 'entry 0 is inside the window');
      });
    } finally { await h.close(); }
  }
  // promotion source: the verified deploy of the SHA is entry 0 of the source history, found with ten entries and not with eleven
  for (const total of [11, 10]) {
    await promoteScenario({ entry: sha => verifiedEntry(sha), seed: ({ artifacts, sha }) => layoutHistory(artifacts, [verifiedEntry(sha), ...Array.from({ length: total - 1 }, (_, i) => e1(i + 1, { sha: String(i + 1).padStart(40, 'f') }))], 6) }, async ({ run }) => {
      if (total === 11) await assert.rejects(run('--dry-run'), e => e instanceof Refusal && /^PROMOTE_SOURCE_NOT_VERIFIED/.test(e.message), 'outside the window');
      else assert.equal((await run('--dry-run')).dryRun, true, 'inside the window');
    });
  }
});

test('H3 A6: a dry run and a freshness refusal create no history storage and no artifacts directory; the append is the first creation point', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': deployJson(h.url), 'a.txt': 'a\n' });
    h.state.sha = o.sha;
    await withFake(fakeAz(), {}, async home => {
      assert.equal((await run(o.clone, 'qa')).dryRun, true);
      assert.ok(!existsSync(join(home, '.trioharness-lean')), 'a dry run creates nothing under the artifacts root');
      assert.deepEqual(readAllHistory(artifactsOf(home, o.clone, 'qa')), [], 'reading creates nothing either');
      assert.ok(!existsSync(join(home, '.trioharness-lean')));
    });
  } finally { await h.close(); }
});

test('H3 A6: the entry is appended before VERIFY_FAILED, and a rollback appends only after its verification passed', async () => {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ web: webTarget(h.url, { health: { url: h.url, shaField: 'sha', timeoutSeconds: 1 } }) });
    h.state.sha = git(o.clone, 'rev-parse', `${o.sha}~1`); // an ancestor runs now; it keeps reporting itself, so the new SHA never verifies
    await withFake(fakeAz(), { CLAUDECODE: '1' }, async home => {
      await assert.rejects(main(['--repo', o.clone, '--target', 'web', '--sha', o.sha, '--live-retry-ms', '1']), e => e instanceof Refusal && /^VERIFY_FAILED/.test(e.message));
      const logged = readHistory(home, o.clone, 'web');
      assert.equal(logged.length, 1, 'the unverified deploy is recorded before the refusal');
      assert.equal(logged[0].verified, false);
      assert.deepEqual(historyFiles(home, o.clone, 'web'), ['000001.json']);
    });
    // a rollback whose verification fails (the app keeps reporting another SHA) writes no entry
    h.state.sha = 'f'.repeat(40);
    await withFake(fakeAz(), { CLAUDECODE: '1' }, async home => {
      const dir = artifactsOf(home, o.clone, 'web');
      layoutHistory(dir, [e1(1, { sha: OLD_SHA }), e1(2, { sha: NEW_SHA })], 2);
      writeFileSync(join(dir, `${OLD_SHA}.zip`), 'zip bytes');
      await assert.rejects(main(['--repo', o.clone, '--target', 'web', '--rollback', '--live-retry-ms', '1']), e => e instanceof Refusal && /^ROLLBACK_VERIFY_FAILED/.test(e.message));
      assert.deepEqual(historyFiles(home, o.clone, 'web'), [], 'no rollback entry after a failed verification');
    });
  } finally { await h.close(); }
});

test('H3 B1: the artifact is written create-only: an existing <sha>.zip keeps its bytes and <sha>.2.zip, .3.zip are used; 50 names, then ARTIFACT_WRITE_CONFLICT', () => {
  const dir = tmp('art'), sha = 'd'.repeat(40);
  assert.equal(artifactName(sha), `${sha}.zip`); assert.equal(artifactName(sha, 2), `${sha}.2.zip`); assert.equal(artifactName(sha, 50), `${sha}.50.zip`);
  writeFileSync(join(dir, `${sha}.zip`), 'OLD');
  const p2 = writeArtifactExclusive(Buffer.from('NEW-1'), dir, sha), p3 = writeArtifactExclusive(Buffer.from('NEW-2'), dir, sha);
  assert.equal(p2, join(dir, `${sha}.2.zip`)); assert.equal(p3, join(dir, `${sha}.3.zip`));
  assert.equal(readFileSync(join(dir, `${sha}.zip`), 'utf8'), 'OLD'); assert.equal(readFileSync(p2, 'utf8'), 'NEW-1'); assert.equal(readFileSync(p3, 'utf8'), 'NEW-2');
  let n = 0;
  rejectsCode(() => writeArtifactExclusive(Buffer.from('x'), dir, sha, { ...realIo, openSync: () => { n++; throw eexist(); } }), 'ARTIFACT_WRITE_CONFLICT');
  assert.equal(n, ARTIFACT_MAX_NAMES);
  const denied = Object.assign(new Error('ENOSPC: full'), { code: 'ENOSPC' });
  n = 0;
  assert.throws(() => writeArtifactExclusive(Buffer.from('x'), dir, sha, { ...realIo, openSync: () => { n++; throw denied; } }), e => e === denied);
  assert.equal(n, 1, 'only EEXIST moves to the next name');
});

test('H3 B1/B2: a webapp deploy with an existing <sha>.zip writes <sha>.2.zip and records that exact path', async () => {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ web: webTarget(h.url) });
    h.state.sha = o.sha;
    await withFake(fakeAz(), { CLAUDECODE: '1' }, async home => {
      const dir = artifactsOf(home, o.clone, 'web'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${o.sha}.zip`), 'OLD-BYTES');
      const r = await main(['--repo', o.clone, '--target', 'web', '--sha', o.sha, '--live-retry-ms', '1']);
      assert.equal(r.deployed, true);
      assert.equal(readFileSync(join(dir, `${o.sha}.zip`), 'utf8'), 'OLD-BYTES', 'the earlier ZIP is untouched');
      const second = join(dir, `${o.sha}.2.zip`);
      assert.equal(readFileSync(second).subarray(0, 2).toString(), 'PK', 'a real ZIP was written under the next name');
      assert.equal(readHistory(home, o.clone, 'web').at(-1).artifact, second, 'the history entry records the path actually written');
    });
  } finally { await h.close(); }
});

test('H3 B3: rollback uses the recorded artifact path, refuses when that exact path is missing, and uses <sha>.zip only for an entry without the field', async () => {
  assert.equal(rollbackArtifactPath({ sha: OLD_SHA, artifact: '/a/b.2.zip' }, '/art'), '/a/b.2.zip');
  assert.equal(rollbackArtifactPath({ sha: OLD_SHA }, '/art'), join('/art', `${OLD_SHA}.zip`));
  for (const bad of ['', null, 7, {}]) assert.equal(rollbackArtifactPath({ sha: OLD_SHA, artifact: bad }, '/art'), null, `a recorded but unusable field is never replaced by <sha>.zip: ${JSON.stringify(bad)}`);
  const scenario = async (layout, check) => {
    const h = await startHealth();
    try {
      const o = makeBuildOrigin({ web: webTarget(h.url) });
      h.state.sha = OLD_SHA;
      const az = fakeAz();
      await withFake(az, { CLAUDECODE: '1' }, async home => {
        const dir = artifactsOf(home, o.clone, 'web'); mkdirSync(dir, { recursive: true });
        layoutHistory(dir, layout(dir), 2);
        await check({ az, home, dir, o, rollbackWeb: (...more) => main(['--repo', o.clone, '--target', 'web', '--rollback', '--live-retry-ms', '1', ...more]) });
      });
    } finally { await h.close(); }
  };
  const entries = (prevOver = {}) => [e1(1, { sha: OLD_SHA, ...prevOver }), e1(2, { sha: NEW_SHA })];
  await scenario(dir => { writeFileSync(join(dir, `${OLD_SHA}.zip`), 'DECOY'); writeFileSync(join(dir, `${OLD_SHA}.2.zip`), 'RECORDED'); return entries({ artifact: join(dir, `${OLD_SHA}.2.zip`) }); },
    async ({ az, dir, home, o, rollbackWeb }) => {
      assert.equal((await rollbackWeb()).rolledBack, true);
      const deploy = az.calls().find(c => /webapp deploy/.test(c));
      assert.ok(deploy.includes(`--src-path ${join(dir, `${OLD_SHA}.2.zip`)} `) && !deploy.includes(`--src-path ${join(dir, `${OLD_SHA}.zip`)} `), deploy);
      const last = readHistory(home, o.clone, 'web').at(-1);
      assert.equal(last.rollback, true); assert.ok(!Object.hasOwn(last, 'artifact'), 'a rollback entry records no artifact');
      assert.equal(readFileSync(join(dir, `${OLD_SHA}.zip`), 'utf8'), 'DECOY');
    });
  await scenario(dir => { writeFileSync(join(dir, `${OLD_SHA}.zip`), 'EXISTS-BUT-NOT-RECORDED'); return entries({ artifact: join(dir, `${OLD_SHA}.2.zip`) }); },
    async ({ az, dir, home, o, rollbackWeb }) => {
      await assert.rejects(rollbackWeb(), e => e instanceof Refusal && /^ROLLBACK_ARTIFACT_MISSING/.test(e.message) && e.message.includes(`${OLD_SHA}.2.zip`), 'no silent fallback to <sha>.zip');
      assert.deepEqual(az.mutations(), []);
      assert.deepEqual(historyFiles(home, o.clone, 'web'), []);
    });
  await scenario(dir => { writeFileSync(join(dir, `${OLD_SHA}.zip`), 'LEGACY'); return entries(); },
    async ({ az, dir, rollbackWeb }) => {
      assert.equal((await rollbackWeb()).rolledBack, true);
      assert.ok(az.calls().find(c => /webapp deploy/.test(c)).includes(`--src-path ${join(dir, `${OLD_SHA}.zip`)} `), 'a legacy entry uses <sha>.zip');
    });
});

// ---- C: freshness without git fetch
const TIP1 = '1'.repeat(40), TIP2 = '2'.repeat(40);
test('H3 C1/C2: advertisement and tracking refs parse strictly; exact refs are compared; STALE and UNREADABLE are distinct', () => {
  const adv = parseRemoteHeads(`${TIP1}\trefs/heads/main\n${TIP2}\trefs/heads/feature/x\n`, 'origin');
  assert.equal(adv.get('refs/heads/feature/x'), TIP2); assert.equal(adv.size, 2);
  for (const [why, text] of Object.entries({ empty: '', whitespace: ' \n\n', garbage: 'fatal: nope', 'short sha': 'abc123\trefs/heads/main', 'not a head': `${TIP1}\trefs/tags/v1`, duplicate: `${TIP1}\trefs/heads/main\n${TIP2}\trefs/heads/main` }))
    rejectsCode(() => parseRemoteHeads(text, 'origin'), 'REMOTE_REF_UNREADABLE', why);
  const trk = parseTrackingRefs(`${TIP1} refs/remotes/origin/main\n${TIP1} refs/remotes/origin/HEAD\n`, 'origin');
  assert.deepEqual([...trk.keys()], ['refs/remotes/origin/main'], 'the symbolic HEAD alias is excluded');
  assert.equal(parseTrackingRefs('', 'origin').size, 0);
  rejectsCode(() => parseTrackingRefs('garbage line', 'origin'), 'REMOTE_REF_UNREADABLE');
  const same = { remote: 'origin', branch: 'main', advertised: adv, tracking: trk };
  assert.equal(checkRemoteRef(same), TIP1);
  assert.throws(() => checkRemoteRef({ ...same, tracking: new Map([['refs/remotes/origin/main', TIP2]]) }), e => e instanceof Refusal && /^REMOTE_REF_STALE/.test(e.message) && e.message.includes(TIP1) && e.message.includes(TIP2) && /git fetch origin/.test(e.message), 'unequal tips name both and tell the person to fetch');
  assert.throws(() => checkRemoteRef({ ...same, tracking: new Map() }), e => /^REMOTE_REF_STALE/.test(e.message) && /missing locally/.test(e.message), 'a missing local tracking ref is stale');
  rejectsCode(() => checkRemoteRef({ ...same, branch: 'release' }), 'REMOTE_REF_UNREADABLE', 'a head the remote does not advertise');
  assert.throws(() => checkRemoteRef({ ...same, remote: 'origin', branch: 'feature/x' }), e => /^REMOTE_REF_STALE/.test(e.message), 'refs compare exactly, branch names with a slash included');
});

test('H3 C3: shaOnFreshRemote counts a branch only when its local tracking tip equals the advertised tip', () => {
  const advertised = parseRemoteHeads(`${TIP1}\trefs/heads/main\n${TIP2}\trefs/heads/dev\n`, 'origin');
  const tracking = parseTrackingRefs(`${TIP1} refs/remotes/origin/main\n${TIP1} refs/remotes/origin/dev\n${TIP1} refs/remotes/origin/HEAD\n`, 'origin');
  const call = containing => shaOnFreshRemote({ containing, remote: 'origin', advertised, tracking });
  assert.equal(call('  origin/HEAD -> origin/main\n  origin/dev\n'), false, 'dev is stale and the HEAD alias never counts');
  assert.equal(call('  origin/dev\n  origin/main\n'), true, 'main is fresh');
  assert.equal(call('  upstream/main\n'), false, 'another remote does not count');
  assert.equal(call(''), false);
  assert.equal(call('  origin/gone\n'), false, 'a branch the remote no longer advertises does not count');
});

test('H3 C1: a stale config-source ref refuses REMOTE_REF_STALE before deploy.json is trusted; nothing is fetched, written or changed', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { 'a.txt': 'a\n' }); // the default branch has no deploy.json yet
    const tip = commit(o.seed, '.trioharness/deploy.json', deployJson(h.url), 'add deploy.json'); git(o.seed, 'push', '-q', 'origin', 'main');
    const refs = () => git(o.clone, 'for-each-ref', 'refs/remotes'), before = refs();
    await withFake(fakeAz(), {}, async home => {
      await assert.rejects(run(o.clone, 'qa'), e => e instanceof Refusal && /^REMOTE_REF_STALE/.test(e.message) && e.message.includes(o.sha) && e.message.includes(tip) && !/NO_DEPLOY_CONFIG/.test(e.message), 'freshness is checked before the config is read');
      assert.equal(refs(), before, 'the tracking refs did not move');
      assert.ok(!existsSync(join(o.clone, '.git', 'FETCH_HEAD')), 'no FETCH_HEAD: the script never fetches');
      assert.ok(!existsSync(join(home, '.trioharness-lean')), 'no history or artifact storage was created');
      git(o.clone, 'fetch', '-q', 'origin'); h.state.sha = o.sha; // the person fetches; the checkout (and the running commit) is still o.sha
      assert.equal((await run(o.clone, 'qa')).dryRun, true);
    });
  } finally { await h.close(); }
});

test('H3 C1: cfg.defaultBranch on an unchanged remote is validated after the config loads: a missing or stale local release ref refuses even though origin/main is fresh', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': deployJson(h.url, { defaultBranch: 'release' }), 'a.txt': 'a\n' });
    h.state.sha = o.sha;
    git(o.seed, 'checkout', '-q', '-b', 'release'); const r1 = commit(o.seed, 'r.txt', 'r\n', 'release one'); git(o.seed, 'push', '-q', 'origin', 'release');
    await withFake(fakeAz(), {}, async home => {
      assert.equal(git(o.clone, 'rev-parse', 'origin/main'), o.sha, 'the config-source ref is fresh');
      await assert.rejects(run(o.clone, 'qa'), e => e instanceof Refusal && /^REMOTE_REF_STALE: origin\/release/.test(e.message) && /missing locally/.test(e.message), 'the clone has no origin/release');
      git(o.clone, 'fetch', '-q', 'origin');
      assert.equal((await run(o.clone, 'qa')).dryRun, true, 'fresh after a person-run fetch');
      const r2 = commit(o.seed, 'r2.txt', 'r2\n', 'release two'); git(o.seed, 'push', '-q', 'origin', 'release');
      await assert.rejects(run(o.clone, 'qa'), e => e instanceof Refusal && /^REMOTE_REF_STALE: origin\/release/.test(e.message) && e.message.includes(r1) && e.message.includes(r2), 'a stale origin/release names both tips');
      assert.ok(!existsSync(join(home, '.trioharness-lean')));
    });
  } finally { await h.close(); }
});

test('H3 C1: deploy.json is read from the exact validated refs/remotes ref; a tag with the same short name cannot shadow it', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': deployJson(h.url), 'a.txt': 'a\n' });
    h.state.sha = o.sha;
    // a local tag named origin/main points at a commit whose deploy.json declares an extra target; Git's short-name lookup prefers tags over remote-tracking refs
    const evil = JSON.parse(deployJson(h.url)); evil.targets.evil = evil.targets.qa;
    git(o.clone, 'checkout', '-q', '-b', 'shadow'); commit(o.clone, '.trioharness/deploy.json', JSON.stringify(evil), 'a different deploy.json');
    git(o.clone, 'tag', 'origin/main'); git(o.clone, 'checkout', '-q', 'main');
    assert.notEqual(git(o.clone, 'rev-parse', 'origin/main'), git(o.clone, 'rev-parse', 'refs/remotes/origin/main'), 'the short name is shadowed by the tag');
    await withFake(fakeAz(), {}, async () => {
      await assert.rejects(run(o.clone, 'evil'), e => e instanceof Refusal && /^UNKNOWN_TARGET/.test(e.message), 'the target that exists only on the tag is unknown');
      assert.equal((await run(o.clone, 'qa')).dryRun, true, 'the validated ref still governs');
    });
  } finally { await h.close(); }
});

test('H3 C2: an unreachable remote or one that advertises no branch refuses REMOTE_REF_UNREADABLE', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': deployJson(h.url), 'a.txt': 'a\n' });
    h.state.sha = o.sha;
    await withFake(fakeAz(), {}, async () => {
      git(o.clone, 'remote', 'set-url', 'origin', join(tmp('gone'), 'missing.git'));
      await assert.rejects(run(o.clone, 'qa'), e => e instanceof Refusal && /^REMOTE_REF_UNREADABLE/.test(e.message), 'ls-remote fails');
      const empty = tmp('empty'); git(empty, 'init', '-q', '--bare');
      git(o.clone, 'remote', 'set-url', 'origin', empty);
      await assert.rejects(run(o.clone, 'qa'), e => e instanceof Refusal && /^REMOTE_REF_UNREADABLE/.test(e.message), 'an empty advertisement');
    });
  } finally { await h.close(); }
});

test('H3 C4: the freshness gate is added, not substituted: it comes first, and the running-commit and ancestry gates still run on fresh refs', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': deployJson(h.url), 'a.txt': 'a\n' });
    commit(o.seed, 'b.txt', 'b\n', 'remote moves on'); git(o.seed, 'push', '-q', 'origin', 'main');
    h.state.mode = 'down'; // the running commit is unreadable as well
    await withFake(fakeAz(), {}, async () => {
      await assert.rejects(run(o.clone, 'qa'), e => e instanceof Refusal && /^REMOTE_REF_STALE/.test(e.message), 'stale refs are reported first');
      git(o.clone, 'fetch', '-q', 'origin');
      await assert.rejects(run(o.clone, 'qa'), e => e instanceof Refusal && /^RUNNING_REF_UNREADABLE/.test(e.message), 'then the unchanged running-commit gate');
      git(o.clone, 'checkout', '-q', '-b', 'feature/x'); const f = commit(o.clone, 'f.txt', 'f\n', 'feature only'); git(o.clone, 'push', '-q', 'origin', 'feature/x');
      git(o.clone, 'checkout', '-q', 'main');
      h.state.mode = 'sha'; h.state.sha = f;
      await assert.rejects(run(o.clone, 'qa'), e => e instanceof Refusal && /^WOULD_OVERWRITE_UNMERGED/.test(e.message), 'and the unchanged ancestry gate');
      h.state.sha = o.sha; // the running commit is the checkout
      assert.equal((await run(o.clone, 'qa')).dryRun, true);
    });
  } finally { await h.close(); }
});

test('deploy.mjs source (H3): no fetch call, no history.json write, no copyFileSync, only exclusive writers, one ten-entry window used by exactly two readers', () => {
  const text = readFileSync(join(here, 'deploy.mjs'), 'utf8');
  assert.ok(!/git\('fetch'|'fetch',/.test(text), 'no git fetch');
  assert.ok(/loadConfigFromRef\(git, fullRef\)/.test(text) && /fullRef = `refs\/remotes\//.test(text), 'the config is loaded from the full validated ref');
  assert.ok(!/writeFileSync|copyFileSync|truncateSync|appendFileSync/.test(text), 'no replacing or truncating writer');
  assert.ok(!/\b(rmSync|unlinkSync|rmdirSync|renameSync)\b|'prune'|--prune|worktree.*remove/.test(text), 'nothing removes, renames or prunes');
  const opens = [...text.matchAll(/openSync\(([^)]*)\)/g)];
  assert.ok(opens.length >= 1 && opens.every(m => /'wx'/.test(m[1])), `every openSync call is exclusive: ${opens.map(m => m[0]).join(' | ')}`);
  assert.equal((text.match(/'history\.json'/g) || []).length, 1, 'the legacy file name appears once, in the reader');
  assert.equal((text.match(/slice\(-10\)|slice\(-HISTORY_WINDOW\)/g) || []).length, 1, 'one window, inside recentHistory');
  assert.equal((text.match(/recentHistory\(/g) || []).length, 3, 'the definition and exactly two consumers (rollback selection, promotion source)');
});

test('run-state CLI: `set --run --gate x` refuses and creates no run folder named after the flag', () => {
  const repo = tmp('rs');
  const r = spawnSync(process.execPath, [join(here, 'run-state.mjs'), 'set', '--repo', repo, '--run', '--gate', 'x', '--status', 'passed'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /RUN_ID_INVALID/);
  assert.ok(!existsSync(join(repo, '.trioharness-direct', 'runs', '--gate')), 'no runs/--gate');
  assert.ok(!existsSync(join(repo, '.trioharness-direct', 'runs')) || readdirSync(join(repo, '.trioharness-direct', 'runs')).length === 0, 'no run folder at all');
});

test('run-state CLI: `finish --run --gate x` never falls back to the latest run; omitting --run still does', () => {
  const rs = (...a) => spawnSync(process.execPath, [join(here, 'run-state.mjs'), ...a], { encoding: 'utf8' });
  const fixture = () => { const repo = tmp('rsf'); const r = rs('set', '--repo', repo, '--run', 'r1', '--gate', 'done-jev', '--status', 'passed'); assert.equal(r.status, 0, r.stderr); return repo; };
  const stateFile = repo => join(repo, '.trioharness-direct', 'runs', 'r1', 'state.json');
  // the fixture run is eligible: with --run omitted the latest run is finished (legitimate behaviour kept)
  const ok = fixture();
  const fin = rs('finish', '--repo', ok);
  assert.equal(fin.status, 0, fin.stdout + fin.stderr);
  assert.equal(JSON.parse(readFileSync(stateFile(ok), 'utf8')).finished, true);
  // the same run, but --run is followed by a flag, or has no value at all: refused, state untouched
  for (const bad of [['--run', '--gate', 'x'], ['--run']]) {
    const repo = fixture(), before = readFileSync(stateFile(repo));
    const r = rs('finish', '--repo', repo, ...bad);
    assert.notEqual(r.status, 0, `${bad.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, /RUN_ID_INVALID/);
    assert.deepEqual(readFileSync(stateFile(repo)), before, `${bad.join(' ')}: state.json is byte-identical`);
  }
  // every command refuses a --run without a value, not only the ones that fall back
  const repo = fixture();
  for (const cmd of ['show', 'audit', 'dispatch']) assert.match(rs(cmd, '--repo', repo, '--run', '--role', 'writer').stderr, /RUN_ID_INVALID/, cmd);
});

import * as S6_DEPLOY from './deploy.mjs';
const S6_DEPLOY_GOLDEN = {"refusal": {"stdout": "", "stderr": "DEPLOY: UNKNOWN_TARGET: unknown is not declared in .trioharness/deploy.json on worktree\n", "code": 2}, "broken": {"stdout": "", "stderr": "DEPLOY: Expected property name or '}' in JSON at position 1 (line 1 column 2)\n", "code": 3}};
test('hf5b1e-s6-p-runcli-01 spawned deploy refusals and errors retain base golden bytes',()=>{
  const repo=tmp('s6-cli');write(repo,'.trioharness/deploy.json',JSON.stringify({schema:1,targets:{}}));
  const argv=[join(here,'deploy.mjs'),'--repo',repo,'--target','unknown','--config-from-worktree'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !DEFAULT_AGENT_MARKERS.includes(key)));
  const check = golden => {const r=spawnSync(process.execPath,argv,{encoding:'utf8',env});assert.deepEqual({stdout:r.stdout,stderr:r.stderr,code:r.status},golden);};
  check(S6_DEPLOY_GOLDEN.refusal);write(repo,'.trioharness/deploy.json','{');check(S6_DEPLOY_GOLDEN.broken);
});

const S6_WRAPPER_GOLDEN = {
 success:{stdout:'{"deployed":true,"plan":{"target":"qa","sha":"'+ 'a'.repeat(40)+'"},"revision":"rev-1"}\n',stderr:'',code:0},
 refusal:{stdout:'',stderr:'DEPLOY: fixture refusal\n',code:2},error:{stdout:'',stderr:'DEPLOY: fixture error\n',code:3}
};
const s6Deployed=()=>({deployed:true,plan:{target:'qa',sha:'a'.repeat(40)},revision:'rev-1'});
function s6DeployFixture(){const root=tmp('s6-runcli');const rd=join(root,'.trioharness-direct','runs','s6-cli');mkdirSync(rd,{recursive:true});writeFileSync(join(rd,'state.json'),'{}');return {root,rd,argv:['--repo',root,'--ledger',root,'--run','s6-cli','--target','qa']};}
async function s6DeployCli(t,result,deps={}){let stdout='',stderr='';const code=await S6_DEPLOY.runCli(t.argv,{run:async()=>result,stdout:s=>{stdout+=s},stderr:s=>{stderr+=s},...deps});return {stdout,stderr,code};}
function s6DeployLines(t,event,category){const file=join(t.rd,'issues-failures.jsonl');assert.ok(existsSync(file),'failure record exists');const lines=readFileSync(file,'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(lines.length,1);const line=lines[0];assert.ok(Object.keys(line).every(k=>['v','kind','ts','run','event','category','key'].includes(k)));assert.equal(line.v,1);assert.equal(line.kind,'failure');assert.equal(line.run,'s6-cli');assert.equal(line.event,event);assert.equal(line.category,category);assert.equal(new Date(line.ts).toISOString(),line.ts);return lines;}
test('hf5b1e-s6-d-runcli-01 injectable wrapper preserves base success refusal error bytes',async()=>{
  for(const loadIssues of [undefined,async()=>({transitionForEvent:async()=>{throw new Error('hook')}}),async()=>{throw new Error('import')},async()=>({transitionForEvent:async()=>({ok:false,pending:true})})]) {
    const t=s6DeployFixture();assert.deepEqual(await s6DeployCli(t,s6Deployed(),{loadIssues}),S6_WRAPPER_GOLDEN.success);
    for(const [name,e] of [['refusal',new Refusal('fixture refusal')],['error',new Error('fixture error')]])assert.deepEqual(await s6DeployCli(t,null,{loadIssues,run:async()=>{throw e}}),S6_WRAPPER_GOLDEN[name]);
  }
});
test('hf5b1e-s6-d-runcli-02 deployed qa prod only with valid run and existing ledger',async()=>{
  for(const target of ['qa','prod']) {const t=s6DeployFixture();t.argv[t.argv.length-1]=target;let call;await s6DeployCli(t,s6Deployed(),{loadIssues:async()=>({transitionForEvent:async(event,opts)=>{call={event,opts}}})});assert.ok(call);assert.equal(call.event,'deployed-'+target);assert.deepEqual(call.opts,{repo:t.root,ledger:t.root,run:'s6-cli',target,sha:'a'.repeat(40),revision:'rev-1',toSha:undefined,toRevision:undefined});}
  for(const variant of ['staging','missing-run','missing-ledger','invalid-run','dry-run']) {const t=s6DeployFixture();if(variant==='staging')t.argv[t.argv.length-1]='staging';if(variant==='missing-run')t.argv.splice(4,2);if(variant==='missing-ledger')t.argv[5]='absent';if(variant==='invalid-run')t.argv[5]='../outside';let called=false;await s6DeployCli(t,variant==='dry-run'?{dryRun:true}:s6Deployed(),{loadIssues:async()=>{called=true;return {}}});assert.equal(called,false,variant);}
});
test('hf5b1e-s6-d-runcli-03 rollback forwards verified restored sha and revision',async()=>{
  const t=s6DeployFixture();let call;const result={rolledBack:true,plan:{sha:'b'.repeat(40),revision:'rev-old'}};const out=await s6DeployCli(t,result,{loadIssues:async()=>({transitionForEvent:async(event,opts)=>{call={event,opts}}})});assert.ok(call);assert.equal(call.event,'rollback');assert.equal(call.opts.toSha,result.plan.sha);assert.equal(call.opts.toRevision,'rev-old');assert.equal(call.opts.target,'qa');assert.equal(out.stdout,JSON.stringify(result)+'\n');assert.equal(out.code,0);
});
test('hf5b1e-s6-d-runcli-04 missing rejecting imports durably record each allowed event',async()=>{
  for(const event of ['deployed-qa','deployed-prod','rollback'])for(const broken of [false,true]){const t=s6DeployFixture();if(event==='deployed-prod')t.argv[t.argv.length-1]='prod';const file=join(t.root,'absent.mjs');if(broken)writeFileSync(file,'export const = ;');const result=event==='rollback'?{rolledBack:true,plan:{sha:null,revision:'rev-old'}}:s6Deployed();const out=await s6DeployCli(t,result,{loadIssues:()=>import(new URL('file://'+file).href)});assert.equal(out.code,0);assert.equal(out.stdout,JSON.stringify(result)+'\n');s6DeployLines(t,event,'IMPORT_FAILED');}
});
test('hf5b1e-s6-d-runcli-05 credential-shaped hook errors never enter output or record',async()=>{
  for(const value of ['pass'+'word=ab1','https://'+'user:pw@host/x']){const t=s6DeployFixture();const error=new Error(value);error.code=value;error.name=value;const out=await s6DeployCli(t,s6Deployed(),{loadIssues:async()=>({transitionForEvent:async()=>{throw error}})});assert.deepEqual(out,S6_WRAPPER_GOLDEN.success);const lines=s6DeployLines(t,'deployed-qa','OTHER');assert.doesNotMatch(JSON.stringify(lines)+out.stdout+out.stderr,/password|user:pw|Error/);}
});

// S2-C1/C2/C6; all external commands below use local git and fakeAz.
test('hf5b1e-s2-d-health: short live SHA refuses HEALTH_SHA_NOT_FULL before any mutation', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': deployJson(h.url), 'a.txt': 'fixture' });
    h.state.sha = o.sha.slice(0, 7);
    const az = fakeAz();
    await withFake(az, {}, async () => {
      await assert.rejects(run(o.clone, 'qa'), /HEALTH_SHA_NOT_FULL/);
      assert.deepEqual(az.mutations(), []);
    });
  } finally { await h.close(); }
});
test('hf5b1e-s2-d-intent: intent precedes traffic switch and crash rollback uses it', async () => {
  // Exercise the actual pre-switch block against an in-memory history writer;
  // the switch crashes, leaving precisely the durable entry rollback must use.
  const text = readFileSync(join(here, 'deploy.mjs'), 'utf8');
  const start = text.indexOf('      const canaryHealth =');
  const end = text.indexOf("    } else sh('az', azDeployArgs(target, zipPath));", start);
  const block = text.slice(start, end);
  const files = new Map();
  const io = {
    mkdirSync: () => {}, readdirSync: () => [...files.keys()].map(p => p.split('/').pop()),
    openSync: (p, flag) => { assert.equal(flag, 'wx'); assert.ok(!files.has(p)); files.set(p, ''); return p; },
    writeSync: (p, buf) => { files.set(p, buf.toString()); return buf.length; }, closeSync: () => {},
  };
  const crash = new Error('fixture switch crash');
  const entry = { sha: NEW_SHA, imageRef: pinned(RUN_DIGEST), digest: RUN_DIGEST, runId: 'fixture', imageTag: 'fixture',
    previousImage: 'old-image', revision: 'new-revision', previousRevision: OLD_REV, promoteFrom: null, authorization: null };
  const mod = await import('./deploy.mjs');
  const args = { ...entry, stage: false, target: caTarget('https://fixture.invalid/health'), fqdn: 'fixture.invalid', artifacts: '/memory',
    waitForSha: async () => ({ verified: true }), revisionHealthUrl: mod.revisionHealthUrl, Refusal,
    deployHistoryEntry: mod.deployHistoryEntry, appendHistoryEntry: (dir, e) => appendHistoryEntry(dir, e, io),
    containerappTrafficSetArgs: mod.containerappTrafficSetArgs, sh: () => { throw crash; } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(...Object.keys(args), 'let canary;\n' + block);
  await assert.rejects(execute(...Object.values(args)), e => e === crash);
  assert.equal(files.size, 1, 'intent is durable before the switch can crash');
  const intent = [...files.values()].map(t => JSON.parse(t)[0])[0];
  assert.equal(intent.intent, true); assert.equal(intent.verified, false);
  for (const k of ['sha', 'digest', 'runId', 'revision', 'previousRevision', 'previousImage']) assert.equal(intent[k], entry[k]);
  assert.equal(intent.image, entry.imageRef); assert.ok(!Number.isNaN(Date.parse(intent.at)));
  const h = fixtureTrafficHealth();
  const o = makeOrigin('main', { '.trioharness/deploy.json': JSON.stringify({ schema: 1, targets: { prd: caTarget(h.url) } }) });
  await withFake(fakeAz(), { CLAUDECODE: '1' }, async home => {
    layoutHistory(artifactsOf(home, o.clone, 'prd'), [verifiedEntry(OLD_SHA), intent], 0);
    const { plan } = await rollbackRun(o.clone, '--dry-run');
    assert.equal(plan.revision, OLD_REV); assert.equal(plan.sha, OLD_SHA);
    assert.equal(plan.authorizationPhrase, `app-prd:rollback:${OLD_REV}`);
  });
});
test('hf5b1e-s2-d-intent: recentHistory drops superseded intents before the window', () => {
  const entries = Array.from({ length: 9 }, (_, i) => e1(i));
  const intent = e1(10, { revision: 'new', intent: true, verified: false });
  const done = e1(10, { revision: 'new', verified: true });
  const original = [...entries, intent, done];
  assert.deepEqual(recentHistory(original), [...entries, done]);
  assert.equal(original.length, 11, 'input is not changed');
  assert.deepEqual(recentHistory([...entries, intent]), [...entries, intent], 'unsuperseded intent survives a crash');
  assert.deepEqual(recentHistory([intent, e1(11, { revision: 'other' })]), [intent, e1(11, { revision: 'other' })]);
});
test('hf5b1e-s2-d-history-invalid: null legacy entries refuse even outside the ten-entry window', () => {
  const artifacts = tmp('s2-invalid-history');
  const path = join(artifacts, 'history.json');
  const valid = Array.from({ length: 11 }, (_, i) => e1(i));
  for (const invalid of [null, false, 1, 'entry', []]) {
    const bytes = JSON.stringify([invalid, ...valid]);
    writeFileSync(path, bytes);
    assert.throws(() => recentHistory(readAllHistory(artifacts)), e => e instanceof Refusal && /^HISTORY_ENTRY_UNREADABLE:/.test(e.message));
    assert.equal(readFileSync(path, 'utf8'), bytes, 'unreadable legacy evidence stays unchanged');
  }
});
test('hf5b1e-s2-d-plan: plan.build starts with az acr build', async () => {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': JSON.stringify({ schema: 1, targets: { qa: caTarget(h.url, { agentAllowed: true }) } }) });
    h.state.sha = o.sha;
    await withFake(fakeAz(), {}, async () => assert.match((await run(o.clone, 'qa')).plan.build, /^az acr build /));
  } finally { await h.close(); }
});
test('hf5b1e-s2-p-rollback: last/prev and authorization unchanged without intent', async () => {
  const h = await startHealth();
  try {
    const target = caTarget(h.url);
    const o = makeOrigin('main', { '.trioharness/deploy.json': JSON.stringify({ schema: 1, targets: { prd: target } }) });
    const mod = await import('./deploy.mjs');
    await withFake(fakeAz(), { CLAUDECODE: '1' }, async home => {
      seedHistory(home, o.clone, 'prd', { withRevision: true });
      const { plan } = await rollbackRun(o.clone, '--dry-run');
      assert.equal(plan.sha, OLD_SHA); assert.equal(plan.revision, OLD_REV);
      const checks = { target, targetName: 'prd', revision: OLD_REV, sha: OLD_SHA, env: { CLAUDECODE: '1' }, isTTY: false };
      assert.throws(() => mod.checkRollbackAuthorization(checks), /AUTHORIZATION_REQUIRED/);
      assert.throws(() => mod.checkRollbackAuthorization({ ...checks, authorization: `app-prd:${OLD_SHA.slice(0, 12)}` }), /AUTHORIZATION_REQUIRED/);
      assert.doesNotThrow(() => mod.checkRollbackAuthorization({ ...checks, authorization: plan.authorizationPhrase }));
    });
  } finally { await h.close(); }
});

// S4: remote-advertised provenance; all Git effects stay in the confined test root.
const s4opts = o => ({ repo: o.clone, base: o.sha, owned: ['src.txt', 'src/'], remote: `origin/${o.branch}`, allowMainWorktree: true });
for (const branch of ['main', 'develop']) test(`hf5b1e-s4-d-prov: spoofed ${branch} is refused when default is release`, () => {
  const o = makeOrigin('release', { 'src.txt': 'base\n' });
  git(o.clone, 'update-ref', `refs/remotes/origin/${branch}`, o.sha);
  assert.throws(() => guard({ ...s4opts(o), base: 'live', remote: `origin/${branch}` }), /REMOTE_NOT_DEFAULT/);
});
test('hf5b1e-s4-d-prov: forged local origin/HEAD cannot select a task branch', () => {
  const o = makeOrigin('release', { 'src.txt': 'base\n' });
  git(o.clone, 'update-ref', 'refs/remotes/origin/trio/forged', o.sha);
  git(o.clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trio/forged');
  assert.throws(() => guard({ ...s4opts(o), base: 'live', remote: 'origin/trio/forged' }), /REMOTE_NOT_DEFAULT/);
});
test('hf5b1e-s4-d-prov: forged tracking tip is refused', () => {
  const o = makeOrigin('main', { 'src.txt': 'base\n' });
  const attacker = commit(o.clone, 'src.txt', 'candidate\n', 'candidate');
  git(o.clone, 'update-ref', 'refs/remotes/origin/main', attacker);
  assert.throws(() => guard(s4opts(o)), /REMOTE_REF_STALE/);
});
test('hf5b1e-s4-d-prov: a local origin/main branch cannot impersonate a missing tracking ref', () => {
  const o = makeOrigin('main', { 'src.txt': 'base\n' });
  git(o.clone, 'branch', 'origin/main', o.sha); git(o.clone, 'update-ref', '-d', 'refs/remotes/origin/main');
  assert.throws(() => guard(s4opts(o)), /REMOTE_REF_STALE/);
});
test('hf5b1e-s4-d-prov: unreachable and symref-less remotes fail closed', () => {
  for (const kind of ['unreachable', 'detached']) {
    const o = makeOrigin('main', { 'src.txt': 'base\n' });
    if (kind === 'unreachable') git(o.clone, 'remote', 'set-url', 'origin', join(tmp('absent'), 'missing'));
    else git(o.bare, 'update-ref', '--no-deref', 'HEAD', o.sha);
    assert.throws(() => guard(s4opts(o)), /DEFAULT_UNVERIFIED/, kind);
  }
});
test('hf5b1e-s4-d-prov: live with drift refuses a stale clone until fetch', () => {
  const o = makeOrigin('main', { 'src.txt': 'base\n' });
  const next = commit(o.seed, 'src.txt', 'next\n', 'advance'); git(o.seed, 'push', '-q', 'origin', 'main');
  assert.throws(() => guard({ ...s4opts(o), base: 'live' }), /REMOTE_REF_STALE/);
  git(o.clone, 'fetch', '-q', 'origin'); git(o.clone, 'merge', '-q', '--ff-only', 'origin/main');
  const r = guard({ ...s4opts(o), base: 'live', maxBehind: 0 });
  assert.equal(r.base, next); assert.equal(r.clean, true);
});
test('hf5b1e-s4-d-prov: no remote is explicitly unverified in result and CLI', () => {
  const o = makeOrigin('main', { 'src.txt': 'base\n' });
  const r = guard({ ...s4opts(o), remote: undefined });
  assert.equal(r.baseVerified, false);
  const cli = spawnSync(process.execPath, [join(here, 'guard.mjs'), '--repo', o.clone, '--base', o.sha, '--owned', 'src.txt', '--allow-main-worktree'], { encoding: 'utf8' });
  assert.equal(cli.status, 0); assert.match(cli.stderr, /GUARD: UNVERIFIED BASE \(local result only, not promotion proof\)/);
});
test('hf5b1e-s4-d-prov: post-resolution ref movement cannot change ancestry or allowances', () => {
  const line = 'Pwd=' + 'reviewed-fixture-value;';
  const o = makeOrigin('main', { 'src.txt': 'base\n', [ALLOW_FILE]: `src/db.js ${lineFingerprint(line)}\n` });
  git(o.clone, 'checkout', '-q', '-b', 'trio/candidate');
  commit(o.clone, 'src/db.js', line + '\n', 'candidate');
  const attacker = commit(o.seed, ALLOW_FILE, '# no allowances\n', 'attacker');
  git(o.clone, 'fetch', '-q', o.seed, 'HEAD');
  let called = false;
  const r = guard({ ...s4opts(o), base: 'live', maxBehind: 0, resolveDefault: args => {
    called = true; const trusted = resolveTrustedDefault(args);
    git(o.clone, 'update-ref', 'refs/remotes/origin/main', attacker); return trusted;
  } });
  assert.equal(called, true); assert.equal(r.base, o.sha); assert.equal(r.baseBehindRemote, 0);
  assert.equal(r.clean, true, JSON.stringify(r.violations)); assert.equal(r.defaultRef.sha, o.sha);
});
test('hf5b1e-s4-p-prov: legitimate nonstandard defaults and live after fetch pass', () => {
  for (const branch of ['cumulus/main', 'release']) {
    const o = makeOrigin(branch, { 'src.txt': 'base\n' });
    git(o.clone, 'checkout', '-q', '-b', 'trio/work'); commit(o.clone, 'src.txt', 'candidate\n', 'candidate');
    assert.equal(guard(s4opts(o)).clean, true);
    const next = commit(o.seed, 'other.txt', 'next\n', 'advance'); git(o.seed, 'push', '-q', 'origin', branch);
    git(o.clone, 'fetch', '-q', 'origin'); git(o.clone, 'merge', '-q', '--no-edit', `origin/${branch}`);
    const r = guard({ ...s4opts(o), base: 'live', maxBehind: 0 });
    assert.equal(r.clean, true, JSON.stringify(r.violations));
    assert.equal(r.base, git(o.clone, 'merge-base', 'HEAD', next));
  }
});
test('hf5b1e-s4-d-markers: hook, scrubber and deploy retain the same marker union', () => {
  const activation = readFileSync(HOOK, 'utf8').split('\n').find(l => l.startsWith('if [ -n '));
  const markers = [...activation.matchAll(/\$\{([A-Z_]+)\+x\}/g)].map(m => m[1]).sort();
  const union = ['OPENCODE_CONFIG_CONTENT', 'CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'TRIOHARNESS_AGENT'].sort();
  assert.deepEqual(markers, union); assert.deepEqual([...SHARED_MARKERS].sort(), union); assert.deepEqual([...DEFAULT_AGENT_MARKERS].sort(), union);
});

// Revision cleanup: all Azure responses are projected fixtures, never live Azure.
const CLEAN_CFG = { quietDays: 7, keepPrevious: 1 };
const CLEAN_NOW = Date.parse('2026-11-14T00:00:00Z');
const cleanRev = (name, over = {}) => ({ name, active: true, created: '2025-01-01T00:00:00Z', weight: 0, ...over });
const cleanHist = (revision, previousRevision, over = {}) => ({ revision, previousRevision, verified: true, rollback: false, at: '2026-01-01T00:00:00Z', ...over });
const cleanPlan = over => S6_DEPLOY.planRevisionCleanup({ revisions: [cleanRev('old')], trafficEntries: [{ revisionName: 'live', weight: 100 }], serving: 'live', latest: 'latest', history: [cleanHist('live', 'prior')], protectedNames: [], now: CLEAN_NOW, cfg: CLEAN_CFG, maxInactive: 100, ...over });

test('revisionCleanup validateConfig: strict opt-in object, ranges and default without mutating config', () => {
  const good = v => ({ schema: 1, targets: { qa: caTarget('https://test.invalid/h', { revisionCleanup: v }) } });
  for (const v of [{ quietDays: 1 }, { quietDays: 365, keepPrevious: 10 }]) {
    const c = good(v), bytes = JSON.stringify(c); S6_DEPLOY.validateConfig(c); assert.equal(JSON.stringify(c), bytes);
  }
  for (const v of [null, [], true, {}, { quietDays: 0 }, { quietDays: 366 }, { quietDays: 1.5 }, { quietDays: '7' }, { quietDays: 7, keepPrevious: 0 }, { quietDays: 7, keepPrevious: 11 }, { quietDays: 7, keepPrevious: 1.5 }, { quietDays: 7, extra: true }])
    assert.throws(() => S6_DEPLOY.validateConfig(good(v)), /CONFIG_INVALID/);
  const web = JSON.parse(goodCfg); web.targets.qa.revisionCleanup = CLEAN_CFG;
  assert.throws(() => S6_DEPLOY.validateConfig(web), /CONFIG_INVALID/);
});

test('revisionCleanup planner: every kept class, full-history retirement, pre-history, stable order', () => {
  const history = [cleanHist('first', 'retired'), cleanHist('other', 'young-retired', { at: '2026-11-13T00:00:00Z' }), ...Array.from({ length: 10 }, (_, i) => cleanHist('middle'+i, 'holder'+i)), cleanHist('live', 'prior', { at: '2026-11-14T00:00:00Z' })];
  const revisions = ['live', 'young-retired', 'latest', 'label', 'traffic', 'young-created', 'unproven', 'inactive', 'retired', 'old', 'prior', 'recorded'].map(n => cleanRev(n,
    n === 'young-created' ? { created: '2026-11-13T00:00:00Z' } : n === 'unproven' ? { created: '2026-02-01T00:00:00Z' } : n === 'inactive' ? { active: false } : n === 'traffic' ? { weight: 1 } : {}));
  const p = cleanPlan({ revisions, history, protectedNames: ['recorded'], previousRevision: 'prior', trafficEntries: [{ revisionName: 'live', weight: 100 }, { revisionName: 'label', label: 'sticky', weight: 0 }] });
  assert.equal(p.refusal, null); assert.deepEqual(p.deactivate, ['old', 'retired']);
  assert.deepEqual(Object.fromEntries(p.kept.map(x => [x.name, x.reason])), { inactive: 'already-inactive', label: 'labelled', latest: 'latest', live: 'serving', prior: 'previous', recorded: 'recorded-target', traffic: 'traffic', unproven: 'retirement-unproven', 'young-created': 'young-created', 'young-retired': 'young-retired' });
  // Intent, failure and future timestamps cannot establish retirement evidence.
  for (const h of [cleanHist('live', 'old', { intent: true }), cleanHist('live', 'old', { verified: false }), cleanHist('live', 'old', { at: '2027-01-01' })]) {
    const padded = [h, ...Array.from({ length: 12 }, (_, i) => cleanHist('x'+i, 'p'+i))];
    assert.equal(cleanPlan({ history: padded }).kept[0].reason, 'retirement-unproven');
  }
  for (const at of ['2026-02-01', '2026-11-13']) for (const reactivation of [cleanHist('old', null, { at }), { revision: 'old', rollback: true, at }]) {
    const h = [cleanHist('x', 'old'), reactivation, ...Array.from({ length: 12 }, (_, i) => cleanHist('x'+i, 'p'+i))];
    assert.deepEqual(cleanPlan({ history: h }), { deactivate: [], kept: [{ name: 'old', reason: 'retirement-unproven' }], refusal: null });
  }
  assert.deepEqual(cleanPlan().deactivate, ['old'], 'unnamed revision predating the oldest entry is proven pre-history');
  assert.equal(cleanPlan({ history: [] }).kept[0].reason, 'retirement-unproven');
  assert.equal(cleanPlan({ history: [cleanHist('live', 'prior', { at: 'bad' })] }).kept[0].reason, 'retirement-unproven');
  const full = [cleanHist('x', 'old'), ...Array.from({ length: 12 }, (_, i) => cleanHist('x'+i, 'p'+i))];
  assert.deepEqual(cleanPlan({ history: full }).deactivate, ['old'], 'retirement uses history beyond the protection window');
  const young = cleanPlan({ history: [cleanHist('live', 'old', { at: '2026-11-13' }), ...Array.from({ length: 12 }, (_, i) => cleanHist('x'+i, 'p'+i))] });
  assert.equal(young.kept[0].reason, 'young-retired');
});

test('revisionCleanup planner: ambiguous inputs and tied purge cutoff refuse all mutations', () => {
  for (const over of [{ revisions: null }, { revisions: {} }, { revisions: [cleanRev('old'), cleanRev('old')] }, { revisions: [cleanRev('old', { created: null })] }, { revisions: [cleanRev('old', { created: 'bad' })] }, { revisions: [cleanRev('old', { active: 'true' })] }, { revisions: [cleanRev('old', { weight: null })] }, { maxInactive: null }, { maxInactive: -1 }, { trafficEntries: {} }]) {
    const p = cleanPlan(over); assert.match(p.refusal, /^REVISION_CLEANUP_REFUSED:/); assert.deepEqual(p.deactivate, []);
  }
  for (const order of [false, true]) {
    const revisions = [cleanRev('old'), cleanRev('saved', { active: false }), cleanRev('newer', { active: false, created: '2026-01-01' })];
    const p = cleanPlan({ revisions: order ? revisions.reverse() : revisions, maxInactive: 2, protectedNames: ['saved'] });
    assert.equal(p.refusal, 'REVISION_CLEANUP_WOULD_PURGE_ROLLBACK_TARGET'); assert.deepEqual(p.deactivate, []);
  }
  assert.deepEqual(cleanPlan({ revisions: [cleanRev('old'), cleanRev('saved', { active: false, created: '2026-01-01' })], maxInactive: 1, protectedNames: ['saved'] }).deactivate, ['old']);
});

async function cleanupScenario(extra, fn, env = {}) {
  const h = await startHealth();
  try {
    const o = makeOrigin('main', { '.trioharness/deploy.json': JSON.stringify({ schema: 1, targets: { prd: caTarget(h.url, { agentAllowed: true, revisionCleanup: CLEAN_CFG, ...extra }) } }), 'Dockerfile': 'FROM scratch\n' });
    h.state.sha = o.sha;
    const az = fakeAz(), revision = `app-prd--r${o.sha.slice(0, 8)}`;
    await withFake(az, { FAKE_CLEAN_LIST: JSON.stringify([cleanRev('old-a'), cleanRev('old-b'), cleanRev(OLD_REV)]), FAKE_CLEAN_APP: JSON.stringify({ latest: OLD_REV, maxInactive: 100 }), ...env }, async home => {
      const dir = artifactsOf(home, o.clone, 'prd'); mkdirSync(dir, { recursive: true });
      writeFileSync(historyPath(home, o.clone, 'prd'), JSON.stringify([cleanHist(OLD_REV, 'prior')]));
      const invoke = (...a) => main(['--repo', o.clone, '--target', 'prd', '--live-retry-ms', '1', ...a]);
      await withCanary(o.sha, async ({ hits }) => fn({ o, h, az, home, revision, invoke, hits }));
    });
  } finally { await h.close(); }
}
const cleanupCalls = az => az.calls().filter(c => /revision deactivate/.test(c));

test('revisionCleanup absent: no new calls, keys or history fields', async () => {
  await cleanupScenario({ revisionCleanup: undefined }, async ({ az, invoke, home, o }) => {
    const r = await invoke(); assert.equal(r.deployed, true); assert.ok(!Object.hasOwn(r, 'cleanup')); assert.ok(!Object.hasOwn(r.plan, 'revisionCleanup'));
    assert.ok(readHistory(home, o.clone, 'prd').every(x => !Object.hasOwn(x, 'cleanup')));
    assert.ok(!az.calls().some(c => /revision list|revision deactivate|revision activate|maxInactive:|state:properties/.test(c)));
  });
});

test('revisionCleanup preview: dry-run and authorization list identical names; drift changes phrase before any mutation', async () => {
  await cleanupScenario({ agentAllowed: 'with-authorization' }, async ({ az, invoke }) => {
    let first; try { await invoke(); } catch (e) { first = e.message; }
    assert.match(first, /old-a, old-b/); const phrase = first.match(/app-prd:[a-f0-9]{12}:cleanup-[a-f0-9]{64}/)?.[0]; assert.ok(phrase);
    const dry = await invoke('--dry-run', '--authorize', phrase);
    assert.deepEqual(dry.plan.revisionCleanup.deactivate, ['old-a', 'old-b']); assert.equal(dry.plan.authorizationPhrase, phrase);
    process.env.FAKE_CLEAN_LIST = JSON.stringify([cleanRev('old-c'), cleanRev(OLD_REV)]);
    await assert.rejects(invoke('--authorize', phrase), e => /AUTHORIZATION_REQUIRED/.test(e.message) && /old-c/.test(e.message) && !e.message.includes(phrase));
    assert.deepEqual(az.mutations(), []);
  });
});

test('revisionCleanup: only preview-authorized names survive recomputation and immediate revalidation', async () => {
  await cleanupScenario({ agentAllowed: 'with-authorization' }, async ({ az, invoke, revision, home, o }) => {
    let msg; try { await invoke(); } catch (e) { msg = e.message; }
    const phrase = msg.match(/app-prd:[a-f0-9]{12}:cleanup-[a-f0-9]{64}/)[0];
    process.env.FAKE_CLEAN_POST = JSON.stringify([cleanRev('old-a'), cleanRev('old-b'), cleanRev('old-c'), cleanRev(OLD_REV), cleanRev(revision)]);
    // Count includes the unauthorized preview; revalidation happens after the authorized preview and post-deploy snapshot.
    process.env.FAKE_CLEAN_REVALIDATE = '';
    const r = await invoke('--authorize', phrase);
    assert.equal(r.cleanup.status, 'done'); assert.deepEqual(r.cleanup.deactivated, ['old-a', 'old-b']);
    assert.ok(r.cleanup.kept.some(x => x.name === 'old-c' && x.reason === 'not-in-authorized-list'));
    assert.equal(cleanupCalls(az).length, 2); assert.deepEqual(readHistory(home, o.clone, 'prd').at(-1).cleanup, r.cleanup);
    for (const name of ['old-a', 'old-b']) assert.ok(cleanupCalls(az).some(c => c.startsWith(`containerapp revision deactivate --subscription s --resource-group rg --name app-prd --revision ${name} --only-show-errors |`)));
    const calls = az.calls().map(c => c.split(' | ')[0]);
    assert.ok(calls.includes('containerapp revision list --subscription s --resource-group rg --name app-prd --query [].{name:name,active:properties.active,created:properties.createdTime,weight:properties.trafficWeight} -o json'));
    assert.ok(calls.includes('containerapp show --subscription s --resource-group rg --name app-prd --query {latest:properties.latestRevisionName,maxInactive:properties.configuration.maxInactiveRevisions} -o json'));
  });
});

test('revisionCleanup: revalidation keeps removed candidates', async () => {
  await cleanupScenario({}, async ({ invoke, az, revision }) => {
    process.env.FAKE_CLEAN_REVALIDATE = JSON.stringify([cleanRev('old-a', { active: false }), cleanRev('old-b'), cleanRev(OLD_REV), cleanRev(revision)]);
    const r = await invoke(); assert.deepEqual(r.cleanup.deactivated, ['old-b']); assert.equal(cleanupCalls(az).length, 1);
  });
});

for (const kind of ['purge', 'failure', 'unavailable']) test(`revisionCleanup ${kind}: verified deploy records outcome and exits successfully`, async () => {
  const env = kind === 'failure' ? { FAKE_CLEAN_FAIL: '1' } : kind === 'unavailable' ? { FAKE_CLEAN_LIST: '{}' } : { FAKE_CLEAN_APP: JSON.stringify({ latest: OLD_REV, maxInactive: 0 }) };
  await cleanupScenario({ agentAllowed: kind === 'unavailable' ? 'with-authorization' : true }, async ({ az, invoke, home, o }) => {
    if (kind === 'purge') {
      process.env.FAKE_CLEAN_LIST = JSON.stringify([cleanRev('old-a'), cleanRev('prior', { active: false })]);
    }
    const r = await invoke(...(kind === 'unavailable' ? ['--authorize', `app-prd:${o.sha.slice(0, 12)}`] : []));
    assert.equal(r.deployed, true); assert.equal(readHistory(home, o.clone, 'prd').at(-1).verified, true);
    assert.deepEqual(readHistory(home, o.clone, 'prd').at(-1).cleanup, r.cleanup);
    assert.equal(r.cleanup.status, kind === 'failure' ? 'failed' : kind === 'purge' ? 'refused' : 'skipped');
    assert.match(r.cleanup.code, kind === 'failure' ? /REVISION_CLEANUP_FAILED/ : kind === 'purge' ? /REVISION_CLEANUP_WOULD_PURGE_ROLLBACK_TARGET/ : /REVISION_CLEANUP_PREVIEW_UNAVAILABLE/);
    if (kind === 'failure') { assert.equal(cleanupCalls(az).length, 1); assert.ok(r.cleanup.kept.some(x => x.name === 'old-b' && x.reason === 'not-attempted')); }
    else assert.deepEqual(cleanupCalls(az), []);
  }, env);
});

for (const kind of ['inactive', 'active', 'legacy', 'purged', 'permission', 'malformed', 'unknown-sha', 'active-unknown-sha', 'health-failure']) test(`revisionCleanup rollback ${kind}: revision identity and readiness precede traffic`, async () => {
  await cleanupScenario({}, async ({ o, h, az, home, hits }) => {
    const f = historyPath(home, o.clone, 'prd');
    const entries = [verifiedEntry(OLD_SHA, { at: '2026-01-01' }), verifiedEntry(NEW_SHA, { revision: 'unrelated', at: '2026-02-01' }), { revision: OLD_REV, rollback: true, sha: NEW_SHA }, cleanHist('latest', OLD_REV)];
    if (['unknown-sha', 'active-unknown-sha'].includes(kind)) entries[0].revision = 'different';
    if (kind === 'legacy') delete entries[0].verified;
    writeFileSync(f, JSON.stringify(entries)); h.state.sha = OLD_SHA;
    process.env.FAKE_CLEAN_SHOW = JSON.stringify({ active: ['active', 'active-unknown-sha', 'legacy'].includes(kind), state: 'ScaledToZero', prov: 'Provisioned' });
    process.env.FAKE_CLEAN_READY = JSON.stringify({ active: true, state: 'ScaledToZero', prov: 'Provisioned' });
    if (kind === 'purged') process.env.FAKE_CLEAN_SHOW_ERROR = 'ResourceNotFound AZ_OUTPUT_SENTINEL';
    if (kind === 'permission') process.env.FAKE_CLEAN_SHOW_ERROR = 'permission denied AZ_OUTPUT_SENTINEL';
    if (kind === 'malformed') process.env.FAKE_CLEAN_SHOW = '{AZ_OUTPUT_SENTINEL';
    const real = globalThis.fetch, events = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('canary.test')) {
        events.push({ traffic: az.calls().filter(c => /traffic set/.test(c)).length });
        return new Response(JSON.stringify({ sha: kind === 'health-failure' ? NEW_SHA : OLD_SHA }));
      }
      return real(url, init);
    };
    try {
      if (['inactive', 'active', 'legacy'].includes(kind)) {
        const r = await rollbackRun(o.clone); assert.equal(r.plan.sha, OLD_SHA); assert.equal(r.rolledBack, true);
        const calls = az.calls(); const traffic = calls.findIndex(c => /traffic set/.test(c)), activate = calls.findIndex(c => /revision activate/.test(c));
        assert.ok(traffic >= 0);
        if (kind === 'inactive') assert.ok(activate >= 0 && activate < traffic); else assert.equal(activate, -1);
        assert.deepEqual(events, [{ traffic: 0 }]);
        assert.ok(calls.some(c => c.startsWith(`containerapp revision show --subscription s --resource-group rg --name app-prd --revision ${OLD_REV} --query {active:properties.active,state:properties.runningState,prov:properties.provisioningState} -o json |`)));
      } else {
        await assert.rejects(rollbackRun(o.clone), kind === 'purged' ? /ROLLBACK_TARGET_PURGED/ : /ROLLBACK_TARGET_UNVERIFIED/);
        assert.ok(!az.calls().some(c => /traffic set/.test(c)));
        if (['unknown-sha', 'active-unknown-sha'].includes(kind)) assert.ok(!az.calls().some(c => /revision activate/.test(c)));
      }
    } finally { globalThis.fetch = real; }
  });
});

test('revisionCleanup capture: projected JSON and failed command output never reach process stdout/stderr', async () => {
  for (const fail of [false, true]) await cleanupScenario({}, async ({ o, home, az }) => {
    // Spawn a dry-run or failing rollback: no HTTP server dependency in either path.
    process.env.FAKE_CLEAN_LIST = '{"AZ_OUTPUT_SENTINEL":true}';
    const args = [join(here, 'deploy.mjs'), '--repo', o.clone, '--target', 'prd', '--rollback'];
    writeFileSync(historyPath(home, o.clone, 'prd'), JSON.stringify([verifiedEntry(OLD_SHA), cleanHist('latest', OLD_REV)]));
    process.env.FAKE_CLEAN_SHOW = fail ? JSON.stringify({ active: false, prov: 'Provisioned', state: 'AZ_OUTPUT_SENTINEL' }) : '{AZ_OUTPUT_SENTINEL';
    process.env.FAKE_CLEAN_FAIL = '1';
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env });
    assert.equal(r.status, 2); assert.doesNotMatch(r.stdout + r.stderr, /AZ_OUTPUT_SENTINEL/);
    assert.match(r.stderr, /ROLLBACK_TARGET_UNVERIFIED/); assert.ok(!az.calls().some(c => /traffic set/.test(c)));
  });
});

for (const kind of ['serving', 'label', 'malformed-label', 'inventory', 'snapshot', 'limit-purge']) test(`revisionCleanup revalidation ${kind}: refuses before first deactivation`, async () => {
  await cleanupScenario({}, async ({ az, invoke, revision, home, o }) => {
    if (kind === 'serving') process.env.FAKE_CLEAN_TRAFFIC_REVALIDATE = JSON.stringify([{ revisionName: 'other', weight: 100 }]);
    if (kind === 'label') process.env.FAKE_CLEAN_TRAFFIC_REVALIDATE = JSON.stringify([{ revisionName: revision, weight: 100 }, { revisionName: 'old-a', label: 'new-label', weight: 0 }]);
    if (kind === 'malformed-label') process.env.FAKE_CLEAN_TRAFFIC_REVALIDATE = JSON.stringify([{ revisionName: revision, weight: 100 }, { revisionName: 'old-a', weight: 0, label: { toString: null } }, { revisionName: 'old-b', weight: 0, label: 'sticky' }]);
    if (kind === 'snapshot') process.env.FAKE_CLEAN_REVALIDATE = '{';
    if (kind === 'inventory') process.env.FAKE_CLEAN_REVALIDATE = JSON.stringify([cleanRev('old-a'), cleanRev('old-a')]);
    if (kind === 'limit-purge') {
      process.env.FAKE_CLEAN_APP = JSON.stringify({ latest: OLD_REV, maxInactive: 2 });
      process.env.FAKE_CLEAN_REVALIDATE = JSON.stringify([cleanRev('old-a'), cleanRev('old-b'), cleanRev('prior', { active: false })]);
    }
    const r = await invoke(); assert.equal(r.deployed, true); assert.equal(r.cleanup.status, 'refused');
    assert.match(r.cleanup.code, /^REVISION_CLEANUP_(REFUSED:|WOULD_PURGE_ROLLBACK_TARGET)/); assert.deepEqual(cleanupCalls(az), []);
    assert.deepEqual(r.cleanup.kept.filter(k => k.reason === 'revalidation-refused').map(k => k.name), ['old-a', 'old-b']);
    assert.deepEqual(readHistory(home, o.clone, 'prd').at(-1).cleanup, r.cleanup);
  });
});

test('revisionCleanup phrase: canonical names/config, target identity, and empty list bind authorization', () => {
  const t = caTarget('https://test.invalid/h', { revisionCleanup: { quietDays: 7 } });
  const phrase = S6_DEPLOY.revisionCleanupPhrase('qa', t, OLD_SHA, ['b', 'a']);
  assert.equal(phrase, S6_DEPLOY.revisionCleanupPhrase('qa', { ...t, revisionCleanup: { keepPrevious: 2, quietDays: 7 } }, OLD_SHA, ['a', 'b']));
  for (const other of [S6_DEPLOY.revisionCleanupPhrase('prd', t, OLD_SHA, ['b', 'a']), S6_DEPLOY.revisionCleanupPhrase('qa', { ...t, app: 'other' }, OLD_SHA, ['b', 'a']), S6_DEPLOY.revisionCleanupPhrase('qa', t, OLD_SHA, [])]) assert.notEqual(phrase, other);
  assert.match(S6_DEPLOY.revisionCleanupPhrase('qa', t, OLD_SHA, []), /^app-prd:a{12}:cleanup-[a-f0-9]{64}$/);
  const p = cleanPlan({ revisions: [cleanRev('p1'), cleanRev('p2'), cleanRev('p3')], history: [cleanHist('a', 'p1'), cleanHist('b', 'p2'), cleanHist('c', 'p3')], cfg: { quietDays: 7 } });
  assert.deepEqual(p.kept.filter(k => k.reason === 'previous').map(k => k.name), ['p2', 'p3']);
});

test('revisionCleanup rollback: bounded injectable polling refuses unprovisioned target without traffic', async () => {
  const az = fakeAz();
  await withFake(az, { FAKE_CLEAN_SHOW: JSON.stringify({ active: false, state: 'Stopped', prov: 'Provisioned' }), FAKE_CLEAN_READY: JSON.stringify({ active: true, state: 'ScaledToZero', prov: 'Provisioning' }) }, async () => {
    let clock = 0, sleeps = 0;
    await assert.rejects(S6_DEPLOY.verifyRollbackRevision(caTarget('https://test.invalid/h'), OLD_REV, OLD_SHA, { now: () => clock, sleep: async ms => { clock += ms; sleeps++; } }), /ROLLBACK_TARGET_UNVERIFIED/);
    assert.equal(sleeps, 29); assert.equal(az.calls().filter(c => /state:properties/.test(c)).length, 31);
    assert.ok(!az.calls().some(c => /traffic set/.test(c)));
  });
});

for (const fail of [false, true]) test(`revisionCleanup process output: verified ${fail ? 'failed' : 'successful'} cleanup never echoes az bodies`, async () => {
  await cleanupScenario({}, async ({ o, home }) => {
    const sentinel = 'AZ_OUTPUT_SENTINEL';
    process.env.FAKE_CLEAN_LIST = JSON.stringify([cleanRev('old-a', { ignored: sentinel }), cleanRev('old-b'), cleanRev(OLD_REV)]);
    process.env.FAKE_CLEAN_APP = JSON.stringify({ latest: OLD_REV, maxInactive: 100, ignored: sentinel });
    if (fail) process.env.FAKE_CLEAN_FAIL = '1';
    const code = `import {runCli} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)}; globalThis.fetch=async()=>new Response(JSON.stringify({sha:${JSON.stringify(o.sha)}})); process.exitCode=await runCli(process.argv.slice(1));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, '--', '--repo', o.clone, '--target', 'prd'], { encoding: 'utf8', env: process.env });
    assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout + r.stderr, /AZ_OUTPUT_SENTINEL/);
    const result = JSON.parse(r.stdout); assert.equal(result.deployed, true); assert.equal(result.cleanup.status, fail ? 'failed' : 'done');
    assert.deepEqual(readHistory(home, o.clone, 'prd').at(-1).cleanup, result.cleanup);
    if (fail) assert.equal(r.stderr, 'DEPLOY: REVISION_CLEANUP_FAILED\n');
  });
});

test('revisionCleanup delta M2/M3: own revision invalidates retirement and previousRevision extends it for every entry kind', () => {
  const padding = Array.from({ length: 12 }, (_, i) => cleanHist('x'+i, 'p'+i));
  for (const flags of [{ intent: true, verified: false }, { verified: false }, { verified: true }, { rollback: true }]) {
    for (const field of ['revision', 'previousRevision']) {
      const later = { [field]: 'old', at: '2026-11-13', ...flags };
      assert.deepEqual(cleanPlan({ history: [cleanHist('x', 'old'), later, ...padding] }), { deactivate: [], kept: [{ name: 'old', reason: field === 'revision' ? 'retirement-unproven' : 'young-retired' }], refusal: null }, JSON.stringify(later));
    }
  }
  for (const at of ['bad', undefined, '2027-01-01']) {
    assert.deepEqual(cleanPlan({ history: [cleanHist('x', 'old'), { previousRevision: 'old', intent: true, at }, ...padding] }).kept, [{ name: 'old', reason: 'retirement-unproven' }]);
  }
  const history = [cleanHist('x', 'old', { at: '2026-11-13' }), { previousRevision: 'old', verified: false, at: '2026-01-01' }, ...padding];
  assert.equal(cleanPlan({ history }).kept[0].reason, 'young-retired', 'out-of-order timestamps must never shorten the quiet period');
});

test('revisionCleanup delta L4: nullable labels and absent weights are zero traffic, malformed shapes still refuse', () => {
  const trafficEntries = [{ revisionName: 'live', weight: 100, label: null }, { revisionName: 'old' }];
  assert.deepEqual(cleanPlan({ trafficEntries }).deactivate, ['old']);
  for (const extra of [{ label: 7 }, { weight: null }, { weight: '0' }, { weight: -1 }, { weight: 101 }, { latestRevision: true }])
    assert.match(cleanPlan({ trafficEntries: [trafficEntries[0], { revisionName: 'old', ...extra }] }).refusal, /^REVISION_CLEANUP_REFUSED:/);
  for (const maxInactive of [undefined, null, '100', -1]) assert.equal(cleanPlan({ maxInactive }).refusal, 'REVISION_CLEANUP_REFUSED:maxInactiveRevisions');
});

test('revisionCleanup delta L4: unreadable app limit is named in the recorded refusal', async () => {
  await cleanupScenario({}, async ({ invoke, home, o, az }) => {
    process.env.FAKE_CLEAN_APP = JSON.stringify({ latest: OLD_REV, maxInactive: null });
    const r = await invoke(); assert.equal(r.deployed, true); assert.equal(r.cleanup.code, 'REVISION_CLEANUP_REFUSED:maxInactiveRevisions');
    assert.deepEqual(cleanupCalls(az), []); assert.deepEqual(readHistory(home, o.clone, 'prd').at(-1).cleanup, r.cleanup);
  });
});

test('revisionCleanup delta L4: rollback ignores missing or null runningState but requires valid active and provisioning fields', async () => {
  const az = fakeAz();
  await withFake(az, {}, async () => {
    for (const state of [undefined, null]) {
      process.env.FAKE_CLEAN_SHOW = JSON.stringify({ active: true, prov: 'Provisioned', ...(state === null ? { state } : {}) });
      process.env.FAKE_AZ_FQDN = 'canary.test';
      await S6_DEPLOY.verifyRollbackRevision(caTarget('https://test.invalid/h'), OLD_REV, OLD_SHA, { fetchImpl: async () => new Response(JSON.stringify({ sha: OLD_SHA })) });
    }
    for (const s of [{ active: 'true', prov: 'Provisioned' }, { active: true }, null, [], { active: true, prov: 'Failed' }]) {
      process.env.FAKE_CLEAN_SHOW = JSON.stringify(s);
      await assert.rejects(S6_DEPLOY.verifyRollbackRevision(caTarget('https://test.invalid/h'), OLD_REV, OLD_SHA), /ROLLBACK_TARGET_UNVERIFIED/);
    }
    assert.ok(!az.calls().some(c => /traffic set/.test(c)));
  });
});

test('revisionCleanup delta M3: February rollback makes January retirement unproven beyond the history protection window', () => {
  const padding = Array.from({ length: 12 }, (_, i) => cleanHist('nov'+i, 'previous'+i, { at: `2026-11-${10 + i % 3}T00:00:00Z` }));
  const retired = cleanHist('first', 'old', { at: '2026-01-01' });
  for (const flags of [{ rollback: true }, { verified: true }, { intent: true, verified: false }, { verified: false }]) {
    const restarted = { revision: 'old', at: '2026-02-01', ...flags };
    const unknown = [retired, restarted];
    assert.deepEqual(cleanPlan({ history: [...unknown, ...padding] }), { deactivate: [], kept: [{ name: 'old', reason: 'retirement-unproven' }], refusal: null }, JSON.stringify(flags));
    for (const unproven of [{ verified: false }, { verified: true, intent: true }, { rollback: true }]) {
      const history = [...unknown, { previousRevision: 'old', at: '2026-11-01', ...unproven }, ...padding];
      assert.equal(cleanPlan({ history }).kept[0].reason, 'retirement-unproven', 'an unverified previousRevision mention cannot restore invalidated evidence');
    }
    const renewed = [...unknown, cleanHist('new-serving', 'old', { at: '2026-11-01' })];
    assert.deepEqual(cleanPlan({ history: [...renewed, ...padding] }).deactivate, ['old'], 'a later verified forward retirement establishes new evidence');
    const extended = [...renewed, { previousRevision: 'old', verified: false, at: '2026-11-13' }, ...padding];
    assert.deepEqual(cleanPlan({ history: extended }).kept, [{ name: 'old', reason: 'young-retired' }]);
  }
});

for (const cleanup of [false, true]) for (const known of [false, true]) test(`revisionCleanup delta L8: rollback dry-run hint cleanup=${cleanup} known-sha=${known}`, async () => {
  await cleanupScenario({ revisionCleanup: cleanup ? CLEAN_CFG : undefined }, async ({ o, home, az }) => {
    const entries = [...(known ? [verifiedEntry(OLD_SHA)] : []), cleanHist('current', OLD_REV)];
    writeFileSync(historyPath(home, o.clone, 'prd'), JSON.stringify(entries));
    const r = await rollbackRun(o.clone, '--dry-run');
    assert.equal(r.plan.sha, known ? OLD_SHA : null);
    if (cleanup && !known) assert.equal(r.plan.willRefuse, 'ROLLBACK_TARGET_UNVERIFIED');
    else assert.ok(!Object.hasOwn(r.plan, 'willRefuse'));
    assert.deepEqual(az.calls(), [], 'dry-run uses history without az calls or mutations');
  });
});

for (const cleanup of [false, true]) test(`revisionCleanup delta L8: unknown image-only rollback hint is truthful, cleanup=${cleanup}`, async () => {
  await cleanupScenario({ revisionCleanup: cleanup ? CLEAN_CFG : undefined }, async ({ o, home, az }) => {
    writeFileSync(historyPath(home, o.clone, 'prd'), JSON.stringify([{ previousImage: `x.azurecr.io/web:${OLD_SHA}`, verified: true, at: '2026-01-01' }]));
    const r = await rollbackRun(o.clone, '--dry-run');
    assert.equal(r.plan.sha, null);
    if (cleanup) {
      assert.equal(r.plan.willRefuse, 'ROLLBACK_TARGET_UNVERIFIED');
      await assert.rejects(rollbackRun(o.clone), /ROLLBACK_TARGET_UNVERIFIED/);
    } else assert.ok(!Object.hasOwn(r.plan, 'willRefuse'));
    assert.deepEqual(az.calls(), []);
  });
});

// App-keyed history: legacy inputs use real commits; all storage stays in temporary homes.
const appHistory = await import('./deploy.mjs');
const legacyDir = (home, folder, target = 'prd') => join(home, '.trioharness-lean', 'artifacts', folder, target);
const appEntry = (sha, at = '2026-01-01', extra = {}) => ({ ...verifiedEntry(sha), revision: `app-prd--r${sha.slice(0, 8)}`, at, ...extra });
function historyFixture() {
  const target = caTarget('https://fixture.invalid/h', { agentAllowed: true });
  const o = makeOrigin('main', { '.trioharness/deploy.json': JSON.stringify({ schema: 1, targets: { prd: target } }) });
  const home = tmp('app-history');
  const options = { home, repo: o.clone, targetName: 'prd', target, cfg: { targets: { prd: target } }, git: (...a) => git(o.clone, ...a) };
  return { ...options, o, options, own: legacyDir(home, o.clone.split('/').pop()) };
}
test('app history: identity ignores folders, target names and case; separates type/subscription/group/app/slot', () => {
  const t = caTarget('https://fixture.invalid/h');
  const key = appHistory.appHistoryKey(t);
  assert.equal(key, appHistory.appHistoryKey({ ...t, app: ' APP-PRD ', subscription: ' S ', resourceGroup: ' RG ', type: ' ContainerApp ' }));
  assert.equal(appHistory.appHistoryKey({ ...t, type: undefined }), appHistory.appHistoryKey({ ...t, type: 'webapp' }));
  for (const field of ['type', 'subscription', 'resourceGroup', 'app', 'slot']) assert.notEqual(key, appHistory.appHistoryKey({ ...t, [field]: 'other' }), field);
  assert.equal(appHistory.appHistoryDir(t, '/home'), join('/home', '.trioharness-lean', 'app-history', key));
  assert.match(key, /^app-prd-[a-f0-9]{16}$/);
});
test('app history: own legacy migration preserves bytes, is idempotent, resumes tails and read paths create nothing', () => {
  const f = historyFixture();
  const bytes = JSON.stringify([appEntry(f.o.sha)], null, 3);
  write(f.own, 'history.json', bytes);
  const read = () => appHistory.loadAppHistory(f.options);
  assert.equal(read().entries.length, 1);
  assert.ok(!existsSync(join(f.home, '.trioharness-lean', 'app-history')));
  const state = read();
  appHistory.appendAppHistory(state, { at: '2026-02-01', rollback: true });
  assert.equal(readFileSync(join(f.own, 'history.json'), 'utf8'), bytes);
  assert.deepEqual(read().entries[0].migratedFrom, { dir: `${f.o.clone.split('/').pop()}/prd`, index: 0, hash: appHistory.legacyEntryHash(appEntry(f.o.sha)) });
  assert.equal(read().pending.length, 0);
  appendHistoryEntry(f.own, appEntry(f.o.sha, '2026-03-01'));
  assert.equal(read().pending.length, 1);
  appHistory.appendAppHistory(read(), { at: '2026-04-01' });
  assert.equal(read().entries.length, 4);
  assert.equal(read().pending.length, 0);
  assert.ok(existsSync(join(f.own, 'history.d', '000001.json')));
  assert.ok(read().entries.every(e => e.appIdentity === appHistory.appHistoryKey(f.target)));
});
test('app history: foreign matching revisions merge chronologically; another app and unrelated sources are ignored', () => {
  const f = historyFixture();
  write(f.own, 'history.json', JSON.stringify([appEntry(f.o.sha, '2026-02-01')]));
  write(legacyDir(f.home, 'other'), 'history.json', JSON.stringify([appEntry(f.o.sha, '2026-01-01')]));
  write(legacyDir(f.home, 'foreign'), 'history.json', JSON.stringify([appEntry(f.o.sha, '2026-01-01', { revision: 'another--r12345678' })]));
  write(legacyDir(f.home, 'unrelated'), 'history.json', JSON.stringify([{ sha: f.o.sha, at: '2026-01-01' }]));
  const s = appHistory.loadAppHistory(f.options);
  assert.equal(s.ambiguous, false); assert.equal(s.pending.length, 2);
  assert.deepEqual(s.entries.map(e => e.at), ['2026-01-01', '2026-02-01']);
  const before = JSON.stringify(s.entries);
  assert.equal(appHistory.classifyLegacyHistory({ entries: [appEntry(f.o.sha, undefined, { revision: 'another--r12345678' })], own: true, target: f.target, commitExists: () => true }), 'ambiguous');
  assert.equal(JSON.stringify(s.entries), before);
});
test('app history: attribution refuses unknown commits but preserves own history with same-name config identities', () => {
  for (const web of [false, true]) {
    const f = historyFixture();
    if (web) { f.options.target = webTarget('https://fixture.invalid/h', { app: 'app-prd' }); f.options.cfg.targets.prd = f.options.target; }
    write(f.own, 'history.json', JSON.stringify([appEntry('f'.repeat(40))]));
    let s = appHistory.loadAppHistory(f.options);
    assert.equal(s.ambiguous, true); assert.deepEqual(s.pending, []);
    writeFileSync(join(f.own, 'history.json'), JSON.stringify([appEntry(f.o.sha)]));
    f.options.cfg.targets.other = { ...f.options.target, subscription: 'another' };
    s = appHistory.loadAppHistory(f.options);
    assert.equal(s.ambiguous, false); assert.equal(s.pending.length, 1);
  }
});
test('app history: append order never sorts rollback before retirement; older tails and backwards migrated stores are ambiguous', () => {
  const f = historyFixture();
  write(f.own, 'history.json', JSON.stringify([appEntry(f.o.sha, '2026-02-01')]));
  appHistory.appendAppHistory(appHistory.loadAppHistory(f.options), { at: '2026-03-01', rollback: true, revision: 'old' });
  appendHistoryEntry(f.own, appEntry(f.o.sha, '2026-01-01'));
  const s = appHistory.loadAppHistory(f.options);
  assert.equal(s.ambiguous, true); assert.deepEqual(s.pending, []);
  assert.deepEqual(s.entries.map(e => e.at), ['2026-02-01', '2026-03-01']);
  const view = appHistory.buildHistoryView([{ at: '2026-02-01', migratedFrom: { dir: 'x/prd', index: 0 } }, { at: '2026-01-01', rollback: true }], []);
  assert.equal(view.ambiguous, true);
  assert.deepEqual(view.entries.map(e => e.at), ['2026-02-01', '2026-01-01']);
});
test('app history: multi-source invalid timestamps and positively attributed unreadable records stay ambiguous', () => {
  const f = historyFixture();
  write(f.own, 'history.json', JSON.stringify([appEntry(f.o.sha)]));
  const foreign = legacyDir(f.home, 'other');
  write(foreign, 'history.json', JSON.stringify([appEntry(f.o.sha, 'bad')]));
  let s = appHistory.loadAppHistory(f.options);
  assert.equal(s.ambiguous, true); assert.equal(s.pending.length, 1);
  writeFileSync(join(foreign, 'history.json'), JSON.stringify([appEntry(f.o.sha)]));
  write(foreign, 'history.d/000001.json', '[{"sha":');
  s = appHistory.loadAppHistory(f.options);
  assert.equal(s.ambiguous, true); assert.equal(s.pending.length, 1);
});
test('app history: webapp imports only own source and fills the absolute legacy artifact path', () => {
  const f = historyFixture();
  f.options.target = webTarget('https://fixture.invalid/h', { app: 'app-prd' }); f.options.cfg.targets.prd = f.options.target;
  write(f.own, 'history.json', JSON.stringify([{ sha: f.o.sha, at: '2026-01-01' }]));
  write(f.own, `${f.o.sha}.zip`, 'ZIP');
  write(legacyDir(f.home, 'other'), 'history.json', JSON.stringify([appEntry(f.o.sha)]));
  const s = appHistory.loadAppHistory(f.options);
  assert.equal(s.pending.length, 1); assert.equal(s.entries[0].artifact, join(f.own, `${f.o.sha}.zip`));
  assert.equal(s.ambiguous, false);
});
test('app history: identity mismatch and partial or short imported records fail closed without repair', () => {
  const f = historyFixture();
  write(f.own, 'history.json', JSON.stringify([appEntry(f.o.sha)]));
  const s = appHistory.loadAppHistory(f.options);
  const paths = new Map();
  const io = { ...realIo, openSync: (path, flag) => { const fd = openSync(path, flag); paths.set(fd, path); return fd; },
    writeSync: (fd, buf, off, len) => writeSync(fd, buf, off, paths.get(fd).includes('history.d') ? Math.min(3, len) : len) };
  assert.throws(() => appHistory.appendAppHistory(s, { at: '2026-02-01' }, { io }), /HISTORY_ENTRY_UNREADABLE/);
  const broken = join(s.dir, 'history.d', '000001.json'), bytes = readFileSync(broken);
  assert.throws(() => appHistory.loadAppHistory(f.options), /HISTORY_ENTRY_UNREADABLE/);
  assert.deepEqual(readFileSync(broken), bytes);
  const g = historyFixture(), dir = appHistory.appHistoryDir(g.target, g.home);
  write(dir, 'identity.json', '[]');
  assert.throws(() => appHistory.loadAppHistory(g.options), /HISTORY_IDENTITY_MISMATCH/);
});
test('app history main: two folders share forward history and rollback; changing app isolates the same target name', async () => {
  const h = await startHealth();
  try {
    const target = caTarget(h.url, { agentAllowed: true });
    const o = makeBuildOrigin({ prd: target }); h.state.sha = o.sha;
    const other = tmp('second-clone'); git(other, 'clone', '-q', o.bare, '.');
    git(other, 'fetch', '-q', 'origin');
    const az = fakeAz();
    await withFake(az, { CLAUDECODE: '1' }, async home => {
      const state = appHistory.loadAppHistory({ home, repo: o.clone, targetName: 'prd', target, cfg: { targets: { prd: target } }, git: (...a) => git(o.clone, ...a) });
      appHistory.appendAppHistory(state, appEntry(o.sha, '2026-01-01', { revision: OLD_REV }));
      await withCanary(o.sha, async () => assert.equal((await main(['--repo', o.clone, '--target', 'prd'])).deployed, true));
      assert.equal((await rollbackRun(other)).rolledBack, true);
      assert.equal(readAllHistory(state.dir).at(-1).rollback, true);
      const cfg = { schema: 1, targets: { prd: { ...target, app: 'different' } } };
      write(other, '.trioharness/deploy.json', JSON.stringify(cfg));
      await assert.rejects(withEnv({}, () => rollbackRun(other, '--config-from-worktree', '--dry-run')), /NO_ROLLBACK_TARGET/);
    });
  } finally { await h.close(); }
});
test('app history main: ambiguous legacy refuses cleanup in preview and run without deactivation', async () => {
  await oldCleanupScenario(async ({ invoke, home, o, az }) => {
    write(legacyDir(home, o.clone.split('/').pop()), 'history.json', JSON.stringify([appEntry(o.sha)]));
    write(legacyDir(home, 'other'), 'history.json', JSON.stringify([appEntry('f'.repeat(40))]));
    const preview = await invoke('--dry-run');
    assert.equal(preview.plan.revisionCleanup.code, 'REVISION_CLEANUP_REFUSED:history-ambiguous');
    assert.ok(!existsSync(join(home, '.trioharness-lean', 'app-history')));
    const result = await invoke();
    assert.equal(result.deployed, true); assert.equal(result.cleanup.code, 'REVISION_CLEANUP_REFUSED:history-ambiguous');
    assert.deepEqual(cleanupCalls(az), []);
  });
});

test('app history: attribution treats app names literally and detects positive evidence beside malformed legacy entries', () => {
  const f = historyFixture();
  assert.equal(appHistory.classifyLegacyHistory({ entries: [{ revision: 'appXprd--r12345678' }], own: false, target: { ...f.target, app: 'app.prd' }, commitExists: () => true }), 'foreign-app');
  for (const kind of ['name', 'null', 'array']) {
    const folder = legacyDir(f.home, kind);
    if (kind === 'name') { write(folder, 'history.d/000001.json', JSON.stringify([appEntry(f.o.sha)])); write(folder, 'history.d/unexpected', 'bad'); }
    if (kind === 'null') write(folder, 'history.json', JSON.stringify([null, appEntry(f.o.sha)]));
    if (kind === 'array') { write(folder, 'history.d/000001.json', '[]'); write(folder, 'history.d/000002.json', JSON.stringify([appEntry(f.o.sha)])); }
    const s = appHistory.loadAppHistory(f.options);
    assert.equal(s.ambiguous, true, kind); assert.deepEqual(s.pending, [], kind);
  }
});
test('app history: a crash between complete imports resumes without duplicates; backwards pending sources are not imported', () => {
  const f = historyFixture();
  write(f.own, 'history.json', JSON.stringify([appEntry(f.o.sha, '2026-01-01'), appEntry(f.o.sha, '2026-02-01')]));
  const io = { ...realIo, openSync: (path, flag) => { if (path.endsWith('000002.json')) throw Object.assign(new Error('fixture interruption'), { code: 'EIO' }); return openSync(path, flag); } };
  assert.throws(() => appHistory.appendAppHistory(appHistory.loadAppHistory(f.options), { at: '2026-03-01' }, { io }), /fixture interruption/);
  const resumed = appHistory.loadAppHistory(f.options);
  assert.equal(resumed.entries.length, 2); assert.equal(resumed.pending.length, 1);
  appHistory.appendAppHistory(resumed, { at: '2026-03-01' });
  assert.equal(appHistory.loadAppHistory(f.options).entries.length, 3);
  const backwards = appHistory.buildHistoryView([], [{ dir: 'x/prd', classification: 'attributed', entries: [{ at: '2026-02-01' }, { at: '2026-01-01' }] }]);
  assert.equal(backwards.ambiguous, true); assert.deepEqual(backwards.pending, []);
});

// Review delta: use the serialized records that the deploy writer actually emits.
const writtenEntry = (sha, at, extra = {}) => JSON.parse(JSON.stringify(appHistory.deployHistoryEntry({ sha, at, imageRef: null, digest: null, runId: null, imageTag: null, previousImage: null, revision: null, previousRevision: null, promoteFrom: null, authorization: null, verified: true, ...extra })));
const writtenImageRollback = (sha, at) => {
  const { image, revision } = writtenEntry(sha, at, { imageRef: 'old-image' });
  return { sha, image, revision, at, rollback: true }; // the actual rollback writer records these five fields
};
test('review H1: null revisions and Azure pre-script revisions preserve the own newest retirement', () => {
  const f = historyFixture(), retired = 'app-prd--b';
  const own = [writtenEntry(f.o.sha, '2026-01-02'),
    writtenImageRollback(f.o.sha, '2026-01-03'),
    writtenEntry(f.o.sha, '2026-11-13', { revision: 'APP-PRD--x1y2z3a', previousRevision: retired }),
    ...Array.from({ length: 12 }, (_, i) => writtenEntry(f.o.sha, '2026-11-13', { revision: `app-prd--p${i}`, previousRevision: `app-prd--q${i}` }))];
  write(f.own, 'history.json', JSON.stringify(own));
  write(legacyDir(f.home, 'earlier'), 'history.json', JSON.stringify([writtenEntry(f.o.sha, '2026-01-01', { revision: 'app-prd--earlier' })]));
  const s = appHistory.loadAppHistory(f.options);
  assert.equal(s.ambiguous, false); assert.equal(s.entries.length, own.length + 1);
  assert.deepEqual(cleanPlan({ history: s.entries, revisions: [cleanRev(retired)] }).kept, [{ name: retired, reason: 'young-retired' }]);
  for (const revision of [null, undefined, 4, {}, []]) assert.equal(appHistory.classifyLegacyHistory({ entries: [writtenEntry(f.o.sha, '2026-01-01', { revision })], own: true, target: f.target, commitExists: () => true }), 'attributed');
  for (const revision of ['app-prd--x1y2z3a', 'APP-PRD--old']) assert.equal(appHistory.classifyLegacyHistory({ entries: [{ revision }], own: false, target: f.target, commitExists: () => true }), 'attributed');
  for (const revision of ['app-prd--old--extra', 'other--old', 'app-prd', ' app-prd--old']) assert.equal(appHistory.classifyLegacyHistory({ entries: [{ revision }], own: true, target: f.target, commitExists: () => true }), 'ambiguous');
});
async function oldCleanupScenario(fn) {
  const h = await startHealth();
  try {
    const target = caTarget(h.url, { agentAllowed: true, revisionCleanup: CLEAN_CFG });
    const o = makeBuildOrigin({ prd: target }); h.state.sha = o.sha;
    const az = fakeAz();
    await withFake(az, { FAKE_CLEAN_LIST: JSON.stringify([cleanRev(OLD_REV)]), FAKE_CLEAN_APP: JSON.stringify({ latest: OLD_REV, maxInactive: 100 }) }, async home => {
      const invoke = (...args) => main(['--repo', o.clone, '--target', 'prd', '--live-retry-ms', '1', ...args]);
      const options = { home, repo: o.clone, targetName: 'prd', target, cfg: { targets: { prd: target } }, git: (...args) => git(o.clone, ...args) };
      await withCanary(o.sha, () => fn({ o, home, az, invoke, options }));
    });
  } finally { await h.close(); }
}
test('review H2: nonmonotone retirement and rollback source cannot be rescued by a multi-source merge', async () => {
  await oldCleanupScenario(async ({ o, home, invoke, az, options }) => {
    const own = legacyDir(home, o.clone.split('/').pop());
    const entries = [writtenEntry(o.sha, '2026-01-10', { revision: 'app-prd--f', previousRevision: 'app-prd--b' }),
      { ...writtenEntry(o.sha, '2026-01-09', { revision: 'app-prd--b' }), rollback: true }];
    const bytes = JSON.stringify(entries); write(own, 'history.json', bytes);
    write(legacyDir(home, 'earlier'), 'history.json', JSON.stringify([writtenEntry(o.sha, '2026-01-01', { revision: 'app-prd--e' })]));
    const view = appHistory.loadAppHistory(options);
    assert.equal(view.ambiguous, true); assert.deepEqual(view.pending, []); assert.deepEqual(view.entries, []);
    const preview = await invoke('--dry-run'); assert.equal(preview.plan.revisionCleanup.code, 'REVISION_CLEANUP_REFUSED:history-ambiguous');
    assert.ok(!existsSync(join(home, '.trioharness-lean', 'app-history')));
    const result = await invoke(); assert.equal(result.cleanup.code, 'REVISION_CLEANUP_REFUSED:history-ambiguous');
    assert.deepEqual(cleanupCalls(az), []); assert.equal(readFileSync(join(own, 'history.json'), 'utf8'), bytes);
    assert.ok(readHistory(home, o.clone, 'prd').every(e => !e.migratedFrom));
  });
});
test('review M1: malformed own legacy history refuses strictly before writes or Azure calls', async () => {
  const h = await startHealth();
  try {
    const o = makeBuildOrigin({ prd: caTarget(h.url, { agentAllowed: true }) }), az = fakeAz();
    await withFake(az, {}, async home => {
      const dir = legacyDir(home, o.clone.split('/').pop());
      for (const text of ['[', '[null]']) {
        write(dir, 'history.json', text);
        await assert.rejects(rollbackRun(o.clone, '--dry-run'), /HISTORY_ENTRY_UNREADABLE/);
        assert.ok(!existsSync(join(home, '.trioharness-lean', 'app-history')));
        assert.equal(readFileSync(join(dir, 'history.json'), 'utf8'), text);
      }
      writeFileSync(join(dir, 'history.json'), JSON.stringify([writtenEntry(o.sha, '2026-01-01')]));
      write(dir, 'history.d/000001.json', '[{"sha":');
      await assert.rejects(rollbackRun(o.clone, '--dry-run'), /HISTORY_ENTRY_UNREADABLE/);
      assert.ok(!existsSync(join(home, '.trioharness-lean', 'app-history')));
      assert.deepEqual(az.calls(), []);
    });
  } finally { await h.close(); }
});
test('review M1: unreadable own parent directory retains the strict refusal', () => {
  const f = historyFixture(); write(f.own, 'history.json', JSON.stringify([appEntry(f.o.sha)]));
  const io = { ...realIo, readdirSync: (path, ...args) => {
    if (path === dirname(f.own)) throw Object.assign(new Error('fixture permission failure'), { code: 'EACCES' });
    return readdirSync(path, ...args);
  } };
  assert.throws(() => appHistory.loadAppHistory({ ...f.options, io }), /HISTORY_ENTRY_UNREADABLE/);
  assert.ok(!existsSync(join(f.home, '.trioharness-lean', 'app-history')));
});
test('review M2: config ambiguity excludes other folders while the own source stays trusted until targets change', () => {
  const f = historyFixture();
  write(f.own, 'history.json', JSON.stringify([appEntry(f.o.sha, '2026-02-01')]));
  write(legacyDir(f.home, 'other'), 'history.json', JSON.stringify([appEntry(f.o.sha, '2026-01-01')]));
  f.options.cfg.targets.other = { ...f.target, resourceGroup: 'elsewhere' };
  for (let i = 0; i < 2; i++) {
    const view = appHistory.loadAppHistory(f.options);
    assert.equal(view.ambiguous, true); assert.equal(view.pending.length, 1);
    assert.equal(view.pending[0].migratedFrom.dir, `${f.o.clone.split('/').pop()}/prd`);
  }
  delete f.options.cfg.targets.other;
  const view = appHistory.loadAppHistory(f.options);
  assert.equal(view.ambiguous, false); assert.equal(view.pending.length, 2);
});
test('review M3: migration hashes detect changed imported prefixes and copied histories across folders', () => {
  const f = historyFixture(), entry = appEntry(f.o.sha);
  write(f.own, 'history.json', JSON.stringify([entry]));
  appHistory.appendAppHistory(appHistory.loadAppHistory(f.options), { at: '2026-02-01' });
  const stored = readAllHistory(appHistory.appHistoryDir(f.target, f.home));
  assert.match(stored[0].migratedFrom.hash, /^[0-9a-f]{64}$/);
  assert.equal(stored[0].migratedFrom.hash, appHistory.legacyEntryHash(entry));
  writeFileSync(join(f.own, 'history.json'), JSON.stringify([Object.fromEntries(Object.entries(entry).reverse())]));
  assert.equal(appHistory.loadAppHistory(f.options).ambiguous, false, 'object key order is not a source change');
  writeFileSync(join(f.own, 'history.json'), JSON.stringify([{ ...entry, previousRevision: 'app-prd--changed' }]));
  let view = appHistory.loadAppHistory(f.options);
  assert.equal(view.ambiguous, true); assert.deepEqual(view.pending, []);
  writeFileSync(join(f.own, 'history.json'), JSON.stringify([entry]));
  write(legacyDir(f.home, 'copied'), 'history.json', JSON.stringify([entry]));
  view = appHistory.loadAppHistory(f.options);
  assert.equal(view.ambiguous, true); assert.deepEqual(view.pending, []);
  // Also reject duplicate evidence in the very first multi-source migration.
  const fresh = historyFixture();
  write(fresh.own, 'history.json', JSON.stringify([appEntry(fresh.o.sha)]));
  write(legacyDir(fresh.home, 'copied'), 'history.json', JSON.stringify([appEntry(fresh.o.sha)]));
  view = appHistory.loadAppHistory(fresh.options);
  assert.equal(view.ambiguous, true); assert.equal(view.pending.length, 1);
  assert.equal(view.pending[0].migratedFrom.dir, `${fresh.o.clone.split('/').pop()}/prd`);
  assert.equal(appHistory.legacyEntryHash({ z: { b: 2, a: 1 }, a: null }), appHistory.legacyEntryHash({ a: null, z: { a: 1, b: 2 } }));
  assert.notEqual(appHistory.legacyEntryHash({ a: [1, 2] }), appHistory.legacyEntryHash({ a: [2, 1] }));
});
test('review L1: injected short identity writes fail closed and are never repaired', () => {
  const f = historyFixture(); write(f.own, 'history.json', JSON.stringify([appEntry(f.o.sha)]));
  const io = { ...realIo, writeSync: (fd, buf, off, len) => writeSync(fd, buf, off, Math.min(3, len)) };
  assert.throws(() => appHistory.appendAppHistory(appHistory.loadAppHistory(f.options), { at: '2026-02-01' }, { io }), /HISTORY_ENTRY_UNREADABLE/);
  const dir = appHistory.appHistoryDir(f.target, f.home), identity = join(dir, 'identity.json'), before = readFileSync(identity);
  assert.equal(before.length, 3); assert.ok(!existsSync(join(dir, 'history.d')));
  assert.throws(() => appHistory.loadAppHistory(f.options), /HISTORY_IDENTITY_MISMATCH/);
  assert.deepEqual(readFileSync(identity), before);
});
for (const type of ['webapp', 'containerapp']) test(`review L2: main migrates OLD ${type} legacy rollback history without dry-run writes`, async () => {
  const h = await startHealth();
  try {
    const target = type === 'webapp' ? webTarget(h.url) : caTarget(h.url, { agentAllowed: true });
    const o = makeBuildOrigin({ prd: target }), old = git(o.clone, 'rev-parse', `${o.sha}~1`);
    h.state.sha = old;
    const az = fakeAz();
    await withFake(az, { FAKE_AZ_SERVING: 'app-prd--x1y2z3a' }, async home => {
      const dir = legacyDir(home, o.clone.split('/').pop());
      const entries = [writtenEntry(old, '2026-01-01', { revision: type === 'webapp' ? null : 'app-prd--x1y2z3a', imageRef: 'old-image' }),
        writtenImageRollback(old, '2026-01-02'),
        writtenEntry(o.sha, '2026-01-03', { revision: type === 'webapp' ? null : 'app-prd--new', previousRevision: type === 'webapp' ? null : 'app-prd--x1y2z3a', imageRef: 'new-image', previousImage: 'old-image' })];
      const bytes = JSON.stringify(entries); write(dir, 'history.json', bytes);
      if (type === 'webapp') write(dir, `${old}.zip`, 'OLD ZIP');
      const dry = await rollbackRun(o.clone, '--dry-run');
      assert.equal(dry.plan.sha, old); assert.ok(!existsSync(join(home, '.trioharness-lean', 'app-history')));
      assert.deepEqual(az.calls(), []);
      const result = await rollbackRun(o.clone); assert.equal(result.rolledBack, true);
      const stored = readAllHistory(appHistory.appHistoryDir(target, home));
      assert.equal(stored.length, 4); assert.ok(stored.slice(0, 3).every(e => e.migratedFrom?.hash));
      assert.equal(readFileSync(join(dir, 'history.json'), 'utf8'), bytes);
      if (type === 'webapp') assert.ok(az.calls().some(c => c.includes(`--src-path ${join(dir, `${old}.zip`)}`)));
    });
  } finally { await h.close(); }
});
test('review L3: relevant ignored sources emit one reason line each, including dry runs', () => {
  const f = historyFixture(), lines = [];
  write(f.own, 'history.json', JSON.stringify([{ revision: 'other--old' }]));
  write(legacyDir(f.home, 'ambiguous'), 'history.json', JSON.stringify([appEntry('f'.repeat(40))]));
  const options = { ...f.options, log: text => lines.push(text), reported: new Set() };
  appHistory.loadAppHistory(options); appHistory.loadAppHistory(options);
  assert.equal(lines.length, 2);
  assert.ok(lines.some(line => line === `DEPLOY: history: ${f.o.clone.split('/').pop()}/prd not imported (foreign-app-own-dir)\n`));
  assert.ok(lines.some(line => /^DEPLOY: history: ambiguous\/prd not imported \([a-z-]+\)\n$/.test(line)));
  assert.ok(!existsSync(join(f.home, '.trioharness-lean', 'app-history')));
});


test('LOW fold: foreign app revision in own legacy history refuses cleanup with a named reason', async () => {
  await oldCleanupScenario(async ({ o, home, invoke, az, options }) => {
    const dir = legacyDir(home, o.clone.split('/').pop()), lines = [];
    const bytes = JSON.stringify([writtenEntry(o.sha, '2026-01-01', { revision: 'other-app--old' })]);
    write(dir, 'history.json', bytes);
    write(legacyDir(home, 'foreign'), 'history.json', bytes);
    const view = appHistory.loadAppHistory({ ...options, log: text => lines.push(text) });
    assert.equal(view.ambiguous, true); assert.deepEqual(view.pending, []); assert.deepEqual(view.entries, []);
    assert.deepEqual(view.ignored, [{ dir: `${o.clone.split('/').pop()}/prd`, reason: 'foreign-app-own-dir' }]);
    assert.deepEqual(lines, [`DEPLOY: history: ${o.clone.split('/').pop()}/prd not imported (foreign-app-own-dir)\n`]);
    assert.equal(appHistory.classifyLegacyHistory({ entries: JSON.parse(bytes), own: false, target: options.target, commitExists: () => true }), 'foreign-app');
    const preview = await invoke('--dry-run');
    assert.equal(preview.plan.revisionCleanup.code, 'REVISION_CLEANUP_REFUSED:history-ambiguous');
    assert.ok(!existsSync(join(home, '.trioharness-lean', 'app-history')));
    const result = await invoke(); assert.equal(result.deployed, true);
    assert.equal(result.cleanup.code, 'REVISION_CLEANUP_REFUSED:history-ambiguous');
    assert.deepEqual(cleanupCalls(az), []);
    assert.ok(readHistory(home, o.clone, 'prd').every(entry => !entry.migratedFrom));
    assert.equal(readFileSync(join(dir, 'history.json'), 'utf8'), bytes);
  });
});

function fixtureTrafficHealth() {
  return { url: 'https://live.test/health', state: { sha: '' } };
}

async function withTrafficHealth(h, sha, fn) {
  const hits = { canary: 0, other: 0 };
  const previousFetch = globalThis.fetch;
  const previousFqdn = process.env.FAKE_AZ_FQDN;
  process.env.FAKE_AZ_FQDN = 'canary.test';
  globalThis.fetch = async url => {
    const canary = String(url) === 'https://canary.test/health';
    assert.ok(canary || String(url) === h.url, `unexpected health URL ${url}`);
    hits[canary ? 'canary' : 'other']++;
    return new Response(JSON.stringify({ sha: canary ? (typeof sha === 'function' ? sha() : sha) : h.state.sha }));
  };
  try { return await fn({ hits }); }
  finally {
    globalThis.fetch = previousFetch;
    if (previousFqdn === undefined) delete process.env.FAKE_AZ_FQDN;
    else process.env.FAKE_AZ_FQDN = previousFqdn;
  }
}

async function trafficModeCli(o, target, ...args) {
  let stdout = '', stderr = '';
  const code = await S6_DEPLOY.runCli(['--repo', o.clone, '--target', target, '--live-retry-ms', '1', ...args], {
    stdout: line => { stdout += line; }, stderr: line => { stderr += line; },
  });
  return { stdout, stderr, code };
}

test('traffic modes: stage creates a healthy revision without changing traffic', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
  h.state.sha = o.sha;
  const az = fakeAz(), revision = `app-prd--r${o.sha.slice(0, 8)}`;
  await withFake(az, {}, async home => withTrafficHealth(h, o.sha, async ({ hits }) => {
    const result = await trafficModeCli(o, 'qa', '--stage-only');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).revision, revision);
    assert.match(result.stdout, new RegExp(`node deploy.mjs --target qa --switch-traffic ${revision}`));
    assert.ok(az.calls().some(call => call.includes(`--revision-suffix r${o.sha.slice(0, 8)}`)));
    const trafficReads = az.calls().filter(call => call.includes('properties.configuration.ingress.traffic'));
    assert.equal(trafficReads.length, 3);
    assert.equal(az.calls().some(call => call.includes('traffic set')), false);
    assert.deepEqual(hits, { canary: 1, other: 1 });
    const entries = readHistory(home, o.clone, 'qa');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].staged, true);
    assert.equal(entries[0].verified, true);
  }));
});

test('traffic modes: stage skips cleanup and requires its own phrase', async () => {
  const h = fixtureTrafficHealth();
  const target = caTarget(h.url, { revisionCleanup: CLEAN_CFG });
  const o = makeBuildOrigin({ qa: target });
  const az = fakeAz();
  const deployPhrase = `app-prd:${o.sha.slice(0, 12)}`;
  const stagePhrase = `app-prd:stage:${o.sha.slice(0, 12)}`;
  const cleanupPhrase = S6_DEPLOY.revisionCleanupPhrase('qa', target, o.sha, []);
  h.state.sha = o.sha;
  await withFake(az, {
    CLAUDECODE: '1',
    FAKE_CLEAN_LIST: JSON.stringify([cleanRev(OLD_REV)]),
    FAKE_CLEAN_APP: JSON.stringify({ latest: OLD_REV, maxInactive: 100 }),
  }, async () => withTrafficHealth(h, o.sha, async () => {
    for (const phrase of [deployPhrase, cleanupPhrase]) {
      const refused = await trafficModeCli(o, 'qa', '--stage-only', '--authorize', phrase);
      assert.equal(refused.code, 2, refused.stderr);
      assert.ok(refused.stderr.includes(stagePhrase));
    }
    const dry = await trafficModeCli(o, 'qa', '--stage-only', '--dry-run', '--authorize', stagePhrase);
    assert.equal(dry.code, 0, dry.stderr);
    const { plan } = JSON.parse(dry.stdout);
    assert.equal(plan.authorizationPhrase, stagePhrase);
    assert.equal(Object.hasOwn(plan, 'revisionCleanup'), false);
    assert.deepEqual(az.calls(), []);
    const staged = await trafficModeCli(o, 'qa', '--stage-only', '--authorize', stagePhrase);
    assert.equal(staged.code, 0, staged.stderr);
    assert.equal(Object.hasOwn(JSON.parse(staged.stdout).plan, 'revisionCleanup'), false);
    assert.equal(az.calls().filter(call => call.includes('properties.configuration.ingress.traffic')).length, 3);
    assert.ok(az.calls().every(call => !/revision (list|deactivate)|maxInactiveRevisions/.test(call)));
    const deploy = await trafficModeCli(o, 'qa', '--authorize', stagePhrase);
    assert.equal(deploy.code, 2, deploy.stderr);
    assert.match(deploy.stderr, /AUTHORIZATION_REQUIRED/);
    assert.ok(deploy.stderr.includes(cleanupPhrase));
  }));
});

test('traffic modes: stage refuses when the post-update traffic snapshot differs', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
  h.state.sha = o.sha;
  const az = fakeAz();
  const drifted = JSON.stringify([{ revisionName: OLD_REV, weight: 90 }, { revisionName: 'changed-revision', weight: 10 }]);
  await withFake(az, { FAKE_STAGE_AFTER_TRAFFIC: drifted }, async home => withTrafficHealth(h, o.sha, async ({ hits }) => {
    const result = await trafficModeCli(o, 'qa', '--stage-only');
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /STAGE_TRAFFIC_CHANGED.*az containerapp ingress traffic set .*--revision-weight app-prd--rold=100/);
    assert.equal(hits.canary, 0);
    assert.equal(az.calls().some(call => call.includes('traffic set')), false);
    assert.deepEqual(historyFiles(home, o.clone, 'qa'), []);
  }));
});

for (const percent of [null, '25', 'unknown', 'malformed']) {
  test(`traffic modes: switch containerapp (${percent ?? 'default'}) without building`, async () => {
    const h = fixtureTrafficHealth();
    const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
    h.state.sha = o.sha;
    const az = fakeAz(), revision = `app-prd--r${o.sha.slice(0, 8)}`;
    await withFake(az, { FAKE_SWITCH_REVISIONS: percent === 'malformed' ? 'malformed' : JSON.stringify([revision, OLD_REV]) }, async home => withTrafficHealth(h, o.sha, async () => {
      seedTrafficHistory(home, o, 'qa', verifiedEntry(o.sha), verifiedEntry(o.sha, { revision, staged: true }));
      const result = await trafficModeCli(o, 'qa', '--switch-traffic', percent === 'unknown' ? 'missing-revision' : revision,
        ...(percent === '25' ? ['--percent', percent] : []));
      if (percent === 'unknown' || percent === 'malformed') {
        assert.equal(result.code, 2, result.stderr);
        assert.match(result.stderr, /UNKNOWN_REVISION/);
        assert.deepEqual(az.mutations(), []);
        return;
      }
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`--target qa --rollback --allow-overwrite ${o.sha.slice(0, 12)}`));
      const weights = percent === '25' ? `${revision}=25 ${OLD_REV}=75` : `${revision}=100`;
      assert.deepEqual(az.mutations().map(call => call.split(' | ')[0]), [
        `containerapp ingress traffic set --subscription s --resource-group rg --name app-prd --revision-weight ${weights} --only-show-errors`,
      ]);
    }));
  });
}

function seedTrafficHistory(home, o, target, ...entries) {
  write(artifactsOf(home, o.clone, target), 'history.json', JSON.stringify(entries));
}

async function trafficTerminal(answer, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  Object.defineProperty(process, 'stdin', { configurable: true, value: input });
  input.write(`${answer}\n`);
  try { return await fn(); }
  finally {
    Object.defineProperty(process, 'stdin', descriptor);
    input.destroy();
  }
}

test('traffic modes: webapp requires its configured slot and production policy, and rolls back the swap', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({
    web: webTarget(h.url, { slot: 'preview' }),
    prod: webTarget(h.url, { agentAllowed: 'with-authorization' }),
    missing: webTarget(h.url, { slot: 'missing' }),
  });
  const old = git(o.clone, 'rev-parse', 'HEAD^');
  const az = fakeAz();
  await withFake(az, { FAKE_SWITCH_SLOTS: '["preview","other"]' }, async home => {
    h.state.sha = old;
    const slotSha = o.sha;
    let productionOverride, beforeSwitchOverride;
    const fetch = globalThis.fetch;
    globalThis.fetch = async url => {
      if (String(url) === 'https://production.test/health') {
        const swaps = az.calls().filter(call => call.includes('slot swap')).length;
        const liveSha = productionOverride !== undefined && swaps === 1 ? productionOverride : swaps % 2 ? o.sha : beforeSwitchOverride ?? old;
        return new Response(JSON.stringify({ sha: liveSha }));
      }
      if (String(url) === 'https://canary.test/health') {
        const swaps = az.calls().filter(call => call.includes('slot swap')).length;
        return new Response(JSON.stringify({ sha: swaps % 2 ? old : slotSha }));
      }
      assert.equal(String(url), h.url);
      return new Response(JSON.stringify({ sha: h.state.sha }));
    };
    try {
      const refused = async (target, code, ...args) => {
        const result = await trafficModeCli(o, target, ...args);
        assert.equal(result.code, 2, result.stderr);
        assert.match(result.stderr, new RegExp(code));
      };
      await refused('prod', 'STAGE_NEEDS_SLOT', '--stage-only');
      await refused('web', 'PERCENT_UNSUPPORTED', '--switch-traffic', 'preview', '--percent', '100');
      await refused('web', 'SLOT_INVALID', '--switch-traffic', 'production');
      await refused('web', 'UNKNOWN_SLOT', '--switch-traffic', 'other');
      await refused('web', 'INTERACTIVE_REQUIRED', '--switch-traffic', 'preview');
      await withEnv({ CLAUDECODE: '1' }, () => refused('web', 'AGENT_NOT_ALLOWED', '--switch-traffic', 'preview'));
      await trafficTerminal('app-web', () => refused('missing', 'UNKNOWN_SLOT', '--switch-traffic', 'missing'));
      const slotList = process.env.FAKE_SWITCH_SLOTS;
      process.env.FAKE_SWITCH_SLOTS = 'malformed';
      try {
        await trafficTerminal('app-web', () => refused('web', 'UNKNOWN_SLOT', '--switch-traffic', 'preview'));
      } finally { process.env.FAKE_SWITCH_SLOTS = slotList; }
      assert.ok(az.calls().some(call => call.includes('slot list')));
      assert.deepEqual(az.mutations(), []);

      const staged = await trafficModeCli(o, 'web', '--stage-only');
      assert.equal(staged.code, 0, staged.stderr);
      assert.equal(JSON.parse(staged.stdout).slot, 'preview');
      assert.match(az.mutations().at(-1), /webapp deploy .*--slot preview /);
      assert.equal(readHistory(home, o.clone, 'web').at(-1).staged, true);

      await trafficTerminal('app-web', () => refused('web', 'AUTHORIZATION_REQUIRED', '--switch-traffic', 'preview',
        '--authorize', `app-web:${o.sha.slice(0, 12)}`));
      const attemptSwitch = (code, ...args) => trafficTerminal('app-web', () => refused('web', code, '--switch-traffic', 'preview',
        '--authorize', 'app-web:switch:preview:100', ...args));
      beforeSwitchOverride = NEW_SHA;
      await attemptSwitch('WOULD_OVERWRITE_UNMERGED: prod');
      beforeSwitchOverride = '';
      await attemptSwitch('RUNNING_REF_UNREADABLE: prod', '--allow-unreadable', 'web');
      for (const baseline of ['', old.slice(0, 12)]) {
        beforeSwitchOverride = baseline;
        await attemptSwitch('ROLLBACK_BASELINE_UNREADABLE: prod did not report a full running commit', '--allow-unreadable', 'prod');
      }
      assert.equal(az.mutations().filter(call => call.includes('slot swap')).length, 0);
      beforeSwitchOverride = undefined;
      const switched = await trafficTerminal('app-web', () => trafficModeCli(o, 'web', '--switch-traffic', 'preview',
        '--authorize', 'app-web:switch:preview:100'));
      assert.equal(switched.code, 0, switched.stderr);
      assert.match(az.mutations().at(-1), /webapp deployment slot swap .*--slot preview --target-slot production /);
      const [, intent, verified] = readHistory(home, o.clone, 'web');
      assert.equal(intent.intent, true);
      assert.equal(verified.slot, 'preview');
      assert.equal(verified.verified, true);
      assert.equal(verified.previousSha, old);
      const switchResult = JSON.parse(switched.stdout);
      assert.doesNotMatch(switchResult.rollbackCommand, /--authorize/);
      assert.equal(switchResult.rollbackAuthorizationPhrase, 'app-web:rollback:preview');
      assert.deepEqual(readHistory(home, o.clone, 'prod').map(({ intent, sha, previousSha }) => [intent, sha, previousSha]),
        [[true, o.sha, old], [undefined, o.sha, old]]);

      await trafficTerminal('app-web', () => refused('web', 'AUTHORIZATION_REQUIRED', '--rollback'));
      productionOverride = '';
      await trafficTerminal('app-web', () => refused('web', 'RUNNING_REF_UNREADABLE', '--rollback',
        '--authorize', 'app-web:rollback:preview'));
      productionOverride = old;
      await trafficTerminal('app-web', () => refused('web', 'WOULD_OVERWRITE_UNMERGED', '--rollback',
        '--authorize', 'app-web:rollback:preview'));
      productionOverride = NEW_SHA;
      await trafficTerminal('app-web', () => refused('web', 'WOULD_OVERWRITE_UNMERGED', '--rollback',
        '--authorize', 'app-web:rollback:preview', '--allow-overwrite', o.sha.slice(0, 12)));
      assert.equal(az.mutations().filter(call => call.includes('slot swap')).length, 1);
      const rolled = await trafficTerminal('app-web', () => trafficModeCli(o, 'prod', '--rollback',
        '--authorize', 'app-web:rollback:preview', '--allow-overwrite', NEW_SHA.slice(0, 12)));
      assert.equal(rolled.code, 0, rolled.stderr);
      assert.equal(JSON.parse(rolled.stdout).reported, old);
      for (const target of ['web', 'prod']) {
        assert.equal(readHistory(home, o.clone, target).at(-1).rollback, true);
        assert.equal(readHistory(home, o.clone, target).at(-1).sha, old);
      }
      assert.equal(az.mutations().filter(call => call.startsWith('webapp deploy ')).length, 1);
    } finally { globalThis.fetch = fetch; }
  });
});

for (const swapBack of [false, true]) {
  test(`traffic modes: plain webapp slot rollback refuses after a ${swapBack ? 'swap-back' : 'swap'}`, async () => {
    const h = fixtureTrafficHealth();
    const o = makeBuildOrigin({ web: webTarget(h.url, { slot: 'preview' }) });
    const az = fakeAz();
    const stagedSha = git(o.clone, 'rev-parse', 'HEAD^');
    h.state.sha = stagedSha;
    await withFake(az, {}, async home => withTrafficHealth(h, o.sha, async () => {
      const artifact = join(artifactsOf(home, o.clone, 'web'), 'recorded.zip');
      const swapped = { sha: stagedSha, slot: 'preview', switched: true, previousSha: OLD_SHA };
      seedTrafficHistory(home, o, 'web',
        { sha: OLD_SHA, at: '2026-01-01' },
        { sha: stagedSha, at: '2026-01-02', artifact, staged: true },
        ...(swapBack ? [{ sha: OLD_SHA, slot: 'preview', at: '2026-01-04', rollback: true }] : [
          { ...swapped, at: '2026-01-03', artifact, intent: true, verified: false },
          { ...swapped, at: '2026-01-04', artifact, verified: true },
        ]),
        { sha: o.sha, at: '2026-01-05' });
      writeFileSync(artifact, 'recorded');
      const result = await trafficModeCli(o, 'web', '--rollback');
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /ROLLBACK_TARGET_UNVERIFIED: preview content changed by a slot swap; redeploy the slot instead/);
      assert.deepEqual(az.mutations(), []);
    }));
  });
}

test('traffic modes: plain webapp slot rollback restores the artifact preceding a stage', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({ web: webTarget(h.url, { slot: 'preview' }) });
  const az = fakeAz();
  const previous = git(o.clone, 'rev-parse', 'HEAD^');
  h.state.sha = previous;
  await withFake(az, {}, async home => withTrafficHealth(h, o.sha, async () => {
    const artifact = join(artifactsOf(home, o.clone, 'web'), 'recorded.zip');
    seedTrafficHistory(home, o, 'web',
      { sha: OLD_SHA, at: '2026-01-01' },
      { sha: previous, at: '2026-01-02', artifact },
      { sha: o.sha, at: '2026-01-03', staged: true });
    writeFileSync(artifact, 'recorded');
    const result = await trafficModeCli(o, 'web', '--rollback');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reported, previous);
    assert.ok(az.mutations().some(call => call.includes(`--src-path ${artifact} `) && call.includes('--slot preview ')));
  }));
});

test('traffic modes: webapp rollback refuses a recorded previous slot different from the configured slot', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({ web: webTarget(h.url, { slot: 'preview' }), prod: webTarget(h.url) });
  const az = fakeAz();
  await withFake(az, {}, async home => {
    seedTrafficHistory(home, o, 'web', {
      sha: o.sha, verified: true, switched: true, slot: 'preview', previousRevision: 'other', previousSha: OLD_SHA,
    });
    const result = await trafficTerminal('app-web', () => trafficModeCli(o, 'web', '--rollback', '--dry-run'));
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /ROLLBACK_TARGET_UNVERIFIED/);
    assert.deepEqual(az.calls(), []);
  });
});

test('traffic modes: switch guards and dedicated authorization refuse before mutation', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({
    user: caTarget(h.url, { agentAllowed: false }),
    auth: caTarget(h.url),
    qa: caTarget(h.url, { agentAllowed: true, requireOnDefaultBranch: true }),
  });
  const az = fakeAz(), revision = 'app-prd--candidate';
  h.state.sha = o.sha;
  await withFake(az, { FAKE_SWITCH_REVISIONS: JSON.stringify([revision]) }, async home => {
    seedTrafficHistory(home, o, 'qa', verifiedEntry(o.sha, { revision, staged: true }));
    const refused = async (target, code, ...args) => {
      const result = await trafficModeCli(o, target, ...args);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, new RegExp(code));
    };
    const switching = ['--switch-traffic', revision];
    await withTrafficHealth(h, o.sha, async () => {
      for (const [target, agent, code] of [
        ['user', true, 'AGENT_NOT_ALLOWED'], ['user', false, 'INTERACTIVE_REQUIRED'],
        ['auth', true, 'AUTHORIZATION_REQUIRED'], ['auth', false, 'AUTHORIZATION_REQUIRED'],
      ]) {
        await withEnv(agent ? { CLAUDECODE: '1' } : {}, () => refused(target, code, ...switching,
          '--authorize', `app-prd:${o.sha.slice(0, 12)}`));
      }
      const dry = await trafficModeCli(o, 'auth', ...switching, '--percent', '25', '--dry-run',
        '--authorize', `app-prd:switch:${revision}:25`);
      assert.equal(dry.code, 0, dry.stderr);
      assert.equal(JSON.parse(dry.stdout).plan.authorizationPhrase, `app-prd:switch:${revision}:25`);
      for (const percent of ['0', '101', '1.5']) await refused('qa', 'PERCENT_INVALID', ...switching, '--percent', percent);
      await refused('qa', 'PERCENT_INVALID', '--percent', '25');
      await refused('qa', 'DEPLOY_MODE_CONFLICT', ...switching, '--stage-only');
      await refused('qa', 'DEPLOY_MODE_CONFLICT', ...switching, '--rollback');
      h.state.sha = NEW_SHA;
      await refused('qa', 'WOULD_OVERWRITE_UNMERGED', ...switching);
    });
    git(o.clone, 'checkout', '-qb', 'candidate');
    const branchSha = commit(o.clone, 'branch.txt', 'branch', 'branch only');
    await withTrafficHealth(h, branchSha, () => refused('qa', 'UNVERIFIED_DESTINATION', ...switching));
    seedTrafficHistory(home, o, 'qa', verifiedEntry(branchSha, { revision }));
    await withTrafficHealth(h, branchSha, () => refused('qa', 'SHA_NOT_PUSHED', ...switching));
    git(o.clone, 'push', '-q', 'origin', 'candidate');
    await withTrafficHealth(h, branchSha, () => refused('qa', 'SHA_NOT_ON_DEFAULT', ...switching));
    git(o.seed, 'pull', '-q', 'origin', 'main');
    commit(o.seed, 'stale.txt', 'stale', 'advance remote main');
    git(o.seed, 'push', '-q', 'origin', 'main');
    await refused('qa', 'REMOTE_REF_STALE', ...switching);
    assert.deepEqual(az.mutations(), []);
    assert.deepEqual(historyFiles(home, o.clone, 'qa'), []);
  });
});

test('traffic modes: split verification accepts the remainder and printed rollback works with production policy', async t => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({
    qa: caTarget(h.url, { app: 'app-qa', agentAllowed: true }),
    prod: caTarget(h.url, { requireSameShaOn: 'qa' }),
  });
  const old = git(o.clone, 'rev-parse', 'HEAD^'), revision = 'app-prd--candidate';
  const az = fakeAz();
  const split = JSON.stringify([{ revisionName: revision, weight: 65 }, { revisionName: OLD_REV, weight: 25 },
    { revisionName: 'app-prd--other', weight: 10 }]);
  const hasSplit = () => az.mutations().some(call => call.includes(`${revision}=80`));
  let clock = Date.now();
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms !== 10000) return realSetTimeout(fn, ms, ...args);
    clock += ms;
    return realSetTimeout(fn, 0, ...args);
  });
  await withFake(az, { FAKE_SWITCH_REVISIONS: JSON.stringify([revision, OLD_REV]), FAKE_AZ_TRAFFIC: split }, async home => {
    seedTrafficHistory(home, o, 'prod', verifiedEntry(old), verifiedEntry(o.sha, { revision, staged: true }));
    Object.defineProperty(h.state, 'sha', { configurable: true, get: () => hasSplit() ? old : o.sha });
    await withTrafficHealth(h, o.sha, async () => {
      const partial = await trafficModeCli(o, 'prod', '--switch-traffic', revision, '--percent', '80', '--authorize', `app-prd:switch:${revision}:80`);
      assert.equal(partial.code, 0, partial.stderr);
      assert.equal(JSON.parse(partial.stdout).reported, old);
      assert.match(az.mutations().at(-1), new RegExp(`${revision}=80 ${OLD_REV}=20`));
      const [, , intent, verified] = readHistory(home, o.clone, 'prod');
      for (const entry of [intent, verified]) {
        assert.equal(entry.revision, revision);
        assert.equal(entry.previousRevision, OLD_REV);
        assert.equal(entry.percent, 80);
        assert.equal(entry.switched, true);
      }
      assert.equal(intent.intent, true);
      assert.equal(intent.verified, false);
      assert.equal(verified.verified, true);
      assert.equal(verified.staged, undefined);
    });
    // Execute the actual printed command in a fresh process, with health still driven by the fake.
    Object.defineProperty(h.state, 'sha', { value: o.sha });
    const forward = await withTrafficHealth(h, o.sha, () => trafficModeCli(o, 'prod', '--switch-traffic', revision,
      '--authorize', `app-prd:switch:${revision}:100`));
    assert.equal(forward.code, 0, forward.stderr);
    const { rollbackCommand: printed, rollbackAuthorizationPhrase: phrase } = JSON.parse(forward.stdout);
    assert.match(printed, /--rollback /);
    assert.doesNotMatch(printed, /--authorize/);
    assert.equal(phrase, 'app-prd:rollback:app-prd--rold');
    const preload = join(az.dir, 'fake-health.mjs');
    writeFileSync(preload, `import { readFileSync } from 'node:fs';
globalThis.fetch = async url => new Response(JSON.stringify({ sha:
  String(url).includes('canary.test') || readFileSync(process.env.FAKE_AZ_LOG + '.switched', 'utf8') === ${JSON.stringify(OLD_REV)}
    ? ${JSON.stringify(old)} : ${JSON.stringify(o.sha)} }));
`);
    const execution = spawnSync('sh', ['-c', `${printed} --authorize "$1"`, 'rollback', phrase], { encoding: 'utf8',
      env: { ...process.env, FAKE_AZ_FQDN: 'canary.test', NODE_OPTIONS: `--import=${preload}` } });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(JSON.parse(execution.stdout).reported, old);

    assert.equal(JSON.parse(execution.stdout).rolledBack, true);
    assert.match(az.mutations().at(-1), new RegExp(`${OLD_REV}=100`));
  });
});

test('traffic modes: plain rollback ignores staged entries, including the cleanup revision lookup', async () => {
  const h = fixtureTrafficHealth();
  for (const revisionCleanup of [undefined, { quietDays: 7 }]) {
    const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true, revisionCleanup }) });
    const old = git(o.clone, 'rev-parse', 'HEAD^');
    const az = fakeAz();
    await withFake(az, {}, async home => {
      seedTrafficHistory(home, o, 'qa', verifiedEntry(old),
        verifiedEntry(NEW_SHA, { staged: true }),
        verifiedEntry(o.sha, { revision: 'app-prd--live', previousRevision: OLD_REV }),
        verifiedEntry(NEW_SHA, { revision: 'app-prd--staged', staged: true }));
      const result = await trafficModeCli(o, 'qa', '--rollback', '--dry-run');
      assert.equal(result.code, 0, result.stderr);
      const { plan } = JSON.parse(result.stdout);
      assert.equal(plan.revision, OLD_REV);
      assert.equal(plan.sha, old);
      assert.deepEqual(az.mutations(), []);
    });
  }
});

test('traffic modes: switch rollback refuses a short previous SHA before setting traffic', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
  const az = fakeAz();
  await withFake(az, {}, async home => {
    seedTrafficHistory(home, o, 'qa', verifiedEntry(o.sha, {
      revision: 'app-prd--live', switched: true, previousRevision: OLD_REV, previousSha: 'abcdef1',
    }));
    const result = await trafficModeCli(o, 'qa', '--rollback', '--dry-run');
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /ROLLBACK_TARGET_UNVERIFIED/);
    assert.deepEqual(az.mutations(), []);
  });
});

test('traffic modes: stage and partial switch do not prove retirement, full switch does', () => {
  const padding = Array.from({ length: 12 }, (_, i) => cleanHist(`new-${i}`, 'live'));
  for (const entry of [cleanHist('candidate', 'old', { staged: true }),
    cleanHist('candidate', 'old', { switched: true, percent: 75 })]) {
    assert.deepEqual(cleanPlan({ history: [entry, ...padding] }).kept, [{ name: 'old', reason: 'retirement-unproven' }]);
  }
  const switched = cleanHist('candidate', 'old', { switched: true, percent: 100 });
  assert.deepEqual(cleanPlan({ history: [switched, ...padding] }).deactivate, ['old']);
});

test('traffic modes: switch refuses when the heaviest other revision has no verified SHA', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
  const az = fakeAz(), revision = 'app-prd--candidate';
  const split = JSON.stringify([{ revisionName: revision, weight: 20 },
    { revisionName: 'app-prd--other', weight: 30 }, { revisionName: OLD_REV, weight: 50 }]);
  h.state.sha = o.sha;
  await withFake(az, { FAKE_SWITCH_REVISIONS: JSON.stringify([revision, OLD_REV, 'app-prd--other']),
    FAKE_AZ_TRAFFIC: split }, async home => {
    seedTrafficHistory(home, o, 'qa', verifiedEntry(o.sha, { revision, staged: true }));
    const before = readHistory(home, o.clone, 'qa');
    const fetch = globalThis.fetch;
    let canaryReads = 0;
    process.env.FAKE_AZ_FQDN = 'canary.test';
    globalThis.fetch = async url => {
      if (String(url) === 'https://canary.test/health' && ++canaryReads === 2)
        return new Response(null, { status: 503 });
      return new Response(JSON.stringify({ sha: o.sha }));
    };
    try {
      const result = await trafficModeCli(o, 'qa', '--switch-traffic', revision);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /ROLLBACK_BASELINE_UNREADABLE: app-prd--rold has no verified full commit; a switch without a rollback baseline is refused/);
      assert.equal(canaryReads, 2);
      assert.deepEqual(az.mutations(), []);
      assert.deepEqual(readHistory(home, o.clone, 'qa'), before);
      assert.deepEqual(historyFiles(home, o.clone, 'qa'), []);
    } finally { globalThis.fetch = fetch; }
  });
});

test('traffic modes: partial switch refuses without another active revision', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
  h.state.sha = o.sha;
  const az = fakeAz(), revision = 'app-prd--candidate';
  await withFake(az, { FAKE_SWITCH_REVISIONS: JSON.stringify([revision]), FAKE_AZ_SERVING: revision }, async home => {
    seedTrafficHistory(home, o, 'qa', verifiedEntry(o.sha, { revision }));
    const result = await withTrafficHealth(h, o.sha, () => trafficModeCli(o, 'qa', '--switch-traffic', revision, '--percent', '75'));
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /TRAFFIC_REMAINDER_UNAVAILABLE/);
    assert.deepEqual(az.mutations(), []);
    assert.deepEqual(historyFiles(home, o.clone, 'qa'), []);
  });
});

test('traffic modes: canary failure still checks for delayed stage traffic drift', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
  const az = fakeAz();
  h.state.sha = o.sha;
  await withFake(az, {}, async home => withTrafficHealth(h, () => {
    process.env.FAKE_AZ_TRAFFIC = JSON.stringify([{ revisionName: OLD_REV, weight: 99 }, { revisionName: 'other-revision', weight: 1 }]);
    return NEW_SHA;
  }, async () => {
    const result = await trafficModeCli(o, 'qa', '--stage-only');
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /STAGE_TRAFFIC_CHANGED.*--revision-weight app-prd--rold=100/);
    assert.deepEqual(historyFiles(home, o.clone, 'qa'), []);
  }));
});

test('default deploy preserves the existing missing-FQDN argv and CLI output', async () => {
  const h = fixtureTrafficHealth();
  const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true }) });
  h.state.sha = o.sha;
  const az = fakeAz();
  await withFake(az, {}, async home => {
    const result = await withFixtureHealthSha(h.url, o.sha, () => trafficModeCli(o, 'qa'));
    const revision = `app-prd--r${o.sha.slice(0, 8)}`;
    assert.deepEqual({ ...result, stderr: result.stderr.replace(/buildDir \S+/, 'buildDir <temp>') }, {
      code: 2, stdout: '', stderr: `DEPLOY: REVISION_FQDN_MISSING: ${revision}; buildDir <temp>\n`,
    });
    const app = '--subscription s --resource-group rg --name app-prd';
    const rev = `${app} --revision ${revision}`;
    assert.deepEqual(az.calls().map(call => call.split(' | ')[0]), [
      `acr build --subscription s --registry myacr --image web:${o.sha} --file Dockerfile --no-logs --output json .`,
      'acr show --subscription s --name myacr --query loginServer -o tsv',
      `containerapp show ${app} --query properties.template.containers[0].image -o tsv`,
      `containerapp show ${app} --query {mode:properties.configuration.activeRevisionsMode,containers:properties.template.containers[].name} -o json`,
      `containerapp show ${app} --query properties.configuration.ingress.traffic -o json`,
      `containerapp update ${app} --image ${pinned(RUN_DIGEST)} --only-show-errors --revision-suffix r${o.sha.slice(0, 8)}`,
      `containerapp revision show ${rev} --query properties.template.containers[0].image -o tsv`,
      `containerapp ingress traffic set ${app} --revision-weight ${OLD_REV}=100 --only-show-errors`,
      `containerapp revision show ${rev} --query properties.fqdn -o tsv`,
    ]);
    assert.deepEqual(historyFiles(home, o.clone, 'qa'), []);
  });
});

test('deploy help prints launcher usage before git or az', () => {
  const az = fakeAz();
  const cwd = tmp('deploy-help');
  const gitLog = join(cwd, 'git.log');
  writeFileSync(gitLog, '');
  writeFileSync(join(az.dir, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_GIT_LOG"\nexit 1\n', { mode: 0o755 });
  for (const args of [['--help'], ['-h'], ['--target', 'qa', '--help'],
    ['--help', '--target', 'qa', '--stage-only'], ['--target', 'qa', '-h']]) {
    const result = spawnSync(process.execPath, [join(here, 'deploy.mjs'), ...args], {
      cwd, encoding: 'utf8',
      env: { PATH: `${az.dir}:${process.env.PATH}`, FAKE_AZ_LOG: az.log, FAKE_GIT_LOG: gitLog },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^Usage: node deploy\.mjs /);
    for (const option of ['--stage-only', '--switch-traffic', '--allow-unreadable', '--config-from-worktree']) {
      assert.ok(result.stdout.includes(option), option);
    }
    assert.doesNotMatch(result.stdout, /^\/\//m);
    assert.deepEqual(az.calls(), []);
    assert.equal(readFileSync(gitLog, 'utf8'), '');
  }
});

test('buildArgsFromApp queries metadata before reading only mapped plain values', async () => {
  const h = fixtureTrafficHealth();
  const az = fakeAz();
  const build = { dockerfile: 'Dockerfile', buildArgsFromApp: { CLIENT: 'NEXT.PUBLIC-ID', ALIAS: 'NEXT.PUBLIC-ID' } };
  const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true, build }) });
  h.state.sha = o.sha;
  const metadata = JSON.stringify([{ name: 'NEXT.PUBLIC-ID' }, { name: 'UNRELATED_SETTING' }]);
  await withFake(az, { FAKE_BUILD_ENV_METADATA: metadata }, () => withTrafficHealth(h, o.sha, async () => {
    const result = await trafficModeCli(o, 'qa', '--stage-only');
    assert.equal(result.code, 0, result.stderr);
    const queries = az.calls().filter(line => line.includes('.env'));
    assert.equal(queries.length, 2);
    assert.match(queries[0], /\.env\[\]\.\{name:name,secretRef:secretRef\} -o json/);
    assert.match(queries[1], /\.env\[\?name=='NEXT\.PUBLIC-ID'\] \| \[0\]\.value -o tsv/);
    assert.ok(az.calls().some(line => line.includes('--build-arg CLIENT=fixture-client-id --build-arg ALIAS=fixture-client-id')));
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-client-id/);
  }));
});

test('buildArgsFromApp dry run refuses an invalid app-variable name at config load', async () => {
  const h = fixtureTrafficHealth();
  const az = fakeAz();
  const build = { dockerfile: 'Dockerfile', buildArgsFromApp: { CLIENT: "bad'name" } };
  const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true, build }) });
  h.state.sha = o.sha;
  await withFake(az, {}, () => withTrafficHealth(h, o.sha, async ({ hits }) => {
    const result = await trafficModeCli(o, 'qa', '--dry-run');
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /BUILD_ARG_NAME_INVALID/);
    assert.deepEqual(hits, { canary: 0, other: 0 });
    assert.deepEqual(az.calls(), []);
  }));
});

test('buildArgsFromApp refuses secret or missing names before reading any value', async () => {
  for (const [name, code, entry] of [
    ['PRIVATE_SETTING', 'BUILD_ARG_IS_SECRET', { name: 'PRIVATE_SETTING', secretRef: 'fixture-reference' }],
    ['ABSENT', 'BUILD_ARG_MISSING_ON_APP', null],
  ]) {
    const h = fixtureTrafficHealth();
    const az = fakeAz();
    const build = { dockerfile: 'Dockerfile', buildArgsFromApp: { CLIENT: 'PUBLIC_CLIENT_ID', OTHER: name } };
    const o = makeBuildOrigin({ qa: caTarget(h.url, { agentAllowed: true, build }) });
    h.state.sha = o.sha;
    const metadata = JSON.stringify([{ name: 'PUBLIC_CLIENT_ID' }, ...(entry ? [entry] : [])]);
    await withFake(az, { FAKE_BUILD_ENV_METADATA: metadata }, () => withTrafficHealth(h, o.sha, async () => {
      const result = await trafficModeCli(o, 'qa', '--stage-only');
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, new RegExp(code));
      const queries = az.calls().filter(line => line.includes('.env'));
      assert.equal(queries.length, 1);
      assert.ok(queries[0].includes('.env[].{name:name,secretRef:secretRef} -o json'));
      assert.deepEqual(az.mutations(), []);
    }));
  }
});
