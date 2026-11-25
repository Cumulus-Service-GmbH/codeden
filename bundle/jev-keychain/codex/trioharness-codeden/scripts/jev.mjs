#!/usr/bin/env node
// TrioHarness Lean — Jev decision gates.
// Called by the Architect at four decision points only (never per tool call):
//   route   → how much process a task needs (lean | standard | clarify)
//   plan    → is the plan in scope, grounded, provable, and gate-preserving
//   finding → may a HIGH/MEDIUM review finding be dismissed
//   done    → does the evidence support calling the task finished
// Each gate asks small atomic questions; all combining logic and thresholds live in code below.
// Usage: node jev.mjs <route|plan|finding|check|fixed|done> <input.json> [--dry-run] [--log <file>] [--attempt-repo <repo> --attempt-run <id>]
// Plan input: {objective, criteria, changes, proof, owned_paths, evidence, after?: "investigator-pack"|"scope-cut"}; attempt is assigned by --attempt-repo/--attempt-run; after required at attempt >=3; maximum 4 since the last pass.
// Exit: 0 pass · 2 blocked/escalate · 3 Jev unavailable or bad input (never treated as a pass)
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Gate paths from subdirectories: without --repo, the run ledger belongs to the worktree ROOT, never the cwd.
const worktreeRoot = d => { try { const t = execFileSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return t ? resolve(t) : resolve(d); } catch { return resolve(d); } };
import { pathToFileURL } from 'node:url';
import { redactText, redactDeep } from './secret-patterns.mjs';
import { isMain } from './is-main.mjs';
import { findException } from './exception-store.mjs';
import { auditCheckDigest, CHECK_THRESHOLDS, validateAuditCheck } from './guard.mjs';

// ── Everything a human should review lives in this block ─────────────────────────────
// TODO: Jev model will come from Settings → Team (Jev role) — app follow-up
export const MODEL = 'jev-latest';
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Initial thresholds. Tune from the receipts log after ~20 real decisions; they are not accuracy guarantees.
export const T = {
  routeConfidence: 0.70,   // below this, route falls back to "standard"
  inScope: 0.80, grounded: 0.70, proof: 0.70, weakensMax: 0.20,
  dismissAgreeConfidence: 0.75, dismissReproducedMax: 0.30,
  criterionMet: 0.80, failingMax: 0.20, unsupportedMax: 0.30,
  checkYes: CHECK_THRESHOLDS.yes, checkNoMax: CHECK_THRESHOLDS.no, resolved: 0.80, newBehaviourMax: 0.20
};
const MAX_CHECK_QUESTIONS = 12;
const EVIDENCE_ITEM_MAX = 3000;   // chars per evidence item (head + tail kept)
const STATE_MAX_BYTES = 40000;
const MAX_PLAN_CHANGES = 12;     // more change items than this → split the task    // Jev degrades on large, noisy state — split instead of stuffing

export const GATES = {
  route: {
    build: i => ({
      state: { task: need(i.task, 'task'), facts: clip(i.facts || []) },
      questions: {
        depth: { type: 'choice', instructions: 'How much process does `task` need before any code is changed?', criteria: {
          trivial: 'A mechanical change whose correct result is obvious from the task alone: text, documentation, comments, configuration values, a rename, or a one-line fix in a known place; at most two files and a few lines; no change to control flow, data handling, authentication, tenancy, persistence, schema, migrations, concurrency, public API, or deployment.',
          lean: 'One bounded behaviour change in files already identified, with an obvious test; no change to authentication, tenancy, persistence or database schema, migrations, concurrency, public API, or deployment.',
          standard: 'Touches several files or callers, or authentication, tenancy, persistence or database schema, migrations, concurrency, public API, or deployment, or the cause or affected code still has to be found.',
          clarify: 'The goal or the acceptance criteria are missing, ambiguous, or contradictory, so a human must clarify before planning.'
        } }
      }
    }),
    decide: a => {
      const { choice, confidence } = a.depth;
      if (choice === 'clarify') return { pass: false, verdict: 'clarify', reasons: ['task needs human clarification'] };
      // Low confidence always moves one tier up, never down.
      const up = { trivial: 'lean', lean: 'standard', standard: 'standard' };
      const depth = confidence >= T.routeConfidence ? choice : up[choice];
      return { pass: true, verdict: depth, reasons: depth !== choice ? [`low confidence ${confidence} → ${depth}`] : [] };
    }
  },
  plan: {
    // Judged per change item so a block names exactly which change lacks evidence or is out of scope.
    // Tests, verification and documentation of a change are part of that change, not extra scope.
    build: i => {
      // Churn brake: after two revises, an edited plan is not enough — bring new evidence or cut scope.
      const attempt = i.attempt === undefined ? 1 : i.attempt;
      if (!Number.isInteger(attempt) || attempt < 1) throw new Error('INPUT_INVALID:attempt must be a positive integer');
      if (attempt > 4) throw new Error('PLAN_ATTEMPTS_EXHAUSTED: four submissions used; stop and show the user the failing items');
      if (attempt >= 3 && !['investigator-pack', 'scope-cut'].includes(i.after)) throw new Error('PLAN_CHURN: attempt 3+ requires after="investigator-pack" (fresh cited evidence for the failing items) or after="scope-cut" (flagged items moved to a follow-up)');
      const changes = needArr(i.changes, 'changes');
      if (changes.length > MAX_PLAN_CHANGES) throw new Error(`PLAN_TOO_LARGE: ${changes.length} changes > ${MAX_PLAN_CHANGES}; split the task`);
      changes.forEach((c, n) => { if (!c || typeof c.file !== 'string' || typeof c.change !== 'string') throw new Error(`INPUT_MISSING:changes[${n}].file/change`); });
      const questions = {
        proof: { type: 'noul', instructions: 'Does `proof` name a specific test or command whose result would show that `objective` and `criteria` are met?' },
        weakens: { type: 'noul', instructions: 'Does any entry in `changes` delete, skip, loosen, or bypass a test, code review, validation, or security check?' }
      };
      changes.forEach((_, n) => {
        questions[`scope_${n}`] = { type: 'noul', instructions: `Is \`changes[${n}]\` needed to satisfy \`objective\` or one of \`criteria\`? A test, verification step, or documentation for a needed change counts as needed.` };
        questions[`grounded_${n}`] = { type: 'noul', instructions: `Does \`evidence\` show the current code, contract, or behaviour that \`changes[${n}]\` modifies or depends on?` };
        // A second grounding route, only for a new changelog note named for the plan's issue (same threshold).
        const issue = fragmentIssue(changes[n], i);
        if (issue) questions[`fragment_${n}`] = { type: 'noul', instructions: `\`changes[${n}].file\` is a changelog note named for #${issue}. Does \`changes[${n}].change\` only add a new note file (no edit, rename or deletion of an existing note, nothing else), and do \`objective\`, \`criteria\` or \`evidence\` show that #${issue} is this repository's issue that this plan fixes or builds and describe the user-facing change that the note records?` };
      });
      return { state: { objective: need(i.objective, 'objective'), criteria: needArr(i.criteria, 'criteria'), changes,
        proof: needArr(i.proof, 'proof'), owned_paths: i.owned_paths || [], evidence: clip(needArr(i.evidence)) }, questions };
    },
    decide: (a, i) => check([
      ...i.changes.flatMap((c, n) => [
        // The repository's changelog note for this plan's user-facing change is part of that change: a new-note
        // answer at the scope threshold puts it in scope. Every other item needs scope_n.
        fragmentIssue(c, i)
          ? [a[`scope_${n}`].noul >= T.inScope || a[`fragment_${n}`].noul >= T.inScope, `changes[${n}] ${c.file}: scope ${a[`scope_${n}`].noul} and new-note ${a[`fragment_${n}`].noul} < ${T.inScope} — drop it to a follow-up, tie it to a criterion, or make it only the new note for the plan's issue and its user-facing change`]
          : [a[`scope_${n}`].noul >= T.inScope, `changes[${n}] ${c.file}: scope ${a[`scope_${n}`].noul} < ${T.inScope} — drop it to a follow-up or tie it to a criterion`],
        fragmentIssue(c, i)
          ? [a[`grounded_${n}`].noul >= T.grounded || a[`fragment_${n}`].noul >= T.grounded, `changes[${n}] ${c.file}: grounded ${a[`grounded_${n}`].noul} and new-note ${a[`fragment_${n}`].noul} < ${T.grounded} — add the exact current note it edits, or, for a new note, name the plan's issue and the user-facing change it records`]
          : [a[`grounded_${n}`].noul >= T.grounded, `changes[${n}] ${c.file}: grounded ${a[`grounded_${n}`].noul} < ${T.grounded} — add the exact current code it touches or depends on`]
      ]),
      [a.proof.noul >= T.proof, `proof ${a.proof.noul} < ${T.proof} — name the RED/verification command`],
      [a.weakens.noul <= T.weakensMax, `weakens ${a.weakens.noul} > ${T.weakensMax}`]
    ])
  },
  finding: {
    // Fixing a finding never needs Jev. Only dismissing a HIGH/MEDIUM one does.
    skip: i => i.proposed === 'fix' || !/^(HIGH|MEDIUM)$/i.test(String(i.severity || ''))
      ? { pass: true, verdict: 'no-gate-needed', reasons: [i.proposed === 'fix' ? 'fixing is always allowed' : 'LOW findings are folded, not gated'] } : null,
    build: i => ({
      state: { finding: { id: need(i.id, 'id'), severity: i.severity, text: need(i.text, 'text') }, evidence: clip(needArr(i.evidence)) },
      questions: {
        disposition: { type: 'choice', instructions: 'Based only on `evidence`, what should happen to `finding`?', criteria: {
          fix: 'The problem in `finding` exists in the changed code and is within the task.',
          false_positive: '`evidence` shows the problem described in `finding` does not exist.',
          out_of_scope: 'The problem exists but was not introduced by this change and is not required by the task.',
          duplicate: '`evidence` shows the same problem is already tracked under another finding.'
        } },
        reproduced: { type: 'noul', instructions: 'Does `evidence` directly confirm that the problem described in `finding` exists in the current code?' }
      }
    }),
    decide: (a, i) => check([
      [a.disposition.choice === i.proposed, `Jev chose ${a.disposition.choice}, coordinator proposed ${i.proposed}`],
      [a.disposition.confidence >= T.dismissAgreeConfidence, `confidence ${a.disposition.confidence} < ${T.dismissAgreeConfidence}`],
      [i.proposed !== 'false_positive' || a.reproduced.noul <= T.dismissReproducedMax, `reproduced ${a.reproduced.noul} > ${T.dismissReproducedMax}`]
    ], 'dismiss', 'escalate-to-human')
  },
  check: {
    // Cheap typed judgement for intermediate Architect decisions (premise audits, fixture validity, design sanity)
    // that would otherwise cost a model worker. Each question is atomic and answerable from the evidence alone.
    build: i => {
      const qs = needArr(i.questions, 'questions');
      if (i.mode === 'audit') validateAuditCheck(i);
      if (qs.length > MAX_CHECK_QUESTIONS) throw new Error(`CHECK_TOO_LARGE: ${qs.length} questions > ${MAX_CHECK_QUESTIONS}; split the decision`);
      const questions = {};
      qs.forEach((q, n) => {
        if (!q || typeof q.ask !== 'string' || !q.ask.trim()) throw new Error(`INPUT_MISSING:questions[${n}].ask`);
        if (q.expect !== undefined && q.expect !== 'yes' && q.expect !== 'no') throw new Error(`INPUT_INVALID:questions[${n}].expect must be yes or no`);
        questions[`q_${n}`] = { type: 'noul', instructions: `Based only on \`evidence\`: ${q.ask}` };
      });
      return { state: { context: need(i.context, 'context'), evidence: clip(needArr(i.evidence)),
        ...(i.mode === 'audit' ? { mode: 'audit', audit: i.audit, auditQuestions: qs } : {}) }, questions };
    },
    decide: (a, i) => check(i.questions.map((q, n) => {
      const v = a[`q_${n}`].noul;
      return q.expect === 'no'
        ? [v <= T.checkNoMax, `q_${n} expected no, got ${v}: ${q.ask.slice(0, 80)}`]
        : [v >= T.checkYes, `q_${n} expected yes, got ${v}: ${q.ask.slice(0, 80)}`];
    }), 'confirmed', 'not-confirmed')
  },
  fixed: {
    // Verifies a correction batch against the findings it claims to fix, instead of a second full model review.
    build: i => {
      const findings = needArr(i.findings, 'findings');
      findings.forEach((f, n) => { if (!f || typeof f.id !== 'string' || typeof f.text !== 'string') throw new Error(`INPUT_MISSING:findings[${n}].id/text`); });
      const questions = {
        new_behaviour: { type: 'noul', instructions: 'Does `diff` change any behaviour beyond what is needed to resolve `findings`?' },
        failing: { type: 'noul', instructions: 'Does `evidence` show any failing test, build error, or guard violation?' }
      };
      findings.forEach((_, n) => { questions[`resolved_${n}`] = { type: 'noul', instructions: `Do \`diff\` and \`evidence\` show that \`findings[${n}]\` is resolved at its root cause?` }; });
      return { state: { findings, diff: clip([need(i.diff, 'diff')])[0], evidence: clip(needArr(i.evidence)) }, questions };
    },
    decide: (a, i) => check([
      ...i.findings.map((f, n) => [a[`resolved_${n}`].noul >= T.resolved, `${f.id} not shown resolved (${a[`resolved_${n}`].noul})`]),
      [a.new_behaviour.noul <= T.newBehaviourMax, `new_behaviour ${a.new_behaviour.noul} > ${T.newBehaviourMax} — the delta needs a reviewer`],
      [a.failing.noul <= T.failingMax, `failing ${a.failing.noul} > ${T.failingMax}`]
    ], 'verified', 'needs-review')
  },
  done: {
    build: i => {
      const criteria = needArr(i.criteria, 'criteria');
      // The done gate judges product behaviour only. Workflow conformance is proven by run-state and receipts,
      // delivery constraints by the delivery and browser-test gates; neither can be evidenced before delivery.
      const processTerms = /\b(trioharness|jev|gate|workflow|harness|code review|reviewer|fold|run-state|receipt)\b/i;
      const bad = criteria.findIndex(c => processTerms.test(String(c)));
      if (bad >= 0) throw new Error(`CRITERION_NOT_PRODUCT: criteria[${bad}] describes workflow, not product behaviour; it is proven by run-state/receipts or gates 9-10, not by the done gate`);
      const questions = {
        failing: { type: 'noul', instructions: 'Does `evidence` show any failing test, build error, or unresolved HIGH or MEDIUM review finding?' },
        unsupported: { type: 'noul', instructions: 'Does `evidence` contain a claim of success that is not backed by command output or test results?' }
      };
      // One question per criterion — never ask Jev to count or combine them.
      criteria.forEach((_, n) => { questions[`met_${n}`] = { type: 'noul', instructions: `Does \`evidence\` show that \`criteria[${n}]\` is satisfied?` }; });
      return { state: { objective: need(i.objective, 'objective'), criteria, evidence: clip(needArr(i.evidence)) }, questions };
    },
    decide: (a, i) => check([
      ...i.criteria.map((c, n) => [a[`met_${n}`].noul >= T.criterionMet, `criterion ${n} not shown (${a[`met_${n}`].noul}): ${String(c).slice(0, 80)}`]),
      [a.failing.noul <= T.failingMax, `failing ${a.failing.noul} > ${T.failingMax}`],
      [a.unsupported.noul <= T.unsupportedMax, `unsupported claims ${a.unsupported.noul} > ${T.unsupportedMax}`]
    ])
  }
};
// ─────────────────────────────────────────────────────────────────────────────────────

// A changelog fragment `changes/<issue>-<slug>.md` has no current code to cite. When the plan names that issue,
// its grounding comes from the issue and the plan; the threshold is unchanged. Returns the issue number or null.
export function fragmentIssue(change, plan) {
  const m = /^(?:\.\/)?changes\/(\d+)-[a-z0-9][a-z0-9-]*\.md$/.exec(String(change?.file ?? ''));
  if (!m) return null;
  const named = new RegExp(`(?<![\\w/.-])#${m[1]}(?!\\w)`);
  return [plan.objective, ...(Array.isArray(plan.criteria) ? plan.criteria : [])].some(t => named.test(String(t))) ? m[1] : null;
}
function need(v, name) { if (typeof v !== 'string' || !v.trim()) throw new Error(`INPUT_MISSING:${name}`); return v; }
function needArr(v, name = 'evidence') { if (!Array.isArray(v) || !v.length) throw new Error(`INPUT_MISSING:${name}`); return v; }
function check(rules, passVerdict = 'proceed', failVerdict = 'revise') {
  const reasons = rules.filter(([ok]) => !ok).map(([, why]) => why);
  return { pass: !reasons.length, verdict: reasons.length ? failVerdict : passVerdict, reasons };
}
export function clip(items) {
  return items.map(x => {
    const s = typeof x === 'string' ? x : JSON.stringify(x);
    return s.length <= EVIDENCE_ITEM_MAX ? s : `${s.slice(0, EVIDENCE_ITEM_MAX / 2)}\n…[clipped]…\n${s.slice(-EVIDENCE_ITEM_MAX / 2)}`;
  });
}
// Redaction uses the shared patterns and runs on each STRING VALUE before serialisation, so JSON
// escaping (\" inside a stringified excerpt) can never hide a `"Password": "…"` pair.
export const redact = redactText;
export function receiptsPath(repo = process.cwd()) {
  return join(homedir(), '.trioharness-lean', 'receipts', `${basename(resolve(repo))}.jsonl`);
}
function repoName() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return basename(dirname(common));
  } catch { return basename(process.cwd()); }
}
const KEY_MISSING = 'JEV_KEY_MISSING: configure the codeden Keychain item or TYPESAFE_API_KEY, TYPE_SAFE_API_KEY, JEV_API_KEY, or JEV_KEY_FILE';
const keyDirectory = join(homedir(), '.config', 'trioharness');
const KEYCHAIN_ACCESS_REQUIRED = 'JEV_KEYCHAIN_ACCESS_REQUIRED: the Jev key needs the owner’s one-time access grant for the non-interactive Keychain reader';

function keychainTransport({
  platform = process.platform, accountHome = userInfo().homedir, home = homedir(),
  run = spawnSync, timeout = 1500, requestTimeout = 22000
} = {}) {
  if (platform !== 'darwin' || resolve(home) !== resolve(accountHome)) return null;
  const security = join(accountHome, '.config', 'trioharness', 'jev-keyring-runtime', 'bin', 'jev-keychain-reader');
  const reader = lstatSync(security, { throwIfNoEntry: false });
  if (!reader) return null;
  if (!reader.isFile() || reader.nlink !== 1 || reader.uid !== process.getuid?.() ||
      (reader.mode & 0o022) || realpathSync(security) !== security) {
    throw new Error(KEYCHAIN_ACCESS_REQUIRED);
  }
  const opts = { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 + 4,
    stdio: ['ignore', 'pipe', 'ignore'], env: {} };
  const metadata = run(security, ['present'], opts);
  if (metadata.error || metadata.signal || metadata.stdout) throw new Error(KEYCHAIN_ACCESS_REQUIRED);
  if (metadata.status === 44) return null;
  if (metadata.status !== 0) throw new Error(KEYCHAIN_ACCESS_REQUIRED);

  return {
    verify() {
      const result = run(security, ['ready'], opts);
      if (result.error || result.signal || result.status !== 0 || result.stdout) throw new Error(KEYCHAIN_ACCESS_REQUIRED);
    },
    send(request) {
      const result = run(security, ['request'], { ...opts, timeout: requestTimeout,
        stdio: ['pipe', 'pipe', 'ignore'], input: JSON.stringify(request) });
      if (result.signal === 'SIGALRM') throw new Error(KEYCHAIN_ACCESS_REQUIRED);
      if (result.error || result.signal || result.status === 69) throw new Error('JEV_UNREACHABLE');
      if (result.status === 65) throw new Error('JEV_RESPONSE_INVALID');
      if (result.status !== 0) throw new Error(KEYCHAIN_ACCESS_REQUIRED);
      const frame = /^([1-5][0-9]{2})\n([\s\S]*)$/.exec(result.stdout);
      if (!frame) throw new Error('JEV_RESPONSE_INVALID');
      const status = Number(frame[1]);
      return { status, ok: status >= 200 && status < 300, json: () => JSON.parse(frame[2]) };
    }
  };
}

async function loadJevSource(env = process.env, { keychain = keychainTransport, readFile = readFileSync } = {}) {
  let transport;
  try { transport = await keychain(); }
  catch { throw new Error(KEYCHAIN_ACCESS_REQUIRED); }
  if (transport) return transport;
  const key = env.TYPESAFE_API_KEY || env.TYPE_SAFE_API_KEY || env.JEV_API_KEY;
  if (key) return { key };
  try {
    const contents = readFile(env.JEV_KEY_FILE || join(keyDirectory, 'jev.env'), 'utf8');
    const match = contents.match(/^\s*(?:TYPESAFE_API_KEY|TYPE_SAFE_API_KEY|JEV_API_KEY)\s*=\s*["']?([^"'\r\n]+)/m);
    return { key: match ? match[1].trim() : '' };
  } catch (error) {
    if (error.code === 'ENOENT') return { key: '' };
    throw new Error('JEV_KEY_FILE_UNREADABLE');
  }
}
function validAnswers(questions, answers) {
  for (const [id, q] of Object.entries(questions)) {
    const a = answers?.[id];
    if (!a || a.type !== q.type) return false;
    if (q.type === 'noul' && !(Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1)) return false;
    if (q.type === 'choice' && (typeof a.choice !== 'string' || !Object.hasOwn(q.criteria, a.choice) || !(Number.isFinite(a.confidence) && a.confidence >= 0 && a.confidence <= 1))) return false;
  }
  return true;
}

export async function ask(request, { key, send, fetchImpl = fetch, retries = 3 } = {}) {
  if (!key && !send) throw new Error(KEY_MISSING);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = send ? await send(request) : await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    } catch (error) {
      if (send && [KEYCHAIN_ACCESS_REQUIRED, 'JEV_RESPONSE_INVALID'].includes(error?.message)) throw error;
      if (attempt < retries) { await sleep(attempt); continue; }
      throw new Error('JEV_UNREACHABLE');
    }
    if ((res.status === 429 || res.status === 529) && attempt < retries) { await sleep(attempt); continue; }
    if (!res.ok) throw new Error(`JEV_HTTP_${res.status}`);
    try { return await res.json(); }
    catch { throw new Error('JEV_RESPONSE_INVALID'); }
  }
}
const sleep = n => new Promise(r => setTimeout(r, 500 * 2 ** n));

// The digest of exactly what Jev is shown for an input. A user's gate exception is bound to this value, so it covers
// that one judged input and nothing else.
export function inputDigest(gateName, input) {
  const gate = GATES[gateName]; if (!gate) throw new Error(`UNKNOWN_GATE:${gateName}`);
  if (gateName === 'check' && input.mode === 'audit') return auditCheckDigest(input);
  return createHash('sha256').update(JSON.stringify(redactDeep(gate.build(input).state))).digest('hex').slice(0, 16);
}

function redactCredential(value, key) {
  if (typeof value === 'string') return value.replaceAll(key, '[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redactCredential(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) =>
      [redactCredential(name, key), redactCredential(item, key)]));
  }
  return value;
}

export async function runGate(gateName, input, opts = {}) {
  const gate = GATES[gateName];
  if (!gate) throw new Error(`UNKNOWN_GATE:${gateName}`);
  const skipped = gate.skip?.(input);
  if (skipped) return { gate: gateName, ...skipped, jev: null };
  const built = gate.build(input);
  const state = redactDeep(built.state);
  const questions = redactDeep(built.questions);
  const stateText = JSON.stringify(state);
  if (Buffer.byteLength(stateText) > STATE_MAX_BYTES) throw new Error('STATE_TOO_LARGE: send only the evidence this decision needs');
  const request = { model: MODEL, state, questions };
  if (opts.dryRun) return { gate: gateName, dryRun: true, request: opts.showState ? request : { model: MODEL, questionCount: Object.keys(questions).length, stateBytes: Buffer.byteLength(stateText), stateSha256: createHash('sha256').update(stateText).digest('hex') } };
  const source = opts.key ? { key: opts.key } : await opts.loadSource?.();
  const data = await ask(request, { ...opts, ...source });
  if (!validAnswers(questions, data?.answers)) throw new Error('JEV_INVALID_ANSWER');
  const decision = gate.decide(data.answers, input);
  const clean = value => source?.key ? redactCredential(value, source.key) : value;
  const jev = { model: clean(data.model), answers: clean(data.answers), usage: clean(data.usage) };
  return { gate: gateName, ...decision, jev,
    inputSha256: gateName === 'check' && input.mode === 'audit' ? auditCheckDigest(input) : createHash('sha256').update(stateText).digest('hex').slice(0, 16), ...(input.mode === 'audit' ? { mode: 'audit', audit: input.audit } : {}) };
}

async function main(escalation = null) {
  process.exitCode = 3;
  const [gateName, inputPath, ...rest] = process.argv.slice(2);
  if (!gateName || gateName.startsWith('-') || !inputPath || inputPath.startsWith('-')) {
    process.stderr.write('Usage: node jev.mjs <route|plan|finding|check|fixed|done> <input.json> [--dry-run] [--log <file>] [--attempt-repo <repo> --attempt-run <id>]\nPlan input fields: attempt (positive integer, maximum 4); after: \"investigator-pack\"|\"scope-cut\" required at attempt >=3.\n');
    process.exit(gateName === '--help' || gateName === '-h' ? 0 : 3);
  }
  const flag = name => rest.includes(name);
  const opt = name => { const i = rest.indexOf(name), value = rest[i + 1]; return i >= 0 && value && !value.startsWith('--') ? value : undefined; };
  const attemptRepo = opt('--attempt-repo'), attemptRun = opt('--attempt-run');
  const exceptionRepo = opt('--exception-repo'), exceptionRun = opt('--exception-run');
  const repo = (attemptRepo ?? exceptionRepo) ? resolve(attemptRepo ?? exceptionRepo) : worktreeRoot('.');
  const hasException = Boolean(exceptionRepo && exceptionRun);
  const li = rest.indexOf('--log');
  const logPath = li >= 0 && rest[li + 1] ? rest[li + 1] : receiptsPath(repo);
  const runDir = dirname(resolve(logPath));
  if (!escalation && opt('--log') && !flag('--dry-run') && ['plan', 'done'].includes(gateName)
      && /(?:[\\/]\.trioharness-direct[\\/]runs|[\\/]trioharness-direct-runs)[\\/][^\\/]+$/.test(runDir)) {
    try {
      const arb = await import(existsSync(new URL('./arbiter.mjs', import.meta.url)) ? './arbiter.mjs' : '../../config/arbiter-lib.mjs');
      const team = arb.loadEscalationTeam({ repo });
      if (team) {
        const unlock = arb.lockItem(join(runDir, '.arbiter-item.lock'));
        try {
          arb.jevPrecheck(team, runDir, gateName, resolve(logPath));
          arb.registerJevLog(runDir, resolve(logPath));
          await main({ arb, team });
        } finally { unlock(); }
        return;
      }
    } catch (error) {
      const reason = redactText(String(error.message || error));
      process.stderr.write(`[JEV] ${gateName}: ${reason}\n`);
      process.stdout.write(`${JSON.stringify({ gate: gateName, pass: false, verdict: 'unavailable', reasons: [reason] })}\n`);
      return;
    }
  }
  const yellow = s => `\u001b[33m🟨 [JEV] ${s}\u001b[0m`;
  let out, reservedAttempt, reservedAfter, reservedSubmission, attemptState, outcomeInputDigest, auditTarget;
  try {
    if (attemptRepo && exceptionRepo && repo !== resolve(exceptionRepo)) throw new Error('REPO_FLAGS_CONFLICT');
    const tracked = flag('--attempt-repo') || flag('--attempt-run');
    if (tracked && (gateName !== 'plan' || !attemptRepo || !attemptRun)) throw new Error('ATTEMPT_FLAGS: plan requires both --attempt-repo <repo> and --attempt-run <id>');
    let input = JSON.parse(readFileSync(inputPath, 'utf8'));
    if (flag('--audit-repo') || flag('--audit-run')) {
      if (gateName !== 'check' || !opt('--audit-repo') || !opt('--audit-run')) throw new Error('AUDIT_FLAGS: check requires --audit-repo and --audit-run');
      const auditState = await import('./run-state.mjs');
      auditTarget = { repo: resolve(opt('--audit-repo')), run: opt('--audit-run'), state: auditState };
      input = auditState.prepareAuditCheck(auditTarget.repo, auditTarget.run, resolve(inputPath));
    } else if (input.mode === 'audit') throw new Error('AUDIT_FLAGS_REQUIRED');
    let sourcePromise;
    const loadSource = () => sourcePromise ??= loadJevSource();
    const verifySource = async () => {
      const source = await loadSource();
      if (source.verify) source.verify();
      else if (!source.key) throw new Error(KEY_MISSING);
    };
    if (auditTarget) {
      await runGate(gateName, input, { dryRun: true });
      if (!flag('--dry-run')) {
        await verifySource();
        const reservation = auditTarget.state.reserveAuditCheck(auditTarget.repo, auditTarget.run, resolve(inputPath), logPath);
        input = reservation.input; auditTarget.submission = reservation.submission;
      }
    }
    if (tracked) {
      // Caller attempt is ignored. Preflight all input/size checks without network or counting.
      input.attempt = 1;
      await runGate(gateName, input, { dryRun: true });
      if (!flag('--dry-run')) {
        await verifySource();
        attemptState = await import('./run-state.mjs');
        const submission = randomUUID();
        const digest = inputDigest('plan', input);
        input.attempt = attemptState.reserveAttempt(repo, attemptRun, 'plan', attempt => GATES.plan.build({ ...input, attempt }), submission, digest);
        reservedSubmission = submission;
        reservedAttempt = input.attempt; reservedAfter = input.after;
      }
    }
    if (gateName === 'plan') outcomeInputDigest = inputDigest('plan', input);
    out = await runGate(gateName, input, { loadSource, dryRun: flag('--dry-run'), showState: flag('--show-state') });
    // A user's recorded exception (gate-exception.mjs grant) turns ONE rejected plan input into an accepted one. Plan gate only,
    // only for the exact input the user saw rejected, never when Jev was unavailable (that is exit 3 above, never a pass).
    if (!out.dryRun && !out.pass && gateName === 'plan' && hasException) {
      const ex = findException(repo, exceptionRun, 'plan', out.inputSha256);
      if (ex) { out = { ...out, pass: true, verdict: 'accepted-exception', waived: out.reasons, reasons: [`waived by the user's exception ${ex.set} (${ex.at})`], exception: ex }; }
    }
    if (!out.dryRun && out.pass && hasException) {
      try {
        const { readState, resetAttempt } = await import('./run-state.mjs');
        // The exact-input outcome hook below authorizes and resets an awaiting run.
        if (readState(repo, exceptionRun)?.status !== 'awaiting-exception') resetAttempt(repo, exceptionRun, 'plan');
      } catch (e) { process.stderr.write(`ATTEMPT_RESET: ${redactText(String(e.message || e)).replace(/[\r\n]+/g, ' ')}\n`); }
    }
    if (reservedAttempt !== undefined && out.pass) {
      try { attemptState.resetAttempt(repo, attemptRun, 'plan'); }
      catch (e) { process.stderr.write(`ATTEMPT_RESET: ${redactText(String(e.message || e)).replace(/[\r\n]+/g, ' ')}\n`); }
    }
    process.exitCode = out.dryRun || out.pass ? 0 : 2;
  } catch (e) {
    out = { gate: gateName, pass: false, verdict: 'unavailable', reasons: [redactText(String(e.message || e))] };
    if (auditTarget && !flag('--dry-run')) {
      try { auditTarget.state.setGate(auditTarget.repo, auditTarget.run, { gate: 'audit-check', status: 'failed', note: 'Jev unavailable; no accepting outcome' }); }
      catch { /* changed candidate/mode already refuses acceptance */ }
    }
    process.exitCode = 3;
  }
  if (reservedAttempt !== undefined) { out.attempt = reservedAttempt; out.submission = reservedSubmission; if (reservedAfter !== undefined) out.after = redactDeep(reservedAfter); }
  if (auditTarget?.submission) out.submission = auditTarget.submission;
  out.at = new Date().toISOString();
  if (Array.isArray(out.reasons)) out.reasons = out.reasons.map(r => redactText(String(r)));
  if (!out.dryRun) { try { mkdirSync(dirname(logPath), { recursive: true }); appendFileSync(logPath, `${JSON.stringify(out)}\n`); } catch { /* receipt failure never flips a block into a pass */ } }
  if (escalation && out.pass === false && out.verdict !== 'unavailable') {
    try { escalation.arb.blockJevAtCap(escalation.team, runDir, gateName, resolve(logPath)); }
    catch (error) {
      process.exitCode = 3;
      process.stderr.write(`[JEV] ${redactText(String(error.message || error))}\n`);
    }
  }
  // Audit acceptance is recorded only after the exact outcome exists in its reserved log.
  if (auditTarget?.submission && !out.dryRun && out.mode === 'audit') {
    try { auditTarget.state.recordAuditOutcome(auditTarget.repo, auditTarget.run, out); }
    catch (e) {
      process.exitCode = 3; out.outcomeRecorded = false;
      process.stderr.write(`AUDIT_OUTCOME: ${redactText(String(e.message || e)).replace(/[\r\n]+/g, ' ')}\n`);
    }
  }
  // Report outcomes without changing the verdict, retries, receipt or exception prerequisites.
  if (gateName === 'plan' && !out.dryRun && outcomeInputDigest) {
    const trackedOutcome = reservedAttempt !== undefined;
    // Exception flags alone do not turn a detached successful judgement into a
    // tracked pass. Keep its CLI verdict/reset behavior; only a real grant can
    // authorize the accepting outcome hook without a reserved submission.
    if (trackedOutcome || hasException) {
      try {
        const canRecord = trackedOutcome || !out.pass || findException(repo, exceptionRun, 'plan', outcomeInputDigest);
        if (!canRecord) out.outcomeRecorded = false;
        if (canRecord) {
          const { recordPlanOutcome } = await import('./run-state.mjs');
          recordPlanOutcome(repo, trackedOutcome ? attemptRun : exceptionRun,
            { verdict: out.verdict, inputSha256: outcomeInputDigest, at: out.at, ...(reservedAttempt === undefined ? {} : { attempt: reservedAttempt, submission: reservedSubmission }) });
        }
      } catch (e) { process.exitCode = 3; out.outcomeRecorded = false; process.stderr.write(`PLAN_OUTCOME: ${redactText(String(e.message || e)).replace(/[\r\n]+/g, ' ')}\n`); }
    }
  }
  process.stderr.write(`${yellow(`${gateName}: ${out.dryRun ? 'dry-run' : out.verdict}${out.reasons?.length ? ' — ' + out.reasons.join('; ') : ''}`)}\n`);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

// No top-level await: gate-exception.mjs imports this module for its input digest.
if (isMain(import.meta.url)) void main();
