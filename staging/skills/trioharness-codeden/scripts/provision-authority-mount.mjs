#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const apiVersion = '2025-07-01';
const cli = args => execFileSync('az', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 64 * 1024,
  env: { ...process.env, AZURE_LOGGING_ENABLE_LOG_FILE: 'false', AZURE_CORE_COLLECT_TELEMETRY: 'false' },
});

function check(condition) {
  if (!condition) throw new Error('Authority mount precondition or readback failed');
}

function checkTraffic(properties, mount) {
  const config = properties?.configuration;
  const traffic = config?.ingress?.traffic;
  check(config?.activeRevisionsMode === 'Multiple' && Array.isArray(traffic) && traffic.length === 1);
  const [entry] = traffic;
  check(entry?.revisionName === mount.active[0] && entry.weight === 100 &&
    (entry.latestRevision === false || entry.latestRevision == null) && entry.label == null);
  const aliases = config.secrets?.filter(secret => secret.name === mount.alias);
  check(aliases?.length === 1 && aliases[0].keyVaultUrl === mount.secretUri &&
    aliases[0].identity?.toLowerCase() === mount.identity.toLowerCase());
}

function checkProdGrant(mount) {
  if (mount.app !== 'mobile-api-prod') return;
  const principal = 'd63529e0-761c-441b-8c71-a01560b42d99';
  const role = 'Key Vault Secrets User';
  const scope = mount.resourceId.split('/providers/')[0] +
    '/providers/Microsoft.KeyVault/vaults/kv-erpure-mobile-test/secrets/migration-authority-prod';
  const grants = JSON.parse(cli(['role', 'assignment', 'list', '--subscription', mount.subscription,
    '--assignee-object-id', principal, '--role', role, '--scope', scope, '--only-show-errors',
    '--query', '[].{principalId:principalId,roleDefinitionName:roleDefinitionName,scope:scope}', '-o', 'json']));
  check(grants.some(grant => grant.principalId === principal && grant.roleDefinitionName === role &&
    grant.scope?.toLowerCase() === scope.toLowerCase()));
}

function privateArm(mount) {
  const accessToken = cli(['account', 'get-access-token', '--subscription', mount.subscription,
    '--resource-type', 'arm', '--only-show-errors', '--query', 'accessToken', '-o', 'tsv']).trim();
  check(/^[A-Za-z0-9._~-]+$/.test(accessToken));
  return async (endpoint, method = 'GET', body, etag) => fetch(
    `https://management.azure.com${mount.resourceId}${endpoint}?api-version=${apiVersion}`, {
      method, body, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${accessToken}`, Accept: 'application/json',
        ...(method === 'PATCH' && { 'Content-Type': 'application/json', 'If-Match': etag }),
      },
    },
  );
}

async function readApp(request, mount) {
  const response = await request('');
  check(response.ok);
  const app = await response.json();
  check(app.id?.toLowerCase() === mount.resourceId.toLowerCase());
  checkTraffic(app.properties, mount);
  return { template: app.properties.template, etag: response.headers.get('etag') };
}

async function revisions(request, active) {
  const response = await request('/revisions');
  check(response.ok);
  const { value, nextLink } = await response.json();
  check(!nextLink && Array.isArray(value));
  const actual = value.filter(item => item.properties?.active === true).map(item => item.name);
  check(actual.length === active.length && active.every(name => actual.includes(name)));
  return value;
}

function patchTemplate(template, mount) {
  check(Array.isArray(template?.containers) && template.containers.length === 1);
  const [container] = template.containers;
  check(typeof container?.name === 'string' && typeof container.image === 'string');
  const volumes = template.volumes ?? [];
  const mounts = container.volumeMounts ?? [];
  check(Array.isArray(volumes) && !volumes.some(volume => volume.name === mount.volume));
  check(Array.isArray(mounts) && !mounts.some(item => item.volumeName === mount.volume || item.mountPath === mount.mountPath));

  const env = container.env?.map(item => {
    check(typeof item?.name === 'string');
    return Object.hasOwn(item, 'value') || Object.hasOwn(item, 'secretRef') ? item : { ...item, value: '' };
  });
  const addedVolume = { name: mount.volume, storageType: 'Secret', secrets: [{ secretRef: mount.alias, path: mount.file }] };
  const addedMount = { volumeName: mount.volume, mountPath: mount.mountPath };
  return {
    revisionSuffix: mount.suffix,
    volumes: [...volumes, addedVolume],
    containers: [{ ...container, ...(env && { env }), volumeMounts: [...mounts, addedMount] }],
  };
}

async function verifyRevision(request, mount, revision, expected) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await request(`/revisions/${revision}`);
    check(response.ok || response.status === 404);
    if (response.ok) {
      const { properties } = await response.json();
      check(properties?.provisioningState !== 'Failed');
      if (properties?.active === true && properties.provisioningState === 'Provisioned') {
        const template = properties.template;
        const volume = template?.volumes?.find(item => item.name === mount.volume);
        const container = template?.containers?.[0];
        check(volume?.storageType === 'Secret' && volume.secrets?.length === 1 &&
          volume.secrets[0].secretRef === mount.alias && volume.secrets[0].path === mount.file);
        check(template.containers.length === 1 && container.volumeMounts?.some(item =>
          item.volumeName === mount.volume && item.mountPath === mount.mountPath));
        const envRefs = list => JSON.stringify((list ?? []).map(item => [item.name, item.secretRef]).sort());
        check(envRefs(container.env) === envRefs(expected.containers[0].env));
        await readApp(request, mount);
        await revisions(request, [...mount.active, revision]);
        return;
      }
    }
    await delay(2000);
  }
  throw new Error('Authority mount revision did not become active');
}

try {
  const script = realpathSync(process.argv[1]);
  const home = userInfo().homedir;
  check(['trioharness-codeden', 'trioharness-lean'].some(skill =>
    script === join(home, '.claude', 'skills', skill, 'scripts', 'provision-authority-mount.mjs')));
  const { parseAuthorityMount, consumeAuthorityMountCard } = await import(
    pathToFileURL(join(home, '.claude/hooks/codeden-guard-prd-cards.mjs')).href);
  const args = process.argv.slice(2, -4);
  const [sessionFlag, session, claimFlag, claim] = process.argv.slice(-4);
  const mount = parseAuthorityMount(args);
  check(mount && sessionFlag === '--card-session' && claimFlag === '--card-claim' &&
    consumeAuthorityMountCard(args, session, claim));

  checkProdGrant(mount);
  const request = privateArm(mount);
  const revision = `${mount.app}--${mount.suffix}`;
  const before = await revisions(request, mount.active);
  check(!before.some(item => item.name === revision));
  const { template, etag } = await readApp(request, mount);
  check(etag && etag !== '*');
  const expected = patchTemplate(template, mount);
  const result = await request('', 'PATCH', JSON.stringify({ properties: { template: expected } }), etag);
  check(result.ok);
  await result.body?.cancel();
  await verifyRevision(request, mount, revision, expected);
  console.log(JSON.stringify({ app: mount.app, revision, trafficWeight: 0 }));
} catch {
  console.error('Authority mount failed. Verify revision and traffic before requesting another deploy card.');
  process.exitCode = 1;
}
