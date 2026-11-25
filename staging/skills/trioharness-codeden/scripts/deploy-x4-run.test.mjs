import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { runX4, runX4Main } from './deploy-x4-run.mjs';

const azCalls = [];

test('build refuses app-derived build arguments before reading Azure', async () => {
  await assert.rejects(runX4({
    argv: ['--action', 'build', '--sha', 'a'.repeat(40)],
    target: { ...TARGET, build: { buildArgsFromApp: {} } },
    deps: { az: args => {
      azCalls.push([...args]);
      assert.fail('unexpected Azure read');
    } },
  }), /X4_BUILD_ARGS_FROM_APP_UNSUPPORTED/);
});

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { registerHooks } from 'node:module';
import * as deploy from './deploy.mjs';
import { appHistoryDir, appendHistoryEntry, DEFAULT_AGENT_MARKERS, main, validateConfig } from './deploy.mjs';
import { actionP64, canonicalJson, normalizeTraffic, plannedTraffic, sha256Hex } from './deploy-x4.mjs';

const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);
const DIGEST = 'sha256:' + 'c'.repeat(64);
const OTHER_DIGEST = 'sha256:' + 'd'.repeat(64);
const OLD = 'api--old';
const CANDIDATE = 'api--raaaaaaaa-g2';
const INTERMEDIATE = CANDIDATE + '-v';
const SENTINEL = 'SENTINEL-VALUE-123';
const GEN = 'MigrationAuthority__Generation';
const REV_GEN = 'MigrationAuthority__RevocationGeneration';
const DECL = { name: 'authority', aliasPrefix: 'authority-g', vaultHost: 'test.vault.azure.net', vaultItem: 'item',
  identity: '/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id',
  mountPath: '/app/auth', path: 'receipt.json' };
const MOUNTS = [{ volumeName: DECL.name, mountPath: DECL.mountPath }];
const IMAGE = 'registry.azurecr.io/api@' + DIGEST;
const EXPECT = { webBaseSha: '{webPin}', 'migration.state': 'ok' };
const TARGET = { type: 'containerapp', app: 'api', subscription: '12345678-1234-1234-1234-123456789abc', resourceGroup: 'rg',
  image: 'api', registry: 'registry', loginServer: 'registry.azurecr.io', container: 'api',
  agentAllowed: true, build: { dockerfile: 'Dockerfile', buildArgs: { WEB_BASE_SHA: SHA } },
  health: { url: 'https://live.invalid/health', shaField: 'nested.sha', expect: EXPECT, timeoutSeconds: 15 },
  settings: { generationEnv: GEN, revocationEnv: REV_GEN, authorityVolume: DECL,
    env: [{ name: GEN, format: 'generation' }, { name: REV_GEN, format: 'generation' },
      { name: 'WEB', format: 'webPin' }, { name: 'FLAVOR', equals: SENTINEL }],
    envRefs: [{ name: 'ApiToken', aliasPattern: '^ref-[a-z]+$' }] } };
const trafficWithIdle = (serving, ...idle) => [...plannedTraffic(serving),
  ...idle.map(revisionName => ({ revisionName, label: null, latestRevision: false, weight: 0 }))];
const HOOK_FLAGS = ['--run', 'hook-test', '--ledger', '/ledger', '--key', 'work'];
const INPUT_FLAGS = ['--revision-input', '/input', '--authority-receipt', '/receipt'];
const RECEIPT = Buffer.from(JSON.stringify({ generation: '2' }));

function fixture({ withBuild = true, run = runX4 } = {}) {
  const target = structuredClone(TARGET);
  const input = { schema: 1, sourceSha: SHA, image: { digest: DIGEST }, revisionSuffix: 'raaaaaaaa-g2',
    env: [{ name: GEN, value: '2' }, { name: REV_GEN, value: '2' }, { name: 'WEB', value: SHA },
      { name: 'FLAVOR', value: SENTINEL }],
    envRefs: [{ name: 'ApiToken', appRef: 'ref-one' }],
    secretVolume: { name: DECL.name, alias: 'authority-g2', identity: DECL.identity,
      kvVersionedUri: 'https://test.vault.azure.net/secrets/item/' + 'e'.repeat(32),
      path: DECL.path, mountPath: DECL.mountPath },
    authorityReceiptSha256: sha256Hex(RECEIPT), expiresAtUtc: '2030-01-02T00:00:00Z' };
  const oldVolumes = [{ name: 'other', storageType: 'EmptyDir', storageName: null }, {
    name: DECL.name, storageType: 'Secret', secrets: [{ secretRef: 'authority-g1', path: DECL.path }],
  }];
  const oldEnv = [{ name: 'BeforeToken', secretRef: 'kept-ref' }, { name: 'Existing', value: SENTINEL }];
  const revision = { active: true, env: oldEnv, image: IMAGE, prov: 'Provisioned', fqdn: 'old.invalid', mounts: MOUNTS, volumes: oldVolumes };
  const journal = withBuild ? [{ op: 'op-000000000000', step: 'built', sha: SHA, digest: DIGEST }] : [];
  const calls = [], writes = [], sleeps = [];
  const state = { traffic: plannedTraffic(OLD), latest: OLD, revisions: { [OLD]: revision },
    mounts: MOUNTS, volumes: oldVolumes, vault: [{ name: input.secretVolume.alias,
      keyVaultUrl: input.secretVolume.kvVersionedUri, identity: DECL.identity }, { name: 'ref-one' }],
    health: { 'old.invalid': OLD_SHA, 'candidate.invalid': SHA }, remainingPolls: 0, receipt: RECEIPT,
    candidateHealthFailures: 0, now: Date.parse('2030-01-01'), locked: false };
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  const deps = {
    shaOnDefault: sha => sha !== state.offDefaultSha,
    az(args) {
      azCalls.push([...args]);
      calls.push(args);
      if (args[0] === 'version') return JSON.stringify(state.version ?? { 'azure-cli': '2.91.0', extensions: { containerapp: '1.3.0b6' } });
      const query = value(args, '--query');
      if (state.unreadable) throw new Error(SENTINEL);
      if (query.endsWith('.image')) return state.sourceImage ?? IMAGE;
      let result;
      if (query.includes('activeRevisionsMode')) result = { mode: state.mode ?? 'Multiple', containers: ['api'] };
      else if (query.includes('properties.configuration.ingress')) result = state.traffic;
      else if (query.includes('latestRevisionName')) {
        result = { latest: state.latest };
        if (state.pendingIntermediate && --state.latestPolls === 0) {
          state.revisions[INTERMEDIATE] = state.pendingIntermediate;
          state.latest = INTERMEDIATE;
        }
      }
      else if (query.startsWith('properties.configuration.secrets')) result = state.vault;
      else if (query === 'properties.template.volumes') result = state.volumes;
      else if (query.includes('provisioningState')) {
        const name = value(args, '--revision');
        result = state.revisions[name];
        if (name === INTERMEDIATE && result && state.remainingPolls > 0) {
          state.remainingPolls--;
          result = { ...result, prov: 'Provisioning' };
        }
      } else if (query.includes('volumeMounts')) result = state.mounts;
      else if (query.includes('trafficWeight')) result = Object.entries(state.revisions)
        .map(([name, data]) => ({ name, active: data.active, weight: state.traffic.find(x => x.revisionName === name)?.weight ?? 0 }));
      else assert.fail('unexpected Azure query');
      return JSON.stringify(result);
    },
    azWrite(args) {
      azCalls.push([...args]);
      const id = args[0] === 'rest' ? 'volume-patch' : args[1] === 'update' ? 'update' :
        args[1] === 'ingress' ? 'traffic' : 'deactivate';
      assert.equal(journal.at(-1).step, 'intent');
      assert.equal(journal.at(-1).write, id);
      assert.equal(state.locked, true);
      assert.equal(value(args, '-o'), 'none');
      assert.ok(!args.some(arg => ['--replace-env-vars', '--remove-env-vars', '--remove-all-env-vars', '--yaml',
        'secret', '--show-values'].includes(arg)));
      writes.push(id);
      if (state.failWrite === id) throw Object.assign(new Error(SENTINEL), { processStarted: state.processStarted });
      if (id === 'volume-patch') {
        assert.equal(value(args, '--body'), '@/private-fixture/patch.json');
        const body = JSON.parse(state.bodyFile);
        assert.deepEqual(Object.keys(body), ['properties']);
        assert.deepEqual(Object.keys(body.properties), ['template']);
        assert.deepEqual(Object.keys(body.properties.template).sort(), ['revisionSuffix', 'volumes']);
        for (const volume of body.properties.template.volumes) {
          assert.ok(Object.keys(volume).every(key => ['name', 'storageType', 'storageName', 'mountOptions', 'secrets'].includes(key)));
          for (const item of volume.secrets ?? []) assert.deepEqual(Object.keys(item).sort(), ['path', 'secretRef']);
        }
        assert.deepEqual(body.properties.template.volumes.find(v => v.name === 'other'),
          { name: 'other', storageType: 'EmptyDir' });
        state.volumes = body.properties.template.volumes;
        const intermediateName = target.app + '--' + body.properties.template.revisionSuffix;
        const intermediate = { ...structuredClone(state.revisions[state.latest]), volumes: state.volumes, prov: state.intermediateProv ?? 'Provisioned' };
        if (state.latestPolls) state.pendingIntermediate = intermediate;
        else {
          state.revisions[intermediateName] = intermediate;
          state.latest = state.race ? 'api--competing' : intermediateName;
        }
      } else if (id === 'update') {
        assert.equal(value(args, '--image'), state.sourceImage ?? IMAGE);
        const declared = new Set([...input.env, ...input.envRefs].map(item => item.name));
        const env = [...oldEnv.filter(item => !declared.has(item.name)), ...input.env,
          ...input.envRefs.map(({ name, appRef }) => ({ name, secretRef: appRef }))];
        if (state.retainPlainRef) env.find(item => item.name === 'FLAVOR').secretRef = 'kept-ref';
        const candidate = target.app + '--' + value(args, '--revision-suffix');
        state.revisions[candidate] = { ...structuredClone(revision), fqdn: 'candidate.invalid', image: value(args, '--image'),
          prov: state.candidateProv ?? 'Provisioned',
          env: env.filter(item => !(state.dropRef && item.name === 'BeforeToken')), volumes: state.volumes };
        state.latest = candidate;
        return JSON.stringify({ env: [{ value: SENTINEL }] });
      } else if (id === 'traffic') {
        const destination = value(args, '--revision-weight').split('=')[0];
        state.traffic = state.trafficAfter ?? [...plannedTraffic(destination),
          ...state.traffic.filter(item => item.revisionName !== destination).map(item => ({ ...item, weight: 0 }))];
      } else {
        const name = value(args, '--revision');
        if (name === INTERMEDIATE && journal.at(-1).action === 'stage')
          assert.ok(journal.some(item => item.step === 'verified' || item.action === 'recover'));
        state.revisions[name].active = false;
      }
    },
    azBuild(args) {
      azCalls.push([...args]);
      assert.equal(journal.at(-1).write, 'acr-build');
      assert.equal(journal.at(-1).step, 'intent');
      assert.deepEqual(args.slice(0, 2), ['acr', 'build']);
      assert.equal(value(args, '--image'), 'api:' + SHA);
      writes.push('acr-build');
      return JSON.stringify({ runId: 'build1', status: state.failBuildParse ? SENTINEL : 'Succeeded', discarded: SENTINEL,
        outputImages: [{ registry: target.loginServer, repository: target.image, tag: SHA, digest: DIGEST }] });
    },
    fetchHealth(url) {
      let host = new URL(url).hostname;
      if (host === 'source.invalid') return { status: 200, body: { nested: { sha: state.sourceSha ?? SHA } } };
      if (host === 'live.invalid') {
        const serving = state.traffic.find(item => item.weight > 0);
        host = state.revisions[serving?.revisionName]?.fqdn;
      }
      if (host === 'candidate.invalid' && state.candidateHealthFailures > 0) {
        state.candidateHealthFailures--;
        return { status: 503, body: {} };
      }
      const sha = state.health[host];
      return { status: sha ? 200 : 503, body: { nested: { sha }, webBaseSha: SHA, migration: { state: 'ok' }, discarded: SENTINEL } };
    },
    now: () => state.now,
    sleep(ms) { sleeps.push(ms); state.now += ms; },
    lock: {
      acquire() { assert.equal(state.locked, false); if (state.lockHeld) return false; state.locked = true; },
      release() { assert.equal(state.locked, true); state.locked = false; },
    },
    journal: {
      entries: () => structuredClone(journal),
      append(entry) {
        if (state.failAppend === entry.step) throw new Error(SENTINEL);
        journal.push(structuredClone(entry));
      },
    },
    readFile: path => path === '/input' ? Buffer.from(JSON.stringify(input)) : state.receipt,
    writeBodyFile(body) { state.bodyFile = JSON.stringify(body); return '/private-fixture/patch.json'; },
    isTTY: false, env: {}, confirm: () => {},
  };
  return { target, input, journal, calls, writes, sleeps, state, deps,
    run: (...argv) => run({ argv, targetName: 'qa', target, deps, cfg: { targets: { ...state.aliases, test: { ...TARGET, loginServer: state.sourceRegistry ?? TARGET.loginServer, health: { ...TARGET.health, url: 'https://source.invalid/health' } } } },
      history: () => state.promotion ?? [] }) };
}

const stage = (f, ...args) => f.run('--action', 'stage', ...INPUT_FLAGS, ...args);
const action = (f, kind, op, ...args) => f.run('--action', kind, '--op', op, ...args);
const status = (f, op) => f.run('--status', op);
const recover = (f, op, report, ...args) => action(f, 'recover', op, '--authorize', report.phrase, ...args);
const safe = value => assert.doesNotMatch(JSON.stringify(value), new RegExp(SENTINEL));

test('stage redacts plain values, hashes the full input, and writes PATCH, update, verified, then deactivate', async () => {
  const f = fixture();
  const dry = await stage(f, '--dry-run');
  assert.equal(dry.dryRun, true);
  safe(dry);
  assert.equal(f.journal.length, 1);
  assert.deepEqual(f.writes, []);
  const { inputSha256, ...plan } = dry.plan;
  assert.match(inputSha256, /^[a-f0-9]{64}$/);
  assert.ok(plan.args.input.env.every(item => Object.keys(item).sort().join() === 'name,valueSha256'));
  const env = [...f.input.env].sort((a, b) => a.name < b.name ? -1 : 1);
  assert.equal(actionP64({ ...plan, args: { ...plan.args, input: { ...f.input, env } } }), dry.p64);
  const result = await stage(f);
  assert.equal(result.p64, dry.p64);
  assert.deepEqual(f.writes, ['volume-patch', 'update', 'deactivate']);
  assert.deepEqual(f.journal.slice(1).map(entry => entry.step),
    ['intent', 'intermediate', 'intent', 'revision-created', 'verified', 'intent', 'deactivated']);
  for (const entry of f.journal.filter(item => item.step === 'intent'))
    assert.equal(entry.redactedArgsSha256, sha256Hex(canonicalJson(entry.args)));
  assert.deepEqual(f.calls.filter(args => args[0] === 'version'), [['version', '-o', 'json']]);
  safe(f.journal);
  safe(result);
  assert.equal((await status(f, result.opId)).state, 'staged');
});

test('stage refuses dropped prior secretRef before verification and leaves traffic unchanged', async () => {
  const f = fixture();
  f.state.dropRef = true;
  await assert.rejects(stage(f), error => /REVISION_SETTINGS_MISMATCH/.test(error.message) && !error.message.includes(SENTINEL));
  assert.deepEqual(f.writes, ['volume-patch', 'update']);
  assert.ok(!f.journal.some(entry => entry.step === 'verified'));
  const op = f.journal.at(-1).op;
  const report = await status(f, op);
  assert.equal(report.state, 'staged-unverified');
  await assert.rejects(recover(f, op, report), /REVISION_SETTINGS_MISMATCH/);
  assert.deepEqual(f.writes, ['volume-patch', 'update']);
});

test('withdraw retires both revisions after stage fails settings verification', async () => {
  const f = fixture();
  f.state.dropRef = true;
  await assert.rejects(stage(f), /REVISION_SETTINGS_MISMATCH/);
  await action(f, 'withdraw', f.journal.at(-1).op);
  assert.equal(f.state.revisions[CANDIDATE].active, false);
  assert.equal(f.state.revisions[INTERMEDIATE].active, false);
  assert.deepEqual(f.state.traffic, plannedTraffic(OLD));
});

test('withdraw retires a journal-owned intermediate when stage never created the candidate', async () => {
  const f = fixture();
  f.state.intermediateProv = 'Failed';
  f.state.failWrite = 'update';
  await assert.rejects(stage(f), /REVISION_UPDATE_FAILED/);
  f.state.failWrite = undefined;
  await action(f, 'withdraw', f.journal.at(-1).op);
  assert.equal(f.state.revisions[CANDIDATE], undefined);
  assert.equal(f.state.revisions[INTERMEDIATE].active, false);
  assert.deepEqual(f.writes, ['volume-patch', 'update', 'deactivate']);
});

test('stage preflight gates prevent all writes', async () => {
  const cases = [
    ['VOLUME_MOUNT_NOT_PROVISIONED', f => { f.state.mounts = []; }],
    ['ALIAS_NOT_PROVISIONED', f => { f.state.vault[0].keyVaultUrl += 'x'; }],
    ['ENV_NAME_CASE_COLLISION', f => { f.state.revisions[OLD].env.push({ name: 'flavor' }); }],
    ['ENV_VALUE_RESERVED', f => { f.input.env.find(item => item.name === 'FLAVOR').value = 'a SeCrEtReF:alias'; }],
    ['DIGEST_PROVENANCE_UNPROVEN', f => { f.journal.length = 0; }],
  ];
  for (const [code, mutate] of cases) {
    const f = fixture();
    mutate(f);
    await assert.rejects(stage(f), new RegExp(code));
    assert.deepEqual(f.writes, [], code);
    if (code === 'ENV_VALUE_RESERVED') assert.deepEqual(f.calls, []);
  }
});

test('authorization is bound to full state and respects TTY policy', async () => {
  const f = fixture();
  f.target.agentAllowed = 'with-authorization';
  const dry = await stage(f, '--dry-run');
  await assert.rejects(stage(f, '--authorize', dry.phrase.replace(':stage:', ':build:')), /AUTHORIZATION_REQUIRED/);
  f.state.traffic.push({ revisionName: 'api--idle', weight: 0 });
  const changed = await stage(f, '--dry-run');
  assert.notEqual(changed.p64, dry.p64);
  await assert.rejects(stage(f, '--authorize', dry.phrase), new RegExp(changed.phrase));
  assert.deepEqual(f.writes, []);
  f.target.agentAllowed = false;
  const person = await stage(f, '--dry-run');
  await assert.rejects(stage(f, '--authorize', person.phrase), /INTERACTIVE_REQUIRED/);
  f.deps.isTTY = true;
  await stage(f, '--authorize', person.phrase);
  assert.equal(f.state.locked, false);
});

test('PATCH waits for Provisioned and stops at a competing latest revision', async () => {
  const f = fixture();
  f.state.remainingPolls = 2;
  await stage(f);
  assert.deepEqual(f.sleeps, [5000, 5000]);
  const race = fixture();
  race.state.race = true;
  await assert.rejects(stage(race), /TEMPLATE_RACE/);
  assert.deepEqual(race.writes, ['volume-patch']);
  assert.deepEqual(race.sleeps, []);
  assert.equal((await status(race, race.journal.at(-1).op)).state, 'drift');
  const timeout = fixture();
  timeout.state.remainingPolls = 121;
  await assert.rejects(stage(timeout), /VOLUME_PATCH_TIMEOUT/);
  assert.deepEqual(timeout.sleeps, Array(120).fill(5000));
  assert.deepEqual(timeout.writes, ['volume-patch']);
});

test('a Failed intermediate carries the template and is deactivated after stage', async () => {
  const f = fixture();
  f.state.intermediateProv = 'Failed';
  await stage(f);
  assert.deepEqual(f.sleeps, []);
  assert.deepEqual(f.writes, ['volume-patch', 'update', 'deactivate']);
  assert.equal(f.state.revisions[INTERMEDIATE].active, false);
});

test('PATCH never accepts Succeeded as a terminal intermediate state', async () => {
  const f = fixture();
  f.state.intermediateProv = 'Succeeded';
  await assert.rejects(stage(f), /VOLUME_PATCH_TIMEOUT/);
  assert.deepEqual(f.sleeps, Array(120).fill(5000));
  assert.deepEqual(f.writes, ['volume-patch']);
});

test('candidate provisioning failure refuses stage immediately', async () => {
  const f = fixture();
  f.state.candidateProv = 'Failed';
  await assert.rejects(stage(f), /REVISION_PROVISIONING_FAILED/);
  assert.deepEqual(f.sleeps, []);
  assert.ok(!f.journal.some(entry => entry.step === 'verified'));
});

test('renew requires serving verified image, higher generation and closed WEB interlock', async () => {
  const renew = f => f.run('--action', 'renew-authority', ...INPUT_FLAGS);
  const prepared = () => {
    const f = fixture({ withBuild: false });
    f.state.health['old.invalid'] = SHA;
    f.journal.push({ step: 'verified', revision: OLD, sha: SHA, digest: DIGEST, imageRef: IMAGE, generation: '1', verified: true });
    return f;
  };
  const good = prepared();
  await renew(good);
  assert.deepEqual(good.writes, ['volume-patch', 'update', 'deactivate']);
  assert.equal(good.journal.findLast(item => item.step === 'verified').digest, DIGEST);
  for (const [code, mutate] of [
    ['WEB_INTERLOCK_OPEN', f => { f.input.env.find(item => item.name === REV_GEN).value = '1'; }],
    ['GENERATION_NOT_HIGHER', f => { f.journal.at(-1).generation = '2'; }],
    ['DIGEST_PROVENANCE_UNPROVEN', f => { f.state.revisions[OLD].image = 'registry.azurecr.io/api@' + OTHER_DIGEST; }],
  ]) {
    const f = prepared();
    mutate(f);
    await assert.rejects(renew(f), new RegExp(code));
    assert.deepEqual(f.writes, []);
  }
});

test('ACR run output stays in memory and only an exact digest receipt proves provenance', async () => {
  const f = fixture({ withBuild: false });
  await f.run('--action', 'build', '--sha', SHA);
  assert.deepEqual(f.writes, ['acr-build']);
  assert.equal(f.journal.at(-1).step, 'built');
  assert.equal(f.journal.at(-1).digest, DIGEST);
  safe(f.journal);
  await stage(f);
  const failed = fixture({ withBuild: false });
  failed.state.failBuildParse = true;
  await assert.rejects(failed.run('--action', 'build', '--sha', SHA), /^Error: ACR_RUN_UNREADABLE$/);
  safe(failed.journal);
  assert.equal(failed.journal.at(-1).failure, 'ACR_RUN_UNREADABLE');

  const promoted = fixture({ withBuild: false });
  promoted.target.promoteFrom = 'test';
  promoted.state.sourceRegistry = 'source.azurecr.io';
  promoted.state.sourceImage = 'source.azurecr.io/api@' + DIGEST;
  promoted.state.promotion = [{ verified: true, sha: SHA, digest: DIGEST, image: promoted.state.sourceImage, revision: OLD }];
  const dry = await stage(promoted, '--dry-run');
  assert.equal(dry.plan.args.imageRef, promoted.state.sourceImage);
  const result = await stage(promoted);
  assert.equal(result.p64, dry.p64);
  assert.equal(promoted.state.revisions[CANDIDATE].image, promoted.state.sourceImage);
  assert.ok(!promoted.writes.includes('acr-build'));
});

test('intent journal failure prevents write and failed write is reconciled from live evidence', async () => {
  const before = fixture();
  before.state.failAppend = 'intent';
  await assert.rejects(stage(before), /JOURNAL_APPEND_FAILED/);
  assert.deepEqual(before.writes, []);
  assert.equal(before.state.locked, false);
  before.state.lockHeld = true;
  const reads = before.calls.length;
  await assert.rejects(stage(before), /APP_WRITE_LOCKED/);
  assert.equal(before.calls.length, reads);

  const failed = fixture();
  failed.state.failWrite = 'volume-patch';
  await assert.rejects(stage(failed), /^Error: VOLUME_PATCH_FAILED$/);
  assert.equal(failed.journal.at(-1).step, 'failed');
  assert.equal((await status(failed, failed.journal.at(-1).op)).state, 'drift');
  safe(failed.journal);
});

test('lost PATCH result requires recovery input and binds a stable observation and phrase', async () => {
  const f = fixture();
  f.state.failAppend = 'intermediate';
  await assert.rejects(stage(f), /JOURNAL_APPEND_FAILED/);
  const op = f.journal.at(-1).op;
  const report = await status(f, op);
  assert.equal(report.state, 'intermediate-only');
  assert.equal(report.nextStep, 'finish-stage');
  assert.equal(report.needsInput, true);
  assert.deepEqual(await status(f, op), report);
  const dry = await action(f, 'recover', op, '--dry-run');
  assert.equal(dry.p64, report.p64);
  assert.match(dry.plan.args.observedSha256, /^[a-f0-9]{64}$/);
  assert.equal(dry.plan.args.state, report.state);
  await assert.rejects(action(f, 'recover', op, ...INPUT_FLAGS), /AUTHORIZATION_REQUIRED/);
  await assert.rejects(recover(f, op, report), /RECOVER_INPUT_MISMATCH/);
  f.state.receipt = Buffer.from('wrong');
  await assert.rejects(recover(f, op, report, ...INPUT_FLAGS), /RECOVER_INPUT_MISMATCH/);
  f.state.receipt = RECEIPT;
  f.input.expiresAtUtc = '2030-01-03T00:00:00Z';
  await assert.rejects(recover(f, op, report, ...INPUT_FLAGS), /RECOVER_INPUT_MISMATCH/);
  f.input.expiresAtUtc = '2030-01-02T00:00:00Z';
  f.state.revisions['api--extra'] = { ...f.state.revisions[OLD], active: true };
  await assert.rejects(recover(f, op, report, ...INPUT_FLAGS), /AUTHORIZATION_REQUIRED/);
  delete f.state.revisions['api--extra'];
  assert.deepEqual(f.writes, ['volume-patch']);
  await recover(f, op, report, ...INPUT_FLAGS);
  assert.deepEqual(f.writes, ['volume-patch', 'update', 'deactivate']);
  assert.equal((await status(f, op)).state, 'staged');
  await assert.rejects(recover(f, op, report, ...INPUT_FLAGS), /NOTHING_TO_RECOVER/);
  safe(f.journal);
});

test('failed recover update follows original stage intent and repeats full reverification', async () => {
  const f = fixture();
  f.state.failAppend = 'intermediate';
  await assert.rejects(stage(f), /JOURNAL_APPEND_FAILED/);
  const op = f.journal.at(-1).op;
  f.state.failAppend = undefined;
  f.state.failWrite = 'update';
  await assert.rejects(recover(f, op, await status(f, op), ...INPUT_FLAGS), /REVISION_UPDATE_FAILED/);
  assert.equal((await status(f, op)).nextStep, 'finish-stage');
  f.state.failWrite = undefined;
  f.state.failAppend = 'revision-created';
  f.state.dropRef = true;
  await assert.rejects(recover(f, op, await status(f, op), ...INPUT_FLAGS), /JOURNAL_APPEND_FAILED/);
  const report = await status(f, op);
  assert.equal(report.nextStep, 'reverify-stage');
  await assert.rejects(recover(f, op, report), /REVISION_SETTINGS_MISMATCH/);
  assert.ok(!f.journal.some(item => item.step === 'verified'));
  f.state.revisions[CANDIDATE].env.push({ name: 'BeforeToken', secretRef: 'kept-ref' });
  f.state.failAppend = undefined;
  await recover(f, op, await status(f, op));
  assert.equal((await status(f, op)).state, 'staged');
});

test('verified stage with failed intermediate deactivation can be recovered once', async () => {
  const f = fixture();
  f.state.intermediateProv = 'Failed';
  f.state.failWrite = 'deactivate';
  await assert.rejects(stage(f), /DEACTIVATE_FAILED/);
  const op = f.journal.at(-1).op;
  assert.equal((await status(f, op)).state, 'intermediate-left');
  await assert.rejects(recover(f, op, await status(f, op)), /DEACTIVATE_FAILED/);
  assert.equal((await status(f, op)).nextStep, 'deactivate-intermediate');
  f.state.failWrite = undefined;
  await recover(f, op, await status(f, op));
  assert.equal((await status(f, op)).state, 'staged');
});

test('switch verifies complete map even when live SHA was already identical', async () => {
  const switched = fixture();
  const { opId } = await stage(switched);
  const result = await action(switched, 'switch', opId, '--run', 'test-run', '--ledger', '/ledger', '--key', 'example');
  assert.equal(result.switched, true);
  assert.equal(result.percent, 100);
  assert.equal(result.revision, CANDIDATE);
  assert.equal(result.sha, SHA);
  assert.equal((await status(switched, opId)).state, 'switched');
  assert.deepEqual(switched.state.traffic, trafficWithIdle(CANDIDATE, OLD));

  for (const [map, expectedState] of [
    [plannedTraffic(OLD), 'switch-not-applied'],
    [[...plannedTraffic(CANDIDATE), { revisionName: 'unknown', weight: 0 }], 'drift'],
    [[...plannedTraffic(CANDIDATE), { revisionName: OLD, weight: 0, label: 'old' }], 'drift'],
  ]) {
    const f = fixture();
    f.state.health['old.invalid'] = SHA;
    const { opId: op } = await stage(f);
    f.state.trafficAfter = map;
    await assert.rejects(action(f, 'switch', op), /TRAFFIC_NOT_AS_PLANNED/);
    assert.equal(f.journal.at(-1).failure, 'TRAFFIC_NOT_AS_PLANNED');
    assert.equal((await status(f, op)).state, expectedState);
    assert.equal(f.writes.filter(write => write === 'traffic').length, 1);
  }
});

test('lost switch and rollback results are recorded without touching traffic again', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  f.state.failAppend = 'switched';
  await assert.rejects(action(f, 'switch', opId), /JOURNAL_APPEND_FAILED/);
  let report = await status(f, opId);
  assert.equal(report.state, 'switch-applied-unrecorded');
  const recovered = await recover(f, opId, report, ...HOOK_FLAGS);
  assert.deepEqual([recovered.switched, recovered.percent, recovered.revision, recovered.sha], [true, 100, CANDIDATE, SHA]);
  assert.equal((await status(f, opId)).state, 'switched');
  f.target.health.timeoutSeconds++;
  f.state.failAppend = 'rolled-back';
  await assert.rejects(action(f, 'rollback', opId, '--to-revision', OLD), /JOURNAL_APPEND_FAILED/);
  const intent = f.journal.at(-1);
  f.target.health.timeoutSeconds++;
  report = await status(f, opId);
  assert.equal(report.state, 'rollback-applied-unrecorded');
  assert.equal(report.plan.args.stagePolicySha256, intent.args.stagePolicySha256);
  assert.notEqual(report.plan.target.policySha256, intent.target.policySha256);
  const rollback = await recover(f, opId, report, ...HOOK_FLAGS);
  assert.equal(rollback.rolledBack, true);
  assert.deepEqual(rollback.plan, { sha: OLD_SHA, revision: OLD });
  assert.equal((await status(f, opId)).state, 'rolled-back');
  assert.equal(f.writes.filter(write => write === 'traffic').length, 2);
});

test('rollback rejects a majority map and does not automatically restore traffic', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  await action(f, 'switch', opId);
  f.state.trafficAfter = [{ revisionName: OLD, weight: 80 }, { revisionName: CANDIDATE, weight: 20 }];
  await assert.rejects(action(f, 'rollback', opId, '--to-revision', OLD), /TRAFFIC_NOT_AS_PLANNED/);
  assert.deepEqual(f.state.traffic, f.state.trafficAfter);
  assert.equal(f.writes.filter(write => write === 'traffic').length, 2);
});

test('cleanup depth and recovery use the cleanup plan, preserving the recorded switch', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  await action(f, 'switch', opId);
  await assert.rejects(action(f, 'cleanup', opId, '--retire-revision', CANDIDATE), /REVISION_NOT_IDLE/);
  f.state.failWrite = 'deactivate';
  await assert.rejects(action(f, 'cleanup', opId, '--retire-revision', OLD), /DEACTIVATE_FAILED/);
  assert.equal((await status(f, opId)).state, 'deactivate-pending');
  await assert.rejects(recover(f, opId, await status(f, opId)), /DEACTIVATE_FAILED/);
  assert.equal((await status(f, opId)).nextStep, 'retry-deactivate');
  f.state.failWrite = undefined;
  f.state.failAppend = 'recovered';
  await assert.rejects(recover(f, opId, await status(f, opId)), /JOURNAL_APPEND_FAILED/);
  const report = await status(f, opId);
  assert.equal(report.state, 'deactivate-done-unrecorded');
  f.state.failAppend = undefined;
  await recover(f, opId, report);
  assert.equal((await status(f, opId)).state, 'cleaned');
  assert.equal(f.journal.filter(item => item.step === 'switched').length, 1);
});

test('withdraw deactivates staged candidate and active intermediate with no traffic writes', async () => {
  const f = fixture();
  f.state.failWrite = 'deactivate';
  await assert.rejects(stage(f), /DEACTIVATE_FAILED/);
  const op = f.journal.at(-1).op;
  f.target.health.timeoutSeconds++;
  await assert.rejects(action(f, 'withdraw', op), /DEACTIVATE_FAILED/);
  f.state.failWrite = undefined;
  f.target.health.timeoutSeconds++;
  const pending = await status(f, op);
  assert.equal(pending.nextStep, 'retry-deactivate');
  await recover(f, op, pending);
  await action(f, 'withdraw', op);
  const report = await status(f, op);
  assert.equal(report.state, 'withdrawn');
  assert.equal(report.templateNotServing, true);
  assert.equal(f.state.revisions[CANDIDATE].active, false);
  assert.equal(f.state.revisions[INTERMEDIATE].active, false);
  assert.ok(!f.writes.includes('traffic'));
});

test('status reports drift when metadata is unreadable or traffic has a label', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  f.state.unreadable = true;
  assert.equal((await status(f, opId)).state, 'drift');
  f.state.unreadable = false;
  f.state.traffic[0].label = 'labeled';
  assert.equal((await status(f, opId)).state, 'drift');
});

test('the removed TEST fence flag refuses before reading input or metadata', async () => {
  const f = fixture();
  f.deps.readFile = () => assert.fail('read before flag refusal');
  await assert.rejects(stage(f, '--test-fence-receipt', '/fence'), /TEST_FENCE_UNSUPPORTED/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(main(['--test-fence-receipt']), /^Error: TEST_FENCE_UNSUPPORTED$/);
});

test('stage requires a serving baseline', async () => {
  const f = fixture();
  f.state.traffic = [];
  await assert.rejects(stage(f), /TRAFFIC_NOT_PINNED/);
  assert.deepEqual(f.writes, []);
});

function fakeAz(dir) {
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'az'), `#!/bin/sh
printf '%s\\000' "$#" "$@" >> "$X4_FAKE_LOG"
case "$*" in
  *"ingress.traffic"*) echo '[{"revisionName":"api--old","weight":100}]';;
  "version --query syntheticBuildQuery"|"account show") exit 0;;
  *"revision list"*) echo '[{"name":"api--old","active":true,"weight":100}]';;
  *) exit 88;;
esac
`);
  chmodSync(join(dir, 'az'), 0o755);
  function calls() {
    if (!existsSync(log)) return [];
    const fields = readFileSync(log, 'utf8').split('\0');
    const invocations = [];
    for (let i = 0; i < fields.length - 1;) {
      const count = Number(fields[i++]);
      invocations.push(fields.slice(i, i + count));
      i += count;
    }
    return invocations;
  }
  return { dir, log, calls };
}

async function withFake(t, fn, { unknownDefault = false, staleDefault = false, unreadableConfig = false, failedGitRead, trackX4 = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x4-cli-'));
  const az = fakeAz(dir);
  const cfg = { schema: 1, targets: { qa: TARGET, legacy: {
    ...Object.fromEntries(Object.entries(TARGET).filter(([key]) => key !== 'settings')), app: 'legacy-api',
  } } };
  const cfgPath = join(dir, 'deploy.json');
  writeFileSync(cfgPath, JSON.stringify(cfg));
  // Stub read-only Git plumbing to keep this suite local without committing a fixture.
  writeFileSync(join(dir, 'git'), `#!/bin/sh
if test "$3" = '${failedGitRead ?? ''}'; then echo 'fake git diagnostic' >&2; exit 1; fi
case "$3" in
  symbolic-ref) ${unknownDefault ? "exit 1" : "echo origin/main"};;
  ls-remote) printf '%s\n' '${SHA} refs/heads/main' '${SHA} refs/heads/alternate';;
  for-each-ref) printf '%s\n' '${staleDefault ? OLD_SHA : SHA} refs/remotes/origin/main' '${SHA} refs/remotes/origin/alternate';;
  merge-base) test "$4" = --is-ancestor && test "$5" != '${OLD_SHA}' && test "$6" = refs/remotes/origin/main;;
  branch) echo origin/main;;
  worktree) mkdir -p "$6"; echo "$6" > "$X4_FAKE_CONFIG.worktree";;
  rev-parse) echo '${SHA}';;
  ls-tree) if test "$6" = refs/remotes/origin/main && test -f "$X4_FAKE_CONFIG"; then echo .trioharness/deploy.json; fi;;
  show) test "$4" = refs/remotes/origin/main:.trioharness/deploy.json && test -f "$X4_FAKE_CONFIG" || exit 128
        ${unreadableConfig ? "exit 128" : 'cat "$X4_FAKE_CONFIG"'};;
  *) exit 89;;
esac
`, { mode: 0o755 });
  const env = { PATH: `${az.dir}:${process.env.PATH}`, HOME: dir, USERPROFILE: dir,
    X4_FAKE_LOG: az.log, X4_FAKE_CONFIG: cfgPath };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, TARGET.health.url);
    return new Response(JSON.stringify({ nested: { sha: OLD_SHA } }), { status: 200 });
  });
  try { await fn({ dir, az, cfg }); }
  finally {
    if (trackX4) azCalls.push(...az.calls());
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('main runs a default-branch webapp build step with a config-defined Azure query', async t => {
  await withFake(t, async ({ dir, az, cfg }) => {
    const args = ['version', '--query', 'syntheticBuildQuery'];
    cfg.targets.web = { type: 'webapp', app: 'web', subscription: TARGET.subscription, resourceGroup: 'rg',
      health: TARGET.health, agentAllowed: true, outputDir: 'missing-output', build: [{ command: 'az', args }] };
    writeFileSync(join(dir, 'deploy.json'), JSON.stringify(cfg));
    const marker = join(dir, 'deploy.json.worktree');
    try {
      await assert.rejects(main(['--repo', dir, '--target', 'web', '--sha', SHA]), /BUILD_OUTPUT_MISSING/);
      assert.deepEqual(az.calls(), [args]);
    } finally {
      if (existsSync(marker)) rmSync(dirname(readFileSync(marker, 'utf8').trim()), { recursive: true, force: true });
    }
  }, { trackX4: false });
});

test('main runs a worktree webapp build step without a reviewed Azure query', async t => {
  await withFake(t, async ({ dir, az, cfg }) => {
    const args = ['account', 'show'];
    cfg.targets.web = { type: 'webapp', app: 'web', subscription: TARGET.subscription, resourceGroup: 'rg',
      health: TARGET.health, agentAllowed: true, outputDir: 'missing-output', build: [{ command: 'az', args }] };
    mkdirSync(join(dir, '.trioharness'));
    writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify(cfg));
    const marker = join(dir, 'deploy.json.worktree');
    const markers = Object.fromEntries(DEFAULT_AGENT_MARKERS.map(key => [key, process.env[key]]));
    try {
      for (const key of Object.keys(markers)) delete process.env[key];
      await assert.rejects(main(['--repo', dir, '--target', 'web', '--sha', SHA, '--config-from-worktree']),
        /BUILD_OUTPUT_MISSING/);
      assert.deepEqual(az.calls(), [args]);
    } finally {
      for (const [key, value] of Object.entries(markers)) {
        if (value !== undefined) process.env[key] = value;
      }
      if (existsSync(marker)) rmSync(dirname(readFileSync(marker, 'utf8').trim()), { recursive: true, force: true });
    }
  }, { trackX4: false });
});

test('legacy history scan follows symlinked stores for respelled targets', async t => {
  await withFake(t, async ({ dir, cfg }) => {
    const target = cfg.targets.qa;
    const store = appHistoryDir(target, dir);
    const history = deploy.loadAppHistory({ repo: dir, targetName: 'qa', target, cfg, home: dir });
    deploy.appendAppHistory(history, { op: 'op-000000000000', step: 'switched' });
    const backing = join(dir, 'linked-store');
    renameSync(store, backing);
    symlinkSync(backing, store, 'dir');
    const respelled = { ...target, subscription: 'Named Subscription' };
    assert.deepEqual(deploy.findRecordedX4History(respelled), { name: basename(store), reason: 'op' });
  });
});

test('main dispatches X4 from the default branch with only fake Azure reads', async t => {
  await withFake(t, async ({ dir, az }) => {
    const plan = await main(['--repo', dir, '--target', 'qa', '--action', 'build', '--sha', SHA, '--dry-run']);
    assert.equal(plan.plan.action, 'build');
    assert.equal(plan.plan.expected.servingSha, OLD_SHA);
    assert.ok(az.calls().every(args => /^(?:containerapp show|containerapp revision list)/.test(args.join(' '))));
    assert.equal(az.calls().length, 2);
  });
});

test('main passes issue-hook flags to X4 switch, rollback and recover', async t => {
  await withFake(t, async ({ dir }) => {
    for (const action of ['switch', 'rollback', 'recover']) {
      await assert.rejects(main(['--repo', dir, '--target', 'qa', '--action', action, '--op', 'op-000000000000',
        ...HOOK_FLAGS, '--dry-run']), /^Error: OP_NOT_FOUND$/);
    }
  });
});

test('main rejects worktree config, undeclared G7 and legacy writes to G7 before Azure', async t => {
  await withFake(t, async ({ dir, az }) => {
    await assert.rejects(main(['--repo', dir, '--target', 'qa', '--action', 'build', '--config-from-worktree']),
      /^Error: X4_DEFAULT_BRANCH_ONLY$/);
    await assert.rejects(main(['--repo', dir, '--target', 'legacy', '--status', 'op-000000000000']),
      /^Error: G7_NOT_DECLARED$/);
    await assert.rejects(main(['--repo', dir, '--target', 'qa', '--rollback']), /^Error: G7_USE_ACTION$/);
    await assert.rejects(main(['--repo', dir, '--target', 'qa', '--action', 'build', '--rollback']), /^Error: DEPLOY_MODE_CONFLICT$/);
    assert.deepEqual(az.calls(), []);
  });
});

test('legacy rollback dry-run refuses older X4 history', async t => {
  await withFake(t, async ({ dir, az, cfg }) => {
    const path = appHistoryDir(cfg.targets.legacy, dir);
    appendHistoryEntry(path, { sha: OLD_SHA, image: IMAGE, verified: true, revision: 'legacy-api--old' });
    appendHistoryEntry(path, { sha: SHA, image: IMAGE, verified: true, revision: 'legacy-api--new', previousRevision: 'legacy-api--old' });
    writeFileSync(join(path, 'identity.json'), JSON.stringify(deploy.appHistoryIdentity(cfg.targets.legacy)));
    const argv = ['--repo', dir, '--target', 'legacy', '--rollback', '--dry-run'];
    const clean = await main(argv);
    for (let i = 0; i < 12; i++) appendHistoryEntry(path, { op: 'op-000000000000', sha: SHA,
      image: IMAGE, revision: 'legacy-api--other', previousRevision: 'legacy-api--wrong', verified: true });
    appendHistoryEntry(path, { sha: SHA, image: IMAGE, verified: true, revision: 'legacy-api--latest', previousRevision: 'legacy-api--other' });
    await assert.rejects(main(argv), { message: `X4_HISTORY_PRESENT: ${basename(path)}` });
    assert.equal(clean.plan.revision, 'legacy-api--old');
    assert.deepEqual(az.calls(), []);
  });
});

test('legacy rollback and cleanup report their own corrupt history before scanning aliases', async t => {
  await withFake(t, async ({ dir, az, cfg }) => {
    const target = cfg.targets.legacy;
    target.revisionCleanup = { quietDays: 1 };
    writeFileSync(join(dir, 'deploy.json'), JSON.stringify(cfg));
    const store = appHistoryDir(target, dir);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'history.json'), '{');
    appendHistoryEntry(appHistoryDir({ ...target, slot: 'previous' }, dir), { op: 'op-000000000000' });

    const argv = ['--repo', dir, '--target', 'legacy', '--dry-run'];
    for (const flags of [[], ['--rollback']]) {
      await assert.rejects(main([...argv, ...flags]), SyntaxError);
    }
    assert.deepEqual(az.calls(), []);
  });
});

test('legacy rollback and X4 status refuse an unlistable history root', { skip: process.getuid?.() === 0 }, async t => {
  await withFake(t, async ({ dir, az, cfg }) => {
    const root = dirname(appHistoryDir(cfg.targets.legacy, dir));
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o000);
    try {
      const argv = ['--repo', dir, '--target', 'legacy'];
      for (const flags of [['--rollback', '--dry-run'], ['--status', 'op-000000000000']]) {
        await assert.rejects(main([...argv, ...flags]), { message: `X4_HISTORY_PRESENT: ${root} unreadable` });
      }
      assert.deepEqual(az.calls(), []);
    } finally {
      chmodSync(root, 0o700);
    }
  });
});

test('legacy rollback and cleanup find X4 history after de-opt and respelling', async t => {
  await withFake(t, async ({ dir, az, cfg }) => {
    const { settings, ...legacy } = cfg.targets.qa;
    const original = appHistoryDir(cfg.targets.qa, dir);
    const history = deploy.loadAppHistory({ repo: dir, targetName: 'qa', target: cfg.targets.qa, cfg, home: dir });
    assert.equal(existsSync(original), false);
    deploy.appendAppHistory(history, { op: 'op-000000000000', step: 'switched' });
    cfg.targets.qa = { ...legacy, subscription: 'Named Subscription', slot: 'new', revisionCleanup: { quietDays: 1 } };
    writeFileSync(join(dir, 'deploy.json'), JSON.stringify(cfg));

    const argv = ['--repo', dir, '--target', 'qa', '--dry-run'];
    await assert.rejects(main([...argv, '--rollback']), { message: `X4_HISTORY_PRESENT: ${basename(original)}` });
    await assert.rejects(main(argv), { message: `X4_HISTORY_PRESENT: ${basename(original)}` });
    const x4 = ['--repo', dir, '--target', 'qa'];
    const op = 'op-000000000000';
    for (const flags of [['--status', op], ['--action', 'rollback', '--op', op, '--to-revision', OLD],
      ['--action', 'withdraw', '--op', op], ['--action', 'recover', '--op', op]]) {
      await assert.rejects(main([...x4, ...flags]), /^Error: STAGE_POLICY_CHANGED$/);
    }
    assert.equal(existsSync(appHistoryDir(cfg.targets.qa, dir)), false);
    assert.deepEqual(az.calls(), []);
  });
});

for (const [label, identity, history, otherApp] of [
  ['missing identity', null, '[{}]'],
  ['invalid identity', '{', '{'],
  ['corrupt history', undefined, '{'],
  ['missing identity for another app', null, '[{"op":null}]', true],
]) {
  test(`legacy rollback checks X4 history in a store with ${label}`, async t => {
    await withFake(t, async ({ dir, az, cfg }) => {
      const target = cfg.targets.legacy;
      const previous = { ...target, subscription: 'Named Subscription',
        app: otherApp ? `${target.app}-other` : target.app };
      const store = appHistoryDir(previous, dir);
      mkdirSync(store, { recursive: true });
      if (identity !== null) writeFileSync(join(store, 'identity.json'),
        identity ?? JSON.stringify(deploy.appHistoryIdentity(previous)));
      writeFileSync(join(store, 'history.json'), history);
      const argv = ['--repo', dir, '--target', 'legacy', '--rollback', '--dry-run'];
      if (history === '[{}]') {
        await assert.rejects(main(argv), /NO_ROLLBACK_TARGET/);
        mkdirSync(join(store, 'history.d'));
        writeFileSync(join(store, 'history.d', '000001.json'), '[{"op":null}]');
      }
      await assert.rejects(main(argv), otherApp ? /NO_ROLLBACK_TARGET/ : { message: `X4_HISTORY_PRESENT: ${basename(store)}` });
      if (history === '{') {
        await assert.rejects(main(['--repo', dir, '--target', 'legacy', '--status', 'op-000000000000']),
          { message: `X4_HISTORY_PRESENT: ${basename(store)}` });
      }
      assert.deepEqual(az.calls(), []);
    });
  });
}

test('container app identity agrees across authorization, markers, opt-in and history', async t => {
  const cases = [
    ['subscription display name', { subscription: 'Named Subscription' }, true],
    ['case and whitespace', { type: 'CONTAINERAPP', resourceGroup: ` ${TARGET.resourceGroup.toUpperCase()} `,
      app: TARGET.app.toUpperCase() }, true],
    ['different resource group', { resourceGroup: 'other-group' }, false],
    ['different app', { app: 'other-app' }, false],
    ['webapp', { type: 'webapp' }, false],
    ['absent type', { type: undefined }, false],
    ['slot', { slot: 'x' }, true],
  ];
  for (const [name, change, same] of cases) {
    await t.test(name, async t => {
      const f = fixture();
      const marker = 'X4_IDENTITY_AGENT';
      f.target.agentAllowed = 'with-authorization';
      f.state.aliases = { owner: { ...f.target, ...change, agentAllowed: false, agentMarkers: [marker] } };
      f.deps.env[marker] = '1';
      await assert.rejects(stage(f), same ? /AGENT_NOT_ALLOWED/ : /AUTHORIZATION_REQUIRED/);
      assert.deepEqual(f.writes, []);

      await withFake(t, async ({ dir, az, cfg }) => {
        const { settings, ...legacy } = cfg.targets.qa;
        legacy.revisionCleanup = { quietDays: 1 };
        const alias = { ...legacy, ...change, agentMarkers: [marker] };
        // CLI config requires canonical type spelling.
        if (alias.type === 'CONTAINERAPP') alias.type = 'containerapp';
        if (!alias.type || alias.type === 'webapp') {
          alias.build = [{ command: 'node' }];
          alias.outputDir = 'dist';
          delete alias.revisionCleanup;
        }
        const defaultConfig = targets => writeFileSync(join(dir, 'deploy.json'), JSON.stringify({ ...cfg, targets }));
        mkdirSync(join(dir, '.trioharness'));
        writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify({ ...cfg, targets: { legacy } }));
        const argv = ['--repo', dir, '--target', 'legacy'];
        const worktree = [...argv, '--config-from-worktree'];
        const markers = Object.fromEntries([...DEFAULT_AGENT_MARKERS, marker].map(key => [key, process.env[key]]));
        try {
          for (const key of Object.keys(markers)) delete process.env[key];
          defaultConfig({ alias });
          process.env[marker] = '1';
          await assert.rejects(main([...worktree, '--rollback', '--dry-run']),
            same ? /^Error: CONFIG_FROM_WORKTREE_PERSON_ONLY:/ : /NO_ROLLBACK_TARGET/);
          delete process.env[marker];

          defaultConfig({ alias: alias.type === 'containerapp' ? { ...alias, subscription: TARGET.subscription, settings } : alias });
          await assert.rejects(main([...worktree, '--rollback']), same ? /^Error: G7_USE_ACTION$/ : /NO_ROLLBACK_TARGET/);

          const historyAlias = { ...alias, slot: alias.slot ?? 'history' };
          defaultConfig({ legacy, alias: historyAlias });
          const store = appHistoryDir(historyAlias, dir);
          appendHistoryEntry(store, { op: 'op-000000000000', step: 'switched' });
          writeFileSync(join(store, 'identity.json'), JSON.stringify(deploy.appHistoryIdentity(historyAlias)));
          for (const mode of [argv, worktree]) {
            await assert.rejects(main([...mode, '--rollback', '--dry-run']),
              same ? { message: `X4_HISTORY_PRESENT: ${basename(store)}` } : /NO_ROLLBACK_TARGET/);
            if (same) await assert.rejects(main([...mode, '--dry-run']), { message: `X4_HISTORY_PRESENT: ${basename(store)}` });
          }
        } finally {
          for (const [key, value] of Object.entries(markers)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
        assert.deepEqual(az.calls(), []);
      });
      assert.equal(deploy.sameContainerApp(f.target, f.state.aliases.owner), same);
    });
  }
});

test('no PATCH is needed when the provisioned Secret volume already maps the alias', async () => {
  const f = fixture();
  f.state.volumes[1].secrets[0].secretRef = f.input.secretVolume.alias;
  const preview = await stage(f, '--dry-run');
  assert.equal(preview.plan.args.intermediateRevision, null);
  assert.equal(preview.plan.args.volumePatchSha256, null);
  const { opId } = await stage(f);
  assert.deepEqual(f.writes, ['update']);
  assert.equal((await status(f, opId)).state, 'staged');
});

test('status recognizes failed without write and journaled intermediate and verified checkpoints', async () => {
  const intermediate = fixture();
  const originalAppend = intermediate.deps.journal.append;
  intermediate.deps.journal.append = entry => {
    if (entry.write === 'update' && entry.step === 'intent') throw new Error(SENTINEL);
    originalAppend(entry);
  };
  await assert.rejects(stage(intermediate), /JOURNAL_APPEND_FAILED/);
  const intermediateResult = intermediate.journal.at(-1);
  assert.equal(intermediateResult.step, 'intermediate');
  assert.equal((await status(intermediate, intermediateResult.op)).state, 'intermediate-only');
  const noWrite = fixture();
  const { opId } = await stage(noWrite);
  const verified = noWrite.journal.findLast(item => item.step === 'verified');
  noWrite.journal.splice(noWrite.journal.indexOf(verified) + 1);
  noWrite.journal.push({ ...verified, step: 'failed', failure: 'HEALTH_UNREADABLE' });
  assert.equal((await status(noWrite, opId)).state, 'failed-before-write');
  noWrite.journal.pop();
  noWrite.state.revisions[INTERMEDIATE].active = true;
  assert.equal((await status(noWrite, opId)).state, 'intermediate-left');
});

test('finish-stage refuses to verify a candidate that dropped a prior ref despite healthy HTTP', async () => {
  const f = fixture();
  f.state.failAppend = 'intermediate';
  await assert.rejects(stage(f), /JOURNAL_APPEND_FAILED/);
  const op = f.journal.at(-1).op;
  const report = await status(f, op);
  assert.equal(report.nextStep, 'finish-stage');
  f.state.failAppend = undefined;
  f.state.dropRef = true;
  await assert.rejects(recover(f, op, report, ...INPUT_FLAGS), /REVISION_SETTINGS_MISMATCH/);
  assert.equal(f.state.health['candidate.invalid'], SHA);
  assert.deepEqual(f.writes, ['volume-patch', 'update']);
  assert.equal((await status(f, op)).nextStep, 'reverify-stage');
  assert.ok(!f.journal.some(entry => entry.step === 'verified'));
});

test('rollback requires a switch and only accepts its previous serving revision', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  const rollback = (revision, ...flags) => action(f, 'rollback', opId, '--to-revision', revision, ...flags);
  await assert.rejects(rollback(OLD), /ROLLBACK_TARGET_NOT_ALLOWED/);
  await action(f, 'switch', opId);
  f.state.revisions[INTERMEDIATE].active = true;
  f.state.revisions['api--unrelated'] = { ...f.state.revisions[OLD] };
  for (const name of [CANDIDATE, INTERMEDIATE, 'api--unrelated'])
    await assert.rejects(rollback(name), /ROLLBACK_TARGET_NOT_ALLOWED/);
  for (const extra of [{ revisionName: 'api--unrelated', weight: 0 }, { revisionName: OLD, weight: 0, label: 'old' }]) {
    const current = f.state.traffic;
    f.state.traffic = [...current, extra];
    await assert.rejects(rollback(OLD), /ROLLBACK_OP_NOT_SERVING/);
    f.state.traffic = current;
  }
  const restored = await rollback(OLD, ...HOOK_FLAGS);
  assert.equal(restored.rolledBack, true);
  assert.deepEqual(restored.plan, { sha: OLD_SHA, revision: OLD });
  assert.deepEqual(f.state.traffic, trafficWithIdle(OLD, CANDIDATE));
  assert.equal(f.writes.filter(write => write === 'traffic').length, 2);
});

test('PATCH polls through two reads of the original latest', async () => {
  const f = fixture();
  f.state.latestPolls = 2;
  await stage(f);
  assert.deepEqual(f.sleeps, [5000, 5000]);
  assert.equal(f.journal.find(item => item.step === 'intent' && item.write === 'volume-patch').beforeLatest, OLD);
});

test('absent PATCH intermediate is drift after latest changes', async () => {
  const f = fixture();
  f.deps.azWrite = () => { throw Object.assign(new Error(SENTINEL), { processStarted: false }); };
  await assert.rejects(stage(f), /VOLUME_PATCH_FAILED/);
  const { op, azReturned } = f.journal.at(-1);
  assert.equal(azReturned, false);
  assert.equal((await status(f, op)).state, 'failed-before-write');
  f.state.latest = 'api--competing';
  assert.equal((await status(f, op)).state, 'drift');
});

test('legacy writes cannot bypass settings through a default-branch alias', async t => {
  await withFake(t, async ({ dir, az, cfg }) => {
    cfg.targets.legacy.app = TARGET.app;
    cfg.targets.legacy.slot = 'x';
    writeFileSync(join(dir, 'deploy.json'), JSON.stringify(cfg));
    await assert.rejects(main(['--repo', dir, '--target', 'legacy', '--rollback']), /G7_USE_ACTION/);
    assert.deepEqual(az.calls(), []);
  });
});

test('default-branch legacy writes refuse an alias using a subscription display name', async t => {
  await withFake(t, async ({ dir, az, cfg }) => {
    Object.assign(cfg.targets.legacy, {
      app: ` ${TARGET.app.toUpperCase()} `, resourceGroup: ` ${TARGET.resourceGroup.toUpperCase()} `,
      subscription: 'Subscription Display Name',
    });
    writeFileSync(join(dir, 'deploy.json'), JSON.stringify(cfg));
    await assert.rejects(main(['--repo', dir, '--target', 'legacy', '--rollback']), /^Error: G7_USE_ACTION$/);
    assert.deepEqual(az.calls(), []);
  });
});

test('config refuses duplicate G7 declarations for the same container app', () => {
  const alias = { ...TARGET, subscription: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    resourceGroup: ` ${TARGET.resourceGroup.toUpperCase()} `, app: ` ${TARGET.app.toUpperCase()} ` };
  assert.throws(() => validateConfig({ schema: 1, targets: { qa: TARGET, alias } }), /^Error: CONFIG_INVALID:/);
});

test('build and stage refuse a SHA outside the default history even with a built receipt', async () => {
  const f = fixture();
  f.state.offDefaultSha = SHA;
  await assert.rejects(f.run('--action', 'build', '--sha', SHA), /SHA_NOT_ON_DEFAULT/);
  await assert.rejects(stage(f), /SHA_NOT_ON_DEFAULT/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.writes, []);
});

test('CLI checks ancestry against the verified fully qualified tracking ref', async t => {
  await withFake(t, async ({ dir, az }) => {
    await assert.rejects(main(['--repo', dir, '--target', 'qa', '--action', 'build', '--sha', OLD_SHA, '--dry-run']),
      /SHA_NOT_ON_DEFAULT/);
    assert.deepEqual(az.calls(), []);
  });
});

test('stage allows an explicitly declared ref to move to another alias', async () => {
  const f = fixture();
  f.state.revisions[OLD].env.push({ name: 'ApiToken', secretRef: 'old-ref' });
  await stage(f);
  assert.equal(f.state.revisions[CANDIDATE].env.find(item => item.name === 'ApiToken').secretRef, 'ref-one');
});

test('stage rejects a plain env name that still has a secretRef', async () => {
  const f = fixture();
  f.state.retainPlainRef = true;
  await assert.rejects(stage(f), /REVISION_SETTINGS_MISMATCH: FLAVOR/);
});

test('candidate health is polled at ten-second intervals', async () => {
  const f = fixture();
  f.target.health.timeoutSeconds = 30;
  f.state.candidateHealthFailures = 2;
  await stage(f);
  assert.deepEqual(f.sleeps, [10000, 10000]);
  const down = fixture();
  down.state.candidateHealthFailures = 5;
  await assert.rejects(stage(down), /HEALTH_UNREADABLE/);
  assert.deepEqual(down.sleeps, [10000]);
});

test('renew refuses an input source SHA different from the serving SHA', async () => {
  const f = fixture();
  f.journal.push({ step: 'verified', revision: OLD, sha: OLD_SHA, digest: DIGEST, imageRef: IMAGE, generation: '1', verified: true });
  await assert.rejects(f.run('--action', 'renew-authority', ...INPUT_FLAGS), /SOURCE_SHA_MISMATCH/);
  assert.deepEqual(f.writes, []);
});

test('failed update without PATCH is terminal only if Azure never started and latest is unchanged', async () => {
  for (const [processStarted, expected] of [[undefined, 'drift'], [false, 'failed-before-write']]) {
    const f = fixture();
    f.state.volumes[1].secrets[0].secretRef = f.input.secretVolume.alias;
    f.state.processStarted = processStarted;
    f.state.failWrite = 'update';
    await assert.rejects(stage(f), /REVISION_UPDATE_FAILED/);
    const { op } = f.journal.at(-1);
    assert.equal((await status(f, op)).state, expected);
    f.state.latest = 'api--competing';
    assert.equal((await status(f, op)).state, 'drift');
  }
});

test('finish-stage refuses an unsafe app shape before update', async () => {
  const f = fixture();
  f.state.failAppend = 'intermediate';
  await assert.rejects(stage(f), /JOURNAL_APPEND_FAILED/);
  const op = f.journal.at(-1).op;
  const report = await status(f, op);
  f.state.failAppend = undefined;
  f.state.mode = 'Single';
  await assert.rejects(recover(f, op, report, ...INPUT_FLAGS), /APP_SHAPE_UNSAFE/);
  assert.deepEqual(f.writes, ['volume-patch']);
});

test('CLI lock records its owner and reports the path on contention', async t => {
  await withFake(t, async ({ dir, cfg }) => {
    const lockPath = join(dir, 'x4.lock');
    const invoke = sh => runX4Main({
      argv: ['--action', 'build', '--sha', SHA], repo: dir, targetName: 'qa', target: cfg.targets.qa, cfg,
      git: () => '', remote: 'origin', branch: 'main', historyStore: { dir }, sha: SHA,
      sh(command, args, options) {
        assert.equal(command, 'az');
        azCalls.push([...args]);
        return sh(options);
      },
    });
    let contents, readTimeout, readEnv;
    await assert.rejects(invoke(options => {
      readTimeout = options.timeout;
      readEnv = options.env;
      contents = readFileSync(lockPath, 'utf8');
      throw new Error('stop before any write');
    }), /AZ_READ_FAILED/);
    assert.equal(readTimeout, 120000);
    assert.equal(readEnv?.AZURE_LOGGING_ENABLE_LOG_FILE, 'no');
    assert.match(contents, new RegExp(String(process.pid)));
    assert.match(contents, /\d{4}-\d\d-\d\dT[\d:.]+Z/);
    assert.equal(existsSync(lockPath), false);
    const exit = t.mock.method(process, 'exit', () => {});
    const baseline = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
    for (const [signal, replaceOwner] of [['SIGINT', false], ['SIGTERM', true]]) {
      let lockAfterSignal;
      await assert.rejects(invoke(() => {
        if (replaceOwner) writeFileSync(lockPath, '0 replacement owner');
        const handler = process.listeners(signal).find(listener => !baseline[signal].includes(listener));
        handler?.(signal);
        lockAfterSignal = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null;
        throw new Error('stop before any write');
      }), /AZ_READ_FAILED/);
      assert.equal(exit.mock.calls.at(-1)?.arguments[0], signal === 'SIGINT' ? 130 : 143);
      assert.equal(lockAfterSignal, replaceOwner ? '0 replacement owner' : null);
      assert.deepEqual(process.listeners(signal), baseline[signal]);
      if (replaceOwner) assert.equal(readFileSync(lockPath, 'utf8'), '0 replacement owner');
      else assert.equal(existsSync(lockPath), false);
    }
    writeFileSync(lockPath, 'existing owner');
    await assert.rejects(invoke(() => assert.fail('unexpected Azure read')), error =>
      error.message.startsWith('APP_WRITE_LOCKED') && error.message.includes(lockPath));
    assert.equal(readFileSync(lockPath, 'utf8'), 'existing owner');
  });
});

test('legacy promotion selects entries from the declared source history', async t => {
  await withFake(t, async ({ dir, cfg }) => {
    const destination = appHistoryDir(cfg.targets.legacy, dir);
    const source = appHistoryDir(cfg.targets.qa, dir);
    const entry = { sha: SHA, image: IMAGE, digest: DIGEST, verified: true, revision: OLD };
    appendHistoryEntry(destination, entry);
    appendHistoryEntry(source, { ...entry, op: 'op-000000000000' });
    const argv = ['--repo', dir, '--target', 'legacy', '--sha', SHA, '--promote-from', 'qa', '--dry-run'];
    await assert.rejects(main(argv), /PROMOTE_SOURCE_NOT_VERIFIED/);
    appendHistoryEntry(source, entry);
    await assert.rejects(main(argv), /PROMOTE_SOURCE_MISMATCH/);
  });
});

test('interface status identifies draft 3.2 and review sections 15 and 16', () => {
  const status = readFileSync(new URL('../references/deploy-x4.md', import.meta.url), 'utf8').split('\n')
    .find(line => line.startsWith('Status:'));
  assert.match(status, /draft 3\.2.*sections 13 and 14.*sections 15 and 16/);
});

after(function x4UsesOnlyReviewedAzureCommands() {
  const reads = ['version', 'containerapp show', 'containerapp revision show', 'containerapp revision list'];
  const writes = ['rest', 'containerapp update', 'containerapp ingress traffic set',
    'containerapp revision deactivate', 'acr build'];
  const observedWrites = new Set();
  for (const args of azCalls) {
    assert.ok(!args.some(arg => /^(?:create(?:$|-)|onboard$|up$|new$)/.test(arg)),
      'X4 emitted an Azure resource creation token');
    const firstOption = args.findIndex(arg => arg.startsWith('-'));
    const commandArgs = args.slice(0, firstOption === -1 ? args.length : firstOption);
    const command = commandArgs.join(' ');
    assert.deepEqual(commandArgs, command.split(' '));
    if (reads.includes(command)) continue;
    assert.ok(writes.includes(command), `Unexpected X4 Azure command: ${command}`);
    if (command === 'rest') {
      const methods = args.flatMap((arg, index) => arg === '--method' ? [args[index + 1]] : []);
      assert.deepEqual(methods, ['PATCH']);
      assert.ok(!args.some(arg => arg.startsWith('--method=')));
    }
    observedWrites.add(command);
  }
  assert.deepEqual(observedWrites, new Set(writes));
});

test('owner-only X4 rejects agents and requires interactive confirmation from a person', async () => {
  for (const policy of [false, undefined]) {
    const f = fixture();
    if (policy === undefined) delete f.target.agentAllowed;
    else f.target.agentAllowed = policy;
    f.target.agentMarkers = ['CUSTOM_AGENT'];
    f.deps.isTTY = true;
    let confirmed = 0;
    f.deps.confirm = app => { assert.equal(app, f.target.app); confirmed++; };
    const { phrase } = await stage(f, '--dry-run');
    for (const marker of ['CODEX_SANDBOX', 'CUSTOM_AGENT']) {
      f.deps.env = { [marker]: '1' };
      await assert.rejects(stage(f, '--authorize', phrase), /^Error: AGENT_NOT_ALLOWED$/);
    }
    assert.equal(confirmed, 0);
    f.deps.env = {};
    await stage(f, '--authorize', phrase);
    assert.equal(confirmed, 1);
  }
});

test('rollback of operation A is refused after operation B switches', async () => {
  const f = fixture();
  const a = await stage(f);
  await action(f, 'switch', a.opId);

  f.input.env.find(item => item.name === GEN).value = '3';
  f.input.env.find(item => item.name === REV_GEN).value = '3';
  f.input.revisionSuffix = 'raaaaaaaa-g3';
  f.input.secretVolume.alias = 'authority-g3';
  f.state.vault.push({ name: f.input.secretVolume.alias,
    keyVaultUrl: f.input.secretVolume.kvVersionedUri, identity: DECL.identity });
  f.state.receipt = Buffer.from(JSON.stringify({ generation: '3' }));
  f.input.authorityReceiptSha256 = sha256Hex(f.state.receipt);
  const b = await stage(f);
  await action(f, 'switch', b.opId);

  const writes = f.writes.length;
  await assert.rejects(action(f, 'rollback', a.opId, '--to-revision', OLD), /ROLLBACK_OP_NOT_SERVING/);
  await assert.rejects(action(f, 'switch', a.opId), /GENERATION_NOT_NEWER/);
  await assert.rejects(action(f, 'switch', b.opId), /GENERATION_NOT_NEWER/);
  assert.deepEqual(f.state.traffic, trafficWithIdle('api--raaaaaaaa-g3', CANDIDATE, OLD));
  assert.equal(f.writes.length, writes);
});

test('rollback of operation A after its switch fails is refused after operation B switches', async () => {
  const f = fixture();
  const a = await stage(f);
  const fetch = f.deps.fetchHealth;
  f.deps.fetchHealth = url => url === f.target.health.url && f.state.traffic[0].revisionName === CANDIDATE
    ? { status: 503, body: {} } : fetch(url);
  await assert.rejects(action(f, 'switch', a.opId), /HEALTH_UNREADABLE/);
  assert.equal(f.journal.at(-1).step, 'failed');
  f.deps.fetchHealth = fetch;
  assert.deepEqual(f.state.traffic, trafficWithIdle(CANDIDATE, OLD));

  f.input.env.find(item => item.name === GEN).value = '3';
  f.input.env.find(item => item.name === REV_GEN).value = '3';
  f.input.revisionSuffix = 'raaaaaaaa-g3';
  f.input.secretVolume.alias = 'authority-g3';
  f.state.vault.push({ name: f.input.secretVolume.alias,
    keyVaultUrl: f.input.secretVolume.kvVersionedUri, identity: DECL.identity });
  f.state.receipt = Buffer.from(JSON.stringify({ generation: '3' }));
  f.input.authorityReceiptSha256 = sha256Hex(f.state.receipt);
  const b = await stage(f);
  await action(f, 'switch', b.opId);

  const writes = f.writes.length;
  await assert.rejects(action(f, 'rollback', a.opId, '--to-revision', OLD), /ROLLBACK_OP_NOT_SERVING/);
  assert.deepEqual(f.state.traffic, trafficWithIdle('api--raaaaaaaa-g3', CANDIDATE, OLD));
  assert.equal(f.writes.length, writes);
});

test('switch and rollback poll live and destination health after the traffic write', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  const fetch = f.deps.fetchHealth;
  for (const [kind, destination, host, staleSha, flags] of [
    ['switch', CANDIDATE, 'candidate.invalid', OLD_SHA, []],
    ['rollback', OLD, 'old.invalid', SHA, ['--to-revision', OLD]],
  ]) {
    const reads = new Map();
    f.deps.fetchHealth = url => {
      const name = new URL(url).hostname;
      const response = fetch(url);
      if (f.state.traffic[0].revisionName !== destination || !['live.invalid', host].includes(name)) return response;
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      if (count === 1) response.body.nested.sha = staleSha;
      return response;
    };
    f.sleeps.length = 0;
    await action(f, kind, opId, ...flags);
    assert.ok(reads.get('live.invalid') >= 2);
    assert.ok(reads.get(host) >= 2);
    assert.deepEqual(f.sleeps, [10000]);
  }
});

test('rollback restores the previous revision after an unverified traffic move', async () => {
  const g = fixture();
  g.target.agentAllowed = 'with-authorization';
  const staged = await stage(g, '--dry-run');
  const { opId: op } = await stage(g, '--authorize', staged.phrase);
  const switching = await action(g, 'switch', op, '--dry-run');
  const fetch = g.deps.fetchHealth;
  g.deps.fetchHealth = url => url === g.target.health.url && g.state.traffic[0].revisionName === CANDIDATE
    ? { status: 200, body: { nested: { sha: OLD_SHA } } } : fetch(url);
  await assert.rejects(action(g, 'switch', op, '--authorize', switching.phrase), /HEALTH_SHA_MISMATCH/);
  assert.deepEqual(g.state.traffic, trafficWithIdle(CANDIDATE, OLD));
  g.state.traffic.push({ revisionName: 'api--unknown', weight: 0 });
  await assert.rejects(action(g, 'rollback', op, '--to-revision', OLD, '--dry-run'), /ROLLBACK_OP_NOT_SERVING/);
  g.state.traffic.pop();
  const rollback = await action(g, 'rollback', op, '--to-revision', OLD, '--dry-run');
  await action(g, 'rollback', op, '--to-revision', OLD, '--authorize', rollback.phrase);
  assert.deepEqual(g.state.traffic, trafficWithIdle(OLD, CANDIDATE));
});

test('failed switch rollback accepts a partial move only between its two revisions', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  f.state.trafficAfter = [{ revisionName: OLD, weight: 80 }, { revisionName: CANDIDATE, weight: 20 }];
  await assert.rejects(action(f, 'switch', opId), /TRAFFIC_NOT_AS_PLANNED/);
  f.state.trafficAfter = undefined;
  f.state.traffic = [{ revisionName: 'api--unrelated', weight: 80 }, { revisionName: CANDIDATE, weight: 20 }];
  await assert.rejects(action(f, 'rollback', opId, '--to-revision', OLD), /ROLLBACK_OP_NOT_SERVING/);
  f.state.traffic = [{ revisionName: OLD, weight: 80 }, { revisionName: CANDIDATE, weight: 20 }];
  await action(f, 'rollback', opId, '--to-revision', OLD);
  assert.deepEqual(normalizeTraffic(f.state.traffic), trafficWithIdle(OLD, CANDIDATE));
  assert.equal((await status(f, opId)).state, 'rolled-back');
});

test('rollback binds null when the live app is down and still checks destination health', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  await action(f, 'switch', opId);
  delete f.state.health['candidate.invalid'];
  const rollback = (...flags) => action(f, 'rollback', opId, '--to-revision', OLD, ...flags);
  const dry = await rollback('--dry-run');
  assert.equal(dry.plan.expected.servingSha, null);
  delete f.state.health['old.invalid'];
  await assert.rejects(rollback(), /HEALTH_UNREADABLE/);
  f.state.health['old.invalid'] = OLD_SHA;
  await rollback();
  assert.deepEqual(f.state.traffic, trafficWithIdle(OLD, CANDIDATE));
});

test('promotion requires verified serving provenance for the exact pinned digest', async () => {
  const entry = { sha: SHA, digest: DIGEST, image: IMAGE, revision: OLD, verified: true };
  for (const [change, live, image] of [
    [{ verified: false }], [{ intent: true }], [{ staged: true }],
    [{ op: 'op-000000000000', step: 'verified' }],
    [{}, OLD_SHA], [{}, SHA, IMAGE.replace(DIGEST, OTHER_DIGEST)],
  ]) {
    const f = fixture({ withBuild: false });
    f.target.promoteFrom = 'test';
    f.state.promotion = [{ ...entry, ...change }];
    f.state.sourceSha = live ?? SHA;
    f.state.sourceImage = image ?? IMAGE;
    await assert.rejects(stage(f), /^Error: DIGEST_PROVENANCE_UNPROVEN$/);
    assert.deepEqual(f.writes, []);
  }
});

test('a PATCH with an unknown outcome and no intermediate is drift', async () => {
  for (const code of [undefined, 'ETIMEDOUT', 1]) {
    const f = fixture();
    f.deps.azWrite = () => { throw Object.assign(new Error(SENTINEL), { code }); };
    await assert.rejects(stage(f), /VOLUME_PATCH_FAILED/);
    assert.equal(f.journal.at(-1).azReturned, null);
    assert.equal((await status(f, f.journal.at(-1).op)).state, 'drift');
  }
  const f = fixture();
  f.deps.azWrite = () => {};
  await assert.rejects(stage(f), /VOLUME_PATCH_TIMEOUT/);
  assert.equal((await status(f, f.journal.at(-1).op)).state, 'drift');
});

test('a PATCH builder returning a different URL is refused before the write intent', async () => {
  const runner = new URL('./deploy-x4-run.mjs?patch-builder-spy', import.meta.url);
  const builder = new URL('./deploy-x4.mjs?patch-builder-spy', import.meta.url);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(context.parentURL === runner.href && specifier === './deploy-x4.mjs'
        ? builder.href : specifier, context);
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== builder.href) return result;
      const source = result.source.toString().replace('export function volumePatchArgs(', 'function originalVolumePatchArgs(');
      return { ...result, source: source + `
export function volumePatchArgs(...args) {
  const argv = originalVolumePatchArgs(...args);
  argv[4] = 'https://other.invalid';
  return argv;
}
` };
    },
  });
  try {
    const { runX4: run } = await import(runner.href);
    const f = fixture({ run });
    await assert.rejects(stage(f), /^Error: X4_ARGV_REFUSED$/);
    assert.deepEqual(f.writes, []);
    assert.equal(f.journal.length, 1);
  } finally { hooks.deregister(); }
});

test('traffic writes recheck app shape', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  f.state.mode = 'Single';
  await assert.rejects(action(f, 'switch', opId), /APP_SHAPE_UNSAFE/);
  f.state.mode = 'Multiple';
  await action(f, 'switch', opId);
  f.state.mode = 'Single';
  await assert.rejects(action(f, 'rollback', opId, '--to-revision', OLD), /APP_SHAPE_UNSAFE/);
  assert.equal(f.writes.filter(write => write === 'traffic').length, 1);
});

test('writes require the reviewed CLI and extension versions', async () => {
  for (const version of [
    { 'azure-cli': '3.0.0', extensions: { containerapp: '1.3.0b6' } },
    { 'azure-cli': '2.90.0', extensions: { containerapp: '1.3.0b6' } },
    { 'azure-cli': '2.91.0', extensions: { containerapp: '1.3.0' } },
    { 'azure-cli': '2.91.0' },
  ]) {
    const f = fixture();
    f.state.version = version;
    await assert.rejects(stage(f), /^Error: AZ_VERSION_UNREVIEWED$/);
    assert.deepEqual(f.writes, []);
  }
});

test('later actions refuse altered redacted stage args', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  f.journal.find(entry => entry.op === opId && entry.step === 'intent').args.input.env[0].valueSha256 = 'a'.repeat(64);
  await assert.rejects(status(f, opId), /^Error: JOURNAL_TAMPERED$/);
  await assert.rejects(action(f, 'switch', opId), /^Error: JOURNAL_TAMPERED$/);
});

test('CLI reads capture stderr and report a fixed code', async t => {
  await withFake(t, async ({ dir }) => {
    writeFileSync(join(dir, 'az'), '#!/bin/sh\nprintf "%s" "' + SENTINEL + '" >&2\nexit 88\n', { mode: 0o755 });
    const stderr = t.mock.method(process.stderr, 'write', () => true);
    await assert.rejects(main(['--repo', dir, '--target', 'qa', '--action', 'build', '--sha', SHA, '--dry-run']),
      /^Error: AZ_READ_FAILED$/);
    assert.ok(stderr.mock.calls.every(({ arguments: args }) => !String(args[0]).includes(SENTINEL)));
  });
});

test('renew compares the declared revocation env name', async () => {
  const f = fixture({ withBuild: false });
  const name = 'CustomRevocation';
  f.target.settings.revocationEnv = name;
  f.target.settings.env.find(item => item.name === REV_GEN).name = name;
  f.input.env.find(item => item.name === REV_GEN).name = name;
  f.state.health['old.invalid'] = SHA;
  f.journal.push({ step: 'verified', revision: OLD, sha: SHA, digest: DIGEST, imageRef: IMAGE, generation: '1', verified: true });
  await f.run('--action', 'renew-authority', ...INPUT_FLAGS);
  assert.ok(f.writes.includes('update'));
});


test('legacy cleanup planning refuses older X4 history', async t => {
  await withFake(t, async ({ dir, az, cfg }) => {
    cfg.targets.legacy.revisionCleanup = { keepPrevious: 2, quietDays: 1 };
    writeFileSync(join(dir, 'deploy.json'), JSON.stringify(cfg));
    const path = appHistoryDir(cfg.targets.legacy, dir);
    appendHistoryEntry(path, { op: 'op-000000000000', step: 'switched' });
    appendHistoryEntry(path, { sha: SHA, image: IMAGE, verified: true, revision: 'legacy-api--latest' });
    await assert.rejects(main(['--repo', dir, '--target', 'legacy', '--dry-run']), { message: `X4_HISTORY_PRESENT: ${basename(path)}` });
    assert.deepEqual(az.calls(), []);
  });
});

test('renew uses the serving promoted image and checks its journal and declared registry', async () => {
  for (const change of ['none', 'journal', 'registry']) {
    const f = fixture({ withBuild: false });
    f.target.promoteFrom = 'test';
    f.state.sourceRegistry = 'source.azurecr.io';
    const image = (change === 'registry' ? 'unknown.azurecr.io/api@' : 'source.azurecr.io/api@') + DIGEST;
    f.state.sourceImage = f.state.revisions[OLD].image = image;
    f.state.health['old.invalid'] = SHA;
    f.journal.push({ step: 'verified', revision: OLD, sha: SHA, digest: DIGEST,
      imageRef: change === 'journal' ? IMAGE : image, generation: '1', verified: true });
    const renew = f.run('--action', 'renew-authority', ...INPUT_FLAGS);
    if (change === 'none') {
      await renew;
      assert.equal(f.state.revisions[CANDIDATE].image, image);
    } else {
      await assert.rejects(renew, /DIGEST_PROVENANCE_UNPROVEN/);
      assert.deepEqual(f.writes, []);
    }
  }
});

test('build binds empty normalized traffic and still journals the build', async () => {
  const f = fixture({ withBuild: false });
  f.state.traffic = [];
  await f.run('--action', 'build', '--sha', SHA);
  assert.deepEqual(f.journal.at(-1).expected.traffic, []);
  assert.equal(f.journal.at(-1).expected.servingRevision, null);
  assert.equal(f.journal.at(-1).step, 'built');
});

test('legacy dispatch refuses lone X4 flags before any Azure calls', async t => {
  await withFake(t, async ({ dir, az }) => {
    for (const flag of ['--op', '--retire-revision', '--to-revision', '--revision-input',
      '--authority-receipt']) {
      await assert.rejects(main(['--repo', dir, '--target', 'legacy', flag, 'value', '--dry-run']),
        /^Error: DEPLOY_MODE_CONFLICT$/);
    }
    assert.deepEqual(az.calls(), []);
  });
});

test('a 15-second health timeout gives Azure writes 600 seconds', async t => {
  await withFake(t, async ({ dir }) => {
    const f = fixture();
    writeFileSync(join(dir, 'input.json'), JSON.stringify(f.input));
    writeFileSync(join(dir, 'receipt.json'), RECEIPT);
    const historyDir = appHistoryDir(f.target, dir);
    for (const entry of f.journal) appendHistoryEntry(historyDir, entry);
    let writeTimeout, writeEnv, bodyRemoved;
    const exit = t.mock.method(process, 'exit', () => {});
    await assert.rejects(runX4Main({
      argv: ['--action', 'stage', '--revision-input', join(dir, 'input.json'), '--authority-receipt', join(dir, 'receipt.json')],
      repo: dir, targetName: 'qa', target: f.target, cfg: { targets: { qa: f.target } },
      git: () => '', remote: 'origin', branch: 'main', historyStore: { dir: historyDir, options: {
        repo: dir, home: dir, targetName: 'qa', target: f.target, cfg: { targets: { qa: f.target } }, git: () => '',
      } },
      sh: (_cmd, args) => f.deps.az(args),
      shQuiet: (args, timeout, options) => {
        writeTimeout = timeout;
        writeEnv = options?.env;
        const bodyDir = dirname(args[args.indexOf('--body') + 1].slice(1));
        const handler = process.listeners('SIGTERM').at(-1);
        assert.equal(existsSync(bodyDir), true);
        handler('SIGTERM');
        bodyRemoved = !existsSync(bodyDir);
        throw new Error('stop after capturing write timeout');
      },
    }), /VOLUME_PATCH_FAILED/);
    assert.equal(writeTimeout, 600000);
    assert.equal(writeEnv?.AZURE_LOGGING_ENABLE_LOG_FILE, 'no');
    assert.equal(bodyRemoved, true);
    assert.equal(exit.mock.calls.at(-1)?.arguments[0], 143);
  });
});

test('policy edits preserve rollback but refuse switch on the old stage', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  const journaledPolicySha256 = f.journal.at(-1).target.policySha256;
  await action(f, 'switch', opId);
  f.target.health.timeoutSeconds++;
  f.target.health.shaField = 'differentField';
  const report = await status(f, opId);
  assert.equal(report.state, 'switched');
  assert.equal(report.policyChanged, true);
  f.target.health.shaField = TARGET.health.shaField;
  await assert.rejects(action(f, 'switch', opId, '--dry-run'), /STAGE_POLICY_CHANGED/);
  const dry = await action(f, 'rollback', opId, '--to-revision', OLD, '--dry-run');
  assert.notEqual(dry.plan.target.policySha256, journaledPolicySha256);
  assert.equal(dry.plan.args.stagePolicySha256, journaledPolicySha256);
  f.target.container = 'different';
  await assert.rejects(action(f, 'rollback', opId, '--to-revision', OLD), /STAGE_POLICY_CHANGED/);
  f.target.container = TARGET.container;
  f.target.subscription = '22345678-1234-1234-1234-123456789abc';
  await assert.rejects(action(f, 'rollback', opId, '--to-revision', OLD, '--dry-run'), /^Error: STAGE_POLICY_CHANGED$/);
  await assert.rejects(status(f, opId), /^Error: STAGE_POLICY_CHANGED$/);
  f.target.subscription = TARGET.subscription.toUpperCase();
  f.target.resourceGroup = TARGET.resourceGroup.toUpperCase();
  await action(f, 'rollback', opId, '--to-revision', OLD);
  assert.deepEqual(f.state.traffic, trafficWithIdle(OLD, CANDIDATE));
});

test('rollback status and recover evaluate a null bound serving SHA', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  await action(f, 'switch', opId);
  delete f.state.health['candidate.invalid'];
  f.state.failWrite = 'traffic';
  await assert.rejects(action(f, 'rollback', opId, '--to-revision', OLD), /TRAFFIC_WRITE_FAILED/);
  assert.equal((await status(f, opId)).state, 'rollback-not-applied');
  f.state.health['candidate.invalid'] = SHA;
  assert.equal((await status(f, opId)).state, 'rollback-not-applied');
  await assert.rejects(action(f, 'recover', opId, '--dry-run'), /NOTHING_TO_RECOVER/);
});

test('candidate provisioning can take longer than the health timeout', async () => {
  const f = fixture();
  f.state.candidateProv = 'Provisioning';
  const sleep = f.deps.sleep;
  f.deps.sleep = ms => {
    sleep(ms);
    if (f.sleeps.length === 3) f.state.revisions[CANDIDATE].prov = 'Provisioned';
  };
  await stage(f);
  assert.equal(f.sleeps.length, 3);
});

test('finish-stage refuses a provisioning intermediate without updating', async () => {
  const f = fixture();
  f.state.failAppend = 'intermediate';
  await assert.rejects(stage(f), /JOURNAL_APPEND_FAILED/);
  const op = f.journal.at(-1).op;
  f.state.revisions[INTERMEDIATE].prov = 'Provisioning';
  const report = await status(f, op);
  await assert.rejects(recover(f, op, report, ...INPUT_FLAGS), /INTERMEDIATE_NOT_READY/);
  assert.deepEqual(f.writes, ['volume-patch']);
});

test('legacy worktree config fails closed when the default declaration is invalid', async t => {
  await withFake(t, async ({ dir, cfg, az }) => {
    mkdirSync(join(dir, '.trioharness'));
    writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify(cfg));
    writeFileSync(join(dir, 'deploy.json'), '{');
    const markers = DEFAULT_AGENT_MARKERS.filter(key => Object.hasOwn(process.env, key));
    const saved = Object.fromEntries(markers.map(key => [key, process.env[key]]));
    try {
      for (const key of markers) delete process.env[key];
      await assert.rejects(main(['--repo', dir, '--target', 'legacy', '--config-from-worktree']), /^Error: G7_USE_ACTION$/);
    } finally {
      Object.assign(process.env, saved);
    }
    assert.deepEqual(az.calls(), []);
  });
});

for (const [name, options, refusal] of [
  ['the default tracking ref is stale', { staleDefault: true }, /^Error: G7_USE_ACTION$/],
  ['the default branch is unknown', { unknownDefault: true }, /^Error: G7_DEFAULT_UNKNOWN: run git remote set-head origin --auto$/],
  ['the default config exists but show fails', { unreadableConfig: true }, /^Error: G7_USE_ACTION$/],
]) {
  test(`legacy worktree writes fail closed when ${name}`, async t => {
    await withFake(t, async ({ dir, cfg, az }) => {
      mkdirSync(join(dir, '.trioharness'));
      writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify({ ...cfg, defaultBranch: 'alternate' }));
      const saved = Object.fromEntries(DEFAULT_AGENT_MARKERS.filter(key => Object.hasOwn(process.env, key))
        .map(key => [key, process.env[key]]));
      try {
        for (const key of Object.keys(saved)) delete process.env[key];
        await assert.rejects(main(['--repo', dir, '--target', 'legacy', '--config-from-worktree', '--rollback']), refusal);
      } finally {
        Object.assign(process.env, saved);
      }
      assert.deepEqual(az.calls(), []);
    }, options);
  });
}

test('X4 applies the strictest authorization and combines markers across aliases', async () => {
  const f = fixture();
  f.target.agentMarkers = ['NAMED_AGENT'];
  f.state.aliases = { authorized: { ...f.target, agentAllowed: 'with-authorization' } };
  await assert.rejects(stage(f), /AUTHORIZATION_REQUIRED/);
  f.state.aliases.owner = { ...f.target, subscription: 'Named Subscription', slot: 'x', agentAllowed: false, agentMarkers: ['OWNER_AGENT'] };
  f.deps.env.OWNER_AGENT = '1';
  const dry = await stage(f, '--dry-run');
  await assert.rejects(stage(f, '--authorize', dry.phrase), /AGENT_NOT_ALLOWED/);
  delete f.deps.env.OWNER_AGENT;
  f.deps.env.NAMED_AGENT = '1';
  await assert.rejects(stage(f, '--authorize', dry.phrase), /AGENT_NOT_ALLOWED/);
  assert.deepEqual(f.writes, []);
});

test('a worktree declaration can bootstrap a default branch without deploy.json', async t => {
  await withFake(t, async ({ dir, cfg, az }) => {
    mkdirSync(join(dir, '.trioharness'));
    const { app, subscription, resourceGroup, health } = cfg.targets.legacy;
    cfg.targets.web = { type: 'webapp', app, subscription, resourceGroup, health, outputDir: 'dist', build: [{ command: 'true' }], agentAllowed: true };
    writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify(cfg));
    rmSync(join(dir, 'deploy.json'));
    const markers = DEFAULT_AGENT_MARKERS.filter(key => Object.hasOwn(process.env, key));
    const saved = Object.fromEntries(markers.map(key => [key, process.env[key]]));
    try {
      for (const key of markers) delete process.env[key];
      for (const [target, refusal] of [['legacy', /NO_ROLLBACK_TARGET/], ['web', /NO_ROLLBACK_ARTIFACT/]]) {
        await assert.rejects(main(['--repo', dir, '--target', target, '--config-from-worktree', '--rollback']), refusal);
      }
    } finally {
      Object.assign(process.env, saved);
    }
    assert.deepEqual(az.calls(), []);
  });
});

test('a legacy webapp worktree rollback can use its configured branch without origin/HEAD', async t => {
  await withFake(t, async ({ dir, cfg, az }) => {
    const { app, subscription, resourceGroup, health } = cfg.targets.legacy;
    const web = { type: 'webapp', app, subscription, resourceGroup, health, outputDir: 'dist', build: [{ command: 'true' }], agentAllowed: true };
    mkdirSync(join(dir, '.trioharness'));
    writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify({
      schema: 1, defaultBranch: 'alternate', targets: { web },
    }));
    const saved = Object.fromEntries(DEFAULT_AGENT_MARKERS.filter(key => Object.hasOwn(process.env, key))
      .map(key => [key, process.env[key]]));
    try {
      for (const key of Object.keys(saved)) delete process.env[key];
      await assert.rejects(main(['--repo', dir, '--target', 'web', '--config-from-worktree', '--rollback']), /NO_ROLLBACK_ARTIFACT/);
    } finally {
      Object.assign(process.env, saved);
    }
    assert.deepEqual(az.calls(), []);
  }, { unknownDefault: true });
});

for (const failedGitRead of ['ls-remote', 'for-each-ref']) {
  test(`worktree G7 refusal keeps failed ${failedGitRead} diagnostics quiet`, async t => {
    await withFake(t, async ({ dir, cfg, az }) => {
      mkdirSync(join(dir, '.trioharness'));
      writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify(cfg));
      const env = { ...process.env };
      for (const key of DEFAULT_AGENT_MARKERS) delete env[key];
      const result = spawnSync(process.execPath, [new URL('./deploy.mjs', import.meta.url).pathname, '--repo', dir, '--target', 'legacy',
        '--config-from-worktree', '--rollback'], { env, encoding: 'utf8' });
      assert.ok(result.status > 0);
      assert.match(result.stderr, /G7_USE_ACTION/);
      assert.doesNotMatch(result.stderr, /fake git diagnostic/);
      assert.deepEqual(az.calls(), []);
    }, { failedGitRead });
  });
}

test('worktree aliases are checked against the default branch by app identity', async t => {
  await withFake(t, async ({ dir, cfg, az }) => {
    mkdirSync(join(dir, '.trioharness'));
    const { settings, ...optedInApp } = cfg.targets.qa;
    const worktree = { schema: 1, defaultBranch: 'alternate', targets: { qa: cfg.targets.legacy, renamed: optedInApp } };
    writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify(worktree));
    const markers = DEFAULT_AGENT_MARKERS.filter(key => Object.hasOwn(process.env, key));
    const saved = Object.fromEntries(markers.map(key => [key, process.env[key]]));
    try {
      for (const key of markers) delete process.env[key];
      const rollback = target => main(['--repo', dir, '--target', target, '--config-from-worktree', '--rollback']);
      await assert.rejects(rollback('qa'), /NO_ROLLBACK_TARGET/);
      await assert.rejects(rollback('renamed'), /^Error: G7_USE_ACTION$/);
      worktree.targets.renamed.slot = 'x';
      writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify(worktree));
      await assert.rejects(rollback('renamed'), /^Error: G7_USE_ACTION$/);
      worktree.targets.renamed.subscription = 'Subscription Display Name';
      worktree.targets.renamed.resourceGroup = ` ${optedInApp.resourceGroup.toUpperCase()} `;
      worktree.targets.renamed.app = ` ${optedInApp.app.toUpperCase()} `;
      writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify(worktree));
      await assert.rejects(rollback('renamed'), /^Error: G7_USE_ACTION$/);
    } finally {
      Object.assign(process.env, saved);
    }
    assert.deepEqual(az.calls(), []);
  });
});

test('worktree config refuses agents identified by a default-branch alias even on dry runs', async t => {
  await withFake(t, async ({ dir, cfg, az }) => {
    const { settings, ...renamed } = cfg.targets.qa;
    const worktree = { schema: 1, defaultBranch: 'alternate', targets: { renamed } };
    mkdirSync(join(dir, '.trioharness'));
    writeFileSync(join(dir, '.trioharness/deploy.json'), JSON.stringify(worktree));
    writeFileSync(join(dir, 'deploy.json'), JSON.stringify({
      ...cfg, targets: { qa: { ...renamed, subscription: 'Named Subscription', slot: 'x', agentMarkers: ['X4_DEFAULT_AGENT'] } },
    }));
    const saved = Object.fromEntries(DEFAULT_AGENT_MARKERS.filter(key => Object.hasOwn(process.env, key))
      .map(key => [key, process.env[key]]));
    try {
      for (const key of Object.keys(saved)) delete process.env[key];
      process.env.X4_DEFAULT_AGENT = '1';
      await assert.rejects(main(['--repo', dir, '--target', 'renamed', '--config-from-worktree', '--rollback', '--dry-run']),
        /^Error: CONFIG_FROM_WORKTREE_PERSON_ONLY:/);
    } finally {
      delete process.env.X4_DEFAULT_AGENT;
      Object.assign(process.env, saved);
    }
    assert.deepEqual(az.calls(), []);
  });
});

test('CLI dispatches de-opted operations only with X4 app history', async t => {
  await withFake(t, async ({ dir, cfg, az }) => {
    const legacy = cfg.targets.legacy;
    const id = 'op-000000000000';
    appendHistoryEntry(appHistoryDir(legacy, dir), { op: id, action: 'build', step: 'built' });
    const argv = ['--repo', dir, '--target', 'legacy'];
    await assert.rejects(main([...argv, '--status', id]), /JOURNAL_PLAN_UNREADABLE/);
    for (const [kind, flags] of [['rollback', ['--to-revision', OLD]], ['withdraw', []]]) {
      await assert.rejects(main([...argv, '--action', kind, '--op', 'op-111111111111', ...flags]), /OP_NOT_FOUND/);
    }
    await assert.rejects(main([...argv, '--action', 'stage', ...INPUT_FLAGS]), /G7_NOT_DECLARED/);
    assert.ok(az.calls().every(args => args.includes('--query')));
  });
});

test('de-opted targets can report status and recover rollback and withdrawal', async () => {
  const f = fixture();
  const { opId } = await stage(f);
  await action(f, 'switch', opId);
  delete f.target.settings;
  delete f.target.loginServer;
  const report = await status(f, opId);
  assert.equal(report.state, 'switched');
  assert.equal(report.policyChanged, true);

  f.state.failAppend = 'rolled-back';
  await assert.rejects(action(f, 'rollback', opId, '--to-revision', OLD), /JOURNAL_APPEND_FAILED/);
  f.state.failAppend = undefined;
  await recover(f, opId, await status(f, opId));
  assert.equal((await status(f, opId)).state, 'rolled-back');
  assert.deepEqual(f.state.traffic, trafficWithIdle(OLD, CANDIDATE));

  f.state.failAppend = 'deactivated';
  await assert.rejects(action(f, 'withdraw', opId), /JOURNAL_APPEND_FAILED/);
  f.state.failAppend = undefined;
  await recover(f, opId, await status(f, opId));
  assert.equal((await status(f, opId)).state, 'withdrawn');

  for (const kind of ['build', 'stage', 'renew-authority', 'switch', 'cleanup']) {
    const extra = kind === 'build' ? ['--sha', SHA] : ['stage', 'renew-authority'].includes(kind) ? INPUT_FLAGS : ['--op', opId];
    await assert.rejects(f.run('--action', kind, ...extra), /G7_NOT_DECLARED/);
  }
});


test('history root lookup fails closed on stat and directory-read errors', async () => {
  const { appHistoryDir, findRecordedX4History } = await import('./deploy.mjs');
  const root = dirname(appHistoryDir(TARGET));
  const fail = code => () => { throw Object.assign(new Error('fixture'), { code }); };
  assert.equal(findRecordedX4History(TARGET, { statSync: fail('ENOENT') }), undefined);
  for (const code of ['EACCES', 'EPERM', 'ENOTDIR', 'EIO']) {
    assert.deepEqual(findRecordedX4History(TARGET, { statSync: fail(code) }),
      { name: root + ' unreadable', reason: 'unreadable' });
  }
  assert.deepEqual(findRecordedX4History(TARGET, { statSync: () => ({}), readdirSync: fail('EACCES') }),
    { name: root + ' unreadable', reason: 'unreadable' });
});
