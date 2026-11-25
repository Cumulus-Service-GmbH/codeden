#!/usr/bin/env node
// TrioHarness Lean — run-state checkpoints so any new session can resume exactly where a run stopped.
// Usage:
//   node run-state.mjs set  --repo . --run <run-id> --gate <gate> --status in_progress|passed|failed|blocked [--next "<next action>"] [--note "<note>"] [--task "<task>"]
//   node run-state.mjs attempt --repo . --run <run-id> --gate plan [--reset [--recover --reason <reason>]]   — manual reservation, consecutive reset, or abandon lost tracked outcomes
//   node run-state.mjs dispatch --repo . --run <run-id> --role writer|plan-reviewer|code-reviewer|browser-tester
//   node run-state.mjs worktree --repo . --run <run-id> --path <worktree> [--branch <b>] [--role writer|reviewer|scratch|slice]   — register every worktree the run creates
//   node run-state.mjs worktree --release --repo . --run <run-id> --path <worktree> --card <Q-n>   — release an absent, unlisted registration with an answered card
//   node run-state.mjs dispatch ... --worker <id> [--deadline-min 30] [--review-reservation <id>]   — also records the worker with a deadline; `worker-done --run <id> --worker <id> --status done|failed|stopped [--report <path>]` closes it
//   node run-state.mjs worker-done --repo . --run <id> --review-reservation <id> --status done|failed|stopped [--report <path>] — done requires report bytes
//   node run-state.mjs stalled --repo . [--minutes 20]   — runs with open work, nothing running and no sign of life (exit 2 if any): a worker that was stopped or is past its deadline counts as FAILED, take over
//   node run-state.mjs audit --repo . [--run <run-id>]   — flag missing checkpoints and inconsistent bookkeeping
//   (long commands: jobs.mjs run|start|wait|check — never leave a background job running at turn end)
//   (blocking questions: questions.mjs ask — an open card refuses every gate advance, dispatch and finish until the user answers it)
//   node run-state.mjs show --repo . [--run <run-id>]        (default: most recently updated run)
//   node run-state.mjs scope|defer --repo . --run <id> --file <record.json>
//   node run-state.mjs item|handoff add|set --repo . --run <id> --file <record.json>
//   node run-state.mjs status --repo . --run <id>   — read-only owner/obligation table
// State lives in <repo>/.trioharness-direct/runs/<run-id>/state.json (untracked run ledger directory).
import { closeSync, constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Gate paths from subdirectories: without --repo, the run ledger belongs to the worktree ROOT, never the cwd.
const worktreeRoot = d => { try { const t = execFileSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return t ? resolve(t) : resolve(d); } catch { return resolve(d); } };
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { auditDiffPaths, auditCheckDigest, auditCheckPass, validateAuditCheck } from './guard.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isIdle, mainCheckout } from './reclaim.mjs';
import { normPath, realOr } from './ownership.mjs';
import { openJobsReason, readJobs } from './jobs.mjs';
import { openQuestionsReason, deferredSets, readSets } from './questions.mjs';
import { learningsReason } from './knowledge.mjs';
import { runningRefReason } from './running-ref.mjs';
import { cleanStateReason } from './clean-state.mjs';
import { validRunId } from './ids.mjs';
import { findException } from './exception-store.mjs';
import { isMain } from './is-main.mjs';
import { saveBoundary, validRegisteredState, registrationsForTree } from './boundary.mjs';
import { lockNameFor, tryAcquire, release as releaseTreeLock } from './run-lock.mjs';

export const GATES = ['shape', 'base', 'route', 'task-card', 'plan-review', 'plan-jev', 'build', 'guard-proof', 'review', 'low-fold', 'done-jev', 'commit-push', 'deploy-qa', 'browser-test', 'closeout', 'learnings'];
// Legacy gate lists remain unchanged. Only a declared, still-clean audit substitutes
// its contract check; invalidated audits need normal gates and cannot finish.
export function requiredGates(state, purpose = 'resume') {
  const gates = purpose === 'audit' ? ['base', 'route', 'task-card', 'guard-proof', 'done-jev'] : purpose === 'product' ? [...PRODUCT_GATES] : [...GATES];
  if (state?.mode !== 'audit' || state.auditInvalidated) return gates;
  if (purpose === 'audit') gates.splice(3, 0, 'plan-jev');
  return gates.map(g => g === 'plan-jev' ? 'audit-check' : g);
}
const auditGit = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const auditHash = bytes => createHash('sha256').update(bytes).digest('hex');
const modeFile = (repo, run) => join(reviewStateDirectory(repo, run), 'run-mode.json');
function auditDeclaration(repo, run, state) {
  const file = modeFile(repo, run);
  if (!existsSync(file)) {
    if (state?.mode !== undefined || state?.auditConfig !== undefined) throw new Error('MODE_IMMUTABLE: missing audit declaration');
    return null;
  }
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('MODE_IMMUTABLE');
  const declaration = JSON.parse(readFileSync(file, 'utf8'));
  if (declaration.run !== run || declaration.mode !== 'audit' || state?.mode !== 'audit' ||
      JSON.stringify(state.auditConfig) !== JSON.stringify(declaration)) throw new Error('MODE_IMMUTABLE: declaration differs from state');
  return declaration;
}
function auditCandidate(repo, run, state) {
  const config = state.auditConfig;
  if (!/^[a-f0-9]{40,64}$/.test(config?.base || '')) throw new Error('AUDIT_BASE_REQUIRED');
  const common = realpathSync(auditGit(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const main = auditGit(repo, 'worktree', 'list', '--porcelain', '-z').split('\0').find(x => x.startsWith('worktree '))?.slice(9);
  if (!main) throw new Error('AUDIT_REPOSITORY: main checkout unavailable');
  const paths = [...new Set([resolve(repo), resolve(main), ...(state.worktrees || []).map(w => resolve(w.path))])].sort();
  const trees = paths.map(path => {
    if (realpathSync(auditGit(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== common) throw new Error('AUDIT_REPOSITORY: registered tree belongs to another repository');
    const diff = auditDiffPaths(path, config.base, run);
    if (diff.length) throw new Error(`AUDIT_DIFF: ${path}: ${diff.join(', ')}; use normal gates in a new run`);
    return { path, head: auditGit(path, 'rev-parse', 'HEAD'), diffEmpty: true };
  });
  return { head: auditGit(repo, 'rev-parse', 'HEAD'), diffEmpty: true, trees };
}
function invalidateAudit(repo, run, state, error) {
  const file = join(reviewStateDirectory(repo, run), 'audit-invalidated.json');
  try { writeFileSync(file, JSON.stringify({ reason: error.message }), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  state.auditInvalidated = error.message; state.finished = false;
}
function assertAuditClean(state, repo, run) {
  if (state?.mode !== 'audit') return;
  if (state.auditInvalidated) {
    const error = new Error(state.auditInvalidated); invalidateAudit(repo, run, state, error); throw error;
  }
  try { auditCandidate(repo, run, state); } catch (e) { invalidateAudit(repo, run, state, e); throw e; }
}
export function setRunMode(repo, run, { mode, base, contract }) {
  return withStateLock(repo, run, () => {
    const existing = readState(repo, run);
    if (existsSync(modeFile(repo, run))) throw new Error('MODE_IMMUTABLE');
    if (mode !== 'audit') throw new Error('MODE_IMMUTABLE: supported declaration is audit');
    const config = { run, mode, base, contract: resolve(contract || '') };
    const state = { run, mode, auditConfig: config, task: '', gates: {}, history: [] };
    // Inspect registered trees before rejecting late selection, so dirty trees never
    // masquerade as eligible audit candidates.
    auditCandidate(repo, run, { ...state, worktrees: existing?.worktrees });
    if (existing) throw new Error('MODE_START_ONLY: declare audit before the first checkpoint');
    loadAuditInput(repo, run, state);
    writeFileSync(modeFile(repo, run), JSON.stringify(config), { flag: 'wx' });
    saveState(join(reviewStateDirectory(repo, run), 'state.json'), state);
    return state;
  });
}
function loadAuditInput(repo, run, state) {
  const path = state.auditConfig.contract;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('AUDIT_CONTRACT_INVALID');
  const bytes = readFileSync(path), contract = JSON.parse(bytes);
  if (!Array.isArray(contract.questions) || !contract.questions.length || contract.questions.some(q => !q?.ask?.trim() || !['yes', 'no'].includes(q.expect)) ||
      !Array.isArray(contract.sources) || !contract.sources.length || !textValue(contract.coverage)) throw new Error('AUDIT_CONTRACT_INVALID: questions with expect, sources and coverage required');
  const sources = contract.sources.map(path => {
    if (!planPathValid(path)) throw new Error('AUDIT_SOURCE_INVALID: use repository-relative file paths');
    const file = join(repo, path);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(realpathSync(repo) + sep)) throw new Error('AUDIT_SOURCE_INVALID');
    return { path, sha256: auditHash(readFileSync(file)) };
  });
  const input = { ...contract, mode: 'audit', audit: { run, mode: 'audit', base: state.auditConfig.base,
    contractSha256: auditHash(bytes), candidate: auditCandidate(repo, run, state), sources, coverage: contract.coverage } };
  validateAuditCheck(input);
  return input;
}
export function prepareAuditCheck(repo, run, contract) {
  const state = readState(repo, run);
  if (!state || state.mode !== 'audit') throw new Error('AUDIT_MODE_REQUIRED');
  assertActive(state, repo, run);
  if (resolve(contract) !== state.auditConfig.contract) throw new Error('AUDIT_CONTRACT_MISMATCH');
  return loadAuditInput(repo, run, state);
}
// Reserve before the network call: changed contracts, failures and resumes never
// reset the lifetime budget. The receipt path belongs to the reservation, not its caller.
export function reserveAuditCheck(repo, run, contract, logPath) {
  return withStateLock(repo, run, () => {
    const state = readState(repo, run);
    if (!state || state.mode !== 'audit') throw new Error('AUDIT_MODE_REQUIRED');
    assertActive(state, repo, run);
    const q = openQuestionsReason(repo, run); if (q) throw new Error(`QUESTIONS_OPEN: ${q}`);
    if (resolve(contract) !== state.auditConfig.contract) throw new Error('AUDIT_CONTRACT_MISMATCH');
    const input = loadAuditInput(repo, run, state);
    consumeEntry(repo, run, state, 'audit-check');
    const submission = randomUUID();
    state.auditSubmissions = [...(state.auditSubmissions || []), { submission, inputSha256: auditCheckDigest(input), logPath: resolve(logPath) }];
    state.gates['audit-check'] = { status: 'in_progress', at: new Date().toISOString() };
    state.finished = false;
    saveState(join(reviewStateDirectory(repo, run), 'state.json'), state);
    return { input, submission };
  });
}
function auditReceipt(state, outcome) {
  const reservation = (state.auditSubmissions || []).find(r => r.submission === outcome?.submission);
  if (!reservation || reservation.inputSha256 !== outcome.inputSha256) throw new Error('AUDIT_RECEIPT_MISMATCH: reserved submission required');
  let lines;
  try { lines = readFileSync(reservation.logPath, 'utf8').split('\n'); }
  catch { throw new Error('AUDIT_RECEIPT_MISSING'); }
  const { receipt, ...record } = outcome;
  const bytes = JSON.stringify(record);
  const line = receipt ? receipt.line - 1 : lines.lastIndexOf(bytes);
  if (!Number.isSafeInteger(line) || line < 0 || lines[line] !== bytes ||
      (receipt && (receipt.path !== reservation.logPath || receipt.sha256 !== auditHash(lines[line])))) throw new Error('AUDIT_RECEIPT_MISMATCH: log bytes differ');
  return { path: reservation.logPath, line: line + 1, sha256: auditHash(lines[line]) };
}
function validateAuditOutcome(repo, run, state, outcome) {
  let input;
  try { input = loadAuditInput(repo, run, state); } catch (e) { throw new Error(`AUDIT_RECEIPT_STALE: ${e.message}`); }
  if (outcome?.gate !== 'check' || outcome.mode !== 'audit' || outcome.dryRun || !outcome.jev?.model ||
      JSON.stringify(outcome.audit) !== JSON.stringify(input.audit) || outcome.inputSha256 !== auditCheckDigest(input)) throw new Error('AUDIT_RECEIPT_MISMATCH');
  const answers = outcome.jev.answers;
  if (input.questions.some((_, n) => answers?.[`q_${n}`]?.type !== 'noul' || !Number.isFinite(answers[`q_${n}`].noul) || answers[`q_${n}`].noul < 0 || answers[`q_${n}`].noul > 1)) throw new Error('AUDIT_RECEIPT_INVALID');
  auditReceipt(state, outcome);
  const pass = auditCheckPass(input, answers);
  if (outcome.verdict !== (pass ? 'confirmed' : 'not-confirmed') || outcome.pass !== pass) throw new Error('AUDIT_RECEIPT_INVALID');
}
export function recordAuditOutcome(repo, run, outcome) {
  return withStateLock(repo, run, () => {
    const state = readState(repo, run);
    if (!state || state.mode !== 'audit') throw new Error('AUDIT_MODE_REQUIRED');
    assertActive(state, repo, run); validateAuditOutcome(repo, run, state, outcome);
    const reservation = state.auditSubmissions.find(r => r.submission === outcome.submission);
    if (reservation.recordedAt) throw new Error('AUDIT_RECEIPT_REPLAY');
    state.auditOutcome = { ...outcome, receipt: auditReceipt(state, outcome) };
    reservation.recordedAt = new Date().toISOString();
    state.gates['audit-check'] = { status: outcome.pass ? 'passed' : 'failed', at: new Date().toISOString(), inputSha256: outcome.inputSha256 };
    state.finished = false;
    saveState(join(reviewStateDirectory(repo, run), 'state.json'), state);
    return outcome;
  });
}
function assertAuditAcceptance(state, repo, run) {
  if (!requiredGates(state).includes('audit-check')) return;
  if (state.gates['audit-check']?.status !== 'passed' || state.auditOutcome?.verdict !== 'confirmed') throw new Error('AUDIT_CHECK_REQUIRED');
  validateAuditOutcome(repo, run, state, state.auditOutcome);
}
// Atomic: a concurrent reader (closeout, reuse) never sees a half-written state.json.
export function saveState(file, state, { allowInvalidatedAudit = false } = {}) {
  if (state.mode === 'audit' || existsSync(join(dirname(file), 'run-mode.json'))) {
    const repo = resolve(dirname(file), '../../..');
    auditDeclaration(repo, state.run, state);
    try { assertAuditClean(state, repo, state.run); }
    catch (error) { if (!allowInvalidatedAudit) throw error; state.finished = false; }
    if (state.finished) assertAuditAcceptance(state, repo, state.run);
  }
  // A successful ledger save remembers a changed NEXT even if its old bytes later return.
  if (state.planAck) {
    let next = null;
    try { next = planHash(readFileSync(join(dirname(file), 'HANDOVER-NEXT.md'))); }
    catch (e) { if (e.code === 'ENOENT') next = 'absent'; }
    if (next === null || state.planAck.next !== next) state.planAck = null;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (i < 3 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { const t = Date.now() + 50 * (i + 1); while (Date.now() < t) { /* brief wait: an editor or scanner holds the file */ } continue; }
      try { unlinkSync(tmp); } catch { /* gone */ }
      throw e;
    }
  }
}
// Every read-modify-write of a run's state.json runs under this short lock: the atomic rename in saveState
// protects readers, not two writers (20 parallel registrations used to keep 6). Held for milliseconds; a lock
// whose owner is gone, or older than a minute, is taken over.
const terminalCloseouts = new Set();
function withStateLockOnce(repo, run, fn, directory) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  const dir = directory || reviewStateDirectory(repo, run); mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'state.lock');
  const deadline = Date.now() + 30000;
  for (;;) {
    try { const fd = openSync(lock, 'wx'); writeSync(fd, String(process.pid)); closeSync(fd); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - statSync(lock).mtimeMs; const owner = Number(readFileSync(lock, 'utf8'));
        let dead = !Number.isInteger(owner) || owner <= 0; if (!dead) { try { process.kill(owner, 0); } catch (k) { dead = k.code === 'ESRCH'; } }
        if (age > 60000 || (dead && age > 1000)) { rmSync(lock, { force: true }); continue; }
      } catch { continue; /* vanished between the checks */ }
      if (Date.now() > deadline) throw new Error('STATE_LOCKED: another process holds the state lock for this run; retry in a moment');
      const t = Date.now() + 15; while (Date.now() < t) { /* brief wait */ }
    }
  }
  try { return fn(); } finally {
    rmSync(lock, { force: true });
    // Parking can originate in any gate/loop path, including one that throws after saving.
    // Drain only after releasing the state lock: closeout records its result under that same lock.

  }
}
// A boundary request unwinds the short state lock before any Git/network operation.
// The unchanged generation is checked under that lock before replaying publication.
class BoundaryRequest extends Error {
  constructor(allowCleanInTree) {
    super();
    this.allowCleanInTree = allowCleanInTree;
  }
}
const boundaryPermits = new Map();
function boundaryGeneration(dir) {
  return planHash(['state.json', 'HANDOVER-NEXT.md', ...readdirSync(dir).filter(n => /^HANDOVER-TAKEN-\d+\.md$/.test(n)).sort()]
    .map(n => `${n}\0${existsSync(join(dir, n)) ? planHash(readFileSync(join(dir, n))) : 'absent'}`).join('\n'));
}
function requireBoundary(repo, run, state, directory, allowCleanInTree = false) {
  if (!validRegisteredState(state)) throw new Error('BOUNDARY_REFUSED: UNKNOWN registration state');
  if (!(state.worktrees || []).length) return;
  if (closeoutHoldReason(state)) throw new Error('BOUNDARY_REFUSED: NOT_OWNED owner-hold');
  const dir = resolve(directory || reviewStateDirectory(repo, run)), permit = boundaryPermits.get(dir);
  if (!permit) throw new BoundaryRequest(allowCleanInTree);
  if (permit.allowCleanInTree && !allowCleanInTree) throw new Error('BOUNDARY_REFUSED: CALLER_IN_WORKTREE');
  if (boundaryGeneration(dir) !== permit.generation) throw new Error('STATE_CHANGED');
  permit.saved.validate();
}
export function withStateLock(repo, run, fn, directory) {
  const dir = resolve(directory || reviewStateDirectory(repo, run));
  let saved, generation, allowCleanInTree, attempts = 0;
  try {
    for (;;) {
      let request;
      try {
        const result = withStateLockOnce(repo, run, () => {
          if (saved && boundaryGeneration(dir) !== generation) throw new Error('STATE_CHANGED');
          if (saved) boundaryPermits.set(dir, { saved, generation, allowCleanInTree });
          try { return fn(); }
          catch (error) {
            if (!(error instanceof BoundaryRequest)) throw error;
            generation = boundaryGeneration(dir); request = error;
          } finally { boundaryPermits.delete(dir); }
        }, directory);
        if (!request) return result;
        saved?.release();
        allowCleanInTree = request.allowCleanInTree;
        saved = saveBoundary({ repo, run, allowCleanInTree });
        if (!saved.output.ok) {
          const changed = saved.output.checkouts.some(row => row.reason === 'STATE_CHANGED');
          if (changed) throw new Error('STATE_CHANGED');
          throw new Error(`BOUNDARY_REFUSED: ${JSON.stringify(saved.output)}`);
        }
      } catch (error) {
        if (error.message !== 'STATE_CHANGED' || attempts++ >= 1) throw error;
        saved?.release(); saved = null; continue;
      }
    }
  } finally {
    saved?.release(); boundaryPermits.delete(dir);
    if (terminalCloseouts.delete(dir)) terminalCloseout(repo, run);
  }
}

const STATUSES = ['in_progress', 'passed', 'failed', 'blocked'];
export const runsDir = repo => join(repo, '.trioharness-direct', 'runs');

function appendRunHistory(state, event) {
  const history = [...(state.history || []), event];
  // A release card remains spent when routine history rolls over.
  state.history = history.filter((entry, i) => i >= history.length - 100 || entry?.event === 'worktree-release');
}

// Optional discipline records: absent fields preserve legacy runs' behaviour.
const textValue = v => typeof v === 'string' && Boolean(v.trim());
const recordId = v => typeof v === 'string' && /^[A-Za-z0-9._-]+$/.test(v);
const taskLabel = v => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(v);
const objectRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const recordArray = v => Array.isArray(v) ? v.filter(objectRecord) : [];
function requireRecord(ok, kind) { if (!ok) throw new Error(`${kind.toUpperCase()}_INVALID`); }
function onlyFields(record, fields, kind) {
  requireRecord(objectRecord(record) && Object.keys(record).every(k => fields.includes(k)), kind);
}
function validateScope(scope) {
  onlyFields(scope, ['outcome', 'nonGoals', 'files'], 'scope');
  requireRecord(textValue(scope.outcome) && ['nonGoals', 'files'].every(k => Array.isArray(scope[k]) && scope[k].every(textValue)), 'scope');
}
function validateDeferral(d) {
  onlyFields(d, ['id', 'item', 'reason'], 'deferral');
  requireRecord(recordId(d.id) && textValue(d.item) && textValue(d.reason), 'deferral');
}
function validateItem(item) {
  onlyFields(item, ['id', 'item', 'owner', 'status', 'blocker', 'next', 'reason'], 'item');
  requireRecord(recordId(item.id) && textValue(item.item) && textValue(item.owner) &&
    ['open', 'blocked', 'done', 'parked'].includes(item.status) &&
    (item.blocker === undefined || typeof item.blocker === 'string') &&
    (item.next === undefined || typeof item.next === 'string') &&
    (item.reason === undefined || textValue(item.reason)) &&
    (!['open', 'blocked', 'parked'].includes(item.status) || textValue(item.next)) &&
    (item.status !== 'blocked' || textValue(item.blocker)) &&
    (item.status !== 'parked' || textValue(item.reason)), 'item');
}
function validateHandoff(h, repo, run) {
  onlyFields(h, ['id', 'kind', 'source', 'target', 'state', 'result', 'verification', 'itemId', 'replaces'], 'handoff');
  const identity = (x, optionalTask = false) => objectRecord(x) && Object.keys(x).every(k => ['repo', 'run', 'task'].includes(k)) && textValue(x.repo) && isAbsolute(x.repo) && validRunId(x.run) && (optionalTask && x.task === undefined || taskLabel(x.task));
  requireRecord(recordId(h.id) && ['same-repo', 'cross-repo'].includes(h.kind) && identity(h.source) && identity(h.target, true) &&
    h.source.repo === repo && h.source.run === run && recordId(h.itemId) &&
    ['sent', 'running', 'done', 'failed'].includes(h.state) &&
    ['result', 'verification'].every(k => h[k] === undefined || textValue(h[k])) &&
    (h.replaces === undefined || recordId(h.replaces)), 'handoff');
  const sameRepo = h.source.repo === h.target.repo;
  requireRecord(h.kind === 'same-repo' ? sameRepo && h.source.run === h.target.run : !sameRepo, 'handoff');
  if (h.state === 'done') requireRecord(textValue(h.result) && (h.kind === 'same-repo' || textValue(h.verification)), 'handoff');
}
const planHash = bytes => createHash('sha256').update(bytes).digest('hex');
const planPathValid = path => textValue(path) && !isAbsolute(path) && !/[\\\x00-\x1f\x7f]/.test(path) &&
  path.split('/').every(part => part && part !== '.' && part !== '..');
function validatePlans(state) {
  if (state.reportNext !== undefined) requireRecord(typeof state.reportNext === 'string' && /^[a-f0-9]{64}$/.test(state.reportNext), 'plans');
  if (!Object.hasOwn(state, 'plans')) return;
  requireRecord(Array.isArray(state.plans), 'plans');
  const previous = new Map();
  for (const pin of state.plans) {
    onlyFields(pin, ['path', 'sha256', 'approvedBy', 'at', 'supersedes'], 'plans');
    requireRecord(planPathValid(pin.path) && /^[a-f0-9]{64}$/.test(pin.sha256 || '') && /^Q-[1-9]\d*$/.test(pin.approvedBy || '') &&
      textValue(pin.at) && Number.isFinite(Date.parse(pin.at)) &&
      (previous.has(pin.path) ? pin.supersedes === previous.get(pin.path) : pin.supersedes === undefined), 'plans');
    previous.set(pin.path, pin.sha256);
  }
  if (state.planAck !== undefined && state.planAck !== null) {
    onlyFields(state.planAck, ['digest', 'at', 'pickup', 'next'], 'plans');
    requireRecord(/^[a-f0-9]{64}$/.test(state.planAck.digest || '') && textValue(state.planAck.at) && Number.isFinite(Date.parse(state.planAck.at)) &&
      /^(none|HANDOVER-TAKEN-\d+\.md)$/.test(state.planAck.pickup || '') &&
      (state.planAck.next === undefined || (typeof state.planAck.next === 'string' && /^(absent|[a-f0-9]{64})$/.test(state.planAck.next))), 'plans');
  }
}
function activePlans(state) {
  validatePlans(state);
  return [...new Map((state.plans || []).map(pin => [pin.path, pin])).values()].sort((a, b) => a.path.localeCompare(b.path));
}
const planDigest = plans => planHash(plans.map(pin => pin.sha256).sort().join('\n'));
const snapshotName = pin => `${pin.sha256}${/^\.[A-Za-z0-9]{1,12}$/.test(extname(pin.path)) ? extname(pin.path) : '.bin'}`;
const snapshotFile = (repo, run, pin) => join(reviewStateDirectory(repo, run), 'plans', snapshotName(pin));
function verifyPlanSnapshot(repo, run, pin) {
  try {
    const file = snapshotFile(repo, run, pin), info = lstatSync(file);
    if (!info.isFile() || !info.size || info.size > 256 * 1024 || lstatSync(join(file, '..')).isSymbolicLink() || planHash(readFileSync(file)) !== pin.sha256) throw new Error('invalid');
  } catch { throw new Error(`PLAN_SNAPSHOT_INVALID: ${pin.path} ${pin.sha256}`); }
}
function renderPlans(state) {
  const plans = activePlans(state);
  if (!plans.length) return '';
  return `## Pinned plans\n\nManifest digest: ${planDigest(plans)}\n\n${plans.map(pin =>
    `- ${pin.path}\n  sha256: ${pin.sha256}\n  approvedBy: ${pin.approvedBy}\n  snapshot: plans/${snapshotName(pin)}`).join('\n')}\n`;
}
function planNextIdentity(repo, run) {
  try { return planHash(readFileSync(join(reviewStateDirectory(repo, run), 'HANDOVER-NEXT.md'))); }
  catch (e) { if (e.code === 'ENOENT') return 'absent'; throw new Error('PLAN_ACK_REQUIRED: cannot read HANDOVER-NEXT.md'); }
}
function currentPlanPickup(state, repo, run) {
  if (recordArray(state.handoffs).some(h => h.kind === 'same-repo' && ['sent', 'running'].includes(h.state))) return null;
  const pickup = state.handoff;
  // NEXT may be an exception/park report. Only recorded handoff state creates a pickup obligation.
  if (!pickup) return 'none';
  return !pickup.kept && /^HANDOVER-TAKEN-\d+\.md$/.test(pickup.file || '') &&
    existsSync(join(reviewStateDirectory(repo, run), pickup.file)) ? pickup.file : null;
}
function assertPlanAcknowledged(state, repo, run) {
  const plans = activePlans(state);
  if (!plans.length) return;
  const pickup = currentPlanPickup(state, repo, run);
  if (!pickup || state.planAck?.pickup !== pickup || state.planAck?.digest !== planDigest(plans) ||
      state.planAck?.next !== planNextIdentity(repo, run)) {
    throw new Error(`PLAN_ACK_REQUIRED: read the snapshots and acknowledge this generation (consume any recorded handoff first), then plan ack --digest ${planDigest(plans)}\n${renderPlans(state)}`);
  }
}
// The card must name whole path/digest tokens, never a basename, suffix or digest prefix.
function namesPlanValue(question, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[\\s`"\'(<\\[])' + escaped + '(?=$|[\\s`"\')>\\],;:?!])').test(question);
}
function namesPlanPair(question, path, digest) {
  const hashes = question.match(/\b[a-f0-9]{64}\b/gi) || [];
  if (hashes.length !== 1 || hashes[0] !== digest || !namesPlanValue(question, path) || !namesPlanValue(question, digest)) return false;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // One adjacent path/hash pair per question; separate questions may approve separate plans.
  return new RegExp('(^|[\\s`"\'(<\\[])' + escaped + '[`"\']?\\s+(?:sha256\\s*[:=]?\\s*)?[`"\']?' + digest + '(?=$|[\\s`"\')>\\],;:?!])').test(question);
}
function hasPlanApproval(repo, run, card, path, digest) {
  const set = readSets(repo, run).find(s => s.id === card);
  return set?.status === 'answered' && ['card', 'ui', 'numbered-reply'].includes(set.answeredVia) &&
    Array.isArray(set.card?.questions) && set.card.questions.some(q => {
      const answer = set.answers?.[q.id], selected = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer;
      return typeof selected === 'string' && q.options?.some(option => option.id === selected && /^Approve\b/.test(option.label)) &&
        typeof q.question === 'string' && namesPlanPair(q.question, path, digest);
    });
}
export function planCommand(repo, run, action, { path, card, digest } = {}) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  const directory = reviewStateDirectory(repo, run);
  return withStateLock(repo, run, () => {
    const stateFile = join(directory, 'state.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    if (!state) throw new Error('RUN_UNKNOWN');
    const plans = activePlans(state);
    if (action === 'render') return renderPlans(state);
    if (action === 'list') return { digest: planDigest(plans), plans: plans.map(pin => {
      verifyPlanSnapshot(repo, run, pin);
      let live = 'missing';
      try { live = planHash(readFileSync(join(repo, pin.path))) === pin.sha256 ? 'ok' : 'changed'; } catch { /* source may be gone; snapshot remains authoritative */ }
      return { ...pin, snapshot: snapshotFile(repo, run, pin), live };
    }) };
    if (!['pin', 'ack'].includes(action)) throw new Error('PLAN_ACTION_INVALID: pin|list|ack|render');
    if (state.finished) throw new Error(`RUN_FINISHED: run ${run} is finished`);
    assertActive(state, repo, run);
    const now = new Date().toISOString();
    if (action === 'ack') {
      const pickup = currentPlanPickup(state, repo, run);
      if (!pickup) throw new Error('PLAN_ACK_REQUIRED: consume the recorded handover first');
      if (digest !== planDigest(plans)) throw new Error('PLAN_DIGEST_MISMATCH');
      plans.forEach(pin => verifyPlanSnapshot(repo, run, pin));
      const next = planNextIdentity(repo, run);
      if (next !== 'absent' && next !== state.reportNext) throw new Error('PLAN_ACK_REQUIRED: hand off instead; write NEXT after the last ack, then the successor runs handover-taken and plan ack');
      state.planAck = { digest, at: now, pickup, next };
    } else {
      let file, canonical;
      try {
        const root = realpathSync.native(repo);
        if (!textValue(path)) throw new Error('missing');
        file = realpathSync.native(resolve(root, path));
        if (!file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error('outside');
        canonical = relative(root, file).split(sep).join('/');
        if (!planPathValid(canonical)) throw new Error('invalid');
      } catch { throw new Error('PLAN_PATH_INVALID: a file inside the main repo is required'); }
      if (!statSync(file).size || statSync(file).size > 256 * 1024) throw new Error('PLAN_SIZE_INVALID: nonempty, at most 256 KiB');
      const bytes = readFileSync(file);
      if (!bytes.length || bytes.length > 256 * 1024) throw new Error('PLAN_SIZE_INVALID: nonempty, at most 256 KiB');
      const hash = planHash(bytes);
      if (!hasPlanApproval(repo, run, card, canonical, hash)) throw new Error('PLAN_APPROVAL_REQUIRED: owner must Approve the exact canonical path and full sha256');
      const q = openQuestionsReason(repo, run); if (q) throw new Error(`QUESTIONS_OPEN: ${q}`);
      const prior = plans.find(pin => pin.path === canonical);
      const pin = { path: canonical, sha256: hash, approvedBy: card, at: now, ...(prior ? { supersedes: prior.sha256 } : {}) };
      const plansDirectory = join(directory, 'plans'); mkdirSync(plansDirectory, { recursive: true });
      if (lstatSync(plansDirectory).isSymbolicLink()) throw new Error('PLAN_SNAPSHOT_INVALID: plans directory is a symlink');
      const temp = join(plansDirectory, `.${snapshotName(pin)}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, bytes, { flag: 'wx' });
        // Exclusive link publication is atomic like rename, but cannot overwrite an existing final name.
        try { linkSync(temp, snapshotFile(repo, run, pin)); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
      } finally { rmSync(temp, { force: true }); }
      verifyPlanSnapshot(repo, run, pin);
      state.plans = [...(state.plans || []), pin]; state.planAck = null;
    }
    state.updatedAt = now; saveState(stateFile, state);
    return action === 'ack' ? state.planAck : state.plans.at(-1);
  }, directory);
}
function disciplineProblems(state, repo, run) {
  const problems = [];
  const check = fn => { try { fn(); } catch (e) { problems.push(e.message); } };
  check(() => validatePlans(state));
  if (Object.hasOwn(state, 'scope')) check(() => validateScope(state.scope));
  for (const [field, validate] of [['deferrals', validateDeferral], ['items', validateItem], ['handoffs', h => validateHandoff(h, state.repo ?? repo, run)]]) {
    if (!Object.hasOwn(state, field)) continue;
    if (!Array.isArray(state[field])) { problems.push(`${field.toUpperCase()}_INVALID`); continue; }
    const ids = new Set();
    for (const record of state[field]) check(() => {
      validate(record);
      requireRecord(!ids.has(record.id), field); ids.add(record.id);
    });
  }
  if (Array.isArray(state.handoffs)) for (const [i, h] of state.handoffs.entries()) check(() => {
    if (!objectRecord(h)) return; // already reported by record validation
    if (h.itemId !== undefined) requireRecord(Array.isArray(state.items) && state.items.some(x => x?.id === h.itemId), 'handoff');
    if (h.replaces !== undefined) {
      const prior = state.handoffs.slice(0, i).find(x => x?.id === h.replaces);
      requireRecord(prior?.state === 'failed' && prior.itemId === h.itemId, 'handoff');
    }
  });
  return problems;
}
const owedHandoffs = state => recordArray(state.handoffs).filter(h => ['sent', 'running'].includes(h.state) ||
  (h.state === 'failed' && !recordArray(state.handoffs).some(next => next.replaces === h.id) &&
    !recordArray(state.items).some(item => item.id === h.itemId && item.status === 'parked')));
function assertNoOwedWork(state, repo, run) {
  const problems = disciplineProblems(state, repo, run);
  if (problems.length) throw new Error(`RUN_OWES_WORK: malformed records: ${problems.join(', ')}`);
  const owed = [...(state.items || []).filter(i => ['open', 'blocked'].includes(i.status)).map(i => i.id), ...owedHandoffs(state).map(h => h.id)];
  if (owed.length) throw new Error(`RUN_OWES_WORK: ${owed.join(', ')}`);
}
// All mutations share the existing state lock and atomic save. No gate/cap is changed here.
export function updateDiscipline(repo, run, kind, action, record) {
  return withStateLock(repo, run, () => {
    const state = readState(repo, run); if (!state) throw new Error('RUN_UNKNOWN');
    if (state.finished) throw new Error(`RUN_FINISHED: run ${run} is finished`);
    assertActive(state, repo, run);
    const problems = disciplineProblems(state, repo, run);
    if (problems.length) throw new Error(`RECORDS_INVALID: ${problems.join(', ')}`);
    if (kind === 'scope') {
      validateScope(record);
      if (Object.hasOwn(state, 'scope')) throw new Error('SCOPE_ALREADY_SET: scope baseline is immutable');
      state.scope = record;
    } else if (kind === 'defer') {
      validateDeferral(record);
      const list = state.deferrals || [];
      if (list.some(d => d.id === record.id)) throw new Error('DEFERRAL_EXISTS');
      state.deferrals = [...list, record];
    } else if (['item', 'handoff'].includes(kind)) {
      requireRecord(objectRecord(record) && recordId(record.id), kind);
      const field = kind === 'item' ? 'items' : 'handoffs', list = state[field] || [];
      const old = list.find(x => x.id === record.id);
      if (!['add', 'set'].includes(action) || (action === 'add' ? Boolean(old) : !old)) throw new Error('RECORD_ACTION_INVALID: add needs a new id; set needs an existing id');
      const next = { ...old, ...record };
      if (kind === 'item') {
        validateItem(next);
        if (next.status === 'parked' && old?.status !== 'parked') requireRecord(textValue(record.owner) && textValue(record.reason), 'item');
      }
      else {
        if (!old) {
          for (const key of ['source', 'target']) {
            requireRecord(objectRecord(next[key]) && textValue(next[key].repo), 'handoff');
            try { next[key] = { ...next[key], repo: realpathSync(next[key].repo) }; }
            catch { throw new Error('HANDOFF_REPO_INVALID: repo must resolve to an existing path'); }
          }
          const canonicalRepo = realpathSync(repo);
          requireRecord(next.source.repo === canonicalRepo, 'handoff');
          if (state.repo !== undefined) requireRecord(state.repo === canonicalRepo, 'handoff');
          state.repo = canonicalRepo;
        }
        validateHandoff(next, state.repo, run);
        if (!old && next.state !== 'sent') throw new Error('HANDOFF_INITIAL_STATE: sent required');
        if (old) {
          for (const key of ['kind', 'source', 'target', 'itemId', 'replaces']) if (JSON.stringify(next[key]) !== JSON.stringify(old[key])) throw new Error('HANDOFF_IDENTITY_IMMUTABLE');
          if ((['done', 'failed'].includes(old.state) && next.state !== old.state) || (old.state === 'running' && next.state === 'sent')) throw new Error('HANDOFF_TRANSITION_INVALID');
          if (['done', 'failed'].includes(old.state)) for (const key of ['result', 'verification']) if (old[key] !== undefined && next[key] !== old[key]) throw new Error('HANDOFF_EVIDENCE_IMMUTABLE');
          if (next.state === 'running' && next.kind === 'same-repo') assertPlanAcknowledged(state, repo, run);
          if (next.state === 'done' && old.state !== 'done' && next.kind === 'same-repo') throw new Error('HANDOFF_PICKUP_REQUIRED: consume NEXT with handover-taken');
        }
      }
      state[field] = old ? list.map(x => x.id === record.id ? next : x) : [...list, next];
    } else throw new Error('RECORD_KIND_INVALID');
    const after = disciplineProblems(state, repo, run);
    if (after.length) throw new Error(`RECORDS_INVALID: ${after.join(', ')}`);
    if (kind === 'handoff') requireBoundary(repo, run, state);
    state.finished = false; state.updatedAt = new Date().toISOString();
    saveState(join(runsDir(repo), run, 'state.json'), state);
    return state;
  });
}
export function statusTable(repo, run) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  const state = readState(repo, run); if (!state) throw new Error('RUN_UNKNOWN');
  const problems = disciplineProblems(state, repo, run);
  const escape = v => String(v ?? '').replace(/\\|&|\[|\]|!|`|\||<|>/g, c => ({ '\\': '&#92;', '&': '&amp;', '[': '&#91;', ']': '&#93;', '!': '&#33;', '`': '&#96;', '|': '&#124;', '<': '&lt;', '>': '&gt;' })[c]).replace(/\r\n|\r|\n/g, '<br>');
  const rows = [['Kind', 'ID', 'State', 'Owner / target', 'Next / evidence / reason'], ['---', '---', '---', '---', '---']];
  rows.push(['run', run, state.finished ? 'finished' : state.status || 'active', state.task, state.next]);
  for (const problem of problems) rows.push(['problem', '', 'invalid', '', problem]);
  if (objectRecord(state.scope) && Array.isArray(state.scope.files) && Array.isArray(state.scope.nonGoals)) rows.push(['scope', '', 'baseline', '', `${state.scope.outcome}; files: ${state.scope.files.join(', ')}; non-goals: ${state.scope.nonGoals.join(', ')}`]);
  for (const i of recordArray(state.items)) rows.push(['item', i.id, i.status, i.owner, [i.item, i.next, i.blocker, i.reason].filter(Boolean).join('; ')]);
  for (const h of recordArray(state.handoffs).filter(h => objectRecord(h.target))) rows.push(['handoff', h.id, h.state, `${h.target.repo} / ${h.target.run} / ${h.target.task ?? ''}`, [h.kind, h.result, h.verification, h.itemId && `item ${h.itemId}`, h.replaces && `replaces ${h.replaces}`].filter(Boolean).join('; ')]);
  for (const [gate, g] of Object.entries(state.gates || {})) rows.push(['gate', gate, g.status, '', g.note || g.evidence]);
  rows.push(['round', 'review', state.reviewRound || 0, '', `synced: ${state.findingsSyncedRound ?? 'not recorded'}`]);
  for (const [kind, cap] of Object.entries(LOOP_CAPS)) rows.push(['cap', kind, `${state.loops?.[kind] || 0}/${cap}`, '', '']);
  for (const d of recordArray(state.deferrals)) rows.push(['deferral', d.id, 'deferred', '', `${d.item}; ${d.reason}`]);
  return rows.map(row => `| ${row.map(escape).join(' | ')} |`).join('\n') + '\n';
}

// Lifetime budgets never reset when Jev's consecutive-attempt counter resets.
export const LOOP_CAPS = Object.freeze({ 'plan-review': 1, 'jev-plan': 3, 'audit-check': 3, 'code-review': 2, 'fix-batch': 2, replan: 1, 'base-drift': 2, 'need-context': 2 });
const values = value => Array.isArray(value) ? value : Object.entries(value || {}).map(([id, item]) => ({ id, ...item }));
const openFindings = state => values(state?.findings).filter(f => /^(HIGH|MEDIUM)$/i.test(f.severity || '') && !['closed', 'fixed', 'dismissed', 'resolved'].includes(f.status));
const REVIEW_GATES = ['plan-review', 'review', 'browser-test'];
const PRODUCT_GATES = [...REVIEW_GATES, 'guard-proof', 'plan-jev'];
const reviewRound = state => state.reviewRound || (REVIEW_GATES.some(g => ['passed', 'in_progress'].includes(state.gates?.[g]?.status)) ? 1 : 0);
function isExceptionCard(card) {
  const q = card.card?.questions?.[0];
  return card.card?.questions?.length === 1 && q.id === 'jevexc' &&
    q.options?.some(o => o.id === 'proceed') && !q.options.some(o => o.id === 'renew');
}
function validGrant(repo, run, digest) {
  const grant = findException(repo, run, 'plan', digest);
  const card = grant && readSets(repo, run).find(s => s.id === grant.set);
  return card?.status === 'answered' && ['card', 'ui', 'numbered-reply'].includes(card.answeredVia) &&
    card.answers?.jevexc === 'proceed' && card.card?.questions?.length === 1 && card.card.questions[0].id === 'jevexc' && isExceptionCard(card) && card.card.questions[0].question.includes(`input ${digest}`);
}
function assertBudgetChoice(state, repo, run) {
  if (state?.status !== 'awaiting-budget') return;
  const issued = state.planBudgetCard;
  const card = issued?.run === run && readSets(repo, run).find(s => s.id === issued.set);
  if (card && ['answered', 'assumed'].includes(card.status) && card.answers?.jevexc === 'park' &&
      createHash('sha256').update(JSON.stringify(card.card)).digest('hex') === issued.cardSha256) {
    parkUnlocked(repo, run, state, 'BUDGET_RENEWAL_NOT_GRANTED'); throw new Error('RUN_PARKED: BUDGET_RENEWAL_NOT_GRANTED');
  }
}
function assertActive(state, repo, run) {
  assertAuditClean(state, repo, run);
  if (state?.status?.startsWith('parked:')) throw new Error(`RUN_PARKED: ${state.status}`);
  assertBudgetChoice(state, repo, run);
  if (state?.status === 'awaiting-budget') throw new Error('AWAITING_BUDGET: only the exact-input renewal card or park may continue');
  if (state?.status === 'awaiting-exception') {
    const card = readSets(repo, run).find(s => s.id !== state.planBudgetCard?.set && isExceptionCard(s) && s.card.questions[0].question.includes(`input ${state.awaitingException.inputSha256}`));
    if (!card || (card.status === 'answered' && !validGrant(repo, run, state.awaitingException.inputSha256))) {
      parkUnlocked(repo, run, state, 'EXCEPTION_NOT_GRANTED');
      throw new Error('RUN_PARKED: EXCEPTION_NOT_GRANTED');
    }
    throw new Error('AWAITING_EXCEPTION: only the exact-input exception flow or park may continue');
  }
}
function unresolved(state) {
  return (state.planPendingOutcomes || 0) > 0 || requiredGates(state, 'product').some(g => ['failed', 'blocked', 'in_progress'].includes(state?.gates?.[g]?.status)) || openFindings(state).length ||
    values(state?.criteria).some(c => !['passed', 'met', 'satisfied'].includes(c.status));
}
function assertAcceptance(state, repo, run) {
  assertActive(state, repo, run);
  assertAuditAcceptance(state, repo, run);
  if (unresolved(state)) throw new Error('RUN_UNRESOLVED: failed product gates, open HIGH/MEDIUM findings or unmet criteria');
  if (reviewRound(state) && state.findingsSyncedRound !== reviewRound(state)) throw new Error('FINDINGS_NOT_SYNCED: explicit sync required for current review round');
}
function consumeEntry(repo, run, state, kind, directory) {
  const n = state.loops?.[kind] === undefined ? 0 : state.loops[kind];
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('LOOP_COUNTER_INVALID');
  if (n >= LOOP_CAPS[kind]) { parkUnlocked(repo, run, state, `LOOP_CAP:${kind}`, directory); throw new Error(`LOOP_CAP:${kind}`); }
  state.loops = { ...(state.loops || {}), [kind]: n + 1 };
}
// These writes retain prior findings: an omitted or downgraded finding cannot disappear in sync.
export function updateFindings(repo, run, action, { id, severity, evidence, file, round } = {}) {
  return withStateLock(repo, run, () => {
    const state = readState(repo, run); if (!state) throw new Error('RUN_UNKNOWN');
    assertActive(state, repo, run);
    const findings = values(state.findings).map(f => ({ ...f }));
    const add = item => {
      if (!/^[A-Za-z0-9._-]+$/.test(item?.id || '') || !['HIGH', 'MEDIUM', 'LOW'].includes(item.severity) || typeof item.evidence !== 'string' || !item.evidence.trim()) throw new Error('FINDING_INVALID');
      if (item.status !== undefined && !['open', 'resolved'].includes(item.status)) throw new Error('FINDING_DISPOSITION_REQUIRED');
      const old = findings.find(f => f.id === item.id);
      if (old && (old.severity !== item.severity || (old.status !== 'resolved' && item.status === 'resolved'))) throw new Error('FINDING_DISPOSITION_REQUIRED');
      if (old) Object.assign(old, item); else findings.push({ ...item, status: 'open' });
    };
    if (action === 'add') add({ id, severity, evidence, status: 'open' });
    else if (action === 'resolve') {
      const finding = findings.find(f => f.id === id);
      if (!finding || typeof evidence !== 'string' || !evidence.trim()) throw new Error('FINDING_INVALID');
      finding.status = 'resolved'; finding.resolutionEvidence = evidence;
    } else if (action === 'sync') {
      if (!Number.isSafeInteger(round) || round !== reviewRound(state)) throw new Error('FINDINGS_ROUND_STALE');
      const incoming = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(incoming)) throw new Error('FINDING_INVALID');
      for (const item of incoming) add(item);
      state.findingsSyncedRound = round;
    } else throw new Error('FINDINGS_ACTION_INVALID');
    if (action !== 'sync') delete state.findingsSyncedRound;
    state.finished = false;
    state.findings = findings; state.updatedAt = new Date().toISOString();
    saveState(join(runsDir(repo), run, 'state.json'), state); return state;
  });
}
export function setCriterion(repo, run, { id, status, evidence }) {
  return withStateLock(repo, run, () => {
    const state = readState(repo, run); if (!state) throw new Error('RUN_UNKNOWN'); assertActive(state, repo, run);
    if (!/^[A-Za-z0-9._-]+$/.test(id || '') || !['met', 'unmet'].includes(status) || typeof evidence !== 'string' || !evidence.trim()) throw new Error('CRITERION_INVALID');
    state.finished = false;
    state.criteria = [...values(state.criteria).filter(c => c.id !== id), { id, status, evidence }];
    state.updatedAt = new Date().toISOString(); saveState(join(runsDir(repo), run, 'state.json'), state); return state;
  });
}
// Called only for real reported outcomes, after Jev's verdict/exception logic and receipt write.
// The CLI calls this under the item lock after verifying the Team ruling and exact subject.
export function recordArbiterPlan(repo, run, outcome) {
  return withStateLock(repo, run, () => {
    const state = readState(repo, run);
    if (!state) throw new Error('RUN_UNKNOWN');
    if (state.status?.startsWith('parked:') || state.planPendingOutcomes) throw new Error('PLAN_OUTCOME_BLOCKED');
    const question = openQuestionsReason(repo, run);
    if (question) throw new Error(`QUESTIONS_OPEN: ${question}`);
    const existing = (state.planOutcomes || []).find(o => o.rulingId === outcome.rulingId && o.inputSha256 === outcome.inputSha256);
    if (existing && state.gates?.['plan-jev']?.status === 'passed') return state;
    state.status = 'active';
    state.attempts = { ...state.attempts, plan: 0 };
    delete state.awaitingException;
    delete state.awaitingBudget;
    delete state.planAcceptanceInvalidated;
    state.gates ||= {};
    state.gates['plan-jev'] = { status: 'passed', at: outcome.at, evidence: `Team Arbiter ruling ${outcome.rulingId} input ${outcome.inputSha256}` };
    state.planOutcomes = [...(state.planOutcomes || []), { ...outcome, verdict: 'proceed', authority: 'arbiter' }];
    state.updatedAt = outcome.at;
    saveState(join(runsDir(repo), run, 'state.json'), state);
    return state;
  });
}

export function recordPlanOutcome(repo, run, outcome) {
  return withStateLock(repo, run, () => {
    const state = readState(repo, run); if (!state) throw new Error('RUN_UNKNOWN');
    if (!['proceed', 'accepted-exception', 'revise', 'unavailable'].includes(outcome.verdict) || !/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(outcome.inputSha256 || '')) throw new Error('PLAN_OUTCOME_INVALID');
    if (state.status?.startsWith('parked:')) throw new Error('RUN_PARKED');
    if (outcome.attempt !== undefined && !(state.planPendingSubmissions || []).some(p => p.submission === outcome.submission && p.attempt === outcome.attempt && (!p.inputSha256 || p.inputSha256 === outcome.inputSha256))) throw new Error('PLAN_SUBMISSION_UNKNOWN');
    if (state.status === 'awaiting-exception') {
      if (!['proceed', 'accepted-exception'].includes(outcome.verdict) || state.awaitingException.inputSha256 !== outcome.inputSha256 || !validGrant(repo, run, outcome.inputSha256)) {
        parkUnlocked(repo, run, state, 'EXCEPTION_NOT_GRANTED'); throw new Error('RUN_PARKED: EXCEPTION_NOT_GRANTED');
      }
      state.status = 'active'; state.attempts = { ...state.attempts, plan: 0 }; delete state.awaitingException;
    }
    if (['proceed', 'accepted-exception'].includes(outcome.verdict) && outcome.attempt === undefined &&
        (!validGrant(repo, run, outcome.inputSha256) || (state.planOutcomes || []).some(o =>
          o.inputSha256 === outcome.inputSha256 && ['proceed', 'accepted-exception'].includes(o.verdict)))) throw new Error('PLAN_PROVENANCE_REQUIRED: current submission or unconsumed exact-input exception required');
    if (outcome.attempt !== undefined) {
      state.planPendingSubmissions = state.planPendingSubmissions.filter(p => p.submission !== outcome.submission);
      state.planPendingOutcomes = Math.max(0, (state.planPendingOutcomes || 0) - 1);
    }
    if (state.loops) delete state.loops['jev-plan-manual'];
    state.gates ||= {};
    state.gates['plan-jev'] = { status: ['proceed', 'accepted-exception'].includes(outcome.verdict) ? 'passed' : 'failed', at: outcome.at, evidence: `Jev ${outcome.verdict} input ${outcome.inputSha256}` };
    state.planOutcomes = [...(state.planOutcomes || []), outcome];
    if (['proceed', 'accepted-exception'].includes(outcome.verdict)) delete state.planAcceptanceInvalidated;
    if (['revise', 'unavailable'].includes(outcome.verdict)) {
      state.planFailedSubmissions = (state.planFailedSubmissions || 0) + 1;
      if ((state.loops?.['jev-plan'] || 0) >= LOOP_CAPS['jev-plan']) {
        state.status = 'awaiting-exception'; state.awaitingException = { inputSha256: outcome.inputSha256, at: outcome.at };
        state.finished = false;
        writeOutstandingReport(repo, run, state, 'Awaiting exact-input exception; not accepted');
      }
    }
    state.updatedAt = new Date().toISOString(); saveState(join(runsDir(repo), run, 'state.json'), state); return state;
  });
}
function writeOutstandingReport(repo, run, state, heading, directory) {
  const dir = directory || join(runsDir(repo), run);
  const record = (item, id, severity) => ({ ...item, id: item.id || id, severity: item.severity || severity, evidence: item.evidence || item.note || 'NOT_RECORDED: see original record', original: item });
  const outstanding = [
    ...openFindings(state).map(f => record(f, 'UNNAMED_FINDING', 'UNKNOWN')),
    ...Object.entries(state.gates || {}).filter(([, g]) => ['failed', 'blocked'].includes(g.status)).map(([id, g]) => record(g, id, 'BLOCKING')),
    ...values(state.criteria).filter(c => !['passed', 'met', 'satisfied'].includes(c.status)).map(c => record(c, 'UNNAMED_CRITERION', 'BLOCKING')),
    ...recordArray(state.items).filter(i => ['open', 'blocked'].includes(i.status)).map(i => record(i, 'UNNAMED_ITEM', 'BLOCKING')),
    ...owedHandoffs(state).map(h => record(h, 'UNNAMED_HANDOFF', 'BLOCKING'))
  ];
  let pinned = '';
  try { pinned = renderPlans(state); }
  catch (error) {
    outstanding.push({ id: 'PIN_RECORDS_INVALID', severity: 'BLOCKING', evidence: error.message,
      original: { plans: state.plans, planAck: state.planAck } });
  }
  const handover = join(dir, 'HANDOVER-NEXT.md');
  const previous = existsSync(handover) ? readFileSync(handover) : null;
  const report = `${previous ?? ''}${previous?.length ? '\n\n' : ''}# ${heading}\n\nAcceptance and delivery refused.\n\nOutstanding records (id, severity, evidence):\n\n${JSON.stringify(outstanding, null, 2)}\n${pinned ? `\n${pinned}` : ''}`;
  writeFileSync(handover, report);
  // Appending a report preserves agent bytes, but must never authorize them for acknowledgement.
  if (previous === null || planHash(previous) === state.reportNext) state.reportNext = planHash(report);
  else delete state.reportNext;
  return outstanding;
}
function parkUnlocked(repo, run, state, reason, directory, allowCleanInTree = false) {
  if (typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason)) throw new Error('PARK_REASON_REQUIRED');
  const dir = directory || reviewStateDirectory(repo, run);
  if (state.status?.startsWith('parked:')) return state;
  requireBoundary(repo, run, state, dir, allowCleanInTree);
  const now = new Date().toISOString();
  const outstanding = writeOutstandingReport(repo, run, state, `Parked: ${reason}`, dir);
  state.status = `parked:${reason}`;
  state.parked = { reason, at: now, report: 'HANDOVER-NEXT.md', outstanding };
  state.finished = false;
  state.next = 'Owner disposition in a new run; do not resume this terminal run';
  state.updatedAt = now;
  saveState(join(dir, 'state.json'), state, { allowInvalidatedAudit: true });
  terminalCloseouts.add(resolve(dir));
  return state;
}
export function parkRun(repo, run, reason) {
  return withStateLock(repo, run, () => {
    const state = readState(repo, run);
    if (!state) throw new Error('RUN_UNKNOWN');
    return parkUnlocked(repo, run, state, reason);
  });
}
// Record a consumed iteration while work remains. A converged result does not request another loop.
export function countLoop(repo, run, kind) {
  if (!Object.hasOwn(LOOP_CAPS, kind || '')) throw new Error('LOOP_KIND_INVALID');
  return withStateLock(repo, run, () => {
    const state = readState(repo, run);
    if (!state) throw new Error('RUN_UNKNOWN');
    assertActive(state, repo, run);
    const previous = state.loops?.[kind] === undefined ? 0 : state.loops[kind];
    if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('LOOP_COUNTER_INVALID');
    state.loops = { ...(state.loops || {}), [kind]: Math.min(previous + 1, LOOP_CAPS[kind]) };
    if (state.loops[kind] >= LOOP_CAPS[kind]) {
      parkUnlocked(repo, run, state, `LOOP_CAP:${kind}`, undefined, kind === 'base-drift');
      throw new Error(`LOOP_CAP:${kind}`);
    }
    state.updatedAt = new Date().toISOString();
    saveState(join(reviewStateDirectory(repo, run), 'state.json'), state);
    return state.loops[kind];
  });
}


export function latestRun(repo) {
  const dir = runsDir(repo);
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter(r => existsSync(join(dir, r, 'state.json')))
    .map(r => ({ r, t: statSync(join(dir, r, 'state.json')).mtimeMs })).sort((a, b) => b.t - a.t);
  return runs[0]?.r || null;
}

function reviewStateDirectory(repo, run, fallback = join(runsDir(repo), run)) {
  const canonical = join(runsDir(repo), run), alternate = join(repo, 'trioharness-direct-runs', run);
  return [canonical, alternate].find(dir => existsSync(join(dir, 'state.json'))) || fallback;
}
export function readState(repo, run) {
  const f = join(reviewStateDirectory(repo, run), 'state.json');
  // Output/declaration artifacts can precede a run's first checkpoint.
  let bytes;
  try { bytes = readFileSync(f, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const state = JSON.parse(bytes);
  auditDeclaration(repo, run, state);
  if (state?.mode === 'audit') {
    const invalid = join(dirname(f), 'audit-invalidated.json');
    if (existsSync(invalid)) { state.auditInvalidated = JSON.parse(readFileSync(invalid)).reason; state.finished = false; }
    else { try { auditCandidate(repo, run, state); } catch (e) { state.auditInvalidated = e.message; state.finished = false; } }
  }
  return state;
}

const reviewRole = role => ['code-reviewer', 'reviewer', 'reviewer-opus'].includes(role);

// Only old states need counter import. A dispatch keeps its stable id; a launch
// binds its receipt reservation to that record once. Neither binding lives in
// the bounded event log or depends on worker registration order.
function closureObligations(state, legacyReceipts = 0) {
  if (state.closureObligations) return state.closureObligations;
  const obligations = Object.entries(state.dispatches || {}).flatMap(([role, count]) =>
    Array.from({ length: count }, () => ({ role, dispatch: true, reservation: null })));
  const tickets = (state.history || []).filter(h => h.reviewLaunch).map(h => ({ ...h.reviewLaunch, launchedAt: h.at }));
  for (const ticket of tickets) {
    const slot = (!ticket.charged && obligations.find(o => reviewRole(o.role) && !o.launched)) || { role: 'code-reviewer' };
    if (!obligations.includes(slot)) obligations.push(slot);
    Object.assign(slot, { reservation: ticket.id, launched: true, launchedAt: ticket.launchedAt, refunded: ticket.refunded });
  }
  const launches = Math.max(state.loops?.['code-review-launch'] || 0, legacyReceipts);
  for (let i = tickets.filter(t => !t.refunded).length; i < launches; i++) {
    const slot = obligations.find(o => reviewRole(o.role) && !o.launched) || { role: 'code-reviewer', reservation: null };
    if (!obligations.includes(slot)) obligations.push(slot);
    slot.launched = true;
  }
  const workers = Object.entries(state.workers || {});
  for (const [id, worker] of workers) {
    const compatible = o => worker?.role == null || worker.role === o.role || reviewRole(worker.role) && reviewRole(o.role);
    const matching = obligations.filter(o => !o.worker && !o.refunded && compatible(o));
    const terminal = ['done', 'failed', 'stopped'].includes(worker?.status);
    // A lone remaining slot is not proof when older attempts also existed.
    // Legacy terminal reviews without an explicit identity require one dispatch,
    // one launch and one worker, irrespective of their recorded clock values.
    const soleReview = obligations.filter(compatible).length === 1 && workers.length === 1 &&
      matching[0]?.dispatch && matching[0]?.launched;
    const slot = obligations.find(o => !o.worker && o.reservation && o.reservation === worker?.reviewReservation) ||
      (!worker?.reviewReservation && matching.length === 1 &&
        (!terminal || !reviewRole(matching[0].role) || soleReview) ? matching[0] : null);
    if (slot) {
      slot.worker = id;
      if (slot.reservation && worker) worker.reviewReservation = slot.reservation;
    }
  }
  return obligations;
}

function countDispatchUnlocked(repo, run, role, now = new Date().toISOString(), { reservation } = {}) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  if (!/^[a-z-]+$/.test(role || '')) throw new Error('ROLE_INVALID');
  { const q = openQuestionsReason(repo, run); if (q) throw new Error(`QUESTIONS_OPEN: ${q}; no worker is dispatched while a question is open`); }
  const dir = reviewStateDirectory(repo, run);
  mkdirSync(dir, { recursive: true });
  const state = readState(repo, run) || { run, task: '', gates: {}, history: [] };
  assertTreeAdmission(state);
  assertActive(state, repo, run);
  assertPlanAcknowledged(state, repo, run);
  const obligations = closureObligations(state);
  if (reservation && (!reviewRole(role) || obligations.some(o => o.reservation === reservation || o.id === reservation))) throw new Error('REVIEW_RESERVATION_USED');
  const kind = ['plan-reviewer', 'reviewer-plan'].includes(role) ? 'plan-review' : ['code-reviewer', 'reviewer', 'reviewer-opus'].includes(role) ? 'code-review' : null;
  if (kind) { consumeEntry(repo, run, state, kind, dir); state.reviewRound = reviewRound(state) + 1; state.finished = false; }
  state.dispatches = { ...(state.dispatches || {}), [role]: ((state.dispatches || {})[role] || 0) + 1 };
  state.closureObligations = [...obligations, { id: reservation || randomUUID(), role, dispatch: true, reservation: reservation || null, reportRequired: true }];
  state.updatedAt = now;
  saveState(join(dir, 'state.json'), state);
  return state.dispatches;
}
export function countDispatch(repo, run, ...args) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  return withStateLock(repo, run, () => countDispatchUnlocked(repo, run, ...args), reviewStateDirectory(repo, run));
}

const reviewReceiptFiles = (repo, run) => [
  join(runsDir(repo), run, 'CODE_REVIEW_ROUNDS.jsonl'),
  join(repo, 'trioharness-direct-runs', run, 'CODE_REVIEW_ROUNDS.jsonl')
];
function completedReviews(receiptFiles) {
  const completed = new Map();
  for (const path of new Set(receiptFiles)) if (existsSync(path)) {
    readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).forEach((line, i) => {
      const entry = JSON.parse(line);
      if (entry.status === 'completed') completed.set(entry.output ? resolve(entry.output) : `${path}:${i}`, entry);
    });
  }
  return completed;
}

// Dispatch reserves a paid round; launch claims that reservation or reserves one itself.
// Both counters live under the same state lock, including failed paid attempts.
export function reserveReviewLaunch(repo, run, { directory = join(runsDir(repo), run), legacyState, receiptFiles = [...reviewReceiptFiles(repo, run), join(directory, 'CODE_REVIEW_ROUNDS.jsonl')], reservation = randomUUID(), worker, output } = {}) {
  return withStateLock(repo, run, () => {
    directory = reviewStateDirectory(repo, run, directory);
    const file = join(directory, 'state.json');
    const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : legacyState || { run, task: '', gates: {}, history: [] };
    assertActive(state, repo, run);
    assertPlanAcknowledged(state, repo, run);
    const q = openQuestionsReason(repo, run); if (q) throw new Error(`QUESTIONS_OPEN: ${q}`);
    const completed = completedReviews(receiptFiles);
    const obligations = closureObligations(state, [...completed.values()].filter(r => !r.reservation).length);
    let obligation = obligations.find(o => o.reservation === reservation || o.id === reservation);
    if (obligation && (obligation.launched || obligation.refunded || ['done', 'failed', 'stopped'].includes(state.workers?.[obligation.worker]?.status))) throw new Error('REVIEW_RESERVATION_USED');
    if (!obligation) {
      const pending = obligations.filter(o => reviewRole(o.role) && !o.reservation && !o.launched && !o.refunded &&
        !['done', 'failed', 'stopped'].includes(state.workers?.[o.worker]?.status) && (!worker || !o.worker || o.worker === worker));
      if (!worker && pending.length > 1 && pending.some(o => o.worker)) throw new Error('REVIEW_WORKER_REQUIRED: identify the dispatched worker');
      obligation = pending.find(o => o.worker === worker) || pending[0];
    }
    if (obligation && (!reviewRole(obligation.role) || worker && obligation.worker && obligation.worker !== worker)) throw new Error('REVIEW_RESERVATION_MISMATCH');
    if (![state.loops?.['code-review-launch'] ?? 0, state.loops?.['code-review'] ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('LOOP_COUNTER_INVALID');
    const launched = Math.max(state.loops?.['code-review-launch'] ?? 0, completed.size);
    const reserved = Math.max(state.loops?.['code-review'] ?? 0, completed.size);
    if (![launched, reserved].every(n => Number.isSafeInteger(n) && n >= 0) || launched > reserved) throw new Error('LOOP_COUNTER_INVALID');
    state.loops = { ...state.loops, 'code-review': reserved, 'code-review-launch': launched };
    const charged = launched >= reserved;
    if (charged) {
      consumeEntry(repo, run, state, 'code-review', directory);
      state.reviewRound = reviewRound(state) + 1;
    }
    state.loops['code-review-launch'] = launched + 1;
    if (!obligation) { obligation = { id: reservation, role: 'code-reviewer' }; obligations.push(obligation); }
    state.closureObligations = obligations;
    const now = new Date().toISOString();
    Object.assign(obligation, { reservation, launched: true, launchedAt: now, reportRequired: true, refunded: false, ...(output ? { output: resolve(output) } : {}) });
    if (worker) obligation.worker = worker;
    const registered = state.workers?.[obligation.worker];
    if (registered?.status === 'running' && !registered.reviewReservation) { registered.reviewReservation = reservation; registered.obligationId = obligation.id || reservation; }
    state.closureObligations = obligations;
    appendRunHistory(state, { at: now, reviewLaunch: { id: reservation, charged, refunded: false } });
    state.finished = false; state.updatedAt = now;
    saveState(file, state);
    return launched + 1;
  }); // One coordinator/run lock, independent of the receipt/state layout.
}
// Release only a caller-proven failure before any model work. The ticket makes
// retries idempotent and distinguishes charged entries from dispatch credit.
export function releaseReviewLaunch(repo, run, reservation, { directory = join(runsDir(repo), run) } = {}) {
  return withStateLock(repo, run, () => {
    directory = reviewStateDirectory(repo, run, directory);
    const file = join(directory, 'state.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const obligations = closureObligations(state);
    const ticket = obligations.find(o => o.launched && o.reservation === reservation);
    if (!ticket || ticket.refunded) return false;
    if (!(state.loops?.['code-review-launch'] > 0)) throw new Error('LOOP_COUNTER_INVALID');
    state.loops['code-review-launch']--;
    state.loops['code-review']--; // Restore the round even when dispatch supplied it.
    ticket.refunded = true;
    const worker = state.workers?.[ticket.worker];
    if (worker?.reviewReservation === reservation) delete worker.reviewReservation;
    state.closureObligations = obligations;
    const event = state.history?.findLast(h => h.reviewLaunch?.id === reservation)?.reviewLaunch;
    if (event) event.refunded = true;
    state.updatedAt = new Date().toISOString(); saveState(file, state);
    return true;
  });
}

// validate is synchronous and runs before persistence under the same lock, so concurrent
// submissions cannot race a churn check. Network calls belong outside this lock.
// A renewal buys a judgement, never an acceptance. The script's card registration is
// separate from the answer record, so a caller-created lookalike cannot grant credit.
function budgetCardAnswered(state, repo, run, digest, set) {
  const issued = state.planBudgetCard;
  const card = readSets(repo, run).find(s => s.id === set);
  return issued?.run === run && issued.inputSha256 === digest && issued.set === set &&
    card?.status === 'answered' && card.answeredVia === 'ui' && !card.settledBy &&
    typeof card.answerQuote === 'string' && Boolean(card.answerQuote.trim()) &&
    card.answers?.jevexc === 'renew' && card.card?.questions?.length === 1 && card.card.questions[0].id === 'jevexc' &&
    createHash('sha256').update(JSON.stringify(card.card)).digest('hex') === issued.cardSha256;
}
function budgetWaitUnlocked(repo, run, state, digest) {
  if (!/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(digest || '')) throw new Error('BUDGET_RENEWAL_INPUT: exact plan digest required');
  if (state.awaitingBudget && state.awaitingBudget.inputSha256 !== digest) throw new Error('BUDGET_RENEWAL_INPUT: waiting for a different plan input');
  state.status = 'awaiting-budget';
  state.awaitingBudget = { inputSha256: digest, reason: 'LOOP_CAP:jev-plan', at: new Date().toISOString() };
  delete state.awaitingException;
  state.finished = false; state.next = 'Owner renewal card for this exact plan input, or park';
  state.updatedAt = state.awaitingBudget.at;
  saveState(join(runsDir(repo), run, 'state.json'), state);
}
function unavailableAtCap(state, digest) {
  return state.status === 'awaiting-exception' && state.awaitingException?.inputSha256 === digest &&
    state.planOutcomes?.at(-1)?.verdict === 'unavailable' &&
    !(state.planOutcomes || []).some(o => o.verdict === 'revise' && o.inputSha256 === digest);
}
export function preparePlanBudgetRenewal(repo, run, digest) {
  return withStateLock(repo, run, () => {
    const state = readState(repo, run); if (!state) throw new Error('RUN_UNKNOWN');
    if (state.status?.startsWith('parked:')) throw new Error('RUN_PARKED');
    if (state.planBudgetRenewal) throw new Error('BUDGET_RENEWAL_USED: one renewal per run');
    if ((state.loops?.['jev-plan'] || 0) !== LOOP_CAPS['jev-plan'] ||
        !(state.status === 'awaiting-budget' || unavailableAtCap(state, digest))) throw new Error('BUDGET_RENEWAL_NOT_AVAILABLE');
    budgetWaitUnlocked(repo, run, state, digest);
    return state;
  });
}
export function grantPlanBudgetRenewal(repo, run, digest, set) {
  return withStateLock(repo, run, () => {
    const state = readState(repo, run); if (!state) throw new Error('BUDGET_RENEWAL_NOT_GRANTED');
    if (state.status?.startsWith('parked:')) throw new Error('RUN_PARKED');
    if (state.planBudgetRenewal) throw new Error('BUDGET_RENEWAL_USED: one renewal per run');
    if (state.status !== 'awaiting-budget' || state.awaitingBudget?.inputSha256 !== digest ||
        !budgetCardAnswered(state, repo, run, digest, set)) throw new Error('BUDGET_RENEWAL_NOT_GRANTED: script-created card and owner UI answer required');
    const card = readSets(repo, run).find(s => s.id === set);
    const entry = { kind: 'budget-renewal', run, gate: 'plan', inputSha256: digest, set,
      at: new Date().toISOString(), answeredVia: card.answeredVia, quote: card.answerQuote };
    state.planBudgetRenewal = entry; state.updatedAt = entry.at;
    saveState(join(runsDir(repo), run, 'state.json'), state);
    return entry;
  });
}
export function reserveAttempt(repo, run, gate, validate = () => {}, submission, digest) {
  if (gate !== 'plan') throw new Error('ATTEMPT_GATE: only plan submissions are counted');
  return withStateLock(repo, run, () => {
    const state = readState(repo, run);
    if (!state) throw new Error('RUN_UNKNOWN');
    if (state.status?.startsWith('parked:')) throw new Error(`RUN_PARKED: ${state.status}`);
    if (digest !== undefined && !/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(digest)) throw new Error('BUDGET_RENEWAL_INPUT: exact plan digest required');
    const n = state.loops?.['jev-plan'] ?? 0;
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('LOOP_COUNTER_INVALID');
    const capped = digest !== undefined && n >= LOOP_CAPS['jev-plan'];
    if (capped && state.planBudgetRenewal?.consumedAt) {
      parkUnlocked(repo, run, state, 'LOOP_CAP:jev-plan'); throw new Error('LOOP_CAP:jev-plan');
    }
    assertBudgetChoice(state, repo, run);
    if (!capped || (state.status !== 'awaiting-budget' && !unavailableAtCap(state, digest))) assertActive(state, repo, run);
    const q = openQuestionsReason(repo, run);
    if (q) throw new Error(`QUESTIONS_OPEN: ${q}; no submission while a question is open`);
    const previous = state.attempts?.plan === undefined ? 0 : state.attempts.plan;
    if (!Number.isSafeInteger(previous) || previous < 0 || previous === Number.MAX_SAFE_INTEGER) throw new Error('ATTEMPT_INVALID: plan counter must permit a safe integer increment');
    const attempt = previous + 1;
    validate(attempt);
    if (capped) {
      const renewal = state.planBudgetRenewal;
      if (!renewal) {
        budgetWaitUnlocked(repo, run, state, digest);
        throw new Error('LOOP_CAP:jev-plan: awaiting exact-input owner renewal');
      }
      if (renewal.inputSha256 !== digest) throw new Error('BUDGET_RENEWAL_INPUT: renewal covers a different plan input');
      if (renewal.run !== run || !budgetCardAnswered(state, repo, run, digest, renewal.set)) throw new Error('BUDGET_RENEWAL_NOT_GRANTED');
      if (submission === undefined) throw new Error('BUDGET_RENEWAL_TRACKED_REQUIRED: use jev.mjs plan with attempt flags');
      state.planBudgetRenewal = { ...renewal, consumedAt: new Date().toISOString(), ...(submission ? { submission } : {}) };
      state.loops['jev-plan'] = n + 1; state.status = 'active';
      delete state.awaitingBudget; delete state.awaitingException;
    } else consumeEntry(repo, run, state, 'jev-plan');
    // Manual callers settle their verdict with the normal gate checkpoint; only the
    // automatic Jev outcome hook creates a pending obligation, bound to this submission.
    if (submission !== undefined) {
      if (!/^[a-f0-9-]{36}$/.test(submission) || (state.planPendingSubmissions || []).some(p => p.submission === submission)) throw new Error('PLAN_SUBMISSION_INVALID');
      state.planPendingOutcomes = (state.planPendingOutcomes || 0) + 1;
      state.planPendingSubmissions = [...(state.planPendingSubmissions || []), { submission, attempt, ...(digest ? { inputSha256: digest } : {}) }];
    }
    state.attempts = { ...(state.attempts || {}), plan: attempt };
    // A manual reservation is settled once by the normal plan checkpoint. An
    // automated submission has its own UUID and cannot be settled by a manual set.
    if (submission === undefined) {
      state.loops['jev-plan-manual'] = state.loops['jev-plan'];
      if (['failed', 'blocked'].includes(state.gates['plan-jev']?.status)) state.gates['plan-jev'] = { status: 'in_progress', at: new Date().toISOString() };
    }
    else delete state.loops['jev-plan-manual'];
    state.finished = false;
    state.updatedAt = new Date().toISOString();
    saveState(join(runsDir(repo), run, 'state.json'), state);
    return attempt;
  });
}

// A passing plan ends the consecutive non-passing streak. Keep the same refusals as reservation.
export function resetAttempt(repo, run, gate, { recover = false, reason } = {}) {
  if (gate !== 'plan') throw new Error('ATTEMPT_GATE: only plan submissions are counted');
  return withStateLock(repo, run, () => {
    const state = readState(repo, run);
    if (!state) throw new Error('RUN_UNKNOWN');
    if (state.status === 'awaiting-exception') throw new Error('AWAITING_EXCEPTION: reset cannot grant an exception');
    assertActive(state, repo, run);
    const q = openQuestionsReason(repo, run);
    if (q) throw new Error(`QUESTIONS_OPEN: ${q}; no submission while a question is open`);
    const previous = state.attempts?.plan === undefined ? 0 : state.attempts.plan;
    if (!Number.isSafeInteger(previous) || previous < 0 || previous === Number.MAX_SAFE_INTEGER) throw new Error('ATTEMPT_INVALID: plan counter must permit a safe integer increment');
    if (recover) {
      if (typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason)) throw new Error('PLAN_RECOVERY_REASON_REQUIRED');
      const pending = state.planPendingOutcomes || 0;
      if (!Number.isSafeInteger(pending) || pending < 1) throw new Error('PLAN_RECOVERY_NONE');
      const at = new Date().toISOString();
      state.planRecoveries = [...(state.planRecoveries || []), { at, reason, pending, submissions: state.planPendingSubmissions || [], previousGate: state.gates?.['plan-jev'] }];
      state.planPendingOutcomes = 0; state.planPendingSubmissions = [];
      state.gates['plan-jev'] = { status: 'failed', at, evidence: `Lost outcome: ${reason}; ${pending} submission(s) abandoned, lifetime budget retained` };
      state.planAcceptanceInvalidated = true;
      state.finished = false;
    }
    state.attempts = { ...(state.attempts || {}), plan: 0 };
    if (recover && state.loops) delete state.loops['jev-plan-manual'];
    if (recover && (state.loops?.['jev-plan'] || 0) >= LOOP_CAPS['jev-plan']) {
      parkUnlocked(repo, run, state, 'PLAN_OUTCOME_LOST_AT_CAP');
      return 0;
    }
    state.updatedAt = new Date().toISOString();
    saveState(join(runsDir(repo), run, 'state.json'), state);
    return 0;
  });
}

function setGateUnlocked(repo, run, { gate, status, next, note, task }, now = new Date().toISOString()) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  if (![...GATES, 'audit-check'].includes(gate)) throw new Error(`GATE_UNKNOWN: ${gate} (one of ${GATES.join(', ')})`);
  if (!STATUSES.includes(status)) throw new Error(`STATUS_UNKNOWN: ${status}`);
  // An open question card stops the run: nothing starts or passes until the user answers it. Recording `blocked` or `failed` stays allowed.
  if (status === 'passed' || status === 'in_progress') { const q = openQuestionsReason(repo, run); if (q) throw new Error(`QUESTIONS_OPEN: ${q}; record the gate as blocked and end the turn`); }
  // 2.31: a repo that declares running environments needs the running-ref check before its base gate passes ...
  if (gate === 'base' && status === 'passed') { const r = runningRefReason(repo, run); if (r) throw new Error(`RUNNING_REF_UNRESOLVED: ${r}`); }
  // ... and a run that produced a task branch ends only with nothing uncommitted, unpushed or unaccounted for.
  if (gate === 'learnings' && status === 'passed') { const c = cleanStateReason(repo, run); if (c) throw new Error(`CLEAN_STATE_NOT_REACHED: ${c}`); }
  if (gate === 'learnings' && status === 'passed') { const l = learningsReason(repo, run); if (l) throw new Error(`LEARNINGS_NOT_RECORDED: ${l}`); }
  const dir = reviewStateDirectory(repo, run);
  mkdirSync(dir, { recursive: true });
  const state = readState(repo, run) || { run, task: task || '', gates: {}, history: [] };
  if (gate === 'audit-check' && status === 'passed') throw new Error('AUDIT_PROVENANCE_REQUIRED: run jev check with audit flags');
  if (gate === 'audit-check' && state.mode !== 'audit') throw new Error('AUDIT_MODE_REQUIRED');
  if (status === 'passed' || status === 'in_progress') assertActive(state, repo, run);
  if ((['passed', 'in_progress'].includes(status) && ['done-jev', 'commit-push', 'deploy-qa'].includes(gate)) || (status === 'passed' && gate === 'learnings')) assertAcceptance(state, repo, run);
  if (gate === 'learnings' && status === 'passed') assertNoOwedWork(state, repo, run);
  if (REVIEW_GATES.includes(gate) && (status === 'in_progress' || (status === 'passed' && !['passed', 'in_progress'].includes(state.gates[gate]?.status)))) { state.reviewRound = reviewRound(state) + 1; state.finished = false; }
  if (gate === 'plan-jev' && status === 'passed') {
    const manual = state.loops?.['jev-plan-manual'];
    const latest = state.planOutcomes?.at(-1);
    const accepted = !state.planAcceptanceInvalidated && ['proceed', 'accepted-exception'].includes(latest?.verdict);
    // Only explicitly identified imported reservations get pre-marker compatibility.
    // New runs never write this marker; a start checkpoint alone authorizes nothing.
    const legacyReservation = !state.planAcceptanceInvalidated && state.legacyPlanReservation === true && !Object.hasOwn(state, 'planOutcomes') &&
      manual === undefined && !state.planRecoveries?.length &&
      !state.history.some(h => h.gate === 'plan-jev' && ['failed', 'blocked'].includes(h.status)) &&
      ((state.attempts?.plan || 0) > 0 || (state.loops?.['jev-plan'] || 0) > 0);
    if (['failed', 'blocked'].includes(state.gates['plan-jev']?.status) ||
        (state.planPendingOutcomes || 0) > 0 || !(accepted || legacyReservation ||
        (Number.isSafeInteger(manual) && manual > 0 && manual === state.loops?.['jev-plan']))) throw new Error('PLAN_PROVENANCE_REQUIRED: reservation or accepted outcome required');
  }
  // A restart must not revive an older acceptance, even after history rolls over.
  // A new manual reservation is separately tracked and cleared by any later failure/outcome.
  if (gate === 'plan-jev' && ['failed', 'blocked'].includes(status)) state.planAcceptanceInvalidated = true;
  if (gate === 'plan-jev' && status !== 'in_progress' && state.loops) delete state.loops['jev-plan-manual'];
  state.createdAt ||= now;
  if (task) state.task = task;
  state.gates[gate] = { status, at: now, ...(note ? { note } : {}) };
  if (state.history.some(h => h.reviewLaunch)) state.closureObligations = closureObligations(state);
  appendRunHistory(state, { gate, status, at: now });
  state.current = gate;
  if (next !== undefined) state.next = next;
  // The learning step is the last gate of every tier; passing it closes the run for reclaim/cleanup —
  // but only an accepted run with nothing failed or blocked. A parked run stays open however it is annotated.
  if (gate === 'learnings' && status === 'passed') {
    assertClosure(repo, run, state);
    const bad = Object.entries(state.gates).filter(([, g]) => ['failed', 'blocked'].includes(g.status)).map(([n]) => n);
    const open = openWorktreeReason(state) || openJobsReason(repo, run);
    // 2.36 autopilot: gates parked for the final approval do not stop a finished run; they are recorded so the report lists them.
    { const dg = deferredSets(repo, run); if (dg.length) state.awaitingApproval = dg.map(d => ({ set: d.id, questions: d.card.questions.map(q => q.question) })); else delete state.awaitingApproval; }
    if (state.gates['done-jev']?.status === 'passed' && !bad.length && !open) { requireBoundary(repo, run, state); state.finished = true; }
    else state.notFinishedBecause = state.gates['done-jev']?.status !== 'passed' ? 'done-jev has not passed' : bad.length ? `gates ${bad.join(', ')} are failed or blocked` : open;
  }
  state.updatedAt = now;
  saveState(join(dir, 'state.json'), state, { allowInvalidatedAudit: ['blocked', 'failed'].includes(status) });
  return state;
}
export function setGate(repo, run, ...args) { return withStateLock(repo, run, () => setGateUnlocked(repo, run, ...args)); }

// A successor picks up a parked run under the state lock. Exclusive TAKEN files
// never replace an earlier pickup; --keep copies NEXT and leaves it available.
export function handoverTaken(repo, run, { by, depth, keep = false, handoff }, now = new Date().toISOString()) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  if (!taskLabel(by)) throw new Error('HANDOVER_BY_INVALID: --by <successor task id>');
  if (handoff !== undefined && !recordId(handoff)) throw new Error('HANDOFF_PICKUP_INVALID');
  const validDepth = value => Number.isInteger(value) && value >= 1 && value <= 5;
  if (depth !== undefined && !validDepth(depth)) throw new Error('HANDOVER_DEPTH: 1-5 (at depth 5 park the run for the user instead of handing over again)');
  const dir = reviewStateDirectory(repo, run), src = join(dir, 'HANDOVER-NEXT.md');
  const resume = state => {
    const h = state?.handoff;
    return h?.takenBy === by && (handoff === undefined || h.handoffId === handoff) && (depth === undefined || depth === h.depth) &&
      typeof h.file === 'string' && /^HANDOVER-TAKEN-\d+\.md$/.test(h.file) && existsSync(join(dir, h.file))
      ? { ...h, resumed: true } : null;
  };
  // A repeated pickup is a read-only observation, including no lock-file write.
  if (!existsSync(src)) {
    const recorded = resume(readState(repo, run));
    if (recorded) return recorded;
  }
  return withStateLock(repo, run, () => {
    const state = readState(repo, run);
    if (!existsSync(src)) {
      const recorded = resume(state); if (recorded) return recorded;
      throw new Error('HANDOVER_NONE: no HANDOVER-NEXT.md in this run');
    }
    if (!state) throw new Error('RUN_UNKNOWN');
    const nextDepth = depth ?? ((state.handoff?.depth ?? 0) + 1);
    if (!validDepth(nextDepth)) throw new Error('HANDOVER_DEPTH: 1-5 (at depth 5 park the run for the user instead of handing over again)');
    if (state.handoff && nextDepth <= state.handoff.depth) throw new Error(`HANDOVER_DEPTH: the previous handoff was depth ${state.handoff.depth}; this one must be higher`);
    const problems = disciplineProblems(state, repo, run);
    if (problems.length) throw new Error(`RECORDS_INVALID: ${problems.join(', ')}`);
    if (handoff === undefined && recordArray(state.handoffs).some(h => h.kind === 'same-repo' && ['sent', 'running'].includes(h.state))) throw new Error('HANDOFF_PICKUP_REQUIRED: specify --handoff <id>');
    const pending = handoff === undefined ? null : (state.handoffs || []).find(h => h.id === handoff);
    if (handoff !== undefined && (!pending || pending.kind !== 'same-repo' || !['sent', 'running'].includes(pending.state))) throw new Error('HANDOFF_PICKUP_INVALID');
    requireBoundary(repo, run, state, dir);
    let sequence = BigInt(now.replace(/[^0-9]/g, '').slice(0, 17).padEnd(17, '0'));
    let taken;
    for (;;) {
      taken = `HANDOVER-TAKEN-${String(sequence).padStart(17, '0')}.md`;
      try {
        if (keep) copyFileSync(src, join(dir, taken), constants.COPYFILE_EXCL);
        else linkSync(src, join(dir, taken));
        break;
      } catch (e) { if (e.code !== 'EEXIST') throw e; sequence += 1n; }
    }
    // Completion belongs to the consuming successor, never to a kept copy or a manual set.
    if (!keep) {
      unlinkSync(src);
      delete state.reportNext;
      if (pending) { pending.state = 'done'; pending.result = taken; }
    }
    if (state.plans?.length) state.planAck = null;
    state.handoff = { takenBy: by, depth: nextDepth, at: now, file: taken, ...(keep ? { kept: true } : {}), ...(handoff === undefined ? {} : { handoffId: handoff }) };
    state.updatedAt = now;
    saveState(join(dir, 'state.json'), state);
    return state.handoff;
  }, dir);
}

// Flags a run whose own bookkeeping is unreliable: missing gate records, gates left open, dispatch
// obligations lacking bound report bytes, receipts or dispositions, and missing review rounds.
export function auditRun(repo, run, options = {}) {
  return auditState(repo, run, readState(repo, run), options);
}
function auditState(repo, run, state, { workerFiles = null, hasReviewRounds = null } = {}) {
  if (!state) return { run, ok: false, problems: ['no state.json recorded'] };
  const problems = [];
  const open = Object.entries(state.gates || {}).filter(([, g]) => g.status === 'in_progress').map(([k]) => k);
  if (open.length) problems.push(`gates left in progress: ${open.join(', ')}`);
  const recorded = Object.keys(state.gates || {});
  const required = requiredGates(state, 'audit');
  if (state.mode === 'audit') {
    try { assertAuditClean(state, repo, run); assertAuditAcceptance(state, repo, run); }
    catch (e) { problems.push(e.message); }
  }
  if (!GATES.slice(1).some(g => recorded.includes(g))) required.unshift('shape'); // older runs may predate this checkpoint
  for (const g of required) if (!recorded.includes(g)) problems.push(`gate never recorded: ${g}`);
  const dispatched = Object.values(state.dispatches || {}).reduce((a, b) => a + b, 0);
  const workers = Object.entries(state.workers || {});
  const terminal = workers.filter(([, w]) => ['done', 'failed', 'stopped'].includes(w?.status));
  const unfinished = workers.filter(([, w]) => !['done', 'failed', 'stopped'].includes(w?.status));
  const receipts = reviewReceiptFiles(repo, run);
  let completed = new Map();
  try { completed = completedReviews(receipts); } catch { problems.push('CODE_REVIEW_ROUNDS.jsonl unreadable'); }
  let legacyReceipts = [...completed.values()].filter(r => !r.reservation).length;
  const obligations = closureObligations(state, legacyReceipts).filter(o => !o.refunded);
  const reportHashes = new Set();
  const reports = new Set(obligations.filter(o => {
    if (o.sha256) {
      if (reportHashes.has(o.sha256)) { problems.push(`REPORT_ALREADY_BOUND: ${o.sha256}`); return false; }
      reportHashes.add(o.sha256);
    }
    try { const current = readReport(o.reportPath, reviewStateDirectory(repo, run)); return current.size === o.size && current.sha256 === o.sha256; }
    catch { return false; }
  }));
  const files = workerFiles ?? reports.size;
  const missing = obligations.filter(o => {
    if (reports.has(o) || ['failed', 'stopped'].includes(o.disposition?.status)) return false;
    // Pre-binding terminal records remain explicit failure dispositions only for
    // their own worker/reservation. Success never infers a report from a name.
    if (terminal.some(([id, w]) => o.worker === id && ['failed', 'stopped'].includes(w.status) &&
      (!o.reservation || o.reservation === w.reviewReservation))) return false;
    if (!reviewRole(o.role)) return true;
    const identity = o.reservation || o.id;
    if (identity) return ![...completed.values()].some(r => r.reservation === identity);
    return !(legacyReceipts-- > 0); // One imported receipt per unidentified legacy obligation.
  });
  if (missing.length) problems.push(`dispatch count ${dispatched} disagrees with ${files} worker result file(s) (${missing.length} unsatisfied obligation(s))`);
  if (unfinished.length) problems.push(`workers running or unknown: ${unfinished.map(([id]) => id).join(', ')}`);
  // Identity is optional: partial registration cannot identify every dispatch.
  if (workers.length === dispatched && terminal.length !== dispatched) problems.push(`dispatch count ${dispatched} disagrees with ${terminal.length} terminal worker record(s)`);
  const rounds = hasReviewRounds ?? receipts.some(path => existsSync(path));
  if (!rounds && (state.gates || {})['review']) problems.push('review gate recorded but CODE_REVIEW_ROUNDS.jsonl missing');
  const records = disciplineProblems(state, repo, run);
  problems.push(...records);
  if (!records.length) for (const h of owedHandoffs(state)) problems.push(`handoff unresolved: ${h.id} (${h.state})`);
  return { run, ok: !problems.length, problems, gates: recorded.length, dispatches: state.dispatches || {}, workerFiles: files };
}

function assertClosure(repo, run, state) {
  const audit = auditState(repo, run, state);
  const problems = state.dispatches === undefined ? audit.problems.filter(p => !p.startsWith('gate never recorded:')) : audit.problems;
  if (problems.length) throw new Error(`RUN_AUDIT_UNCLEAN: ${problems.join('; ')}`);
}

// A dispatched worker with a deadline. A worker that was stopped, or is silent past its deadline, counts as failed:
// nothing will resume the lead for it.
function bindWorkerObligation(state, id, role, reviewReservation) {
  const obligations = closureObligations(state);
  const available = obligations.filter(o => (!o.worker || o.worker === id) && !o.refunded && (role == null || o.role === role || reviewRole(role) && reviewRole(o.role)));
  const reservation = reviewReservation || id;
  let obligation = available.find(o => o.reservation === reservation || o.id === reservation);
  if (reviewReservation && !obligation) throw new Error('REVIEW_RESERVATION_UNKNOWN');
  if (!obligation) {
    const pending = available.filter(o => !o.reservation);
    obligation = pending[0];
    // A sole launched dispatch can be identified without choosing by order.
    if (!obligation && available.length === 1 && available[0].dispatch) obligation = available[0];
  }
  if (obligation) {
    obligation.worker = id;
    state.workers[id].obligationId = obligation.id ||= obligation.reservation || randomUUID();
    if (obligation.reservation) state.workers[id].reviewReservation = obligation.reservation;
  }
  state.closureObligations = obligations;
}

function registerWorkerUnlocked(repo, run, { id, role, deadlineMin = 30, reviewReservation }, now = new Date().toISOString()) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  if (!/^[A-Za-z0-9._-]+$/.test(id || '')) throw new Error('WORKER_ID_INVALID');
  if (!Number.isFinite(deadlineMin) || deadlineMin <= 0 || deadlineMin > 24 * 60) throw new Error('DEADLINE_INVALID: minutes between 1 and 1440');
  { const q = openQuestionsReason(repo, run); if (q) throw new Error(`QUESTIONS_OPEN: ${q}; no worker is dispatched while a question is open`); }
  const dir = reviewStateDirectory(repo, run); mkdirSync(dir, { recursive: true });
  const state = readState(repo, run) || { run, task: '', gates: {}, history: [] };
  assertTreeAdmission(state);
  assertActive(state, repo, run);
  assertPlanAcknowledged(state, repo, run);
  state.closureObligations = closureObligations(state);
  if (state.workers?.[id]) {
    // Retain worker records, never rename reports or launcher sidecars.
    let attempt = 1;
    while (Object.hasOwn(state.workers, `${id}.attempt-${attempt}`)) attempt++;
    const archived = `${id}.attempt-${attempt}`, previous = state.workers[id];
    state.workers[archived] = previous;
    for (const o of state.closureObligations) if (o.worker === id &&
      (previous.obligationId ? (o.id || o.reservation) === previous.obligationId : !o.reservation || o.reservation === previous.reviewReservation)) o.worker = archived;
  }
  state.workers = { ...(state.workers || {}), [id]: { role: role || null, at: now, deadlineAt: new Date(Date.parse(now) + deadlineMin * 60000).toISOString(), status: 'running' } };
  bindWorkerObligation(state, id, role, reviewReservation);
  state.updatedAt = now;
  saveState(join(dir, 'state.json'), state);
  return state.workers[id];
}
export function registerWorker(repo, run, ...args) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  return withStateLock(repo, run, () => registerWorkerUnlocked(repo, run, ...args), reviewStateDirectory(repo, run));
}
function readReport(path, runDir) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('REPORT_REQUIRED: --report <path>');
  const reportPath = resolve(path);
  if (!realpathSync.native(reportPath).startsWith(realpathSync.native(runDir) + sep)) throw new Error('REPORT_OUTSIDE_RUN');
  const bytes = readFileSync(reportPath);
  if (!bytes.length || !bytes.toString('utf8').trim()) throw new Error('REPORT_EMPTY');
  return { reportPath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}
function recordDisposition(obligation, status, report, now, legacyPath, obligations, runDir) {
  if (!['done', 'failed', 'stopped'].includes(status)) throw new Error('WORKER_STATUS_UNKNOWN: done|failed|stopped');
  let binding = {};
  if (report !== undefined) binding = readReport(report, runDir);
  else if (status === 'done') {
    if (obligation.reportRequired || !legacyPath) throw new Error('REPORT_REQUIRED: --report <path>');
    if (lstatSync(legacyPath).isSymbolicLink()) throw new Error('REPORT_SYMLINK');
    // Native realpath returns the actual basename even on case-insensitive hosts.
    if (basename(realpathSync.native(legacyPath)) !== basename(legacyPath)) throw new Error('REPORT_CASE_MISMATCH');
    binding = readReport(legacyPath, runDir);
  }
  if (binding.sha256 && obligations.some(o => o !== obligation && o.sha256 === binding.sha256)) throw new Error('REPORT_ALREADY_BOUND');
  obligation.id ||= obligation.reservation || randomUUID();
  Object.assign(obligation, binding, { disposition: { status, at: now } });
}
function finishWorkerUnlocked(repo, run, id, status, now = new Date().toISOString(), { report } = {}) {
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  if (!/^[A-Za-z0-9._-]+$/.test(id || '')) throw new Error('WORKER_ID_INVALID');
  if (!['done', 'failed', 'stopped'].includes(status)) throw new Error('WORKER_STATUS_UNKNOWN: done|failed|stopped');
  const state = readState(repo, run);
  if (!state?.workers || !Object.hasOwn(state.workers, id)) {
    const dispatched = Object.values(state?.dispatches || {}).reduce((a, b) => a + b, 0);
    if (!state || status === 'done' || Object.keys(state.workers || {}).length >= dispatched) throw new Error(`WORKER_UNKNOWN: ${id}`);
    state.workers = { ...state.workers, [id]: { role: null, at: now } };
    bindWorkerObligation(state, id, null);
  }
  state.closureObligations = closureObligations(state);
  const worker = state.workers[id];
  const matching = state.closureObligations.filter(o => !o.refunded && (worker.obligationId
    ? (o.id || o.reservation) === worker.obligationId
    : o.worker === id && (!worker.reviewReservation || o.reservation === worker.reviewReservation)));
  if (matching.length !== 1 && (status === 'done' || report !== undefined)) throw new Error('WORKER_OBLIGATION_UNKNOWN: use --review-reservation');
  if (matching.length === 1) {
    recordDisposition(matching[0], status, report, now, join(reviewStateDirectory(repo, run), 'workers', `${id}.md`), state.closureObligations, reviewStateDirectory(repo, run));
    worker.obligationId = matching[0].id;
  }
  Object.assign(worker, { status, endedAt: now });
  state.updatedAt = now;
  saveState(join(reviewStateDirectory(repo, run), 'state.json'), state);
  return worker;
}
export function finishWorker(repo, run, ...args) { return withStateLock(repo, run, () => finishWorkerUnlocked(repo, run, ...args)); }

function finishReviewReservation(repo, run, reservation, status, report) {
  if (!/^[A-Za-z0-9._-]+$/.test(reservation || '')) throw new Error('REVIEW_RESERVATION_INVALID');
  return withStateLock(repo, run, () => {
    const state = readState(repo, run);
    if (!state) throw new Error('RUN_UNKNOWN');
    const obligations = closureObligations(state);
    const obligation = obligations.find(o => !o.refunded && o.reservation === reservation);
    if (!obligation) throw new Error('REVIEW_RESERVATION_UNKNOWN');
    const now = new Date().toISOString();
    recordDisposition(obligation, status, report, now, obligation.worker && join(reviewStateDirectory(repo, run), 'workers', `${obligation.worker}.md`), obligations, reviewStateDirectory(repo, run));
    const worker = state.workers?.[obligation.worker];
    if (worker?.reviewReservation === reservation) Object.assign(worker, { status, endedAt: now, obligationId: obligation.id });
    state.closureObligations = obligations;
    state.updatedAt = now;
    saveState(join(reviewStateDirectory(repo, run), 'state.json'), state);
    return obligation.disposition;
  });
}

// Newest file or folder time under dir (bounded depth and count), so nested packets and logs count as signs of life.
const newestMtime = (dir, depth = 3, budget = { n: 2000 }) => {
  let t = 0;
  let names = []; try { names = readdirSync(dir); } catch { return 0; }
  for (const f of names) {
    if (budget.n-- <= 0) break;
    try { const st = statSync(join(dir, f)); t = Math.max(t, st.mtimeMs); if (st.isDirectory() && depth > 0) t = Math.max(t, newestMtime(join(dir, f), depth - 1, budget)); } catch { /* gone */ }
  }
  return t;
};

// Runs that look dead: not finished, not parked on purpose (HANDOVER-NEXT.md), no live job or worker, no sign of life for
// `minutes`. A running worker past its deadline, or a lost job, is reported at once whatever the idle time.
export function stalledRuns(repo, { minutes = 20, now = Date.now() } = {}) {
  const dir = runsDir(repo); const out = [];
  if (!existsSync(dir)) return out;
  for (const run of readdirSync(dir)) {
    try {
      let state; try { state = readState(repo, run); } catch { out.push({ run, gate: null, idleMin: null, reasons: ['state.json unreadable'] }); continue; }
      if (!state || state.finished) continue;
      const next = join(dir, run, 'HANDOVER-NEXT.md');
      if (existsSync(next)) {
        const h = state.handoff;
        if (h?.kept !== true) continue; // no kept pickup: parked on purpose
        if (typeof h.file === 'string' && /^HANDOVER-TAKEN-\d+\.md$/.test(h.file)) {
          try {
            if (!readFileSync(next).equals(readFileSync(join(dir, run, h.file)))) continue; // new NEXT bytes park the run again
          } catch { /* unreadable evidence cannot prove parking; inspect for a stall */ }
        }
      }
      const waitingForUser = Boolean(openQuestionsReason(repo, run)); // a question card is open: idle is expected, overdue workers and lost jobs are still reported
      const reasons = [];
      const workers = Object.entries(state.workers && typeof state.workers === 'object' ? state.workers : {}).filter(([, w]) => w && typeof w === 'object' && w.status === 'running');
      // a worker with no readable deadline is overdue, never immortal
      const overdue = workers.filter(([, w]) => !(Date.parse(w.deadlineAt) > now)).map(([id]) => id);
      if (overdue.length) reasons.push(`worker(s) past their deadline: ${overdue.join(', ')} (treat as failed and take over)`);
      let jobs = []; try { jobs = readJobs(repo, run, now); } catch { /* none */ }
      const lost = jobs.filter(j => j.status === 'lost').map(j => j.name);
      if (lost.length) reasons.push(`job(s) lost their supervisor: ${lost.join(', ')} (rerun in the foreground)`);
      const live = jobs.some(j => j.status === 'running' || j.status === 'queued') || workers.some(([id]) => !overdue.includes(id));
      const last = Math.min(now, Math.max(Date.parse(state.updatedAt || 0) || 0, newestMtime(join(dir, run)))); // a future timestamp (clock skew) never hides a stall
      const idleMin = Math.floor((now - last) / 60000);
      if (!live && !waitingForUser && idleMin >= minutes) reasons.push(`no sign of life for ${idleMin} min at gate ${state.current || 'unknown'}${state.next ? ` (next: ${state.next})` : ''}`);
      if (reasons.length) out.push({ run, gate: state.current || null, idleMin, reasons });
    } catch (e) { out.push({ run, gate: null, idleMin: null, reasons: [`could not be inspected: ${e.message}`] }); }
  }
  return out;
}

// Every worktree a run creates is registered here the moment it is cut, so closeout can find all of them
// (writer, reviewers, slices) even across several repositories' runs. Idempotent on path.
function registerWorktreeUnlocked(repo, run, { path, branch = null, role = 'writer' }, now = new Date().toISOString()) {
  { const q = openQuestionsReason(repo, run); if (q) throw new Error(`QUESTIONS_OPEN: ${q}; no worktree is registered while a question is open`); }
  if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
  if (!path) throw new Error('WORKTREE_PATH_REQUIRED');
  if (!['writer', 'reviewer', 'scratch', 'slice'].includes(role)) throw new Error(`WORKTREE_ROLE_UNKNOWN: ${role}`);
  const dir = reviewStateDirectory(repo, run);
  mkdirSync(dir, { recursive: true });
  let registrations;
  try { registrations = registrationsForTree(existsSync(path) ? mainCheckout(path) : mainCheckout(repo), path, repo); }
  catch (error) {
    if (error.reason === 'WORKTREE_REGISTRATION_AMBIGUOUS') throw error;
    if (error.run) throw new Error(`WORKTREE_REGISTRATION_UNKNOWN: could not read registration state for run ${error.run}`);
    throw new Error('WORKTREE_REGISTRATION_UNKNOWN: could not list run registrations in this ledger');
  }
  const state = readState(repo, run) || { run, task: '', gates: {}, history: [] };
  assertActive(state, repo, run);
  if (state.finished) throw new Error(`RUN_FINISHED: run ${run} is finished; register trees under a new run id`);
  const file = normPath(join(dir, 'state.json'));
  if (registrations.some(entry => entry.run === run && normPath(entry.file) !== file)) {
    throw new Error(`WORKTREE_REGISTRATION_AMBIGUOUS: path is registered to run ${run} in another ledger`);
  }
  const owner = registrations.find(entry => entry.run !== run && entry.state.finished !== true);
  if (owner) throw new Error(`WORKTREE_ALREADY_REGISTERED: path is registered to unfinished run ${owner.run}`);
  const list = (state.worktrees || []).filter(w => normPath(w.path) !== normPath(path));
  list.push({ path, branch, role, at: now });
  state.worktrees = list;
  assertAuditClean(state, repo, run);
  const closedDetails = (state.closeout?.details || []).filter(d => d.status === 'closed' && typeof d.path === 'string' &&
    normPath(d.path) !== normPath(path) && !existsSync(d.path));
  if (closedDetails.length) {
    // Registration reopens the full closeout without forgetting earlier trees.
    state.closeout = { ...state.closeout, at: now, closed: closedDetails.length, open: Math.max(1, list.length - closedDetails.length), details: closedDetails };
    if (!closeoutHoldReason(state)) state.gates.closeout = { status: 'blocked', at: now, note: 'a newly registered tree reopens the closeout' };
  } else delete state.closeout;
  state.updatedAt = now;
  saveState(join(dir, 'state.json'), state);
  return state.worktrees;
}
function assertTreeAdmission(state) {
  const acquired = [];
  try {
    for (const tree of state.worktrees || []) {
      const lock = tryAcquire(`boundary-${lockNameFor(tree.path)}`, { note: 'worker start admission' });
      if (!lock.acquired) throw new Error('STATE_CHANGED: tree admission reserved');
      acquired.push(lock);
    }
  } finally { for (const lock of acquired) releaseTreeLock(lock.file); }
}
function withWorktreeRegistrationLock(repo, run, path, note, fn, { allowReuse = false } = {}) {
  const name = lockNameFor(path || repo);
  const admission = tryAcquire(`boundary-${name}`, { note: `${note} admission` });
  if (!admission.acquired) throw new Error('STATE_CHANGED: tree admission reserved');
  let lock;
  try {
    lock = tryAcquire(name, { note });
    // reuseTree already owns this lock through its switch + registration operation.
    const reuse = allowReuse && lock.holder?.pid === process.pid && lock.holder?.host === hostname() && lock.holder?.note === 'reuse';
    if (!lock.acquired && !reuse) throw new Error('STATE_CHANGED: tree admission reserved');
    return withStateLock(repo, run, fn);
  } finally { if (lock?.acquired) releaseTreeLock(lock.file); releaseTreeLock(admission.file); }
}

export function registerWorktree(repo, run, ...args) {
  return withWorktreeRegistrationLock(repo, run, args[0]?.path, 'worktree registration',
    () => registerWorktreeUnlocked(repo, run, ...args), { allowReuse: true });
}

function assertWorktreeAbsent(path) {
  try { lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`WORKTREE_PATH_UNKNOWN: could not verify absence of ${path} (${error.code})`);
  }
  throw new Error(`WORKTREE_PATH_EXISTS: ${path}`);
}

function namesReleasePath(question, path) {
  const parts = question.split(/(`[^`]*`|"[^"]*"|'[^']*')/);
  if (parts.some((part, i) => i % 2 === 1 && part.slice(1, -1) === path)) return true;
  const tail = parts.at(-1).trimEnd().replace(/\?$/, '');
  return !/\s/.test(path) && tail.endsWith(path) && /(?:^|\s)$/.test(tail.slice(0, -path.length));
}

function requireReleaseCard(repo, run, state, card, path) {
  if (state.history?.some(entry => entry?.event === 'worktree-release' && entry.card === card)) {
    throw new Error(`WORKTREE_CARD_ALREADY_USED: ${card} has already released a worktree in run ${run}`);
  }
  const set = readSets(repo, run).find(entry => entry.id === card);
  if (set?.status !== 'answered') throw new Error(`WORKTREE_CARD_NOT_ANSWERED: ${card} has no answer in run ${run}`);
  const authorized = typeof set.askedAt === 'string' && Number.isFinite(Date.parse(set.askedAt)) &&
    ['card', 'ui', 'numbered-reply'].includes(set.answeredVia) && Array.isArray(set.card?.questions) &&
    set.card.questions.some(q => {
      const answer = set.answers?.[q?.id];
      const selected = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer;
      return selected === 'release' && Array.isArray(q?.options) && q.options.some(o => o?.id === selected) &&
        typeof q.question === 'string' && namesReleasePath(q.question, path);
    });
  if (!authorized) throw new Error(`WORKTREE_CARD_NOT_AUTHORIZED: ${card} does not authorize release of ${path} in run ${run}`);
}

function releaseWorktree(repo, run, path, card) {
  if (!path) throw new Error('WORKTREE_PATH_REQUIRED: --release requires --path');
  if (!/^Q-\d+$/.test(card || '')) throw new Error('WORKTREE_CARD_REQUIRED: --release requires --card Q-<n>');
  return withWorktreeRegistrationLock(repo, run, path, 'worktree release', () => {
    const state = readState(repo, run);
    if (!state) throw new Error('RUN_UNKNOWN');
    if (state.finished) throw new Error(`RUN_FINISHED: run ${run} is finished`);
    if (state.mode === 'audit') throw new Error(`WORKTREE_RELEASE_AUDIT_MODE: run ${run} is in audit mode`);
    const target = normPath(path);
    const matches = (state.worktrees || []).filter(w => normPath(w.path) === target);
    if (!matches.length) throw new Error(`WORKTREE_NOT_REGISTERED: ${path} is not registered to run ${run}`);
    if (matches.length > 1) throw new Error(`WORKTREE_REGISTRATION_AMBIGUOUS: run ${run} has multiple registrations for ${path}`);
    const [registration] = matches;
    requireReleaseCard(repo, run, state, card, registration.path);

    const checkedRepo = realpathSync(repo);
    const env = { ...process.env };
    delete env.GIT_COMMON_DIR;
    delete env.GIT_WORK_TREE;
    const git = (...args) => execFileSync('git', ['-C', checkedRepo, '--git-dir', '.git', ...args],
      { encoding: 'utf8', env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    const { branch } = registration;
    try {
      if (typeof branch !== 'string' || !branch) throw new Error();
      git('show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    } catch { throw new Error(`WORKTREE_REPO_UNATTRIBUTED: ${path} has no matching local branch ref in ${checkedRepo}`); }
    let listed;
    try { listed = git('worktree', 'list', '--porcelain', '-z'); }
    catch { throw new Error(`WORKTREE_GIT_LIST_UNKNOWN: could not list the worktrees of ${checkedRepo}`); }
    assertWorktreeAbsent(path);
    if (registration.path !== path) assertWorktreeAbsent(registration.path);
    if (listed.split('\0').some(field => field.startsWith('worktree ') && normPath(field.slice(9)) === target)) {
      throw new Error(`WORKTREE_GIT_LISTED: ${path} is still listed by Git`);
    }

    const at = new Date().toISOString();
    const event = { at, event: 'worktree-release', path: registration.path, branch, card,
      evidence: { absent: true, gitListed: false, repo: checkedRepo } };
    state.worktrees = state.worktrees.filter(w => w !== registration);
    appendRunHistory(state, event);
    state.updatedAt = at;
    saveState(join(reviewStateDirectory(repo, run), 'state.json'), state);
    return event;
  });
}

// The documented owner disposition is retained independently of resource cleanup results.
export function closeoutHoldReason(state) {
  for (const record of [state?.closeout, state?.gates?.closeout]) {
    if (typeof record?.note === 'string' && /^\s*owner-hold:/i.test(record.note)) return record.note;
  }
  return null;
}

// Run the existing closeout CLI from the main checkout, never from a tree being removed.
// Cleanup is best effort after terminal state is durable; its failures cannot replace the caller's outcome.
function terminalCloseout(repo, run, { finish = false } = {}) {
  let note;
  try {
    const main = mainCheckout(resolve(repo));
    const state = readState(repo, run);
    if (!finish) {
      const workers = Object.entries(state?.workers || {}).filter(([, worker]) => !['done', 'failed', 'stopped'].includes(worker?.status));
      if (workers.length) throw new Error(`unfinished workers: ${workers.map(([id]) => id).join(', ')}`);
      let jobs = openJobsReason(repo, run);
      // openJobsReason deliberately swallows directory read failures for its other callers.
      // At this destructive boundary, independently inspect records and treat unknown as busy.
      try {
        const pending = readJobs(repo, run).filter(job => ['running', 'queued', 'lost'].includes(job.status));
        if (!jobs && pending.length) jobs = 'unresolved job records';
      } catch { jobs = 'job records are unreadable'; }
      if (jobs) throw new Error(`open jobs: ${jobs}`);
      if ((state?.worktrees || []).some(w => !isIdle(w.path))) throw new Error('a registered tree is not idle');
    }
    const cwd = normPath(process.cwd());
    if ((state?.worktrees || []).some(w => { const tree = normPath(w.path); return cwd === tree || cwd.startsWith(`${tree}/`); })) {
      throw new Error('the current directory is inside a registered worktree; run terminalization from the main checkout');
    }
    let output;
    try {
      output = execFileSync(process.execPath, [fileURLToPath(new URL('./closeout.mjs', import.meta.url)), 'close', '--repo', main,
        '--run', run, '--ledger', resolve(repo), '--apply', '--json'], {
        cwd: main, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000
      });
    } catch (error) {
      if (error.status !== 2 || !error.stdout) throw error;
      output = error.stdout; // refused trees still have a structured result
    }
    const report = JSON.parse(output);
    const reasons = report.results.flatMap(r => r.blockers || []);
    note = report.open ? `closeout: refused ${reasons.join('; ') || `${report.open} open`}` : `closeout: closed ${report.closed} tree(s)`;
  } catch (error) {
    const reason = String(error.stderr || error.message || error).split('\n').find(Boolean) || 'unknown failure';
    note = `closeout: refused ${reason}`;
  }
  try {
    withStateLock(repo, run, () => {
      const state = readState(repo, run);
      if (!state) return;
      const at = new Date().toISOString();
      if (!closeoutHoldReason(state)) state.closeout = { ...(state.closeout || { at, closed: 0, open: Math.max(1, state.worktrees?.length || 0) }), note };
      appendRunHistory(state, { gate: 'closeout', at, note });
      state.updatedAt = at;
      saveState(join(reviewStateDirectory(repo, run), 'state.json'), state, { allowInvalidatedAudit: true });
    });
  } catch { /* the durable park/finish outcome remains authoritative even if its note cannot be written */ }
}

// Written by closeout.mjs: how many registered worktrees are closed and how many are still open.
function recordCloseoutUnlocked(repo, run, { closed = 0, open = 0, details = [], detailsOnly = false } = {}, now = new Date().toISOString()) {
  const state = readState(repo, run);
  if (!state) throw new Error('RUN_UNKNOWN');
  const hold = closeoutHoldReason(state);
  if (!hold) {
    // Empty and partial closes must retain proof for trees already removed. A
    // recreated path or a current result supersedes its earlier closed identity.
    const byPath = new Map((state.closeout?.details || [])
      .filter(d => d.status === 'closed' && typeof d.path === 'string' && !existsSync(d.path))
      .map(d => [normPath(d.path), d]));
    for (const detail of details) if (typeof detail.path === 'string') byPath.set(normPath(detail.path), { ...detail, path: realOr(detail.path) });
    details = [...byPath.values(), ...details.filter(d => typeof d.path !== 'string')];
    if (detailsOnly) state.closeout = { ...(state.closeout || {}), details };
    else {
      closed = Math.max(closed, details.filter(d => d.status === 'closed').length);
      state.closeout = { at: now, closed, open, details };
    }
  }
  state.gates = state.gates || {};
  // a card that is open means the run is waiting on the user: closeout is recorded, but never as a passed gate
  const q = openQuestionsReason(repo, run);
  if (!hold && !detailsOnly) state.gates.closeout = { status: open || q ? 'blocked' : 'passed', at: now, note: `${closed} closed, ${open} open${q ? '; a question card is open' : ''}` };
  if (state.history?.some(h => h.reviewLaunch)) state.closureObligations = closureObligations(state);
  appendRunHistory(state, { gate: 'closeout', status: hold ? 'blocked' : state.gates.closeout?.status || 'blocked', at: now });
  state.updatedAt = now;
  saveState(join(runsDir(repo), run, 'state.json'), state, { allowInvalidatedAudit: true });
  return state.closeout;
}
export function recordCloseout(repo, run, ...args) { return withStateLock(repo, run, () => recordCloseoutUnlocked(repo, run, ...args)); }

// Why a run may not be closed yet: worktrees it created are still open (or closeout never ran for them).
export function openWorktreeReason(state) {
  const registered = (state?.worktrees || []).length;
  if (!registered) return null;
  if (!state.closeout || !Number.isSafeInteger(state.closeout.open)) return `${registered} registered worktree(s) and closeout has not run`;
  if (state.closeout.open > 0) return `${state.closeout.open} worktree(s) are still open after closeout`;
  return null;
}

export function resumePoint(state) {
  if (!state) return { resumeAt: 'shape', reason: 'no state recorded' };
  if (state.status?.startsWith('parked:')) return { resumeAt: 'parked', status: state.status, next: state.next || null };
  const gates = requiredGates(state);
  const open = gates.find(g => state.gates[g] && state.gates[g].status !== 'passed');
  if (open) return { resumeAt: open, status: state.gates[open].status, next: state.next || null };
  const candidates = gates.slice(1).some(g => Object.hasOwn(state.gates, g)) ? gates.slice(1) : gates;
  const firstMissing = candidates.find(g => !state.gates[g]);
  return { resumeAt: firstMissing || 'complete', next: state.next || null };
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); const v = i >= 0 ? argv[i + 1] : undefined; return v === undefined || v.startsWith('--') ? undefined : v; }; // a following flag is not this option's value
  const repo = opt('repo') ? resolve(opt('repo')) : worktreeRoot('.');
  try {
    // --run given without a usable value is an error, never the same as an omitted --run (which may fall back to the latest run)
    if (argv.includes('--run') && opt('run') === undefined) throw new Error('RUN_ID_INVALID: --run needs a run id');
    if (cmd !== 'mode' && argv.includes('--mode')) throw new Error('MODE_START_ONLY: use the mode declaration before any checkpoint');
    if (cmd === 'mode') {
      process.stdout.write(`${JSON.stringify(setRunMode(repo, opt('run'), { mode: opt('mode'), base: opt('base'), contract: opt('contract') }))}\n`);
    } else if (cmd === 'plan') {
      const result = planCommand(repo, opt('run'), argv[0], { path: opt('path'), card: opt('card'), digest: opt('digest') });
      process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result)}\n`);
    } else if (['scope', 'defer', 'item', 'handoff'].includes(cmd)) {
      const record = opt('file') ? JSON.parse(readFileSync(opt('file'), 'utf8')) : Object.fromEntries(
        ['id', 'item', 'owner', 'status', 'blocker', 'next', 'reason', 'state', 'result', 'verification', 'itemId', 'replaces'].map(k => [k, opt(k)]).filter(([, v]) => v !== undefined));
      process.stdout.write(`${JSON.stringify(updateDiscipline(repo, opt('run'), cmd, argv[0], record))}\n`);
    } else if (cmd === 'status') {
      process.stdout.write(statusTable(repo, opt('run') || latestRun(repo)));
    } else if (cmd === 'set') {
      process.stdout.write(`${JSON.stringify(setGate(repo, opt('run'), { gate: opt('gate'), status: opt('status'), next: opt('next'), note: opt('note'), task: opt('task') }))}\n`);
    } else if (cmd === 'findings') {
      process.stdout.write(`${JSON.stringify(updateFindings(repo, opt('run'), argv[0], { id: opt('id'), severity: opt('severity'), evidence: opt('evidence'), file: opt('file'), round: opt('round') === undefined ? undefined : Number(opt('round')) }))}\n`);
    } else if (cmd === 'criteria' && argv[0] === 'set') {
      process.stdout.write(`${JSON.stringify(setCriterion(repo, opt('run'), { id: opt('id'), status: opt('status'), evidence: opt('evidence') }))}\n`);
    } else if (cmd === 'loop') {
      process.stdout.write(`${countLoop(repo, opt('run'), opt('kind'))}\n`);
    } else if (cmd === 'park') {
      process.stdout.write(`${JSON.stringify(parkRun(repo, opt('run'), opt('reason')))}\n`);
    } else if (cmd === 'attempt') {
      if (argv.includes('--recover') && !argv.includes('--reset')) throw new Error('PLAN_RECOVERY_REQUIRES_RESET');
      process.stdout.write(`${argv.includes('--reset') ? resetAttempt(repo, opt('run'), opt('gate'), { recover: argv.includes('--recover'), reason: opt('reason') }) : reserveAttempt(repo, opt('run'), opt('gate'))}\n`);
    } else if (cmd === 'dispatch') {
      const run = opt('run'), worker = opt('worker'), deadlineMin = opt('deadline-min') === undefined ? 30 : Number(opt('deadline-min'));
      if (worker && (!/^[A-Za-z0-9._-]+$/.test(worker) || !Number.isFinite(deadlineMin) || deadlineMin <= 0 || deadlineMin > 1440)) throw new Error('WORKER_OR_DEADLINE_INVALID');
      if (!validRunId(run)) throw new Error('RUN_ID_INVALID');
      const counts = withStateLock(repo, run, () => {
        if (worker && Object.hasOwn(readState(repo, run)?.workers || {}, worker)) throw new Error('DISPATCH_ALREADY_RECORDED: worker already recorded for this run; use a fresh worker id for a new attempt');
        const result = countDispatchUnlocked(repo, run, opt('role'), undefined, { reservation: opt('review-reservation') });
        if (worker) registerWorkerUnlocked(repo, run, { id: worker, role: opt('role'), deadlineMin, reviewReservation: opt('review-reservation') });
        return result;
      }, reviewStateDirectory(repo, run));
      process.stdout.write(`${JSON.stringify(counts)}\n`);
    } else if (cmd === 'worker-done') {
      if (opt('review-reservation') && opt('worker')) throw new Error('WORKER_DISPOSITION_TARGET: choose --worker or --review-reservation');
      const result = opt('review-reservation')
        ? finishReviewReservation(repo, opt('run'), opt('review-reservation'), opt('status'), opt('report'))
        : finishWorker(repo, opt('run'), opt('worker'), opt('status'), undefined, { report: opt('report') });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (cmd === 'stalled') {
      const mins = opt('minutes') === undefined ? 20 : Number(opt('minutes'));
      if (!Number.isFinite(mins) || mins < 1) throw new Error('MINUTES_INVALID');
      const list = stalledRuns(repo, { minutes: mins });
      process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      if (list.length) process.exitCode = 2;
    } else if (cmd === 'worktree') {
      if (argv.includes('--release')) {
        const path = opt('path');
        process.stdout.write(`${JSON.stringify(releaseWorktree(repo, opt('run'), path && resolve(path), opt('card')))}\n`);
      } else {
        if ((opt('role') || 'writer') === 'reviewer') process.stderr.write('RUN-STATE: warning: reviewers do not need a worktree; review the diff packet (see SKILL.md). Register a reviewer tree only if it must run tests.\n');
        process.stdout.write(`${JSON.stringify(registerWorktree(repo, opt('run'), { path: resolve(opt('path') || '.'), branch: opt('branch') || null, role: opt('role') || 'writer' }))}\n`);
      }
    } else if (cmd === 'finish') {
      // Explicit close: only after acceptance passed. Reclaim and cleanup treat an unfinished run as active.
      const run = opt('run') || latestRun(repo);
      withStateLock(repo, run, () => {
      const state = readState(repo, run);
      if (!state) throw new Error('RUN_UNKNOWN');
      assertAcceptance(state, repo, run);
      assertNoOwedWork(state, repo, run);
      if (state.gates['done-jev']?.status !== 'passed') throw new Error('RUN_NOT_ACCEPTED: done-jev has not passed; a run cannot be closed before acceptance');
      const openReason = openWorktreeReason(state);
      if (openReason) throw new Error(`RUN_HAS_OPEN_WORKTREES: ${openReason}; run closeout.mjs close first`);
      const jobsReason = openJobsReason(repo, run);
      if (jobsReason) throw new Error(`RUN_HAS_OPEN_JOBS: ${jobsReason}`);
      const qReason = openQuestionsReason(repo, run);
      if (qReason) throw new Error(`QUESTIONS_OPEN: ${qReason}`);
      const csReason = cleanStateReason(repo, run);
      if (csReason) throw new Error(`CLEAN_STATE_NOT_REACHED: ${csReason}`);
      assertClosure(repo, run, state);
      requireBoundary(repo, run, state);
      state.finished = true; state.updatedAt = new Date().toISOString();
      saveState(join(runsDir(repo), run, 'state.json'), state);
      });
      terminalCloseout(repo, run, { finish: true });
      process.stdout.write(`${JSON.stringify({ run, finished: true })}\n`);
    } else if (cmd === 'handover-taken') {
      if (argv.includes('--handoff') && opt('handoff') === undefined) throw new Error('HANDOFF_PICKUP_INVALID');
      const pickup = handoverTaken(repo, opt('run'), { by: opt('by'), depth: opt('depth') === undefined ? undefined : Number(opt('depth')), keep: argv.includes('--keep'), handoff: opt('handoff') });
      process.stdout.write(`${JSON.stringify(pickup)}\n${renderPlans(readState(repo, opt('run')))}`);
    } else if (cmd === 'audit') {
      const run = opt('run') || latestRun(repo);
      const result = auditRun(repo, run);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
    } else if (cmd === 'show') {
      const run = opt('run') || latestRun(repo);
      const state = run ? readState(repo, run) : null;
      process.stdout.write(`${JSON.stringify({ run, ...resumePoint(state), state }, null, 2)}\n`);
    } else throw new Error('USAGE: plan|scope|defer|item|handoff|status|set|findings|criteria|loop|park|attempt|dispatch|worker-done|stalled|worktree|finish|handover-taken|audit|show');
  } catch (e) { process.stderr.write(`RUN-STATE: ${e.message}\n`); process.exitCode = /^(LOOP_CAP:|RUN_PARKED:|RUN_UNRESOLVED:|FINDINGS_NOT_SYNCED:|FINDINGS_ROUND_STALE|AWAITING_EXCEPTION:)/.test(e.message) ? 2 : 3; }
}
