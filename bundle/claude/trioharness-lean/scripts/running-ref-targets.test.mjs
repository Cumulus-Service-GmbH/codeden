import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { checkRunningRef, gitIn, readVerifiedRecord, recordRunningRef, runningRefReason } from './running-ref.mjs';
import { isProtectedClass, probePlan, readAzureTargets } from './running-ref-targets.mjs';
import { azureFile, checkCli, defaultAzure, envFile, g, H, mkRepo, publish, targetNames, targetRepo } from './running-ref-fixture.mjs';

const selected = ['test', 'qa'];
const selectedFlag = ['--target=test,qa'];
const subscriptionGuid = '01234567-89AB-CDEF-0123-456789abcdef';
const deployFile = (r, targets) => {
  mkdirSync(join(r.work, '.trioharness'), { recursive: true });
  writeFileSync(join(r.work, '.trioharness', 'deploy.json'), JSON.stringify({ targets }));
};
const environments = (r, urls) => envFile(r.work, {
  schema: 1, environments: Object.fromEntries(Object.entries(urls).map(([name, url]) => [
    name, { health: { ...H(name), url } }
  ]))
});
async function refused(r, options, pattern) {
  const probes = [];
  await assert.rejects(checkRunningRef(r.work, {
    ...r, ...options, readSha: h => { probes.push(h.url); return { ok: true, sha: r.c3 }; }
  }), pattern);
  assert.deepEqual(probes, []);
}

test('both CLI modes read remote default, ignore origin/HEAD and local edits, and preserve receipt output', async () => {
  const r = targetRepo();
  g(r.work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat');
  environments(r, { test: 'https://local-edit.invalid/health' });
  for (const [args, names] of [[[], targetNames], [selectedFlag, selected]]) {
    const result = await checkCli(r, args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.probes, names.map(name => H(name).url));
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.branch, 'main');
    assert.equal(receipt.base, r.c3);
    assert.equal(receipt.verdict, 'ok');
    assert.deepEqual(receipt.envs, names.map(name => ({ name, status: 'same', sha: r.c3.slice(0, 12) })));
    if (args.length) {
      assert.equal(receipt.prdProbes, undefined);
      assert.deepEqual(receipt.omittedProd, ['prd']);
      assert.equal(receipt.omittedProdLine, `prod targets omitted by scope (azure-targets.json): prd; default branch main@${r.c3.slice(0, 12)} via ls-remote`);
    } else {
      assert.equal(receipt.prdProbes.length, 1);
      assert.match(receipt.prdProbes[0], /^prd read-only probe: prd https:\/\/prd\/health at \d{4}-\d\d-\d\dT[^ ]+, user-approved full check$/);
      assert.deepEqual(result.stderr.split('\n').filter(line => line.includes('prd read-only probe:')),
        [`RUNNING-REF: ${receipt.prdProbes[0]}`]);
    }
    assert.equal(runningRefReason(r.work, 'selected', r), null);
  }
  for (const args of [[], selectedFlag]) {
    for (const [flags, reason] of [
      [['--default=feat'], /RUNNING_REF_DEFAULT_MISMATCH/], [['--remote', 'other'], /RUNNING_REF_REMOTE_FIXED/]
    ]) {
      const result = await checkCli(r, [...args, ...flags]);
      assert.equal(result.status, 3);
      assert.match(result.stderr, reason);
      assert.deepEqual(result.probes, []);
    }
  }
});

test('remote lookup, fetch race, unreadable manifests, and a moved default block', async () => {
  const r = targetRepo();
  assert.equal((await checkCli(r, selectedFlag)).status, 0);
  const git = gitIn(r.work);
  for (const [override, reason] of [
    [args => { if (args.includes('fetch')) throw new Error('fetch failed'); return git(args); }, /RUNNING_REF_FETCH_FAILED/],
    [args => { const out = git(args); return args.includes('ls-remote') ? out.replace(r.c3, 'f'.repeat(40)) : out; }, /RUNNING_REF_DEFAULT_MISMATCH/],
    [args => { if (args.includes('show')) throw new Error('I/O error'); return git(args); }, /RUNNING_REF_DEFAULT_UNREADABLE/]
  ]) {
    await refused(r, { targets: selected, git: override }, reason);
    assert.match(runningRefReason(r.work, 'selected', { ...r, git: override }), reason);
  }
  r.commit('later.txt');
  g(r.work, 'push', '-q', 'origin', 'main');
  assert.match(runningRefReason(r.work, 'selected', r), /remote default is now main@/);
  g(r.work, 'remote', 'set-url', 'origin', join(r.work, 'missing-origin.git'));
  await refused(r, {}, /RUNNING_REF_REMOTE_UNREADABLE/);
  assert.match(runningRefReason(r.work, 'missing', r), /RUNNING_REF_REMOTE_UNREADABLE/);
});

test('missing receipts use remote declarations and local declarations can only add strictness', () => {
  const r = targetRepo();
  g(r.work, 'rm', '.trioharness/environments.json');
  assert.match(runningRefReason(r.work, 'missing', r), /not signed.*Run check again/);
  g(r.work, 'remote', 'rename', 'origin', 'upstream');
  assert.match(runningRefReason(r.work, 'missing', r), /RUNNING_REF_REMOTE_UNREADABLE/);
  g(r.work, 'remote', 'remove', 'upstream');
  assert.equal(runningRefReason(r.work, 'missing', r), null);
  assert.match(runningRefReason(join(r.work, '..'), 'missing', r), /RUNNING_REF_REMOTE_UNREADABLE/);
  environments(r, { test: H('test').url });
  assert.match(runningRefReason(r.work, 'missing', r), /not signed/);
});

test('working-tree-only environments block with a merge instruction even with a signed receipt', async () => {
  const r = mkRepo();
  environments(r, { test: H('test').url });
  const reason = 'environments are declared only in the working tree, not on origin/main: push them (merge) first, then run the check again';
  const check = await checkCli(r);
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(check.probes, []);
  assert.equal(readVerifiedRecord(r.work, 'selected', r).configured, false);
  assert.equal(runningRefReason(r.work, 'selected', r), reason);
  assert.equal(runningRefReason(r.work, 'missing', r), reason);
});

test('full receipts must match the current remote default branch and SHA', async () => {
  const r = targetRepo();
  assert.equal((await checkCli(r)).status, 0);
  assert.equal(runningRefReason(r.work, 'selected', r), null);

  const remote = g(r.work, 'remote', 'get-url', 'origin');
  g(r.work, 'push', '-q', 'origin', 'main:alternate');
  g(remote, 'symbolic-ref', 'HEAD', 'refs/heads/alternate');
  assert.match(runningRefReason(r.work, 'selected', r), /remote default is now alternate@.*Run the check again/);

  g(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  r.commit('later.txt');
  g(r.work, 'push', '-q', 'origin', 'main');
  assert.match(runningRefReason(r.work, 'selected', r), /remote default is now main@.*Run the check again/);
});

test('both modes ignore replacement objects from a repo subdirectory and use redirect-error GETs', async () => {
  const r = targetRepo();
  const real = g(r.work, 'rev-parse', `${r.c3}:.trioharness/environments.json`);
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: r.work, input: '{"schema":1,"environments":{}}', encoding: 'utf8'
  }).trim();
  g(r.work, 'replace', real, blob);
  const subdir = join(r.work, 'frontend');
  mkdirSync(subdir);
  const calls = [];
  const git = args => { calls.push(args); return gitIn(subdir)(args); };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push([url, options.redirect, options.method]);
    return { ok: true, text: async () => JSON.stringify({ commit: r.c3 }) };
  };
  try {
    for (const targets of [undefined, selected]) {
      const result = await checkRunningRef(subdir, { ...r, targets, git });
      assert.deepEqual(result.envs.map(e => e.name), targets || targetNames);
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.ok(calls.length && calls.every(args => args[0] === '--no-replace-objects'));
  assert.deepEqual(requests, [...targetNames, ...selected].map(name => [H(name).url, 'error', 'GET']));
});

test('WebChatMobile TEST-only cut-over probes only TEST and requires PRD classification', async () => {
  const r = targetRepo();
  const testTarget = 'mobile-api-test';
  const prodTarget = 'mobile-api-prod';
  const testHealth = H('mobile-api-test.example.invalid');
  const prodHealth = H('mobile-api-prod.example.invalid');
  deployFile(r, {
    [testTarget]: { app: testTarget, health: testHealth },
    [prodTarget]: { app: prodTarget, health: prodHealth }
  });
  environments(r, { [testTarget]: testHealth.url, [prodTarget]: prodHealth.url });
  publish(r);

  const azureTargets = {
    test: { apps: [{ name: testTarget }], deployTargets: [{ name: testTarget }] },
    prd: { apps: [{ name: prodTarget }], deployTargets: [{ name: prodTarget }] }
  };
  const configured = { ...r, azureTargetsFile: azureFile(azureTargets) };
  const targets = [testTarget];
  const probes = [];
  const receipt = await checkRunningRef(r.work, {
    ...configured, targets,
    readSha: health => { probes.push(health.url); return { ok: true, sha: r.c3 }; }
  });
  assert.deepEqual(probes, [testHealth.url]);
  assert.deepEqual(receipt.omittedProd, [prodTarget]);
  recordRunningRef(r.work, 'selected', receipt, { keyFile: r.keyFile });
  assert.equal(runningRefReason(r.work, 'selected', configured), null);

  await refused(r, {
    targets, azureTargetsFile: azureFile({ ...azureTargets, prd: {} })
  }, /RUNNING_REF_OMITTED_NOT_PRD: mobile-api-prod \(unknown\)/);
});

test('app matches classify selected and omitted targets, including an ordinary __proto__ target', async () => {
  const r = mkRepo();
  deployFile(r, {
    preview: { app: 'MOBILE-API-TEST', health: H('preview') },
    live: { app: 'MOBILE-API-PROD', health: H('live') },
    ['__proto__']: { app: 'proto-app', health: H('proto') }
  });
  publish(r);
  await refused(r, { targets: ['preview'] }, /OMITTED_NOT_PRD: __proto__ \(unknown\)/);
  const azureTargetsFile = azureFile({
    ...defaultAzure,
    prd: { apps: [{ name: 'mobile-api-prod', subscription: subscriptionGuid, resourceGroup: 'rg-prd' }] },
    shared: {}, qa: { apps: [{ name: 'proto-app' }] }
  });
  const configured = { ...r, azureTargetsFile };
  const check = await checkCli(configured, ['--target=preview,__proto__']);
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(check.probes, [H('preview').url, H('proto').url]);
  assert.deepEqual(JSON.parse(check.stdout).omittedProd, ['live']);
  assert.equal(runningRefReason(r.work, 'selected', configured), null);
  assert.match(runningRefReason(r.work, 'selected', {
    ...configured, azureTargetsFile: azureFile({ ...defaultAzure, prd: {}, qa: { apps: [{ name: 'proto-app' }] } })
  }), /OMITTED_NOT_PRD: live \(unknown\)/);
  await refused(r, { ...configured, targets: ['live'] }, /SELECTED_NOT_NONPRD: live \(prd\)/);
});

test('conflict and unknown cannot be selected or omitted; prd patterns count', async () => {
  const r = targetRepo();
  const azureTargetsFile = azureFile({
    prd: { patterns: [{ regex: '^prd$', scope: 'fixture' }], apps: [{ name: 'test' }] },
    test: { apps: [{ name: 'test' }] }
  });
  await refused(r, { azureTargetsFile, targets: ['test', 'qa'] }, /SELECTED_NOT_NONPRD: test \(conflict\), qa \(unknown\)/);
  await refused(r, { azureTargetsFile, targets: ['prd'] }, /OMITTED_NOT_PRD: test \(conflict\), qa \(unknown\)/);
  await refused(r, {
    azureTargetsFile: azureFile({ ...defaultAzure, shared: { resources: [{ name: 'qa' }] } }),
    targets: selected
  }, /SELECTED_NOT_NONPRD: qa \(conflict\)/);
  const check = await checkCli({ ...r, azureTargetsFile });
  assert.equal(check.status, 0, check.stderr);
  const { prdProbes } = JSON.parse(check.stdout);
  assert.match(prdProbes[0], /prd read-only probe: test .*user-approved full check \(classification conflict\)$/);
  assert.match(prdProbes[1], /prd read-only probe: prd .*user-approved full check$/);
  const calls = [];
  const result = await checkRunningRef(r.work, {
    ...r, azureTargetsFile, log: line => calls.push(line),
    readSha: health => { calls.push(health.url); return { ok: true, sha: r.c3 }; }
  });
  assert.deepEqual(calls, [result.prdProbes[0], H('test').url, H('qa').url, result.prdProbes[1], H('prd').url]);
});

test('uppercase prd patterns block conflicting app selections and log pattern-only prd probes', async () => {
  const r = mkRepo();
  deployFile(r, { qa: { app: 'billing-PRD' } });
  environments(r, { qa: H('qa').url, 'ledger-prd': H('ledger').url });
  publish(r);
  const azureTargetsFile = azureFile({
    prd: { patterns: [{ regex: '-PRD$', scope: 'fixture' }] },
    qa: { deployTargets: [{ name: 'qa' }] }
  });
  await refused(r, { azureTargetsFile, targets: ['qa'] }, /RUNNING_REF_SELECTED_NOT_NONPRD: qa \(conflict\)/);
  const check = await checkCli({ ...r, azureTargetsFile });
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(check.probes, [H('qa').url, H('ledger').url]);
  const { prdProbes } = JSON.parse(check.stdout);
  assert.match(prdProbes[1], /^prd read-only probe: ledger-prd .*user-approved full check$/);
  assert.ok(check.stderr.includes(`RUNNING-REF: ${prdProbes[1]}`));
});

test('app subscriptions must be GUID strings and other entry keys stay strict', async () => {
  const r = targetRepo();
  for (const [prd, reason] of [
    [{ apps: [{ name: 'prd', subscription: 'invalid' }] }, /prd\.apps\[0\]\.subscription must be a subscription GUID/],
    [{ apps: [{ name: 'prd', subscription: null }] }, /prd\.apps\[0\]\.subscription must be a subscription GUID/],
    [{ resources: [{ name: 'prd', subscription: subscriptionGuid }] }, /unknown key "prd\.resources\[0\]\.subscription"/],
    [{ apps: [{ name: 'prd', resourceGroup: ' ' }] }, /prd\.apps\[0\]\.resourceGroup must be a non-empty string/],
    [{ apps: [{ name: 'prd', resourceGroup: 7 }] }, /prd\.apps\[0\]\.resourceGroup must be a string/],
    [{ resources: [{ name: 'prd', resourceGroup: 'rg-prd' }] }, /unknown key "prd\.resources\[0\]\.resourceGroup"/],
    [{ apps: [{ name: 'prd', subscription: subscriptionGuid, nmae: 'other' }] }, /unknown key "prd\.apps\[0\]\.nmae"/]
  ]) {
    await refused(r, { azureTargetsFile: azureFile({ ...defaultAzure, prd }) }, error =>
      error.message.includes('RUNNING_REF_CLASSIFICATION_UNREADABLE') && reason.test(error.message));
  }
});

test('strict allowlist rejects malformed fields throughout the file without probing', async () => {
  const r = targetRepo();
  for (const [bad, path] of [
    [{ prd: { deployTarget: [{ name: 'prd' }] } }, 'prd.deployTarget'],
    [{ prod: {} }, 'prod'],
    [{ version: 2 }, 'version'],
    [{ prd: { patterns: [{ regex: 'a', scope: 'a', flags: 'i' }] } }, 'prd.patterns[0].flags'],
    [{ prd: { patterns: [{ regex: '[', scope: 'a' }] } }, 'prd.patterns[0].regex'],
    [{ prd: { patterns: [{ regex: 'a', scope: '' }] } }, 'prd.patterns[0].scope'],
    [{ prd: { apps: { name: 'prd' } } }, 'prd.apps'],
    [{ prd: { apps: [{ name: 'a', nmae: 'b' }] } }, 'prd.apps[0].nmae'],
    [{ prd: { apps: [{ source: 'a' }] } }, 'prd.apps[0].name'],
    [{ test: { databases: [{ name: 'x', server: false }] } }, 'test.databases[0].server'],
    [{ shared: { subscriptions: [false] } }, 'shared.subscriptions[0]'],
    [{ comment: false }, 'comment']
  ]) {
    const azureTargetsFile = azureFile({ ...defaultAzure, ...bad });
    const reason = error => error.message.includes('RUNNING_REF_CLASSIFICATION_UNREADABLE') && error.message.includes(path);
    await refused(r, { azureTargetsFile }, reason);
    await refused(r, { azureTargetsFile, targets: selected }, reason);
  }
  await refused(r, { azureTargetsFile: join(r.work, 'missing.json') }, /RUNNING_REF_CLASSIFICATION_UNREADABLE: .*missing/);
});

test('raw deploy URL is protected even when overridden, with hostname-only matching', async () => {
  const r = mkRepo();
  deployFile(r, { prd: { health: { ...H('prd'), url: 'https://API.prod.invalid.:443/other' } } });
  for (const url of ['https://api.prod.invalid:8443/health', 'https://api.prod.invalid/different']) {
    environments(r, { prd: H('new-prod.invalid').url, test: url, qa: H('qa').url });
    publish(r);
    for (const targets of [undefined, selected]) {
      await refused(r, { targets }, /RUNNING_REF_PRD_HOST: test .*prd target prd/);
    }
  }
  await refused(r, { azureTargetsFile: azureFile({ prd: defaultAzure.prd }) }, /RUNNING_REF_PRD_HOST: test .*prd target prd/);
});

test('refuses an IPv4-mapped IPv6 health host matching a prd IPv4 host', async () => {
  const r = mkRepo();
  environments(r, { prd: 'http://10.0.0.5/health', test: 'http://[::ffff:10.0.0.5]/health', qa: H('qa').url });
  publish(r);
  await refused(r, { targets: selected }, /RUNNING_REF_PRD_HOST: test .*prd target prd/);
});

test('protect prd first labels and IPv6 hostnames, and reject malformed raw prd URLs', async () => {
  const r = mkRepo();
  environments(r, { test: H('mobile-api-prod.azurewebsites.invalid').url, qa: H('qa').url, prd: H('different.invalid').url });
  publish(r);
  await refused(r, { targets: selected }, /RUNNING_REF_PRD_HOST: test .*prd name mobile-api-prod/);
  deployFile(r, { prd: { health: { ...H('prd'), url: 'https://[::1]:8443/old' } } });
  environments(r, { test: 'http://[0:0:0:0:0:0:0:1]/new', qa: H('qa').url, prd: H('different.invalid').url });
  publish(r);
  await refused(r, {}, /RUNNING_REF_PRD_HOST: test .*prd target prd/);
  deployFile(r, { prd: { health: { ...H('prd'), url: 'https://' } } });
  publish(r);
  await refused(r, {}, /ENVIRONMENTS_INVALID: prd.health.url/);
  await refused(r, { targets: selected }, /ENVIRONMENTS_INVALID: prd.health.url/);
});

test('the selected gate reclassifies targets and hosts and checks probe consistency', async () => {
  const r = targetRepo();
  const result = await checkCli(r, selectedFlag);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  for (const [extra, reason] of [
    [{ prd: { ...defaultAzure.prd, apps: [{ name: 'test' }] } }, /SELECTED_NOT_NONPRD: test \(conflict\)/],
    [{ prd: {} }, /OMITTED_NOT_PRD: prd \(unknown\)/],
    [{ prd: { ...defaultAzure.prd, databaseServers: [{ name: 'test' }] } }, /RUNNING_REF_PRD_HOST: test .*prd name test/]
  ]) {
    const azureTargetsFile = azureFile({ ...defaultAzure, ...extra });
    assert.match(runningRefReason(r.work, 'selected', { ...r, azureTargetsFile }), reason);
  }
  for (const [extra, reason] of [
    [{ envs: [] }, /record is inconsistent/],
    [{ envs: [{ name: 'test', status: 'fine' }, receipt.envs[1]] }, /unknown status/],
    [{ envs: [{ name: 'test', status: 'unmerged' }, receipt.envs[1]], blocking: false }, /ask the card/],
    [{ targets: [] }, /invalid selection/],
    [{ targets: ['test', 'test'] }, /invalid selection/],
    [{ selected: undefined }, /selection data without a valid selected flag/]
  ]) {
    recordRunningRef(r.work, 'selected', { ...receipt, ...extra }, r);
    assert.match(runningRefReason(r.work, 'selected', r), reason);
  }
});

test('full checks GET each allowed prd path and log the receipt line', async t => {
  const r = mkRepo();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url, options.method]);
    return { ok: true, text: async () => JSON.stringify({ commit: r.c3 }) };
  });
  for (const path of ['/health', '/api/health', '/build-info']) {
    const url = `https://prd.invalid${path}`;
    environments(r, { prd: url });
    publish(r);
    const lines = [];
    const result = await checkRunningRef(r.work, { ...r, log: line => lines.push(line) });
    assert.equal(result.verdict, 'ok');
    assert.match(result.prdProbes[0], /^prd read-only probe: prd .*user-approved full check$/);
    assert.ok(result.prdProbes[0].includes(`prd ${url} at `));
    assert.deepEqual(lines, result.prdProbes);
    assert.deepEqual(requests.splice(0), [[url, 'GET']]);
  }
});

test('unsafe prd and conflict paths refuse the entire check before any probe', async () => {
  const r = targetRepo();
  for (const [path, conflict] of [
    ['/version', false], ['/health?x=1', false], ['/health/extra', false],
    ['/health#fragment', false], ['/health?', false], ['/health#', false], ['/admin', true]
  ]) {
    const url = `https://prd.invalid${path}`;
    environments(r, { test: H('test').url, qa: H('qa').url, prd: url });
    publish(r);
    const azureTargetsFile = conflict
      ? azureFile({ ...defaultAzure, shared: { resources: [{ name: 'prd' }] } })
      : r.azureTargetsFile;
    const reason = `RUNNING_REF_PRD_PATH: prd probes ${url}; prd probes may only GET /health, /api/health or /build-info`;
    await refused(r, { azureTargetsFile }, { message: reason });
    if (!conflict) {
      const result = await checkCli(r, selectedFlag);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.probes, selected.map(name => H(name).url));
      assert.equal(runningRefReason(r.work, 'selected', r), null);
    }
  }
});

test('a full check refuses an unclassified /version before any probe', async () => {
  const r = mkRepo();
  const url = 'https://preview.invalid/version';
  environments(r, { test: H('test').url, preview: url });
  publish(r);
  await refused(r, {}, {
    message: `RUNNING_REF_UNCLASSIFIED_PATH: preview probes ${url}; unclassified targets may only GET /health, /api/health or /build-info (classify it in ~/.config/trioharness/azure-targets.json to probe another path)`
  });
});

for (const [kind, name, url] of [
  ['unclassified', 'preview', 'https://preview.invalid/health'],
  ['nonprd', 'test', 'https://test.invalid/version']
]) {
  test(`a full check probes ${kind} targets at ${new URL(url).pathname}`, async () => {
    const r = mkRepo();
    environments(r, { [name]: url });
    publish(r);
    const result = await checkCli(r);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.probes, [url]);
  });
}

test('CLI refuses --include-prod with or without a value before probing', async () => {
  const r = targetRepo();
  for (const flag of ['--include-prod', '--include-prod=false']) {
    const result = await checkCli(r, [flag]);
    assert.equal(result.status, 3);
    assert.equal(result.stderr, 'RUNNING-REF: RUNNING_REF_INCLUDE_PROD_REFUSED: --include-prod is never supported; the full check already probes prd read-only at /health, /api/health or /build-info\n');
    assert.equal(result.stdout, '');
    assert.deepEqual(result.probes, []);
  }
});

const evidenceGrant = { role: 'Reader', scope: '/subscriptions/fixture/resourceGroups/rg-fixture' };
const principalGrant = { ...evidenceGrant, principalId: subscriptionGuid };
const guardPrd = {
  grantPrincipals: [principalGrant],
  allowedCreates: ['fixture-create'],
  evidencePublisherGrants: [evidenceGrant],
  evidencePublisherPrincipalId: subscriptionGuid
};

test('guard PRD metadata parses without affecting names, hosts, or probe paths', () => {
  const config = {
    ...defaultAzure,
    comment: 'Synthetic Azure targets',
    prd: {
      ...defaultAzure.prd,
      patterns: [{ regex: '^live-', scope: 'fixture' }],
      databaseServers: [{ name: 'prod-db' }]
    },
    shared: { resources: [{ name: 'shared' }] }
  };
  const withGuard = { ...config, prd: { ...config.prd, ...guardPrd } };
  const baseline = azureFile(config);
  const extended = azureFile(withGuard);
  assert.deepEqual(readAzureTargets(extended), withGuard);
  const unprovisioned = { ...withGuard, prd: { ...withGuard.prd, evidencePublisherPrincipalId: null } };
  const unprovisionedFile = azureFile(unprovisioned);
  assert.deepEqual(readAzureTargets(unprovisionedFile), unprovisioned);

  const targets = Object.fromEntries(['prd', 'qa', 'test', 'live-app', 'shared', 'preview', 'fixture-create']
    .map(name => [name, { health: H(name) }]));
  targets.mobile = { app: 'MOBILE-API-PROD', health: H('mobile') };
  const read = entries => path => path === '.trioharness/deploy.json' ? JSON.stringify({ targets: entries }) : null;
  const plan = probePlan(read(targets), undefined, baseline);
  assert.deepEqual(probePlan(read(targets), undefined, extended), plan);
  assert.deepEqual(probePlan(read(targets), undefined, unprovisionedFile), plan);
  assert.deepEqual([...plan.classes.values()], ['prd', 'nonprd', 'nonprd', 'prd', 'conflict', 'unknown', 'unknown', 'prd']);
  assert.deepEqual([...plan.classes].filter(([, kind]) => isProtectedClass(kind)).map(([name]) => name),
    ['prd', 'live-app', 'shared', 'mobile']);

  const selectedTargets = { prd: targets.prd, qa: targets.qa, test: targets.test, mobile: targets.mobile };
  assert.deepEqual(probePlan(read(selectedTargets), selected, extended), probePlan(read(selectedTargets), selected, baseline));

  for (const [name, url, reason] of [
    ['qa', 'https://prd/health', /RUNNING_REF_PRD_HOST/],
    ['qa', 'https://prod-db.example.invalid/health', /RUNNING_REF_PRD_HOST/],
    ['qa', 'https://mobile-api-prod.example.invalid/health', /RUNNING_REF_PRD_HOST/],
    ['prd', 'https://prd/version', /RUNNING_REF_PRD_PATH/],
    ['preview', 'https://preview/version', /RUNNING_REF_UNCLASSIFIED_PATH/]
  ]) {
    const manifest = read({ ...targets, [name]: { health: { ...H(name), url } } });
    let message;
    assert.throws(() => probePlan(manifest, undefined, baseline), error => {
      message = error.message;
      return reason.test(message);
    });
    assert.throws(() => probePlan(manifest, undefined, extended), { message });
    assert.throws(() => probePlan(manifest, undefined, unprovisionedFile), { message });
  }
});

const ownerAzureFile = join(userInfo().homedir, '.config', 'trioharness', 'azure-targets.json');
test('the installed Azure targets file parses read-only', { skip: !existsSync(ownerAzureFile) }, () => {
  let loaded = false;
  try {
    readAzureTargets();
    loaded = true;
  } catch {
    // Keep owner configuration details out of test output.
  }
  assert.ok(loaded, 'The installed Azure targets file must load.');
});

test('unknown Azure targets keys still fail closed', async () => {
  const r = targetRepo();
  for (const [config, reason] of [
    [{ somethingNew: true }, /unknown key "somethingNew"/],
    [{ prd: { ...guardPrd, somethingNew: true } }, /unknown key "prd\.somethingNew"/],
    [{ qa: { allowedCreates: [] } }, /unknown key "qa\.allowedCreates"/],
    [{ shared: { resources: [{ name: 'shared', somethingNew: true }] } }, /unknown key "shared\.resources\[0\]\.somethingNew"/]
  ]) {
    const result = await checkCli({ ...r, azureTargetsFile: azureFile(config) });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /RUNNING_REF_CLASSIFICATION_UNREADABLE/);
    assert.match(result.stderr, reason);
    assert.deepEqual(result.probes, []);
  }
});

test('malformed guard PRD metadata fails closed before any probe', async () => {
  const r = targetRepo();
  const badRolesAndScopes = [
    { ...evidenceGrant, role: ' ' }, { ...evidenceGrant, role: 1 },
    { ...evidenceGrant, scope: '' }, { ...evidenceGrant, scope: 'relative' }
  ];
  for (const [key, invalidValues] of Object.entries({
    grantPrincipals: [
      principalGrant, [evidenceGrant], [null], [{ ...principalGrant, principalId: 'bad' }],
      [{ ...principalGrant, principalId: 1 }], [{ ...principalGrant, extra: true }],
      ...badRolesAndScopes.map(grant => [{ ...principalGrant, ...grant }])
    ],
    allowedCreates: ['fixture-create', [''], [' '], [1]],
    evidencePublisherGrants: [
      evidenceGrant, [null], [{ role: 'Reader' }], [{ scope: evidenceGrant.scope }],
      [principalGrant], ...badRolesAndScopes.map(grant => [grant])
    ],
    evidencePublisherPrincipalId: ['', 'bad', 1, [subscriptionGuid]]
  })) {
    for (const value of invalidValues) {
      const config = { ...defaultAzure, prd: { ...defaultAzure.prd, [key]: value } };
      const result = await checkCli({ ...r, azureTargetsFile: azureFile(config) });
      assert.equal(result.status, 3, `${key} must reject ${JSON.stringify(value)}`);
      assert.match(result.stderr, /RUNNING_REF_CLASSIFICATION_UNREADABLE/);
      assert.ok(result.stderr.includes(`prd.${key}`), result.stderr);
      assert.doesNotMatch(result.stderr, new RegExp(`unknown key "prd\\.${key}"`));
      assert.deepEqual(result.probes, []);
    }
  }
});

test('owner-pinned AdminConsole staging build info does not relax production probes', () => {
  const app = 'erpure-adminconsole-staging';
  const url = 'https://erpure-adminconsole-staging.azurewebsites.net/build-info.txt';
  const prod = 'https://adminconsole.erpure.ai';
  const prd = {
    deployTargets: [{ name: 'prd' }],
    patterns: [{ regex: 'erpure', scope: 'unlisted-names' }]
  };
  const config = { prd, runningRefStaging: [{ name: app, url }] };
  const read = (stagingUrl = url, prodPath = '/build-info', stagingApp = app) => file => {
    const targets = {
      staging: { app: stagingApp, health: { url: stagingUrl, shaField: '.' } },
      prd: { app: 'erpure-adminconsole', health: { url: prod + prodPath, shaField: '.' } }
    };
    return file === '.trioharness/deploy.json' ? JSON.stringify({ targets }) : null;
  };
  const settings = azureFile(config);
  const selected = probePlan(read(), ['staging'], settings);
  assert.deepEqual([...selected.classes], [['staging', 'nonprd'], ['prd', 'prd']]);
  assert.deepEqual(selected.names, ['staging']);
  assert.throws(() => probePlan(read(url, '/build-info.txt'), undefined, settings),
    /RUNNING_REF_PRD_PATH: prd/);
  assert.throws(() => probePlan(read(), ['prd'], settings),
    /RUNNING_REF_SELECTED_NOT_NONPRD: prd \(prd\)/);
  for (const changed of [read(prod + '/build-info.txt'), read(url + '?query'), read(url, '/build-info', 'erpure-adminconsole')]) {
    assert.throws(() => probePlan(changed, undefined, settings), /RUNNING_REF_PRD_PATH: staging/);
  }
  for (const overrides of [
    { prd: { ...prd, apps: [{ name: app }] } },
    { prd: { ...prd, patterns: [...prd.patterns, { regex: app, scope: 'any-token' }] } },
    { shared: { resources: [{ name: app }] } },
    { runningRefStaging: [] }
  ]) {
    const guarded = azureFile({ ...config, ...overrides });
    assert.throws(() => probePlan(read(), undefined, guarded), /RUNNING_REF_PRD_PATH: staging/);
  }
});
