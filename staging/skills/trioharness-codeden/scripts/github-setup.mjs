#!/usr/bin/env node
// TrioHarness Lean — GitHub-side setup of a new private repository, copying what the user's existing repos already have.
// Everything is copied from a REFERENCE repo (extend what exists, never invent a second convention): merge settings,
// the merge-approval ruleset(s), vulnerability alerts. Files that belong IN the repo (CI workflow, PR template,
// AGENTS.md, .trioharness/*) are written by bootstrap and reviewed through a normal pull request, not by this script.
// Uses the `gh` CLI with the user's login. Never deletes anything, never makes a repo public, never touches a repo that
// already exists with different visibility. Anything gh refuses (owner-only, plan limits) is reported, never worked around.
// 2.36: the same baseline for a repository that ALREADY exists (`audit` read-only, `converge` applies only what is
// missing, never creates, never deletes), and the guarded switch from the manual merge-approval ruleset to the
// "Verified merge" ruleset (`verified-merge`): preflight proof first, the new ruleset is added BEFORE the old one is
// disabled (never an unprotected moment), the old one is disabled, not deleted, and the rollback is printed.
// Usage:
//   node github-setup.mjs plan  --repo owner/new-name --reference owner/existing [--source <local dir>] [--description "…"]
//   node github-setup.mjs apply --repo owner/new-name --reference owner/existing [--source <local dir>] [--description "…"] --confirm
//   node github-setup.mjs audit    --repo owner/existing --reference owner/other        read-only: what differs from the baseline
//   node github-setup.mjs converge --repo owner/existing --reference owner/other --confirm   apply the missing baseline to an existing repo
//   node github-setup.mjs verified-merge --repo owner/existing [--confirm | --rollback --restore <ruleset ids>]
// Prints a JSON report: steps done / skipped / failed, and ownerSteps (what only the user can click).
import { appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './is-main.mjs';

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SETTING_KEYS = ['allow_merge_commit', 'allow_squash_merge', 'allow_rebase_merge', 'allow_auto_merge', 'delete_branch_on_merge', 'allow_update_branch', 'merge_commit_title', 'merge_commit_message', 'has_wiki', 'has_projects'];
const RULESET_DROP = ['id', 'node_id', 'source', 'source_type', 'created_at', 'updated_at', '_links', 'current_user_can_bypass'];

const defaultGh = (args, input) => {
  try { return { ok: true, out: execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }) }; }
  catch (e) { return { ok: false, out: '', err: `${String(e.stderr || e.message).split('\n')[0]}`.slice(0, 240) }; }
};
const json = r => { try { return JSON.parse(r.out); } catch { return null; } };

export function cleanRuleset(rs) {
  const out = {};
  for (const [k, v] of Object.entries(rs)) if (!RULESET_DROP.includes(k)) out[k] = v;
  return out;
}

export function setupSteps({ repo, reference, source, description }) {
  return [
    { id: 'create', what: `create ${repo} as a PRIVATE repository${source ? ` from ${source} and push it` : ''}` },
    { id: 'settings', what: `copy merge settings from ${reference} (${SETTING_KEYS.join(', ')})` },
    { id: 'rulesets', what: `copy every active ruleset from ${reference} (the merge-approval rules)` },
    { id: 'alerts', what: 'turn on Dependabot vulnerability alerts and automated security fixes' },
    { id: 'scanning', what: 'turn on secret scanning and push protection where the plan allows it' },
    { id: 'app', what: 'add the repository to the GitHub App installation if the login may' }
  ];
}

export function apply({ repo, reference, source, description = '', confirm = false, plan = false, existing = false }, { gh = defaultGh, log = () => {}, appInstallationId = '175097583' } = {}) {
  if (!SLUG.test(repo || '') || !SLUG.test(reference || '')) throw new Error('USAGE: --repo owner/name --reference owner/name');
  const steps = setupSteps({ repo, reference, source, description });
  if (plan || !confirm) return { plan: true, repo, reference, steps, note: 'nothing was changed; run apply with --confirm' };
  const report = { repo, reference, done: [], skipped: [], failed: [], ownerSteps: [] };
  const done = (id, note) => { report.done.push({ id, note }); log({ id, ok: true, note }); };
  const skip = (id, note) => { report.skipped.push({ id, note }); log({ id, skipped: true, note }); };
  const fail = (id, note) => { report.failed.push({ id, note }); log({ id, ok: false, note }); };

  // 1. the repository, always private
  const view = gh(['api', `repos/${repo}`]);
  let info = view.ok ? json(view) : null;
  if (info) {
    if (!info.private) { fail('create', `${repo} already exists and is PUBLIC; nothing was changed. Make it private yourself or pick another name.`); return report; }
    skip('create', 'already exists and is private');
  } else if (existing) {
    fail('create', `${repo} does not exist or is not readable with this login; converge never creates a repository`); return report;
  } else {
    const args = ['repo', 'create', repo, '--private', ...(description ? ['--description', description.slice(0, 300)] : []), ...(source ? ['--source', resolve(source), '--remote', 'origin', '--push'] : [])];
    const c = gh(args);
    if (!c.ok) { fail('create', c.err); return report; }
    info = json(gh(['api', `repos/${repo}`]));
    if (!info || info.private !== true) { fail('create', 'the new repository did not come back as private; stopped'); return report; }
    done('create', `created private ${repo}`);
  }
  // 2. merge settings from the reference
  const refInfo = json(gh(['api', `repos/${reference}`]));
  if (!refInfo) fail('settings', `could not read ${reference}`);
  else {
    const body = {}; for (const k of SETTING_KEYS) if (k in refInfo) body[k] = refInfo[k];
    const r = gh(['api', '-X', 'PATCH', `repos/${repo}`, '--input', '-'], JSON.stringify(body));
    r.ok ? done('settings', Object.entries(body).map(([k, v]) => `${k}=${v}`).join(', ')) : fail('settings', r.err);
  }
  // 3. rulesets from the reference
  const list = json(gh(['api', `repos/${reference}/rulesets`]));
  if (!Array.isArray(list)) fail('rulesets', `could not list rulesets of ${reference}`);
  else if (!list.length) skip('rulesets', `${reference} has no rulesets`);
  else {
    const existing = new Set((json(gh(['api', `repos/${repo}/rulesets`])) || []).map(r => r.name));
    for (const rs of list) {
      if (existing.has(rs.name)) { skip('rulesets', `${rs.name} already exists`); continue; }
      const detail = json(gh(['api', `repos/${reference}/rulesets/${rs.id}`]));
      if (!detail) { fail('rulesets', `could not read ruleset ${rs.name}`); continue; }
      const r = gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], JSON.stringify(cleanRuleset(detail)));
      r.ok ? done('rulesets', `copied "${rs.name}" (${detail.enforcement})`) : fail('rulesets', `${rs.name}: ${r.err}`);
    }
  }
  // 4. alerts
  let r = gh(['api', '-X', 'PUT', `repos/${repo}/vulnerability-alerts`]);
  r.ok ? done('alerts', 'vulnerability alerts on') : fail('alerts', r.err);
  r = gh(['api', '-X', 'PUT', `repos/${repo}/automated-security-fixes`]);
  r.ok ? done('alerts', 'automated security fixes on') : skip('alerts', `automated security fixes: ${r.err}`);
  // 5. secret scanning (private repos need the plan feature)
  r = gh(['api', '-X', 'PATCH', `repos/${repo}`, '--input', '-'], JSON.stringify({ security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } }));
  r.ok ? done('scanning', 'secret scanning and push protection on') : skip('scanning', `not available on this plan or not allowed: ${r.err}`);
  // 6. the GitHub App installation (best effort)
  r = gh(['api', '-X', 'PUT', `user/installations/${appInstallationId}/repositories/${info.id}`]);
  r.ok ? done('app', `added to installation ${appInstallationId}`) : skip('app', r.err);
  if (!r.ok) report.ownerSteps.push(`Add ${repo} to the "Cumulus Agents" GitHub App installation (GitHub → Settings → Applications → Cumulus Agents → Configure → Repository access).`);
  // 7. what only the owner can do
  report.ownerSteps.push(`Add ${repo} to the approver token's repository list (GitHub → Settings → Developer settings → Fine-grained tokens → CumulusService → Repository access); a fine-grained token cannot be edited through the API.`);
  report.ownerSteps.push('Confirm the ruleset(s) are active on the new repo (Settings → Rules) and that a pull request cannot be merged without the approval.');
  return report;
}

// ---------- existing repositories ----------
const rawFile = (gh, repo, path, ref) => { const r = gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`]); return r.ok ? r.out : null; };
const MV_RULESET = 'Verified merge';

export function audit({ repo, reference }, { gh = defaultGh } = {}) {
  if (!SLUG.test(repo || '') || !SLUG.test(reference || '')) throw new Error('USAGE: --repo owner/name --reference owner/name');
  const gaps = []; const ok = []; const gap = (id, what, fix) => gaps.push({ id, what, fix });
  const info = json(gh(['api', `repos/${repo}`]));
  if (!info) return { repo, reference, error: `cannot read ${repo} with this login`, gaps: [], ok: [] };
  const ref = json(gh(['api', `repos/${reference}`]));
  const def = info.default_branch;
  info.private ? ok.push('private') : gap('visibility', 'the repository is public', 'make it private yourself (this script never changes visibility)');
  if (ref) {
    const diff = SETTING_KEYS.filter(k => k in ref && ref[k] !== info[k]).map(k => `${k}: ${info[k]} (baseline ${ref[k]})`);
    diff.length ? gap('settings', diff.join('; '), 'converge') : ok.push('merge settings match the baseline');
  }
  const va = gh(['api', `repos/${repo}/vulnerability-alerts`]);
  va.ok ? ok.push('vulnerability alerts on') : gap('alerts', 'vulnerability alerts are off', 'converge');
  const sa = info.security_and_analysis || {};
  (sa.secret_scanning?.status === 'enabled' && sa.secret_scanning_push_protection?.status === 'enabled') ? ok.push('secret scanning and push protection on') : gap('scanning', 'secret scanning or push protection is not enabled', 'converge (where the plan allows it)');
  const rulesets = json(gh(['api', `repos/${repo}/rulesets`])) || [];
  const refRulesets = ref ? (json(gh(['api', `repos/${reference}/rulesets`])) || []) : [];
  const have = new Set(rulesets.map(r => r.name));
  const missing = refRulesets.filter(r => !have.has(r.name) && r.name !== MV_RULESET).map(r => r.name);
  missing.length ? gap('rulesets', `missing from the baseline: ${missing.join(', ')}`, 'converge') : ok.push('baseline rulesets present');
  const active = rulesets.filter(r => r.enforcement === 'active');
  active.length ? ok.push(`active ruleset(s): ${active.map(r => r.name).join(', ')}`) : gap('default-branch', 'no active ruleset protects the default branch', 'converge, or the owner adds one');
  const files = { 'AGENTS.md': 'AGENTS.md', 'a CI workflow': '.github/workflows/ci.yml', 'the PR template': '.github/pull_request_template.md', 'the merge policy': '.trioharness/merge-policy.json', 'the merge-verify workflow': '.github/workflows/merge-verify.yml' };
  for (const [what, path] of Object.entries(files)) {
    if (rawFile(gh, repo, path, def) !== null) ok.push(`${what} on ${def}`);
    else gap(`file:${path}`, `${what} (${path}) is not on ${def}`, path.includes('merge-') ? 'merge-verify.mjs install, in a reviewed PR' : 'the bootstrap pull request');
  }
  const mv = rulesets.find(r => r.name === MV_RULESET);
  mv ? ok.push(`"${MV_RULESET}" ruleset present (${mv.enforcement})`) : gap('verified-merge', `no "${MV_RULESET}" ruleset: merges still need the manual approval`, 'github-setup.mjs verified-merge, after merge-verify is merged and proven');
  return { repo, reference, defaultBranch: def, ok, gaps };
}

const pullRule = rs => (rs.rules || []).find(x => x.type === 'pull_request');
export function verifiedMerge({ repo, confirm = false, rollback = false, restore = [] }, { gh = defaultGh, log = () => {}, ruleset } = {}) {
  if (!SLUG.test(repo || '')) throw new Error('USAGE: --repo owner/name');
  const report = { repo, steps: [], blocked: [], done: [], rollback: null };
  const info = json(gh(['api', `repos/${repo}`]));
  if (!info) { report.blocked.push({ id: 'repo', note: `cannot read ${repo} with this login` }); return report; }
  const def = info.default_branch;
  const list = json(gh(['api', `repos/${repo}/rulesets`])) || [];
  const mv = list.find(r => r.name === MV_RULESET);
  // a ruleset is updated with PUT (GitHub answers PATCH with 404); PUT takes a partial body such as { enforcement }
  if (rollback) {
    for (const id of restore) { const r = gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${id}`, '--input', '-'], JSON.stringify({ enforcement: 'active' })); r.ok ? report.done.push({ id: 'restore', note: `ruleset ${id} active again` }) : report.blocked.push({ id: 'restore', note: `${id}: ${r.err}` }); }
    if (mv) { const r = gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${mv.id}`, '--input', '-'], JSON.stringify({ enforcement: 'disabled' })); r.ok ? report.done.push({ id: 'disable-verified', note: `"${MV_RULESET}" disabled` }) : report.blocked.push({ id: 'disable-verified', note: r.err }); }
    return report;
  }
  // preflight: the check must exist on the default branch AND have been seen passing on a real pull request
  const policy = rawFile(gh, repo, '.trioharness/merge-policy.json', def); let pol = null; try { pol = JSON.parse(policy); } catch { /* handled below */ }
  if (!pol || pol.enabled !== true) report.blocked.push({ id: 'policy', note: `.trioharness/merge-policy.json on ${def} is missing or not enabled:true` });
  for (const f of ['.github/workflows/merge-verify.yml', '.github/merge-verify/merge-verify.mjs']) if (rawFile(gh, repo, f, def) === null) report.blocked.push({ id: 'files', note: `${f} is not on ${def}` });
  const prs = json(gh(['api', `repos/${repo}/pulls?state=all&per_page=15`])) || [];
  let proven = false;
  for (const p of prs) {
    const runs = json(gh(['api', `repos/${repo}/commits/${p.head.sha}/check-runs?per_page=100`]));
    if ((runs?.check_runs || []).some(c => c.name === 'merge-verify' && c.conclusion === 'success')) { proven = true; report.steps.push(`proof: merge-verify passed on PR #${p.number}`); break; }
  }
  if (!proven) report.blocked.push({ id: 'proof', note: 'no recent pull request shows a passing "merge-verify" check; open a small docs-only PR first and let the check run' });
  if (mv && mv.enforcement === 'active') { report.done.push({ id: 'already', note: `"${MV_RULESET}" is already active` }); }
  if (report.blocked.length) return report;
  // the rulesets to replace: active, on the default branch, requiring approving reviews
  const details = list.filter(r => r.enforcement === 'active' && r.name !== MV_RULESET).map(r => json(gh(['api', `repos/${repo}/rulesets/${r.id}`]))).filter(Boolean);
  const old = details.filter(d => (pullRule(d)?.parameters?.required_approving_review_count || 0) >= 1);
  const bypass = []; for (const d of old) for (const b of d.bypass_actors || []) if (!bypass.some(x => x.actor_id === b.actor_id && x.actor_type === b.actor_type)) bypass.push(b);
  const next = { ...(ruleset || {}), bypass_actors: bypass };
  report.steps.push(`add the "${MV_RULESET}" ruleset (required status check merge-verify, no approving review, no force push, no deletion; bypass copied from the old one: ${bypass.length} actor(s))`);
  for (const d of old) report.steps.push(`then DISABLE (not delete) "${d.name}" (#${d.id})`);
  if (!confirm) return { ...report, plan: true, note: 'nothing was changed; run again with --confirm' };
  if (!mv) {
    const r = gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], JSON.stringify(next));
    if (!r.ok) { report.blocked.push({ id: 'add', note: r.err }); return report; }
    report.done.push({ id: 'add', note: `"${MV_RULESET}" added (both rulesets are active now: nothing was loosened yet)` }); log({ id: 'verified-merge-add' });
  }
  if (mv && mv.enforcement !== 'active') { // an existing but switched-off Verified merge must be ON before anything is loosened
    const r = gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${mv.id}`, '--input', '-'], JSON.stringify({ enforcement: 'active' }));
    if (!r.ok) { report.blocked.push({ id: 'activate', note: `"${MV_RULESET}" could not be switched on: ${r.err}; nothing was loosened` }); return report; }
    report.done.push({ id: 'activate', note: `"${MV_RULESET}" switched on` });
  }
  const disabled = [];
  for (const d of old) {
    const r = gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${d.id}`, '--input', '-'], JSON.stringify({ enforcement: 'disabled' }));
    if (r.ok) { disabled.push(d.id); report.done.push({ id: 'disable', note: `"${d.name}" #${d.id} disabled (kept, not deleted)` }); log({ id: 'verified-merge-disable', ruleset: d.id }); }
    else report.blocked.push({ id: 'disable', note: `"${d.name}": ${r.err} (still active: stricter, nothing is unprotected)` });
  }
  report.rollback = disabled.length ? `node github-setup.mjs verified-merge --repo ${repo} --rollback --restore ${disabled.join(',')}` : null;
  return report;
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    if (cmd === 'audit') { process.stdout.write(`${JSON.stringify(audit({ repo: opt('repo'), reference: opt('reference') }), null, 2)}\n`); process.exit(0); }
    if (cmd === 'verified-merge') {
      const { rulesetJson } = await import('./merge-verify.mjs');
      const r = verifiedMerge({ repo: opt('repo'), confirm: argv.includes('--confirm'), rollback: argv.includes('--rollback'), restore: (opt('restore') || '').split(',').filter(Boolean) }, { ruleset: rulesetJson() });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exitCode = r.blocked?.length ? 2 : 0; process.exit(process.exitCode);
    }
    if (!['plan', 'apply', 'converge'].includes(cmd)) throw new Error('USAGE: plan|apply|converge|audit|verified-merge --repo owner/name [--reference owner/existing] [--source dir] [--description "…"] [--confirm]');
    const logDir = join(resolve(opt('source') || '.'), '.trioharness-direct');
    const log = rec => { try { mkdirSync(logDir, { recursive: true }); appendFileSync(join(logDir, 'github-setup.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), repo: opt('repo'), ...rec })}\n`); } catch { /* best effort */ } };
    const r = apply({ repo: opt('repo'), reference: opt('reference'), source: opt('source'), description: opt('description') || '', confirm: argv.includes('--confirm'), plan: cmd === 'plan', existing: cmd === 'converge' }, { log });
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exitCode = r.failed?.length ? 1 : 0;
  } catch (e) { process.stderr.write(`GITHUB_SETUP: ${e.message}\n`); process.exitCode = 3; }
}
