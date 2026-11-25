#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { scrubEnv } from './secret-patterns.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gptReviewArgs, parseEvents, synthesizeReviewStream, verifyGptRuntime } from './gpt-review.mjs';
import { isConfiguredPin, loadTeam, loadTeamChecked, reviewChain, reviewerProblem, role, sameModel, teamForWriter, teamProvider, unsetRole, vendorOf } from './team.mjs';
import { alias, assertPacketModelFree } from './packet-check.mjs';

const closureReviewRole = `reviewer-${alias.closureReview}`;

const sha256Value = value => createHash('sha256').update(value).digest('hex');
const promotionLockOwnerForRepo = rawRepo => {
  const repo = resolve(rawRepo);
  const git = args => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !String(result.stdout || '').trim()) throw new Error('PROMOTION_LOCK_OWNER_UNAVAILABLE: cannot resolve the repository/worktree identity.');
    return String(result.stdout).trim();
  };
  const worktreeRoot = realpathSync(git(['rev-parse', '--show-toplevel']));
  const commonDir = git(['rev-parse', '--git-common-dir']);
  const repositoryGitCommonDir = realpathSync(resolve(worktreeRoot, commonDir));
  const key = sha256Value(JSON.stringify({ repositoryGitCommonDir, worktreeRoot }));
  return { schema: 1, repositoryGitCommonDir, worktreeRoot, key };
};
const validPromotionLockOwner = owner => owner?.schema === 1
  && typeof owner.repositoryGitCommonDir === 'string' && isAbsolute(owner.repositoryGitCommonDir)
  && typeof owner.worktreeRoot === 'string' && isAbsolute(owner.worktreeRoot)
  && typeof owner.key === 'string'
  && owner.key === sha256Value(JSON.stringify({ repositoryGitCommonDir: owner.repositoryGitCommonDir, worktreeRoot: owner.worktreeRoot }));
const samePromotionLockOwner = (left, right) => validPromotionLockOwner(left) && validPromotionLockOwner(right)
  && left.repositoryGitCommonDir === right.repositoryGitCommonDir && left.worktreeRoot === right.worktreeRoot && left.key === right.key;
const promotionLockPathFor = (runRoot, owner) => join(runRoot, `PROMOTION_LOCK.${owner.key}.json`);
const promotionLockAmbiguous = (lockPath, reason) => new Error(`PROMOTION_LOCK_OWNER_AMBIGUOUS: ${lockPath} ${reason}. Refusing to determine lock scope.`);
const legacyPromotionLockOwner = (lock, lockPath) => {
  if (!lock || typeof lock !== 'object' || typeof lock.reviewContext !== 'string' || !isAbsolute(lock.reviewContext) || !existsSync(lock.reviewContext)) {
    throw promotionLockAmbiguous(lockPath, 'does not name a readable review context');
  }
  if (lstatSync(lock.reviewContext).isSymbolicLink()) throw promotionLockAmbiguous(lockPath, 'review context is a symbolic link');
  let contextBytes; let context;
  try {
    contextBytes = readFileSync(lock.reviewContext);
    context = JSON.parse(contextBytes);
  } catch {
    throw promotionLockAmbiguous(lockPath, 'review context is not valid JSON');
  }
  const schemaTwo = context?.schema === 2 && typeof context.contextSha256 === 'string' && typeof lock.reviewContextSha256 === 'string';
  const schemaOne = context?.schema === 1 && typeof lock.reviewIdentity?.contextSha256 === 'string';
  if (schemaTwo) {
    const unsigned = { ...context }; delete unsigned.contextSha256;
    if (context.contextSha256 !== sha256Value(JSON.stringify(unsigned)) || lock.reviewContextSha256 !== context.contextSha256) {
      throw promotionLockAmbiguous(lockPath, 'review context hash binding is invalid');
    }
  } else if (schemaOne) {
    if (lock.reviewIdentity.contextSha256 !== sha256Value(contextBytes)) {
      throw promotionLockAmbiguous(lockPath, 'review context byte hash does not match the lock');
    }
  } else {
    throw promotionLockAmbiguous(lockPath, 'review context lacks a verifiable binding');
  }
  if (typeof context.candidateWorktree !== 'string' || !isAbsolute(context.candidateWorktree)) {
    throw promotionLockAmbiguous(lockPath, 'review context lacks an absolute candidate worktree');
  }
  try { return promotionLockOwnerForRepo(context.candidateWorktree); }
  catch { throw promotionLockAmbiguous(lockPath, 'candidate worktree identity cannot be resolved'); }
};
const readPromotionLock = lockPath => {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); }
  catch { throw promotionLockAmbiguous(lockPath, 'is not valid JSON'); }
};
const resolvePromotionLockForOwner = (runRoot, owner) => {
  const ownerPath = promotionLockPathFor(runRoot, owner);
  if (existsSync(ownerPath)) {
    const lock = readPromotionLock(ownerPath);
    if (!samePromotionLockOwner(lock.owner, owner)) throw new Error(`PROMOTION_LOCK_OWNER_MISMATCH: ${ownerPath} does not match this repository/worktree identity.`);
    return { path: ownerPath, lock, legacy: false };
  }
  const legacyPath = join(runRoot, 'PROMOTION_LOCK.json');
  if (!existsSync(legacyPath)) return null;
  const lock = readPromotionLock(legacyPath);
  const legacyOwner = legacyPromotionLockOwner(lock, legacyPath);
  return samePromotionLockOwner(legacyOwner, owner) ? { path: legacyPath, lock, legacy: true } : null;
};
const parse = values => Object.fromEntries(values.reduce((a, v, i) => i % 2 ? a : [...a, [v.replace(/^--/, ''), values[i + 1]]], []));
const a = parse(process.argv.slice(2));
if (a['promotion-check'] === 'true') {
  const repo = resolve(a.repo || '.');
  const runRoot = resolve(a.run || '');
  const promotionLockOwner = promotionLockOwnerForRepo(repo);
  const promotionLock = resolvePromotionLockForOwner(runRoot, promotionLockOwner);
  const lockPath = promotionLock?.path || promotionLockPathFor(runRoot, promotionLockOwner);
  const rehearsalPath = resolve(a['rehearsal-receipt'] || '');
  if (!promotionLock) throw new Error('PROMOTION_LOCK_MISSING: deploy is forbidden until a final clean review writes a repository-scoped promotion lock.');
  if (!a['rehearsal-receipt'] || !existsSync(rehearsalPath)) throw new Error('PROMOTION_REHEARSAL_MISSING: pass --rehearsal-receipt <path> after target-faithful clean-source rehearsal.');
  const lock = promotionLock.lock;
  const rehearsal = JSON.parse(readFileSync(rehearsalPath, 'utf8'));
  const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const dirty = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const sameReviewedTree = /^[0-9a-f]{40}$/.test(lock.frozenSourceSha || '') && head !== lock.frozenSourceSha
    && spawnSync('git', ['-C', repo, 'diff', '--quiet', lock.frozenSourceSha, head], { windowsHide: true }).status === 0;
  if (!/^[0-9a-f]{40}$/.test(lock.frozenSourceSha || '') || (!sameReviewedTree && head !== lock.frozenSourceSha) || dirty) throw new Error(`PROMOTION_LOCK_MISMATCH: lock=${lock.frozenSourceSha || 'invalid'} head=${head || 'unavailable'} equivalentTree=${sameReviewedTree} dirty=${Boolean(dirty)}. Do not deploy.`);
  if (rehearsal.schema !== 1 || (rehearsal.frozenSourceSha !== lock.frozenSourceSha && !(sameReviewedTree && rehearsal.frozenSourceSha === head))) throw new Error('PROMOTION_REHEARSAL_SHA_MISMATCH: rehearsal must identify the reviewed source or a byte-identical merged source tree.');
  const rehearsalGates = ['cleanSource', 'entrypoints', 'lineEndings', 'livePreflight', 'readiness', 'cloudPayloads', 'rollback'];
  for (const gate of rehearsalGates) {
    const item = rehearsal.gates?.[gate];
    if (!item || !['passed', 'not_applicable'].includes(item.status)) throw new Error(`PROMOTION_REHEARSAL_INVALID: gate ${gate} requires status passed or not_applicable.`);
    if (item.status === 'passed' && (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.some(value => typeof value !== 'string' || !value.trim()))) throw new Error(`PROMOTION_REHEARSAL_INVALID: passed gate ${gate} requires non-empty evidence.`);
    if (item.status === 'not_applicable' && (gate === 'rollback' || typeof item.reason !== 'string' || !item.reason.trim())) throw new Error(`PROMOTION_REHEARSAL_INVALID: gate ${gate} requires an explicit reason and rollback cannot be not_applicable.`);
  }
  process.stdout.write(`${JSON.stringify({ status: 'promotion_ready', runRoot, lockPath, rehearsalPath, frozenSourceSha: lock.frozenSourceSha })}\n`);
  process.exit(0);
}
if (a.status === 'true') {
  const output = resolve(a.output || '');
  if (!output) throw new Error('Status mode requires --output <receipt>.');
  const heartbeatPath = `${output}.heartbeat.jsonl`;
  const monitorPath = `${output}.monitor.json`;
  const monitor = existsSync(monitorPath) ? JSON.parse(readFileSync(monitorPath, 'utf8')) : null;
  const lines = existsSync(heartbeatPath)
    ? readFileSync(heartbeatPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    : [];
  let heartbeat = null;
  if (lines.length) {
    try { heartbeat = JSON.parse(lines.at(-1)); } catch { heartbeat = { malformed: true }; }
  }
  const pid = monitor?.terminal === false ? monitor.launcherPid ?? heartbeat?.pid : monitor?.pid ?? heartbeat?.pid ?? null;
  let processState = 'unknown';
  if (pid) {
    try { process.kill(pid, 0); processState = 'alive'; } catch (error) { processState = error.code === 'EPERM' ? 'alive' : 'exited'; }
  }
  // Legacy monitors predate the explicit terminal flag and remain readable.
  const terminal = Boolean(monitor) && monitor.terminal !== false;
  const status = terminal
    ? monitor.timedOut ? 'timed_out' : monitor.exitCode === 0 ? 'completed' : 'failed'
    : heartbeat ? processState === 'alive' ? 'running' : 'unverified' : 'not_started';
  const monitorSummary = monitor && {
    role: monitor.role,
    pid: monitor.pid,
    startedAt: monitor.startedAt,
    completedAt: monitor.completedAt,
    elapsedMs: monitor.elapsedMs,
    exitCode: monitor.exitCode,
    signal: monitor.signal,
    timedOut: monitor.timedOut,
    stdoutBytes: monitor.stdoutBytes,
    stderrBytes: monitor.stderrBytes,
    selectedReviewerEngine: monitor.selectedReviewerEngine,
    phase: monitor.phase
  };
  process.stdout.write(`${JSON.stringify({ status, processState, output, heartbeatPath, monitorPath, heartbeat, monitor: monitorSummary })}\n`);
  process.exit(0);
}
const removedGraphOption = ['DIRECT_EXECUTOR_ORIENTATION', 'DIRECT_GRAFT_WORKTREE_SYNC', 'DIRECT_GRAFT_LSP']
  .find(name => process.env[name] === '1');
if (removedGraphOption) throw new Error(`${removedGraphOption}: graft removed; opt-in executor/sync unavailable`);
const repo = resolve(a.repo || '.');
const prompt = resolve(a.prompt || '');
const output = resolve(a.output || '');
// Default-off recorder setup must precede packet validation so a failed
// preflight is observable when measurement is explicitly enabled.
const directOutOfRootGuardEnabled = process.env.DIRECT_OUT_OF_ROOT_GUARD === '1' && a.role?.startsWith('executor-');
// The guard must leave an auditable terminal record even when callers did not
// separately opt into general lane telemetry.
const directLaneTelemetryEnabled = process.env.DIRECT_LANE_TELEMETRY === '1' || directOutOfRootGuardEnabled;
const telemetryLaneStartedAtMs = Date.now();
const heartbeatPath = `${output}.heartbeat.jsonl`;
const eventsPath = `${output}.events.jsonl`;
const stderrPath = `${output}.stderr.log`;
const monitorPath = `${output}.monitor.json`;
let telemetryTerminalFinalizer = null;
if (directLaneTelemetryEnabled && a.output) {
  process.on('uncaughtException', error => {
    if (telemetryTerminalFinalizer) return;
    const completedAtMs = Date.now();
    const failure = error instanceof Error ? error.message : String(error);
    try {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(monitorPath, `${JSON.stringify({
        role: a.role || null,
        output,
        startedAt: new Date(telemetryLaneStartedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        elapsedMs: completedAtMs - telemetryLaneStartedAtMs,
        modelExitCode: null,
        exitCode: 1,
        timedOut: false,
        terminal: true,
        phase: 'failed',
        failure,
        failureClassification: 'preflight-throw',
        timing: {
          lane: { startedAt: new Date(telemetryLaneStartedAtMs).toISOString(), completedAt: new Date(completedAtMs).toISOString(), elapsedMs: completedAtMs - telemetryLaneStartedAtMs },
          model: { startedAt: null, completedAt: null, elapsedMs: null },
          verification: { startedAt: null, completedAt: new Date(completedAtMs).toISOString(), elapsedMs: 0 }
        }
      }, null, 2)}\n`, 'utf8');
    } catch { }
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
if (a.role === 'executor-terra' || a.role === 'deepseek') {
  console.error(`TEAM_ROLE_UNKNOWN: ${a.role}; use team-role.mjs writer`);
  process.exit(2);
}
const roles = ['explorer', 'planner', 'executor-sol', 'executor-cubic', 'reviewer', 'reviewer-plan', closureReviewRole];
if (!roles.includes(a.role) || !existsSync(prompt) || !output) throw new Error('Use --role, --repo, --prompt, and --output.');
const revalidateExisting = a['revalidate-existing'] === 'true';
if (revalidateExisting && a.role !== 'reviewer' && a.role !== closureReviewRole) {
  throw new Error('--revalidate-existing is permitted only for reviewer evidence.');
}
mkdirSync(dirname(output), { recursive: true });
const rawInput = readFileSync(prompt, 'utf8');
const isCodeReviewer = a.role === 'reviewer' || a.role === closureReviewRole;
const isClaudeReview = isCodeReviewer || a.role === 'reviewer-plan';
// --review-engine gpt runs reviewer / reviewer-plan through Codex instead of Claude;
// every contract, marker, receipt, revalidation and promotion-lock rule stays identical.
const requestedReviewEngine = a['review-engine'];
if (requestedReviewEngine !== undefined && !['claude', 'gpt'].includes(requestedReviewEngine)) throw new Error(`--review-engine must be claude or gpt; got ${requestedReviewEngine}.`);
// Code reviews use the Team fallback for the explicit or Settings writer provider.
const runRootMatch = output.match(/^(.*[\\/](?:\.trioharness-direct[\\/]runs|trioharness-direct-runs)[\\/][^\\/]+)/i);
const runRoot = runRootMatch?.[1] || null;
const arb = a.role === 'reviewer' && runRoot
  ? await import(existsSync(new URL('./arbiter.mjs', import.meta.url)) ? './arbiter.mjs' : '../../config/arbiter-lib.mjs')
  : null;
const escalationTeam = arb?.loadEscalationTeam({ repo });
const team = isClaudeReview ? escalationTeam ?? loadTeamChecked({ repo }) : null;
if (team?.app?.hostReview || team?.app?.hostReviewRequired) throw new Error('HOST_REVIEW_REQUIRED: use the authenticated CodeDen host review route');
if (escalationTeam) {
  const stage = arb.codeStage(escalationTeam, runRoot, arb.readJsonl(join(runRoot, 'CODE_REVIEW_ROUNDS.jsonl')));
  if (stage.blocked) throw new Error(`ITEM_BLOCKED: ${stage.blocked.reason}`);
  if (stage.cycle.pastLimit) throw new Error('ARBITER_REQUIRED: a code review ran after escalation was due');
  if (stage.phase !== 'review') throw new Error(`ARBITER_REQUIRED: the code stage is ${stage.phase}; use team-review.mjs`);
}
// The Codex writer lanes run the Team's Writer model.
const writerTeam = isClaudeReview ? null : process.env.TEAM_FILE ? loadTeamChecked({ repo }) : loadTeam();
const scanModelLiterals = (text, path) => {
  try {
    assertPacketModelFree(text, path, team ?? writerTeam);
  } catch (error) {
    console.error(error.message);
    process.exit(error.exit || 2);
  }
};
if (isClaudeReview && !a.brief) {
  console.error('--brief is required for review roles. Pass the writer-authored instructions.');
  process.exit(2);
}
if (a.brief) {
  const brief = resolve(a.brief);
  const instructions = readFileSync(brief, 'utf8');
  if (!rawInput.includes(instructions)) {
    console.error(`PACKET_BRIEF_MISMATCH: ${brief}: brief does not match the prompt (${prompt}).`);
    process.exit(2);
  }
  scanModelLiterals(instructions, brief);
}
scanModelLiterals(rawInput, prompt);
const refuseUnset = key => { console.error(unsetRole(key)); process.exit(2); };
if (writerTeam && !isConfiguredPin(writerTeam.roles.writer)) refuseUnset('writer');
const writer = writerTeam && role(writerTeam, 'writer');
if (writer && writer.provider !== 'codex') throw new Error('TEAM_ROLE_MISMATCH: invoke-lane requires a Codex Writer');
const reviewKey = a.role === 'reviewer-plan' ? 'planReviewer' : 'reviewerFallback';
const reviewWriter = teamProvider(team, a.writer?.trim() || team?.roles.writer?.provider);
const reviewSlot = a['review-slot'] || 'fallback';
if (!['fallback', 'second-pass'].includes(reviewSlot)) throw new Error('--review-slot must be fallback or second-pass (invoke-lane cannot run the primary Code Reviewer).');
let reviewPin = team?.roles.planReviewer;
if (isCodeReviewer) {
  if (!reviewWriter || reviewWriter === 'auto' || !vendorOf(team, reviewWriter)) {
    console.error(`${unsetRole('writer')} or pass --writer <provider>.`);
    process.exit(2);
  }
  try {
    const resolved = teamForWriter(team, reviewWriter);
    const { fallbacks } = reviewChain(resolved, reviewWriter);
    let problem;
    reviewPin = fallbacks.find(reviewer => !(problem = reviewerProblem(resolved, { slot: reviewSlot, writer: reviewWriter, reviewer })));
    if (!reviewPin) throw new Error(problem ?? unsetRole(reviewKey));
  } catch (error) {
    console.error(`TEAM_ROLE_UNSET: no cross-vendor reviewer for ${reviewWriter}-written code. ${error.message}`);
    process.exit(2);
  }
}
if (team && !isConfiguredPin(reviewPin)) refuseUnset(reviewKey);
if (team && reviewKey === 'planReviewer') role(team, reviewKey);
const reviewEngine = { codex: 'gpt', claude: 'claude' }[reviewPin?.provider];
if (team && (!reviewEngine || (requestedReviewEngine && requestedReviewEngine !== reviewEngine))) {
  throw new Error(`TEAM_ROLE_MISMATCH: Settings → Team selects ${reviewPin.provider} for --role ${a.role}`);
}
if (reviewEngine === 'gpt' && a.role !== 'reviewer' && a.role !== 'reviewer-plan') throw new Error('--review-engine gpt applies only to --role reviewer or reviewer-plan.');
if ((a['review-model'] || a['review-effort']) && !isClaudeReview) throw new Error('--review-model / --review-effort apply only to review roles.');
if (a['review-model'] && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{1,79}$/.test(a['review-model'])) throw new Error(`--review-model is not a valid model id: ${a['review-model']}`);
if (a['review-effort'] && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(a['review-effort'])) throw new Error(`--review-effort must be minimal|low|medium|high|xhigh|max; got ${a['review-effort']}.`);
const { model: reviewModel, effort: reviewEffort } = reviewPin ?? {};
if (team && ((a['review-model'] && !sameModel(team, reviewPin.provider, reviewModel, a['review-model'], [{ ...reviewPin, model: a['review-model'] }])) || (a['review-effort'] && a['review-effort'] !== reviewEffort))) {
  throw new Error(`TEAM_MODEL_MISMATCH: Settings → Team selects ${reviewModel}/${reviewEffort} for --role ${a.role}`);
}
const reviewFallbackReason = a['fallback-reason'] || 'invoke-lane cannot run the primary Code Reviewer (agy)';
const reviewEngineLabel = reviewPin ? `${reviewPin.provider}/${reviewModel}(${reviewEffort})` : null;
const reviewRuntimeCwd = `${output}.runtime`;
if (isClaudeReview) {
  const runtimeRelative = relative(repo, reviewRuntimeCwd);
  if (!isAbsolute(runtimeRelative) && runtimeRelative !== '..' && !runtimeRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('REVIEW_RECEIPTS_MUST_BE_EXTERNAL: keep receipts and wrapper runtime outside the frozen review checkout.');
  }
}
const isLocalPrecommitReview = /^CODE_REVIEW_TARGET:\s*LOCAL_PRECOMMIT\s*$/mi.test(rawInput);
const initialPlanOnly = new RegExp(`^(?:${alias.closureReview}|${alias.initialPlan})_PLAN_GATE:\\s*INITIAL_ONLY\\s*$`, 'mi').test(rawInput);
const fableInitialPlanReceipt = runRootMatch ? join(runRootMatch[1], 'FABLE_INITIAL_PLAN_RECEIPT.json') : null;
const codeReviewReceipt = runRootMatch ? join(runRootMatch[1], 'CODE_REVIEW_ROUNDS.jsonl') : null;
const promotionLockOwner = runRoot ? promotionLockOwnerForRepo(repo) : null;
const promotionLockPath = promotionLockOwner ? promotionLockPathFor(runRoot, promotionLockOwner) : null;
if (a.role === 'reviewer-plan' && (!initialPlanOnly || !fableInitialPlanReceipt)) {
  throw new Error('reviewer-plan is permitted only for the initial plan gate and requires FABLE_PLAN_GATE: INITIAL_ONLY with output under .trioharness-direct/runs/<run-id>.');
}
if (a.role === 'reviewer-plan' && resolve(output) === resolve(fableInitialPlanReceipt)) {
  throw new Error('reviewer-plan output must be a dedicated review transcript, not FABLE_INITIAL_PLAN_RECEIPT.json. The receipt is written separately after validation; using it as output would overwrite the review evidence.');
}
if (a.role === 'reviewer-plan' && existsSync(fableInitialPlanReceipt)) {
  throw new Error('reviewer-plan has already completed for this run. Plan review is initial-only; use the recorded initial review when amending the plan.');
}
if (a.role === 'reviewer') {
  const hasPrTarget = /^CODE_REVIEW_TARGET:\s*(?:https:\/\/github\.com\/[^\s]+\/pull\/\d+|#?\d+)\s*$/mi.test(rawInput);
  const hasFrozenLocalTarget = /^CODE_REVIEW_TARGET:\s*LOCAL_PRECOMMIT\s*$/mi.test(rawInput)
    && /^FROZEN_LOCAL_ARTIFACT:\s*.+$/mi.test(rawInput);
  if (!hasPrTarget && !hasFrozenLocalTarget) {
    throw new Error('reviewer requires CODE_REVIEW_TARGET: <GitHub PR URL or number>, or CODE_REVIEW_TARGET: LOCAL_PRECOMMIT with FROZEN_LOCAL_ARTIFACT for repositories that require independent review before commit/push.');
  }
  if (!/^CODE_REVIEW_MODE:\s*PLAIN_TEXT_SAFE_MODE\s*$/mi.test(rawInput)) {
    throw new Error('reviewer requires CODE_REVIEW_MODE: PLAIN_TEXT_SAFE_MODE; safe mode forbids relying on a custom /code-review command.');
  }
}
if (isCodeReviewer) {
  if (!codeReviewReceipt) throw new Error('CODE_REVIEW_RUN_REQUIRED: output must be under .trioharness-direct/runs/<run-id> or trioharness-direct-runs/<run-id> so the shared review cap is enforced.');
  if (a['closure-review'] && !revalidateExisting) {
    throw new Error('CODE_REVIEW_CLOSURE_OVERRIDE_OBSOLETE: review rounds no longer use a fixed cap or post-cap override.');
  }
}
const cubicSourceSha = rawInput.match(/^FROZEN_SOURCE_SHA:\s*([0-9a-f]{40})\s*$/mi)?.[1] || null;
const isCubicExecutor = a.role === 'executor-cubic';
const isStandardExecutor = a.role === 'executor-sol';
const parseJsonHeader = name => {
  const match = rawInput.match(new RegExp(`^${name}:\\s*(\\[[^\\r\\n]*\\])\\s*$`, 'mi'));
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
};
const parseJsonObjectHeader = name => {
  const match = rawInput.match(new RegExp(`^${name}:\\s*(\\{[^\\r\\n]*\\})\\s*$`, 'mi'));
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
};
const archiveInterruptedReceipt = () => {
  const monitorPath = `${output}.monitor.json`;
  const heartbeatPath = `${output}.heartbeat.jsonl`;
  const artifacts = [output, `${output}.events.jsonl`, `${output}.stderr.log`, heartbeatPath, monitorPath, `${output}.launch-runtime.json`, `${output}.review-context.json`].filter(existsSync);
  if (!artifacts.length) return;
  // Revalidation and dry-run modes are read-only with respect to the live
  // receipt. They must reach their validation/sidecar paths rather than
  // being mistaken for an attempt to replace a completed lane.
  if (revalidateExisting || a['dry-run'] === 'true') return;
  let monitor = null;
  try { if (existsSync(monitorPath)) monitor = JSON.parse(readFileSync(monitorPath, 'utf8')); } catch { monitor = null; }
  if (monitor?.terminal !== false && monitor?.exitCode === 0 && !monitor.timedOut) throw new Error(`RECEIPT_REUSE_REJECTED: ${output} is a completed receipt; use a new output path.`);
  if ((!monitor || monitor.terminal === false) && existsSync(heartbeatPath)) {
    const line = readFileSync(heartbeatPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).at(-1);
    const beat = JSON.parse(line || '{}');
    const pid = monitor?.launcherPid || beat.pid;
    if (pid) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return archiveDeadReceipt(); else throw error; }
      throw new Error(`LANE_ALREADY_RUNNING: ${output} PID ${pid}`);
    }
  }
  archiveDeadReceipt();
  function archiveDeadReceipt() {
    const suffix = `.interrupted-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    for (const artifact of artifacts) renameSync(artifact, `${artifact}${suffix}`);
  }
};
if (!isStandardExecutor) archiveInterruptedReceipt();
const normalizeRepoPath = path => path.replace(/\\/g, '/').replace(/^\.\//, '');
const ownedPathMatches = (path, approved) => approved === path
  || (approved.endsWith('/**') && path.startsWith(approved.slice(0, -2)));
const cubicAcceptedIds = parseJsonHeader('CUBIC_ACCEPTED_IDS_JSON');
const cubicOwnedPaths = parseJsonHeader('CUBIC_APPROVED_OWNED_PATHS_JSON')?.map(normalizeRepoPath);
const cubicExecutorHandoff = parseJsonObjectHeader('CUBIC_EXECUTOR_HANDOFF_JSON');
const cubicCallerClosure = parseJsonObjectHeader('CUBIC_CALLER_CLOSURE_JSON');
const hasScopeLock = /^CUBIC_SCOPE_LOCK:\s*APPROVED\s*$/mi.test(rawInput);
const validIds = Array.isArray(cubicAcceptedIds) && cubicAcceptedIds.length > 0
  && cubicAcceptedIds.every(id => typeof id === 'string' && /^[A-Z][A-Z0-9_-]+$/.test(id));
const validPaths = Array.isArray(cubicOwnedPaths) && cubicOwnedPaths.length > 0
  && cubicOwnedPaths.every(path => typeof path === 'string' && path.length > 0 && !path.includes('..') && !path.startsWith('/'));
const validHandoff = validIds && cubicExecutorHandoff && typeof cubicExecutorHandoff === 'object'
  && cubicAcceptedIds.every(id => {
    const item = cubicExecutorHandoff[id];
    return item && typeof item === 'object'
      && ['callers', 'invariant', 'verification', 'noTouch'].every(key => typeof item[key] === 'string' && item[key].trim());
  });
const validCallerClosure = validIds && validPaths && cubicCallerClosure && typeof cubicCallerClosure === 'object'
  && Object.keys(cubicCallerClosure).length === cubicAcceptedIds.length
  && cubicAcceptedIds.every(id => {
    const item = cubicCallerClosure[id];
    if (!item || typeof item !== 'object') return false;
    const callers = item.callers;
    const paths = item.paths;
    const dependencies = item.dependencies;
    const risks = item.risks;
    const nonEmptyStringArray = value => Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry.trim());
    return nonEmptyStringArray(callers) && nonEmptyStringArray(paths) && nonEmptyStringArray(dependencies)
      && nonEmptyStringArray(risks)
      && paths.map(normalizeRepoPath).every(path => cubicOwnedPaths.some(approved => ownedPathMatches(path, approved)))
      && ['invariant', 'negativeProof'].every(key => typeof item[key] === 'string' && item[key].trim());
  });
if (isCubicExecutor && (!rawInput.includes('CUBIC_CORRECTION_PACKET') || !rawInput.includes('CUBIC_FINDING_LEDGER') || !rawInput.includes('CUBIC_PROTECTED_BEHAVIORS') || !cubicSourceSha || !hasScopeLock || !validIds || !validPaths || !validHandoff || !validCallerClosure)) {
  throw new Error('executor-cubic requires a frozen packet, scope lock, complete ID/path handoff, and CUBIC_CALLER_CLOSURE_JSON for every approved ID with owned paths, callers, dependencies, risks, invariant, and negative proof.');
}
const standardTaskIds = parseJsonHeader('EXECUTOR_TASK_IDS_JSON');
const standardOwnedPaths = parseJsonHeader('EXECUTOR_APPROVED_OWNED_PATHS_JSON')?.map(normalizeRepoPath);
const standardHandoff = parseJsonObjectHeader('EXECUTOR_HANDOFF_JSON');
const standardCallerClosure = parseJsonObjectHeader('EXECUTOR_CALLER_CLOSURE_JSON');
const standardProtectedBehaviors = parseJsonHeader('EXECUTOR_PROTECTED_BEHAVIORS_JSON');
const executorPacketBytes = Buffer.byteLength(rawInput);
const directFastPathExecutorContractEnabled = process.env.DIRECT_FASTPATH_EXECUTOR_CONTRACT === '1';
const fastPathContractApproved = /^EXECUTOR_FASTPATH_CONTRACT:\s*APPROVED\s*$/mi.test(rawInput);
const fastPathMaxChangedLines = Number(rawInput.match(/^EXECUTOR_FASTPATH_MAX_CHANGED_LINES:\s*(\d+)\s*$/mi)?.[1]);
const reviewProtectedBehaviors = parseJsonHeader('REVIEW_PROTECTED_BEHAVIORS_JSON');
const correctionMode = rawInput.match(/^EXECUTOR_CORRECTION_MODE:\s*(INITIAL|DELTA)\s*$/mi)?.[1] || null;
const baselineWorktreeRaw = rawInput.match(/^EXECUTOR_BASELINE_WORKTREE:\s*(.+?)\s*$/mi)?.[1] || null;
const baselineWorktree = baselineWorktreeRaw ? resolve(baselineWorktreeRaw) : null;
const deltaAllowedPaths = parseJsonHeader('EXECUTOR_DELTA_ALLOWED_PATHS_JSON')?.map(normalizeRepoPath);
const baselinePreservedPaths = parseJsonHeader('EXECUTOR_BASELINE_PRESERVED_PATHS_JSON')?.map(normalizeRepoPath);
const deltaInPlace = /^EXECUTOR_DELTA_IN_PLACE:\s*APPROVED\s*$/mi.test(rawInput);
const executorRequiredGates = parseJsonHeader('EXECUTOR_REQUIRED_GATES_JSON');
const parseGateCommand = command => {
  if (typeof command !== 'string' || !command.trim() || /[\x00-\x1f\x7f|&;<>`$%!^]/.test(command)
      || /\\[\s"'|&;<>`$%!^]/.test(command)) return null;
  const tokens = [];
  let token = ''; let quote = null; let started = false;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      started = true;
    } else if (character === '"' || character === "'") {
      quote = character; started = true;
    } else if (character === ' ') {
      if (started) { tokens.push(token); token = ''; started = false; }
    } else {
      token += character; started = true;
    }
  }
  if (quote || !started && !tokens.length) return null;
  if (started) tokens.push(token);
  if (tokens.some(value => !value)) return null;
  if (tokens[0] === 'git' && tokens[1] === 'diff' && tokens[2] === '--check'
      && !tokens.some(value => /^--(?:output|ext-diff|textconv)(?:=|$)/i.test(value)))
    return { command, executable: 'git', args: tokens.slice(1), artifact: null };
  if (tokens[0] === 'npm' && (tokens[1] === 'ci' || tokens[1] === 'test'
      || (tokens[1] === 'run' && /^[A-Za-z0-9:_-]+$/.test(tokens[2] || ''))))
    return { command, executable: 'npm', args: tokens.slice(1), artifact: null };
  if (tokens[0] === 'dotnet' && (tokens[1] === 'build' || tokens[1] === 'test')) {
    const artifact = tokens[2] && !tokens[2].startsWith('-') ? tokens[2] : null;
    return { command, executable: 'dotnet', args: tokens.slice(1), artifact };
  }
  if (tokens[0] === 'dotnet' && tokens[1] === 'ef' && tokens[2] === 'migrations' && tokens[3] === 'has-pending-model-changes') {
    const projectIndex = tokens.indexOf('--project');
    return { command, executable: 'dotnet', args: tokens.slice(1), artifact: projectIndex >= 0 ? tokens[projectIndex + 1] || null : null };
  }
  return null;
};
const executorGateSpecs = Array.isArray(executorRequiredGates) ? executorRequiredGates.map(parseGateCommand) : [];
const validExecutorRequiredGates = Array.isArray(executorRequiredGates) && executorRequiredGates.length > 0
  && executorGateSpecs.every(Boolean);
const postReviewCorrectionAuthorized = /^EXECUTOR_POST_REVIEW_CORRECTION:\s*USER_APPROVED\s*$/mi.test(rawInput)
  && /^POST_REVIEW_AUTHORIZATION_REF:\s*\S.+$/mi.test(rawInput);
const reviewKnownFindingIds = parseJsonHeader('REVIEW_KNOWN_FINDING_IDS_JSON');
const reviewChangedPaths = parseJsonHeader('REVIEW_CHANGED_PATHS_JSON')?.map(normalizeRepoPath);
const reviewImpactMap = parseJsonObjectHeader('REVIEW_IMPACT_MAP_JSON');
// Optional, repo-agnostic closure provenance. Literal IDs remain mandatory
// unless this validated map links every omitted ID to reviewed invariants.
// `parseJsonObjectHeader` deliberately returns null when an optional header is
// absent. Normalize that sentinel to undefined here so the optional coverage
// contract is not mistakenly validated as a supplied, malformed object.
const reviewKnownFindingCoverage = parseJsonObjectHeader('REVIEW_KNOWN_FINDING_COVERAGE_JSON') || undefined;
const reviewBaselineWorktreeRaw = rawInput.match(/^REVIEW_BASELINE_WORKTREE:\s*(.+?)\s*$/mi)?.[1] || null;
const reviewBaselineWorktree = reviewBaselineWorktreeRaw ? resolve(reviewBaselineWorktreeRaw) : null;
const reviewBaselineSha = rawInput.match(/^REVIEW_BASELINE_SHA:\s*([0-9a-f]{40})\s*$/mi)?.[1] || null;
const reviewPredecessorManifestRaw = rawInput.match(/^REVIEW_PREDECESSOR_MANIFEST:\s*(.+?)\s*$/mi)?.[1] || null;
const reviewPredecessorManifestPath = reviewPredecessorManifestRaw ? resolve(reviewPredecessorManifestRaw) : null;
const reviewPredecessorManifestSha256 = rawInput.match(/^REVIEW_PREDECESSOR_MANIFEST_SHA256:\s*([0-9a-f]{64})\s*$/mi)?.[1] || null;
const reviewCorrectionMode = rawInput.match(/^REVIEW_CORRECTION_MODE:\s*(INVENTORY|RECONCILIATION)\s*$/mi)?.[1] || null;
const reviewCorrectionDeltaPaths = parseJsonHeader('REVIEW_CORRECTION_DELTA_PATHS_JSON')?.map(normalizeRepoPath);
const requiresReviewReconciliation = isCodeReviewer && reviewCorrectionMode === 'RECONCILIATION';
const isLocalPrecommitReconciliation = isLocalPrecommitReview && requiresReviewReconciliation;
const hasStandardScopeLock = /^EXECUTOR_SCOPE_LOCK:\s*APPROVED\s*$/mi.test(rawInput);
const validStandardIds = Array.isArray(standardTaskIds) && standardTaskIds.length > 0 && standardTaskIds.every(id => typeof id === 'string' && /^[A-Z][A-Z0-9_-]+$/.test(id));
const validStandardPaths = Array.isArray(standardOwnedPaths) && standardOwnedPaths.length > 0 && standardOwnedPaths.every(path => typeof path === 'string' && path.length > 0 && !path.includes('..') && !path.startsWith('/'));
const validCorrectionMode = correctionMode === 'INITIAL' || correctionMode === 'DELTA';
const validDeltaBaseline = correctionMode !== 'DELTA' || (
  baselineWorktree && existsSync(baselineWorktree) && (baselineWorktree !== repo || deltaInPlace)
  && Array.isArray(deltaAllowedPaths) && deltaAllowedPaths.length > 0
  && Array.isArray(baselinePreservedPaths) && baselinePreservedPaths.length > 0
  && deltaAllowedPaths.every(path => standardOwnedPaths?.some(approved => ownedPathMatches(path, approved)))
  && baselinePreservedPaths.every(path => typeof path === 'string' && path.length > 0 && !path.includes('..') && !path.startsWith('/'))
  && baselinePreservedPaths.every(path => !deltaAllowedPaths.includes(path))
);
const validDeltaInPlace = !deltaInPlace || (correctionMode === 'DELTA' && baselineWorktree === repo);
const isFastPathExecutorContract = isStandardExecutor && directFastPathExecutorContractEnabled && fastPathContractApproved;
if (isStandardExecutor && !validExecutorRequiredGates) {
  throw new Error('executor lanes require EXECUTOR_REQUIRED_GATES_JSON with exact safe local build/test/EF/diff commands; writer narrative alone is never a green gate.');
}
if (isStandardExecutor && directFastPathExecutorContractEnabled && (!fastPathContractApproved || !Number.isInteger(fastPathMaxChangedLines) || fastPathMaxChangedLines < 1 || fastPathMaxChangedLines >= 25)) {
  throw new Error('DIRECT_FASTPATH_EXECUTOR_CONTRACT requires EXECUTOR_FASTPATH_CONTRACT: APPROVED and EXECUTOR_FASTPATH_MAX_CHANGED_LINES from 1 through 24.');
}
if (isStandardExecutor && runRoot && promotionLockOwner) {
  const promotionLock = resolvePromotionLockForOwner(runRoot, promotionLockOwner);
  if (promotionLock) {
    const lock = promotionLock.lock;
    if (!postReviewCorrectionAuthorized) throw new Error(`POST_REVIEW_CORRECTION_BLOCKED: ${promotionLock.path} locks clean reviewed SHA ${lock.frozenSourceSha}.`);
    if (lock.frozenSourceSha !== cubicSourceSha) throw new Error(`POST_REVIEW_BASELINE_DRIFT_BLOCKED: reviewed SHA ${lock.frozenSourceSha} differs from packet SHA ${cubicSourceSha}. Re-plan with explicit user authorization.`);
  }
}
const validReviewKnownFindingIds = Array.isArray(reviewKnownFindingIds)
  && reviewKnownFindingIds.every(id => typeof id === 'string' && /^[A-Z][A-Z0-9_-]+$/.test(id));
const validReviewChangedPaths = Array.isArray(reviewChangedPaths) && reviewChangedPaths.length > 0
  && reviewChangedPaths.every(path => typeof path === 'string' && path.length > 0 && !path.includes('..') && !path.startsWith('/'));
const validReviewEvidence = evidence => typeof evidence === 'string'
  && /^[-A-Za-z0-9_./]+::.+$/.test(evidence)
  && !evidence.split('::', 1)[0].includes('..');
const validReviewImpactMap = validReviewKnownFindingIds && reviewImpactMap && typeof reviewImpactMap === 'object'
  && Object.keys(reviewImpactMap).length === reviewKnownFindingIds.length
  && reviewKnownFindingIds.every(id => {
    const item = reviewImpactMap[id];
    if (!item || typeof item !== 'object' || typeof item.invariant !== 'string' || !item.invariant.trim()) return false;
    return ['callers', 'consumers', 'dependencies', 'tests'].every(key =>
      Array.isArray(item[key]) && item[key].length > 0 && item[key].every(validReviewEvidence));
  });
const validReviewKnownFindingCoverage = reviewKnownFindingCoverage === undefined || (
  reviewKnownFindingCoverage && typeof reviewKnownFindingCoverage === 'object' && !Array.isArray(reviewKnownFindingCoverage)
  && Object.keys(reviewKnownFindingCoverage).length === reviewKnownFindingIds?.length
  && reviewKnownFindingIds?.every(id => {
    const item = reviewKnownFindingCoverage[id];
    return item && typeof item === 'object' && !Array.isArray(item)
      && Array.isArray(item.protectedBehaviorIds) && item.protectedBehaviorIds.length > 0
      && item.protectedBehaviorIds.every(value => typeof value === 'string' && reviewProtectedBehaviors?.some(behavior => behavior.id === value));
  })
);
const reviewPacketIssues = () => {
  const issues = [];
  if (!cubicSourceSha) issues.push('FROZEN_SOURCE_SHA must be one 40-character lowercase Git SHA.');
  if (!reviewCorrectionMode) issues.push('REVIEW_CORRECTION_MODE must be INVENTORY or RECONCILIATION.');
  if (!validReviewKnownFindingIds) issues.push('REVIEW_KNOWN_FINDING_IDS_JSON must be a non-empty, single-line JSON array of stable uppercase IDs.');
  if (!validReviewKnownFindingCoverage) issues.push('REVIEW_KNOWN_FINDING_COVERAGE_JSON, when supplied, must be a single-line object keyed by every known finding ID; each entry requires non-empty protectedBehaviorIds declared in REVIEW_PROTECTED_BEHAVIORS_JSON.');
  if (!validReviewChangedPaths) issues.push('REVIEW_CHANGED_PATHS_JSON must be a non-empty, single-line JSON array of normalized repo-relative paths.');
  if (!validProtectedBehaviorManifest(reviewProtectedBehaviors)) issues.push('REVIEW_PROTECTED_BEHAVIORS_JSON must contain IDs, invariants, and non-empty path::token source/regression evidence arrays.');
  if (!reviewImpactMap || typeof reviewImpactMap !== 'object' || Array.isArray(reviewImpactMap)) {
    issues.push('REVIEW_IMPACT_MAP_JSON must be one single-line JSON object keyed by every known finding ID.');
    return issues;
  }
  if (validReviewKnownFindingIds) {
    const expected = new Set(reviewKnownFindingIds);
    const actual = Object.keys(reviewImpactMap);
    const missingIds = reviewKnownFindingIds.filter(id => !Object.hasOwn(reviewImpactMap, id));
    const extraIds = actual.filter(id => !expected.has(id));
    if (missingIds.length) issues.push(`REVIEW_IMPACT_MAP_JSON is missing IDs: ${missingIds.join(', ')}.`);
    if (extraIds.length) issues.push(`REVIEW_IMPACT_MAP_JSON has undeclared IDs: ${extraIds.join(', ')}.`);
    for (const id of reviewKnownFindingIds) {
      const item = reviewImpactMap[id];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        issues.push(`${id} impact entry must be an object.`);
        continue;
      }
      if (typeof item.invariant !== 'string' || !item.invariant.trim()) issues.push(`${id}.invariant must be a non-empty string.`);
      for (const key of ['callers', 'consumers', 'dependencies', 'tests']) {
        if (!Array.isArray(item[key]) || item[key].length === 0) {
          issues.push(`${id}.${key} must be a non-empty array.`);
          continue;
        }
        const invalid = item[key].filter(evidence => !validReviewEvidence(evidence));
        if (invalid.length) issues.push(`${id}.${key} has invalid evidence (${invalid.join(', ')}); every entry must be repo/relative/path::literal source token.`);
      }
    }
  }
  return issues;
};
const validStandardHandoff = validStandardIds && standardHandoff && typeof standardHandoff === 'object' && standardTaskIds.every(id => {
  const item = standardHandoff[id];
  return item && typeof item === 'object' && ['callers', 'dependencies', 'risks', 'invariant', 'verification', 'noTouch'].every(key => typeof item[key] === 'string' && item[key].trim());
});
const validStandardCallerClosure = validStandardIds && validStandardPaths && standardCallerClosure && typeof standardCallerClosure === 'object'
  && Object.keys(standardCallerClosure).length === standardTaskIds.length && standardTaskIds.every(id => {
    const item = standardCallerClosure[id];
    const values = item && typeof item === 'object' ? [item.callers, item.paths, item.dependencies, item.risks] : [];
    return values.length === 4 && values.every(value => Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string' && entry.trim()))
      && item.paths.map(normalizeRepoPath).every(path => standardOwnedPaths.some(approved => ownedPathMatches(path, approved)))
      && ['invariant', 'negativeProof'].every(key => typeof item[key] === 'string' && item[key].trim());
  });
const validProtectedBehaviorManifest = manifest => Array.isArray(manifest) && manifest.length > 0 && manifest.every(item => {
  const validEvidence = evidence => typeof evidence === 'string'
    && /^[-A-Za-z0-9_./]+::.+$/.test(evidence)
    && !evidence.split('::', 1)[0].includes('..');
  return item && typeof item === 'object'
    && typeof item.id === 'string' && /^[A-Z][A-Z0-9_-]+$/.test(item.id)
    && typeof item.invariant === 'string' && item.invariant.trim()
    && Array.isArray(item.requiredSourceEvidence) && item.requiredSourceEvidence.length > 0 && item.requiredSourceEvidence.every(validEvidence)
    && Array.isArray(item.requiredRegressionEvidence) && item.requiredRegressionEvidence.length > 0 && item.requiredRegressionEvidence.every(validEvidence);
});
const verifyProtectedBehaviorEvidence = (manifest, label, evidenceKeys = ['requiredSourceEvidence', 'requiredRegressionEvidence']) => {
  const missing = [];
  for (const behavior of manifest) {
    for (const evidence of evidenceKeys.flatMap(key => behavior[key])) {
      const [rawPath, token] = evidence.split('::');
      const sourcePath = join(repo, normalizeRepoPath(rawPath));
      if (!existsSync(sourcePath) || !readFileSync(sourcePath, 'utf8').includes(token))
        missing.push(`${behavior.id}:${evidence}`);
    }
  }
  if (missing.length)
    throw new Error(`${label} protected-behavior evidence is incomplete: ${missing.join(', ')}. Do not advance.`);
};
if (isStandardExecutor && (!cubicSourceSha || !hasStandardScopeLock || !validStandardIds || !validStandardPaths || !validStandardHandoff || !validStandardCallerClosure || !validProtectedBehaviorManifest(standardProtectedBehaviors) || !validCorrectionMode || !validDeltaBaseline || !validDeltaInPlace)) {
  throw new Error('executor-sol requires scope lock, protected behaviors, EXECUTOR_CORRECTION_MODE, and for DELTA mode an immutable external baseline or an explicitly approved in-place baseline with allowed-delta and preserved-path manifests.');
}
if (isStandardExecutor) {
  // Protected source must already exist in the current candidate, including a
  // DELTA predecessor's uncommitted bytes. Regression evidence may be added by
  // the writer; the unchanged postflight verifies both evidence collections.
  // Reject stale packets before archiving receipts or launching models/gates.
  verifyProtectedBehaviorEvidence(standardProtectedBehaviors, 'executor preflight', ['requiredSourceEvidence']);
  archiveInterruptedReceipt();
}
if (a.role === 'reviewer' || a.role === closureReviewRole) {
  const issues = reviewPacketIssues();
  if (issues.length || !validReviewImpactMap) {
    throw new Error(`REVIEW_PACKET_INVALID:\n- ${issues.join('\n- ')}\nCorrect every item, then rerun the same command with --dry-run true before launching a paid review.`);
  }
}
if (requiresReviewReconciliation && (!reviewBaselineWorktree || reviewBaselineWorktree === repo || !existsSync(reviewBaselineWorktree))) {
  throw new Error('local reconciliation review requires REVIEW_BASELINE_WORKTREE so the reviewer receives an immutable predecessor for the correction delta.');
}
if (isLocalPrecommitReconciliation && (!reviewPredecessorManifestPath || !reviewPredecessorManifestSha256 || !existsSync(reviewPredecessorManifestPath))) {
  throw new Error('LOCAL_PRECOMMIT reconciliation requires REVIEW_PREDECESSOR_MANIFEST and REVIEW_PREDECESSOR_MANIFEST_SHA256.');
}
const git = args => {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Git command failed: git ${args.join(' ')} (${result.stderr?.trim() || 'unknown error'})`);
  return result.stdout;
};
const gitAt = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Git command failed: git ${args.join(' ')} (${result.stderr?.trim() || 'unknown error'})`);
  return result.stdout;
};
const gitResultAt = (cwd, args, options = {}) => spawnSync('git', a['dry-run'] === 'true' ? ['--no-optional-locks', ...args] : args, {
  cwd,
  encoding: options.encoding === undefined ? 'utf8' : options.encoding,
  windowsHide: true,
  maxBuffer: options.maxBuffer || 128 * 1024 * 1024
});
const sha256 = value => createHash('sha256').update(value).digest('hex');
const isSafeRepoPath = value => {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || isAbsolute(value)) return false;
  const segments = value.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..') && normalizeRepoPath(value) === value;
};
const safeWorktreeFile = (cwd, repoPath, allowMissing = false) => {
  if (!isSafeRepoPath(repoPath)) throw new Error(`UNSAFE_REVIEW_PATH: ${String(repoPath)}`);
  if (lstatSync(resolve(cwd)).isSymbolicLink()) throw new Error(`UNSAFE_REVIEW_WORKTREE: symbolic-link root ${cwd}`);
  const root = realpathSync(cwd);
  let cursor = root;
  for (const segment of repoPath.split('/')) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) {
      if (allowMissing) break;
      throw new Error(`REVIEW_SNAPSHOT_PATH_MISSING: ${repoPath}`);
    }
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`UNSAFE_REVIEW_PATH: symbolic-link input ${repoPath}`);
  }
  const resolvedPath = resolve(root, repoPath);
  const rel = relative(root, resolvedPath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error(`UNSAFE_REVIEW_PATH: ${repoPath}`);
  return resolvedPath;
};
const worktreeRecord = (cwd, baseSha, repoPath) => {
  const filePath = safeWorktreeFile(cwd, repoPath, true);
  if (!existsSync(filePath)) return { path: repoPath, state: 'deleted', mode: '000000', blobOid: null, sha256: null, contentBase64: null };
  const stat = lstatSync(filePath);
  if (!stat.isFile()) throw new Error(`UNSAFE_REVIEW_PATH: non-file input ${repoPath}`);
  const rawDiff = gitAt(cwd, ['diff', '--raw', '--no-renames', baseSha, '--', repoPath]).trim();
  const diffMode = rawDiff.match(/^:\d{6} (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]/)?.[1];
  const stageMode = gitAt(cwd, ['ls-files', '--stage', '--', repoPath]).trim().match(/^(\d{6}) /)?.[1];
  const mode = diffMode && diffMode !== '000000' ? diffMode : stageMode || (process.platform !== 'win32' && (stat.mode & 0o111) ? '100755' : '100644');
  if (!['100644', '100755'].includes(mode)) throw new Error(`UNSAFE_REVIEW_MODE: ${repoPath} has unsupported mode ${mode}`);
  const bytes = readFileSync(filePath);
  const blob = gitAt(cwd, ['hash-object', `--path=${repoPath}`, '--', repoPath]).trim();
  if (!/^[0-9a-f]{40}$/.test(blob)) throw new Error(`REVIEW_SNAPSHOT_HASH_FAILED: ${repoPath}`);
  return { path: repoPath, state: 'present', mode, blobOid: blob, sha256: sha256(bytes), contentBase64: bytes.toString('base64') };
};
const treeRecord = (cwd, treeish, repoPath) => {
  if (!isSafeRepoPath(repoPath)) throw new Error(`UNSAFE_REVIEW_PATH: ${String(repoPath)}`);
  const result = gitResultAt(cwd, ['ls-tree', treeish, '--', repoPath]);
  if (result.status !== 0) throw new Error(`Git command failed: git ls-tree ${treeish} -- ${repoPath} (${result.stderr?.trim() || 'unknown error'})`);
  const line = result.stdout.trim();
  if (!line) return { path: repoPath, state: 'deleted', mode: '000000', blobOid: null };
  const match = line.match(/^(\d{6}) blob ([0-9a-f]{40})\t/);
  if (!match || !['100644', '100755'].includes(match[1])) throw new Error(`UNSAFE_REVIEW_MODE: ${repoPath} has unsupported committed mode.`);
  return { path: repoPath, state: 'present', mode: match[1], blobOid: match[2] };
};
const sameGitIdentity = (left, right) => left?.path === right?.path && left?.state === right?.state
  && left?.mode === right?.mode && left?.blobOid === right?.blobOid;
const sameWorktreeRecord = (left, right) => sameGitIdentity(left, right)
  && left?.sha256 === right?.sha256 && left?.contentBase64 === right?.contentBase64;
const compactReviewRecord = record => record ? ({
  path: record.path,
  state: record.state,
  mode: record.mode,
  blobOid: record.blobOid,
  sha256: record.sha256
}) : null;
const isAncestor = (cwd, ancestor, descendant) => gitResultAt(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
const changedProductPaths = baseSha => [
  ...git(['-c', 'core.quotepath=false', 'diff', '--name-only', '--no-renames', baseSha]).split(/\r?\n/).filter(Boolean).map(normalizeRepoPath),
  ...git(['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).map(normalizeRepoPath)
];
const changedProductLineCount = baseSha => {
  let total = 0;
  for (const row of git(['diff', '--numstat', '--no-renames', baseSha]).split(/\r?\n/).filter(Boolean)) {
    const [added, removed] = row.split('\t');
    if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) return Number.POSITIVE_INFINITY;
    total += Number(added) + Number(removed);
  }
  return total;
};
const changedProductPathsAt = (cwd, baseSha) => [
  ...gitAt(cwd, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--no-renames', baseSha]).split(/\r?\n/).filter(Boolean).map(normalizeRepoPath),
  ...gitAt(cwd, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).map(normalizeRepoPath)
];
const rootKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const gitRootAt = cwd => {
  const result = gitResultAt(cwd, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0 || !String(result.stdout || '').trim()) return null;
  try { return realpathSync(String(result.stdout).trim()); } catch { return null; }
};
const gitOutputAt = (cwd, args) => {
  const result = gitResultAt(cwd, args);
  if (result.status !== 0 || result.error) return { ok: false, error: result.error?.message || String(result.stderr || '').trim() || `git ${args.join(' ')} failed` };
  return { ok: true, text: String(result.stdout || '') };
};
const gitPathsAt = (cwd, args) => {
  const result = gitOutputAt(cwd, args);
  return result.ok ? { ...result, paths: result.text.split('\0').filter(Boolean) } : result;
};
const declaredGuardRoots = primaryRoot => {
  const discoveryErrors = [];
  let additionalRoots = [];
  try {
    const headers = rawInput.match(/^GUARD_ROOTS_JSON:[^\r\n]*$/gmi) || [];
    if (headers.length > 1) throw new Error('GUARD_ROOTS_JSON must occur at most once.');
    additionalRoots = headers.length ? JSON.parse(headers[0].slice(headers[0].indexOf(':') + 1)) : [];
    if (!Array.isArray(additionalRoots) || additionalRoots.some(root => typeof root !== 'string' || !root.trim() || !isAbsolute(root)))
      throw new Error('GUARD_ROOTS_JSON must be an array of absolute Git repository roots.');
  } catch (error) {
    discoveryErrors.push({ root: primaryRoot, error: error instanceof Error ? error.message : String(error) });
    additionalRoots = [];
  }
  const roots = new Map();
  for (const candidate of [primaryRoot, ...additionalRoots]) {
    const declared = resolve(candidate);
    try {
      const root = realpathSync(declared);
      if (!lstatSync(root).isDirectory() || rootKey(gitRootAt(root) || '') !== rootKey(root))
        throw new Error('Declared path is not a readable Git repository root.');
      roots.set(rootKey(root), root);
    } catch (error) {
      roots.set(rootKey(declared), declared);
      discoveryErrors.push({ root: declared, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { roots: [...roots.values()].sort((left, right) => left.localeCompare(right)), discoveryErrors };
};
const snapshotOutOfRootRoot = root => {
  try {
  const head = gitOutputAt(root, ['rev-parse', 'HEAD']);
  const status = gitOutputAt(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all']);
  const worktree = gitOutputAt(root, ['diff', '--binary', '--no-ext-diff']);
  const staged = gitOutputAt(root, ['diff', '--cached', '--binary', '--no-ext-diff']);
  const untracked = gitPathsAt(root, ['ls-files', '-z', '--others', '--exclude-standard']);
  const trackedPaths = gitPathsAt(root, ['diff', '-z', '--name-only', '--no-renames']);
  const stagedPaths = gitPathsAt(root, ['diff', '-z', '--cached', '--name-only', '--no-renames']);
  const records = [head, status, worktree, staged, untracked, trackedPaths, stagedPaths];
  if (records.some(record => !record.ok)) return {
    root,
    observed: false,
    errors: records.filter(record => !record.ok).map(record => record.error)
  };
  return {
    root,
    observed: true,
    head: head.text.trim(),
    statusSha256: sha256(status.text),
    trackedWorktreeDiffSha256: sha256(worktree.text),
    stagedDiffSha256: sha256(staged.text),
    untrackedPaths: [...new Set(untracked.paths)].sort(),
    untrackedFiles: [...new Set(untracked.paths)].sort().map(path => {
      const fullPath = join(root, path);
      const stat = lstatSync(fullPath);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Cannot fingerprint untracked non-file: ${path}`);
      return { path, mode: stat.mode, sha256: sha256(stat.isSymbolicLink() ? readlinkSync(fullPath) : readFileSync(fullPath)) };
    }),
    trackedPaths: [...new Set([...trackedPaths.paths, ...stagedPaths.paths])].sort()
  };
  } catch (error) {
    return { root, observed: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
};
const changedOutOfRootPaths = (start, end) => [...new Set([
  ...(start.trackedPaths || []),
  ...(end.trackedPaths || []),
  ...(start.untrackedPaths || []),
  ...(end.untrackedPaths || [])
])].sort();
const compareOutOfRootSnapshot = (start, end) => {
  if (!start.observed || !end.observed) return { root: start.root, status: 'observation-failed', paths: changedOutOfRootPaths(start, end), errors: [...(start.errors || []), ...(end.errors || [])] };
  const changes = {
    headMoved: start.head !== end.head,
    trackedModified: start.trackedWorktreeDiffSha256 !== end.trackedWorktreeDiffSha256,
    stagedModified: start.stagedDiffSha256 !== end.stagedDiffSha256,
    untrackedChanged: JSON.stringify(start.untrackedFiles) !== JSON.stringify(end.untrackedFiles),
    statusChanged: start.statusSha256 !== end.statusSha256
  };
  const headPaths = changes.headMoved
    ? gitPathsAt(start.root, ['diff', '-z', '--name-only', '--no-renames', start.head, end.head])
    : { ok: true, paths: [] };
  if (!headPaths.ok) return { root: start.root, status: 'observation-failed', paths: changedOutOfRootPaths(start, end), errors: [headPaths.error] };
  return {
    root: start.root,
    status: Object.values(changes).some(Boolean) ? 'modified' : 'clean',
    paths: [...new Set([...changedOutOfRootPaths(start, end), ...headPaths.paths])].sort(),
    startHead: start.head,
    endHead: end.head,
    changes
  };
};
const beginOutOfRootGuard = () => {
  if (!directOutOfRootGuardEnabled || !(isStandardExecutor || isCubicExecutor)) return null;
  const primaryRoot = gitRootAt(repo);
  if (!primaryRoot) return { enabled: true, status: 'observation-failed', primaryRoot: repo, declaredRoots: [repo], monitoredRoots: [], discoveryErrors: [{ root: repo, error: 'primary repository root could not be resolved' }], snapshots: [] };
  const declared = declaredGuardRoots(primaryRoot);
  return {
    enabled: true,
    status: 'running',
    primaryRoot,
    declaredRoots: declared.roots,
    monitoredRoots: declared.roots.filter(root => rootKey(root) !== rootKey(primaryRoot)),
    discoveryErrors: declared.discoveryErrors,
    snapshots: declared.roots.map(snapshotOutOfRootRoot)
  };
};
const finishOutOfRootGuard = guard => {
  if (!guard) return null;
  const comparisons = guard.snapshots.map(start => {
    const end = snapshotOutOfRootRoot(start.root);
    // The existing owned-path/HEAD gates govern writes inside the lane root.
    // Still fail observation if that declared root becomes unreadable.
    if (rootKey(start.root) === rootKey(guard.primaryRoot) && start.observed && end.observed)
      return { root: start.root, status: 'clean', ownership: 'lane', paths: [] };
    return compareOutOfRootSnapshot(start, end);
  });
  const findings = comparisons.filter(item => item.status !== 'clean');
  const status = guard.discoveryErrors.length || findings.some(item => item.status === 'observation-failed')
    ? 'observation-failed' : findings.length ? 'modified' : 'clean';
  return { ...guard, status, comparisons, findings };
};
const pathIsWithin = (parent, child) => {
  const rel = relative(realpathSync(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};
const loadPredecessorManifest = baselinePaths => {
  if (lstatSync(reviewPredecessorManifestPath).isSymbolicLink() || !lstatSync(reviewPredecessorManifestPath).isFile())
    throw new Error('REVIEW_PREDECESSOR_MANIFEST must be a regular non-symlink file.');
  if (pathIsWithin(repo, reviewPredecessorManifestPath) || pathIsWithin(reviewBaselineWorktree, reviewPredecessorManifestPath))
    throw new Error('REVIEW_PREDECESSOR_MANIFEST must be external to both reviewed worktrees.');
  const raw = readFileSync(reviewPredecessorManifestPath);
  if (sha256(raw) !== reviewPredecessorManifestSha256)
    throw new Error('REVIEW_PREDECESSOR_MANIFEST_SHA256 does not match the immutable manifest bytes.');
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw new Error('REVIEW_PREDECESSOR_MANIFEST is not valid JSON.'); }
  if (manifest?.schema !== 1 || manifest.baseSha !== cubicSourceSha || !Array.isArray(manifest.files))
    throw new Error('REVIEW_PREDECESSOR_MANIFEST schema requires {schema:1,baseSha:FROZEN_SOURCE_SHA,files:[...]}.');
  const manifestPaths = manifest.files.map(entry => entry?.path);
  if (manifestPaths.some(path => !isSafeRepoPath(path)) || new Set(manifestPaths).size !== manifestPaths.length
      || JSON.stringify([...manifestPaths].sort()) !== JSON.stringify(manifestPaths))
    throw new Error('REVIEW_PREDECESSOR_MANIFEST files must have unique, sorted, normalized repo-relative paths.');
  for (const entry of manifest.files) {
    const expectedKeys = entry.state === 'present'
      ? ['blobOid', 'contentBase64', 'mode', 'path', 'sha256', 'state']
      : entry.state === 'deleted' ? ['blobOid', 'contentBase64', 'mode', 'path', 'sha256', 'state'] : [];
    if (!expectedKeys.length || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys)
        || (entry.state === 'present' && (!['100644', '100755'].includes(entry.mode) || !/^[0-9a-f]{40}$/.test(entry.blobOid || '') || !/^[0-9a-f]{64}$/.test(entry.sha256 || '') || typeof entry.contentBase64 !== 'string'))
        || (entry.state === 'deleted' && (entry.mode !== '000000' || entry.blobOid !== null || entry.sha256 !== null || entry.contentBase64 !== null)))
      throw new Error(`REVIEW_PREDECESSOR_MANIFEST has an invalid exact file record for ${entry.path || '<unknown>'}.`);
  }
  const absent = baselinePaths.filter(path => !manifestPaths.includes(path));
  const extra = manifestPaths.filter(path => !baselinePaths.includes(path));
  if (absent.length || extra.length)
    throw new Error(`predecessor manifest does not cover the full previous candidate; missing: ${absent.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}.`);
  for (const expected of manifest.files) {
    const actual = worktreeRecord(reviewBaselineWorktree, cubicSourceSha, expected.path);
    if (!sameWorktreeRecord(expected, actual))
      throw new Error(`predecessor manifest content or mode is stale/tampered for ${expected.path}.`);
  }
  return { rawSha256: reviewPredecessorManifestSha256, manifest };
};
const writeSnapshotTree = (root, records) => {
  for (const record of records) {
    if (record.state === 'deleted') continue;
    const target = resolve(root, record.path);
    const rel = relative(root, target);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error(`UNSAFE_REVIEW_PATH: ${record.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(record.contentBase64, 'base64'));
    if (process.platform !== 'win32') chmodSync(target, record.mode === '100755' ? 0o755 : 0o644);
  }
};
const sourceDiffEvidence = (predecessorRecords, candidateRecords, deltaPaths) => {
  const diffRoot = mkdtempSync(join(realpathSync(tmpdir()), 'trio-review-diff-'));
  try {
    const predecessorRoot = join(diffRoot, 'predecessor');
    const candidateRoot = join(diffRoot, 'candidate');
    mkdirSync(predecessorRoot); mkdirSync(candidateRoot);
    writeSnapshotTree(predecessorRoot, predecessorRecords.filter(record => deltaPaths.includes(record.path)));
    writeSnapshotTree(candidateRoot, candidateRecords.filter(record => deltaPaths.includes(record.path)));
    const result = gitResultAt(diffRoot, ['diff', '--no-index', '--binary', '--full-index', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', 'predecessor', 'candidate']);
    if (![0, 1].includes(result.status) || result.error)
      throw new Error(`PRECOMMIT_SOURCE_DIFF_UNAVAILABLE: ${result.error?.message || result.stderr?.trim() || 'git diff failed'}`);
    const identities = deltaPaths.map(path => ({
      path,
      predecessor: compactReviewRecord(predecessorRecords.find(record => record.path === path)),
      candidate: compactReviewRecord(candidateRecords.find(record => record.path === path))
    }));
    const modeOnlyDelta = deltaPaths.length > 0 && deltaPaths.every(path => {
      const predecessor = predecessorRecords.find(record => record.path === path);
      const candidate = candidateRecords.find(record => record.path === path);
      return predecessor?.state === 'present' && candidate?.state === 'present'
        && predecessor.sha256 === candidate.sha256
        && predecessor.contentBase64 === candidate.contentBase64
        && ['100644', '100755'].includes(predecessor.mode)
        && ['100644', '100755'].includes(candidate.mode)
        && predecessor.mode !== candidate.mode;
    });
    if ((result.status !== 1 || !result.stdout) && !(result.status === 0 && modeOnlyDelta))
      throw new Error('PRECOMMIT_SOURCE_DIFF_UNAVAILABLE: validated correction delta produced no source diff.');
    const content = `GIT_BLOB_MODE_IDENTITIES_JSON: ${JSON.stringify(identities)}\n${result.stdout}`;
    return { format: 'git-diff-no-index--binary-with-compact-blob-mode-identities', byteLength: Buffer.byteLength(content), sha256: sha256(content), content };
  } finally {
    const safeTempParent = realpathSync(tmpdir());
    const resolvedRoot = resolve(diffRoot);
    if (dirname(resolvedRoot) !== safeTempParent || !resolvedRoot.startsWith(`${safeTempParent}${sep}`))
      throw new Error(`Refusing unsafe temporary cleanup: ${resolvedRoot}`);
    rmSync(resolvedRoot, { recursive: true, force: true });
  }
};
let baselineChangedPaths = [];
const preservedBaselineSnapshot = new Map();
if (isStandardExecutor && correctionMode === 'DELTA') {
  if (gitAt(baselineWorktree, ['rev-parse', 'HEAD']).trim() !== cubicSourceSha)
    throw new Error('DELTA correction baseline HEAD must equal FROZEN_SOURCE_SHA; do not use an ambiguous predecessor.');
  baselineChangedPaths = [...new Set(changedProductPathsAt(baselineWorktree, cubicSourceSha))];
  const uncovered = baselineChangedPaths.filter(path =>
    !baselinePreservedPaths.includes(path) && !deltaAllowedPaths.some(allowed => ownedPathMatches(path, allowed)));
  if (uncovered.length)
    throw new Error(`DELTA correction baseline manifest leaves prior candidate paths unaccounted for: ${uncovered.join(', ')}. Do not run a rewrite.`);
}
const verifyReviewImpactEvidence = () => {
  const missing = [];
  for (const id of reviewKnownFindingIds || []) {
    const item = reviewImpactMap[id];
    for (const evidence of [...item.callers, ...item.consumers, ...item.dependencies, ...item.tests]) {
      const [rawPath, token] = evidence.split('::');
      const sourcePath = join(repo, normalizeRepoPath(rawPath));
      if (!existsSync(sourcePath) || !readFileSync(sourcePath, 'utf8').includes(token)) missing.push(`${id}:${evidence}`);
    }
  }
  if (missing.length) throw new Error(`REVIEW_PACKET_STALE_EVIDENCE:\n- ${missing.join('\n- ')}\nEach entry must name an existing repo-relative file and a literal token currently present in that file. Correct all entries, then rerun --dry-run true.`);
};
let machineReviewContext = null;
const pendingReceiptRecovery = revalidateExisting && existsSync(`${output}.monitor.json`) && (() => {
  const monitor = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8'));
  return monitor.exitCode !== 0 && monitor.modelExitCode === 0 && monitor.timedOut === false
    && (String(monitor.failure || '').startsWith('LOCAL_PRECOMMIT_PENDING_EXISTS:')
      || (monitor.runtime?.verified === true && monitor.stderrBytes === 0
        && String(monitor.failure || '').endsWith('review promotion decision rejected: missing, duplicated, or malformed ROUND_SUMMARY counts')));
})();
if (a.role === 'reviewer' || a.role === closureReviewRole) {
  if (requiresReviewReconciliation && (!reviewBaselineSha || gitAt(reviewBaselineWorktree, ['rev-parse', 'HEAD']).trim() !== reviewBaselineSha)) {
    throw new Error('REVIEW_BASELINE_WORKTREE HEAD must equal explicit REVIEW_BASELINE_SHA; do not reconcile against an ambiguous predecessor.');
  }
  if (requiresReviewReconciliation && !isAncestor(repo, reviewBaselineSha, cubicSourceSha)) {
    throw new Error('REVIEW_BASELINE_SHA must be an ancestor of FROZEN_SOURCE_SHA; do not reconcile unrelated histories.');
  }
  const baselinePaths = reviewBaselineWorktree ? [...new Set(changedProductPathsAt(reviewBaselineWorktree, cubicSourceSha))].sort() : [];
  // An initial review is launched from a clean checkout at FROZEN_SOURCE_SHA.
  // Diffing that checkout against its own SHA is necessarily empty and makes
  // every honest changed-path manifest fail validation. Anchor inventory to
  // the PR's local mainline merge-base; reconciliation retains its explicit
  // predecessor worktree/SHA path below.
  const inventoryBaseSha = requiresReviewReconciliation
    ? cubicSourceSha
    : isLocalPrecommitReview ? cubicSourceSha : git(['merge-base', cubicSourceSha, 'origin/main']).trim();
  if (!requiresReviewReconciliation && !isLocalPrecommitReview && !/^[0-9a-f]{40}$/.test(inventoryBaseSha)) {
    throw new Error('initial review requires a valid merge-base between FROZEN_SOURCE_SHA and origin/main. Fetch the PR base; do not review an ambiguous diff.');
  }
  const candidateGitChangedPaths = [...new Set(changedProductPaths(inventoryBaseSha))].sort();
  if (isLocalPrecommitReconciliation) {
    const candidateHead = git(['rev-parse', 'HEAD']).trim();
    const baselineDirty = gitAt(reviewBaselineWorktree, ['status', '--porcelain', '--untracked-files=all']).trim();
    if (reviewBaselineSha !== cubicSourceSha || !baselineDirty)
      throw new Error('LOCAL_PRECOMMIT predecessor worktree must be dirty at the exact FROZEN_SOURCE_SHA base.');
    if (!revalidateExisting && candidateHead !== cubicSourceSha)
      throw new Error('LOCAL_PRECOMMIT candidate HEAD must equal FROZEN_SOURCE_SHA before the reviewed commit.');
    if (pendingReceiptRecovery && candidateHead !== cubicSourceSha)
      throw new Error('LOCAL_PRECOMMIT pending receipt recovery requires the original uncommitted HEAD.');
    if (revalidateExisting && !pendingReceiptRecovery && (git(['status', '--porcelain', '--untracked-files=all']).trim() || candidateHead === cubicSourceSha || !isAncestor(repo, cubicSourceSha, candidateHead)))
      throw new Error('LOCAL_PRECOMMIT revalidation requires a clean committed candidate at a descendant of FROZEN_SOURCE_SHA.');
  } else if (requiresReviewReconciliation) {
    const candidateHead = git(['rev-parse', 'HEAD']).trim();
    const candidateDirty = git(['status', '--porcelain', '--untracked-files=all']).trim();
    const baselineDirty = gitAt(reviewBaselineWorktree, ['status', '--porcelain', '--untracked-files=all']).trim();
    if (candidateHead !== cubicSourceSha || candidateDirty || baselineDirty) {
      throw new Error('reconciliation review requires clean candidate and baseline worktrees at their explicit frozen SHAs.');
    }
  }
  // A reconciliation review compares committed Git objects, not checkout bytes. Physical
  // worktree bytes can differ solely because of core.autocrlf or attributes even when the
  // baseline and candidate blobs are identical. Clean-worktree enforcement above makes the
  // explicit baseline-SHA-to-candidate-SHA Git delta authoritative and preserves every
  // unchanged reviewed blob byte-for-byte.
  const actualChangedPaths = isLocalPrecommitReconciliation ? candidateGitChangedPaths
    : requiresReviewReconciliation ? baselinePaths : candidateGitChangedPaths;
  const declaredButAbsent = reviewChangedPaths.filter(path => !actualChangedPaths.includes(path));
  const undeclaredChangedPaths = actualChangedPaths.filter(path => !reviewChangedPaths.includes(path));
  if (declaredButAbsent.length || undeclaredChangedPaths.length) {
    throw new Error(`review changed-path manifest does not match frozen artifact; absent: ${declaredButAbsent.join(', ') || 'none'}; undeclared: ${undeclaredChangedPaths.join(', ') || 'none'}.`);
  }
  let correctionDelta = reviewBaselineWorktree ? baselinePaths : actualChangedPaths;
  let predecessorManifest = null;
  let predecessorSnapshot = null;
  let candidateSnapshot = null;
  let sourceDiff = null;
  if (isLocalPrecommitReconciliation) {
    predecessorManifest = loadPredecessorManifest(baselinePaths);
    const unionPaths = [...new Set([...baselinePaths, ...actualChangedPaths])].sort();
    if (revalidateExisting) {
      const storedPath = `${output}.review-context.json`;
      if (!existsSync(storedPath)) throw new Error('REVIEW_REVALIDATION_REJECTED: immutable review context is missing.');
      const stored = JSON.parse(readFileSync(storedPath, 'utf8'));
      const storedHash = stored.contextSha256;
      const unsignedStored = { ...stored }; delete unsignedStored.contextSha256;
      if (stored.schema !== 2 || sha256(JSON.stringify(unsignedStored)) !== storedHash)
        throw new Error('REVIEW_REVALIDATION_REJECTED: immutable review context hash is invalid.');
      const storedMonitorPath = `${output}.monitor.json`;
      const storedMonitor = existsSync(storedMonitorPath) ? JSON.parse(readFileSync(storedMonitorPath, 'utf8')) : null;
      const storedCandidatePaths = Array.isArray(stored.candidateSnapshot) ? stored.candidateSnapshot.map(record => record?.path) : [];
      // Legacy pending-file collisions occurred before the terminal monitor got
      // its context binding. Require the exact independently saved prelaunch
      // dry-run context; a recomputed self-hash alone is not recovery evidence.
      const archivedContextBinding = pendingReceiptRecovery && !storedMonitor?.reviewContextSha256
        && readdirSync(dirname(output)).filter(name => name.startsWith(`${basename(output)}.interrupted-`)).some(name => {
          try {
            const receipt = JSON.parse(readFileSync(join(dirname(output), name), 'utf8'));
            return receipt.role === a.role && resolve(receipt.repo || '') === repo
              && receipt.packetValidation?.status === 'passed' && receipt.packetValidation?.sourceEvidenceVerified === true
              && JSON.stringify(receipt.reviewContext) === JSON.stringify(stored);
          } catch { return false; }
        });
      if ((storedMonitor?.reviewContextSha256 !== storedHash && !archivedContextBinding)
          || JSON.stringify(storedCandidatePaths) !== JSON.stringify(unionPaths)
          || JSON.stringify(stored.baselineChangedPaths) !== JSON.stringify(baselinePaths)
          || JSON.stringify(stored.correctionDeltaPaths) !== JSON.stringify([...reviewCorrectionDeltaPaths].sort())
          || JSON.stringify(stored.knownFindingIds) !== JSON.stringify(reviewKnownFindingIds)
          || JSON.stringify(stored.impactMap) !== JSON.stringify(reviewImpactMap)
          || resolve(stored.predecessorManifest?.path || '') !== reviewPredecessorManifestPath
          || stored.sourceDiff?.sha256 !== sha256(stored.sourceDiff?.content || '')
          || stored.sourceDiff?.byteLength !== Buffer.byteLength(stored.sourceDiff?.content || ''))
        throw new Error('REVIEW_REVALIDATION_REJECTED: immutable review context schema or original monitor binding is incomplete.');
      if (stored.rawPacketSha256 !== sha256(rawInput) || stored.predecessorManifest?.sha256 !== reviewPredecessorManifestSha256
          || stored.frozenSourceSha !== cubicSourceSha || JSON.stringify(stored.reviewedChangedPaths) !== JSON.stringify(actualChangedPaths))
        throw new Error('REVIEW_REVALIDATION_REJECTED: packet, manifest, base, or changed-path context differs from the paid review.');
      for (const expected of stored.candidateSnapshot || []) {
        const actual = pendingReceiptRecovery ? worktreeRecord(repo, cubicSourceSha, expected.path)
          : treeRecord(repo, git(['rev-parse', 'HEAD']).trim(), expected.path);
        if (!(pendingReceiptRecovery ? sameWorktreeRecord(expected, actual) : sameGitIdentity(expected, actual)))
          throw new Error(`REVIEW_REVALIDATION_REJECTED: committed blob/mode drift for ${expected.path}.`);
      }
      machineReviewContext = stored;
      correctionDelta = stored.correctionDeltaPaths;
    } else {
      candidateSnapshot = unionPaths.map(path => worktreeRecord(repo, cubicSourceSha, path));
      const predecessorRecords = predecessorManifest.manifest.files;
      // The manifest covers dirty predecessor paths, not every tracked file.
      // Preserve explicit records (including deletions); resolve other paths
      // from the immutable base rather than inventing a deleted predecessor.
      predecessorSnapshot = unionPaths.map(path => {
        const preserved = predecessorRecords.find(record => record.path === path);
        if (preserved) return preserved;
        const identity = treeRecord(reviewBaselineWorktree, cubicSourceSha, path);
        if (identity.state === 'deleted') return { ...identity, sha256: null, contentBase64: null };
        const blob = gitResultAt(reviewBaselineWorktree, ['cat-file', 'blob', identity.blobOid], { encoding: null });
        if (blob.status !== 0 || blob.error) throw new Error(`REVIEW_BASELINE_BLOB_UNAVAILABLE: ${path}`);
        return { ...identity, sha256: sha256(blob.stdout), contentBase64: blob.stdout.toString('base64') };
      });
      correctionDelta = unionPaths.filter(path => !sameGitIdentity(
        predecessorSnapshot.find(record => record.path === path),
        candidateSnapshot.find(record => record.path === path)));
    }
  }
  if (requiresReviewReconciliation) {
    const validCorrectionDeltaPaths = Array.isArray(reviewCorrectionDeltaPaths) && reviewCorrectionDeltaPaths.length > 0
      && reviewCorrectionDeltaPaths.every(path => typeof path === 'string' && path.length > 0 && !path.includes('..') && !path.startsWith('/'));
    const missingDeltaPaths = validCorrectionDeltaPaths ? correctionDelta.filter(path => !reviewCorrectionDeltaPaths.includes(path)) : correctionDelta;
    const undeclaredDeltaPaths = validCorrectionDeltaPaths ? reviewCorrectionDeltaPaths.filter(path => !correctionDelta.includes(path)) : [];
    if (!validCorrectionDeltaPaths || missingDeltaPaths.length || undeclaredDeltaPaths.length) {
      throw new Error(`review correction-delta manifest does not match predecessor-to-candidate delta; missing: ${missingDeltaPaths.join(', ') || 'none'}; undeclared: ${undeclaredDeltaPaths.join(', ') || 'none'}.`);
    }
  }
  verifyReviewImpactEvidence();
  if (!machineReviewContext) {
    if (isLocalPrecommitReconciliation) sourceDiff = sourceDiffEvidence(predecessorSnapshot, candidateSnapshot, correctionDelta);
    const context = {
      schema: isLocalPrecommitReconciliation ? 2 : 1,
      frozenSourceSha: cubicSourceSha,
      correctionMode: reviewCorrectionMode,
      candidateWorktree: repo,
      baselineWorktree: reviewBaselineWorktree || null,
      reviewedChangedPaths: actualChangedPaths,
      baselineChangedPaths: baselinePaths,
      correctionDeltaPaths: correctionDelta,
      knownFindingIds: reviewKnownFindingIds,
      knownFindingCoverage: reviewKnownFindingCoverage || null,
      impactMap: reviewImpactMap,
      ...(isLocalPrecommitReconciliation ? {
        rawPacketSha256: sha256(rawInput),
        predecessorManifest: {
          path: reviewPredecessorManifestPath,
          sha256: predecessorManifest.rawSha256,
          schema: 1,
          usage: 'External JSON {schema:1,baseSha:<40-hex>,files:[sorted {path,state,mode,blobOid,sha256,contentBase64}]}; deleted files use mode 000000 and null hashes/content. Header REVIEW_PREDECESSOR_MANIFEST_SHA256 pins the raw JSON bytes.'
        },
        candidateSnapshot,
        sourceDiff
      } : {})
    };
    machineReviewContext = isLocalPrecommitReconciliation
      ? { ...context, contextSha256: sha256(JSON.stringify(context)) }
      : context;
  }
}
if (isStandardExecutor && correctionMode === 'DELTA' && deltaInPlace) {
  for (const path of baselinePreservedPaths) {
    const sourcePath = join(repo, path);
    preservedBaselineSnapshot.set(path, existsSync(sourcePath) ? readFileSync(sourcePath) : null);
  }
}
if ((isCubicExecutor || isStandardExecutor) && git(['status', '--porcelain', '--untracked-files=all']).trim() && !(isStandardExecutor && correctionMode === 'DELTA' && deltaInPlace)) {
  throw new Error('executor lanes require a clean assigned worktree before editing; preserve and resolve any prior state instead of mixing it into this batch.');
}
const executorInitialHead = (isCubicExecutor || isStandardExecutor) ? git(['rev-parse', 'HEAD']).trim() : null;
let outOfRootGuardStart = null;
let outOfRootGuardTerminal = null;
const scopeGuardContract = `
SCOPE GUARD — APPLIES TO THIS LANE
Complete the current task with the minimum sufficient change. Read the relevant code, tests, configuration, and applicable repository AGENTS.md instructions directly. Resolve an ambiguous or unverified premise before building on it.

Before editing, state a minimal plan with exactly these fields: Outcome, Non-goals, Files, Proof. Start with one implementation path and split work only for genuinely independent parts.

Reuse existing code, helpers, patterns, and test setup. Fix root causes; add an abstraction only for a second real caller in this task or a stated requirement. Preserve behavior outside scope, remove replaced code, and do not design for speculative cases. Never write or alter an arbitrary repository's AGENTS.md to apply this policy; the prompt itself is authoritative.

Pause only for a new material boundary not already authorized: expanded unrelated scope, a dependency/framework/service/test-infrastructure addition, a public API/schema/storage/wire-format change, destructive data or history operations, or parallel implementations. Read-only discovery and ordinary in-scope implementation do not require another question.

Run the narrowest existing tests for changed behavior, extend the most relevant test before adding a file, and add tests only for an acceptance criterion or regression risk. Focused command selection is allowed; weakening assertions or disabling tests to obtain a pass is forbidden. If work grows into future layers, workaround stacks, or unrelated cleanup, stop, reduce the plan, and confirm any new material scope.

Done means requested behavior and acceptance criteria work; exact check commands and results are reported; every touched file is necessary; no debug, backup, dead, or scratch artifacts remain; and assumptions, limits, or unverified runtime behavior are stated honestly.
`;
const planReviewContract = `
PLAN REVIEW CONTRACT — ONE PASS ONLY
You are the independent plan decision reviewer. This is one complete review, not an approval conversation.

First inspect the supplied PLAN_REVIEW_PACKET and use bounded repository reads to trace every material path it identifies: affected entry points, direct callers/consumers, data/authorization boundaries, contracts, configuration, dependencies, and relevant tests. Use a code graph only when it materially helps that trace. When an INVARIANT_MATRIX is supplied, verify every invariant's owner, forbidden state/transition, error/disposal path, and deterministic negative proof; a happy-path test is not proof of an authorization, lifecycle, or concurrency invariant. Do that investigation before drafting findings. Do not ask the coordinator to run another review or to discover ordinary repository context for you.

Report only defects that are concrete, material, and evidenced by the packet or repository. Do not report style preferences, hypothetical future work, duplicate findings, or improvements that are outside the stated objective/non-goals. Do not turn an uncertainty into a finding; state it once under NEEDS_EVIDENCE only if it can change safety or correctness.

Return exactly this structure and stop:
PLAN_DECISION: APPROVE | AMEND | BLOCK
MATERIAL_FINDINGS:
- [severity: critical|high|medium] [packet slice/path/symbol] [failure mode] [evidence] [smallest plan amendment]
NEEDS_EVIDENCE:
- [only safety/correctness-critical unknowns, or NONE]
ACCEPTED_BOUNDARIES:
- [important non-goals or constraints you verified]

An AMEND decision must include every material amendment you can identify now. A BLOCK decision is allowed only when the plan cannot safely proceed without a new subsystem, security/authorization boundary, external contract, migration, or materially different scope. Never request a follow-up review of an amended version; the coordinator owns one-batch remediation and disposition.
`;
const codeReviewContract = `
CODE REVIEW CONTRACT — BOUNDED, CLASSIFIED PR REVIEW
Review the pushed PR named below exactly once. This is a local Claude Code review, not Cubic and not an approval conversation. Safe mode is active: do NOT invoke /code-review or any custom command.

First inspect the named PR's frozen head through the checked-out PR branch and read-only Git/GitHub CLI metadata, then read the machine-generated review context named below and inspect the frozen diff and impact map. Trace material entry points, direct callers/consumers, authorization/data boundaries, contracts, configuration, dependencies, and relevant tests. Also inspect risky connected code outside the diff when callers or dependencies make it necessary. Do not broaden the implementation scope: an out-of-scope risk must be recorded separately with its dependency path and required owner/decision.

Report only concrete, reproducible defects backed by repository evidence. Reject style preferences, hypothetical future work, duplicates, and findings already recorded as FALSE_POSITIVE or DISPUTED unless this PR supplies materially new evidence. Classify every finding HIGH, MEDIUM, or LOW. HIGH and MEDIUM require a smallest safe correction and deterministic regression proof; LOW is logged and does not trigger another review by itself.

Return exactly:
REVIEW_DECISION: CLEAN | FINDINGS
REVIEW_SCOPE: PR_DIFF | CONNECTED_RISK
PROTECTED_BEHAVIOR_DISPOSITION:
- [every REVIEW_PROTECTED_BEHAVIORS_JSON ID] VERIFIED | REGRESSED | INCOMPLETE — [evidence]
Required literal form: "- <ID> <DISPOSITION> — <evidence>". Example: "- PB-1 VERIFIED — file.txt:1 preserves the invariant". Copy each declared ID exactly and use exactly VERIFIED, REGRESSED, or INCOMPLETE; do not omit either ID or token. Whitespace or a separator dash between them has no semantic meaning.
CORRECTION_DELTA_DISPOSITION:
- [every machine-generated correctionDeltaPaths path] REVIEWED | REGRESSED | OUTSIDE_DELTA — [evidence]
Required literal form: "- <path> <DISPOSITION> — <evidence>". Example: "- src/example.ts REVIEWED — exact candidate inspected". Copy the exact path and literal disposition; whitespace or a separator dash between them has no semantic meaning.
MATERIAL_FINDINGS:
- [id] [severity: HIGH|MEDIUM|LOW] [IN_SCOPE|OUT_OF_SCOPE_RISK] [path:line/symbol] [failure mode] [repository evidence] [smallest safe correction or required owner]
NON_FINDINGS:
- [concern] [why invalid, duplicate, pre-existing, or non-actionable; or NONE]
ROUND_SUMMARY:
- HIGH: <count>; MEDIUM: <count>; LOW: <count>; OUT_OF_SCOPE_RISK: <count>
Use one numeric summary line exactly, for example: "- HIGH: 0; MEDIUM: 0; LOW: 1; OUT_OF_SCOPE_RISK: 0". Put explanations on a separate line, not inside the counts.
RUNTIME_ASSERTION:
- [model and effort reported by the CLI result, and any runtime isolation diagnostic exposed to the reviewer; state UNVERIFIED rather than inventing a value]

Stop after this response. The coordinator validates and batches confirmed in-scope HIGH/MEDIUM findings. Never request an additional review; the three-artifact cap is enforced by the launcher.
`;
const closureReviewContract = `
CLOSURE REVIEW CONTRACT — MACHINE-BOUND INVARIANT CLOSURE
Review the frozen local artifact and its connected callers read-only. Do not modify files or invoke external systems. Before assessing findings, read the machine-generated review context named below. It is the authoritative predecessor-to-candidate delta, the complete changed-path manifest, and the caller/consumer/dependency/test impact map. Trace every mapped caller, consumer, dependency, test, and connected implementation; do not treat the supplied map as proof. Every protected behavior below is mandatory: validate its required source and regression evidence, then trace the relevant implementation and connected callers. A finding is concrete only when backed by repository evidence.

Return exactly:
REVIEW_DECISION: CLEAN | FINDINGS
REVIEW_SCOPE: FROZEN_LOCAL_ARTIFACT | CONNECTED_RISK
PROTECTED_BEHAVIOR_DISPOSITION:
- [every REVIEW_PROTECTED_BEHAVIORS_JSON ID] VERIFIED | REGRESSED | INCOMPLETE — [evidence]
Required literal form: "- <ID> <DISPOSITION> — <evidence>". Example: "- PB-1 VERIFIED — file.txt:1 preserves the invariant". Copy each declared ID exactly and use exactly VERIFIED, REGRESSED, or INCOMPLETE; do not omit either ID or token. Whitespace or a separator dash between them has no semantic meaning.
CORRECTION_DELTA_DISPOSITION:
- [every machine-generated correctionDeltaPaths path] REVIEWED | REGRESSED | OUTSIDE_DELTA — [evidence]
Required literal form: "- <path> <DISPOSITION> — <evidence>". Example: "- src/example.ts REVIEWED — exact candidate inspected". Copy the exact path and literal disposition; whitespace or a separator dash between them has no semantic meaning.
MATERIAL_FINDINGS:
- [id] [severity: HIGH|MEDIUM|LOW] [IN_SCOPE|OUT_OF_SCOPE_RISK] [path:line/symbol] [failure mode] [repository evidence] [smallest safe correction or required owner]
NON_FINDINGS:
- [concern] [why invalid, duplicate, pre-existing, or non-actionable; or NONE]
ROUND_SUMMARY:
- HIGH: <count>; MEDIUM: <count>; LOW: <count>; OUT_OF_SCOPE_RISK: <count>
Use one numeric summary line exactly, for example: "- HIGH: 0; MEDIUM: 0; LOW: 1; OUT_OF_SCOPE_RISK: 0". Put explanations on a separate line, not inside the counts.
RUNTIME_ASSERTION:
- [model and effort reported by the CLI result, and any runtime isolation diagnostic exposed to the reviewer; state UNVERIFIED rather than inventing a value]
`;
const cubicExecutorContract = `
CUBIC REMEDIATION CONTRACT — COMPLETE LEDGER, ONE WRITER BATCH
You are the sole Sol writer for a validated Cubic correction packet. Treat the packet's CUBIC_FINDING_LEDGER as a checklist with immutable IDs and CUBIC_PROTECTED_BEHAVIORS as non-regression constraints. Before editing, trace every affected protected entry point, direct caller/consumer, contract, authorization/data/lifecycle boundary, and stated invariant. Then implement the smallest safe correction for every CONFIRMED or PROBABLE row in this one batch. Never silently omit an ID, substitute a broad rewrite, change behavior outside allowed owned paths, or mark an item complete merely because a suite is green.

Work only within the packet's stated objective and boundaries. Add or update the deterministic regression proof required by each relevant row, run the focused proof/build first, then the supplied verification commands. After editing, inspect the exact diff against allowed owned paths, re-check each protected behavior and caller/consumer path, and prove no test was deleted, weakened, skipped, or narrowed to obtain a pass. If a row cannot safely be fixed, leave product code unchanged for that row and report it as BLOCKED with exact evidence; do not invent a workaround or expand into a new subsystem.

Return exactly this structure after completing the work:
CUBIC_REMEDIATION_RESULT:
- [finding ID] FIXED | NOT_FIXED | NOT_APPLICABLE | BLOCKED — [changed path/symbol or reason] — [focused regression/verification evidence]
UNTOUCHED_FINDING_IDS:
- [IDs, or NONE]
VERIFICATION_RUN:
- [exact command] — [result]
CROSS_IMPACT_CHECK:
- [protected behavior / caller-consumer path] — [preserved evidence]
CALLER_CLOSURE_RESULT:
- [finding ID] CALLERS: [checked symbols] | PATHS: [owned paths] | DEPENDENCIES: [declared dependencies] | RISKS: [guarded risks] | PROOF: [negative/regression evidence]
SCOPE_ESCALATION:
- [required new boundary, or NONE]

The coordinator will reject a completion that does not account for every ledger ID.
`;
const standardExecutorContract = `
SCOPE-LOCKED SOL REMEDIATION CONTRACT — ONE COMPLETE WRITER BATCH
You are the sole Writer for the attached, already-approved correction packet. The packet is authoritative for this lane: do not re-read broad repository planning material, re-run harness setup, inspect unrelated worktrees, or poll this lane's own receipt. The coordinator already performed those duties. Begin by reading only the named owned files and declared caller/consumer closure needed to perform the strict RED proof.

Implement every accepted task ID in the packet using the smallest safe change within EXECUTOR_APPROVED_OWNED_PATHS_JSON. Do not change HEAD, create a migration/package/dependency, touch an unlisted path, broaden authorization or persistence scope, or silently omit a task. For EXECUTOR_CORRECTION_MODE: DELTA, first materialize the exact immutable baseline from EXECUTOR_BASELINE_WORKTREE, preserve every EXECUTOR_BASELINE_PRESERVED_PATHS_JSON file byte-for-byte, and change only EXECUTOR_DELTA_ALLOWED_PATHS_JSON for the stated root causes. The launcher rejects a missing baseline, an unaccounted prior path, or any preserved-file byte change. Run the exact RED proof before editing; then implement, run focused proof, and inspect the exact diff. If a stated task cannot safely be completed in the locked paths, stop product edits for that task and report BLOCKED with concrete evidence. Do not spend the lane waiting, monitoring, or asking the coordinator to repeat ordinary repository exploration.

After the implementation, run focused proof for the changed behavior. The launcher, not the writer, executes the deduplicated authoritative EXECUTOR_REQUIRED_GATES_JSON suite after the model returns. Do not repeat that full suite in the writer lane. Do not weaken, remove, skip, or narrow tests. Explicitly classify unavailable approved-disposable runtime evidence as environment-blocked; never use a live fallback.

Return exactly this structure and stop:
EXECUTOR_REMEDIATION_RESULT:
- [task ID] FIXED | NOT_FIXED | BLOCKED — [changed path/symbol or evidence] — [focused proof]
VERIFICATION_RUN:
- [exact command] — [result]
CROSS_IMPACT_CHECK:
- [protected-behavior ID exactly as supplied in EXECUTOR_PROTECTED_BEHAVIORS_JSON] — [caller/consumer or invariant] — [preserved evidence]
Each protected-behavior ID must appear verbatim at the beginning of its CROSS_IMPACT_CHECK line. Account for every protected-behavior ID supplied in the packet.
CALLER_CLOSURE_RESULT:
- [task ID] CALLERS: [checked symbols] | PATHS: [owned paths] | DEPENDENCIES: [declared dependencies] | RISKS: [guarded risks] | PROOF: [negative/regression evidence]
SCOPE_ESCALATION:
- [required new boundary, or NONE]
`;
const fastPathExecutorContract = `
FAST-PATH EXECUTOR CONTRACT — NARROW, MACHINE-BOUND MECHANICAL CORRECTION
This is an explicitly approved sub-25-line correction. The packet's scope lock, frozen HEAD, clean-worktree precondition, approved owned paths, protected-behavior source/regression evidence, authoritative gates, and unchanged-HEAD and unauthorized-path checks remain binding. Do not add a dependency, migration, public signature, authorization/persistence boundary, or unlisted path. The launcher also rejects a diff above EXECUTOR_FASTPATH_MAX_CHANGED_LINES.

Run the stated focused RED proof before editing, make the smallest safe correction, run focused green proof, and inspect the exact diff. The launcher runs the authoritative gate suite after you return. Protected-behavior evidence remains machine-checked, but this narrow contract does not require repeating every protected-behavior ID in final prose when the diff cannot reach it.

Return exactly this structure and stop:
FASTPATH_REMEDIATION_RESULT:
- [task ID] FIXED | NOT_FIXED | BLOCKED — [changed path/symbol or evidence]
FOCUSED_PROOF:
- [exact focused RED and green command] — [result]
SCOPE_CONFIRMATION:
- PATHS: [changed paths] | HEAD: UNCHANGED | OWNED_ONLY: CONFIRMED
SCOPE_ESCALATION:
- [required new boundary, or NONE]
`;
const reviewContextBytes = machineReviewContext ? `${JSON.stringify(machineReviewContext, null, 2)}\n` : null;
const reviewPromptContext = machineReviewContext?.schema === 2 ? {
  ...machineReviewContext,
  predecessorManifest: { path: machineReviewContext.predecessorManifest.path, sha256: machineReviewContext.predecessorManifest.sha256, schema: machineReviewContext.predecessorManifest.schema },
  candidateSnapshot: machineReviewContext.candidateSnapshot.map(compactReviewRecord)
} : machineReviewContext;
const reviewCandidateFiles = () => {
  // Batch Git metadata reads: mode changes matter even when file bytes do not.
  const modes = new Map(git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(line => {
    const [metadata, path] = line.split('\t');
    return [path, metadata.split(' ')[0]];
  }));
  const rawDiff = git(['diff', '--raw', '--no-renames', '-z', cubicSourceSha]).split('\0');
  for (let index = 0; index + 1 < rawDiff.length; index += 2) {
    const mode = rawDiff[index].match(/^:\d{6} (\d{6}) /)?.[1];
    if (mode) modes.set(rawDiff[index + 1], mode);
  }
  return machineReviewContext.reviewedChangedPaths.map(path => {
    const candidatePath = join(repo, path);
    return { path, mode: existsSync(candidatePath) ? modes.get(path) || '100644' : '000000', sha256: existsSync(candidatePath) ? sha256(readFileSync(candidatePath)) : null };
  });
};
const reviewStartHead = isCodeReviewer ? git(['rev-parse', 'HEAD']).trim() : null;
const reviewStartStatus = isCodeReviewer ? git(['status', '--porcelain', '--untracked-files=all']) : null;
if (isCodeReviewer && !revalidateExisting && (reviewStartHead !== cubicSourceSha || (!isLocalPrecommitReview && reviewStartStatus.trim()))) {
  throw new Error('REVIEW_FROZEN_ARTIFACT_MISMATCH: HEAD must equal FROZEN_SOURCE_SHA and PR review requires a clean checkout.');
}
const reviewIdentity = machineReviewContext && !isLocalPrecommitReconciliation ? {
  promptSha256: sha256(rawInput),
  contextSha256: sha256(reviewContextBytes),
  candidateBlobs: reviewCandidateFiles()
} : null;
if (reviewIdentity) reviewIdentity.candidateBlobsSha256 = sha256(JSON.stringify(reviewIdentity.candidateBlobs));
const dryRunOutput = a['dry-run'] === 'true' && existsSync(output) ? `${output}.dry-run.json` : output;
let machineReviewContextPath = null;
if (machineReviewContext) {
  machineReviewContextPath = `${output}.review-context.json`;
}
const machineReviewContextInstruction = machineReviewContextPath
  ? `MACHINE_GENERATED_REVIEW_CONTEXT_INLINE_JSON:\n${JSON.stringify(reviewPromptContext)}\nThe launcher generated and byte-validated this immutable context before this reviewer started. It is embedded because safe-mode reviewers cannot read coordinator receipts or external baseline worktrees. Treat it as authoritative for the candidate manifest and correction delta. Inspect connected callers/consumers and every correctionDeltaPaths file. Explicitly disposition every delta path and known finding ID; validated knownFindingCoverage may prove an ID through every linked protected behavior.\n`
  : '';
const reviewContextHeaders = /^(?:FROZEN_SOURCE_SHA|REVIEW_CORRECTION_MODE|REVIEW_KNOWN_FINDING_IDS_JSON|REVIEW_KNOWN_FINDING_COVERAGE_JSON|REVIEW_CHANGED_PATHS_JSON|REVIEW_IMPACT_MAP_JSON|REVIEW_CORRECTION_DELTA_PATHS_JSON):.*(?:\r?\n|$)/gmi;
const compactReviewInput = rawInput.replace(reviewContextHeaders, '').trim();
const buildLaneInput = (embeddedContext) => a.role === 'reviewer-plan' ? `${planReviewContract}\n\n${rawInput}`
  : a.role === 'reviewer' ? `${codeReviewContract}\n\n${embeddedContext}\n${compactReviewInput}`
    : a.role === closureReviewRole ? `${closureReviewContract}\n\n${embeddedContext}\n${compactReviewInput}`
    : isCubicExecutor ? `${cubicExecutorContract}\n\n${rawInput}`
      : isStandardExecutor ? `${isFastPathExecutorContract ? fastPathExecutorContract : standardExecutorContract}\n\n${rawInput}`
        : rawInput;
const reviewLocation = isClaudeReview ? `REVIEWED_REPOSITORY: ${repo}\nThe launch directory contains wrapper runtime only. Read the named repository using absolute paths; use git -C "${repo}" for read-only Git inspection. Do not modify it.\n` : '';
const inputPrefix = `${scopeGuardContract}\n\n${reviewLocation}`;
const input = `${inputPrefix}${buildLaneInput(machineReviewContextInstruction)}`;
// Omit only the context inserted by this launcher. Markers in --prompt are scanned as supplied.
scanModelLiterals(`${inputPrefix}${buildLaneInput('')}`, prompt);
if (machineReviewContextPath && !revalidateExisting && a['dry-run'] !== 'true')
  writeFileSync(machineReviewContextPath, reviewContextBytes, { encoding: 'utf8', flag: 'wx' });
const packetTokenizerProgram = [
  'import json',
  'import sys',
  'import tiktoken',
  'texts = json.load(sys.stdin)',
  "encoding = tiktoken.get_encoding('o200k_base')",
  'counts = {key: len(encoding.encode(value)) for key, value in texts.items()}',
  "print(json.dumps({'version': getattr(tiktoken, '__version__', 'unknown'), 'counts': counts}))"
].join('\n');
const packetTokenCounts = () => {
  if (!isStandardExecutor) return null;
  const unavailable = reason => ({
    tokenizer: { library: 'tiktoken', encoding: 'o200k_base', status: 'unavailable', reason },
    rawPacketTokens: null,
    launchPromptTokens: null,
  });
  const tokenized = spawnSync('python', ['-c', packetTokenizerProgram], {
    input: JSON.stringify({
      rawPacket: rawInput,
      launchPrompt: input,
    }),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  if (tokenized.error?.code === 'ENOENT') return unavailable('python-unavailable');
  if (tokenized.status !== 0) return unavailable('tokenizer-command-failed');
  let reported;
  try { reported = JSON.parse(tokenized.stdout); } catch { return unavailable('invalid-tokenizer-result'); }
  const counts = reported?.counts;
  const names = ['rawPacket', 'launchPrompt'];
  if (!names.every(name => Number.isSafeInteger(counts?.[name]) && counts[name] >= 0)) return unavailable('invalid-tokenizer-result');
  return {
    tokenizer: {
      library: 'tiktoken',
      version: typeof reported.version === 'string' ? reported.version : 'unknown',
      encoding: 'o200k_base',
      status: 'estimated',
      basis: 'explicit-o200k_base-for-unmapped-model-alias'
    },
    rawPacketTokens: counts.rawPacket,
    launchPromptTokens: counts.launchPrompt,
  };
};
const maxReviewerInputBytes = 256 * 1024;
const reviewerInputByteLength = Buffer.byteLength(input);
if (isCodeReviewer && !revalidateExisting && reviewerInputByteLength > maxReviewerInputBytes) {
  throw new Error(`PRECOMMIT_REVIEW_INPUT_TOO_LARGE: reviewer input is ${reviewerInputByteLength} bytes; maximum is ${maxReviewerInputBytes}. Reduce the actual correction delta before launching a paid review; truncation is forbidden.`);
}
// Opt-in operational measurement. The existing monitor remains byte-for-byte
// compatible unless this flag is explicitly enabled for a lane.
const telemetryTaskId = runRootMatch ? basename(runRootMatch[1]) : null;
const telemetryTaskLedgerPath = runRootMatch ? join(runRootMatch[1], 'DIRECT_LANE_LEDGER.jsonl') : null;
const telemetry = {
  modelStartedAtMs: null,
  modelCompletedAtMs: null,
  verificationStartedAtMs: null,
  modelExitCode: null,
  requestedReasoningEffort: null,
  eventBuffer: '',
  eventStartedAtMs: new Map(),
  turns: [],
  providerReportedUsage: [],
  usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWriteReported: false, outputTokens: 0, reasoningTokens: 0 },
  toolMix: { commandExecutions: 0, fileReadCommands: 0, grepCommands: 0, shellCommands: 0, testInvocations: 0 },
  preEditRedProof: { testInvocations: 0, elapsedMs: 0 },
  firstEditAtMs: null,
  lastEditAtMs: null,
  terminalWritten: false
};
const telemetryIso = epochMs => epochMs === null ? null : new Date(epochMs).toISOString();
const telemetryNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const telemetryFailureClassification = (exitCode, timedOut, failure) => {
  const text = String(failure || '');
  if (/OUT_OF_ROOT_MODIFICATION/.test(text)) return 'out-of-root-modification';
  if (/OUT_OF_ROOT_OBSERVATION_FAILED/.test(text)) return 'out-of-root-observation-failed';
  if (timedOut) return 'timeout';
  if (/LAUNCH_SPAWN_ERROR/.test(text)) return 'spawn-error';
  if (/MACHINE_REQUIRED_GATE_FAILED|EXECUTOR_REQUIRED_GATES/.test(text)) return 'required-gate';
  if (/EXECUTOR_REMEDIATION_RESULT|CROSS_IMPACT_CHECK|CALLER_CLOSURE_RESULT|missing required markers|executor .*required|executor lane completed without/i.test(text)) return 'required-marker';
  if (/EXECUTOR_TASK_IDS_JSON|protected behavior IDs|PROTECTED_BEHAVIORS/.test(text)) return 'packet-or-marker-contract';
  if (/unauthorized paths/i.test(text)) return 'unauthorized-path';
  if (/^REVIEW_|review lane/i.test(text)) return 'review-rejection';
  if (exitCode !== 0) return 'model-or-launcher-exit';
  return failure ? 'terminal-validation' : null;
};
const telemetryCommandCategories = command => {
  const text = String(command || '');
  const isFileRead = /\b(?:Get-Content|cat|type|sed|head|tail)\b/i.test(text);
  const isGrep = /\b(?:rg|grep|Select-String|findstr)\b/i.test(text);
  const isTest = /\b(?:dotnet\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|vitest|jest|pytest|go\s+test|cargo\s+test)\b/i.test(text);
  return { isFileRead, isGrep, isTest };
};
const recordTelemetryEvent = (record, observedAtMs) => {
  if (!directLaneTelemetryEnabled || !record || typeof record !== 'object') return;
  if (record.type === 'turn.started') {
    telemetry.turns.push({ startedAtMs: observedAtMs, completedAtMs: null, elapsedMs: null });
    return;
  }
  if (record.type === 'turn.completed') {
    const turn = [...telemetry.turns].reverse().find(item => item.completedAtMs === null);
    if (turn) {
      turn.completedAtMs = observedAtMs;
      turn.elapsedMs = observedAtMs - turn.startedAtMs;
    }
    const usage = record.usage || {};
    telemetry.providerReportedUsage.push(usage);
    telemetry.usage.inputTokens += telemetryNumber(usage.input_tokens);
    telemetry.usage.cacheReadTokens += telemetryNumber(usage.cached_input_tokens);
    if (Object.hasOwn(usage, 'cache_write_input_tokens')) {
      telemetry.usage.cacheWriteReported = true;
      telemetry.usage.cacheWriteTokens += telemetryNumber(usage.cache_write_input_tokens);
    }
    telemetry.usage.outputTokens += telemetryNumber(usage.output_tokens);
    telemetry.usage.reasoningTokens += telemetryNumber(usage.reasoning_output_tokens);
    return;
  }
  const item = record.item;
  if (!item?.id) return;
  if (record.type === 'item.started') {
    telemetry.eventStartedAtMs.set(item.id, observedAtMs);
    return;
  }
  if (record.type !== 'item.completed') return;
  const startedAtMs = telemetry.eventStartedAtMs.get(item.id);
  const elapsedMs = startedAtMs === undefined ? 0 : observedAtMs - startedAtMs;
  if (item.type === 'file_change') {
    telemetry.firstEditAtMs ??= observedAtMs;
    telemetry.lastEditAtMs = observedAtMs;
    return;
  }
  if (item.type !== 'command_execution') return;
  telemetry.toolMix.commandExecutions += 1;
  const categories = telemetryCommandCategories(item.command);
  if (categories.isFileRead) telemetry.toolMix.fileReadCommands += 1;
  if (categories.isGrep) telemetry.toolMix.grepCommands += 1;
  if (categories.isTest) {
    telemetry.toolMix.testInvocations += 1;
    if (telemetry.firstEditAtMs === null) {
      telemetry.preEditRedProof.testInvocations += 1;
      telemetry.preEditRedProof.elapsedMs += elapsedMs;
    }
  }
  if (!categories.isFileRead && !categories.isGrep && !categories.isTest) telemetry.toolMix.shellCommands += 1;
};
const recordTelemetryChunk = chunk => {
  if (!directLaneTelemetryEnabled) return;
  telemetry.eventBuffer += chunk.toString('utf8');
  const lines = telemetry.eventBuffer.split(/\r?\n/);
  telemetry.eventBuffer = lines.pop();
  const observedAtMs = Date.now();
  for (const line of lines) {
    try { recordTelemetryEvent(JSON.parse(line), observedAtMs); } catch { }
  }
};
const telemetryTiming = completedAtMs => {
  const modelStartedAtMs = telemetry.modelStartedAtMs;
  const modelCompletedAtMs = telemetry.modelCompletedAtMs;
  const verificationStartedAtMs = telemetry.verificationStartedAtMs;
  return {
    lane: { startedAt: telemetryIso(telemetryLaneStartedAtMs), completedAt: telemetryIso(completedAtMs), elapsedMs: completedAtMs - telemetryLaneStartedAtMs },
    model: { startedAt: telemetryIso(modelStartedAtMs), completedAt: telemetryIso(modelCompletedAtMs), elapsedMs: modelStartedAtMs === null || modelCompletedAtMs === null ? null : modelCompletedAtMs - modelStartedAtMs },
    verification: { startedAt: telemetryIso(verificationStartedAtMs), completedAt: telemetryIso(completedAtMs), elapsedMs: verificationStartedAtMs === null ? 0 : completedAtMs - verificationStartedAtMs }
  };
};
const writeTerminalTelemetry = monitor => {
  if (!directLaneTelemetryEnabled || telemetry.terminalWritten) return;
  telemetry.terminalWritten = true;
  const completedAtMs = Date.parse(monitor.completedAt);
  const cacheReadTokens = telemetry.usage.cacheReadTokens;
  const cacheWriteTokens = telemetry.usage.cacheWriteReported ? telemetry.usage.cacheWriteTokens : null;
  const inputTokens = telemetry.usage.inputTokens;
  const laneRecord = {
    schema: 2,
    recordType: 'lane-terminal',
    taskId: telemetryTaskId,
    taskIds: isStandardExecutor ? standardTaskIds : [],
    role: a.role,
    output,
    terminal: { phase: monitor.phase, exitCode: monitor.exitCode, modelExitCode: monitor.modelExitCode ?? telemetry.modelExitCode, timedOut: Boolean(monitor.timedOut), failureClassification: monitor.failureClassification },
    outOfRootGuard: monitor.outOfRootGuard ? {
      enabled: monitor.outOfRootGuard.enabled,
      status: monitor.outOfRootGuard.status,
      primaryRoot: monitor.outOfRootGuard.primaryRoot,
      monitoredRoots: monitor.outOfRootGuard.monitoredRoots,
      findings: monitor.outOfRootGuard.findings || []
    } : null,
    timing: telemetryTiming(completedAtMs),
    requestedReasoningEffort: telemetry.requestedReasoningEffort,
    packet: isStandardExecutor ? {
      rawPacketBytes: executorPacketBytes,
      launchPromptBytes: Buffer.byteLength(input),
      tokenCounts: packetTokenCounts()
    } : null,
    usage: {
      inputTokens,
      nonCachedInputTokens: cacheWriteTokens === null ? null : Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
      cacheReadTokens,
      cacheWriteTokens,
      cacheWriteReported: telemetry.usage.cacheWriteReported,
      reasoningTokens: telemetry.usage.reasoningTokens,
      outputTokens: telemetry.usage.outputTokens
    },
    pricing: isStandardExecutor && telemetry.modelStartedAtMs !== null ? {
      model: writer?.model,
      costUsd: null,
      status: 'unpriced',
      reason: 'official-provider-rate-not-configured'
    } : null,
    providerReportedUsage: telemetry.providerReportedUsage,
    modelActivity: {
      turns: telemetry.turns.map(turn => ({ elapsedMs: turn.elapsedMs })),
      averageTurnElapsedMs: telemetry.turns.length ? Math.round(telemetry.turns.reduce((total, turn) => total + (turn.elapsedMs || 0), 0) / telemetry.turns.length) : null,
      toolMix: telemetry.toolMix,
      preEditRedProof: telemetry.preEditRedProof,
      lastEditToTerminalMs: telemetry.lastEditAtMs === null ? null : completedAtMs - telemetry.lastEditAtMs,
      packetRereadAssessment: 'not-observable-from-event-stream'
    }
  };
  try {
    writeFileSync(`${output}.lane-telemetry.json`, `${JSON.stringify(laneRecord, null, 2)}\n`, 'utf8');
    if (telemetryTaskLedgerPath) appendFileSync(telemetryTaskLedgerPath, `${JSON.stringify(laneRecord)}\n`, 'utf8');
  } catch (error) {
    telemetry.terminalWritten = false;
    monitor.telemetryError = error instanceof Error ? error.message : String(error);
  }
};
const finalizeMonitor = (exitCode, phase, failure = null, force = false) => {
  let monitor = null;
  try { monitor = existsSync(monitorPath) ? JSON.parse(readFileSync(monitorPath, 'utf8')) : null; } catch { monitor = null; }
  if (!monitor && !directLaneTelemetryEnabled && !force) return;
  monitor ||= {};
  const precedingFailure = failure;
  if (outOfRootGuardStart && !outOfRootGuardTerminal) outOfRootGuardTerminal = finishOutOfRootGuard(outOfRootGuardStart);
  if (outOfRootGuardTerminal?.status === 'modified') {
    const changed = outOfRootGuardTerminal.findings.map(item => `${item.root}: ${item.paths.join(', ') || '<HEAD or Git state>'}`).join('; ');
    exitCode = 1;
    phase = 'failed';
    failure = `OUT_OF_ROOT_MODIFICATION: ${changed}`;
  } else if (outOfRootGuardTerminal?.status === 'observation-failed') {
    const failed = outOfRootGuardTerminal.findings.map(item => `${item.root}: ${(item.errors || []).join(' | ')}`).join('; ')
      || outOfRootGuardTerminal.discoveryErrors.map(item => `${item.root}: ${item.error}`).join('; ');
    exitCode = 1;
    phase = 'failed';
    failure = `OUT_OF_ROOT_OBSERVATION_FAILED: ${failed}`;
  }
  const completedAtMs = Date.now();
  const startedAt = monitor.startedAt || telemetryIso(telemetryLaneStartedAtMs);
  const finalMonitor = {
    ...monitor,
    role: monitor.role || a.role,
    output: monitor.output || output,
    startedAt,
    terminal: true,
    phase,
    currentGate: null,
    completedAt: telemetryIso(completedAtMs),
    elapsedMs: completedAtMs - Date.parse(startedAt),
    exitCode,
    modelExitCode: monitor.modelExitCode ?? telemetry.modelExitCode,
    timedOut: Boolean(monitor.timedOut),
    failure,
    ...(outOfRootGuardTerminal && precedingFailure && precedingFailure !== failure ? { precedingFailure } : {}),
    ...(outOfRootGuardTerminal ? { outOfRootGuard: outOfRootGuardTerminal } : {}),
  };
  if (directLaneTelemetryEnabled) {
    finalMonitor.failureClassification = telemetryFailureClassification(exitCode, finalMonitor.timedOut, failure);
    finalMonitor.timing = telemetryTiming(completedAtMs);
  }
  writeTerminalTelemetry(finalMonitor);
  writeFileSync(monitorPath, `${JSON.stringify(finalMonitor, null, 2)}\n`, 'utf8');
  return finalMonitor;
};
telemetryTerminalFinalizer = finalizeMonitor;
process.on('uncaughtException', error => {
  finalizeMonitor(1, 'failed', error instanceof Error ? error.message : String(error));
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
const requestedTimeoutMinutes = Number(a['timeout-minutes'] || 60);
const timeoutMs = (a.role === 'reviewer' || a.role === 'reviewer-plan' || a.role === closureReviewRole)
  ? 60 * 60000
  : Math.max(1, requestedTimeoutMinutes) * 60000;

if (a['dry-run'] === 'true') {
  // Validate protected-behavior evidence before any paid reviewer is launched.
  // Previously this check ran only after Claude completed, which could turn a
  // semantically sound review into an avoidable incomplete artifact.
  if (a.role === 'reviewer' || a.role === closureReviewRole) {
    const missingProtectedEvidence = [];
    for (const behavior of reviewProtectedBehaviors || []) {
      for (const evidence of [...behavior.requiredSourceEvidence, ...behavior.requiredRegressionEvidence]) {
        const [rawPath, token] = evidence.split('::');
        const sourcePath = join(repo, normalizeRepoPath(rawPath));
        if (!existsSync(sourcePath) || !readFileSync(sourcePath, 'utf8').includes(token))
          missingProtectedEvidence.push(`${behavior.id}:${evidence}`);
      }
    }
    if (missingProtectedEvidence.length)
      throw new Error(`REVIEW_PACKET_STALE_PROTECTED_EVIDENCE:\n- ${missingProtectedEvidence.join('\n- ')}\nCorrect every literal token, then rerun --dry-run true before a paid review.`);
  }
  // Scope-locked executor gates must name real local artifacts. A syntactically
  // safe command such as `dotnet build Missing.sln` is not an executable gate.
  if (isStandardExecutor) {
    const missingGateArtifacts = [];
    for (const spec of executorGateSpecs) {
      if (spec.artifact && !existsSync(join(repo, normalizeRepoPath(spec.artifact)))) missingGateArtifacts.push(`${spec.command} -> ${spec.artifact}`);
    }
    if (missingGateArtifacts.length)
      throw new Error(`EXECUTOR_REQUIRED_GATES_MISSING_ARTIFACT:\n- ${missingGateArtifacts.join('\n- ')}\nCorrect every command path, then rerun --dry-run true before a paid lane.`);
  }
  const route = reviewEngine === 'gpt' ? { primary: reviewEngineLabel, fallback: 'none', isolation: 'disposable-review-worktree', hardCapMinutes: 60, ...(a.role === 'reviewer' ? { closure: 'zero-confirmed-or-probable-high-medium' } : { maximumCompletedArtifacts: 1 }) }
    : a.role === 'reviewer' ? { primary: reviewEngineLabel, fallback: 'none', isolation: 'disposable-review-worktree', hardCapMinutes: 60, closure: 'zero-confirmed-or-probable-high-medium' }
    : a.role === 'reviewer-plan' ? { primary: reviewEngineLabel, fallback: 'none', isolation: 'disposable-review-worktree', hardCapMinutes: 60, maximumCompletedArtifacts: 1 }
    : a.role === closureReviewRole ? { primary: reviewEngineLabel, fallback: 'none', isolation: 'disposable-review-worktree', hardCapMinutes: 60, closure: 'zero-confirmed-or-probable-high-medium' }
    : { primary: writer.model, isolation: a.role.startsWith('executor-') ? 'assigned-writer-worktree' : 'disposable-read-only-worktree', correctionLedger: isCubicExecutor ? 'required' : undefined };
  const packetValidation = (a.role === 'reviewer' || a.role === closureReviewRole)
    ? { status: 'passed', evidenceFormat: 'repo-relative/path::literal source token', sourceEvidenceVerified: true }
    : { status: 'passed' };
  const windowsInvocation = process.platform === 'win32'
    ? { usePty: false, shellWrappers: false, reason: 'Invoke node directly without tty/PTY, Start-Process, cmd /c, or a second shell.' }
    : undefined;
  // A dry-run is validation evidence, never a replacement for an already
  // completed reviewer transcript. Preserve the live artifact and write a
  // deterministic sidecar when callers validate a retry/reconciliation.
  const dryRunGuard = beginOutOfRootGuard();
  const guardObservationFailed = Boolean(dryRunGuard && (dryRunGuard.discoveryErrors.length || dryRunGuard.snapshots.some(item => !item.observed)));
  if (dryRunGuard) dryRunGuard.status = guardObservationFailed ? 'observation-failed' : 'observed';
  writeFileSync(dryRunOutput, `${JSON.stringify({ role: a.role, repo, timeoutMs, packetValidation, windowsInvocation, ...route, dryRunOutput, promptBytes: Buffer.byteLength(input), sourcePacketBytes: Buffer.byteLength(rawInput), reviewerInputByteLength: isCodeReviewer ? reviewerInputByteLength : undefined, maxReviewerInputBytes: isCodeReviewer ? maxReviewerInputBytes : undefined, reviewContext: machineReviewContext, ...(dryRunGuard ? { outOfRootGuard: dryRunGuard } : {}) }, null, 2)}\n`, 'utf8');
  if (guardObservationFailed) process.stderr.write('OUT_OF_ROOT_OBSERVATION_FAILED: could not establish every discovered root baseline; model was not launched.\n');
  process.exit(guardObservationFailed ? 1 : 0);
}


function terminateTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
  else child.kill('SIGTERM');
}

function commandSpec(name) {
  if (process.platform !== 'win32') return { executable: name, prefix: [] };
  const found = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/).filter(Boolean) || [];
  const native = found.find(path => extname(path).toLowerCase() === '.exe');
  if (native) return { executable: native, prefix: [] };
  const wrapper = found.find(path => ['.cmd', '.bat', ''].includes(extname(path).toLowerCase()));
  if (wrapper && name === 'codex') {
    const entry = join(dirname(wrapper), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(entry)) return { executable: process.execPath, prefix: [entry] };
  }
  if (wrapper && name === 'opencode') {
    const entry = join(dirname(wrapper), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (existsSync(entry)) return { executable: entry, prefix: [] };
  }
  if (wrapper && name === 'npm') {
    const entry = join(dirname(wrapper), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(entry)) return { executable: process.execPath, prefix: [entry] };
  }
  throw new Error(`Executable not found: ${name}`);
}

const reviewLaunchState = isCodeReviewer ? await import('./run-state.mjs') : null;
// Paid-review bookkeeping always stays outside the frozen candidate. A legacy
// candidate ledger is read once to seed the external coordinator, never written.
const reviewRun = runRoot && basename(runRoot);
const externalStateRepo = runRoot && (basename(dirname(runRoot)) === 'runs' ? dirname(dirname(dirname(runRoot))) : dirname(dirname(runRoot)));
const canonicalReviewDir = isCodeReviewer ? join(externalStateRepo, '.trioharness-direct', 'runs', reviewRun) : null;
const alternateReviewDir = isCodeReviewer ? join(externalStateRepo, 'trioharness-direct-runs', reviewRun) : null;
const reviewStateDir = isCodeReviewer && !existsSync(join(canonicalReviewDir, 'state.json')) && existsSync(join(alternateReviewDir, 'state.json')) ? alternateReviewDir : canonicalReviewDir;
const legacyReviewFile = isCodeReviewer ? join(repo, '.trioharness-direct', 'runs', reviewRun, 'state.json') : null;
let reviewReservation = a['review-reservation'] || randomUUID();
const reviewBudgetOptions = isCodeReviewer ? { directory: reviewStateDir, worker: a.worker, output,
  receiptFiles: [codeReviewReceipt, join(canonicalReviewDir, 'CODE_REVIEW_ROUNDS.jsonl'), join(alternateReviewDir, 'CODE_REVIEW_ROUNDS.jsonl')],
  ...(!existsSync(join(reviewStateDir, 'state.json')) && existsSync(legacyReviewFile) ? { legacyState: JSON.parse(readFileSync(legacyReviewFile, 'utf8')) } : {}) } : null;
let reviewLaunchReserved = false;
function run(executable, args, env = process.env, stdoutIsFinal = false, cwd = repo) {
  return new Promise(resolveRun => {
    const startedAt = Date.now();
    if (directLaneTelemetryEnabled) telemetry.modelStartedAtMs ??= startedAt;
    let lastActivityAt = startedAt; let stdoutBytes = 0; let stderrBytes = 0; let tail = ''; let timedOut = false;
    const spec = commandSpec(executable);
    try {
      if (isCodeReviewer && !reviewLaunchReserved) {
        reviewLaunchState.reserveReviewLaunch(externalStateRepo, reviewRun, { ...reviewBudgetOptions, reservation: reviewReservation });
        reviewLaunchReserved = true;
      }
    } catch (error) {
      const failure = String(error.message || error);
      finalizeMonitor(1, 'failed', failure, true); process.stderr.write(failure + '\n');
      resolveRun({ status: 1, timedOut: false, tail: failure }); return;
    }
    const stdoutStream = createWriteStream(stdoutIsFinal ? output : eventsPath, { flags: 'w' });
    const stderrStream = createWriteStream(stderrPath, { flags: 'w' });
    writeFileSync(heartbeatPath, '', 'utf8');
    const refund = () => {
      if (isCodeReviewer && reviewLaunchReserved) {
        reviewLaunchState.releaseReviewLaunch(externalStateRepo, reviewRun, reviewReservation, reviewBudgetOptions);
        reviewLaunchReserved = false;
        reviewReservation = randomUUID();
      }
    };
    let child;
    try { child = spawn(spec.executable, [...spec.prefix, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) {
      if (error.code === 'ENOENT') refund();
      stdoutStream.end(); stderrStream.end();
      const failure = `LAUNCH_SPAWN_ERROR: ${error.code || 'Error'}: ${error.message}`;
      finalizeMonitor(1, 'failed', failure, true); process.stderr.write(failure + '\n');
      resolveRun({ status: 1, timedOut: false, tail: failure }); return;
    }
    let modelWorked = false, reviewBuffer = '', reviewErrorBuffer = '';
    const positiveUsage = value => value && typeof value === 'object' && Object.entries(value).some(([key, item]) =>
      (/^(input_tokens|output_tokens|total_tokens|prompt_tokens|completion_tokens|inputTokens|outputTokens|totalTokens)$/.test(key) && typeof item === 'number' && item > 0) || (item && typeof item === 'object' && positiveUsage(item)));
    const observeReview = line => {
      if (!isCodeReviewer || modelWorked) return;
      try {
        const record = JSON.parse(line);
        if (positiveUsage(record.usage) || positiveUsage(record.modelUsage) || positiveUsage(record.response?.usage) ||
            record.type === 'assistant' && (record.message?.content?.length || record.content?.length) ||
            /^item\.(started|completed)$/.test(record.type) && ['agent_message', 'assistant_message', 'reasoning', 'command_execution', 'function_call', 'tool_call'].includes(record.item?.type) ||
            record.type === 'response.output_text.delta' && record.delta ||
            record.type === 'result' && record.is_error !== true && record.subtype === 'success' && record.result) modelWorked = true;
      } catch { /* unstructured diagnostics are not proof of model work */ }
    };
    let spawnError = null;
    let settled = false;
    let heartbeat = null;
    let deadline = null;
    const beat = terminal => writeFileSync(
      heartbeatPath,
      `${JSON.stringify({ at: new Date().toISOString(), pid: child.pid || null, role: a.role, elapsedMs: Date.now() - startedAt, lastActivityAt: new Date(lastActivityAt).toISOString(), stdoutBytes, stderrBytes, terminal })}\n`,
      { encoding: 'utf8', flag: 'a' });
    const finish = async (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      beat(true);
      await Promise.all([stdoutStream, stderrStream].map(stream => new Promise(done => stream.end(done))));
      if (directLaneTelemetryEnabled && telemetry.eventBuffer.trim()) {
        try { recordTelemetryEvent(JSON.parse(telemetry.eventBuffer), Date.now()); } catch { }
        telemetry.eventBuffer = '';
      }
      observeReview(reviewBuffer); observeReview(reviewErrorBuffer);
      if (isCodeReviewer && existsSync(`${output}.last-message.txt`) && readFileSync(`${output}.last-message.txt`, 'utf8').trim()) modelWorked = true;
      if (isCodeReviewer && !modelWorked && (spawnError || (code !== 0 && /(?:\b429\b|rate.?limit|unauthori[sz]ed|authentication (?:failed|required)|not logged in|invalid api key|executable.*not found)/i.test(tail)))) refund();
      const modelExitCode = spawnError ? null : code;
      if (directLaneTelemetryEnabled && !spawnError) {
        telemetry.modelCompletedAtMs ??= Date.now();
        telemetry.modelExitCode ??= modelExitCode;
        telemetry.verificationStartedAtMs ??= telemetry.modelCompletedAtMs;
      }
      const launchRuntimePath = `${output}.launch-runtime.json`;
      let launchRuntime = null;
      if (existsSync(launchRuntimePath)) {
        try { launchRuntime = JSON.parse(readFileSync(launchRuntimePath, 'utf8')); } catch { launchRuntime = null; }
      }
      const receipt = { role: a.role, executable: spec.executable, pid: child.pid || null, launcherPid: process.pid, startedAt: new Date(startedAt).toISOString(), completedAt: null, elapsedMs: Date.now() - startedAt, modelExitCode, exitCode: null, signal, timedOut, terminal: false, phase: 'validating', stdoutBytes, stderrBytes, output, eventsPath, stderrPath, heartbeatPath, launchRuntime, reviewIdentity, spawnError, ...(machineReviewContext?.contextSha256 ? { reviewContextSha256: machineReviewContext.contextSha256 } : {}), ...(outOfRootGuardStart ? { outOfRootGuard: outOfRootGuardStart } : {}) };
      if (isCodeReviewer && reviewLaunchReserved) receipt.reviewReservation = reviewReservation;
      if (isCodeReviewer && existsSync(output)) receipt.reviewOutputSha256 = sha256(readFileSync(output));
      writeFileSync(monitorPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      resolveRun({ status: spawnError ? 1 : code, timedOut, tail, spawnError });
    };
    child.stdout.on('data', chunk => { lastActivityAt = Date.now(); stdoutBytes += chunk.length; stdoutStream.write(chunk); if (isCodeReviewer) { reviewBuffer += chunk.toString('utf8'); const lines = reviewBuffer.split(/\r?\n/); reviewBuffer = lines.pop(); for (const line of lines) observeReview(line); } recordTelemetryChunk(chunk); tail = `${tail}${chunk.toString('utf8')}`.slice(-65536); });
    child.stderr.on('data', chunk => { lastActivityAt = Date.now(); stderrBytes += chunk.length; stderrStream.write(chunk); if (isCodeReviewer) { reviewErrorBuffer += chunk.toString('utf8'); const lines = reviewErrorBuffer.split(/\r?\n/); reviewErrorBuffer = lines.pop(); for (const line of lines) observeReview(line); } tail = `${tail}${chunk.toString('utf8')}`.slice(-65536); });
    child.on('error', error => {
      spawnError = { name: error?.name || 'Error', code: error?.code || null, message: error?.message || String(error) };
      tail = `${tail}\nLAUNCH_SPAWN_ERROR: ${spawnError.code || spawnError.name}: ${spawnError.message}`.slice(-65536);
      void finish(1, null);
    });
    child.stdin.on('error', () => { /* spawn failure is recorded by child error/close */ });
    child.stdin.end(input);
    beat(false);
    heartbeat = setInterval(() => beat(false), 15000);
    deadline = setTimeout(() => { timedOut = true; terminateTree(child); }, timeoutMs);
    child.on('close', (code, signal) => { void finish(code, signal); });
  });
}

const requiredReviewMarkers = role => role === 'reviewer-plan'
  ? ['PLAN_DECISION:', 'MATERIAL_FINDINGS:', 'NEEDS_EVIDENCE:', 'ACCEPTED_BOUNDARIES:']
  : role === 'reviewer' || role === closureReviewRole
    ? ['REVIEW_DECISION:', 'PROTECTED_BEHAVIOR_DISPOSITION:', 'CORRECTION_DELTA_DISPOSITION:', 'MATERIAL_FINDINGS:', 'NON_FINDINGS:', 'ROUND_SUMMARY:', 'RUNTIME_ASSERTION:']
    : ['REVIEW_DECISION:', 'MATERIAL_FINDINGS:', 'NON_FINDINGS:', 'ROUND_SUMMARY:'];
let cachedReviewRecords;
const reviewStreamRecords = () => {
  if (cachedReviewRecords) return cachedReviewRecords;
  if (!existsSync(output)) return [];
  const raw = readFileSync(output, 'utf8');
  return cachedReviewRecords = raw.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean).flatMap(line => {
    try { const parsed = JSON.parse(line); return parsed?.type === 'result' || (parsed?.type === 'system' && parsed.subtype === 'init') ? [parsed] : []; }
    catch { return []; }
  });
};
const reviewerFinalRecord = () => reviewStreamRecords().filter(record => record.type === 'result').at(-1) || null;
const reviewerFinalText = () => {
  const record = reviewerFinalRecord();
  return record && record.is_error !== true && !/error/i.test(String(record.subtype || '')) && typeof record.result === 'string'
    ? record.result : '';
};
const requireCompleteReview = (reviewResult, role) => {
  if (!existsSync(output) || reviewResult.timedOut || reviewResult.status == null) return reviewResult;
  const reviewText = reviewerFinalText();
  const missing = requiredReviewMarkers(role).filter(marker => !reviewText.includes(marker));
  if (role === 'reviewer-plan' && !/^PLAN_DECISION:\s*(?:APPROVE|AMEND|BLOCK)\s*$/m.test(reviewText)) missing.push('valid PLAN_DECISION');
  if (missing.length) return { ...reviewResult, status: 1, tail: `${reviewResult.tail}\nmalformed/incomplete review result: missing ${missing.join(', ')}` };
  // Claude can return a non-zero process status after it has durably emitted a
  // complete successful terminal record. Treat the validated artifact—not that
  // transport-level status—as the review result. Timeouts, signals, missing
  // output, error records, and malformed results still fail closed above.
  return reviewResult.status === 0
    ? reviewResult
    : { ...reviewResult, status: 0, tail: `${reviewResult.tail}\nrecovered complete review artifact after Claude process exit ${reviewResult.status}` };
};
const reportedRuntime = (expectedModel, expectedEffort) => {
  if (!existsSync(output)) return { verified: false, reason: 'no reviewer output' };
  let launch = null;
  const launchPath = `${output}.launch-runtime.json`;
  if (existsSync(launchPath)) {
    try { launch = JSON.parse(readFileSync(launchPath, 'utf8')); } catch { launch = null; }
  }
  const records = reviewStreamRecords();
  const init = records.find(record => record.type === 'system' && record.subtype === 'init') || null;
  const terminal = records.filter(record => record.type === 'result').at(-1) || null;
  const trusted = [init, terminal].filter(Boolean);
  const values = keys => trusted.flatMap(record => keys.map(key => record[key])).filter(value => value !== undefined && value !== null);
  const models = values(['model', 'canonicalModel']);
  for (const record of trusted) if (record.modelUsage && typeof record.modelUsage === 'object') models.push(...Object.keys(record.modelUsage));
  const efforts = values(['effort', 'effortLevel']);
  const auth = values(['apiKeySource']);
  const listFields = ['mcp_servers', 'mcpServers', 'plugins', 'custom_commands', 'customCommands', 'slash_commands', 'slashCommands', 'hooks'];
  const reportedLists = trusted.flatMap(record => listFields.filter(key => Object.hasOwn(record, key)).map(key => record[key]));
  const model = models[0] || null;
  const effort = efforts[0] || launch?.requestedEffort || null;
  const apiKeySource = auth[0] || null;
  const reportedPins = models.map(model => ({ provider: 'claude', model }));
  let modelsMatch = !expectedModel;
  if (expectedModel && models.length && models.every(value => typeof value === 'string')) {
    try { modelsMatch = models.every(value => sameModel(null, 'claude', expectedModel, value, reportedPins)); }
    catch { modelsMatch = false; }
  }
  const noContradictions = modelsMatch
    && efforts.every(value => value === expectedEffort) && auth.length > 0 && auth.every(value => value === 'none')
    && reportedLists.every(value => Array.isArray(value) && value.length === 0);
  const mcpIsolated = Boolean(launch?.safeMode && launch?.strictMcpConfig && launch?.noMcp)
    && Array.isArray(init?.mcp_servers) && init.mcp_servers.length === 0
    && reportedLists.every(value => Array.isArray(value) && value.length === 0);
  const customizationIsolated = Boolean(launch?.safeMode && launch?.emptySettingSources && launch?.disableSlashCommands) && reportedLists.every(value => Array.isArray(value) && value.length === 0);
  return {
    verified: Boolean(init && terminal && terminal.is_error !== true && !/error/i.test(String(terminal.subtype || ''))
      && model && effort === expectedEffort && apiKeySource === 'none' && mcpIsolated && customizationIsolated && noContradictions),
    model,
    effort,
    apiKeySource,
    mcpIsolated,
    customizationIsolated,
    usage: terminal?.usage || null
  };
};
const reportedGptRuntime = () => {
  const launchPath = `${output}.launch-runtime.json`;
  const lastMessagePath = `${output}.last-message.txt`;
  let launch = null;
  try { launch = JSON.parse(readFileSync(launchPath, 'utf8')); } catch { launch = null; }
  return verifyGptRuntime({
    launch,
    events: existsSync(eventsPath) ? parseEvents(readFileSync(eventsPath, 'utf8')) : [],
    lastMessage: existsSync(lastMessagePath) ? readFileSync(lastMessagePath, 'utf8') : '',
    expectedModel: reviewModel,
    expectedEffort: reviewEffort
  });
};
const reviewRuntime = (model, effort) => reviewEngine === 'gpt' ? reportedGptRuntime() : reportedRuntime(model, effort);
const runGptReview = async () => {
  try { commandSpec('headroom'); } catch { throw new Error('Headroom is required for every GPT review but was not found.'); }
  const effort = reviewEffort;
  const lastMessagePath = `${output}.last-message.txt`;
  const directApiKeyEnvironmentPresent = Boolean(process.env.OPENAI_API_KEY);
  // Workers never inherit credentials: every secret-shaped variable is stripped (names recorded below).
  const scrubbedGpt = scrubEnv({ ...process.env, HEADROOM_BEACON: 'off' });
  const gptEnv = scrubbedGpt.env;
  const launch = { engine: 'codex', requestedModel: reviewModel, requestedEffort: effort, promptBytes: Buffer.byteLength(input), cwd: reviewRuntimeCwd, reviewedRepository: repo,
    sandbox: 'read-only', ignoreUserConfig: true, noMcp: true, hooksDisabled: true, directApiKeyEnvironmentPresent, directApiKeyRemoved: !gptEnv.OPENAI_API_KEY, environmentStripped: scrubbedGpt.stripped };
  writeFileSync(`${output}.launch-runtime.json`, `${JSON.stringify(launch, null, 2)}\n`, 'utf8');
  mkdirSync(reviewRuntimeCwd, { recursive: true });
  const runResult = await run('headroom', gptReviewArgs({ model: reviewModel, effort, repo, lastMessagePath, role: reviewKey }), gptEnv, false, reviewRuntimeCwd);
  const events = existsSync(eventsPath) ? parseEvents(readFileSync(eventsPath, 'utf8')) : [];
  const lastMessage = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, 'utf8') : '';
  writeFileSync(output, synthesizeReviewStream({ model: reviewModel, effort, lastMessage, events, launch }), 'utf8');
  cachedReviewRecords = null;
  // run() hashed the review output before it existed; bind the receipt to the synthesized transcript.
  if (existsSync(monitorPath)) {
    const monitor = JSON.parse(readFileSync(monitorPath, 'utf8'));
    monitor.reviewOutputSha256 = sha256(readFileSync(output));
    writeFileSync(monitorPath, `${JSON.stringify(monitor, null, 2)}\n`, 'utf8');
  }
  return runResult;
};
const runClaudeReview = (model, effort, maxTurns = 100) => {
  try { commandSpec('headroom'); } catch { throw new Error('Headroom is required for Claude reviews but was not found.'); }
  const versionResult = spawnSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  const versionText = `${versionResult.stdout || ''}\n${versionResult.stderr || ''}`;
  const version = versionText.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!version || version[0] < 2 || (version[0] === 2 && (version[1] < 1 || (version[1] === 1 && version[2] < 170)))) {
    throw new Error(`Claude Code 2.1.170 or newer is required for this review route; detected: ${versionText.trim() || 'unavailable'}.`);
  }
  // `--bare` suppresses OAuth/keychain reads, so it cannot use the permitted
  // Claude subscription route. `--safe-mode` disables the same project/user
  // customizations while retaining subscription authentication; strict MCP
  // configuration keeps the runtime MCP-free.
  // Claude Code 2.1.257 rejects stream-json under --print unless --verbose is
  // present. Streaming records also avoid a Headroom/Windows single-result
  // hand-off dropping the model's final review payload after a successful 200.
  const claudeArgs = ['--safe-mode', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--tools', 'Read,Glob,Grep,Bash,PowerShell', '--add-dir', repo, '--print', '--model', model, '--effort', effort, '--max-turns', String(maxTurns), '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'dontAsk'];
  const directApiKeyEnvironmentPresent = Boolean(process.env.ANTHROPIC_API_KEY);
  const scrubbedClaude = scrubEnv({ ...process.env, HEADROOM_BEACON: 'off' });
  const subscriptionEnv = scrubbedClaude.env;
  writeFileSync(`${output}.launch-runtime.json`, `${JSON.stringify({
    requestedModel: model,
    requestedEffort: effort,
    environmentStripped: scrubbedClaude.stripped,
    promptBytes: Buffer.byteLength(input),
    cwd: reviewRuntimeCwd,
    reviewedRepository: repo,
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'PowerShell'],
    directApiKeyEnvironmentPresent,
    wrappedApiKeyEnvironmentPresent: Boolean(subscriptionEnv.ANTHROPIC_API_KEY),
    safeMode: true,
    strictMcpConfig: true,
    noMcp: true,
    emptySettingSources: true,
    disableSlashCommands: true
  }, null, 2)}\n`, 'utf8');
  // Headroom writes local settings in cwd even when Claude is in safe mode.
  // Keep those per-lane files outside the source instead of ignoring source drift.
  mkdirSync(reviewRuntimeCwd, { recursive: true });
  return run('headroom', ['wrap', 'claude', '--no-mcp', '--code-memory', 'none', '--', ...claudeArgs], subscriptionEnv, true, reviewRuntimeCwd);
};
outOfRootGuardStart = beginOutOfRootGuard();
if (outOfRootGuardStart) {
  writeFileSync(monitorPath, `${JSON.stringify({ role: a.role, output, launcherPid: process.pid, startedAt: telemetryIso(telemetryLaneStartedAtMs), terminal: false, phase: 'starting', outOfRootGuard: outOfRootGuardStart }, null, 2)}\n`, 'utf8');
  if (outOfRootGuardStart.discoveryErrors.length || outOfRootGuardStart.snapshots.some(item => !item.observed)) {
    throw new Error('OUT_OF_ROOT_OBSERVATION_FAILED: could not establish every discovered root baseline; model was not launched.');
  }
}
let result;
let reviewerEngine = null;
let reviewerFallbackFrom = null;
let revalidatedFailedClosure = false;
let originalReviewReservation;
if (revalidateExisting) {
  if (!existsSync(output) || !existsSync(monitorPath)) {
    throw new Error('REVIEW_REVALIDATION_REJECTED: existing output and monitor are required.');
  }
  const existingMonitor = JSON.parse(readFileSync(monitorPath, 'utf8'));
  if (typeof existingMonitor.selectedReviewerEngine !== 'string' || !existingMonitor.selectedReviewerEngine.trim()) {
    throw new Error('REVIEW_REVALIDATION_REJECTED: existingMonitor.selectedReviewerEngine is required.');
  }
  if (existingMonitor.reviewOutputSha256 !== sha256(readFileSync(output))) {
    throw new Error('REVIEW_REVALIDATION_REJECTED: the original reviewer transcript hash is missing or changed.');
  }
  const recheckClosure = existingMonitor.modelExitCode === 0 && existingMonitor.runtime?.verified === true
    && ((typeof existingMonitor.reviewClosureError === 'string' && existingMonitor.reviewClosureError.length > 0)
      || (typeof existingMonitor.failure === 'string' && existingMonitor.failure.endsWith('review promotion decision rejected: missing, duplicated, or malformed ROUND_SUMMARY counts')));
  const recoverPendingReceipt = pendingReceiptRecovery && reviewRuntime(reviewModel, reviewEffort).verified;
  if (existingMonitor.role !== a.role || resolve(existingMonitor.output || '') !== output
      || (existingMonitor.exitCode !== 0 && !recheckClosure && !recoverPendingReceipt) || existingMonitor.timedOut !== false || existingMonitor.stderrBytes !== 0) {
    throw new Error('REVIEW_REVALIDATION_REJECTED: the existing monitor must match this role/output and prove exitCode 0, no timeout, and zero stderr bytes.');
  }
  if (!isLocalPrecommitReconciliation && (!reviewIdentity || !existingMonitor.reviewIdentity
      || JSON.stringify(existingMonitor.reviewIdentity) !== JSON.stringify(reviewIdentity)
      || !existsSync(machineReviewContextPath)
      || sha256(readFileSync(machineReviewContextPath)) !== reviewIdentity.contextSha256)) {
    throw new Error('REVIEW_REVALIDATION_REJECTED: existing evidence is not bound to this exact prompt, generated context, and candidate file bytes. Preserve the old receipt and launch a new review.');
  }
  originalReviewReservation = typeof existingMonitor.reviewReservation === 'string' && existingMonitor.reviewReservation.trim()
    ? existingMonitor.reviewReservation : undefined;
  reviewerEngine = existingMonitor.selectedReviewerEngine;
  result = requireCompleteReview({ status: 0, timedOut: false, tail: '' }, a.role);
  revalidatedFailedClosure = recheckClosure && existingMonitor.exitCode !== 0 && existingMonitor.terminal === true;
} else if (reviewEngine === 'gpt') {
  reviewerEngine = reviewEngineLabel;
  result = requireCompleteReview(await runGptReview(), a.role);
} else if (a.role === 'reviewer-plan') {
  reviewerEngine = reviewEngineLabel;
  result = requireCompleteReview(await runClaudeReview(reviewModel, reviewEffort, 40), a.role);
} else if (a.role === 'reviewer') {
  reviewerEngine = reviewEngineLabel;
  result = requireCompleteReview(await runClaudeReview(reviewModel, reviewEffort, 100), a.role);
} else if (a.role === closureReviewRole) {
  reviewerEngine = reviewEngineLabel;
  result = requireCompleteReview(await runClaudeReview(reviewModel, reviewEffort), a.role);
} else {
  const { model, effort: reasoningEffort } = writer;
  telemetry.requestedReasoningEffort = reasoningEffort;
  // Use a fresh, per-lane Headroom proxy for every Codex writer invocation.
  // Headroom's own MCP and code-memory are deliberately excluded: the scope-locked
  // writer retains Codex's built-in tools while global MCP/config state cannot alter
  // a reproducible executor run.
  const scrubbedExecutor = scrubEnv({ ...process.env, HEADROOM_BEACON: 'off' });
  telemetry.environmentStripped = scrubbedExecutor.stripped;
  const executorEnv = scrubbedExecutor.env;
  result = await run('headroom', ['wrap', 'codex', '--no-mcp', '--code-memory', 'none', '--', 'exec', '--ignore-user-config', '--dangerously-bypass-approvals-and-sandbox', '--disable', 'hooks', '--ephemeral', '--json', '--skip-git-repo-check', '--model', model, '-c', `model_reasoning_effort="${reasoningEffort}"`, '-C', repo, '--output-last-message', output, '-'], executorEnv);
}
if (!existsSync(output) && existsSync(eventsPath)) copyFileSync(eventsPath, output);
const expectedReviewModel = (isClaudeReview || a.role === closureReviewRole) ? reviewModel : null;
if ((a.role === 'reviewer-plan' || isCodeReviewer) && result.status === 0) {
  const runtime = reviewRuntime(expectedReviewModel, reviewEffort);
  if (!runtime.verified) result = { ...result, status: 1, tail: `${result.tail}\nreview runtime/model/authentication isolation is unverified or contradictory` };
}
const appendGateHeartbeat = terminal => writeFileSync(heartbeatPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, role: a.role, phase: 'verification', terminal })}\n`, { encoding: 'utf8', flag: 'a' });
const runRequiredExecutorGates = async () => {
  const records = [];
  const uniqueSpecs = executorGateSpecs.filter((spec, index, all) => all.findIndex(other => other.command === spec.command) === index);
  for (const spec of uniqueSpecs) {
    const startedAt = Date.now();
    const monitor = existsSync(monitorPath) ? JSON.parse(readFileSync(monitorPath, 'utf8')) : {};
    writeFileSync(monitorPath, `${JSON.stringify({ ...monitor, terminal: false, phase: 'verification', currentGate: spec.command, exitCode: null }, null, 2)}\n`, 'utf8');
    appendGateHeartbeat(false);
    const command = commandSpec(spec.executable);
    const child = spawn(command.executable, [...command.prefix, ...spec.args], { cwd: repo, env: scrubEnv(process.env).env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let spawnError = null; let timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => { spawnError = error; });
    const heartbeat = setInterval(() => appendGateHeartbeat(false), 15000);
    const deadline = setTimeout(() => { timedOut = true; terminateTree(child); }, 30 * 60000);
    const { code, signal } = await new Promise(resolveGate => child.on('close', (code, signal) => resolveGate({ code, signal })));
    clearInterval(heartbeat); clearTimeout(deadline);
    const record = { command: spec.command, elapsedMs: Date.now() - startedAt, status: code, signal, timedOut, error: spawnError?.message || null, stdout, stderr };
    records.push(record);
    if (code !== 0 || spawnError || timedOut) {
      writeFileSync(`${output}.post-gates.json`, `${JSON.stringify({ status: 'failed', records }, null, 2)}\n`, 'utf8');
      return record;
    }
  }
  writeFileSync(`${output}.post-gates.json`, `${JSON.stringify({ status: 'passed', records }, null, 2)}\n`, 'utf8');
  return null;
};
if (isStandardExecutor && result.status === 0) {
  const gateFailure = await runRequiredExecutorGates();
  if (gateFailure) result = { ...result, status: 1, tail: `${result.tail}\nMACHINE_REQUIRED_GATE_FAILED: ${gateFailure.command}` };
}
if (isCubicExecutor && result.status === 0) {
  const finalText = existsSync(output) ? readFileSync(output, 'utf8') : '';
  if (!finalText.includes('CUBIC_REMEDIATION_RESULT:') || !finalText.includes('CROSS_IMPACT_CHECK:') || !finalText.includes('CALLER_CLOSURE_RESULT:')) {
    throw new Error('executor-cubic completed without the required remediation, cross-impact, and caller-closure results; do not advance or push this correction batch.');
  }
  const missingIds = cubicAcceptedIds.filter(id => !new RegExp(`\\b${id}\\b`).test(finalText));
  if (missingIds.length) {
    throw new Error(`executor-cubic completion omitted approved finding IDs: ${missingIds.join(', ')}. Do not advance or push this correction batch.`);
  }
  const missingCallerClosureIds = cubicAcceptedIds.filter(id => !new RegExp(`CALLERS:[^\\r\\n]*\\b${id}\\b|\\b${id}\\b[^\\r\\n]*CALLERS:`, 'i').test(finalText));
  if (missingCallerClosureIds.length) {
    throw new Error(`executor-cubic caller-closure result omitted approved finding IDs: ${missingCallerClosureIds.join(', ')}. Do not advance or push this correction batch.`);
  }
  if (git(['rev-parse', 'HEAD']).trim() !== executorInitialHead) {
    throw new Error('executor-cubic changed HEAD during execution. Do not advance or push this correction batch.');
  }
  const unauthorizedPaths = changedProductPaths(executorInitialHead).filter(path => !cubicOwnedPaths.some(approved => ownedPathMatches(path, approved)));
  if (unauthorizedPaths.length) {
    throw new Error(`executor-cubic changed paths outside CUBIC_APPROVED_OWNED_PATHS_JSON: ${unauthorizedPaths.join(', ')}. Do not advance or push this correction batch.`);
  }
}
if (isStandardExecutor && (result.status === 0 || result.status == null)) {
  const finalText = existsSync(output) ? readFileSync(output, 'utf8') : '';
  if (isFastPathExecutorContract
    ? !finalText.includes('FASTPATH_REMEDIATION_RESULT:') || !finalText.includes('FOCUSED_PROOF:') || !finalText.includes('SCOPE_CONFIRMATION:')
    : !finalText.includes('EXECUTOR_REMEDIATION_RESULT:') || !finalText.includes('CROSS_IMPACT_CHECK:') || !finalText.includes('CALLER_CLOSURE_RESULT:')) {
    throw new Error(isFastPathExecutorContract
      ? 'fast-path executor lane completed without remediation, focused proof, and scope confirmation; do not advance or push this batch.'
      : 'executor lane completed without remediation, cross-impact, and caller-closure results; do not advance or push this batch.');
  }
  const missingIds = standardTaskIds.filter(id => !new RegExp(`\\b${id}\\b`).test(finalText));
  if (missingIds.length) {
    throw new Error(`executor lane completion omitted approved task IDs: ${missingIds.join(', ')}. Do not advance or push this batch.`);
  }
  if (!isFastPathExecutorContract) {
    const omittedBehaviors = standardProtectedBehaviors.filter(behavior => !new RegExp(`\\b${behavior.id}\\b`).test(finalText));
    if (omittedBehaviors.length) {
      throw new Error(`executor lane completion omitted protected behavior IDs: ${omittedBehaviors.map(behavior => behavior.id).join(', ')}. Do not advance or push this batch.`);
    }
  }
  verifyProtectedBehaviorEvidence(standardProtectedBehaviors, 'executor lane');
  if (git(['rev-parse', 'HEAD']).trim() !== executorInitialHead) {
    throw new Error('executor lane changed HEAD during execution. Do not advance or push this batch.');
  }
  const verifiedPreservedPaths = new Set();
  if (correctionMode === 'DELTA') {
    const driftedBaselineFiles = baselinePreservedPaths.filter(path => {
      if (deltaInPlace) {
        const before = preservedBaselineSnapshot.get(path);
        const candidatePath = join(repo, path);
        return before === undefined || (before === null ? existsSync(candidatePath) : !existsSync(candidatePath) || !before.equals(readFileSync(candidatePath)));
      }
      const baselinePath = join(baselineWorktree, path);
      const candidatePath = join(repo, path);
      return !existsSync(baselinePath) || !existsSync(candidatePath)
        || !readFileSync(baselinePath).equals(readFileSync(candidatePath));
    });
    if (driftedBaselineFiles.length) {
      throw new Error(`DELTA correction changed immutable preserved baseline files: ${driftedBaselineFiles.join(', ')}. Do not advance or push this batch.`);
    }
    for (const path of baselinePreservedPaths) verifiedPreservedPaths.add(path);
  }
  const unauthorizedPaths = changedProductPaths(executorInitialHead).filter(path =>
    !verifiedPreservedPaths.has(path) && !standardOwnedPaths.some(approved => ownedPathMatches(path, approved)));
  if (unauthorizedPaths.length) {
    throw new Error(`executor lane changed paths outside EXECUTOR_APPROVED_OWNED_PATHS_JSON: ${unauthorizedPaths.join(', ')}. Do not advance or push this batch.`);
  }
  if (isFastPathExecutorContract) {
    const untrackedPaths = git(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
    if (untrackedPaths.length || changedProductLineCount(executorInitialHead) > fastPathMaxChangedLines) {
      throw new Error(`fast-path executor lane exceeded its ${fastPathMaxChangedLines}-line tracked-diff limit or created untracked product files. Do not advance or push this batch.`);
    }
  }
}
const verifyTerminalPrecommitSnapshot = () => {
  if (!isLocalPrecommitReconciliation || (revalidateExisting && !pendingReceiptRecovery)) return;
  const head = git(['rev-parse', 'HEAD']).trim();
  if (head !== cubicSourceSha) throw new Error('PRECOMMIT_REVIEW_DRIFT: candidate HEAD changed during review.');
  const changed = [...new Set(changedProductPaths(cubicSourceSha))].sort();
  if (JSON.stringify(changed) !== JSON.stringify(machineReviewContext.reviewedChangedPaths))
    throw new Error('PRECOMMIT_REVIEW_DRIFT: candidate changed-path coverage changed during review.');
  for (const expected of machineReviewContext.candidateSnapshot) {
    const actual = worktreeRecord(repo, cubicSourceSha, expected.path);
    if (!sameWorktreeRecord(expected, actual)) throw new Error(`PRECOMMIT_REVIEW_DRIFT: candidate content or mode changed for ${expected.path}.`);
  }
  const baselinePaths = [...new Set(changedProductPathsAt(reviewBaselineWorktree, cubicSourceSha))].sort();
  loadPredecessorManifest(baselinePaths);
  const stored = readFileSync(machineReviewContextPath, 'utf8');
  if (stored !== `${JSON.stringify(machineReviewContext, null, 2)}\n`)
    throw new Error('PRECOMMIT_REVIEW_DRIFT: immutable review context changed during review.');
};
let terminalPrecommitError = null;
if (isCodeReviewer && result.status === 0) {
  try { verifyTerminalPrecommitSnapshot(); }
  catch (error) {
    terminalPrecommitError = error instanceof Error ? error.message : String(error);
    result = { ...result, status: 1, tail: `${result.tail}\n${terminalPrecommitError}` };
  }
}
let reviewClosureError = null;
let regressedReviewEvidence = false;
if ((a.role === 'reviewer' || a.role === closureReviewRole) && result.status === 0) {
  try {
    if (git(['rev-parse', 'HEAD']).trim() !== reviewStartHead
        || git(['status', '--porcelain', '--untracked-files=all']) !== reviewStartStatus
        || (reviewIdentity && JSON.stringify(reviewCandidateFiles()) !== JSON.stringify(reviewIdentity.candidateBlobs))
        || sha256(readFileSync(prompt)) !== sha256(rawInput)
        || sha256(readFileSync(machineReviewContextPath)) !== sha256(reviewContextBytes)) {
      throw new Error('REVIEW_ARTIFACT_DRIFT: source, packet, or immutable context changed during review.');
    }
    verifyProtectedBehaviorEvidence(reviewProtectedBehaviors, 'review lane');
    const finalText = reviewerFinalText();
    const dispositionFor = (id, tokens = 'VERIFIED|REGRESSED|INCOMPLETE', section = finalText) => {
      const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const normalized = section.replace(new RegExp(`^([\\t ]*-[\\t ]*${escapedId})[\\t \\u00a0\\u2013\\u2014-]+(?=\\S)`, 'gm'), '$1 ');
      return normalized.match(new RegExp(`^[\\t ]*-[\\t ]*${escapedId} (${tokens})(?=[\\t ]|$)`, 'm'))?.[1] || null;
    };
    const omittedBehaviors = reviewProtectedBehaviors.filter(behavior => !new RegExp(`\\b${behavior.id}\\b`).test(finalText));
    if (omittedBehaviors.length) {
      throw new Error(`review lane disposition omitted protected behavior IDs: ${omittedBehaviors.map(behavior => behavior.id).join(', ')}. Review is incomplete.`);
    }
    const failedBehaviors = reviewProtectedBehaviors.filter(behavior => !['VERIFIED', 'REGRESSED'].includes(dispositionFor(behavior.id)));
    regressedReviewEvidence = reviewProtectedBehaviors.some(behavior => dispositionFor(behavior.id) === 'REGRESSED');
    if (failedBehaviors.length) throw new Error(`review lane has incomplete or regressed protected behavior dispositions: ${failedBehaviors.map(behavior => behavior.id).join(', ')}. Review is incomplete.`);
    const omittedKnownFindings = reviewKnownFindingIds.filter(id => !new RegExp(`\\b${id}\\b`).test(finalText));
    const machineCoveredKnownFindings = omittedKnownFindings.filter(id => {
      const coverage = reviewKnownFindingCoverage?.[id];
      return coverage && coverage.protectedBehaviorIds.every(behaviorId => new RegExp(`\\b${behaviorId}\\b`).test(finalText));
    });
    const unprovenKnownFindings = omittedKnownFindings.filter(id => !machineCoveredKnownFindings.includes(id));
    if (unprovenKnownFindings.length) {
      throw new Error(`review lane omitted known finding IDs without machine-linked protected-behavior coverage: ${unprovenKnownFindings.join(', ')}. Review is incomplete.`);
    }
    const correctionDeltaPaths = machineReviewContext?.correctionDeltaPaths || [];
    const declaresWholeDelta = correctionDeltaPaths.length > 0
      && new RegExp(`CORRECTION_DELTA_DISPOSITION:[\\s\\S]{0,400}\\ball\\s+${correctionDeltaPaths.length}\\s+paths\\s+reviewed\\b`, 'i').test(finalText);
    // Review packets already machine-validate the exact changed-path manifest.
    // A reviewer may disposition that complete manifest by exact cardinality
    // rather than mechanically repeating every path; accept only that explicit
    // whole-delta statement, otherwise retain the literal-path requirement.
    const dispositionSection = finalText.match(/CORRECTION_DELTA_DISPOSITION:([\s\S]*?)(?:\n[A-Z_]+:|$)/i)?.[1] || '';
    // A reconciliation may also enumerate preserved feature paths. Only those
    // machine-validated paths outside the exact correction delta may be marked
    // OUTSIDE_DELTA; it must never excuse a required path or an unknown row.
    const invalidOutsideDelta = dispositionSection.split(/\r?\n/).filter(line => /\bOUTSIDE_DELTA\b/i.test(line))
      .some(line => !reviewChangedPaths.some(path => !correctionDeltaPaths.includes(path)
        && dispositionFor(path, 'OUTSIDE_DELTA', line)));
    if (/\bINCOMPLETE\b/i.test(dispositionSection) || invalidOutsideDelta) throw new Error('review lane explicitly marked correction-delta evidence incomplete. Review is incomplete.');
    regressedReviewEvidence ||= /\bREGRESSED\b/i.test(dispositionSection);
    const omittedDeltaPaths = declaresWholeDelta ? [] : correctionDeltaPaths.filter(path =>
      !dispositionFor(path, 'REVIEWED|REGRESSED', dispositionSection));
    if (omittedDeltaPaths.length) {
      throw new Error(`review lane omitted correction-delta paths: ${omittedDeltaPaths.join(', ')}. Review is incomplete.`);
    }
  } catch (error) {
    reviewClosureError = error instanceof Error ? error.message : String(error);
    result = { ...result, status: 1, tail: `${result.tail}\n${reviewClosureError}` };
  }
}
const reviewPromotionDecision = finalText => {
  const decisions = [...finalText.matchAll(/^REVIEW_DECISION:\s*(\S+)\s*$/gmi)].map(match => match[1]);
  const summaries = [...finalText.matchAll(/^\s*-?\s*HIGH:\s*(\d+)\s*;\s*MEDIUM:\s*(\d+)\s*;\s*LOW:\s*(\d+)[ \t]*(?:\((?![^()\r\n]*\b(?:HIGH|MEDIUM|LOW|OUT_OF_SCOPE_RISK)\s*:)[^()\r\n]{1,512}\)[ \t]*)?;\s*OUT_OF_SCOPE_RISK:\s*(\d+)\s*$/gmi)];
  if (decisions.length !== 1 || !['CLEAN', 'FINDINGS'].includes(decisions[0])) return { promotable: false, invalid: 'unknown or duplicated REVIEW_DECISION' };
  if (summaries.length !== 1) return { promotable: false, invalid: 'missing, duplicated, or malformed ROUND_SUMMARY counts' };
  const high = Number(summaries[0][1]); const medium = Number(summaries[0][2]);
  const material = finalText.match(/MATERIAL_FINDINGS:([\s\S]*?)(?:\nNON_FINDINGS:|$)/i)?.[1] || '';
  const classifiedMaterial = /(?:\[|severity:\s*)(?:HIGH|MEDIUM)\b/i.test(material);
  if (classifiedMaterial && high === 0 && medium === 0) return { promotable: false, invalid: 'material HIGH/MEDIUM conflicts with zero ROUND_SUMMARY counts' };
  return { promotable: high === 0 && medium === 0 && !classifiedMaterial, invalid: null };
};
const writePromotionLock = record => {
  if (!runRoot || !promotionLockOwner || !promotionLockPath) throw new Error('PROMOTION_LOCK_OWNER_UNAVAILABLE: a repository-scoped promotion lock requires a run-root output and resolvable repository/worktree identity.');
  const existing = resolvePromotionLockForOwner(runRoot, promotionLockOwner);
  if (existing) throw new Error(`PROMOTION_LOCK_EXISTS: refusing to overwrite ${existing.path}.`);
  writeFileSync(promotionLockPath, `${JSON.stringify({ ...record, owner: promotionLockOwner }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
};
if (isCodeReviewer && result.status === 0 && promotionLockPath) {
  const finalText = reviewerFinalText();
  const promotionDecision = reviewPromotionDecision(finalText);
  if (promotionDecision.promotable && regressedReviewEvidence) promotionDecision.invalid = 'regressed evidence conflicts with a promotable decision';
  if (promotionDecision.invalid) {
    reviewClosureError = `review promotion decision rejected: ${promotionDecision.invalid}`;
    result = { ...result, status: 1, tail: `${result.tail}\n${reviewClosureError}` };
  } else if (promotionDecision.promotable) {
    const head = git(['rev-parse', 'HEAD']).trim();
    if (!isLocalPrecommitReview && head !== cubicSourceSha) throw new Error(`PROMOTION_LOCK_REFUSED: reviewer packet SHA ${cubicSourceSha} differs from reviewed HEAD ${head}.`);
    if (isLocalPrecommitReview) {
      if (isLocalPrecommitReconciliation) {
        const pendingPath = `${output}.pending-commit.json`;
        const pendingRecord = {
          schema: 2,
          reviewOutput: output,
          reviewBaseSha: cubicSourceSha,
          reviewedChangedPaths: machineReviewContext.reviewedChangedPaths,
          contextSha256: machineReviewContext.contextSha256,
          rawPacketSha256: machineReviewContext.rawPacketSha256,
          candidateGitIdentities: machineReviewContext.candidateSnapshot.map(({ path, state, mode, blobOid }) => ({ path, state, mode, blobOid })),
          createdAt: new Date().toISOString()
        };
        if (!revalidateExisting || pendingReceiptRecovery) {
          if (existsSync(pendingPath)) throw new Error(`LOCAL_PRECOMMIT_PENDING_EXISTS: refusing to overwrite ${pendingPath}.`);
          writeFileSync(pendingPath, `${JSON.stringify(pendingRecord, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        } else {
          const legacyPendingPath = join(dirname(promotionLockPath), 'LOCAL_PRECOMMIT_REVIEW_PENDING_COMMIT.json');
          const existingPendingPath = existsSync(pendingPath) || !existsSync(legacyPendingPath) ? pendingPath : legacyPendingPath;
          if (!existsSync(existingPendingPath)) {
            // An older validator may have failed closure before writing pending.
            // Recovery reaches here only after original transcript/runtime/context,
            // exact committed identities, and current full closure all validate.
            if (!revalidatedFailedClosure) throw new Error('REVIEW_REVALIDATION_REJECTED: genuine pending precommit review receipt is missing.');
            writeFileSync(pendingPath, `${JSON.stringify(pendingRecord, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
          }
          const pending = JSON.parse(readFileSync(existingPendingPath, 'utf8'));
          if (pending.schema !== 2 || resolve(pending.reviewOutput || '') !== output
              || pending.reviewBaseSha !== cubicSourceSha || pending.contextSha256 !== machineReviewContext.contextSha256
              || pending.rawPacketSha256 !== machineReviewContext.rawPacketSha256
              || JSON.stringify(pending.candidateGitIdentities) !== JSON.stringify(machineReviewContext.candidateSnapshot.map(({ path, state, mode, blobOid }) => ({ path, state, mode, blobOid }))))
            throw new Error('REVIEW_REVALIDATION_REJECTED: pending receipt does not identify the exact reviewed candidate context.');
          writePromotionLock({
            schema: 2,
            frozenSourceSha: head,
            reviewedHead: head,
            reviewBaseSha: cubicSourceSha,
            localPrecommit: true,
            reviewOutput: output,
            reviewContext: machineReviewContextPath,
            reviewContextSha256: machineReviewContext.contextSha256,
            candidateGitIdentities: pending.candidateGitIdentities,
            createdAt: new Date().toISOString()
          });
        }
      } else {
      // Reconciliation reviews freeze the clean candidate itself as FROZEN_SOURCE_SHA.
      // Validate its committed manifest against the explicitly declared predecessor,
      // rather than diffing the candidate against itself.
      const committedPathBase = requiresReviewReconciliation ? reviewBaselineSha : cubicSourceSha;
      const committedPaths = [...new Set(changedProductPaths(committedPathBase))].sort();
      const absent = reviewChangedPaths.filter(path => !committedPaths.includes(path));
      const undeclared = committedPaths.filter(path => !reviewChangedPaths.includes(path));
      if (absent.length || undeclared.length || git(['status', '--porcelain', '--untracked-files=all']).trim()) {
        // A local-precommit review necessarily precedes the exact candidate
        // commit. Preserve the successful review as pending rather than
        // rejecting it for following the documented order. Revalidation after
        // the clean exact commit reaches this branch again and writes the
        // promotion lock only once the declared manifest matches.
        const pendingPath = `${output}.pending-commit.json`;
        if (existsSync(pendingPath)) {
          const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
          if (!revalidateExisting || pending.schema !== 1 || resolve(pending.reviewOutput || '') !== output
              || pending.reviewBaseSha !== cubicSourceSha
              || JSON.stringify(pending.reviewedChangedPaths) !== JSON.stringify(reviewChangedPaths))
            throw new Error(`LOCAL_PRECOMMIT_PENDING_EXISTS: refusing to overwrite ${pendingPath}.`);
          // The revalidation path already checked the original transcript and
          // exact prompt/context/candidate identity. Keep its pending receipt.
        } else {
          writeFileSync(pendingPath, `${JSON.stringify({ schema: 1, reviewOutput: output, reviewBaseSha: cubicSourceSha, reviewedChangedPaths: reviewChangedPaths, createdAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        }
      } else {
        writePromotionLock({ schema: 1, frozenSourceSha: head, reviewedHead: head, reviewBaseSha: cubicSourceSha, localPrecommit: isLocalPrecommitReview, reviewOutput: output, reviewContext: machineReviewContextPath, reviewIdentity, createdAt: new Date().toISOString() });
      }
      }
    } else {
      writePromotionLock({ schema: 1, frozenSourceSha: head, reviewedHead: head, reviewBaseSha: cubicSourceSha, localPrecommit: isLocalPrecommitReview, reviewOutput: output, reviewContext: machineReviewContextPath, reviewIdentity, createdAt: new Date().toISOString() });
    }
  }
}
if (reviewerEngine && existsSync(monitorPath)) {
  const monitor = JSON.parse(readFileSync(monitorPath, 'utf8'));
  monitor.selectedReviewerEngine = reviewerEngine;
  monitor.runtime = reviewRuntime(expectedReviewModel, reviewEffort);
  monitor.authentication = monitor.runtime.apiKeySource === 'none' ? 'claude-subscription' : 'unverified';
  if (machineReviewContext?.knownFindingCoverage) monitor.knownFindingCoverage = machineReviewContext.knownFindingCoverage;
  if (machineReviewContext?.contextSha256) monitor.reviewContextSha256 = machineReviewContext.contextSha256;
  if (terminalPrecommitError) monitor.precommitSnapshotError = terminalPrecommitError;
  if (reviewClosureError) monitor.reviewClosureError = reviewClosureError;
  else if (revalidateExisting) delete monitor.reviewClosureError;
  if (reviewerFallbackFrom) monitor.reviewerFallbackFrom = reviewerFallbackFrom;
  if (revalidateExisting) {
    monitor.revalidatedExisting = true;
    monitor.revalidatedAt = new Date().toISOString();
  }
  writeFileSync(monitorPath, `${JSON.stringify(monitor, null, 2)}\n`, 'utf8');
}
if (a.role === 'reviewer-plan' && result.status === 0) {
  writeFileSync(fableInitialPlanReceipt, `${JSON.stringify({
    role: a.role,
    prompt,
    output,
    completedAt: new Date().toISOString(),
    selectedReviewerEngine: reviewerEngine
  }, null, 2)}\n`, 'utf8');
}
const receiptReservation = isCodeReviewer && result.status === 0 && codeReviewReceipt
  ? (reviewLaunchReserved ? reviewReservation
    : originalReviewReservation && reviewLaunchState.readState(externalStateRepo, reviewRun)?.closureObligations
      ?.find(o => !o.refunded && o.output === output && o.reservation === originalReviewReservation)?.reservation)
  : undefined;
const previousReceipt = isCodeReviewer && result.status === 0 && codeReviewReceipt && revalidateExisting && existsSync(codeReviewReceipt)
  ? readFileSync(codeReviewReceipt, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .findLast(entry => entry.status === 'completed' && resolve(entry.output || '') === output)
  : null;
if (isCodeReviewer && result.status === 0 && codeReviewReceipt && receiptReservation !== undefined && (!previousReceipt || previousReceipt.reservation !== receiptReservation)) {
  const receipt = {
    status: 'completed',
    ...(receiptReservation ? { reservation: receiptReservation } : {}),
    role: a.role,
    completedAt: new Date().toISOString(),
    output,
    monitorPath,
    selectedReviewerEngine: reviewerEngine,
    kind: 'invoke-lane',
    slot: reviewSlot,
    writer: { provider: reviewWriter },
    reviewer: { provider: reviewEngine === 'gpt' ? 'codex' : 'claude', model: reviewModel, effort: reviewEffort },
    fallbackReason: reviewSlot === 'fallback' ? reviewFallbackReason : null,
    ...(team ? { team: { version: team.version, sha256: team.sha256 } } : {}),
    runtime: reviewRuntime(expectedReviewModel, reviewEffort),
    reviewIdentity,
    reviewContextSha256: machineReviewContext?.contextSha256 || null,
    timeoutMinutes: timeoutMs / 60000
  };
  writeFileSync(codeReviewReceipt, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', flag: 'a' });
}
if (isCubicExecutor && existsSync(monitorPath)) {
  const monitor = JSON.parse(readFileSync(monitorPath, 'utf8'));
  monitor.cubicCorrectionPacket = true;
  monitor.cubicSourceSha = cubicSourceSha;
  monitor.requiredResult = 'CUBIC_REMEDIATION_RESULT + CROSS_IMPACT_CHECK';
  writeFileSync(monitorPath, `${JSON.stringify(monitor, null, 2)}\n`, 'utf8');
}
const terminalMonitor = finalizeMonitor(result.status === 0 ? 0 : result.status || 1, result.status === 0 ? 'completed' : 'failed', result.status === 0 ? null : result.tail);
if ((terminalMonitor && terminalMonitor.exitCode !== 0) || result.status !== 0) process.exit(terminalMonitor?.exitCode || result.status || 1);
