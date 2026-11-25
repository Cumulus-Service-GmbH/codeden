// TrioHarness Team library: loads Team policy and Settings pins (session Team or generated Team mirror)
// and checks recorded code-review rounds against the applicable Team.
// Canonical copy: ~/.config/trioharness/team-lib.mjs. team-sync.mjs copies it into each skill as scripts/team.mjs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';

// CodeDen runs agent tools with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so agent CLIs are resolved to absolute paths:
// PATH first, then the usual install folders. childPath() is the PATH to give them (their tools: node, git, ...).
const CLI_DIRS = () => [join(userInfo().homedir, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
export function resolveCli(name) {
  const dirs = [...String(process.env.PATH || '').split(delimiter).filter(Boolean), ...CLI_DIRS()];
  for (const d of dirs) { const p = join(d, name); try { accessSync(p, constants.X_OK); return realpathSync(p); } catch { } }
  throw new Error(`CLI_MISSING: ${name} not found on PATH or in ${CLI_DIRS().join(', ')}`);
}
export const childPath = () => [...new Set([dirname(process.execPath), ...CLI_DIRS(), ...String(process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(delimiter).filter(Boolean)])].join(delimiter);

export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const SIMPLE_ROLES = ['architect', 'writer', 'uiWriter', 'agentsMdWriter', 'planReviewer', 'investigator', 'browserTester', 'browserOperator', 'arbiter'];
export const SLOTS = ['primary', 'fallback', 'second-pass', 'native-factory'];
export const ARBITER_SETTINGS = Object.freeze({ reviewFixRounds: [1, 5], jevReviewRounds: [1, 5], callsPerItem: [1, 3], jevAttempts: [1, 3], totalRounds: [1, 12] });
const arbiterLimitKeys = [...Object.keys(ARBITER_SETTINGS), 'dailyBudgetUsd'];
export function arbiterSettingsProblem(s, where, { required = false } = {}) {
  for (const [k, [lo, hi]] of Object.entries(ARBITER_SETTINGS)) {
    if (s?.[k] === undefined && !required) continue;
    if (!Number.isInteger(s?.[k]) || s[k] < lo || s[k] > hi) return `${where}.${k} must be an integer from ${lo} to ${hi}`;
  }
  const b = s?.dailyBudgetUsd;
  if ((b === undefined && required) || (b !== undefined && b !== null && !(typeof b === 'number' && Number.isFinite(b) && b > 0))) return `${where}.dailyBudgetUsd must be null (off) or a number above 0`;
  return null;
}

export function arbiterLimits(team) {
  const source = team.arbiterLimits ?? team.roles?.arbiter;
  return Object.fromEntries(arbiterLimitKeys.filter(key => source && Object.hasOwn(source, key)).map(key => [key, source[key]]));
}

// The real account home (not $HOME), so a test or a session that rewrites HOME still reads the owner's Team.
// Staging hook: TRIOHARNESS_TEAM_HOME=<dir> moves the team dir and team-sync's targets under <dir> (to try a Team change
// before it goes live). Gate checks never honour it (real: true): they judge every round against the real team.json.
export const realTeamDir = () => join(userInfo().homedir, '.config', 'trioharness');
export const teamDir = ({ real = false } = {}) => (!real && process.env.TRIOHARNESS_TEAM_HOME) ? join(process.env.TRIOHARNESS_TEAM_HOME, '.config', 'trioharness') : realTeamDir();
export const teamFile = (o) => join(teamDir(o), 'team.json');
export const teamPolicyFile = (file = teamFile()) => join(dirname(file), 'team-policy.json');

const fail = msg => { throw new Error(`TEAM_INVALID: ${msg}`); };
const isStr = v => typeof v === 'string' && v.trim() !== '';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonicalJson = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const mirrorDigest = value => sha256(canonicalJson(value));
const mirrorError = () => new Error('TEAM_JSON_HAND_EDITED: team.json is not the generated mirror of Settings → Team; run node ~/.config/trioharness/team-export.mjs');

export function parseTeamMirror(text, file) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw mirrorError(); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw mirrorError();
  const { generatedSha256, ...body } = doc;
  const effective = body.source === 'settings-effective-team';
  if (Object.keys(body).length !== (effective ? 5 : 4) || body.version !== 1 || !isStr(body.generated) ||
      (!effective && body.source !== 'settings-default-team') || !Array.isArray(body.team) ||
      generatedSha256 !== mirrorDigest(body)) throw mirrorError();
  if (body.team.some(member => !member || Object.keys(member).length !== 4 ||
      !['role', 'provider', 'model', 'effort'].every(key => Object.hasOwn(member, key)))) throw mirrorError();
  if (effective && (!body.sources || typeof body.sources !== 'object' || Array.isArray(body.sources) ||
      Object.keys(body.sources).length !== body.team.length ||
      body.team.some(({ role }) => !Object.hasOwn(body.sources, role) ||
        (body.sources[role] !== null && !isStr(body.sources[role]))))) throw mirrorError();
  try { return loadAppTeam(file, text); } catch { throw mirrorError(); }
}

export function loadTeamPolicy(file = teamPolicyFile()) {
  const policy = JSON.parse(readFileSync(file, 'utf8'));
  const hasPin = value => value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
    ['provider', 'model', 'effort', 'codexStandIn'].includes(key) || hasPin(child));
  if (hasPin(policy)) throw new Error(`TEAM_POLICY_INVALID: ${file} holds a pin; pins come only from Settings → Team`);
  const bad = arbiterSettingsProblem(policy.roles?.arbiter, 'roles.arbiter', { required: true });
  if (bad) fail(bad);
  return validateTeam(policy);
}

const ROLE_LABELS = {
  architect: 'Architect', writer: 'Writer', uiWriter: 'UI Writer', agentsMdWriter: 'AGENTS.md Writer',
  planReviewer: 'Plan Reviewer', reviewer: 'Code Reviewer', reviewerFallback: 'Code Reviewer Fallback',
  arbiter: 'Arbiter', investigator: 'Investigator', browserTester: 'Browser Tester', browserOperator: 'Browser Operator',
};
export const roleLabel = key => ROLE_LABELS[key] || key;
export const unsetRole = key => `TEAM_ROLE_UNSET: Set the ${roleLabel(key)} in Settings → Team`;
export const isConfiguredPin = pin => isStr(pin?.provider) && pin.provider !== 'auto' && isStr(pin.model)
  && pin.model !== 'default' && !(pin.provider === 'gemini' && pin.model === 'auto') && EFFORTS.includes(pin.effort);
const pinFields = ({ provider, model, effort }) => ({ provider, model, effort });

export function settingsResolution(team, role, pin) {
  if (team.roleSources?.[role] === 'mirror') {
    return { role, ...pinFields(pin), source: 'mirror', mirrorSha256: team.mirror.fileSha256 };
  }
  return { role, ...pinFields(pin), source: 'settings',
    ...(team.app ? { teamFileSha256: team.app.fileSha256 } : { mirrorSha256: team.sha256 }) };
}

function checkPin(team, pin, where, { effortRequired = false, modelNullable = false } = {}) {
  if (!pin || typeof pin !== 'object') fail(`${where} missing`);
  if (!isStr(pin.provider) || !team.vendors[pin.provider]) fail(`${where}.provider "${pin.provider}" is not a key of vendors`);
  if (!(modelNullable && pin.model === null) && (!isStr(pin.model) || !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{1,79}$/.test(pin.model))) fail(`${where}.model "${pin.model}" is not a model id`);
  if (pin.effort === null && !effortRequired) return;
  if (!EFFORTS.includes(pin.effort)) fail(`${where}.effort "${pin.effort}" must be one of ${EFFORTS.join('|')}${effortRequired ? '' : ' or null'}`);
}

export function validateTeam(team) {
  if (!team || typeof team !== 'object') fail('not a JSON object');
  if (team.version !== 1) fail(`version ${team.version} is not supported (expected 1)`);
  if (!isStr(team.comment)) fail('comment missing');
  if (!team.vendors || typeof team.vendors !== 'object') fail('vendors missing');
  const r = team.roles || fail('roles missing');
  const exported = isStr(team.generated);
  const legacyArbiter = r.arbiter && ['provider', 'model', 'effort'].every(key => !Object.hasOwn(r.arbiter, key));
  for (const key of SIMPLE_ROLES) {
    if (r[key]?.provider !== undefined) {
      checkPin(team, r[key], `roles.${key}`, { modelNullable: exported });
    }
  }
  const limits = arbiterLimits(team);
  if (legacyArbiter || Object.keys(limits).length) {
    const bad = arbiterSettingsProblem(limits, 'Arbiter settings', { required: true });
    if (bad) fail(bad);
  }
  const plan = r.planReviewer;
  if (plan?.provider && !(exported && plan.effort === null) && (!plan.effort || EFFORTS.indexOf(plan.effort) < EFFORTS.indexOf(plan.minEffort || 'low') || plan.effort === 'minimal')) fail('roles.planReviewer.effort must be at least minEffort and never minimal');
  const cr = r.codeReviewer || fail('roles.codeReviewer missing');
  const reviewerOptions = { effortRequired: !exported, modelNullable: exported };
  if (cr.primary != null) checkPin(team, cr.primary, 'roles.codeReviewer.primary', reviewerOptions);
  if (cr.fallback != null && (typeof cr.fallback !== 'object' || Array.isArray(cr.fallback))) fail('roles.codeReviewer.fallback must be an object');
  for (const [writer, list] of Object.entries(cr.fallback ?? {})) {
    if (!team.vendors[writer]) fail(`roles.codeReviewer.fallback.${writer}: writer provider is not a key of vendors`);
    if (!Array.isArray(list) || !list.length) fail(`roles.codeReviewer.fallback.${writer} must be a non-empty ordered list`);
    list.forEach((pin, i) => {
      checkPin(team, pin, `roles.codeReviewer.fallback.${writer}[${i}]`, reviewerOptions);
      if (team.vendors[pin.provider] === team.vendors[writer]) fail(`roles.codeReviewer.fallback.${writer}[${i}] is the writer's own vendor`);
    });
  }
  const hr = cr.highRiskSecondPass || fail('roles.codeReviewer.highRiskSecondPass missing');
  if (typeof hr.required !== 'boolean') fail('highRiskSecondPass.required must be boolean');
  if (hr.reviewer !== 'primary') fail('highRiskSecondPass.reviewer must be "primary"');
  if (!Array.isArray(hr.pathPatterns)) fail('highRiskSecondPass.pathPatterns must be a list');
  for (const p of hr.pathPatterns) { try { new RegExp(p, 'i'); } catch { fail(`highRiskSecondPass.pathPatterns: bad regex ${p}`); } }
  if (hr.whenPrimaryUnavailable !== 'fallback-sufficient') fail('whenPrimaryUnavailable must be "fallback-sufficient"');
  if (!team.factory || !isStr(team.factory.recordAs)) fail('factory.recordAs missing');
  if (!team.policy || !['never', 'last-resort'].includes(team.policy.computerUse) || !isStr(team.policy.computerUseText)) fail('policy.computerUse must be "never" or "last-resort" with policy.computerUseText');
  for (const key of ['codexAgents', 'claudeAgents']) {
    if (!team[key] || typeof team[key] !== 'object' || Array.isArray(team[key])) fail(`${key} missing`);
  }
  return team;
}

export function loadTeam(file = teamFile()) {
  const policy = loadTeamPolicy(teamPolicyFile(file));
  const mirror = parseTeamMirror(readFileSync(file), file);
  return resolveTeamMembers(policy, mirror, null, true);
}

export const teamProvider = (team, provider) => Object.hasOwn(team?.providerAliases ?? {}, provider)
  ? team.providerAliases[provider] : provider;
export const vendorOf = (team, provider) => Object.hasOwn(team.vendors, provider) ? team.vendors[provider] : null;
export const pinLabel = p => p ? `${p.provider}/${p.model}/${p.effort ?? 'n/a'}` : 'none';
export function samePin(a, b, team) {
  if (!a || !b || a.provider !== b.provider || (a.effort ?? null) !== (b.effort ?? null)) return false;
  if (!team) return a.model === b.model;
  try { return sameModel(team, a.provider, a.model, b.model, [a, b]); }
  catch { return false; }
}

const isModelAlias = model => typeof model === 'string' && /^[a-z]+$/.test(model);

export function knownModelIds(team, provider, extraPins = []) {
  const members = team?.members ?? team?.app?.team ?? team?.mirror?.team;
  const roles = members ? {} : team?.roles ?? {};
  const { primary, fallback } = roles.codeReviewer ?? {};
  const pins = [...(members ?? []), ...Object.values(roles), primary, ...Object.values(fallback ?? {}).flat(), ...extraPins];
  return new Set(pins.filter(pin => pin?.model && teamProvider(team, pin.provider) === provider && !isModelAlias(pin.model)).map(pin => pin.model));
}

export function normalizeModel(team, provider, model, extraPins = []) {
  if (!isModelAlias(model)) return model;
  if (model !== 'default') {
    const matches = [...knownModelIds(team, provider, extraPins)].filter(id => id.split('-').includes(model));
    if (matches.length === 1) return matches[0];
  }
  throw new Error(`MODEL_ALIAS_UNKNOWN: ${provider}/${model} does not resolve to a unique Team model ID`);
}

export function sameModel(team, provider, a, b, extraPins = []) {
  return a === b || (provider === 'claude'
    && normalizeModel(team, provider, a, extraPins) === normalizeModel(team, provider, b, extraPins));
}

export function canonicalModel(team, provider, model) {
  if (!isModelAlias(model)) return model;
  const members = team?.members ?? team?.app?.team ?? team?.mirror?.team ?? [];
  const saved = model !== 'default' && members.some(pin => teamProvider(team, pin.provider) === provider && pin.model === model);
  if (saved && provider !== 'claude') return model;
  try {
    return normalizeModel(team, provider, model);
  } catch (error) {
    // Keep a picker value verbatim if the Team cannot prove a unique expansion.
    if (saved) return model;
    throw error;
  }
}

export const claudeMayReview = (team, writer) => isConfiguredPin(team.roles?.writer) && writer === team.roles.writer.provider
  && vendorOf(team, writer) !== null && vendorOf(team, writer) !== 'Anthropic';
export const ARBITER_UNSET = unsetRole('arbiter');
export function configuredArbiterPin(team) {
  const a = team.roles?.arbiter;
  return isConfiguredPin(a) ? pinFields(a) : null;
}

export const role = (team, key) => {
  if (!SIMPLE_ROLES.includes(key)) throw new Error(`TEAM_ROLE_UNKNOWN: ${key}`);
  const pin = team.roles[key];
  if (!isConfiguredPin(pin)) throw new Error(unsetRole(key));
  if (key === 'planReviewer' && (pin.effort === 'minimal' || EFFORTS.indexOf(pin.effort) < EFFORTS.indexOf(pin.minEffort ?? 'low'))) {
    fail('roles.planReviewer.effort must be at least minEffort and never minimal');
  }
  return pinFields(pin);
};

export function reviewChain(team, writer) {
  const cr = team.roles.codeReviewer;
  if (!isConfiguredPin(cr.primary)) throw new Error(unsetRole('reviewer'));
  if (!vendorOf(team, cr.primary.provider)) throw new Error(`${unsetRole('reviewer')} (provider ${cr.primary.provider} has no vendor)`);
  if (!team.app && !Object.hasOwn(team.vendors, writer)) throw new Error(`TEAM_WRITER_UNKNOWN: unknown writer provider "${writer}"`);
  if (!vendorOf(team, writer)) throw new Error(`REVIEWER_SAME_VENDOR: writer ${writer} has no known vendor`);
  if (vendorOf(team, cr.primary.provider) === vendorOf(team, writer)) throw new Error(`REVIEWER_SAME_VENDOR: ${pinLabel(cr.primary)} cannot be proven cross-vendor for ${writer}-written code`);
  return { primary: cr.primary, fallbacks: (cr.fallback?.[writer] || []).filter(isConfiguredPin), secondPass: cr.highRiskSecondPass };
}

// Parse invoke-lane's selected reviewer engine as a pin.
export function parseEngineLabel(label) {
  const m = String(label || '').match(/^([a-z0-9-]+)\/([^()\s]+)\(([a-z]+)\)$/i);
  return m ? { provider: m[1], model: m[2], effort: m[3] } : null;
}

// Why a reviewer is not allowed for this slot and writer, or null when it is.
export function reviewerProblem(team, { slot, writer, reviewer }) {
  if (!SLOTS.includes(slot)) return `unknown slot "${slot}"`;
  if (slot === 'native-factory') {
    return reviewer?.provider === 'codeden' && reviewer?.model === team.factory.recordAs ? null
      : `native-factory rounds are recorded as codeden/"${team.factory.recordAs}"`;
  }
  if (!isConfiguredPin(reviewer)) return unsetRole(slot === 'fallback' ? 'reviewerFallback' : 'reviewer');
  let chain;
  try {
    canonicalModel(team, reviewer.provider, reviewer.model);
    chain = reviewChain(team, writer);
  } catch (e) { return e.message; }
  const reviewerVendor = vendorOf(team, reviewer?.provider);
  const writerVendor = vendorOf(team, writer);
  if (reviewerVendor === writerVendor) return `same-vendor review: ${pinLabel(reviewer)} reviewing ${writer}-written code`;
  if (reviewerVendor === 'Anthropic') {
    if (writerVendor === null) return `writer ${writer} has no known vendor, so Claude cannot be proven cross-vendor`;
    if (isConfiguredPin(team.roles?.writer) && !claudeMayReview(team, writer)) return `Claude reviews only code from the Team's Writer (${team.roles.writer.provider}), not ${writer}-written code`;
  }
  if (slot === 'primary') return samePin(reviewer, chain.primary, team) ? null : `primary reviewer ${pinLabel(reviewer)} is not team.json's ${pinLabel(chain.primary)}`;
  if (slot === 'second-pass' && samePin(reviewer, chain.primary, team)) return null;
  if (!chain.fallbacks.length) return unsetRole('reviewerFallback');
  if (!chain.fallbacks.some(f => samePin(f, reviewer, team))) return `${slot} reviewer ${pinLabel(reviewer)} is not in team.json's fallback for ${writer}-written code (${chain.fallbacks.map(pinLabel).join(', ')})`;
  return null;
}

// Paths listed in the AGENTS.md section whose heading contains `section` (backticked tokens or the first word of a bullet).
export function agentsMdHighRiskPaths(text, section = 'High-risk') {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let inside = false; let level = 0;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (inside && h[1].length <= level) inside = false;
      if (h[2].toLowerCase().includes(section.toLowerCase())) { inside = true; level = h[1].length; }
      continue;
    }
    if (!inside) continue;
    const ticks = [...line.matchAll(/`([^`\s]+)`/g)].map(m => m[1]);
    if (ticks.length) out.push(...ticks);
    else { const b = line.match(/^\s*[-*]\s+([^\s,;]+)/); if (b) out.push(b[1]); }
  }
  return out.map(p => p.replace(/^\.\//, '')).filter(p => p && !p.includes('*') && !p.startsWith('/'));
}

export function highRiskPaths(team, paths, agentsMdText = '') {
  const hr = team.roles.codeReviewer.highRiskSecondPass;
  const res = hr.pathPatterns.map(p => new RegExp(p, 'i'));
  const listed = agentsMdHighRiskPaths(agentsMdText, hr.agentsMdSection || 'High-risk');
  return paths.filter(p => res.some(re => re.test(p)) || listed.some(l => l.endsWith('/') ? p.startsWith(l) : p === l));
}

// Normalise one CODE_REVIEW_ROUNDS.jsonl entry to { slot, writer, reviewer, fallbackReason, highRisk } or a problem.
export function normaliseRound(team, entry) {
  if (entry.reviewer && entry.slot) {
    return { slot: entry.slot, writer: entry.writer?.provider || entry.writer, reviewer: entry.reviewer, fallbackReason: entry.fallbackReason, highRisk: entry.highRisk === true, source: entry.kind || 'team-review', evidence: entry.evidence || null };
  }
  const pin = parseEngineLabel(entry.selectedReviewerEngine);
  if (pin) { // invoke-lane receipt written before it recorded slots: it can only be a fallback route (it cannot run agy)
    const writers = Object.entries(team.roles.codeReviewer.fallback ?? {}).filter(([, list]) => list.some(f => samePin(f, pin, team))).map(([w]) => w);
    return { slot: 'fallback', writer: writers.length === 1 ? writers[0] : null, reviewer: pin, fallbackReason: 'invoke-lane receipt (invoke-lane cannot run the primary reviewer)', highRisk: false, source: 'invoke-lane' };
  }
  return { problem: 'REVIEWER_UNRECORDED: round has no reviewer provider/model/effort' };
}

export function reviewVerdict(text) {
  let fence = null;
  let verdict = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && (open[1][0] === '~' || !open[2].includes('`'))) {
      fence = open[1];
      continue;
    }
    const decision = line.match(/^ {0,3}REVIEW_DECISION:[ \t]*(CLEAN|FINDINGS)[ \t]*$/);
    if (decision) {
      if (verdict) return null;
      verdict = decision[1];
    }
  }
  return verdict;
}

const hasVerdict = e => e.verdict === 'CLEAN' || e.verdict === 'FINDINGS';

function verifiedInitModel(reviewer, evidence) {
  const reported = evidence?.initModel;
  return isStr(reported) && (reviewer.model === reported
    || samePin(reviewer, { ...reviewer, model: reported.split('[', 1)[0] }, {}));
}

export function fallbackTrigger(team, preceding, head, primaryExitId) {
  if (!head) return { problem: 'fallback requires a frozen git head' };
  const primary = preceding.filter(e => e?.kind === 'team-review' && e.slot === 'primary'
    && e.head === head && samePin(e.reviewer, team.roles.codeReviewer.primary, team));
  if (primary.some(e => e.status === 'completed' && !e.partial && hasVerdict(e))) {
    return { problem: 'the primary already gave a verdict on this head' };
  }
  const partial = primary.findLast(e => e.partial);
  const exit = e => e.evidence?.exitCode === 3 && isStr(e.evidence.fallbackReason) && isStr(e.id)
    && (primaryExitId === undefined || e.id === primaryExitId);
  if (partial) {
    const reports = Array.isArray(partial.partReports) ? partial.partReports : [];
    const failed = reports.at(-1);
    const missing = partial.unreviewedParts;
    const valid = partial.status === 'completed' && partial.verdict === 'FINDINGS' && exit(partial)
      && verifiedInitModel(partial.reviewer, partial.evidence)
      && isStr(partial.partFallbackPacket?.packetSha256) && isStr(partial.partFallbackPacket?.packetPath)
      && failed?.exitCode === 3 && Array.isArray(missing) && missing.length > 0
      && reports.some(part => part?.verdict === 'FINDINGS')
      && reports.slice(0, -1).every((part, i) => part?.part === i + 1 && part.exitCode === 0 && hasVerdict(part))
      && failed.part === reports.length && missing.every((part, i) => part === failed.part + i);
    return valid ? { trigger: partial } : { problem: 'fallback needs the cited partial primary exit 3 and its saved missing-parts packet' };
  }
  const trigger = primary.findLast(e => e.status === 'unavailable' && exit(e));
  return trigger ? { trigger } : { problem: 'fallback needs a preceding primary exit 3 on this head' };
}

export function primaryVerdictIndex(team, entries, head) {
  if (!head) return -1;
  return entries.findLastIndex(e => e?.kind === 'team-review' && e.slot === 'primary'
    && e.head === head && samePin(e.reviewer, team.roles.codeReviewer.primary, team)
    && e.status === 'completed' && !e.partial && hasVerdict(e));
}

export function secondPassFallbackTrigger(team, preceding, head, { primaryExitId, fallbackReason } = {}) {
  const base = primaryVerdictIndex(team, preceding, head);
  if (base < 0) return { problem: 'second-pass fallback requires a primary verdict on this head' };
  const trigger = preceding.slice(base + 1).findLast(e => e?.kind === 'team-review'
    && e.slot === 'second-pass' && e.head === head && samePin(e.reviewer, team.roles.codeReviewer.primary, team)
    && e.status === 'unavailable' && e.evidence?.exitCode === 3
    && isStr(e.evidence.fallbackReason) && isStr(e.id)
    && (primaryExitId === undefined || e.id === primaryExitId)
    && (fallbackReason === undefined || e.evidence.fallbackReason === fallbackReason));
  return trigger ? { trigger } : { problem: 'second-pass fallback needs a recorded primary second-pass exit 3 after the verdict on this head' };
}

const slotGroup = e => ['primary', 'fallback'].includes(e.slot) ? 'base' : e.slot;
const timeOf = e => {
  const time = Date.parse(e.completedAt ?? e.entry.completedAt ?? e.entry.at);
  return Number.isFinite(time) ? time : -Infinity;
};
const later = (a, b) => timeOf(a) > timeOf(b)
  || (timeOf(a) === timeOf(b) && a.index > b.index);

function checkLegacyRounds({ team, entries, changedPaths = [], agentsMdText = '' }) {
  const cr = team.roles.codeReviewer;
  const problems = [];
  const rounds = [];
  entries.filter(e => e && e.status === 'completed').forEach((e, i) => {
    const n = normaliseRound(team, e);
    if (n.problem) { problems.push(`round ${i + 1}: ${n.problem}`); return; }
    const legacyPrimarySecond = n.slot === 'second-pass' && samePin(n.reviewer, cr.primary, team);
    const p = reviewerProblem(team, legacyPrimarySecond ? { ...n, slot: 'primary' } : n)
      || (n.slot === 'fallback' && !isStr(n.fallbackReason) ? 'fallback round has no fallback reason' : null);
    // Every round is judged against the current team.json allow-list (a change unrelated to reviewers never invalidates it).
    if (p) problems.push(`round ${i + 1}: REVIEWER_NOT_IN_TEAM: ${p}`);
    else if (samePin(n.reviewer, team.roles.codeReviewer.primary, team) && (n.source !== 'team-review' || !verifiedInitModel(n.reviewer, n.evidence))) problems.push(`round ${i + 1}: PRIMARY_UNVERIFIED: a ${pinLabel(n.reviewer)} round needs the wrapper's init-model evidence (team-review.mjs run / second-pass)`);
    rounds.push(n);
  });
  const writers = [...new Set(rounds.filter(r => r.slot !== 'native-factory' && r.writer).map(r => r.writer))];
  if (writers.length > 1) problems.push(`WRITER_INCONSISTENT: rounds name writers ${writers.join(', ')}`);
  const pathHits = highRiskPaths(team, changedPaths, agentsMdText);
  const highRisk = pathHits.length > 0 || entries.some(e => e?.highRisk === true);
  const native = rounds.some(r => r.slot === 'native-factory');
  const hr = team.roles.codeReviewer.highRiskSecondPass;
  if (highRisk && hr.required && !native) {
    const base = rounds.filter(r => r.slot === 'primary' || r.slot === 'fallback');
    const second = rounds.filter(r => r.slot === 'second-pass');
    if (!base.length) problems.push('REVIEW_MISSING: high-risk change without a primary (or fallback) code review round');
    else {
      const fellBack = !base.some(r => r.slot === 'primary');
      const good = second.some(r => samePin(r.reviewer, cr.primary, team) === fellBack);
      if (!good) {
        const expected = fellBack ? pinLabel(cr.primary) : cr.fallback?.[writers[0]]?.map(pinLabel).join(' or ') || 'team.json fallback';
        problems.push(`SECOND_PASS_MISSING: high-risk change (${pathHits.slice(0, 5).join(', ') || 'declared high-risk'}) needs a completed second pass by ${expected}`);
      }
    }
  }
  return { ok: !problems.length, problems, highRisk, highRiskPaths: pathHits, nativeFactory: native, writer: writers[0] || null, rounds: rounds.map(r => ({ slot: r.slot, writer: r.writer, reviewer: pinLabel(r.reviewer), fallbackReason: r.fallbackReason || null, source: r.source })) };
}

// Gate check over a run's completed review rounds. changedPaths: base...HEAD names; agentsMdText: the repo's AGENTS.md.
export function checkReviewRounds({ team, entries, changedPaths = [], agentsMdText = '' }) {
  const isCurrent = e => e?.kind === 'team-review' && e.schema === 2;
  const hasDeclaredHighRisk = entries.some(e => e?.highRisk === true);
  if (!entries.some(e => isCurrent(e) && e.status === 'completed' && hasVerdict(e))) {
    const legacy = checkLegacyRounds({ team, entries, changedPaths, agentsMdText });
    const incomplete = new Set();
    entries.forEach((entry, index) => {
      if (!isCurrent(entry)) return;
      if (entry.status === 'completed' && entry.slot !== 'native-factory') {
        legacy.problems.push(`round ${index + 1}: REVIEW_INCOMPLETE: missing verdict`);
      }
      if (entry.status === 'incomplete') incomplete.add(slotGroup(entry));
    });
    if (!legacy.nativeFactory) {
      for (const group of incomplete) {
        legacy.problems.push(`REVIEW_INCOMPLETE: ${group} review has no completed verdict after the incomplete round`);
      }
    }
    return { ...legacy, ok: legacy.problems.length === 0 };
  }
  entries = entries.filter(e => isCurrent(e) || e?.slot === 'native-factory');
  const problems = [];
  const rounds = [];
  const incomplete = new Map();
  const partial = new Map();
  entries.forEach((entry, index) => {
    if (entry?.kind !== 'team-review') return;
    const pending = entry.partial ? partial : entry.status === 'incomplete' ? incomplete : null;
    if (!pending) return;
    const group = slotGroup(entry);
    const row = { entry, index };
    if (!pending.has(group) || later(row, pending.get(group))) pending.set(group, row);
  });
  entries.forEach((entry, index) => {
    if (entry?.status !== 'completed' || entry.partial) return;
    const row = { entry, index };
    const n = normaliseRound(team, entry);
    if (n.problem) { problems.push(`round ${index + 1}: ${n.problem}`); return; }
    const p = reviewerProblem(team, n);
    // Every round is judged against the current team.json allow-list (a change unrelated to reviewers never invalidates it).
    if (p) problems.push(`round ${index + 1}: REVIEWER_NOT_IN_TEAM: ${p}`);
    else if (n.source === 'team-review' && n.slot !== 'native-factory' && !hasVerdict(entry)) problems.push(`round ${index + 1}: REVIEW_INCOMPLETE: missing verdict`);
    else if (samePin(n.reviewer, team.roles.codeReviewer.primary, team) && (n.source !== 'team-review' || !verifiedInitModel(n.reviewer, n.evidence))) problems.push(`round ${index + 1}: PRIMARY_UNVERIFIED: a ${pinLabel(n.reviewer)} round needs the wrapper's init-model evidence (team-review.mjs run)`);
    if (p && Array.isArray(entry.parts)) return;
    let coveredPartial;
    if (!p && n.slot === 'fallback' && hasVerdict(entry)) {
      const { trigger, problem } = fallbackTrigger(team, entries.slice(0, index), entry.head, entry.primaryExitId ?? null);
      if (!trigger || n.fallbackReason !== trigger.evidence.fallbackReason) {
        problems.push(`round ${index + 1}: FALLBACK_REFUSED: ${problem || 'fallback reason differs from wrapper evidence'}`);
        return;
      }
      if (trigger.partial || Array.isArray(entry.parts)) {
        const parts = trigger.unreviewedParts;
        if (!trigger.partial || !Array.isArray(entry.parts) || entry.parts.length !== parts.length
          || !parts.every((part, i) => entry.parts[i] === part)
          || n.writer !== trigger.writer?.provider || entry.packetSha256 !== trigger.partFallbackPacket.packetSha256) {
          problems.push(`round ${index + 1}: FALLBACK_REFUSED: fallback must match the partial round's writer and missing-parts packet`);
          return;
        }
        coveredPartial = trigger;
      }
    }
    if (n.slot === 'second-pass' && entry.secondPassRule === 'neon-first' && !samePin(n.reviewer, team.roles.codeReviewer.primary, team)) {
      const preceding = entries.slice(0, index);
      if (primaryVerdictIndex(team, preceding, entry.head) >= 0) {
        const { problem } = secondPassFallbackTrigger(team, preceding, entry.head, {
          primaryExitId: entry.primaryExitId ?? null, fallbackReason: n.fallbackReason ?? null,
        });
        if (problem) problems.push(`round ${index + 1}: FALLBACK_REFUSED: ${problem}`);
      }
    }
    const group = slotGroup(entry);
    if ([incomplete.get(group), partial.get(group)].some(cutoff => cutoff && !later(row, cutoff))) return;
    if (coveredPartial) {
      if (partial.get(group)?.entry !== coveredPartial) return;
      // The cited fallback closes coverage, while the base keeps Neon's verdict and packet.
      rounds.push({ ...normaliseRound(team, coveredPartial), entry: coveredPartial,
        index, completedAt: entry.completedAt });
    }
    rounds.push({ ...n, ...row });
  });
  const writers = [...new Set(rounds.filter(r => r.slot !== 'native-factory' && r.writer).map(r => r.writer))];
  if (writers.length > 1) problems.push(`WRITER_INCONSISTENT: rounds name writers ${writers.join(', ')}`);
  const pathHits = highRiskPaths(team, changedPaths, agentsMdText);
  const highRisk = pathHits.length > 0 || hasDeclaredHighRisk;
  const native = rounds.some(r => r.slot === 'native-factory');
  const hr = team.roles.codeReviewer.highRiskSecondPass;
  for (const group of partial.keys()) {
    if (!rounds.some(r => slotGroup(r) === group && hasVerdict(r.entry))) problems.push(`REVIEW_PARTIAL: ${group} review has no completed verdict after the partial round`);
  }
  if (!native) {
    for (const group of incomplete.keys()) {
      if (!rounds.some(r => slotGroup(r) === group)) problems.push(`REVIEW_INCOMPLETE: ${group} review has no completed verdict after the incomplete round`);
    }
  }
  if (highRisk && hr.required && !native) {
    const base = rounds.filter(r => slotGroup(r) === 'base' && !Array.isArray(r.entry.parts)).reduce((latest, row) => !latest || later(row, latest) ? row : latest, null);
    if (!base) problems.push('REVIEW_MISSING: high-risk change without a primary (or fallback) code review round');
    else {
      const { primary } = team.roles.codeReviewer;
      const good = rounds.some(r => {
        if (r.slot !== 'second-pass') return false;
        const isPrimary = samePin(r.reviewer, primary, team);
        const freshOutput = r.index > base.index && later(r, base) && r.entry.head === base.entry.head
          && isStr(r.entry.output) && r.entry.output !== base.entry.output;
        const sameFallback = !isPrimary && r.entry.primaryExitId === base.entry.primaryExitId && r.fallbackReason === base.fallbackReason;
        if (r.entry.secondPassRule === undefined) {
          const baseInvocation = base.evidence?.invocationId;
          const secondInvocation = r.evidence?.invocationId;
          const reusedInvocation = isStr(baseInvocation) && baseInvocation === secondInvocation;
          return freshOutput && isStr(base.entry.head) && !reusedInvocation
            && (base.slot === 'primary' ? !isPrimary : sameFallback);
        }
        if (r.entry.secondPassRule !== 'neon-first' || !freshOutput || !base.entry.head
          || !isStr(base.entry.packetSha256) || r.entry.packetSha256 !== base.entry.packetSha256) return false;
        if (base.slot === 'fallback') return sameFallback;
        if (isPrimary) {
          return isStr(base.evidence?.invocationId) && isStr(r.evidence?.invocationId)
            && r.evidence.invocationId !== base.evidence.invocationId
            && isStr(base.entry.outputSha256) && isStr(r.entry.outputSha256);
        }
        const { trigger } = secondPassFallbackTrigger(team, entries.slice(0, r.index), r.entry.head, {
          primaryExitId: r.entry.primaryExitId ?? null, fallbackReason: r.fallbackReason ?? null,
        });
        return trigger?.packetSha256 === base.entry.packetSha256;
      });
      if (!good) {
        problems.push(`SECOND_PASS_MISSING: high-risk change (${pathHits.slice(0, 5).join(', ') || 'declared high-risk'}) needs a fresh second pass by the primary, or an authorized writer-specific fallback`);
      }
    }
  }
  return { ok: !problems.length, problems, highRisk, highRiskPaths: pathHits, nativeFactory: native, writer: writers[0] || null, rounds: rounds.map(r => ({ slot: r.slot, writer: r.writer, reviewer: pinLabel(r.reviewer), fallbackReason: r.fallbackReason || null, source: r.source })) };
}

// Runs `team-sync.mjs --check`; throws TEAM_DRIFT with its output when anything generated from team.json drifted.
export function assertTeamInSync({ real = false } = {}) {
  const sync = join(teamDir({ real }), 'team-sync.mjs');
  const env = { ...process.env }; if (real) delete env.TRIOHARNESS_TEAM_HOME;
  if (!existsSync(sync)) throw new Error(`TEAM_DRIFT: ${sync} missing; cannot verify the generated copies of team.json`);
  const r = spawnSync(process.execPath, [sync, '--check'], { encoding: 'utf8', timeout: 30000, env });
  if (r.status !== 0) {
    throw new Error(`TEAM_DRIFT: generated Team copies differ from team.json; run \`node ${sync}\` (owner) and retry.\n${(r.stdout || '') + (r.stderr || '')}`.trim());
  }
  return true;
}

// In-app Team (CodeDen). The CodeDen server writes a session's effective Team to the file named by TEAM_FILE
// (contract: @codeden/contracts TeamFile, { version: 1, projectId, team: [{ role, provider, model, effort }] }).
// Explicit session members override the generated effective mirror role by role.
export const TEAM_FILE_ENV = 'TEAM_FILE';
export const APP_ROLES = [...SIMPLE_ROLES, 'reviewer', 'reviewerFallback'];
// Code Reviewer candidates, in order: the Team's Code Reviewer, then the other Team members (cross-vendor ones are used).
const REVIEW_ORDER = ['reviewer', 'reviewerFallback', 'planReviewer', 'investigator', 'architect', 'writer', 'uiWriter', 'agentsMdWriter', 'browserTester', 'browserOperator'];

// CodeDen writes <home>/.codeden/teams/<sessionId>.json. Legacy <projectId>.json files are also accepted.
// Any other path is refused, so a session cannot point TEAM_FILE at a Team of its own making.
// The Team also governs only code inside the project's own folders (`roots`): a session cannot borrow another
// project's Team for this repository.
export function trustedTeamFile(file, { repo = process.cwd(), home = userInfo().homedir } = {}) {
  let real;
  try { real = realpathSync(file); } catch (e) { throw new Error(`TEAM_FILE_INVALID: ${file}: ${e.message}`); }
  let dir = join(home, '.codeden', 'teams');
  const uid = process.getuid?.();
  const ownerOnlyWrites = st => uid !== undefined && st.uid === uid && (st.mode & 0o022) === 0;
  const untrusted = reason => new Error(`TEAM_FILE_UNTRUSTED: ${file}: ${reason}`);
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || !ownerOnlyWrites(st)) throw new Error(`unsafe teams directory ${dir}`);
    dir = realpathSync(dir);
  } catch (e) { throw untrusted(e.message); }
  const stem = /^([A-Za-z0-9_-]+)\.json$/.exec(real.slice(dir.length + 1))?.[1];
  if (dirname(real) !== dir || !stem) throw untrusted(`not a CodeDen Team file in ${dir}`);

  let fd, text;
  try {
    if (!constants.O_NOFOLLOW) throw new Error('O_NOFOLLOW is unavailable');
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || !ownerOnlyWrites(st)) throw new Error('unsafe Team file');
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    throw untrusted(e.message);
  }
  try { text = readFileSync(fd); }
  catch (e) { throw new Error(`TEAM_FILE_INVALID: ${file}: ${e.message}`); }
  finally { closeSync(fd); }

  const doc = loadAppTeam(real, text);
  const sessionName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(stem);
  if (!(sessionName && doc.sessionId === stem) && doc.projectId !== stem) throw untrusted('filename does not match the Team ID');
  const real2 = p => { try { return realpathSync(p); } catch { return null; } };
  const at = real2(repo);
  const roots = (Array.isArray(doc.roots) ? doc.roots : []).map(real2).filter(Boolean);
  const inside = r => { const rel = relative(r, at); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  if (!at || !roots.some(inside)) throw new Error(`TEAM_FILE_UNTRUSTED: ${repo} is not in project ${doc.projectId}'s folders (${(doc.roots || []).join(', ') || 'none'})`);
  return doc;
}

export function loadAppTeam(file, text) {
  let doc;
  try { text ??= readFileSync(file); doc = JSON.parse(text); } catch (e) { throw new Error(`TEAM_FILE_INVALID: ${file}: ${e.message}`); }
  if (doc?.version !== 1 || !Array.isArray(doc.team)) throw new Error(`TEAM_FILE_INVALID: ${file} is not a version 1 CodeDen Team file`);
  for (const m of doc.team) {
    if (!APP_ROLES.includes(m?.role) || typeof m.provider !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(m.provider)
        || !(m.model == null || (typeof m.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]~-]*$/.test(m.model)))
        || !(m.effort == null || EFFORTS.includes(m.effort)) || (m.role === 'planReviewer' && m.effort === 'minimal')) {
      throw new Error(`TEAM_FILE_INVALID: ${file}: bad Team member`);
    }
  }
  if (new Set(doc.team.map(m => m.role)).size !== doc.team.length) throw new Error(`TEAM_FILE_INVALID: ${file}: duplicate roles`);
  if (doc.escalation !== undefined) {
    const bad = (!doc.escalation || typeof doc.escalation !== 'object' || !['global', 'project', 'session'].includes(doc.escalation.source))
      ? 'escalation.source must be global, project or session' : arbiterSettingsProblem(doc.escalation, 'escalation');
    if (bad) throw new Error(`TEAM_FILE_INVALID: ${file}: ${bad}`);
  }
  doc.team = doc.team.map(m => ({ ...m, model: m.model ?? null, effort: m.effort ?? null }));
  const pins = doc.team.map(({ role, provider, model, effort }) => ({ role, provider, model, effort })).sort((a, b) => a.role.localeCompare(b.role));
  if (doc.escalation) pins.push({ escalation: Object.fromEntries([...arbiterLimitKeys, 'source'].map(key => [key, key === 'dailyBudgetUsd' ? doc.escalation[key] : doc.escalation[key] ?? null])) });
  Object.defineProperty(doc, 'sha256', { value: sha256(JSON.stringify(pins)), enumerable: false });
  Object.defineProperty(doc, 'fileSha256', { value: sha256(text), enumerable: false });
  Object.defineProperty(doc, 'file', { value: file, enumerable: false });
  return doc;
}

// The Team in team.json's shape with every role from the in-app Team. With `writer`, the Code Reviewer primary is the
// first candidate of another vendor than the writer's. The explicit fallback is available only across vendors.
function resolveTeamMembers(base, doc, writer, fromMirror = false) {
  const policy = base.policyBase ?? base;
  const mirror = fromMirror ? doc : base.mirror;
  const team = { ...policy, roles: { ...policy.roles } };
  const vendor = p => vendorOf(team, p);
  const sessionRoles = new Set(doc.team.map(m => m.role));
  const inherited = !doc.hostReview && !fromMirror && mirror?.source === 'settings-effective-team'
    ? mirror.team.filter(m => !sessionRoles.has(m.role)) : [];
  const roleSources = Object.fromEntries(inherited.map(m => [m.role, 'mirror']));
  const members = [...doc.team, ...inherited].map(({ role, provider, model, effort }) =>
    ({ role, provider: teamProvider(team, provider), model: model ?? null, effort: effort ?? null }));
  const modelContext = { ...team, members };
  const byRole = Object.fromEntries(members.map(m => [m.role, m]));
  for (const key of SIMPLE_ROLES) {
    const m = byRole[key];
    team.roles[key] = m ? { ...policy.roles[key], label: roleLabel(key), ...pinFields(m) } : null;
  }
  const limits = { ...arbiterLimits(policy), ...arbiterLimits({ arbiterLimits: doc.escalation }) };
  if (Object.keys(limits).length) team.arbiterLimits = limits;
  const source = fromMirror ? doc.source : 'codeden-team';
  if (byRole.arbiter) team.roles.arbiter.source = roleSources.arbiter ?? source;
  if (doc.escalation) team.arbiterSettingsSource = doc.escalation.source;
  const eligible = (pin, w) => isConfiguredPin(pin) && vendor(pin.provider) && vendor(w) && vendor(pin.provider) !== vendor(w);
  const reviewer = byRole.reviewer;
  const legacyMirror = fromMirror && doc.source === 'settings-default-team';
  const order = legacyMirror ? ['reviewer', 'reviewerFallback'] : REVIEW_ORDER;
  const primaryMember = !doc.hostReview && isConfiguredPin(reviewer) && vendor(reviewer.provider) && writer
    ? order.map(key => byRole[key]).find(pin => eligible(pin, writer)) ?? reviewer
    : reviewer;
  const primary = primaryMember ? pinFields(primaryMember) : null;
  const fallbackMember = byRole.reviewerFallback;
  const fallback = Object.fromEntries(Object.keys(team.vendors).map(w => [w,
    eligible(fallbackMember, w) && !samePin(fallbackMember, primary, modelContext) ? [pinFields(fallbackMember)] : []]));
  team.roles.codeReviewer = { ...policy.roles.codeReviewer, primary, fallback };
  for (const [k, v] of Object.entries({
    sha256: fromMirror ? doc.fileSha256 : doc.sha256, file: doc.file, app: fromMirror ? null : doc,
    mirror, members, memberPins: byRole, roleSources, policyBase: policy, writer, source, primaryRole: primaryMember?.role, planMinEffort: policy.roles.planReviewer?.minEffort,
  })) Object.defineProperty(team, k, { value: v, enumerable: false });
  return team;
}

export function applyAppTeam(base, app, writer = null) {
  return resolveTeamMembers(base, app, writer);
}

// Load + drift check in one call, for scripts at run start. Inside CodeDen (TEAM_FILE set) the in-app Team decides.
export function loadTeamChecked({ real = false, writer = null, env = process.env, repo = process.cwd() } = {}) {
  const team = loadTeam(teamFile({ real }));
  assertTeamInSync({ real });
  if (!env[TEAM_FILE_ENV]) return teamForWriter(team, writer);
  const app = trustedTeamFile(env[TEAM_FILE_ENV], { repo });
  return applyAppTeam(team, app, writer);
}

// team.json for one writer: when its primary is the writer's vendor, the writer's first fallback becomes the primary.
// The primary never reappears as its own fallback.
function jsonTeamForWriter(base, writer) {
  const cr = base.roles.codeReviewer;
  const list = cr.fallback?.[writer];
  if (!cr.primary || !list?.length) return base;
  const primary = base.vendors[cr.primary.provider] === base.vendors[writer] ? list[0] : cr.primary;
  const team = { ...base, roles: { ...base.roles, codeReviewer: { ...cr, primary, fallback: { ...cr.fallback, [writer]: list.filter(p => !samePin(p, primary)) } } } };
  for (const [k, v] of Object.entries({ sha256: base.sha256, file: base.file, jsonBase: base, writer })) Object.defineProperty(team, k, { value: v, enumerable: false });
  return team;
}

// The same Team judged for one writer (a gate check learns the writer only from the recorded rounds).
export function teamForWriter(team, writer) {
  if (!writer || team.writer === writer) return team;
  if (team.app) return applyAppTeam(team, team.app, writer);
  if (team.mirror) return resolveTeamMembers(team, team.mirror, writer, true);
  return jsonTeamForWriter(team.jsonBase || team, writer);
}
