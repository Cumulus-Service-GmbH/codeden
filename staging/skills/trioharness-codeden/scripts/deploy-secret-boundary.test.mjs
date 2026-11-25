import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { checkLegacyAzArgv, LEGACY_AZ_POLICY, normalizeLegacyAzQuery } from './deploy.mjs';

const argvSeparator = /[\s'",`]+/.source;
const tokenChar = /[\w-]/.source;
const commandPatterns = LEGACY_AZ_POLICY.banned.map(family => family === 'rest' ? 'az rest' : family).map(family => [
  family, new RegExp(`(?<!${tokenChar})${family.split(' ').join(argvSeparator)}(?!${tokenChar})`),
]);
const restLiteral = /(['"`])rest\1/;
const localImports = /^\s*(?:import|export)\s+(?:[^'"`]*?\sfrom\s+)?['"](\.\/[^'"\n]+\.mjs)['"]|\bimport\s*\(\s*['"](\.\/[^'"\n]+\.mjs)['"]\s*\)/gm;

const x4Source = 'scripts/deploy-x4.mjs';
const x4Runner = 'scripts/deploy-x4-run.mjs';
const patchTarget = { subscription: '12345678-1234-1234-1234-123456789abc', resourceGroup: 'rg', app: 'app' };
const patchFile = '/tmp/body';
const patchUrlFor = t => `https://management.azure.com/subscriptions/${t.subscription}/resourceGroups/${t.resourceGroup}/providers/Microsoft.App/containerApps/${t.app}`;
const patchUrl = patchUrlFor(patchTarget);
const expectedPatchArgv = (t, path) => ['rest', '--method', 'PATCH', '--url', patchUrlFor(t) + '?api-version=2025-07-01',
  '--body', '@' + path, '-o', 'none', '--only-show-errors'];
const patchArgv = expectedPatchArgv(patchTarget, patchFile);
const patchDeclaration = /^export function volumePatchArgs\(target, bodyFile\) \{[\s\S]*?^\}/gm;

function patchArgvViolations(argv, target = patchTarget, path = patchFile) {
  return isDeepStrictEqual(argv, expectedPatchArgv(target, path)) ? [] : ['volumePatchArgs: unexpected PATCH argv'];
}

function commandViolations(source, label) {
  return commandPatterns.filter(([, pattern]) => pattern.test(source))
    .map(([family]) => `${label}: banned command family ${family}`);
}

function sourceViolations(source, name, patchArgs) {
  const violations = [];
  if (name === 'scripts/deploy.mjs') {
    const policy = source.match(/^export const LEGACY_AZ_POLICY = Object\.freeze\(\{[\s\S]*?^\}\);/m)?.[0];
    const string = /(?:'[^'\\\r\n]*'|"[^"\\\r\n]*")/.source;
    const array = String.raw`Object\.freeze\(\[\s*(?:${string}\s*,\s*)+\]\)`;
    const data = new RegExp(String.raw`^export const LEGACY_AZ_POLICY = Object\.freeze\(\{\s*banned: ${array},\s*queries: ${array},\s*\}\);$`);
    if (!policy || !data.test(policy)) violations.push(`${name}: LEGACY_AZ_POLICY must contain only frozen string arrays`);
    else source = source.replace(policy, policy.replace(new RegExp(string, 'g'), text => ' '.repeat(text.length)));
  }
  violations.push(...commandViolations(source, name));
  let restSource = source;
  if (name === x4Source) {
    const conditional = /\?|&&|\|\||\b(?:if|switch)\b/;
    const resource = /^function resourceId\(t\) \{[\s\S]*?^\}/m.exec(source)?.[0];
    if (resource && conditional.test(resource)) violations.push(`${name}: resourceId contains a conditional expression`);
    const builders = [...source.matchAll(patchDeclaration)];
    const argvErrors = patchArgvViolations(patchArgs);
    violations.push(...argvErrors);
    const [builder] = builders;
    if (builder) {
      const validation = [
        '  if (!matches(subscriptionGuid, target.subscription) ||',
        '      ![target.resourceGroup, target.app].every(segment => matches(armSegment, segment)) ||',
        String.raw`      !matches(/^\/[^\s@\0]+$/, bodyFile)) throw invalid('invalid patch target or body path');`,
      ].join('\n');
      const unchecked = builder[0].replace(' {\n' + validation + '\n', ' {\n')
        .replace('}?api-version=${X4_ARM_API_VERSION}', '}&api-version=${X4_ARM_API_VERSION}');
      if (conditional.test(unchecked))
        violations.push(`${name}: volumePatchArgs contains a conditional expression`);
    }
    if (builders.length !== 1 || !/\breturn \['rest',/.test(builder[0])
      || [...builder[0].matchAll(new RegExp(restLiteral.source, 'g'))].length !== 1) {
      violations.push(`${name}: expected exactly one rest literal in volumePatchArgs`);
    } else if (argvErrors.length === 0) {
      restSource = source.replace(builder[0], '');
    }
  }
  if (name === x4Runner) {
    const guard = [
      "    case 'volume-patch':",
      "      expected = ['rest', '--method', 'PATCH', '--url',",
      '        `https://management.azure.com/subscriptions/${target.subscription}/resourceGroups/${target.resourceGroup}/providers/Microsoft.App/containerApps/${target.app}?api-version=${X4_ARM_API_VERSION}`,',
      "        '--body', '@' + values[0], '-o', 'none', '--only-show-errors'];",
      '      break;',
    ].join('\n');
    restSource = restSource.replace(guard, '');
  }
  if (restLiteral.test(restSource)) violations.push(`${name}: banned rest argv token`);
  if (name === x4Source || name === x4Runner) {
    if (/(['"`])(?:create|onboard)\1/.test(source)) violations.push(`${name}: banned create/onboard argv literal`);
  }
  if (['scripts/deploy.mjs', x4Source, x4Runner].includes(name)) {
    violations.push(...literalQueryViolations(source, name));
  }
  return violations;
}

test('deploy sources stay within the secret-read boundary', async t => {
  const { volumePatchArgs } = await import('./deploy-x4.mjs');
  const patchArgs = volumePatchArgs(patchTarget, patchFile);
  const scripts = dirname(fileURLToPath(import.meta.url));
  const pending = ['deploy.mjs', 'boundary.mjs', 'deploy-x4.mjs', 'deploy-x4-run.mjs'].map(name => resolve(scripts, name));
  const scanned = new Set();
  const missing = [];
  const violations = [];
  for (const file of pending) {
    if (scanned.has(file)) continue;
    const name = relative(dirname(scripts), file);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(name);
      continue;
    }
    scanned.add(file);
    violations.push(...sourceViolations(source, name, patchArgs));
    for (const [, staticImport, dynamicImport] of source.matchAll(localImports)) {
      pending.push(resolve(dirname(file), staticImport ?? dynamicImport));
    }
  }
  t.diagnostic(`Files scanned: ${[...scanned].map(file => relative(dirname(scripts), file)).sort().join(', ')}`);
  assert.equal(violations.length, 0, violations.join('\n'));
  assert.deepEqual(missing, [], 'Missing source dependencies for the transitive boundary scan');
});

test('boundary patterns detect command prefixes and rest across source forms', () => {
  for (const prefix of LEGACY_AZ_POLICY.banned.filter(family => family !== 'rest')) {
    const pattern = commandPatterns.find(([family]) => family === prefix)[1];
    for (const quote of ["'", '"', '`']) {
      const argv = prefix.split(' ').map(word => quote + word + quote).join(', ');
      assert.match('[' + argv + ', action]', pattern);
      assert.match(quote + prefix + ' ' + quote, pattern);
    }
  }
  const shellRest = commandPatterns.find(([family]) => family === 'az rest')[1];
  for (const quote of ["'", '"', '`']) {
    assert.match("sh('az', [" + quote + 'rest' + quote + ', ...args])', restLiteral);
    assert.doesNotMatch(quote + 'restoring' + quote, restLiteral);
    assert.match(quote + 'az rest ' + quote, shellRest);
  }
});

const mountQuery = 'properties.template.containers[0].volumeMounts[].{volumeName:volumeName,mountPath:mountPath}';
const revisionMetaQuery = '{image:properties.template.containers[0].image,env:properties.template.containers[0].env[].{name:name,secretRef:secretRef},'
  + `volumes:properties.template.volumes,mounts:${mountQuery},active:properties.active,prov:properties.provisioningState,fqdn:properties.fqdn}`;
const x4Queries = {
  appVaultRefsArgs: 'properties.configuration.secrets[].{name:name,keyVaultUrl:keyVaultUrl,identity:identity}',
  appVolumesArgs: 'properties.template.volumes',
  appMountsArgs: mountQuery,
  appLatestArgs: '{latest:properties.latestRevisionName}',
  revisionMetaArgs: revisionMetaQuery,
  revisionListArgs: '[].{name:name,active:properties.active,weight:properties.trafficWeight}',
};

const x4OnlyQueries = new Set(Object.values(x4Queries));
function normalizeQuery(query, x4 = false) {
  if (x4) {
    // Both X4 container selections use the same projection fields.
    query = query.replace(/properties\.template\.containers\[\?name=='[A-Za-z0-9_.-]+'\] \| \[0\]/g,
      'properties.template.containers[0]');
  }
  return normalizeLegacyAzQuery(query);
}

function isReadCommand(argv, elements = []) {
  for (const [index, arg] of argv.entries()) {
    if (elements[index]?.startsWith('...')) continue;
    if (typeof arg !== 'string' || !/^[a-z][a-z-]*$/.test(arg)) break;
    if (arg === 'show' || arg === 'list') return true;
  }
  return false;
}

function queryViolations(argv, label, isRead, resolveQuery = index => argv[index], x4 = false) {
  const violations = [];
  let count = 0;
  for (const [index, arg] of argv.entries()) {
    if (arg !== '--query' && !(typeof arg === 'string' && arg.startsWith('--query='))) continue;
    count++;
    const query = arg === '--query' ? resolveQuery(index + 1) : arg.slice('--query='.length);
    // The env builder's computed branches are checked using the exported builder.
    if (query === checkedByBuilder) continue;
    const normalized = typeof query === 'string' ? normalizeQuery(query, x4) : undefined;
    const allowed = LEGACY_AZ_POLICY.queries.includes(normalized) || (x4 && x4OnlyQueries.has(normalized));
    if (!allowed || (x4 && /\bvalue\b/.test(query))) {
      violations.push(`${label}: unapproved --query ${JSON.stringify(query)}`);
    }
  }
  if (isRead && count !== 1 && !violations.length) violations.push(`${label}: show/list requires exactly one --query`);
  return violations;
}

const checkedByBuilder = Symbol('checked by exported builder');
const literal = /^(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)$/;
const unquote = source => literal.exec(source)?.slice(1).find(value => value !== undefined);
const arrayTokens = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[[\](){},]/g;

function arrayElements(tail) {
  const args = [];
  let depth = 0, start = 0, element = '';
  for (const token of tail.matchAll(arrayTokens)) {
    const [value] = token;
    element += tail.slice(start, token.index);
    start = token.index + value.length;
    if (value.startsWith('//') || value.startsWith('/*')) {
      element += ' ';
      continue;
    }
    if (depth === 0 && (value === ',' || value === ']')) {
      args.push(element.trim());
      element = '';
      if (value === ']') return args;
      continue;
    }
    if ('[({'.includes(value)) depth++;
    if ('])}'.includes(value)) depth--;
    if (depth < 0) break;
    element += value;
  }
  return [];
}

function literalQueryViolations(source, name = 'scripts/deploy.mjs') {
  const x4 = name === x4Source || name === x4Runner;
  const violations = [];
  const envBuilder = !x4 && /export function containerappEnvQueryArgs\([^)]*\) \{[\s\S]*?\n\}/.exec(source);
  const containerIndex = "const idx = t.container ? `[?name=='${t.container}'] | [0]` : '[0]';";
  for (const match of source.matchAll(/\[/g)) {
    const elements = arrayElements(source.slice(match.index + 1));
    const argv = elements.map(unquote);
    const isRead = isReadCommand(argv, elements);
    const line = source.slice(0, match.index).split('\n').length;
    if (x4 && elements.some((element, index) => /(?:^|\s)(?:create|onboard)(?:\s|$)/.test(argv[index] ?? element))) {
      violations.push(`${name}:${line}: banned create/onboard token in argv array`);
    }
    if (x4) {
      // Computed argv is validated by the CLI adapter. Inspect literal queries here.
      for (const [index, arg] of argv.entries()) {
        if (arg?.startsWith('--query=') || (arg === '--query' && argv[index + 1] !== undefined))
          violations.push(...queryViolations([arg, argv[index + 1]], `${name}:${line}`, false, undefined, true));
      }
      continue;
    }
    violations.push(...queryViolations(argv, `${name}:${line}`, isRead, index => {
      const expression = elements[index];
      // Only this computed query is exercised through the sampled builder branches.
      if (expression === 'query' && envBuilder && match.index >= envBuilder.index
        && match.index < envBuilder.index + envBuilder[0].length) return checkedByBuilder;
      if (!x4 && expression === '`properties.template.containers${idx}.image`') {
        const before = source.slice(0, match.index);
        const definition = before.slice(before.lastIndexOf('const idx ='));
        if (definition.startsWith(containerIndex)) return 'properties.template.containers[0].image';
      }
      return argv[index];
    }, x4));
  }
  return violations;
}

test('only reviewed query forms are accepted', () => {
  for (const query of [undefined, '-o', 'properties', 'properties.template',
    'properties.template.containers', 'properties.template.containers[0]',
    "properties.template.containers[?name=='web'] | [0]",
    'properties.template.containers[0].env', 'properties.template.containers[0].env[].value',
    'properties.template.containers[0] | env', 'properties.template.containers[0].*',
    '{value:env}', 'env[0].value', 'properties.template.containers[*].name',
    'properties.template[].containers',
    'properties[].name', 'properties[*].name', '@', 'properties.template.containers[0] | @',
    'values(properties.template.containers[0])', 'to_string(properties.template.containers[0])',
    '{t:properties.template}', 'properties.template.containers[0]."en\\u0076"',
    "properties.template.containers[0].env[?name=='<name>'] | [0].value",
    '[].{name:name,id:id}']) {
    assert.equal(queryViolations(['--query', query], 'sample', true).length, 1, String(query));
  }
  for (const query of ['defaultHostName', 'properties.template.containers[0].image', "properties.template.containers[?name=='web'] | [0].image",
    'properties.template.containers[0].env[].{name:name,secretRef:secretRef}']) {
    assert.deepEqual(queryViolations(['--query', query], 'sample', true), [], query);
  }
});

test('source scan checks inline and private show and list argv arrays', () => {
  for (const command of ['acr show', 'containerapp list', 'containerapp revision list',
    'containerapp job list', 'webapp list', 'functionapp list', 'webapp deployment slot list',
    "...prefix, 'show'", "...prefix, 'list'"]) {
    const prefix = command.startsWith('...') ? command : command.split(' ').map(word => JSON.stringify(word)).join(', ');
    for (const source of [
      `sh('az', [${prefix}])`,
      `capturedAz([${prefix}, '--query', defaultHostName])`,
      `capturedAz([${prefix}, '--query', '[].name', '--query', '@'])`,
      `capturedAz([${prefix}, '--query', '[].name', '--query=[].name'])`,
      `capturedAz([${prefix}, '--query', 'containers[0] | env'])`,
      `const privateArgs = () => [${prefix}, ...buildArgs(['--query', '[].name'])];`,
    ]) {
      assert.equal(literalQueryViolations(source).length, 1, source);
    }
    const narrow = `const privateArgs = () => [${prefix}, ...buildArgs(['--name', name]), '--query', '[].name'];`;
    assert.deepEqual(literalQueryViolations(narrow), []);
  }
  assert.equal(literalQueryViolations("capturedAz([...prefix, '--query', '@'])").length, 1);
  assert.equal(literalQueryViolations("capturedAz(['acr', 'build', '--query', '@'])").length, 1);
});

test('exported argv builders stay within the secret-read boundary', async t => {
  const deploy = await import('./deploy.mjs');
  const base = { subscription: '12345678-1234-1234-1234-123456789abc', resourceGroup: 'rg', app: 'app' };
  const containerapp = {
    ...base, type: 'containerapp', registry: 'registry', image: 'app',
    build: { dockerfile: 'Dockerfile', context: '.', buildArgs: { SAMPLE: 'sample' } },
  };
  const slot = 'sample-slot', revision = 'app--sample';
  const sha = 'a'.repeat(40), image = 'registry.example/app:sample';
  const targets = [{ ...base, type: 'webapp', slot }, containerapp, { ...containerapp, container: 'web' }];
  const samples = {
    acrBuildArgs: [[sha, { EXTRA: 'sample' }]],
    azDeployArgs: [['sample.zip']],
    containerappEnvQueryArgs: [[], ['SAMPLE_NAME']],
    containerappTrafficSetArgs: [[revision], [revision, 50, 'app--previous']],
    containerappUpdateArgs: [[image]],
    containerappUpdateWithRevisionArgs: [[image, sha]],
    webappHostnameArgs: [[], [slot]],
    webappSlotSwapArgs: [[slot]],
    revisionActionArgs: [['activate', revision], ['deactivate', revision]],
  };
  const checked = new Set(), skipped = [], violations = [];
  for (const [name, builder] of Object.entries(deploy)) {
    if (typeof builder !== 'function' || !name.endsWith('Args') || name === 'maskedBuildArgs') continue; // maskedBuildArgs masks dry-run output, it builds no argv
    for (const target of targets) {
      for (const args of samples[name] ?? [[revision]]) {
        const label = `${name} (${target.type}, ${target.container ?? 'default container'})`;
        let argv;
        try {
          argv = builder(target, ...args);
        } catch (error) {
          skipped.push(`${label}: ${error.message}`);
          continue;
        }
        checked.add(name);
        if (!Array.isArray(argv)) {
          violations.push(`${label}: expected an argv array`);
          continue;
        }
        if (name === 'containerappEnvQueryArgs' && args.length) {
          assert.throws(() => checkLegacyAzArgv(argv), /^Error: AZ_ARGV_REFUSED$/, label);
          continue; // The dedicated env builder test pins this projection separately.
        }
        assert.doesNotThrow(() => checkLegacyAzArgv(argv), label);
        const commandText = argv.join(' ');
        for (const [family, pattern] of commandPatterns) {
          if (pattern.test(commandText)) violations.push(`${label}: banned command family ${family}`);
        }
        if (argv.includes('rest')) violations.push(`${label}: banned rest argv token`);
        violations.push(...queryViolations(argv, label, isReadCommand(argv)));
      }
    }
  }
  t.diagnostic(`Builders checked: ${[...checked].join(', ') || 'none'}`);
  t.diagnostic(`Builder samples skipped: ${skipped.join('; ') || 'none'}`);
  assert.ok(checked.size > 0, 'Expected exported argv builders');
  assert.deepEqual(violations, []);
});

test('Container App env argv projects metadata or one named value', async () => {
  const { containerappEnvQueryArgs } = await import('./deploy.mjs');
  const target = { subscription: '12345678-1234-1234-1234-123456789abc', resourceGroup: 'rg', app: 'app' };
  for (const t of [target, { ...target, container: 'web' }]) {
    for (const [name, suffix, format] of [
      [undefined, '.env[].{name:name,secretRef:secretRef}', 'json'],
      ['X', ".env[?name=='X'] | [0].value", 'tsv'],
    ]) {
      const args = containerappEnvQueryArgs(t, name);
      const queryIndex = args.indexOf('--query');
      const outputIndex = args.findIndex(arg => arg === '-o' || arg === '--output');
      assert.ok(queryIndex >= 0 && args[queryIndex + 1]?.endsWith(suffix));
      assert.ok(outputIndex >= 0);
      assert.equal(args[outputIndex + 1], format);
    }
  }
});

function patchBodyViolations(body) {
  const exactKeys = (object, keys) => object !== null && typeof object === 'object' && !Array.isArray(object)
    && isDeepStrictEqual(Object.keys(object).sort(), keys);
  const template = body?.properties?.template;
  const volumeKeys = ['name', 'storageType', 'storageName', 'mountOptions', 'secrets'];
  const nullableString = value => value === null || typeof value === 'string';
  const validVolume = volume => volume && typeof volume.name === 'string'
    && Object.entries(volume).every(([key, value]) => volumeKeys.includes(key)
      && (key !== 'secrets' ? nullableString(value) : value === null || (Array.isArray(value)
        && value.every(secret => exactKeys(secret, ['path', 'secretRef']) && Object.values(secret).every(nullableString)))));
  if (exactKeys(body, ['properties']) && exactKeys(body.properties, ['template'])
    && exactKeys(template, ['revisionSuffix', 'volumes']) && typeof template.revisionSuffix === 'string'
    && Array.isArray(template.volumes) && template.volumes.every(validVolume)) return [];
  return ['volumePatchBody: unexpected PATCH body schema'];
}

test('exported X4 builders stay within the PATCH and metadata boundaries', async () => {
  const x4 = await import('./deploy-x4.mjs');
  const { checkX4Argv } = await import('./deploy-x4-run.mjs');
  assert.deepEqual(x4.X4_ALLOWED_QUERIES, new Set([
    ...x4OnlyQueries,
    'properties.configuration.ingress.traffic',
    '{mode:properties.configuration.activeRevisionsMode,containers:properties.template.containers[].name}',
    'properties.template.containers[0].image',
  ]));
  const targets = [patchTarget, { ...patchTarget, container: 'api' }, {
    subscription: 'abcdefab-1234-1234-1234-123456789abc', resourceGroup: 'rg.other', app: 'other-app',
  }];
  for (const target of targets) {
    for (const path of [patchFile, '/var/tmp/other-dir/patch.json', '/tmp/other.json'])
      assert.deepEqual(patchArgvViolations(x4.volumePatchArgs(target, path), target, path), []);
    const update = x4.x4UpdateArgs(target, 'registry.example/app:sample', 'sample', {
      env: [{ name: 'SAMPLE', value: 'value' }], envRefs: [{ name: 'TOKEN', appRef: 'sample-ref' }],
    });
    assert.deepEqual(update, ['containerapp', 'update', '--subscription', target.subscription,
      '--resource-group', target.resourceGroup, '--name', target.app, '--image', 'registry.example/app:sample',
      '--revision-suffix', 'sample', '--set-env-vars', 'SAMPLE=value', 'TOKEN=secretref:sample-ref',
      ...(target.container ? ['--container-name', target.container] : []), '-o', 'none', '--only-show-errors']);
  }
  const other = { name: 'other', storageType: 'AzureFile', storageName: null, mountOptions: null, secrets: null };
  const decl = { name: 'authority', path: 'token' };
  const body = x4.volumePatchBody([other, { name: decl.name, secrets: null }], decl, 'authority-g2', 'sample');
  assert.deepEqual(patchBodyViolations(body), []);
  assert.equal(body.properties.template.revisionSuffix, 'sample-v');
  assert.equal(body.properties.template.volumes.length, 2);
  assert.deepEqual(body.properties.template.volumes.find(volume => volume.name === other.name),
    { name: 'other', storageType: 'AzureFile' });
  assert.deepEqual(body.properties.template.volumes.find(volume => volume.name === decl.name),
    { name: decl.name, storageType: 'Secret', secrets: [{ secretRef: 'authority-g2', path: 'token' }] });

  for (const [name, expectedQuery] of Object.entries(x4Queries)) {
    for (const target of targets) {
      const argv = x4[name](target, 'app--sample');
      assert.doesNotThrow(() => checkX4Argv(argv, target), name);
      const query = argv[argv.indexOf('--query') + 1];
      assert.ok(isReadCommand(argv), name);
      assert.deepEqual(commandViolations(argv.join(' '), name), []);
      assert.ok(!argv.includes('rest'), name);
      assert.deepEqual(queryViolations(argv, name, true, undefined, true), []);
      assert.equal(normalizeQuery(query, true), expectedQuery, name);
    }
  }
});

test('X4 source checker rejects invalid PATCH argv and banned commands', () => {
  const builder = "export function volumePatchArgs(target, bodyFile) {\n  return ['rest', ...args];\n}";
  assert.deepEqual(sourceViolations(builder, x4Source, patchArgv), []);
  for (const extra of ["const token = 'rest';", 'const token = "rest";', 'const token = `rest`;',
    "sh('az rest --method PATCH')", "sh('az', ['containerapp', 'secret', 'set'])", "sh('az', ['--show-values'])",
    "sh('az', ['containerapp', 'show', '--query', 'properties.configuration.secrets[].value'])",
    `sh('az', ['containerapp', 'show', '--query', "properties.template.containers[0].env[?name=='SAMPLE_NAME'] | [0].value"])`]) {
    assert.ok(sourceViolations(builder + '\n' + extra, x4Source, patchArgv).length, extra);
    assert.ok(sourceViolations(extra, x4Runner, patchArgv).length, extra);
  }
  assert.ok(sourceViolations(builder.replace('...args', "'rest', ...args"), x4Source, patchArgv).length);
  assert.ok(sourceViolations(builder, x4Runner, patchArgv).length);

  for (const [index, values] of [
    [2, ['GET', 'POST']],
    [4, [patchUrl + '/listSecrets?api-version=2025-07-01',
      patchArgv[4].replace('Microsoft.App', 'Microsoft.Web'),
      patchUrl + '?api-version=2024-02-02', patchArgv[4] + '&x=1']],
    [6, [patchFile, '@relative/body']],
  ]) {
    for (const value of values) {
      const argv = [...patchArgv];
      argv[index] = value;
      assert.ok(sourceViolations(builder, x4Source, argv).length, value);
    }
  }
  assert.ok(sourceViolations(builder, x4Source, [...patchArgv, '--debug']).length);
});

test('PATCH body checker rejects keys outside the volume schema', () => {
  for (const key of ['configuration', 'containers', 'env', 'secrets']) {
    assert.ok(patchBodyViolations({ [key]: [], properties: { template: { revisionSuffix: 'sample',
      volumes: [] } } }).length, key);
  }
  assert.ok(patchBodyViolations({ properties: { configuration: { secrets: [] },
    template: { revisionSuffix: 'sample', volumes: [] } } }).length);
  for (const key of ['configuration', 'containers', 'env', 'value']) {
    assert.ok(patchBodyViolations({ properties: { template: { revisionSuffix: 'sample',
      volumes: [{ name: 'other', [key]: null }] } } }).length, key);
  }
});

test('X4 source checker rejects target-dependent PATCH argv', () => {
  const builder = "export function volumePatchArgs(target, bodyFile) {\n  return ['rest', '--method', target.method ?? 'PATCH', ...args];\n}";
  assert.match(sourceViolations(builder, x4Source, patchArgv).join('\n'), /conditional/);
});

test('X4 source checker rejects create and onboard across argv forms', () => {
  for (const name of [x4Source, x4Runner]) {
    const source = readFileSync(new URL(`./${name.split('/').at(-1)}`, import.meta.url), 'utf8');
    for (const token of ['create', 'onboard']) {
      for (const quote of ["'", '"', '`']) {
        assert.match(sourceViolations(source + `\nconst verb = ${quote}${token}${quote};`, name, patchArgv).join('\n'),
          /banned create\/onboard argv literal/);
      }
      assert.match(sourceViolations(source + `\naz(['containerapp', ${token}]);`, name, patchArgv).join('\n'),
        /banned create\/onboard token in argv array/);
    }
  }
});

test('runtime boundary rejects computed commands and unlisted queries', async () => {
  const { checkX4Argv } = await import('./deploy-x4-run.mjs');
  assert.equal(typeof checkX4Argv, 'function');
  assert.doesNotMatch(checkX4Argv.toString(), /\b(?:volumePatchArgs|resourceId)\b/);
  assert.throws(() => checkX4Argv(['re' + 'st', '--query', x4Queries.appVolumesArgs], patchTarget),
    /^Error: X4_ARGV_REFUSED$/);
  const { appVolumesArgs } = await import('./deploy-x4.mjs');
  const read = appVolumesArgs(patchTarget);
  assert.doesNotThrow(() => checkX4Argv(read, patchTarget));
  assert.throws(() => checkX4Argv(['--only-show-errors', read[0], '--only-show-errors', ...read.slice(1)], patchTarget));
  assert.throws(() => checkX4Argv(['keyvault', '--only-show-errors', 'secret', 'show'], patchTarget),
    /^Error: X4_ARGV_REFUSED$/);
  assert.throws(() => checkX4Argv(read.map(arg => arg === x4Queries.appVolumesArgs ? 'unreviewed' : arg), patchTarget),
    /^Error: X4_ARGV_REFUSED$/);
  assert.throws(() => checkX4Argv([...read, '--query', x4Queries.appVolumesArgs], patchTarget),
    /^Error: X4_ARGV_REFUSED$/);
  assert.doesNotThrow(() => checkX4Argv(patchArgv, patchTarget, 'volume-patch', [patchFile]));
  assert.throws(() => checkX4Argv([patchArgv.at(-1), ...patchArgv.slice(0, -1)], patchTarget, 'volume-patch', [patchFile]));
  assert.throws(() => checkX4Argv(patchArgv.slice(0, -1), patchTarget, 'volume-patch', [patchFile]),
    /^Error: X4_ARGV_REFUSED$/);
  assert.throws(() => checkX4Argv(['re' + 'st', ...patchArgv.slice(1), '--debug'], patchTarget, 'volume-patch', [patchFile]),
    /^Error: X4_ARGV_REFUSED$/);
});

test('legacy runtime guard refuses diagnostic flags anywhere in argv', () => {
  const read = ['acr', 'show', '--query', 'loginServer'];
  for (const flag of ['--debug', '--verbose']) {
    for (const index of [0, 1, read.length]) {
      assert.throws(() => checkLegacyAzArgv([...read.slice(0, index), flag, ...read.slice(index)]),
        /^Error: AZ_ARGV_REFUSED$/);
    }
  }
});

test('X4 runtime guard refuses diagnostic flags anywhere in read and update argv', async () => {
  const { checkX4Argv } = await import('./deploy-x4-run.mjs');
  const { appVolumesArgs, x4UpdateArgs } = await import('./deploy-x4.mjs');
  const updateValues = ['registry.example/app:sample', 'sample', { env: [], envRefs: [] }];
  const update = x4UpdateArgs(patchTarget, ...updateValues);
  assert.doesNotThrow(() => checkX4Argv(update, patchTarget, 'update', updateValues));
  for (const flag of ['--debug', '--verbose']) {
    for (const [args, writeId, values] of [[appVolumesArgs(patchTarget)], [update, 'update', updateValues]]) {
      for (const index of [0, 1, args.length]) {
        assert.throws(() => checkX4Argv([...args.slice(0, index), flag, ...args.slice(index)], patchTarget, writeId, values),
          /^Error: X4_ARGV_REFUSED$/);
      }
    }
  }
});

test('legacy banned families match across interleaved global options', () => {
  for (const [option, value] of [['-o', 'json'], ['--output', 'json'], ['--query', 'loginServer']]) {
    assert.throws(() => checkLegacyAzArgv(['keyvault', option, value, 'secret', 'show']),
      /^Error: AZ_ARGV_REFUSED$/, option);
  }
});

test('boundary scans conditional PATCH resource IDs', () => {
  const source = readFileSync(new URL('./deploy-x4.mjs', import.meta.url), 'utf8');
  for (const conditional of ['t.path && t.path', 'switch (t.path) {}']) {
    const changed = source.replace('function resourceId(t) {', 'function resourceId(t) {\n  ' + conditional);
    assert.match(sourceViolations(changed, x4Source, patchArgv).join('\n'), /resourceId.*conditional/);
    const changedBuilder = source.replace('function volumePatchArgs(target, bodyFile) {',
      'function volumePatchArgs(target, bodyFile) {\n  ' + conditional + ';');
    assert.match(sourceViolations(changedBuilder, x4Source, patchArgv).join('\n'), /volumePatchArgs.*conditional/);
  }
});

test('X4 process calls are confined to the guarded CLI adapter', () => {
  const builder = readFileSync(new URL('./deploy-x4.mjs', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('./deploy-x4-run.mjs', import.meta.url), 'utf8');
  const adapter = /^  function cliAzure\(args, id, values\) \{[\s\S]*?^  \}/m.exec(runner)?.[0];
  assert.ok(adapter, 'missing CLI adapter');
  assert.match(adapter, /^  function cliAzure\(args, id, values\) \{\n    try \{\n      checkX4Argv\(args, target, id, values\);\n    \} catch \(error\) \{\n      if \(id \|\| !source\) throw error;\n      checkX4Argv\(args, source\);\n    \}/);
  const processCalls = /\b(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?|sh(?:Quiet)?)\s*\(/g;
  assert.doesNotMatch(builder + '\n' + runner.replace(adapter, ''), processCalls);
  assert.deepEqual([...adapter.matchAll(processCalls)].map(call => adapter.slice(call.index).split('\n')[0]), [
    "execFileSync('git', ['--no-replace-objects', '-C', repo, 'archive', '--format=tar', '-o', tar, sha],",
    "execFileSync('tar', ['-xf', tar, '-C', src], { stdio: ['ignore', 'ignore', 'pipe'] });",
    "sh('az', args, { cwd: src, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.max(1800, timeoutSeconds) * 1000 });",
    "shQuiet(args, Math.max(600, timeoutSeconds) * 1000, { env });",
    "sh('az', args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); }",
  ]);
  assert.match(runner, /az: cliAzure,\s+azWrite: cliAzure,\s+azBuild: cliAzure,/);
});

test('legacy runtime boundary rejects computed argv and unreviewed reads', async () => {
  const { revisionActionArgs } = await import('./deploy.mjs');
  const refusal = /^Error: AZ_ARGV_REFUSED$/;
  const pushed = ['containerapp', 'show'];
  pushed.push('--query', 'unreviewed');
  for (const args of [
    ['re' + 'st'], pushed, ['acr', 'build', '--query=unreviewed'], ['containerapp', 'show'], ['containerapp', 'show', '--query=' + 'unreviewed'],
    ['containerapp', 'show', '--query', 'loginServer', '--query=loginServer'],
    ['containerapp', 'exec'], ['webapp', 'ssh'], ['webapp', 'create-remote-connection'], ['graph', 'query'],
  ]) assert.throws(() => checkLegacyAzArgv(args), refusal);
  assert.throws(() => checkLegacyAzArgv(['keyvault', '--only-show-errors', 'secret', 'show']), refusal);
  assert.throws(() => checkLegacyAzArgv(['--only-show-errors', 'acr', '--only-show-errors', 'show', '--query', 'loginServer']));
  assert.throws(() => revisionActionArgs(patchTarget, 'show', 'candidate'), refusal);
  assert.doesNotThrow(() => checkLegacyAzArgv(revisionActionArgs(patchTarget, 'activate', 'candidate')));
  assert.doesNotThrow(() => checkLegacyAzArgv(['acr', 'show', '--query=loginServer']));
  assert.doesNotThrow(() => checkLegacyAzArgv(['acr', 'show', '--query', 'loginServer']));
});

test('independent secret boundary pins survive policy edits', async () => {
  for (const family of ['keyvault secret', 'containerapp secret', '--show-values', 'rest', 'get-access-token']) {
    assert.ok(LEGACY_AZ_POLICY.banned.includes(family), family);
  }
  for (const args of [
    ['keyvault', 'secret', 'list', '--query', '[].name'],
    ['containerapp', 'secret', 'list', '--query', '[].name'],
    ['containerapp', 'list', '--show-values', '--query', '[].name'],
    ['rest', '--method', 'GET'],
    ['account', 'get-access-token', '--query', '[].name'],
  ]) assert.throws(() => checkLegacyAzArgv(args), /^Error: AZ_ARGV_REFUSED$/);
  const { X4_ALLOWED_QUERIES } = await import('./deploy-x4.mjs');
  for (const query of [...LEGACY_AZ_POLICY.queries, ...X4_ALLOWED_QUERIES]) assert.doesNotMatch(query, /\bvalue\b/i);
});

test('legacy process transport is confined to its guarded adapters and declared build step', () => {
  const source = readFileSync(new URL('./deploy.mjs', import.meta.url), 'utf8');
  assert.match(source, /function sh\(cmd, args, opts, appEnv\) \{\n  if \(cmd === 'az'\) checkLegacyAzArgv\(args, appEnv\);\n  return execCommand\(cmd, args, opts\);/);
  assert.match(source, /function capturedAz\([^\n]+\n  checkLegacyAzArgv\(args\);\n  try \{/);
  const uses = /\b(?:execCommand|execFileSync|shQuiet)\b/g;
  assert.deepEqual([...source.matchAll(uses)].map(match => source.slice(match.index).split('\n')[0]), [
    "execFileSync } from 'node:child_process';",
    'execCommand(cmd, args, opts);',
    'execCommand(cmd, args, opts = {}) {',
    "execFileSync([cmd, ...args].map(q).join(' '), { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024, ...opts })",
    "execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024, ...opts });",
    "execCommand('az', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.min(120000, remaining) });",
    'shQuiet(args, timeout, { env }) {',
    "execCommand('az', args, { timeout, env, stdio: ['ignore', 'ignore', 'pipe'] }); }",
    'execCommand, shQuiet, confirm: confirmInteractive });',
    'shQuiet, confirm: confirmInteractive });',
    "execFileSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tarFile, sha], { stdio: ['ignore', 'ignore', 'pipe'] });",
    "execFileSync('tar', ['-xf', tarFile, '-C', wt], { stdio: ['ignore', 'ignore', 'pipe'] });",
    "execCommand(fill(step.command, vars), (step.args || []).map(a => fill(a, vars)), { cwd: join(wt, step.cwd || '.'), env: { ...process.env, TRIO_BUILD_SHA: sha } });",
  ]);
});

test('policy scans reject executable entries and continue scanning adjacent code', () => {
  const source = readFileSync(new URL('./deploy.mjs', import.meta.url), 'utf8');
  const scan = candidate => sourceViolations(candidate, 'scripts/deploy.mjs', patchArgv).join('\n');
  for (const member of ['get data() { return []; }', 'data: () => []', 'data: Object.keys({})', 'data: function () {}']) {
    const changed = source.replace('LEGACY_AZ_POLICY = Object.freeze({', 'LEGACY_AZ_POLICY = Object.freeze({\n  ' + member + ',');
    assert.match(scan(changed), /LEGACY_AZ_POLICY must contain only frozen string arrays/);
  }
  assert.match(scan(source + "\nsh('az', ['keyvault', 'secret', 'list']);"), /banned command family keyvault secret/);
});

test('named build-argument projection requires a declared non-secret name and an exact argv', async () => {
  const { containerappEnvQueryArgs } = await import('./deploy.mjs');
  const name = 'BUILD_LABEL', target = { ...patchTarget, build: { buildArgsFromApp: { LABEL: name } } };
  const args = containerappEnvQueryArgs(target, name);
  assert.doesNotThrow(() => checkLegacyAzArgv(args, { target, name }));
  assert.throws(() => checkLegacyAzArgv(args), /AZ_ARGV_REFUSED/);
  assert.throws(() => checkLegacyAzArgv([...args, '--query', '[].name'], { target, name }), /AZ_ARGV_REFUSED/);
  assert.throws(() => checkLegacyAzArgv(containerappEnvQueryArgs(target, 'OTHER_LABEL'),
    { target, name: 'OTHER_LABEL' }), /AZ_ARGV_REFUSED/);
});

test('deployment guards accept command-like target names as option values', async () => {
  const legacy = await import('./deploy.mjs');
  const { checkX4Argv } = await import('./deploy-x4-run.mjs');
  const { appVolumesArgs, x4UpdateArgs } = await import('./deploy-x4.mjs');
  const sha = 'a'.repeat(40);
  for (const name of ['rest', 'secret', 'exec', 'ssh']) {
    const target = { ...patchTarget, app: name, resourceGroup: name, slot: name, registry: name,
      image: 'app', build: { dockerfile: 'Dockerfile' } };
    const build = legacy.acrBuildArgs(target, sha, { K: 'V' });
    const weights = legacy.containerappTrafficSetArgs(target, 'candidate', 50, 'previous');
    for (const argv of [legacy.webappHostnameArgs(target, target.slot), legacy.azDeployArgs(target, 'release.zip'),
      legacy.containerappShapeArgs(target), build, weights]) assert.doesNotThrow(() => checkLegacyAzArgv(argv));
    checkX4Argv(appVolumesArgs(target), target);
    checkX4Argv(build, target, 'acr-build', [sha, { K: 'V' }]);
    checkX4Argv([...weights, '-o', 'none'], target, 'traffic', ['candidate', 50, 'previous']);
    const values = ['registry.example/app:sample', 'sample', {
      env: [{ name: 'FIRST', value: 'one' }, { name: 'SECOND', value: 'two' }, { name: 'THIRD', value: 'three' }], envRefs: [],
    }];
    checkX4Argv(x4UpdateArgs(target, ...values), target, 'update', values);
  }
  for (const args of [['keyvault', '-o', 'json', 'secret', 'show'],
    ...['--only-show-errors', '--all', '--no-wait', '--yes', '--unknown'].map(flag => ['keyvault', flag, 'secret', 'show'])]) {
    assert.throws(() => checkLegacyAzArgv(args), /^Error: AZ_ARGV_REFUSED$/);
    assert.throws(() => checkX4Argv(args, patchTarget), /^Error: X4_ARGV_REFUSED$/);
  }
});
