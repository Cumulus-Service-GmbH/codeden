// TrioHarness Arbiter: the shared escalation module. Every review path asks it where an item stands in the formula
// (review rounds, then the Arbiter, then Jev, then the merge check), whether a model round may start, and which
// problems the merge check must refuse. Canonical copy: ~/.config/trioharness/arbiter-lib.mjs; team-sync.mjs copies it
// into each skill as scripts/arbiter.mjs. Every number and the Arbiter pin come from the Team (team.json roles.arbiter,
// overridden inside CodeDen by the in-app Team file); nothing here holds a model name or a setting default.
// The formula: up to R reviewer fix rounds; then one Arbiter ruling on the open findings; the writer fixes the VALID
// findings and the regular reviewer confirms them on the next round. A failed confirm, an Arbiter BLOCK or a reached
// cap makes the item BLOCKED for the orchestrator inbox (an owner decision); it is never approved.
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { appendFileSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const lib = await import(existsSync(new URL('./team.mjs', import.meta.url)) ? './team.mjs' : './team-lib.mjs');
const { ARBITER_SETTINGS, ARBITER_UNSET, configuredArbiterPin, EFFORTS, SIMPLE_ROLES, arbiterSettingsProblem, pinLabel, samePin, teamDir, vendorOf } = lib;

export const RULINGS = ['VALID-must-fix', 'INVALID'];
export const ESCALATION = 'ESCALATION.jsonl';
export const BLOCKED = 'ITEM_BLOCKED.json';
const REVIEWS = 'CODE_REVIEW_ROUNDS.jsonl';
const JEV_LOG = 'jev-receipts.jsonl';
export const sha = t => createHash('sha256').update(t).digest('hex');

export function readJsonl(file, label = 'LEDGER_UNREADABLE') {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, i) => {
    if (!line) return [];
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
      return [row];
    } catch {
      throw new Error(`${label}: ${file} line ${i + 1} is not a JSON object`);
    }
  });
}

export function escalationRows(runDir) {
  return resolveEscalation(readJsonl(join(runDir, ESCALATION), 'ESCALATION_UNREADABLE')).map(({ row }) => row);
}

function validReclassificationGrants(rows, index) {
  const row = rows[index];
  if (row.kind !== 'arbiter-reclassification' || !Array.isArray(row.reclassified)) return [];
  return row.reclassified.filter(grant => {
    const rowIndex = grant?.rowIndex;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= index) return false;
    const reason = legacyToolingReason(rows[rowIndex]);
    return reason !== null && reason === grant.toolingReason;
  });
}

function resolveEscalation(rows) {
  const finished = new Set(rows.filter(e => e.kind === 'arbiter').map(e => e.id));
  const faults = new Map();
  rows.forEach((_, index) => {
    for (const { rowIndex, toolingReason } of validReclassificationGrants(rows, index)) {
      faults.set(rowIndex, toolingReason);
    }
  });
  return rows.flatMap((entry, index) => {
    if (entry.kind === 'arbiter-start' && finished.has(entry.id)) return [];
    const row = entry.kind === 'arbiter-start' ? { ...entry, kind: 'arbiter' } : entry;
    const toolingReason = faults.get(index);
    return [{ rowIndex: index, row: toolingReason ? { ...row, status: 'tooling-fault', toolingReason } : row }];
  });
}
export function appendEscalation(runDir, row) {
  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, ESCALATION), `${JSON.stringify(row)}\n`);
  return row;
}

// A lock directory is acquired atomically. A process that dies leaves a lock for explicit recovery.
export function lockItem(file) {
  mkdirSync(dirname(file), { recursive: true });
  try { mkdirSync(file); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw new Error(`ITEM_BUSY: ${file} is locked; verify the holder has stopped before clearing a stale lock`);
  }
  try {
    writeFileSync(join(file, 'owner'), `${process.pid} ${new Date().toISOString()}\n`);
    return () => rmSync(file, { recursive: true });
  } catch (error) {
    rmSync(file, { recursive: true });
    throw error;
  }
}

export function withLock(file, fn) {
  const unlock = lockItem(file);
  try { return fn(); } finally { unlock(); }
}

// The resolved Arbiter settings. Refuses any value outside its range (the Team file is validated on load as well).
export function arbiterSettings(team) {
  const a = lib.arbiterLimits(team);
  if (!Object.keys(a).length) throw new Error(ARBITER_UNSET);
  const bad = arbiterSettingsProblem(a, 'arbiter', { required: true });
  if (bad) throw new Error(`ARBITER_SETTINGS_INVALID: ${bad}`);
  const configured = configuredArbiterPin(team);
  const pin = configured && vendorOf(team, configured.provider) ? configured : null;
  return { pin, ...Object.fromEntries(Object.keys(ARBITER_SETTINGS).map(k => [k, a[k]])), dailyBudgetUsd: a.dailyBudgetUsd ?? null,
    source: team.arbiterSettingsSource || 'team.json', pinSource: team.roles?.arbiter?.source || 'team.json' };
}

function teamPins(team) {
  const r = team.roles;
  const cr = r.codeReviewer || {};
  return [...SIMPLE_ROLES.map(k => r[k]), cr.primary, ...Object.values(cr.fallback || {}).flat()]
    .filter(lib.isConfiguredPin).map(({ provider, model, effort }) => ({ provider, model, effort }));
}

// The Arbiter for one dispute: never the writer's vendor. When the Team's Arbiter is the writer's vendor, the
// highest-effort Team member of another vendor rules (the first in Team order on a tie); with none, the call is refused
// and the dispute waits (ARBITER_SAME_VENDOR). There is no same-vendor fallback.
export function arbiterPin(team, { writer } = {}) {
  const { pin } = arbiterSettings(team);
  if (!pin) throw new Error(ARBITER_UNSET);
  if (!writer) throw new Error('ARBITER_WRITER_UNKNOWN: the writer provider is needed to keep the Arbiter cross-vendor');
  const own = vendorOf(team, writer);
  if (!own) throw new Error(`ARBITER_SAME_VENDOR: writer ${writer} has no known vendor, so no Arbiter can be proven cross-vendor; the dispute waits`);
  const allowed = p => ['agy', 'claude'].includes(p.provider) && vendorOf(team, p.provider) && vendorOf(team, p.provider) !== own;
  if (allowed(pin)) return pin;
  const best = (team.app?.hostReview ? [] : teamPins(team)).filter(allowed)
    .sort((x, y) => EFFORTS.indexOf(y.effort) - EFFORTS.indexOf(x.effort))[0];
  if (!best) throw new Error(`ARBITER_SAME_VENDOR: the configured Arbiter ${pinLabel(pin)} cannot rule for writer ${writer}, and the Team has no eligible tool-free member of another vendor; the dispute waits`);
  return best;
}

const norm = t => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
// Same-finding key: the file path (without line) and the normalised problem text.
export const findingKey = f => `${f.finding.match(/FILE: ([^|:\s]+)/)?.[1] || ''}|${norm(f.finding.match(/PROBLEM: ([^|]+)/)?.[1] || f.finding)}`;
// Plan finding key: the cited file (without line) and the problem text before "->".
export const planFindingKey = f => {
  const [, file = '', rest = f.finding] = f.finding.match(/^([^\s:]+)(?::\d+)?\s+(.*)$/) || [];
  return `${file}|${norm(rest.split('->')[0])}`;
};

// Open findings in a reviewer report. code: "- ID: R1 | SEVERITY: HIGH | ..." under FINDINGS (quoted parts get a P<n>.
// prefix); plan: "[BLOCKING|ADVISORY] <id> ..." under FINDINGS. `source` binds each finding to its report.
export function openFindings(text, { scope = 'code', prefix = '', source = null } = {}) {
  const out = [];
  let section = null;
  let part = null;
  let partStart = 0;
  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    const heading = raw.match(/^## Part (\d+)\s*$/);
    if (heading) { part = heading[1]; partStart = out.length; section = null; continue; }
    const line = raw.replace(/^(?:> ?)+/, '').trim();
    const head = line.match(/^(VERDICT|REVIEW_DECISION|FINDINGS|OUT_OF_SCOPE_RISKS|NON_FINDINGS|FALSE_PREMISES|SUMMARY):\s*(.*)$/);
    if (head) section = head[1];
    if (scope === 'code' && section === 'SUMMARY' && head) {
      for (const m of head[2].matchAll(/\b(high|medium|low)=(\d+)\b/gi)) {
        if (out.slice(partStart).filter(f => f.severity === m[1].toUpperCase()).length !== Number(m[2])) {
          throw new Error('finding counts differ from SUMMARY');
        }
      }
    }
    if (section !== 'FINDINGS') continue;
    const body = (head ? head[2] : line).replace(/^- /, '');
    const m = scope === 'plan' ? body.match(/^\[(BLOCKING|ADVISORY)\] (\S+) (.+)$/)
      : body.match(/^ID: ([A-Za-z0-9._-]+) \| SEVERITY: (HIGH|MEDIUM|LOW) \| (.+)$/);
    if (!m) {
      if (body && !/^none\.?$/i.test(body)) throw new Error(`malformed finding entry: ${body.slice(0, 100)}`);
      continue;
    }
    const [severity, id, finding] = scope === 'plan' ? [m[1], m[2], m[3]] : [m[2], m[1], m[3]];
    out.push({ id: `${prefix}${part ? `P${part}.` : ''}${id}`, severity, finding: finding.trim(), ...(source ? { source } : {}) });
  }
  return out;
}
export const duplicateIds = fs => [...new Set(fs.map(f => f.id).filter((id, i, all) => all.indexOf(id) !== i))];

export const planVerdict = text => String(text).match(/^VERDICT:[ \t]*(APPROVE|AMEND|BLOCK)[ \t]*$/m)?.[1] ?? null;

// The writer's responses: "- ID: <id> | RESPONSE: FIXED|DISPUTE|ACCEPTED | NOTE: ...".
export const parseResponses = text => String(text).split(/\r\n|\r|\n/).map(l => l.trim())
  .map(l => l.match(/^- ID: (\S+) \| RESPONSE: (FIXED|DISPUTE|ACCEPTED)\b/)).filter(Boolean).map(m => ({ id: m[1], response: m[2] }));

const lines = text => String(text).split(/\r\n|\r|\n/).map(l => l.trim());
// The ruling: one decision and exactly one VALID-must-fix or INVALID ruling, with reasoning, per open finding.
export function parseRuling(text, findings) {
  const replyLines = lines(text).filter(Boolean);
  const decisions = replyLines.filter(line => line !== 'RULINGS:' && !line.startsWith('- ID:'));
  const decisionProblem = 'the ruling needs exactly one "ARBITER_DECISION: APPROVE" or "ARBITER_DECISION: BLOCK" line';
  if (!replyLines.length) return { unparseable: true, problem: decisionProblem };
  const blocked = problem => ({ decision: 'BLOCK', rulings: [], problem });
  const decision = decisions.length === 1 && decisions[0].match(/^ARBITER_DECISION:[ \t]*(APPROVE|BLOCK)$/)?.[1];
  if (!decision) return blocked(decisionProblem);
  if (duplicateIds(findings).length) return blocked(`open findings share an ID (${duplicateIds(findings).join(', ')})`);
  const byId = new Map(findings.map(f => [f.id, f]));
  const rulings = [];
  for (const line of replyLines.filter(l => l.startsWith('- ID:'))) {
    const m = line.match(/^- ID: (\S+) \| RULING: (\S+) \| REASON: (.*)$/);
    if (!m) return blocked(`unreadable ruling line: ${line.slice(0, 160)}`);
    const [, id, ruling, reason] = m;
    if (!RULINGS.includes(ruling)) return blocked(`ruling "${ruling}" on ${id} is not VALID-must-fix or INVALID: the Arbiter cannot waive, accept, defer or downgrade a finding`);
    if (!byId.has(id)) return blocked(`the ruling names ${id}, which is not an open finding`);
    if (rulings.some(r => r.id === id)) return blocked(`finding ${id} is ruled twice`);
    if (!reason.trim() || /^none\.?$/i.test(reason.trim())) return blocked(`the ruling on ${id} has no reasoning`);
    rulings.push({ ...byId.get(id), ruling, reason: reason.trim() });
  }
  const missing = findings.filter(f => !rulings.some(r => r.id === f.id)).map(f => f.id);
  if (missing.length) return blocked(`no ruling on ${missing.join(', ')}`);
  return { decision, rulings };
}

// Where an escalated dispute stands: none, ruling (due or retried), confirm (VALID findings await the fix and the
// regular reviewer's confirming round), final (APPROVE or BLOCK).
export function arbiterState(rows, scope) {
  const mine = rows.map((e, index) => ({ e, index })).filter(({ e }) => ['arbiter', 'review-confirm'].includes(e?.kind) && e.scope === scope);
  if (!mine.length) return { phase: 'none', calls: 0 };
  const calls = mine.filter(({ e }) => countsArbiterCall(e)).length;
  const last = mine.at(-1).e;
  const r = mine.findLast(({ e }) => isArbiterRuling(e) && e.mode === 'ruling');
  const base = { last, calls, first: mine[0].e };
  if (!r) return { ...base, phase: 'ruling' };
  const ruling = r.e;
  if (ruling.decision !== 'APPROVE' || !Array.isArray(ruling.rulings)) return { ...base, phase: 'final', decision: 'BLOCK', ruling };
  const valid = ruling.rulings.filter(x => x.ruling === 'VALID-must-fix');
  if (!valid.length) return { ...base, phase: 'final', decision: 'APPROVE', ruling };
  const confirm = mine.find(({ e, index }) => index > r.index && e.kind === 'review-confirm')?.e;
  if (!confirm) return { ...base, phase: 'confirm', ruling, valid };
  return { ...base, phase: 'final', decision: confirm.decision, ruling, confirm };
}

const BASE_SLOTS = ['primary', 'fallback'];
export const verdictRow = e => e?.kind === 'team-review' && e.status === 'completed' && e.head
  && ['primary', 'fallback', 'second-pass'].includes(e.slot) && ['CLEAN', 'FINDINGS'].includes(e.verdict);
const reportText = e => { try { return e.output && existsSync(e.output) ? readFileSync(e.output, 'utf8') : null; } catch { return null; } };
// A FINDINGS report's findings, verified against the recorded digest; problem when it is missing, changed or unparseable.
export function verifiedFindings(e) {
  const text = reportText(e);
  if (text === null) return { problem: `round ${e.round} ${e.slot} report ${e.output} is missing` };
  if (!e.outputSha256 || sha(text) !== e.outputSha256) return { problem: `round ${e.round} ${e.slot} report ${e.output} differs from its recorded sha256` };
  try {
    const findings = openFindings(text, { prefix: `${e.round}.`, source: { round: e.round, slot: e.slot, output: e.output, outputSha256: e.outputSha256 } });
    return findings.length ? { findings, text } : { unparsed: `round ${e.round} ${e.slot} report lists no parseable finding` };
  } catch (e) {
    return { problem: e.message };
  }
}

const lowOnly = checked => checked.every(c => c.findings?.every(f => f.severity === 'LOW'));

// The code-review cycle. Per head, blocking or unverified findings keep the head FINDINGS even after a CLEAN row; heads
// come only from primary or fallback rounds. due: R FINDINGS heads since the last CLEAN head, the same finding back on a
// later head, or a finding disputed twice. pastLimit: a new head was reviewed after due (only for heads after adoption).
// inputProblems: any FINDINGS report of the active cycle that is missing, changed or unparseable.
export function reviewCycle(reviewRows, escRows, R) {
  const adoptedAt = escRows.find(e => e?.kind === 'adopted')?.completedAt ?? '￿';
  const heads = [];
  for (const e of reviewRows.filter(verdictRow)) {
    let h = heads.find(x => x.head === e.head);
    if (!h) {
      if (!BASE_SLOTS.includes(e.slot)) continue;
      heads.push(h = { head: e.head, verdict: null, rows: [], at: e.completedAt || '' });
    }
    h.rows.push(e);
    if (e.verdict === 'FINDINGS') h.verdict = 'FINDINGS';
    else h.verdict ??= 'CLEAN';
  }
  const disputes = new Map();
  for (const r of escRows.filter(e => e?.kind === 'responses' && (e.scope ?? 'code') === 'code')) for (const key of new Set(r.disputes || [])) disputes.set(key, (disputes.get(key) || 0) + 1);
  let count = 0; let pastLimit = false; let due = false; let trigger = null;
  const seen = new Set();
  let inputProblems = [];
  for (const h of heads) {
    const checked = h.rows.filter(e => e.verdict === 'FINDINGS').map(verifiedFindings);
    if (lowOnly(checked)) h.verdict = 'CLEAN';
    if (due && h.at > adoptedAt) pastLimit = true;
    if (h.verdict === 'CLEAN') { count = 0; seen.clear(); inputProblems = []; due = false; trigger = null; continue; }
    count++;
    h.findings = checked.flatMap(c => c.findings || []);
    inputProblems.push(...checked.map(c => c.problem).filter(Boolean));
    h.unparsed = checked.map(c => c.unparsed).filter(Boolean);
    const keys = new Set(h.findings.map(findingKey));
    if (!due && [...keys].some(k => seen.has(k))) { due = true; trigger = 'same finding returned after a fix'; }
    for (const k of keys) seen.add(k);
    if (count >= R && !due) { due = true; trigger = `${R} fix round${R === 1 ? '' : 's'} without approval`; }
  }
  if (!due && count > 0 && [...disputes.values()].some(n => n >= 2)) { due = true; trigger = 'the writer disputed the same finding twice'; }
  return { round: count, of: R, due, trigger, pastLimit, latest: heads.at(-1) || null, heads, inputProblems,
    label: `review round ${Math.min(count, R)} of ${R}${due ? ', Arbiter next' : ''}` };
}

// The findings the Arbiter rules on at `head`: the newest FINDINGS head's, plus every second pass on `head` when `head`
// moved on from it (the high-risk pass the ruling waits for). problems: any report that cannot be verified.
export function openCodeFindings(reviewRows, cycle, head) {
  const extra = head && head !== cycle.latest?.head
    ? reviewRows.filter(e => e?.kind === 'team-review' && e.slot === 'second-pass' && e.head === head && verdictRow(e) && e.verdict === 'FINDINGS').map(verifiedFindings) : [];
  const findings = [...(cycle.latest?.verdict === 'FINDINGS' ? cycle.latest.findings : []), ...extra.flatMap(c => c.findings || [])];
  const problems = [...cycle.inputProblems, ...(cycle.latest?.unparsed || []), ...extra.map(c => c.problem || c.unparsed).filter(Boolean)];
  if (duplicateIds(findings).length) problems.push(`open findings share an ID (${duplicateIds(findings).join(', ')})`);
  return { findings, problems };
}

export function codeWriterProblem(rows, writer) {
  const providers = new Set(rows.filter(verdictRow).map(e => e.writer?.provider).filter(Boolean));
  return providers.size > 0 && (providers.size !== 1 || !providers.has(writer));
}

export function planCeilingConfirmation(team, dir, ruling, head) {
  if (ruling?.run !== basename(dir) || ruling.head !== head || !verifiedCeilingRuling(team, dir, 'plan', ruling)) return false;
  const blocked = itemBlocked(dir);
  return !blocked || (blocked.scope === 'plan' && blocked.run === ruling.run && blocked.head === head &&
    (isModelRoundCeilingBlock(blocked) || approvedRetryForBlock(dir, blocked, 'plan', ruling)) &&
    (blocked.ruling?.receipt === ruling.id || sameBlock(blocked, ruling.ceilingBlock)));
}

export function verifiedPlanConfirm(rows, reports, ruling, confirm) {
  const first = reports.find(r => r.n > ruling.planReport);
  const reservation = rows.find(e => e.kind === 'plan-review-start' && e.n === first?.n && e.rulingId === ruling.id);
  return Boolean(first && reservation && first.n === confirm.report?.n && first.path === confirm.report.path &&
    first.sha256 === confirm.report.sha256 && first.verdict === confirm.decision &&
    reservation.subject?.path === ruling.subject?.path && reservation.subject?.path === confirm.subject?.path && reservation.subject?.sha256 === confirm.subject?.sha256 &&
    rows.some(e => e.kind === 'plan-review-finish' && e.startId === reservation.id && e.sha256 === first.sha256));
}

// The run's plan reviews: workers/plan-reviewer-<n>.md in number order (the launcher writes them; callers pick none).
export function planReports(runDir) {
  const workers = join(runDir, 'workers');
  if (!existsSync(workers)) return [];
  return readdirSync(workers).map(f => f.match(/^plan-reviewer-(\d+)\.md$/)).filter(Boolean)
    .map(m => ({ n: Number(m[1]), path: join(workers, m[0]) })).sort((a, b) => a.n - b.n)
    .map(r => { const text = readFileSync(r.path, 'utf8'); return { ...r, text, sha256: sha(text), verdict: planVerdict(text), modifiedAt: statSync(r.path).mtime.toISOString() }; });
}

// The plan-review cycle: the reviews after the last APPROVE, in number order. due: R non-APPROVE reviews, the same
// finding back in a later review, or a finding disputed twice. capsUsed: no further plan review is allowed.
export function planCycle(reports, escRows, R, planRounds = Infinity) {
  const problems = reports.filter(r => !r.verdict).map(r => `${r.path} has no VERDICT line`);
  const adopted = escRows.find(e => e.kind === 'adopted');
  const ruled = arbiterState(escRows, 'plan').ruling?.planReport ?? Infinity;
  let open = [];
  let trigger = null;
  const seen = new Set();
  for (const r of reports) {
    if (r.n <= ruled && adopted && (adopted.planReport === undefined ? r.modifiedAt > adopted.completedAt : r.n > adopted.planReport) && trigger) problems.push(`${r.path} ran after the plan dispute was due for the Arbiter`);
    if (r.verdict === 'APPROVE') { open = []; trigger = null; seen.clear(); continue; }
    open.push(r);
    try {
      r.findings = openFindings(r.text, { scope: 'plan', prefix: `p${r.n}.`, source: { round: r.n, slot: 'plan-review', output: r.path, outputSha256: r.sha256 } });
    } catch (e) {
      problems.push(`${r.path}: ${e.message}`);
      r.findings = [];
    }
    const keys = new Set(r.findings.map(planFindingKey));
    if (open.length >= R) trigger ??= `${R} plan fix round${R === 1 ? '' : 's'} without approval`;
    if ([...keys].some(k => seen.has(k))) trigger ??= 'same plan finding returned after a fix';
    if (open.length >= planRounds) trigger ??= 'the plan-review caps leave no further plan review';
    for (const k of keys) seen.add(k);
  }
  const disputes = new Map();
  for (const row of escRows.filter(e => e?.kind === 'responses' && e.scope === 'plan')) for (const key of new Set(row.disputes || [])) disputes.set(key, (disputes.get(key) || 0) + 1);
  if (open.length && [...disputes.values()].some(n => n >= 2)) trigger ??= 'the writer disputed the same plan finding twice';
  return { count: open.length, due: Boolean(trigger), trigger, latest: open.at(-1) || null, open, problems };

}

// Model rounds used by the item: every dispatched reviewer, plan-review, Arbiter and Jev-stage round, and Jev attempts.
const isArbiterRuling = e => e.kind === 'arbiter' && e.status !== 'incomplete' && Boolean(e.text || e.output || e.outputSha256 || e.decision || e.rulings?.length);
const isToolingFault = e => e.kind === 'arbiter' && e.status !== 'incomplete' && !isArbiterRuling(e) && Boolean(e.toolingReason);
const countsArbiterRound = e => e.kind === 'arbiter' && (e.status !== 'refused' || isArbiterRuling(e) || isToolingFault(e));
const countsArbiterCall = e => countsArbiterRound(e) && !isToolingFault(e);

export const isBareModelAlias = model => typeof model === 'string' && /^[a-z]+$/.test(model) && model !== 'default';

export function savedModelMatches(provider, saved, reportedId) {
  const model = saved || 'default';
  const reported = reportedId?.split('[', 1)[0];
  if (model !== 'default') {
    if (reportedId === model || reported === model) return true;
    const slash = model.indexOf('/');
    if (provider === 'opencode' && slash >= 0) return reported === model.slice(slash + 1);
    if (provider === 'antigravity' && /[0-9/]/.test(model)) {
      return EFFORTS.some(level => reported === `${model}-${level}`);
    }
    if (!isBareModelAlias(model)) return false;
    const parts = reported?.split('-') ?? [];
    const family = parts[0] === provider || (provider === 'agy' && parts[0] === 'gemini')
      ? parts.slice(1).find(part => !/^\d+(?:\.\d+)*$/.test(part)) : null;
    if (family === model) return true;
  }
  const error = new Error(`MODEL_ALIAS_UNKNOWN: unknown alias ${model} for ${provider}`);
  error.code = 'MODEL_ALIAS_UNKNOWN';
  throw error;
}

export function selectClaudeRulingModel(modelUsage) {
  const models = Object.keys(modelUsage);
  if (!models.every(m => Number.isSafeInteger(modelUsage[m]?.outputTokens) && modelUsage[m].outputTokens >= 0)) return null;
  const [first, second] = models.sort((a, b) => modelUsage[b].outputTokens - modelUsage[a].outputTokens);
  return first && modelUsage[first].outputTokens > 0 &&
    (second === undefined || modelUsage[first].outputTokens !== modelUsage[second].outputTokens) ? first : null;
}

function matchesAliasFamily(pin, id) {
  if (!id.includes('-')) return false;
  try { return savedModelMatches(pin.provider, pin.model, id); }
  catch (error) {
    if (error.code !== 'MODEL_ALIAS_UNKNOWN') throw error;
    return false;
  }
}

export function claudeRulingModelProblem(pin, models, rulingModel) {
  if (isBareModelAlias(pin.model)) {
    const [first, second] = models.filter(id => matchesAliasFamily(pin, id));
    if (second) return `MODEL_ALIAS_AMBIGUOUS: ${pin.model} matched ${first} and ${second}`;
  }
  if (!rulingModel) return 'cannot identify the Claude ruling model from output token counts';
  if (!savedModelMatches(pin.provider, pin.model, rulingModel)) return `Claude ruling model ${rulingModel} does not match ${pin.model}`;
  return null;
}

const modelIdPattern = /^[\w.\[\]:+/\-]+$/;
function acceptsRecordedMismatch(pin, evidence) {
  if (pin?.provider !== 'claude' || typeof pin.model !== 'string' || !modelIdPattern.test(pin.model)) return false;
  const models = evidence?.reportedModels;
  if (!Array.isArray(models) || !models.length || new Set(models).size !== models.length ||
      models.some(id => typeof id !== 'string' || !modelIdPattern.test(id))) return false;
  if (!Object.hasOwn(evidence, 'modelUsage')) {
    return isBareModelAlias(pin.model) && !models.some(id => id.split('[', 1)[0] === pin.model) &&
      models.filter(id => matchesAliasFamily(pin, id)).length === 1;
  }
  const { modelUsage } = evidence;
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage) ||
      Object.keys(modelUsage).length !== models.length || !models.every(id => Object.hasOwn(modelUsage, id))) return false;
  try { return !claudeRulingModelProblem(pin, models, selectClaudeRulingModel(modelUsage)); }
  catch (error) {
    if (error.code !== 'MODEL_ALIAS_UNKNOWN') throw error;
    return false;
  }
}

const budgetFile = () => join(teamDir(), 'arbiter-usage.jsonl');
const budgetLock = () => join(teamDir(), 'arbiter-budget.lock');
function isBudgetPath(path) {
  const lock = budgetLock();
  return path === budgetFile() || path === lock || path.startsWith(lock + sep);
}

const unprefixedReason = reason => reason.replace(/^[\w.-]+\/[^\s/]+\/(?:\w+|n\/a): /, '');

function legacyToolingReason(row) {
  if (row.kind !== 'arbiter' || row.status === 'incomplete' || isArbiterRuling(row) || typeof row.reason !== 'string') return null;
  const reason = unprefixedReason(row.reason);
  if (/^claude reported models [\w.\[\]:+/-]+(?:, [\w.\[\]:+/-]+)*, not [\w.\[\]:+/-]+$/.test(reason) &&
      acceptsRecordedMismatch(row.arbiter, row.evidence)) return row.reason;
  return null;
}

const arbiterCapBlock = /^ARBITER_CAP: (\d+) of (\d+) Arbiter calls used(?: after ARBITER_UNAVAILABLE: (.+))?$/;
const sameBlock = (a, b) => Boolean(a && b && a.at === b.at && a.reason === b.reason);

function recordedCapClear(rows, index) {
  const row = rows[index];
  const reason = row.clearedBlock?.reason;
  if (typeof reason !== 'string' || !arbiterCapBlock.test(reason)) return false;
  const grants = validReclassificationGrants(rows, index);
  return grants.length > 0 && grants.length === row.reclassified.length;
}

export function planReclassification(rows, blocked, callsPerItem) {
  const effective = resolveEscalation(rows);
  const calls = effective.filter(({ row }) => countsArbiterCall(row));
  const state = (marker, callsUsed) => ({ blocked: Boolean(marker), reason: marker?.reason ?? null, callsUsed, callsPerItem });
  const before = state(blocked, calls.length);
  const unchanged = { before, after: before, reclassified: [], clearBlock: false };
  const hasRuling = effective.some(({ row }) => isArbiterRuling(row) || (row.kind === 'review-confirm' && row.decision === 'BLOCK'));
  const clears = rows.filter((_, index) => recordedCapClear(rows, index));
  const otherBlock = rows.some(row => row.kind === 'blocked' &&
    !sameBlock({ at: row.completedAt, reason: row.reason }, blocked) &&
    !clears.some(clear => sameBlock(clear.clearedBlock, { at: row.completedAt, reason: row.reason })));
  if (hasRuling || otherBlock || blocked?.ruling || blocked?.rulings?.length) return unchanged;

  const reclassified = effective.flatMap(({ row, rowIndex }) => {
    const toolingReason = legacyToolingReason(rows[rowIndex]);
    if (!toolingReason || isToolingFault(row)) return [];
    return [{ rowIndex, toolingReason }];
  });
  const released = new Set(reclassified.map(({ rowIndex }) => rowIndex));
  const remaining = calls.filter(({ rowIndex }) => !released.has(rowIndex)).length;
  if (blocked) {
    const cap = arbiterCapBlock.exec(blocked.reason);
    if (blocked.status !== 'BLOCKED' || !cap || Number(cap[2]) < 1 || Number(cap[1]) < Number(cap[2]) || remaining > 0) return unchanged;
    const previousClear = rows.findIndex((row, index) => sameBlock(row.clearedBlock, blocked) && recordedCapClear(rows, index));
    const originalCalls = previousClear < 0 ? calls : resolveEscalation(rows.slice(0, previousClear)).filter(({ row }) => countsArbiterCall(row));
    if (originalCalls.length !== Number(cap[1]) || !originalCalls.every(({ row }) => legacyToolingReason(row)) ||
        (cap[3] && cap[3] !== originalCalls.at(-1)?.row.reason)) return unchanged;
    return { before, after: state(null, remaining), reclassified, clearBlock: true };
  }
  return { before, after: state(null, remaining), reclassified, clearBlock: false };
}

export function itemUsage(runDir, log = join(runDir, JEV_LOG)) {
  const reviews = readJsonl(join(runDir, REVIEWS)).filter(e => ['team-review', 'invoke-lane'].includes(e?.kind) && e.slot !== 'native-factory' && e.status !== 'refused').length;
  const esc = escalationRows(runDir);
  const arbiter = esc.filter(countsArbiterCall).length;
  const arbiterRounds = esc.filter(countsArbiterRound).length;
  const jevReview = esc.filter(e => e.kind === 'jev-review' && e.status !== 'refused').length;
  const jev = jevReceipts(runDir, log).filter(e => ['plan', 'done'].includes(e?.gate) && !e.dryRun && e.verdict !== 'unavailable').length;
  const reports = planReports(runDir);
  const planReviews = reports.length + esc.filter(e => e.kind === 'plan-review-start' && !reports.some(r => r.n === e.n)).length;
  return { reviews, planReviews, arbiter, arbiterRounds, jevReview, jev, total: reviews + planReviews + arbiterRounds + jevReview + jev };
}

export const itemBlocked = runDir => existsSync(join(runDir, BLOCKED)) ? JSON.parse(readFileSync(join(runDir, BLOCKED), 'utf8')) : null;

export const OWNER_DECISION = 'OWNER_DECISION.json';

export function recordOwnerDecision(dir, keyPath, payload, signature) {
  let fd;
  let key;
  try {
    if (!constants.O_NOFOLLOW || !/^[A-Za-z0-9+/]{86}==$/.test(signature ?? '')) throw new Error();
    const parent = lstatSync(dirname(keyPath));
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022)) throw new Error();
    fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > 4096) throw new Error();
    const pem = readFileSync(fd, 'utf8');
    if (!pem.startsWith('-----BEGIN PUBLIC KEY-----\n')) throw new Error();
    key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64'))) throw new Error();
  } catch {
    throw new Error('OWNER_SIGNATURE_INVALID: an owner Ed25519 signature over the current decision is required');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const pending = join(dir, `.${OWNER_DECISION}.${randomUUID()}`);
  try {
    writeFileSync(pending,
      JSON.stringify({ ...JSON.parse(payload), signature, recordedAt: new Date().toISOString() }) + '\n',
      { flag: 'wx', mode: 0o600 });
    linkSync(pending, join(dir, OWNER_DECISION));
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('OWNER_DECISION_EXISTS: the run already has a disposition');
    throw error;
  } finally {
    rmSync(pending, { force: true });
  }
}

// Blocks the item for the orchestrator inbox as an owner decision: never approved, every later model round refused.
export function writeBlocked(runDir, { reason, openFindings: open = [], rulings = [], usage = itemUsage(runDir), binding, supersede }) {
  const prior = itemBlocked(runDir);
  if (prior && !(sameBlock(prior, supersede) && isModelRoundCeilingBlock(prior) &&
      /^(ARBITER_BLOCK|ARBITER_CAP|CONFIRM_FAILED):/.test(reason))) return prior;
  const ruling = escalationRows(runDir).findLast(e => isArbiterRuling(e) && e.mode === 'ruling' && (!binding || e.scope === binding.scope));
  const jev = jevReceipts(runDir).filter(e => ['plan', 'done'].includes(e?.gate)).map(({ gate, verdict, pass, inputSha256, at, reasons }) => ({ gate, verdict, pass, inputSha256, at, reasons }));
  const record = { status: 'BLOCKED', inbox: 'orchestrator', marker: 'owner decision', reason, ...binding, openFindings: open, rulings,
    ruling: ruling ? { receipt: ruling.id, arbiter: ruling.arbiter, decision: ruling.decision, rulings: ruling.rulings } : null, jev, usage, at: new Date().toISOString(),
    next: 'orchestrator inbox, marked owner decision: the orchestrator decides or escalates to the owner; never auto-approved' };
  const path = join(runDir, BLOCKED);
  const data = `${JSON.stringify(record, null, 2)}\n`;
  if (prior) {
    const pending = path + '.' + randomUUID();
    try {
      writeFileSync(pending, data, { flag: 'wx' });
      renameSync(pending, path);
    } finally {
      rmSync(pending, { force: true });
    }
  } else {
    writeFileSync(path, data, { flag: 'wx' });
  }
  mkdirSync(join(runDir, 'workers'), { recursive: true });
  writeFileSync(join(runDir, 'workers', 'blocked-report.md'), [`# Item BLOCKED (owner decision): ${reason}`, '',
    `Model rounds used: ${usage.total} (review ${usage.reviews}, plan review ${usage.planReviews}, Arbiter ${usage.arbiterRounds ?? usage.arbiter}, Jev review ${usage.jevReview}, Jev ${usage.jev}).`, '',
    '## Open findings', ...(open.length ? open.map(f => `- ${f.id} [${f.severity}] ${f.finding}`) : ['- none recorded']), '',
    `## Arbiter rulings${ruling ? ` (receipt ${ruling.id}, ${pinLabel(ruling.arbiter)}, ${ruling.decision})` : ''}`, ...(rulings.length ? rulings.map(r => `- ${r.id}: ${r.ruling}: ${r.reason}`) : ['- none']), '',
    '## Jev receipts', ...(jev.length ? jev.map(j => `- ${j.gate} ${j.verdict} input ${j.inputSha256 || 'n/a'} at ${j.at}${j.reasons?.length ? `: ${j.reasons.join('; ').slice(0, 300)}` : ''}`) : ['- none']), ''].join('\n'));
  appendEscalation(runDir, { kind: 'blocked', reason, marker: 'owner decision', completedAt: record.at,
    ...(prior ? { supersedes: { at: prior.at, reason: prior.reason } } : {}) });
  return record;
}

const budgetUnavailable = 'ARBITER_BUDGET_UNAVAILABLE: Arbiter daily budget needs host-side counting (CodeDen); not available';

export function isBudgetPermissionError(error) {
  if (!['EPERM', 'EACCES'].includes(error?.code) || typeof error.path !== 'string') return false;
  return isBudgetPath(error.path);
}

// The earlier CLI failure is evidence for one retry, not a ruling or a general ceiling exception.
function ceilingFault(dir, block, scope, head) {
  if (block?.status !== 'BLOCKED' || block.ruling || !head || block.head !== head ||
      block.scope !== scope || block.run !== basename(dir) || typeof block.at !== 'string') return null;
  const reason = /^(?:ROUNDS_CEILING: \d+ of \d+ model rounds used|ARBITER_CAP: \d+ of \d+ Arbiter calls used) after ARBITER_UNAVAILABLE: (.+)$/.exec(block.reason)?.[1];
  if (!reason) return null;
  const rows = readJsonl(join(dir, ESCALATION));
  const fault = rows.findLast(row => isToolingFault(row) && row.status === 'tooling-fault' && !row.retryOf &&
    row.scope === scope && row.head === head && row.run === block.run && row.toolingReason === reason &&
    typeof row.id === 'string' && typeof row.completedAt === 'string' && row.completedAt <= block.at);
  if (!fault || !rows.some(row => row.kind === 'arbiter-start' && row.id === fault.id && row.scope === scope &&
      row.head === head && row.run === fault.run && row.packetSha256 === fault.packetSha256 &&
      row.status === 'dispatched' && row.completedAt <= fault.completedAt)) return null;
  return { fault, rows };
}

export function ceilingArbiterRetry(dir, block, scope, head) {
  const previous = ceilingFault(dir, block, scope, head);
  if (!previous) return null;
  const { fault, rows } = previous;
  const last = rows.findLast(row => ['arbiter-start', 'arbiter'].includes(row.kind) && row.scope === scope);
  return last === fault ? fault : null;
}

function approvedRetryForBlock(dir, block, scope, ruling) {
  if (!ruling?.retryOf || !sameBlock(block, ruling.ceilingBlock)) return false;
  return ceilingFault(dir, block, scope, ruling.head)?.fault.id === ruling.retryOf;
}

// Recovery uses the recorded dispatch and report from this run, including for older rows without a run field.
export function verifiedCeilingRuling(team, dir, scope, ruling) {
  if (!ruling?.id || ruling.scope !== scope || ruling.status !== 'completed' || ruling.mode !== 'ruling' ||
      ruling.decision !== 'APPROVE' || !ruling.head || (ruling.run !== undefined && ruling.run !== basename(dir))) return false;
  try {
    const report = realpathSync(ruling.output);
    if (!report.startsWith(join(realpathSync(dir), 'workers') + sep)) return false;
    const started = readJsonl(join(dir, ESCALATION)).some(row => row.kind === 'arbiter-start' &&
      row.id === ruling.id && row.scope === scope && row.head === ruling.head && row.run === ruling.run &&
      row.packetSha256 === ruling.packetSha256 && row.retryOf === ruling.retryOf && JSON.stringify(row.ceilingBlock) === JSON.stringify(ruling.ceilingBlock) &&
      row.completedAt <= ruling.completedAt &&
      samePin(row.arbiter, ruling.arbiter, team));
    if (!started || !samePin(ruling.arbiter, arbiterPin(team, ruling.participants), team)) return false;
    for (const { source } of ruling.rulings) {
      if (source && (!source.outputSha256 || sha(reportText(source) ?? '') !== source.outputSha256)) return false;
    }
    const text = readFileSync(report, 'utf8');
    if (sha(text) !== ruling.outputSha256) return false;
    const parsed = parseRuling(text, ruling.rulings);
    return parsed.decision === 'APPROVE' && JSON.stringify(parsed.rulings) === JSON.stringify(ruling.rulings);
  } catch {
    return false;
  }
}

export function clearCeilingBlock(team, dir, block, scope, ruling, head) {
  if (!block) return;
  if ((!isModelRoundCeilingBlock(block) && !approvedRetryForBlock(dir, block, scope, ruling)) ||
      !sameBlock(itemBlocked(dir), block) ||
      (block.scope && (block.scope !== scope || block.run !== basename(dir) || block.head !== ruling?.head)) ||
      (block.ruling && block.ruling.receipt !== ruling?.id) ||
      !verifiedCeilingRuling(team, dir, scope, ruling)) throw new Error('ITEM_BLOCKED: ceiling recovery evidence changed');
  appendEscalation(dir, { kind: 'rounds-ceiling-resolved', scope, run: basename(dir), head,
    ruledHead: ruling.head, rulingId: ruling.id, outputSha256: ruling.outputSha256,
    block: { at: block.at, reason: block.reason }, completedAt: new Date().toISOString() });
  rmSync(join(dir, BLOCKED));
}

// Whether the next model round of this kind may start: null, or the refusal. kind: review | arbiter.
// A cap that ends the formula blocks the item (blocks: true); a configured daily budget only refuses Arbiter dispatch.
// Callers hold the item lock (withLock) from this check until the round is recorded.
export function nextCallProblem(team, runDir, kind, log, { scope, ceilingBlock, retryOf, head } = {}) {
  const b = itemBlocked(runDir);
  const retry = kind === 'arbiter' && retryOf && ceilingArbiterRetry(runDir, b, scope, head)?.id === retryOf;
  const ruling = b && kind === 'confirm' && scope && arbiterState(escalationRows(runDir), scope).ruling;
  const confirmedRetry = ruling && approvedRetryForBlock(runDir, b, scope, ruling) &&
    verifiedCeilingRuling(team, runDir, scope, ruling);
  if (b && !(scope && sameBlock(b, ceilingBlock) && (isModelRoundCeilingBlock(b) || retry || confirmedRetry))) {
    return { problem: `ITEM_BLOCKED: ${b.reason}; the orchestrator decides` };
  }
  const s = arbiterSettings(team);
  if (kind === 'arbiter' && !s.pin) return { problem: ARBITER_UNSET };
  const u = itemUsage(runDir, log);
  const exception = scope && (kind === 'arbiter' || kind === 'confirm');
  if (kind === 'arbiter') {
    const calls = scope && u.total >= s.totalRounds
      ? escalationRows(runDir).filter(row => row.scope === scope && (retry ? countsArbiterCall(row) : countsArbiterRound(row))).length
      : u.arbiter;
    if (calls >= s.callsPerItem) return { problem: `ARBITER_CAP: ${calls} of ${s.callsPerItem} Arbiter calls used`, blocks: true };
  }
  if (!exception && u.total >= s.totalRounds) return { problem: `ROUNDS_CEILING: ${u.total} of ${s.totalRounds} model rounds used`, blocks: true };
  if (kind === 'arbiter' && s.dailyBudgetUsd !== null) return { problem: budgetUnavailable, blocks: false };
  return null;
}

// Where the item stands in the code stage: blocked, review (a reviewer round may run), ruling, confirm (the regular
// reviewer's round on the fix) or final.
export function codeStage(team, runDir, reviewRows, { head, responses } = {}) {
  const s = arbiterSettings(team);
  const esc = escalationRows(runDir);
  const state = arbiterState(esc, 'code');
  const firstAt = state.first?.completedAt;
  const cycle = reviewCycle(firstAt ? reviewRows.filter(e => (e.completedAt || '') < firstAt) : reviewRows, esc, s.reviewFixRounds);
  const usage = itemUsage(runDir);
  const where = state.phase === 'none' ? cycle.label : state.phase === 'confirm' ? 'the regular reviewer confirms the VALID fixes' : `Arbiter ${state.phase}`;
  const formula = `Formula: ${where}; Arbiter calls ${usage.arbiter} of ${s.callsPerItem}; model rounds ${usage.total} of ${s.totalRounds}`;
  const blocked = itemBlocked(runDir);
  if (blocked) {
    if (head && responses && state.phase === 'ruling' && !cycle.pastLimit && !cycle.inputProblems.length) {
      const arbiterRetry = ceilingArbiterRetry(runDir, blocked, 'code', head);
      if (arbiterRetry) return { phase: 'ruling', ceilingBlock: blocked, arbiterRetry, cycle, state, formula };
    }
    if (head && (isModelRoundCeilingBlock(blocked) || approvedRetryForBlock(runDir, blocked, 'code', state.ruling))) {
      const bound = blocked.scope === 'code' && blocked.run === basename(runDir);
      if (state.phase === 'confirm') {
        const ruling = state.ruling;
        const legacy = blocked.scope === undefined && /; the confirming round needs \d+$/.test(blocked.reason) &&
          blocked.ruling?.receipt === ruling.id;
        if ((legacy || (bound && blocked.head === ruling.head && sameBlock(blocked, ruling.ceilingBlock))) &&
            verifiedCeilingRuling(team, runDir, 'code', ruling)) {
          return { phase: 'confirm', ceilingBlock: blocked, cycle, state, formula };
        }
      }
      if (bound && responses && blocked.head === head && !blocked.ruling && state.phase === 'none' &&
          cycle.latest?.head === head && cycle.latest.verdict === 'FINDINGS' && !cycle.pastLimit) {
        return { phase: 'ruling', ceilingBlock: blocked, cycle, state, formula };
      }
    }
    return { phase: 'blocked', blocked, cycle, state, formula };
  }
  if (state.phase !== 'none') return { phase: state.phase === 'final' ? `final-${state.decision.toLowerCase()}` : state.phase, cycle, state, formula };
  return { phase: cycle.due ? 'ruling' : 'review', cycle, state, formula };
}

export function loadEscalationTeam(options) {
  const team = lib.loadTeamChecked(options);
  return Object.keys(lib.arbiterLimits(team)).length ? team : null;
}

function jevLogs(runDir, log = join(runDir, JEV_LOG)) {
  const logs = escalationRows(runDir).filter(row => row.kind === 'jev-log').map(row => {
    if (!row.file || row.file !== basename(row.file) || ['.', '..'].includes(row.file)) {
      throw new Error('ESCALATION_UNREADABLE: invalid Jev log path');
    }
    return join(runDir, row.file);
  });
  return new Set([join(runDir, JEV_LOG), ...logs, log]);
}

export function registerJevLog(runDir, log) {
  if (!jevLogs(runDir).has(log)) appendEscalation(runDir, { kind: 'jev-log', file: basename(log) });
}

export function jevReceipts(runDir, log) {
  return [...jevLogs(runDir, log)].flatMap(file => readJsonl(file))
    .sort((a, b) => (a.at || '').localeCompare(b.at || ''));
}

function jevAttempts(runDir, gate, log) {
  return jevReceipts(runDir, log).filter(row => row.gate === gate && !row.dryRun && row.verdict !== 'unavailable');
}

function jevAttemptCap(settings, gate, attempts) {
  if (attempts.length < settings.jevAttempts) return null;
  return { problem: `JEV_ATTEMPT_CAP: ${attempts.length} of ${settings.jevAttempts} Jev ${gate} attempts used`,
    blocks: attempts.at(-1).pass !== true };
}

function jevBlockBinding(dir, gate) {
  try {
    const head = execFileSync('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { scope: `jev-${gate}`, head, run: basename(dir) };
  } catch { return undefined; }
}

export function blockJevAtCap(team, runDir, gate, log) {
  const cap = nextCallProblem(team, runDir, 'review', log)
    ?? jevAttemptCap(arbiterSettings(team), gate, jevAttempts(runDir, gate, log));
  if (cap?.blocks) writeBlocked(runDir, { reason: cap.problem, binding: jevBlockBinding(runDir, gate), usage: itemUsage(runDir, log) });
}

export function jevPrecheck(team, runDir, gate, log = join(runDir, JEV_LOG)) {
  if (!team || !Object.keys(lib.arbiterLimits(team)).length) return;
  const checkCap = cap => {
    if (!cap) return;
    if (cap.blocks) writeBlocked(runDir, { reason: cap.problem, binding: jevBlockBinding(runDir, gate), usage: itemUsage(runDir, log) });
    throw new Error(cap.problem);
  };
  const ceiling = nextCallProblem(team, runDir, 'review', log);
  if (ceiling && !ceiling.blocks) checkCap(ceiling);

  const settings = arbiterSettings(team);
  const attempts = jevAttempts(runDir, gate, log);
  if (ceiling) checkCap({ ...ceiling, blocks: attempts.at(-1)?.pass !== true });
  checkCap(jevAttemptCap(settings, gate, attempts));
  const refusals = attempts.slice(attempts.findLastIndex(row => row.pass === true) + 1);

  if (gate === 'done') {
    const reviewRows = readJsonl(join(runDir, REVIEWS));
    const stage = codeStage(team, runDir, reviewRows);
    if (stage.phase === 'ruling') {
      const cap = nextCallProblem(team, runDir, 'arbiter', log, { scope: 'code' });
      if (cap?.blocks) checkCap(cap);
    }
    if (stage.cycle.pastLimit) throw new Error('ARBITER_REQUIRED: a code review ran after escalation was due');
    if (stage.phase === 'review' && stage.cycle.latest?.verdict === 'FINDINGS') {
      throw new Error('CODE_REVIEW_PENDING: code review still has open findings');
    }
    if (stage.phase !== 'review' && stage.phase !== 'final-approve') {
      throw new Error(`ARBITER_REQUIRED: the code stage is ${stage.phase}`);
    }
    if (stage.state.phase === 'none') {
      const git = (...args) => execFileSync('git', ['-C', runDir, 'rev-parse', ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' }
      }).trim();
      let workTree;
      let head;
      try {
        workTree = git('--is-inside-work-tree');
        if (workTree === 'true') head = git('--verify', 'HEAD');
      } catch (error) {
        if (workTree !== undefined || process.env.GIT_DIR !== undefined ||
            error.status !== 128 || !/^fatal: not a git repository\s/.test(error.stderr)) {
          throw new Error('CODE_REVIEW_PENDING: Git could not resolve the worktree HEAD');
        }
        // Git can report the same discovery error when an ancestor has a broken .git directory.
        for (let dir = resolve(runDir); ; dir = dirname(dir)) {
          if (existsSync(join(dir, '.git'))) {
            throw new Error('CODE_REVIEW_PENDING: Git could not resolve the worktree HEAD');
          }
          if (dirname(dir) === dir) break;
        }
      }
      if (workTree !== undefined && !head) {
        throw new Error('CODE_REVIEW_PENDING: Git could not resolve the worktree HEAD');
      }
      if (head) {
        const rows = reviewRows.filter(e => verdictRow(e) && e.head === head);
        if (!rows.some(e => BASE_SLOTS.includes(e.slot)) ||
            !lowOnly(rows.filter(e => e.verdict === 'FINDINGS').map(verifiedFindings))) {
          throw new Error('CODE_REVIEW_PENDING: code review still has open findings');
        }
      }
    }
  }

  if (!refusals.length) return;
  const scope = `jev-${gate}`;
  const after = refusals.at(-1).at;
  const rows = escalationRows(runDir).filter(row => !after || row.completedAt > after);
  if (refusals.length === 1) {
    const reviews = rows.filter(row => row.kind === 'jev-review' && (row.scope === scope || row.gate === gate) && row.status === 'completed');
    if (reviews.length < settings.jevReviewRounds) {
      throw new Error(`JEV_REVIEW_REQUIRED: ${reviews.length} of ${settings.jevReviewRounds} Jev ${gate} review rounds recorded`);
    }
    return;
  }

  const state = arbiterState(rows, scope);
  if (state.phase === 'final' && state.decision === 'APPROVE') return;
  if (state.phase === 'final' && state.decision === 'BLOCK') {
    checkCap({ problem: `ARBITER_BLOCK: Jev ${gate} dispute ended in BLOCK`, blocks: true });
  }
  const cap = nextCallProblem(team, runDir, 'arbiter', log, { scope });
  if (cap?.blocks) checkCap(cap);
  throw new Error(`ARBITER_REQUIRED: Jev ${gate} needs a final Arbiter APPROVE`);
}

export function isModelRoundCeilingBlock(block) {
  return block?.status === 'BLOCKED' &&
    /^ROUNDS_CEILING: \d+ of \d+ model rounds used(?:; the item is still unresolved|; the confirming round needs \d+)?$/.test(block.reason);
}

function verifiedCleanReview(row) {
  const text = reportText(row);
  return text !== null && sha(text) === row.outputSha256 && lib.reviewVerdict(text) === 'CLEAN';
}

function settledAtCeiling(stage, reviewRows, head) {
  if (!head) return false;
  const { cycle, state } = stage;
  if (state.phase === 'none') {
    const latest = cycle.latest;
    return latest?.head === head && latest.verdict === 'CLEAN' &&
      latest.rows.every(row => row.verdict !== 'CLEAN' || verifiedCleanReview(row));
  }

  const final = state.confirm ?? state.ruling;
  if (state.phase !== 'final' || state.decision !== 'APPROVE' || final.head !== head) return false;
  const ruling = state.ruling;
  if (typeof ruling.id !== 'string' || !ruling.id.trim()) return false;
  const text = reportText(ruling);
  if (ruling.status !== 'completed' || text === null || sha(text) !== ruling.outputSha256) return false;
  const { findings, problems } = openCodeFindings(reviewRows, cycle, ruling.head);
  const parsed = parseRuling(text, findings);
  if (problems.length || parsed.decision !== 'APPROVE' ||
      JSON.stringify(parsed.rulings) !== JSON.stringify(ruling.rulings)) return false;
  if (!state.confirm) return true;

  const confirm = state.confirm;
  const rows = reviewRows.filter(row => verdictRow(row) && row.head === head &&
    row.completedAt > ruling.completedAt && row.completedAt <= confirm.completedAt);
  return confirm.rulingId === ruling.id && rows.some(row => BASE_SLOTS.includes(row.slot)) &&
    rows.every(row => row.verdict === 'CLEAN' && verifiedCleanReview(row)) &&
    JSON.stringify(confirm.rounds) === JSON.stringify(rows.map(({ round, slot, verdict, outputSha256 }) =>
      ({ round, slot, verdict, outputSha256 })));
}

// Merge-check problems. head: the commit being checked; the Arbiter's final head must be exactly it.
export function arbiterProblems(team, runDir, reviewRows, { highRisk = false, head = null, planRounds = Infinity, scope: checkScope } = {}) {
  const problems = [];
  let stage;
  try { stage = codeStage(team, runDir, reviewRows); } catch (e) { return [e.message]; }
  const esc = escalationRows(runDir);
  const { cycle, state } = stage;
  if (stage.blocked && !(isModelRoundCeilingBlock(stage.blocked) && settledAtCeiling(stage, reviewRows, head))) {
    problems.push(`ITEM_BLOCKED: ${stage.blocked.reason}`);
  }
  if (cycle.inputProblems.length) problems.push(`REPORT_UNVERIFIED: ${cycle.inputProblems.join('; ')}`);
  if (cycle.pastLimit) problems.push('ARBITER_REQUIRED: a code review round ran on a new head after the dispute was due for the Arbiter');
  if (state.phase === 'none' && cycle.due) problems.push(`ARBITER_RULING_MISSING: code review is due for the Arbiter (${cycle.trigger})`);
  if (state.first) {
    const arbiterHeads = new Set(esc.filter(e => e.kind === 'arbiter' && e.scope === 'code').map(e => e.head));
    const after = e => (e.completedAt || '') > (state.first.completedAt || '');
    const confirmRound = e => (state.phase === 'confirm' || state.confirm) && state.ruling && e.head !== state.ruling.head
      && (!state.confirm || (e.head === state.confirm.head && (e.completedAt || '') <= (state.confirm.completedAt || '')));
    const late = reviewRows.filter(e => ['team-review', 'invoke-lane'].includes(e?.kind) && e.slot !== 'native-factory' && after(e)
      && !(e.slot === 'second-pass' && arbiterHeads.has(e.head)) && !confirmRound(e));
    const confirmHeads = new Set(reviewRows.filter(e => after(e) && confirmRound(e)).map(e => e.head));
    if (late.length || confirmHeads.size > 1) problems.push('ARBITER_FINAL: a review round was recorded after the dispute went to the Arbiter, beyond the one confirming round');
  }
  // The plan dispute, from the run's own plan reviews.
  const reports = checkScope === 'code' ? [] : planReports(runDir);
  const plan = checkScope === 'code' ? null : arbiterState(esc, 'plan');
  if (plan) {
    const pc = planCycle(reports, esc, arbiterSettings(team).reviewFixRounds, planRounds);
    if (pc.problems.length) problems.push(`REPORT_UNVERIFIED: ${pc.problems.join('; ')}`);
    if (plan.phase === 'none' && pc.due && pc.latest) problems.push(`ARBITER_RULING_MISSING: plan review is due for the Arbiter (${pc.trigger})`);
  }
  for (const scope of plan ? ['code', 'plan'] : ['code']) {
    const s = scope === 'code' ? state : plan;
    if (s.phase === 'none') continue;
    for (const e of esc.filter(x => isArbiterRuling(x) && x.scope === scope)) {
      for (const { source } of e.rulings || []) {
        if (source && (!source.outputSha256 || sha(reportText(source) ?? '') !== source.outputSha256)) {
          problems.push(`REPORT_UNVERIFIED: ruling source ${source.output} changed or is missing`);
        }
      }
      if (scope === 'code' && codeWriterProblem(reviewRows, e.participants?.writer)) {
        problems.push('ARBITER_NOT_IN_TEAM: code writer differs from the underlying review receipts');
      }
      let want;
      try { want = arbiterPin(team, e.participants || {}); } catch (err) { problems.push(`ARBITER_NOT_IN_TEAM: ${scope}: ${err.message}`); continue; }
      if (!samePin(e.arbiter, want, team)) problems.push(`ARBITER_NOT_IN_TEAM: ${scope} ${e.mode} by ${pinLabel(e.arbiter)}, the Team's Arbiter is ${pinLabel(want)}`);
    }
    if (s.phase === 'final') {
      if (s.decision === 'BLOCK') { problems.push(`ARBITER_BLOCK: the ${scope} dispute ended in BLOCK; the ruling is final`); continue; }
      const final = s.confirm ?? s.ruling;
      if (scope === 'plan') {
        if (s.confirm && (!verifiedPlanConfirm(esc, reports, s.ruling, s.confirm) ||
            reports.some(report => report.n > s.confirm.report.n) ||
            (s.confirm.head && s.confirm.head !== s.ruling.head))) {
          problems.push('ARBITER_CONFIRM_UNVERIFIED: plan confirmation does not match the single reviewed subject and report');
        }
        const subject = final.subject;
        if (!subject?.path || !existsSync(subject.path) || sha(readFileSync(subject.path, 'utf8')) !== subject.sha256) problems.push(`ARBITER_PLAN_CHANGED: the approved plan ${subject?.path} changed after the final approval`);
        continue;
      }
      if (!s.confirm && !reviewRows.some(e => verdictRow(e) && BASE_SLOTS.includes(e.slot) && e.head === final.head)) {
        problems.push('ARBITER_HEAD: the approved code head has no ordinary review');
      }
      if (head && final.head !== head) problems.push(`ARBITER_HEAD: the Arbiter's dispute ended at ${final.head}, but ${head} is checked; changes after it were never reviewed`);
      if (highRisk) {
        // Every second pass on the final head: CLEAN, or (approval at the ruling) every finding ruled INVALID.
        const invalid = new Set(s.ruling.rulings.filter(r => r.ruling === 'INVALID').map(r => r.id));
        const passes = reviewRows.filter(e => e?.kind === 'team-review' && e.slot === 'second-pass' && e.head === final.head && verdictRow(e));
        const settled = e => e.verdict === 'CLEAN' || (!s.confirm && (v => Boolean(v.findings) && v.findings.every(f => invalid.has(f.id)))(verifiedFindings(e)));
        if (!passes.length || !passes.every(settled)) problems.push('SECOND_PASS_MISSING: high-risk change without a settled second pass (CLEAN, or every finding ruled INVALID) on the head the dispute ended at');
      }
      continue;
    }
    const l = s.last;
    if (isToolingFault(l) || l.status === 'unavailable') problems.push(`ARBITER_UNAVAILABLE: ${scope}: ${l.toolingReason ?? l.reason}`);
    else if (l.status === 'dispatched') problems.push(`ARBITER_INTERRUPTED: ${scope}: dispatch ${l.id} has no result`);
    else if (l.status === 'incomplete') problems.push(`ARBITER_INCOMPLETE: ${scope}: ${l.reason}`);
    else if (s.phase === 'confirm') problems.push(`ARBITER_CONFIRM_MISSING: ${scope}: ${s.valid.map(f => f.id).join(', ')} need the writer's fix and the regular reviewer's confirming round`);
    else problems.push(`ARBITER_RULING_MISSING: ${scope}`);
  }
  return problems;
}

function reclassifyCommand(args) {
  const [command, runFlag, path, dryFlag] = args;
  if (command !== 'reclassify' || runFlag !== '--run' || !path || path.startsWith('--') ||
      (args.length !== 3 && !(args.length === 4 && dryFlag === '--dry-run'))) {
    throw new Error('Usage: arbiter.mjs reclassify --run <run dir> [--dry-run]');
  }
  const runDir = realpathSync(path);
  if (!statSync(runDir).isDirectory()) throw new Error(`Not a run directory: ${runDir}`);
  const reclassify = () => {
    const rows = readJsonl(join(runDir, ESCALATION), 'ESCALATION_UNREADABLE');
    const blocked = itemBlocked(runDir);
    const recordedCap = rows.findLast(row => row.kind === 'arbiter' && Number.isInteger(row.settings?.callsPerItem))?.settings.callsPerItem;
    const blockedCap = arbiterCapBlock.exec(blocked?.reason)?.[2];
    const recorded = recordedCap ?? (blockedCap ? Number(blockedCap) : null);
    let repo;
    if (recorded === null && process.env.TEAM_FILE) {
      try {
        repo = realpathSync(execFileSync('git', ['-C', runDir, 'rev-parse', '--show-toplevel'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      } catch {
        throw new Error('TEAM_FILE_UNTRUSTED: reclassification with TEAM_FILE requires a Git worktree');
      }
    }
    const settings = recorded === null ? arbiterSettings(lib.loadTeamChecked({ real: !repo, ...(repo && { repo }) })) : null;
    const cap = recorded ?? settings.callsPerItem;
    const { before, after, reclassified, clearBlock } = planReclassification(rows, blocked, cap);
    if (!dryFlag) {
      const clearedBlock = clearBlock ? { at: blocked.at, reason: blocked.reason } : null;
      const logged = rows.some((row, index) => sameBlock(row.clearedBlock, blocked) && recordedCapClear(rows, index));
      if (reclassified.length || (clearBlock && !logged)) {
        appendEscalation(runDir, { kind: 'arbiter-reclassification', status: 'tooling-fault', reclassified, clearedBlock,
          before, after, completedAt: new Date().toISOString() });
      }
      if (clearBlock) rmSync(join(runDir, BLOCKED));
    }
    console.log(JSON.stringify({ runDir, before, after }));
  };
  if (dryFlag) reclassify();
  else withLock(join(runDir, '.arbiter-item.lock'), reclassify);
}

if (process.argv[1] && (() => {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})()) {
  try { reclassifyCommand(process.argv.slice(2)); } catch (error) {
    console.error(`arbiter: ${error.message}`);
    process.exitCode = 1;
  }
}
