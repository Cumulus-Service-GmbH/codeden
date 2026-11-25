import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_AGENT_MARKERS, Refusal, acrBuildArgs, acrRunDigest, appendAppHistory, checkAppShape, containerappShapeArgs,
  containerappRevisionImageArgs, containerappTrafficQueryArgs, containerappTrafficSetArgs, pinnedImageRef,
  isAgent, pinnedTrafficRevision, promotionSourceAssociation, readHistory, revisionActionArgs, revisionHealthUrl, sameContainerApp,
} from './deploy.mjs';
import {
  X4_ALLOWED_QUERIES, X4_ARM_API_VERSION, X4_STEPS, actionP64, appLatestArgs, appMountsArgs, appVaultRefsArgs, appVolumesArgs,
  canonicalJson, checkAlias, checkAuthorityReceipt, checkEnvCase, checkHealthExpect,
  checkMount, checkRevisionSettings, envelope, matchesPlannedTraffic, normalizeTraffic, normalizeVolumes,
  parseRevisionInput, planIds, plannedTraffic, reconcile, revisionListArgs,
  azCommandWords, revisionMetaArgs, sha256Hex, stripAzLoggerFlags, targetIdentity, trafficEquals, volumePatchArgs,
  volumePatchBody, volumePatchNeeded, x4Phrase, x4UpdateArgs,
} from './deploy-x4.mjs';

export const REVIEWED_CONTAINERAPP_VERSIONS = ['1.3.0b6'];
const versionArgs = ['version', '-o', 'json'];

const allowsPolicyChange = action => action === 'rollback' || action === 'withdraw';
const stageAction = action => ['stage', 'renew-authority'].includes(action);
const actions = ['build', 'stage', 'renew-authority', 'switch', 'withdraw', 'cleanup', 'rollback', 'recover'];
const hexSha = /^[a-f0-9]{40}$/;
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const digestPattern = /@sha256:[a-f0-9]{64}$/;
const hash = value => sha256Hex(canonicalJson(value));
const refuse = code => { throw new Refusal(code); };
const check = (condition, code) => { if (!condition) refuse(code); };
const intentStep = entry => ['intent', 'switch-intent', 'rollback-intent', 'recover-intent'].includes(entry.step);
const validSha = value => typeof value === 'string' && hexSha.test(value) && value.length === 40;
const named = value => typeof value === 'string' && safeName.test(value) && !/\s/.test(value);
const sortNames = list => [...list].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function redactArgs(args) {
  if (!args.input) return args;
  return { ...args, input: { ...args.input,
    env: args.input.env.map(({ name, value }) => ({ name, valueSha256: sha256Hex(value) })),
  } };
}

function options(argv) {
  check(!argv.includes('--test-fence-receipt'), 'TEST_FENCE_UNSUPPORTED');
  const opt = name => {
    const flag = '--' + name;
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    check(value && !value.startsWith('--') && index === argv.lastIndexOf(flag), 'X4_ARGUMENT_INVALID');
    return value;
  };
  const action = opt('action'), status = opt('status'), opId = opt('op') ?? status;
  check(status ? !action && !argv.includes('--op') : actions.includes(action), 'X4_ARGUMENT_INVALID');
  const stage = stageAction(action);
  const permitted = ['target', 'repo', 'remote', 'default', ...(status ? ['status'] : ['action', 'authorize']),
    ...(stage || action === 'build' ? ['sha'] : []),
    ...(stage || action === 'recover' ? ['revision-input', 'authority-receipt'] : []),
    ...(!status && !stage && action !== 'build' ? ['op'] : []),
    ...(action === 'switch' ? ['percent'] : []),
    ...(['switch', 'rollback', 'recover'].includes(action) ? ['run', 'ledger', 'key'] : []),
    ...(action === 'cleanup' ? ['retire-revision'] : []),
    ...(action === 'rollback' ? ['to-revision'] : [])];
  for (let i = 0; i < argv.length; i++) {
    if (!status && argv[i] === '--dry-run') continue;
    check(argv[i].startsWith('--') && permitted.includes(argv[i].slice(2)), 'X4_ARGUMENT_INVALID');
    opt(argv[i].slice(2));
    i++;
  }
  check(stage || action === 'build' || /^op-[a-f0-9]{12}$/.test(opId ?? ''), 'OP_ID_INVALID');
  check(action !== 'switch' || (opt('percent') ?? '100') === '100', 'PERCENT_INVALID');
  return { action, status, opId, opt, dryRun: argv.includes('--dry-run') };
}

function readInput(opt, target, deps) {
  const inputPath = opt('revision-input'), receiptPath = opt('authority-receipt');
  check(inputPath && receiptPath, 'REVISION_INPUT_REQUIRED');
  let bytes, receipt;
  try {
    bytes = deps.readFile(inputPath);
    receipt = deps.readFile(receiptPath);
  } catch { refuse('REVISION_INPUT_UNREADABLE'); }
  const parsed = parseRevisionInput(bytes, target, { now: deps.now() });
  check(opt('sha') === undefined || opt('sha') === parsed.input.sourceSha, 'SOURCE_SHA_MISMATCH');
  checkAuthorityReceipt(receipt, parsed.input);
  return parsed;
}

const stageFields = ({ input, candidateRevision, imageRef }, inputSha256, generation) => ({
  inputSha256, generation, expiresAtUtc: input.expiresAtUtc,
  authorityReceiptSha256: input.authorityReceiptSha256,
  settings: { env: input.env.map(item => item.name), envRefs: input.envRefs, volume: input.secretVolume },
  sha: input.sourceSha, digest: input.image.digest, image: imageRef, imageRef, revision: candidateRevision,
});

// A result always retains its plan. Resolve a failed write through its exact intent,
// and resolve a recovery write through the original action envelope.
function journalPlan(entries, target, opId) {
  const newest = entries.at(-1);
  check(newest, 'OP_NOT_FOUND');
  const originals = entries.filter(entry => entry.action !== 'recover');
  const stageHashes = new Set(originals.filter(entry => stageAction(entry.action)).map(entry => entry.planSha256));
  check(stageHashes.size <= 1, 'OP_ID_COLLISION');
  let entry = newest;
  if (newest.step === 'failed' && newest.write) {
    entry = entries.slice(0, -1).findLast(item => intentStep(item) && item.write === newest.write &&
      item.action === newest.action && item.planSha256 === newest.planSha256);
    check(entry, 'JOURNAL_PLAN_UNREADABLE');
    entry = { ...entry, azReturned: newest.azReturned };
  }
  let source = entry;
  if (entry.action === 'recover' && entry.step !== 'recovered') {
    source = originals.findLast(item => item.planSha256 === entry.priorPlanSha256 && intentStep(item));
    check(source, 'JOURNAL_PLAN_UNREADABLE');
    entry = { ...source, ...entry, action: source.action, step: intentStep(entry) ? 'intent' : entry.step };
    if (entry.step === 'deactivated' && stageAction(source.action)) entry.step = 'verified';
  }
  if (stageAction(source.action))
    check(source.args && source.redactedArgsSha256 === hash(source.args), 'JOURNAL_TAMPERED');
  check(source.expected && source.args && /^[a-f0-9]{64}$/.test(source.planSha256), 'JOURNAL_PLAN_UNREADABLE');
  const plan = { schema: 1, action: source.action, opId, target: source.target ?? target,
    expected: source.expected, args: source.args };
  if (!stageAction(source.action)) check(actionP64(plan) === source.planSha256, 'JOURNAL_PLAN_UNREADABLE');
  return { entry, plan, planSha256: source.planSha256 };
}

export async function runX4({ argv, targetName, target, cfg, history, deps }) {
  const { action, status, opId, opt, dryRun } = options(argv);
  const deOpted = !target.settings;
  check(!deOpted || status || action === 'recover' || allowsPolicyChange(action), 'G7_NOT_DECLARED');
  if (!deOpted) check(typeof target.loginServer === 'string' &&
    /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(target.loginServer), 'CONFIG_INVALID');
  const identity = targetIdentity(target, targetName);
  const decl = target.settings?.authorityVolume;
  const webPin = target.build?.buildArgs?.WEB_BASE_SHA;
  const healthTimeout = (target.health?.timeoutSeconds ?? 300) * 1000;
  const provisioningTimeout = Math.max(600000, healthTimeout);
  const sha = opt('sha');
  if (action === 'build') {
    check(target.build?.buildArgsFromApp === undefined, 'X4_BUILD_ARGS_FROM_APP_UNSUPPORTED');
    check(validSha(sha), 'SOURCE_SHA_INVALID');
    const context = target.build?.context ?? '.';
    check(typeof context === 'string' && /^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(context) &&
      !context.split('/').includes('..') && !context.startsWith('-'), 'X4_BUILD_CONTEXT_INVALID');
  }
  const parsed = stageAction(action) ? readInput(opt, target, deps) : null;
  if (action === 'build' || action === 'stage') {
    check(await deps.shaOnDefault(action === 'build' ? sha : parsed.input.sourceSha), 'SHA_NOT_ON_DEFAULT');
  }
  const read = async args => {
    try { return JSON.parse(await deps.az(args)); }
    catch (error) { if (error instanceof Refusal) throw error; refuse('AZ_METADATA_UNREADABLE'); }
  };
  const traffic = async () => {
    const map = normalizeTraffic(await read(containerappTrafficQueryArgs(target)));
    check(map.every(item => item.weight >= 0 && item.weight <= 100 &&
      (item.revisionName === null || named(item.revisionName))), 'AZ_METADATA_UNREADABLE');
    return map;
  };
  const list = async () => {
    const rows = await read(revisionListArgs(target));
    check(Array.isArray(rows) && rows.every(row => named(row?.name) && typeof row.active === 'boolean') &&
      new Set(rows.map(row => row.name)).size === rows.length, 'AZ_METADATA_UNREADABLE');
    return sortNames(rows);
  };
  const latest = async () => {
    const result = await read(appLatestArgs(target));
    check(named(result?.latest), 'AZ_METADATA_UNREADABLE');
    return result.latest;
  };
  const envMetadata = entries => {
    check(entries == null || Array.isArray(entries), 'AZ_METADATA_UNREADABLE');
    return sortNames((entries ?? []).map(({ name, secretRef = null }) => {
      check(named(name) || (typeof name === 'string' && /^_[a-zA-Z0-9_.-]*$/.test(name)), 'AZ_METADATA_UNREADABLE');
      check(secretRef === null || named(secretRef), 'AZ_METADATA_UNREADABLE');
      return { name, secretRef };
    }));
  };
  const volumeMetadata = volumes => {
    check(volumes == null || Array.isArray(volumes), 'AZ_METADATA_UNREADABLE');
    // Reuse the PATCH schema validator while retaining all original volumes.
    volumePatchBody(volumes ?? [], decl, '', '');
    return normalizeVolumes(volumes ?? []);
  };
  const vault = async () => {
    const refs = await read(appVaultRefsArgs(target));
    check(Array.isArray(refs), 'AZ_METADATA_UNREADABLE');
    return sortNames(refs.map(({ name, keyVaultUrl = null, identity = null }) => ({ name, keyVaultUrl, identity })));
  };
  const meta = async name => {
    check(named(name), 'REVISION_INVALID');
    const value = await read(revisionMetaArgs(target, name));
    check(value && typeof value === 'object', 'AZ_METADATA_UNREADABLE');
    return { image: typeof value.image === 'string' ? value.image : null, env: envMetadata(value.env),
      volumes: volumeMetadata(value.volumes), mounts: Array.isArray(value.mounts) ?
        value.mounts.map(({ volumeName, mountPath }) => ({ volumeName, mountPath })) : [],
      active: value.active === true, prov: value.prov ?? null, fqdn: value.fqdn ?? null };
  };
  const health = async (url, expectedSha, expect = {}, declaration = target.health) => {
    let body, statusCode;
    try {
      ({ status: statusCode, body } = await deps.fetchHealth(url));
      if (typeof body === 'string' && declaration.shaField !== '.') body = JSON.parse(body);
    } catch { refuse('HEALTH_UNREADABLE'); }
    check(statusCode === 200, 'HEALTH_UNREADABLE');
    const field = declaration.shaField;
    const reported = field === '.' ? (typeof body === 'string' ? body.trim().split(/\r?\n/)[0] : null) :
      field.split('.').reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, body);
    check(validSha(reported) && (expectedSha == null || reported === expectedSha), 'HEALTH_SHA_MISMATCH');
    checkHealthExpect(body, expect, { webPin });
    return reported;
  };
  const revisionHealth = (revision, sha, expect) => {
    check(named(revision.fqdn), 'HEALTH_UNREADABLE');
    return health(revisionHealthUrl(target.health.url, revision.fqdn), sha, expect);
  };
  const pollHealth = async (readHealth, timeout = healthTimeout) => {
    const deadline = deps.now() + timeout;
    for (let elapsed = 0; ; elapsed += 10000) {
      try { return await readHealth(); }
      catch (error) {
        if (error.message === 'REVISION_PROVISIONING_FAILED') throw error;
        if (Math.min(deadline - deps.now(), timeout - elapsed) < 10000) throw error;
        await deps.sleep(10000);
      }
    }
  };
  const expectedState = async (failedSwitch, kind = action, switchPlan, tolerateHealthFailure = false) => {
    const map = await traffic();
    const weighted = map.filter(item => item.weight > 0);
    if (switchPlan && (!failedSwitch || weighted.length <= 1))
      check(matchesPlannedTraffic(map, switchPlan.args.resultingTraffic, switchPlan.expected.traffic), 'ROLLBACK_OP_NOT_SERVING');
    if (failedSwitch) {
      check(weighted.some(item => item.revisionName === failedSwitch.candidateRevision) &&
        weighted.every(item => item.revisionName === failedSwitch.candidateRevision ||
          item.revisionName === failedSwitch.servingRevision), 'ROLLBACK_OP_NOT_SERVING');
    }
    if (kind !== 'build') check(!map.some(item => item.label !== null), 'TRAFFIC_LABELS_PRESENT');
    const revisions = await list();
    const split = failedSwitch && weighted.length > 1;
    if (split) check(!map.some(item => item.latestRevision) &&
      weighted.reduce((total, item) => total + item.weight, 0) === 100 &&
      weighted.every(item => revisions.some(row => row.name === item.revisionName && row.active)), 'TRAFFIC_NOT_PINNED');
    let servingRevision = null;
    if (!split) {
      try { servingRevision = pinnedTrafficRevision(JSON.stringify(map)); }
      catch (error) { if (kind !== 'build') throw error; }
    }
    if (servingRevision !== null && !revisions.some(row => row.name === servingRevision && row.active)) {
      check(kind === 'build', 'TRAFFIC_NOT_PINNED');
      servingRevision = null;
    }
    let servingSha = null;
    if (servingRevision) {
      try { servingSha = await health(target.health.url, null); }
      catch (error) { if (!tolerateHealthFailure && kind !== 'build' && kind !== 'rollback') throw error; }
    }
    return { revisions, expected: { servingRevision, servingSha,
      traffic: map, activeRevisions: revisions.filter(row => row.active).map(row => row.name),
      testFenceReceiptSha256: null } };
  };
  const zero = (map, name) => !map.some(item => item.label !== null || item.latestRevision ||
    (item.revisionName === name && item.weight !== 0));
  const rowsMatch = async (expected, failedSwitch, switchPlan) => {
    const current = await expectedState(failedSwitch, action, switchPlan);
    check(isDeepStrictEqual(current.expected, expected), 'EXPECTED_STATE_CHANGED');
  };
  const checkExpiry = input => check(Date.parse(input.expiresAtUtc) - deps.now() >=
    (target.settings.minExpiryHeadroomSeconds ?? 3600) * 1000, 'AUTHORITY_EXPIRY_HEADROOM');
  check(Number.isSafeInteger(healthTimeout) && healthTimeout > 0, 'CONFIG_INVALID');
  const checkShape = async () => {
    try { checkAppShape(await deps.az(containerappShapeArgs(target)), target); }
    catch (error) { if (error instanceof Refusal && ['AZ_READ_FAILED', 'X4_ARGV_REFUSED'].includes(error.message)) throw error; refuse('APP_SHAPE_UNSAFE'); }
  };
  const locked = !status && !dryRun;
  if (locked) {
    const lockError = deps.lock.path ? `APP_WRITE_LOCKED: ${deps.lock.path}` : 'APP_WRITE_LOCKED';
    try { check(await deps.lock.acquire() !== false, lockError); }
    catch (error) { if (error.code === 'EEXIST') refuse(lockError); throw error; }
  }
  try {
    const entries = await deps.journal.entries();
    const opEntries = entries.filter(item => item.op === opId);
    const ownStage = opEntries.find(item => stageAction(item.action) && intentStep(item));
    const lastVerified = opEntries.findLast(item => item.step === 'verified' && item.verified === true);
    if (ownStage) check(ownStage.args && ownStage.redactedArgsSha256 === hash(ownStage.args), 'JOURNAL_TAMPERED');

    const makePlan = (kind, expected, args, id = opId) => {
      const plan = envelope({ action: kind, opId: id, target: identity, expected, args });
      const ids = id ? { opId: id, p64: actionP64(plan), envelope: plan } : planIds(plan);
      return { ...ids, phrase: x4Phrase(target.app, kind, ids.opId, ids.p64) };
    };
    const display = (plan, inputSha256) => ({ ...plan, args: redactArgs(plan.args),
      ...(inputSha256 ? { inputSha256 } : {}) });
    async function authorize(approval) {
      const aliases = [target, ...Object.values(cfg?.targets ?? {}).filter(alias => sameContainerApp(alias, target))];
      const ownerOnly = aliases.some(alias => alias.agentAllowed === false || alias.agentAllowed === undefined);
      const markers = [...new Set([...DEFAULT_AGENT_MARKERS, ...aliases.flatMap(alias => alias.agentMarkers ?? [])])];
      if (ownerOnly) check(!isAgent(deps.env, markers), 'AGENT_NOT_ALLOWED');
      if ((action === 'recover' || aliases.some(alias => alias.agentAllowed !== true)) && opt('authorize') !== approval.phrase)
        refuse(`AUTHORIZATION_REQUIRED: pass --authorize "${approval.phrase}"`);
      if (ownerOnly) {
        check(deps.isTTY === true, 'INTERACTIVE_REQUIRED');
        await deps.confirm(target.app);
      }
    }
    const journalFor = (approval, fields = {}) => {
      const { action, args, expected, target } = approval.envelope;
      const redacted = redactArgs(args);
      const redactedArgsSha256 = hash(redacted);
      const recovery = action === 'recover' ? { priorPlanSha256: args.priorPlanSha256, recoveryStep: args.recoveryStep } : {};
      return async (step, details = {}) => {
        check(X4_STEPS.includes(step), 'JOURNAL_STEP_INVALID');
        try {
          await deps.journal.append({ op: approval.opId, action, step, planSha256: approval.p64,
            expected, args: redacted, redactedArgsSha256, target, ...fields, ...recovery, ...details,
            at: new Date(deps.now()).toISOString() });
        } catch { refuse('JOURNAL_APPEND_FAILED'); }
      };
    };
    const failureCodes = { 'acr-build': 'ACR_BUILD_FAILED', 'volume-patch': 'VOLUME_PATCH_FAILED',
      update: 'REVISION_UPDATE_FAILED', traffic: 'TRAFFIC_WRITE_FAILED', deactivate: 'DEACTIVATE_FAILED' };
    let versionChecked = false;
    const write = async ({ append, id, args, values, intent = {}, verify, step }) => {
      if (!versionChecked) {
        let version;
        try { version = JSON.parse(await deps.az(versionArgs)); }
        catch (error) { if (error instanceof Refusal && error.message === 'X4_ARGV_REFUSED') throw error; }
        const cli = String(version?.['azure-cli']).match(/^(\d+)\.(\d+)\.\d+$/);
        check(cli && +cli[1] === 2 && +cli[2] >= 91 &&
          REVIEWED_CONTAINERAPP_VERSIONS.includes(version?.extensions?.containerapp), 'AZ_VERSION_UNREVIEWED');
        versionChecked = true;
      }
      checkX4Argv(args, target, id, values);
      await append('intent', { write: id, ...intent });
      let output, details;
      try {
        if (id === 'acr-build') output = await deps.azBuild(args, id, values);
        else await deps.azWrite(args, id, values);
      } catch (error) {
        const argvRefused = error instanceof Refusal && error.message === 'X4_ARGV_REFUSED';
        await append('failed', { write: id, failure: argvRefused ? error.message : failureCodes[id],
          azReturned: argvRefused || error?.processStarted === false ? false : null });
        if (argvRefused) throw error;
        refuse(failureCodes[id]);
      }
      try { details = await verify?.(output); }
      catch (error) {
        const failure = error instanceof Refusal && /^[A-Z][A-Z0-9_]+(?::|$)/.test(error.message)
          ? error.message.split(':')[0] : 'WRITE_VERIFICATION_FAILED';
        await append('failed', { write: id, failure,
          ...(error.traffic ? { observed: { traffic: error.traffic.observed }, plannedTraffic: error.traffic.expected } : {}) });
        throw error instanceof Refusal ? error : new Refusal(failure);
      }
      await append(step, { write: id, ...intent, ...details });
      return details;
    };
    const assertTraffic = async (expected, before) => {
      const observed = await traffic();
      if (!(before ? matchesPlannedTraffic(observed, expected, before) : trafficEquals(observed, expected))) {
        const error = new Refusal('TRAFFIC_NOT_AS_PLANNED');
        error.traffic = { expected, observed };
        throw error;
      }
      return observed;
    };
    const deactivate = async (append, name, step, expectedTraffic, state) => {
      const map = await assertTraffic(expectedTraffic);
      check(zero(map, name), 'REVISION_NOT_IDLE');
      await write({ append, id: 'deactivate', args: [...revisionActionArgs(target, 'deactivate', name), '-o', 'none'],
        values: [name], intent: { retireRevision: name }, step, verify: async () => {
          const rows = await list();
          check(rows.find(row => row.name === name)?.active === false, 'DEACTIVATE_NOT_CONFIRMED');
          return { ...(state ? { state } : {}), observed: { traffic: await assertTraffic(expectedTraffic), revisions: rows.map(({ name, active }) => ({ name, active })) } };
        } });
    };
    const verifySettings = async (args, evidence, revision) => {
      check(revision.prov !== 'Failed', 'REVISION_PROVISIONING_FAILED');
      check(revision.prov === 'Provisioned', 'REVISION_NOT_PROVISIONED');
      check(evidence?.before && evidence.expectedVolumes, 'JOURNAL_PLAN_UNREADABLE');
      checkRevisionSettings({ before: evidence.before, after: revision, input: args.input, decl,
        imageRef: args.imageRef, expectedVolumes: evidence.expectedVolumes,
        vaultBefore: evidence.before.vault, vaultAfter: await vault() });
    };
    const intermediateMatches = (revision, evidence) => !!evidence &&
      revision.image === evidence.before.image &&
      isDeepStrictEqual(revision.volumes, evidence.expectedVolumes) &&
      isDeepStrictEqual(revision.env, evidence.before.env) &&
      isDeepStrictEqual(revision.mounts, evidence.before.mounts);
    const verifyStage = async (args, evidence, expectedTraffic) => {
      check(zero(await assertTraffic(expectedTraffic), args.candidateRevision), 'REVISION_NOT_IDLE');
      const revision = await pollHealth(async () => {
        const current = await meta(args.candidateRevision);
        check(current.prov !== 'Failed', 'REVISION_PROVISIONING_FAILED');
        check(current.prov === 'Provisioned', 'REVISION_NOT_PROVISIONED');
        return current;
      }, provisioningTimeout);
      check(revision.active, 'REVISION_NOT_ACTIVE');
      await verifySettings(args, evidence, revision);
      await pollHealth(() => revisionHealth(revision, args.input.sourceSha, target.health.expect));
      await assertTraffic(expectedTraffic);
      return revision;
    };
    const completeStage = async ({ args, evidence, expectedTraffic, append, update, terminal }) => {
      if (update) {
        checkExpiry(args.input);
        check(await latest() === (args.intermediateRevision ?? evidence.before.latest), 'TEMPLATE_RACE');
        await assertTraffic(expectedTraffic);
        const currentVault = await vault();
        checkAlias(currentVault, args.input);
        check(args.input.envRefs.every(({ appRef }) => currentVault.some(({ name }) => name === appRef)), 'ALIAS_NOT_PROVISIONED');
        await write({ append, id: 'update', args: x4UpdateArgs(target, args.imageRef, args.input.revisionSuffix, args.input),
          values: [args.imageRef, args.input.revisionSuffix, args.input], intent: evidence, step: 'revision-created' });
      }
      const revision = await verifyStage(args, evidence, expectedTraffic);
      await append('verified', { ...evidence, verified: true, staged: true,
        observed: { traffic: expectedTraffic, revision } });
      const intermediate = args.intermediateRevision;
      if (intermediate && (await list()).find(row => row.name === intermediate)?.active) {
        const revision = await meta(intermediate);
        check(intermediateMatches(revision, evidence), 'REVISION_SETTINGS_MISMATCH');
        await deactivate(append, intermediate, 'deactivated', expectedTraffic);
      }
      if (terminal) await append('recovered', { state: 'staged' });
    };
    const verificationEvidence = opEntries.findLast(item => item.before && item.expectedVolumes);
    const stageArgs = ownStage?.args;
    const stageIdentity = ownStage?.target ?? identity;
    const checkPolicy = (bound, kind) => {
      if (status || allowsPolicyChange(kind)) {
        check(bound.resourceId?.toLowerCase() === identity.resourceId.toLowerCase() &&
          bound.containerName?.trim().toLowerCase() === identity.containerName?.trim().toLowerCase(), 'STAGE_POLICY_CHANGED');
      } else check(bound.policySha256 === identity.policySha256, 'STAGE_POLICY_CHANGED');
    };

    if (status || action === 'recover') {
      const resolved = journalPlan(opEntries, stageIdentity, opId);
      const { plan, entry, planSha256 } = resolved;
      const priorAction = plan.action === 'recover'
        ? opEntries.find(item => item.planSha256 === plan.args.priorPlanSha256)?.action : plan.action;
      const restoring = allowsPolicyChange(priorAction);
      const policyChanged = plan.target.policySha256 !== identity.policySha256 ||
        stageIdentity.policySha256 !== identity.policySha256;
      const staleStatus = status && policyChanged &&
        (!restoring || ['rolled-back', 'withdrawn', 'recovered'].includes(entry.step));
      if (status) {
        checkPolicy(plan.target, priorAction);
        checkPolicy(stageIdentity, priorAction);
      } else {
        check(!deOpted || restoring, 'G7_NOT_DECLARED');
        checkPolicy(plan.target, priorAction);
        if (restoring) {
          check(ownStage?.target, 'STAGE_POLICY_CHANGED');
          checkPolicy(stageIdentity, priorAction);
        }
      }
      let snapshot, observed = { readable: false, traffic: null, revisions: {} };
      try {
        const map = await traffic();
        const rows = await list();
        const last = await latest();
        const revisions = {};
        const names = new Set([plan.args.candidateRevision, plan.args.intermediateRevision, plan.args.restoreRevision,
          plan.args.retireRevision, entry.retireRevision, plan.action === 'withdraw' ? stageArgs?.intermediateRevision : null].filter(Boolean));
        for (const name of names) {
          const row = rows.find(item => item.name === name);
          if (!row) { revisions[name] = { exists: false }; continue; }
          const revision = await meta(name);
          check(revision.active === row.active, 'AZ_METADATA_UNREADABLE');
          const weight = map.filter(item => item.revisionName === name).reduce((total, item) => total + item.weight, 0);
          const matchesExpected = name === stageArgs?.intermediateRevision && intermediateMatches(revision, verificationEvidence);
          revisions[name] = { exists: true, active: row.active, weight, latest: last === name, matchesExpected, metadata: revision };
        }
        observed = { readable: true, traffic: map, revisions, latest: last,
          activeRevisions: rows.filter(row => row.active).map(row => row.name) };
        const afterTraffic = plan.args.resultingTraffic &&
          matchesPlannedTraffic(map, plan.args.resultingTraffic, plan.expected.traffic);
        if (!map.some(item => item.label !== null) && (trafficEquals(map, plan.expected.traffic) || afterTraffic)) {
          const splitRollback = plan.action === 'rollback' && plan.expected.servingRevision === null &&
            trafficEquals(map, plan.expected.traffic) && { candidateRevision: stageArgs?.candidateRevision,
              servingRevision: plan.args.restoreRevision };
          snapshot = await expectedState(splitRollback, priorAction, undefined, staleStatus);
          check(trafficEquals(snapshot.expected.traffic, map) &&
            isDeepStrictEqual(snapshot.expected.activeRevisions, observed.activeRevisions), 'EXPECTED_STATE_CHANGED');
          observed.servingSha = snapshot.expected.servingSha;
          observed.servingRevision = snapshot.expected.servingRevision;
          if (!staleStatus && trafficEquals(map, plan.expected.traffic) &&
              !(priorAction === 'rollback' && plan.expected.servingSha === null))
            check(observed.servingSha === plan.expected.servingSha, 'EXPECTED_STATE_CHANGED');
          if (stageAction(plan.action) && verificationEvidence) {
            observed.vaultSha256 = hash(await vault());
          }
          if (afterTraffic) {
            if (plan.action === 'switch') {
              try {
                const candidate = revisions[plan.args.candidateRevision]?.metadata;
                check(candidate?.active && stageArgs, 'REVISION_NOT_ACTIVE');
                await verifySettings(stageArgs, verificationEvidence, candidate);
                await health(target.health.url, plan.args.candidateSha, target.health.expect);
                observed.candidateHealthy = true;
              } catch { observed.candidateHealthy = false; }
            } else if (plan.action === 'rollback') {
              const restore = revisions[plan.args.restoreRevision]?.metadata;
              try {
                check(restore?.active && restore.prov === 'Provisioned' && restore.image === entry.restoreImage &&
                  digestPattern.test(restore.image), 'REVISION_IMAGE_MISMATCH');
                await health(target.health.url, plan.args.restoreSha, target.health.rollbackExpect);
                observed.restoreHealthy = true;
              } catch { observed.restoreHealthy = false; }
            }
          }
        }
      } catch { observed = { ...observed, readable: false }; }

      const effective = entry.retireRevision ? { ...plan, args: { ...plan.args, retireRevision: entry.retireRevision } } : plan;
      const decision = reconcile({ entries: [...opEntries.slice(0, -1), entry], observed, op: effective });
      const pendingWithdrawal = plan.action === 'withdraw' && [stageArgs?.candidateRevision, stageArgs?.intermediateRevision]
        .some(name => name !== entry.retireRevision && observed.revisions[name]?.active);
      const retirementState = plan.action === 'cleanup' ? 'cleaned' : pendingWithdrawal ? 'deactivated' : 'withdrawn';
      if (decision.state === 'deactivated') decision.state = stageAction(entry.action) ? 'staged' : retirementState;
      if (decision.state === 'recovered') decision.state = entry.state ?? 'recovered';
      if (decision.step === 'deactivate-intermediate' && (!zero(observed.traffic, plan.args.intermediateRevision) ||
          !observed.revisions[plan.args.intermediateRevision]?.matchesExpected))
        Object.assign(decision, { state: 'drift', step: null, revisions: [] });
      if (decision.step === 'finish-stage' && observed.revisions[plan.args.intermediateRevision]?.weight !== 0)
        Object.assign(decision, { state: 'drift', step: null, revisions: [] });
      const recovery = decision.step && snapshot && (!policyChanged || restoring) ? makePlan('recover', snapshot.expected, {
        ...(restoring ? { stagePolicySha256: stageIdentity.policySha256 } : {}),
        priorPlanSha256: planSha256, recoveryStep: decision.step, revisions: decision.revisions,
        resultingTraffic: ['record-switch', 'record-rollback'].includes(decision.step) ? plan.args.resultingTraffic : null,
        state: decision.state, observedSha256: hash(observed),
      }) : null;
      const weighted = observed.traffic?.filter(item => item.weight > 0) ?? [];
      const report = { state: decision.state, observed, nextStep: recovery ? decision.step : null,
        templateNotServing: !!observed.latest && weighted.length > 0 && weighted.every(item =>
          !item.latestRevision && item.revisionName !== null && item.revisionName !== observed.latest),
        expected: plan.expected, plan: recovery?.envelope ?? null, phrase: recovery?.phrase ?? null,
        ...(recovery ? { p64: recovery.p64, opId } : {}),
        ...(policyChanged ? { policyChanged: true } : {}),
        ...(decision.step === 'finish-stage' ? { needsInput: true } : {}) };
      if (status) return report;
      check(recovery, 'NOTHING_TO_RECOVER');
      if (decision.step === 'finish-stage')
        check(['Provisioned', 'Failed'].includes(observed.revisions[plan.args.intermediateRevision]?.metadata?.prov),
          'INTERMEDIATE_NOT_READY');
      if (dryRun) return { ...report, dryRun: true };
      await authorize(recovery);
      const recoveryFields = stageAction(plan.action) ?
        stageFields(plan.args, verificationEvidence?.inputSha256, verificationEvidence?.generation) : {};
      const append = journalFor(recovery, recoveryFields);
      await rowsMatch(recovery.envelope.expected);
      switch (decision.step) {
        case 'finish-stage':
        case 'reverify-stage': {
          let args = plan.args;
          if (decision.step === 'finish-stage') {
            await checkShape();
            let supplied;
            try { supplied = readInput(opt, target, deps); } catch { refuse('RECOVER_INPUT_MISMATCH'); }
            check(supplied.inputSha256 === verificationEvidence?.inputSha256 &&
              supplied.input.authorityReceiptSha256 === args.input.authorityReceiptSha256, 'RECOVER_INPUT_MISMATCH');
            check(await latest() === args.intermediateRevision, 'TEMPLATE_RACE');
            args = { ...args, input: supplied.input };
            check(actionP64({ ...plan, args }) === planSha256, 'RECOVER_INPUT_MISMATCH');
          }
          await completeStage({ args, evidence: { before: verificationEvidence.before, expectedVolumes: verificationEvidence.expectedVolumes },
            expectedTraffic: plan.expected.traffic, append, update: decision.step === 'finish-stage', terminal: true });
          break;
        }
        case 'deactivate-intermediate':
        case 'retry-deactivate':
          await deactivate(append, decision.revisions[0], 'recovered', recovery.envelope.expected.traffic,
            decision.step === 'deactivate-intermediate' ? 'staged' : retirementState);
          break;
        case 'record-switch':
        case 'record-rollback':
        case 'record-deactivated':
          await append('recovered', { state: { 'record-switch': 'switched', 'record-rollback': 'rolled-back',
            'record-deactivated': retirementState }[decision.step], observed });
          break;
        default: refuse('NOTHING_TO_RECOVER');
      }
      return { recovered: true, opId, p64: recovery.p64, recoveryStep: decision.step,
        ...(decision.step === 'record-switch' ? { switched: true, percent: 100,
          revision: plan.args.candidateRevision, sha: plan.args.candidateSha } : {}),
        ...(decision.step === 'record-rollback' ? { rolledBack: true,
          plan: { sha: plan.args.restoreSha, revision: plan.args.restoreRevision } } : {}) };
    }

    if (parsed) await checkShape();
    const switchResult = action === 'rollback' ? opEntries.findLast(item => item.action === 'switch' ||
      (item.action === 'recover' && item.step === 'recovered' && item.recoveryStep === 'record-switch' && item.state === 'switched')) : null;
    const switched = switchResult?.step === 'switched' || switchResult?.action === 'recover';
    let switchPlan, failedSwitch;
    if (action === 'rollback' && ownStage) {
      const switchEntries = switchResult?.action === 'recover'
        ? opEntries.filter(item => item.action === 'switch' && intentStep(item) && item.planSha256 === switchResult.priorPlanSha256)
        : opEntries.filter(item => item.action === 'switch');
      check(switchEntries.length, 'ROLLBACK_TARGET_NOT_ALLOWED');
      check(ownStage.target, 'STAGE_POLICY_CHANGED');
      checkPolicy(stageIdentity, action);
      ({ plan: switchPlan } = journalPlan(switchEntries, stageIdentity, opId));
      checkPolicy(switchPlan.target, action);
      if (!switched) {
        check(switchResult.step === 'switch-intent' ||
          (['intent', 'failed'].includes(switchResult.step) && switchResult.write === 'traffic'), 'ROLLBACK_TARGET_NOT_ALLOWED');
        failedSwitch = { candidateRevision: stageArgs.candidateRevision, servingRevision: switchPlan.expected.servingRevision };
      }
    }
    const { expected, revisions } = await expectedState(failedSwitch, action, switchPlan);
    let args, fields = {}, evidence, patch, retire = [], restoreImage;
    if (action === 'build') {
      args = { sha, imageTag: `${target.loginServer}/${target.image}:${sha}` };
    } else if (parsed) {
      const { input, inputSha256, generation } = parsed;
      let imageRef = pinnedImageRef(target.loginServer, target.image, input.image.digest);
      const candidateRevision = `${target.app}--${input.revisionSuffix}`;
      checkMount(await read(appMountsArgs(target)), decl);
      const vaultBefore = await vault();
      checkAlias(vaultBefore, input);
      check(input.envRefs.every(({ appRef }) => vaultBefore.some(({ name }) => name === appRef)), 'ALIAS_NOT_PROVISIONED');
      const template = await latest();
      check(revisions.some(row => row.name === template), 'AZ_METADATA_UNREADABLE');
      const before = { ...await meta(template), vault: vaultBefore };
      checkEnvCase(before.env.map(item => item.name), input);
      if (action === 'renew-authority') {
        check(input.sourceSha === expected.servingSha, 'SOURCE_SHA_MISMATCH');
        const serving = expected.servingRevision && await meta(expected.servingRevision);
        const verified = entries.findLast(item => item.step === 'verified' && item.verified === true &&
          item.revision === expected.servingRevision && item.sha === expected.servingSha);
        check(input.env.some(item => item.name === target.settings.revocationEnv && item.value === generation),
          'WEB_INTERLOCK_OPEN');
        check(verified && /^[1-9][0-9]*$/.test(verified.generation ?? '') &&
          BigInt(generation) > BigInt(verified.generation), 'GENERATION_NOT_HIGHER');
        const source = cfg?.targets?.[target.promoteFrom];
        const sourceImage = source?.type === 'containerapp' && source.loginServer && source.image
          ? pinnedImageRef(source.loginServer, source.image, input.image.digest) : null;
        check(serving?.image && (serving.image === imageRef || serving.image === sourceImage) &&
          (verified.imageRef ?? verified.image) === serving.image &&
          verified.digest === input.image.digest, 'DIGEST_PROVENANCE_UNPROVEN');
        imageRef = serving.image;
      } else {
        const built = entries.some(item => item.step === 'built' && item.sha === input.sourceSha && item.digest === input.image.digest);
        if (!built) {
          const src = cfg?.targets?.[target.promoteFrom];
          check(src?.type === 'containerapp' && src.health, 'DIGEST_PROVENANCE_UNPROVEN');
          const verified = (await history(target.promoteFrom)).findLast(item =>
            item.sha === input.sourceSha && (item.digest ?? item.args?.imageDigest) === input.image.digest &&
            item.verified === true && !item.staged && !item.intent &&
            (!Object.hasOwn(item, 'op') || (item.action === 'switch' && item.step === 'switched')));
          try {
            check(verified, 'DIGEST_PROVENANCE_UNPROVEN');
            const sourceImage = pinnedImageRef(src.loginServer, src.image, input.image.digest);
            const association = Object.hasOwn(verified, 'op')
              ? { ...verified, digest: input.image.digest, image: verified.image ?? sourceImage } : verified;
            promotionSourceAssociation(association, target.promoteFrom, input.sourceSha);
            await health(src.health.url, input.sourceSha, {}, src.health);
            checkAppShape(await deps.az(containerappShapeArgs(src)), src);
            const serving = pinnedTrafficRevision(await deps.az(containerappTrafficQueryArgs(src)));
            const image = (await deps.az(containerappRevisionImageArgs(src, serving))).trim();
            promotionSourceAssociation(association, target.promoteFrom, input.sourceSha, { serving, image });
            check(image === sourceImage, 'DIGEST_PROVENANCE_UNPROVEN');
            imageRef = sourceImage;
          } catch (error) {
            if (error instanceof Refusal && ['AZ_READ_FAILED', 'X4_ARGV_REFUSED'].includes(error.message)) throw error;
            refuse('DIGEST_PROVENANCE_UNPROVEN');
          }
        }
      }
      const volumes = volumeMetadata(await read(appVolumesArgs(target)));
      const needsPatch = volumePatchNeeded(volumes, decl, input.secretVolume.alias) ||
        volumes.find(volume => volume.name === decl.name)?.storageType !== 'Secret';
      patch = needsPatch ? volumePatchBody(volumes, decl, input.secretVolume.alias, input.revisionSuffix) : null;
      const intermediateRevision = patch ? candidateRevision + '-v' : null;
      check(!revisions.some(row => row.name === candidateRevision || row.name === intermediateRevision), 'REVISION_EXISTS');
      args = { input, imageRef, candidateRevision, intermediateRevision, volumePatchSha256: patch ? hash(patch) : null };
      fields = stageFields(args, inputSha256, generation);
      evidence = { before: { image: before.image, env: before.env, mounts: before.mounts, vault: before.vault, volumes, latest: template },
        expectedVolumes: patch?.properties.template.volumes ?? volumes };
    } else {
      check(ownStage, 'OP_NOT_FOUND');
      check(ownStage.target, 'STAGE_POLICY_CHANGED');
      checkPolicy(stageIdentity, action);
      journalPlan(opEntries, allowsPolicyChange(action) ? stageIdentity : identity, opId);
      const stagePlanSha256 = ownStage.planSha256;
      const { candidateRevision, intermediateRevision } = stageArgs;
      if (action === 'switch') {
        check(lastVerified, 'STAGE_NOT_VERIFIED');
        const servingStage = entries.findLast(item => item.op && item.step === 'verified' &&
          item.verified === true && item.revision === expected.servingRevision);
        if (servingStage) check([lastVerified.generation, servingStage.generation].every(value => /^[1-9][0-9]*$/.test(value ?? '')) &&
          BigInt(lastVerified.generation) > BigInt(servingStage.generation), 'GENERATION_NOT_NEWER');
        checkExpiry(stageArgs.input);
        await verifyStage(stageArgs, verificationEvidence, expected.traffic);
        args = { stagePlanSha256, candidateRevision, candidateSha: stageArgs.input.sourceSha,
          imageDigest: stageArgs.input.image.digest, percent: 100, resultingTraffic: plannedTraffic(candidateRevision) };
      } else if (action === 'rollback') {
        const restoreRevision = opt('to-revision');
        check(restoreRevision === switchPlan.expected.servingRevision &&
          restoreRevision !== candidateRevision && restoreRevision !== intermediateRevision, 'ROLLBACK_TARGET_NOT_ALLOWED');
        check(named(restoreRevision) && revisions.some(row => row.name === restoreRevision && row.active), 'ROLLBACK_TARGET_UNVERIFIED');
        const restore = await pollHealth(async () => {
          const revision = await meta(restoreRevision);
          check(revision.prov !== 'Failed', 'REVISION_PROVISIONING_FAILED');
          check(revision.prov === 'Provisioned', 'REVISION_NOT_PROVISIONED');
          return revision;
        });
        check(restore.active && digestPattern.test(restore.image), 'ROLLBACK_TARGET_UNVERIFIED');
        restoreImage = restore.image;
        args = { stagePlanSha256, fromRevision: expected.servingRevision, restoreRevision,
          restoreSha: await revisionHealth(restore, null, target.health.rollbackExpect), resultingTraffic: plannedTraffic(restoreRevision) };
      } else {
        const retireRevision = action === 'withdraw' ? candidateRevision : opt('retire-revision');
        check(named(retireRevision), 'REVISION_INVALID');
        const protectedRevisions = [...new Set([expected.servingRevision, action === 'cleanup' ? candidateRevision : null].filter(Boolean))];
        retire = [retireRevision, ...(action === 'withdraw' && intermediateRevision &&
          revisions.some(row => row.name === intermediateRevision && row.active) ? [intermediateRevision] : [])];
        for (const name of retire) {
          check(!protectedRevisions.includes(name) && zero(expected.traffic, name), 'REVISION_NOT_IDLE');
          const row = revisions.find(row => row.name === name);
          if (action === 'cleanup') {
            check(row?.active, 'REVISION_NOT_ACTIVE');
            await meta(name);
          } else if (row?.active) {
            const write = name === candidateRevision ? 'update' : 'volume-patch';
            check(opEntries.some(item => item.step === 'intent' && item.write === write &&
              ((stageAction(item.action) && item.planSha256 === stagePlanSha256) ||
                (item.action === 'recover' && item.priorPlanSha256 === stagePlanSha256))), 'JOURNAL_PLAN_UNREADABLE');
          }
        }
        retire = retire.filter(name => revisions.find(row => row.name === name)?.active);
        args = { stagePlanSha256, retireRevision, protectedRevisions };
      }
    }

    if (allowsPolicyChange(action)) args.stagePolicySha256 = stageIdentity.policySha256;
    const approval = makePlan(action, expected, args);
    if (!opId) check(!entries.some(item => item.op === approval.opId && item.planSha256 !== approval.p64), 'OP_ID_COLLISION');
    if (dryRun) return { dryRun: true, opId: approval.opId, p64: approval.p64, phrase: approval.phrase,
      plan: display(approval.envelope, fields.inputSha256) };
    await authorize(approval);
    await rowsMatch(expected, failedSwitch, switchPlan);
    const append = journalFor(approval, fields);
    if (action === 'build') {
      await write({ append, id: 'acr-build', args: acrBuildArgs(target, sha), values: [sha], step: 'built', verify: output => {
        let receipt;
        try { receipt = acrRunDigest(output, { ...target, sha }); } catch { refuse('ACR_RUN_UNREADABLE'); }
        check(named(receipt.runId), 'ACR_RUN_UNREADABLE');
        return { ...receipt, ...args };
      } });
    } else if (parsed) {
      checkExpiry(args.input);
      check(await latest() === evidence.before.latest, 'TEMPLATE_RACE');
      if (patch) {
        const bodyFile = await deps.writeBodyFile(patch);
        await write({ append, id: 'volume-patch', args: volumePatchArgs(target, bodyFile), values: [bodyFile], intent: { ...evidence, beforeLatest: evidence.before.latest },
          step: 'intermediate', verify: async () => {
            const deadline = deps.now() + provisioningTimeout;
            for (let elapsed = 0; elapsed <= provisioningTimeout; elapsed += 5000) {
              const currentLatest = await latest();
              check(currentLatest === evidence.before.latest || currentLatest === args.intermediateRevision, 'TEMPLATE_RACE');
              const map = await assertTraffic(expected.traffic);
              const row = (await list()).find(item => item.name === args.intermediateRevision);
              if (row) {
                const revision = await meta(row.name);
                if (currentLatest === args.intermediateRevision && ['Provisioned', 'Failed'].includes(revision.prov) &&
                    isDeepStrictEqual(revision.volumes, evidence.expectedVolumes)) {
                  check(zero(map, row.name) && intermediateMatches(revision, evidence), 'REVISION_SETTINGS_MISMATCH');
                  return { observed: { traffic: map, revision } };
                }
              }
              const remaining = Math.min(deadline - deps.now(), provisioningTimeout - elapsed);
              if (remaining < 5000) break;
              await deps.sleep(5000);
            }
            refuse('VOLUME_PATCH_TIMEOUT');
          } });
      }
      await completeStage({ args, evidence, expectedTraffic: expected.traffic, append, update: true });
    } else if (action === 'switch' || action === 'rollback') {
      const switching = action === 'switch';
      const destination = switching ? args.candidateRevision : args.restoreRevision;
      const destinationSha = switching ? args.candidateSha : args.restoreSha;
      const expect = switching ? target.health.expect : target.health.rollbackExpect;
      if (switching) checkExpiry(stageArgs.input);
      await checkShape();
      await write({ append, id: 'traffic', values: [destination], args: [...containerappTrafficSetArgs(target, destination), '-o', 'none'],
        intent: switching ? {} : { restoreImage }, step: switching ? 'switched' : 'rolled-back', verify: async () => {
          await assertTraffic(args.resultingTraffic, expected.traffic);
          const revision = await meta(destination);
          check(revision.active && revision.image === (switching ? stageArgs.imageRef : restoreImage), 'REVISION_IMAGE_MISMATCH');
          if (switching) await verifySettings(stageArgs, verificationEvidence, revision);
          await pollHealth(async () => {
            const current = await meta(destination);
            check(current.prov !== 'Failed', 'REVISION_PROVISIONING_FAILED');
            check(current.prov === 'Provisioned', 'REVISION_NOT_PROVISIONED');
            const results = await Promise.allSettled([
              health(target.health.url, destinationSha, expect),
              revisionHealth(current, destinationSha, expect),
            ]);
            const failed = results.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
          });
          const map = await assertTraffic(args.resultingTraffic, expected.traffic);
          return { observed: { traffic: map, revision }, revision: destination, sha: destinationSha, verified: true,
            ...(switching ? { digest: stageArgs.input.image.digest, image: stageArgs.imageRef } : {}) };
        } });
      if (switching) return { opId: approval.opId, p64: approval.p64, action, switched: true,
        percent: args.percent, revision: destination, sha: destinationSha };
      return { opId: approval.opId, p64: approval.p64, action, rolledBack: true,
        plan: { sha: destinationSha, revision: destination } };
    } else {
      for (const name of retire) await deactivate(append, name, 'deactivated', expected.traffic);
      await append(action === 'cleanup' ? 'cleaned' : 'withdrawn', { retireRevision: args.retireRevision });
    }
    return { opId: approval.opId, p64: approval.p64, action };
  } finally {
    if (locked) await deps.lock.release();
  }
}

// The CLI adapters own temporary files and process I/O. runX4 only uses its injected dependencies.
export function checkX4Argv(args, target, writeId, values = []) {
  check(azCommandWords(args), 'X4_ARGV_REFUSED');
  if (writeId === 'volume-patch') check(args.includes('--only-show-errors'), 'X4_ARGV_REFUSED');
  args = stripAzLoggerFlags(args);
  let expected;
  switch (writeId) {
    case 'volume-patch':
      expected = ['rest', '--method', 'PATCH', '--url',
        `https://management.azure.com/subscriptions/${target.subscription}/resourceGroups/${target.resourceGroup}/providers/Microsoft.App/containerApps/${target.app}?api-version=${X4_ARM_API_VERSION}`,
        '--body', '@' + values[0], '-o', 'none', '--only-show-errors'];
      break;
    case 'update': expected = x4UpdateArgs(target, ...values); break;
    case 'traffic': expected = [...containerappTrafficSetArgs(target, ...values), '-o', 'none']; break;
    case 'deactivate': expected = [...revisionActionArgs(target, 'deactivate', ...values), '-o', 'none']; break;
    case 'acr-build': expected = acrBuildArgs(target, ...values); break;
    case undefined: {
      if (isDeepStrictEqual(args, versionArgs)) return;
      const queries = args.filter(arg => arg === '--query' || arg.startsWith('--query='));
      const query = args[args.indexOf('--query') + 1];
      const selector = target.container && `properties.template.containers[?name=='${target.container}'] | [0]`;
      check(queries.length === 1 && queries[0] === '--query' && typeof query === 'string' &&
        X4_ALLOWED_QUERIES.has(selector ? query.replaceAll(selector, 'properties.template.containers[0]') : query),
        'X4_ARGV_REFUSED');
      const revision = args[args.indexOf('--revision') + 1];
      const builders = [containerappShapeArgs, containerappTrafficQueryArgs, appLatestArgs, appMountsArgs,
        appVaultRefsArgs, appVolumesArgs, revisionListArgs];
      if (args.includes('--revision') && named(revision)) builders.push(revisionMetaArgs, containerappRevisionImageArgs);
      check(builders.some(builder => isDeepStrictEqual(args, stripAzLoggerFlags(builder(target, revision)))), 'X4_ARGV_REFUSED');
      return;
    }
    default: refuse('X4_ARGV_REFUSED');
  }
  check(isDeepStrictEqual(args, stripAzLoggerFlags(expected)), 'X4_ARGV_REFUSED');
}

export async function runX4Main({ argv, repo, targetName, target, cfg, git, remote, branch, loadHistory, historyStore, sha, sh, shQuiet, confirm }) {
  const lockPath = join(historyStore.dir, 'x4.lock');
  let bodyDir;
  const timeoutSeconds = target.health?.timeoutSeconds ?? 300;
  function releaseLock() {
    process.off('SIGINT', onLockSignal);
    process.off('SIGTERM', onLockSignal);
    try {
      if (readFileSync(lockPath, 'utf8').startsWith(`${process.pid} `)) unlinkSync(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function onLockSignal(signal) {
    try {
      if (bodyDir) rmSync(bodyDir, { recursive: true, force: true });
    } finally {
      try { releaseLock(); }
      finally { process.exit(signal === 'SIGINT' ? 130 : 143); }
    }
  }
  const source = cfg.targets?.[target.promoteFrom];
  function cliAzure(args, id, values) {
    try {
      checkX4Argv(args, target, id, values);
    } catch (error) {
      if (id || !source) throw error;
      checkX4Argv(args, source);
    }
    const env = { ...process.env, AZURE_LOGGING_ENABLE_LOG_FILE: 'no' };
    if (id === 'acr-build') {
      const work = mkdtempSync(join(tmpdir(), 'deploy-x4-build-'));
      try {
        const src = join(work, 'src'), tar = join(work, 'src.tar');
        mkdirSync(src);
        execFileSync('git', ['--no-replace-objects', '-C', repo, 'archive', '--format=tar', '-o', tar, sha],
          { stdio: ['ignore', 'ignore', 'pipe'] });
        execFileSync('tar', ['-xf', tar, '-C', src], { stdio: ['ignore', 'ignore', 'pipe'] });
        return sh('az', args, { cwd: src, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.max(1800, timeoutSeconds) * 1000 });
      } finally { rmSync(work, { recursive: true, force: true }); }
    }
    if (id) return shQuiet(args, Math.max(600, timeoutSeconds) * 1000, { env });
    try { return sh('az', args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); }
    catch { refuse('AZ_READ_FAILED'); }
  }
  try {
    return await runX4({ argv, repo, targetName, target, cfg, git,
      history: name => cfg.targets[name] ? loadHistory(name).entries : [],
      deps: {
        shaOnDefault: sha => {
          try { git('merge-base', '--is-ancestor', sha, `refs/remotes/${remote}/${branch}`); return true; }
          catch { return false; }
        },
        az: cliAzure,
        azWrite: cliAzure,
        azBuild: cliAzure,
        fetchHealth: async url => {
          const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
          return { status: response.status, body: await response.text() };
        },
        now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        lock: {
          path: lockPath,
          acquire: () => {
            mkdirSync(historyStore.dir, { recursive: true, mode: 0o700 });
            const fd = openSync(lockPath, 'wx', 0o600);
            try {
              try { writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`); }
              finally { closeSync(fd); }
            } catch (error) {
              unlinkSync(lockPath);
              throw error;
            }
            process.on('SIGINT', onLockSignal);
            process.on('SIGTERM', onLockSignal);
          },
          release: releaseLock,
        },
        journal: {
          entries: () => readHistory(historyStore.dir),
          append: entry => appendAppHistory(historyStore, entry),
        },
        readFile: readFileSync,
        writeBodyFile: body => {
          bodyDir = mkdtempSync(join(tmpdir(), 'deploy-x4-body-'));
          const path = join(bodyDir, 'patch.json');
          writeFileSync(path, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
          return path;
        },
        isTTY: !!process.stdin.isTTY, env: process.env, confirm,
      },
    });
  } finally {
    if (bodyDir) rmSync(bodyDir, { recursive: true, force: true });
  }
}
