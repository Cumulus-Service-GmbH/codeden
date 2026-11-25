import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as x from './deploy-x4.mjs';

const sha = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const identity = '/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id';
const decl = { name: 'authority', aliasPrefix: 'authority-g', vaultHost: 'test.vault.azure.net',
  vaultItem: 'item', identity, mountPath: '/app/auth', path: 'receipt.json' };
const target = { subscription: '12345678-1234-1234-1234-123456789abc', resourceGroup: 'rg', app: 'app',
  build: { buildArgs: { WEB_BASE_SHA: sha } },
  settings: { generationEnv: 'N', revocationEnv: 'R', env: [{ name: 'N', format: 'generation' },
    { name: 'R', format: 'generation' },
    { name: 'WEB', format: 'webPin' }, { name: 'ENV', equals: 'TEST' }],
  envRefs: [{ name: 'Token', aliasPattern: '^ref-[a-z]+$' }], authorityVolume: decl } };
const input = { schema: 1, sourceSha: sha, image: { digest: 'sha256:' + hash },
  revisionSuffix: 'raaaaaaaa-g2', env: [{ name: 'WEB', value: sha }, { name: 'N', value: '2' },
    { name: 'ENV', value: 'TEST' }, { name: 'R', value: '2' }], envRefs: [{ name: 'Token', appRef: 'ref-one' }],
  secretVolume: { name: decl.name, alias: 'authority-g2',
    kvVersionedUri: 'https://test.vault.azure.net/secrets/item/' + 'c'.repeat(32),
    identity, mountPath: decl.mountPath, path: decl.path },
  authorityReceiptSha256: hash, expiresAtUtc: '2030-01-01T01:00:00Z' };
const parse = i => x.parseRevisionInput(Buffer.from(JSON.stringify(i)), target, { now: Date.parse('2030-01-01') });

test('strict JSON and canonical JSON', () => {
  for (const bad of ['{"a":[{"x":1,"\\u0078":2}]}', '\uFEFF{}', Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    Buffer.from([0x22, 0xff, 0x22]), '{} []', '[1,]', '{"a":01}']) {
    assert.throws(() => x.parseStrictJson(bad), /^Error: INPUT_INVALID:/);
  }
  assert.deepEqual(x.parseStrictJson(' {"x":[true,null,-2,"x"]} '), { x: [true, null, -2, 'x'] });
  assert.equal(x.canonicalJson({ 'é': 3, z: 1, '𐀀': 2, 'Ａ': 4 }), '{"z":1,"é":3,"𐀀":2,"Ａ":4}');
  for (const bad of [0.5, NaN, Infinity, -Infinity]) assert.throws(() => x.canonicalJson(bad));
  assert.equal(x.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('G7 declarations require a subscription GUID', () => {
  assert.throws(() => x.validateSettingsDecl({ ...target, subscription: 'Subscription Display Name' }, 'test'),
    /CONFIG_INVALID:.*subscription/);
});

test('declaration and revision input', () => {
  x.validateSettingsDecl(target, 'test');
  assert.throws(() => x.validateSettingsDecl({ ...target, type: 'containerapp', slot: 'x' }, 'test'), /CONFIG_INVALID:.*slot/);
  for (const mutate of [
    t => { delete t.settings.revocationEnv; },
    t => t.settings.env.push({ name: 'MyPassword', equals: 'x' }),
    t => { t.settings.extra = true; },
    t => { t.settings.envRefs[0].aliasPattern = '^ref$|bad'; },
    t => { t.health = { rollbackExpect: { 'x.y': 3 } }; },
  ]) {
    const t = structuredClone(target);
    mutate(t);
    assert.throws(() => x.validateSettingsDecl(t, 'test'), /CONFIG_INVALID:/);
  }
  const parsed = parse(input);
  assert.equal(parsed.generation, '2');
  assert.deepEqual(parsed.input.env.map(e => e.name), ['ENV', 'N', 'R', 'WEB']);
  assert.equal(parsed.inputSha256, x.sha256Hex(x.canonicalJson(parsed.input)));
  const max = structuredClone(input);
  max.env[1].value = '9223372036854775807';
  max.revisionSuffix = 'raaaaaaaa-g9223372036854775807';
  max.secretVolume.alias = 'authority-g9223372036854775807';
  assert.equal(parse(max).generation, max.env[1].value);
  const uri = input.secretVolume.kvVersionedUri;
  const cases = [
    ['INPUT_INVALID', i => { i.image.extra = 1; }],
    ['INPUT_INVALID', i => { delete i.schema; }],
    ['INPUT_INVALID', i => { i.env[0].value = 3; }],
    ['INPUT_INVALID', i => { i.env[1].value = '9223372036854775808'; }],
    ['INPUT_INVALID', i => { i.env[1].value = '02'; }],
    ['INPUT_INVALID', i => { i.env[0].value = 'b'.repeat(40); }],
    ...input.env.map(({ name }) => ['INPUT_INCOMPLETE', i => { i.env = i.env.filter(entry => entry.name !== name); }]),
    ['INPUT_INVALID', i => { i.envRefs[0].appRef = 'other'; }],
    ['INPUT_INVALID', i => { i.revisionSuffix += '-v'; }],
    ['INPUT_INVALID', i => { i.secretVolume.alias = 'authority-g3'; }],
    ['INPUT_INVALID', i => { i.envRefs[0].name = 'n'; }],
    ['INPUT_INVALID', i => { i.envRefs[0].name = 'N'; }],
    ['INPUT_INVALID', i => { i.expiresAtUtc = '2030-02-30T01:00:00Z'; }],
    ['INPUT_NOT_DECLARED', i => { i.env[0].name = 'UNKNOWN'; }],
    ['ENV_VALUE_RESERVED', i => { i.env[0].value = 'xSeCrEtReF:y'; }],
    ['EXPIRY_HEADROOM', i => { i.expiresAtUtc = '2030-01-01T00:59:59Z'; }],
    ...[uri + '?q=1', uri + '#a', uri.replace('https://', 'https://user@'),
      uri.replace('test.', 'other.'), uri.replace('/item/', '/wrong/'), uri.slice(0, -33)]
      .map(bad => ['INPUT_INVALID', i => { i.secretVolume.kvVersionedUri = bad; }]),
  ];
  for (const [code, mutate] of cases) {
    const i = structuredClone(input);
    mutate(i);
    assert.throws(() => parse(i), new RegExp(code));
  }
});

test('receipt hashes and optional fields', () => {
  const check = fields => {
    const bytes = Buffer.from(JSON.stringify(fields));
    return x.checkAuthorityReceipt(bytes, { ...input, authorityReceiptSha256: x.sha256Hex(bytes) });
  };
  check({ generation: 2, expiresAtUtc: input.expiresAtUtc });
  assert.throws(() => check({ generation: '3' }), /AUTHORITY_RECEIPT_MISMATCH/);
  assert.throws(() => check({ expiresAtUtc: '' }), /AUTHORITY_RECEIPT_MISMATCH/);
  assert.throws(() => x.checkAuthorityReceipt(Buffer.from('{}'), input), /AUTHORITY_RECEIPT_MISMATCH/);
  const generation = '9223372036854775807';
  const large = value => {
    const bytes = Buffer.from('{"generation":' + value + '}');
    x.checkAuthorityReceipt(bytes, { ...input, revisionSuffix: 'raaaaaaaa-g' + generation,
      authorityReceiptSha256: x.sha256Hex(bytes) });
  };
  large(generation);
  assert.throws(() => large('9223372036854775808'), /AUTHORITY_RECEIPT_MISMATCH/);
});

test('traffic, identity and plan binding', () => {
  const traffic = x.normalizeTraffic([{ revisionName: 'b' }, { revisionName: 'a', weight: 100 }]);
  assert.deepEqual(traffic, [...x.plannedTraffic('a'), { revisionName: 'b', label: null, latestRevision: false, weight: 0 }]);
  assert.throws(() => x.normalizeTraffic({}));
  assert.ok(x.trafficEquals(traffic, [...traffic].reverse()));
  const id = x.targetIdentity(target, 'test', '{}');
  assert.deepEqual(id, { name: 'test', resourceId: '/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg/providers/Microsoft.App/containerApps/app',
    containerName: null, policySha256: x.sha256Hex(x.canonicalJson(target)) });
  const data = { action: 'stage', target: id, expected: { traffic, activeRevisions: ['b', 'a'] }, args: { input } };
  const make = fields => x.planIds(x.envelope(fields));
  const plan = make(data);
  assert.deepEqual(plan, make(Object.fromEntries(Object.entries(data).reverse())));
  assert.equal(plan.p64, x.actionP64(plan.envelope));
  assert.match(plan.opId, /^op-[0-9a-f]{12}$/);
  assert.notEqual(plan.p64, make({ ...data, expected: { traffic: [{ ...traffic[0], weight: 99 }, traffic[1]] } }).p64);
  assert.equal(x.x4Phrase('app', 'stage', plan.opId, plan.p64), ['app', 'stage', plan.opId, plan.p64].join(':'));
});

test('volume patch, update argv and narrow metadata', () => {
  const other = { name: 'other', storageType: 'AzureFile', storageName: 'files', mountOptions: 'ro' };
  const old = { name: decl.name, storageType: 'Secret', secrets: [{ secretRef: 'previous', path: decl.path }] };
  const body = x.volumePatchBody([other, old], decl, input.secretVolume.alias, input.revisionSuffix);
  const template = body.properties.template;
  assert.equal(template.revisionSuffix, input.revisionSuffix + '-v');
  assert.equal(JSON.stringify(template.volumes[1]), JSON.stringify(other));
  assert.deepEqual(template.volumes[0], { ...old, secrets: [{ secretRef: 'authority-g2', path: decl.path }] });
  assert.ok(x.volumePatchNeeded([old], decl, 'authority-g2'));
  assert.ok(!x.volumePatchNeeded(template.volumes, decl, 'authority-g2'));
  for (const bad of [{ ...other, containers: [] }, { ...old, secrets: [{ path: 'a', secretRef: 'b', env: [] }] }]) {
    assert.throws(() => x.volumePatchBody([bad], decl, 'authority-g2', input.revisionSuffix), /VOLUME_SHAPE_UNKNOWN/);
  }
  JSON.stringify(body, (key, value) => {
    assert.ok(!['configuration', 'containers', 'env'].includes(key));
    return value;
  });
  assert.equal(x.X4_ARM_API_VERSION, '2025-07-01');
  assert.deepEqual(x.volumePatchArgs(target, '/tmp/body'), ['rest', '--method', 'PATCH', '--url',
    'https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg/providers/Microsoft.App/containerApps/app?api-version=2025-07-01',
    '--body', '@/tmp/body', '-o', 'none', '--only-show-errors']);
  for (const path of ['relative', '/bad path', '/bad@path']) assert.throws(() => x.volumePatchArgs(target, path));
  assert.throws(() => x.volumePatchArgs({ ...target, app: 'bad/name' }, '/tmp/body'));
  const args = x.x4UpdateArgs({ ...target, container: 'api' }, 'image', input.revisionSuffix, input);
  assert.deepEqual(args, ['containerapp', 'update', '--subscription', '12345678-1234-1234-1234-123456789abc', '--resource-group', 'rg', '--name', 'app',
    '--image', 'image', '--revision-suffix', input.revisionSuffix, '--set-env-vars', 'ENV=TEST', 'N=2', 'R=2', 'WEB=' + sha,
    'Token=secretref:ref-one', '--container-name', 'api', '-o', 'none', '--only-show-errors']);
  for (const flag of ['--replace-env-vars', '--remove-env-vars', '--remove-all-env-vars', '--yaml', '--secret-volume-mount']) {
    assert.ok(!args.includes(flag));
  }
  for (const builder of [x.appVaultRefsArgs, x.appVolumesArgs, x.appMountsArgs, x.appLatestArgs, x.revisionMetaArgs, x.revisionListArgs]) {
    const argv = builder({ ...target, container: 'api' }, 'app--revision');
    const query = argv[argv.indexOf('--query') + 1];
    assert.doesNotMatch(query, /\bvalue\b/);
    assert.deepEqual(argv.slice(-2), ['-o', 'json']);
  }
  assert.ok(x.appMountsArgs(target).includes('--query'));
  assert.ok(x.appMountsArgs(target).includes('properties.template.containers[0].volumeMounts[].{volumeName:volumeName,mountPath:mountPath}'));
  assert.ok(x.appMountsArgs({ ...target, container: 'api' }).includes("properties.template.containers[?name=='api'] | [0].volumeMounts[].{volumeName:volumeName,mountPath:mountPath}"));
});

test('post-update assertions and health expectations', () => {
  const alias = { name: input.secretVolume.alias, keyVaultUrl: input.secretVolume.kvVersionedUri, identity };
  const before = { env: [{ name: 'Old', secretRef: 'legacy' }] };
  const expectedVolumes = x.volumePatchBody([], decl, alias.name, input.revisionSuffix).properties.template.volumes;
  const after = { image: 'image', env: [...before.env.map(entry => ({ ...entry })), ...input.env.map(e => ({ name: e.name })),
    { name: 'Token', secretRef: 'ref-one' }], volumes: expectedVolumes,
  mounts: [{ volumeName: decl.name, mountPath: decl.mountPath }] };
  const data = { before, after, input, decl, imageRef: 'image', expectedVolumes,
    vaultBefore: [{ name: 'old', keyVaultUrl: 'old-uri', identity }],
    vaultAfter: [alias, { name: 'old', keyVaultUrl: 'old-uri', identity }] };
  x.checkRevisionSettings(data);
  x.checkAlias([alias], input);
  x.checkMount(after.mounts, decl);
  x.checkEnvCase(['N', 'Other'], input);
  assert.throws(() => x.checkAlias([], input), /ALIAS_NOT_PROVISIONED/);
  assert.throws(() => x.checkMount([], decl), /VOLUME_MOUNT_NOT_PROVISIONED/);
  assert.throws(() => x.checkEnvCase(['n'], input), /ENV_NAME_CASE_COLLISION/);
  for (const mutate of [
    d => { delete d.after.env[0].secretRef; },
    d => { d.vaultAfter[1].keyVaultUrl = 'changed-private-uri'; },
    d => { d.after.mounts = []; },
    d => { d.vaultAfter[0].keyVaultUrl = 'wrong-private-uri'; },
  ]) {
    const d = structuredClone(data);
    mutate(d);
    assert.throws(() => x.checkRevisionSettings(d), e => /^REVISION_SETTINGS_MISMATCH:/.test(e.message) &&
      !/private-uri|legacy/.test(e.message));
  }
  x.checkHealthExpect({ web: { sha } }, { 'web.sha': '{webPin}' }, { webPin: sha });
  assert.throws(() => x.checkHealthExpect({}, { 'web.sha': '{webPin}' }, { webPin: sha }),
    { message: 'HEALTH_EXPECT_MISMATCH: web.sha' });
});

test('ordered reconcile rules and determinism', () => {
  const before = x.plannedTraffic('old');
  const after = x.plannedTraffic('candidate');
  const op = { expected: { traffic: before }, args: { candidateRevision: 'candidate', intermediateRevision: 'intermediate',
    restoreRevision: 'candidate', retireRevision: 'retire', resultingTraffic: after } };
  const intermediate = { exists: true, active: true, weight: 0, matchesExpected: true, latest: true };
  const defaults = { readable: true, traffic: before, latest: 'old', labels: [], revisions: { intermediate }, candidateHealthy: true, restoreHealthy: true };
  const cases = [
    [{ step: 'switched' }, { readable: false }, 'drift', null],
    [{ step: 'failed' }, { labels: ['test'] }, 'drift', null],
    [{ step: 'switched' }, { traffic: x.plannedTraffic('unrelated') }, 'drift', null],
    [{ step: 'failed' }, {}, 'failed-before-write', null],
    [{ action: 'stage', step: 'intent', write: 'volume-patch', beforeLatest: 'old' }, { revisions: {} }, 'drift', null],
    [{ action: 'renew-authority', step: 'intent', write: 'volume-patch' }, {}, 'intermediate-only', 'finish-stage'],
    [{ action: 'stage', step: 'intent', write: 'volume-patch' }, { revisions: { intermediate: { ...intermediate, weight: 1 } } }, 'drift', null],
    [{ step: 'intermediate' }, {}, 'intermediate-only', 'finish-stage'],
    [{ step: 'intent', write: 'update' }, { revisions: { candidate: { exists: true } } }, 'staged-unverified', 'reverify-stage'],
    [{ step: 'intent', write: 'update' }, { revisions: {} }, 'drift', null],
    [{ step: 'revision-created' }, {}, 'staged-unverified', 'reverify-stage'],
    [{ action: 'stage', step: 'verified' }, {}, 'intermediate-left', 'deactivate-intermediate'],
    [{ action: 'stage', step: 'intent', write: 'deactivate' }, { revisions: {} }, 'staged', null],
    [{ step: 'switch-intent' }, { traffic: after }, 'switch-applied-unrecorded', 'record-switch'],
    [{ step: 'switch-intent' }, { traffic: [...after, { revisionName: 'old', weight: 0 }] },
      'switch-applied-unrecorded', 'record-switch'],
    [{ step: 'switch-intent' }, { traffic: [...after, { revisionName: 'unknown', weight: 0 }] }, 'drift', null],
    [{ step: 'switch-intent' }, { traffic: [...after, { revisionName: 'old', weight: 0, latestRevision: true }] }, 'drift', null],
    [{ step: 'switch-intent' }, {}, 'switch-not-applied', null],
    [{ step: 'switch-intent' }, { traffic: after, candidateHealthy: false }, 'drift', null],
    [{ step: 'rollback-intent' }, { traffic: after }, 'rollback-applied-unrecorded', 'record-rollback'],
    [{ step: 'rollback-intent' }, {}, 'rollback-not-applied', null],
    [{ step: 'rollback-intent' }, { traffic: after, restoreHealthy: false }, 'drift', null],
    [{ action: 'withdraw', step: 'intent' }, { revisions: { retire: { exists: true, active: true, weight: 0 } } }, 'deactivate-pending', 'retry-deactivate'],
    [{ action: 'cleanup', step: 'intent' }, { revisions: { retire: { exists: true, active: false } } }, 'deactivate-done-unrecorded', 'record-deactivated'],
    [{ action: 'cleanup', step: 'intent' }, {}, 'drift', null],
    [{ step: 'switched' }, {}, 'switched', null],
  ];
  for (const [entry, observed, state, step] of cases) {
    const args = { entries: [entry], observed: { ...defaults, ...observed }, op };
    const result = x.reconcile(args);
    assert.deepEqual([result.state, result.step], [state, step]);
    assert.ok(Array.isArray(result.revisions));
    assert.deepEqual(result, x.reconcile(args));
  }
  assert.equal(x.reconcile({ entries: [{ step: 'intent', write: 'update' }, { step: 'failed' }],
    observed: defaults, op }).state, 'failed');
});

test('volume PATCH omits null keys and uses the same comparison order as revision verification', () => {
  const other = { name: 'other', storageType: 'Secret', storageName: null, secrets: [
    { secretRef: 'z', path: 'z' }, { secretRef: 'a', path: 'a' }, { secretRef: null, path: 'b' },
  ] };
  const expectedOther = { name: 'other', storageType: 'Secret', secrets: [
    { secretRef: 'a', path: 'a' }, { path: 'b' }, { secretRef: 'z', path: 'z' },
  ] };
  const { volumes } = x.volumePatchBody([other], decl, input.secretVolume.alias, input.revisionSuffix).properties.template;
  assert.deepEqual(volumes.find(volume => volume.name === other.name), expectedOther);
  assert.deepEqual(x.normalizeVolumes([other]), [expectedOther]);

  const alias = { name: input.secretVolume.alias, keyVaultUrl: input.secretVolume.kvVersionedUri, identity };
  x.checkRevisionSettings({
    before: { env: [] },
    after: {
      env: [...input.env.map(({ name }) => ({ name })), ...input.envRefs.map(({ name, appRef }) => ({ name, secretRef: appRef }))],
      volumes: [...volumes].reverse().map(volume => volume.name === other.name ? other : volume),
      image: 'image', mounts: [{ volumeName: decl.name, mountPath: decl.mountPath }],
    },
    input, decl, imageRef: 'image', expectedVolumes: volumes, vaultBefore: [alias], vaultAfter: [alias],
  });
});

test('switch intent reconciles against the switch envelope despite a different stage snapshot', () => {
  const stageTraffic = x.plannedTraffic('stage-serving');
  const switchTraffic = x.plannedTraffic('switch-serving');
  const resultingTraffic = x.plannedTraffic('candidate');
  const entries = [
    { action: 'stage', step: 'verified', expected: { traffic: stageTraffic } },
    { action: 'switch', step: 'intent', write: 'traffic' },
  ];
  const op = { action: 'switch', expected: { traffic: switchTraffic }, args: { candidateRevision: 'candidate', resultingTraffic } };
  const observed = { readable: true, revisions: {}, candidateHealthy: true };
  for (const [traffic, state] of [
    [stageTraffic, 'drift'], [switchTraffic, 'switch-not-applied'], [resultingTraffic, 'switch-applied-unrecorded'],
  ]) {
    assert.equal(x.reconcile({ entries, observed: { ...observed, traffic }, op }).state, state);
  }
});

test('PATCH target rejects dot segments and non-GUID subscriptions', () => {
  const valid = { ...target, subscription: '12345678-1234-1234-1234-123456789abc' };
  for (const [key, value] of [['subscription', 'sub'], ['resourceGroup', '.'], ['resourceGroup', '..'], ['app', '..']])
    assert.throws(() => x.volumePatchArgs({ ...valid, [key]: value }, '/tmp/body'), /invalid patch target/);
});

test('INTERFACE state and journal tables match the X4 constants', () => {
  const doc = readFileSync(new URL('../references/deploy-x4.md', import.meta.url), 'utf8');
  const states = doc.split('## 9. ')[1].split('## 10. ')[0].split('\n')
    .filter(line => line.startsWith('| `')).flatMap(line => [...line.split('|')[1].matchAll(/`([a-z-]+)`/g)].map(match => match[1]));
  const list = doc.split('## 10. ')[1].match(/`step` \(([^)]+)\)/)[1];
  const steps = [...list.matchAll(/`([a-z-]+)`/g)].map(match => match[1]);
  assert.deepEqual(states.sort(), [...x.X4_STATES].sort());
  assert.deepEqual(steps.sort(), [...x.X4_STEPS].sort());
});
