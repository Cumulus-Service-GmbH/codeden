#!/usr/bin/env node
// TrioHarness Lean — verified merge. The Architect (never a worker) merges its own pull request, but only when every
// mechanical check below proves the merge cannot change anything live. Anything else stays an approval card.
//
// Deny by default:
//   * the repository must opt in with .trioharness/merge-policy.json ON THE DEFAULT BRANCH (never read from the PR),
//   * the PR must be an agent task branch (bambooed/*, trio/* or codeden/*) in the same repository, not a draft, against the
//     default branch, with the head SHA the caller expects,
//   * it must touch NO workflow, CI/deploy/infra/environment file, hook, guard or allowlist file, dependency or lock
//     file, migration or schema, auth or secret path, nor any path the repo lists as high-risk in AGENTS.md,
//   * no secret-shaped added line (files, patches, commit messages), no deleted/skipped/weakened tests, a bounded size,
//   * every non-advisory check on the head is green (a failure counts only if the same check also fails on the default
//     branch head and the policy allows baseline failures), nothing pending, at least one real check,
//   * merging must trigger nothing live: a workflow that can run on a push to the default branch (or on a merged PR)
//     and looks like a deploy, release, publish or upload makes the verdict DEPLOY_ON_MERGE. That is a deploy: ask.
// The same script runs as a required GitHub status check (`ci`, from the default branch, through pull_request_target,
// never checking out the PR), so `gh pr merge`, `gh api` and a fresh clone cannot skip it: the ruleset requires the
// check, and a PR that edits this script, the workflow or the policy fails it (those paths are sensitive), unless the
// policy sets sensitivePaths "review": then sensitive paths are notes and merge on review plus green checks; secret
// material still fails.
// Owner approval (ci mode only, never for the Architect's own check/merge): when every remaining reason is a person's
// call (APPROVABLE: sensitive path, size, branch name, missing PR section) and an OWNER/MEMBER/COLLABORATOR who is not a
// bot and not the PR author approved THIS head (and has not since requested changes), the check passes with a note. A
// review does not re-run the check: after approving, run `recheck` (or press Re-run on the check in GitHub).
// Honest limits: it proves the PR is boring, not that it is correct (tests, review and the Jev gates do that); a
// dependency, migration, workflow or config change is never auto-merged unless the policy sets sensitivePaths "review"
// (then the independent review is the gate for those paths); a repo whose default branch deploys on push is
// never auto-merged; baseline-failure tolerance is a heuristic by check name; GitHub limits a PR diff to 3000 files.
// Usage:
//   node merge-verify.mjs check  --repo <owner/name|path> --pr N [--expect-sha S] [--checkout <path> --run <id>] [--wait-checks-sec N]
//   node merge-verify.mjs merge  --repo <owner/name|path> --pr N --expect-sha S [--checkout <path> --run <id>] [--wait-checks-sec N]
//   node merge-verify.mjs post   --repo <owner/name|path> --pr N [--wait-sec 120]        after a merge: on the default branch? deploy started? checks red?
//   node merge-verify.mjs ci     --repo <owner/name> --pr N --expect-sha S               the required status check (exit 0 = PASS)
//   node merge-verify.mjs recheck --repo <owner/name> --pr N                             re-run the latest merge-verify run for the PR head (after the owner approved; needs "Actions: Read and write")
//   node merge-verify.mjs install --repo <checkout> [--skill <skill dir>]                writes the CI check, the policy (enabled:false) into the working tree for a reviewed PR
//   node merge-verify.mjs ruleset [--check merge-verify]                                 prints the ruleset JSON the owner approves once per repo
// Exit 0: PASS / MERGED / POST_OK / RERUN_REQUESTED. Exit 2: anything else (the reasons are printed as JSON; never worked around).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { findSecrets, isSecretFile } from './secret-patterns.mjs';
import { isMain } from './is-main.mjs';
import { appendFailure } from './issues-failure-log.mjs';

export const CHECK_NAME = 'merge-verify';
const COPILOT_REVIEW_CHECK = 'copilot-pull-request-reviewer';
export const POLICY_PATH = '.trioharness/merge-policy.json';
export const AGENT_BRANCH = /^(bambooed|trio|codeden)\/[A-Za-z0-9._\/-]+$/;
export const DEFAULT_POLICY = Object.freeze({
  version: 1, enabled: false, mergeMethod: 'merge', maxFiles: 40, maxChangedLines: 1500,
  extraSensitive: [], allowBaselineFailures: false, requiredChecks: [], requireBodySection: true, minChecks: 1
});

// ---------- policy ----------
export function validatePolicy(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['policy must be a JSON object'], policy: null };
  const p = { ...DEFAULT_POLICY, ...raw };
  if (p.version !== 1) errors.push('version must be 1');
  if (typeof p.enabled !== 'boolean') errors.push('enabled must be true or false');
  if (!['merge', 'squash', 'rebase'].includes(p.mergeMethod)) errors.push('mergeMethod must be merge, squash or rebase');
  if (!Number.isInteger(p.maxFiles) || p.maxFiles < 1 || p.maxFiles > 200) errors.push('maxFiles must be an integer 1-200');
  if (!Number.isInteger(p.maxChangedLines) || p.maxChangedLines < 1 || p.maxChangedLines > 5000) errors.push('maxChangedLines must be an integer 1-5000');
  if (!Array.isArray(p.extraSensitive) || p.extraSensitive.some(x => typeof x !== 'string' || !x || x.length > 200)) errors.push('extraSensitive must be a list of path strings');
  if (typeof p.allowBaselineFailures !== 'boolean') errors.push('allowBaselineFailures must be true or false');
  if (!Array.isArray(p.requiredChecks) || p.requiredChecks.some(x => typeof x !== 'string' || !x)) errors.push('requiredChecks must be a list of check names');
  if (p.advisoryChecks !== undefined) {
    // Only GitHub's named Copilot review job is eligible. CI checks and future names are never inferred.
    if (!Array.isArray(p.advisoryChecks) || p.advisoryChecks.some(name => name !== COPILOT_REVIEW_CHECK)) {
      errors.push(`advisoryChecks must be a list containing only ${COPILOT_REVIEW_CHECK}`);
    } else if (p.advisoryChecks.includes(COPILOT_REVIEW_CHECK) && Array.isArray(p.requiredChecks) && p.requiredChecks.includes(COPILOT_REVIEW_CHECK)) {
      errors.push(`advisoryChecks cannot include ${COPILOT_REVIEW_CHECK} when it is listed in requiredChecks`);
    }
  }
  if (typeof p.requireBodySection !== 'boolean') errors.push('requireBodySection must be true or false');
  if (!Number.isInteger(p.minChecks) || p.minChecks < 1 || p.minChecks > 20) errors.push('minChecks must be an integer 1-20');
  // ciWorkflows: named validation-only workflows whose bare words deploy/publish are not a deploy on merge (a deploy tool
  // in them still is; see DEPLOY_TOOLS). A name that itself
  // reads like a deploy (deploy-*.yml, release, publish, ...) can never be listed. Optional; absent means none.
  // sensitivePaths: "refuse" (default) stops a PR on any sensitive or AGENTS.md high-risk path; "review" lists those
  // paths as notes instead, so they merge on review plus green checks. Secret material (secret files, keys and
  // certificates, local.settings.json) always refuses. Optional; absent means "refuse".
  if (p.sensitivePaths !== undefined && !['refuse', 'review'].includes(p.sensitivePaths)) errors.push('sensitivePaths must be "refuse" or "review"');
  if (p.ciWorkflows !== undefined && (!Array.isArray(p.ciWorkflows) || p.ciWorkflows.some(x => typeof x !== 'string' || !/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(x) || DEPLOY_NAME.test(x.slice('.github/workflows/'.length))))) errors.push('ciWorkflows must be a list of .github/workflows/<name>.yml paths whose names do not read like a deploy');
  return { errors, policy: errors.length ? null : p };
}

// ---------- paths that can never be auto-merged ----------
const R = (id, re) => [id, new RegExp(re, 'i')];
export const SENSITIVE = [
  R('github-config', '^\\.github/'), R('harness', '^\\.trioharness(-direct)?/'), R('agent-rules', '(^|/)(AGENTS|CLAUDE)\\.md$'),
  R('hooks', '(^|/)(\\.husky|\\.githooks)/|(^|/)\\.git(attributes|modules)$|(^|/)CODEOWNERS$'),
  R('deploy-config', '(^|/)(deploy(ment)?\\.(json|ya?ml)|environments\\.json|Dockerfile[^/]*|docker-compose[^/]*\\.ya?ml|Procfile|azure-pipelines[^/]*\\.ya?ml|staticwebapp\\.config\\.json|web\\.config)$|(^|/)(\\.azure|infra|infrastructure|terraform|bicep|helm|charts|k8s|kubernetes|fastlane)/|\\.(bicep|tf|tfvars)$'),
  R('mobile-signing', '\\.(entitlements|mobileprovision|keystore|jks)$|(^|/)(AndroidManifest\\.xml|Info\\.plist)$'),
  R('dependencies', '(^|/)(package\\.json|package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|pnpm-workspace\\.yaml|bun\\.lockb?|\\.npmrc|\\.nvmrc|\\.yarnrc(\\.yml)?|global\\.json|nuget\\.config|packages\\.config|packages\\.lock\\.json|requirements[^/]*\\.txt|pyproject\\.toml|poetry\\.lock|Pipfile(\\.lock)?|setup\\.(py|cfg)|go\\.(mod|sum)|Gemfile(\\.lock)?|Cargo\\.(toml|lock)|pubspec\\.(yaml|lock)|build\\.gradle(\\.kts)?|settings\\.gradle(\\.kts)?|gradle\\.properties|Podfile(\\.lock)?|Package\\.(resolved|swift)|composer\\.(json|lock)|pom\\.xml|\\.tool-versions|Directory\\.(Packages|Build)\\.(props|targets))$|\\.(csproj|vbproj|fsproj|sqlproj)$|(^|/)gradle/wrapper/'),
  R('schema-data', '(^|/)migrations?/|\\.sql$|\\.dacpac$|\\.prisma$|ModelSnapshot\\.cs$|(^|/)schema\\.graphql$'),
  R('auth-secrets', '(^|/)(auth|authentication|authorization|identity|security|secrets?|keyvault|key-vault)/|(^|/)appsettings[^/]*\\.json$|(^|/)local\\.settings\\.json$|\\.(pfx|p12|pem|key|ppk|gpg|asc)$')
];
const globToRe = g => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]')}$`);

export function parseHighRisk(agentsMd) {
  const out = [];
  const m = /^##\s+High-risk paths\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(String(agentsMd || ''));
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const b = /^\s*[-*]\s+`([^`]+)`/.exec(line);
    if (!b) continue;
    const p = b[1].trim();
    if (!p || /[<>]/.test(p) || /^e\.g\./i.test(p)) continue; // template placeholders
    out.push(p);
  }
  return out;
}

// Fail-closed allowlist for a workflow a PR changes under sensitivePaths "review". It is not a YAML parser; it relies on
// one property: a key that decodes to `uses` comes from a line that literally holds the word, unless YAML escapes
// (\x \u \U) or an escaped line break (backslash at the end of a double-quoted line) build it. So escapes refuse,
// escaped line breaks are also checked joined, and every line holding the word must be one of two shapes:
//   * the plain marketplace form `[- ]uses: owner/repo[/path]@ref`, optionally followed by a space and a comment with no
//     quote or backslash (a line without quotes cannot close a multi-line string, so it hides no key), and not a
//     reusable workflow (.github/workflows/), a local ./action, docker:// or a path with `..`;
//   * a full-line comment with no quote character (inside a multi-line string such a line stays content).
// Anything else (quoted, spaced or flow-style keys, aliases, block scalars, ...) is refused rather than parsed. YAML
// separation is ASCII space or tab only, so the patterns never use \s.
const PLAIN_USES = /^[ \t]*(-[ \t]+)?uses:[ \t]+[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.\/-]+@[A-Za-z0-9_.\/-]+[ \t]*([ \t]#[^'"\\]*)?$/;
const SAFE_COMMENT = /^[ \t]*#[^'"]*$/;
export function unfollowableUses(text) {
  const crlf = String(text || '');
  if (/\r(?!\n)|[\u0085\u2028\u2029]/.test(crlf)) return true; // line breaks other than LF and CRLF
  const raw = crlf.replace(/\r\n/g, '\n'); // one line break form, so an escaped CRLF is joined like an escaped LF
  if (/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/.test(raw)) return true; // non-ASCII spaces and BOM
  if (/\\[xuU]/.test(raw)) return true; // YAML escapes that can spell any character
  const plainOk = l => PLAIN_USES.test(l) && !/\.github\/workflows\/|\.\./i.test(l.split(/[ \t]#/)[0]);
  const lines = raw.split('\n');
  if (lines.some(l => /\buses\b/i.test(l) && !SAFE_COMMENT.test(l) && !plainOk(l))) return true;
  // lines joined by escaped line breaks (YAML drops the break and the next line's leading spaces): no exemptions
  const joined = raw.split(/(?<!\\)\n/).filter(l => l.includes('\\\n')).map(l => l.replace(/\\\n[ \t]*/g, ''));
  return joined.some(l => /\buses\b/i.test(l) && !plainOk(l));
}

// Secret material refuses even under sensitivePaths "review" (and so do local actions under .github/actions/, which a
// workflow can run without its own text showing a deploy).
export function isSecretMaterial(path) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  return Boolean(isSecretFile(p)) || /\.(pfx|p12|pem|key|ppk|gpg|asc)$|(^|\/)local\.settings\.json$/i.test(p);
}

export function classifyPath(path, extra = []) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  for (const [id, re] of SENSITIVE) if (re.test(p)) return id;
  if (isSecretFile(p)) return 'secret-file';
  for (const e of extra) {
    const x = String(e).replace(/\\/g, '/').replace(/^\.\//, '');
    if (x.endsWith('/') ? p.startsWith(x) : (x.includes('*') || x.includes('?') ? globToRe(x).test(p) : p === x || p.startsWith(`${x}/`))) return 'repo-high-risk';
  }
  return null;
}

// ---------- tests must not shrink ----------
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress|playwright)\/|\.(test|spec)\.[a-z]+$|Tests?\.cs$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|\.Tests?\//i;
const TEST_DECL = /\b(it|test|describe|specify)(\.each)?\s*\(|\[(Fact|Theory|Test|TestMethod|TestCase|DataTestMethod)\b|\bdef test_|\bfunc Test[A-Z_]|@Test\b|\btest\(/;
const SKIP_MARK = /\.skip\b|\bx(it|describe|test)\s*\(|\[(Fact|Theory)\(Skip|\[Ignore\b|@Disabled\b|@Ignore\b|pytest\.mark\.skip|\bt\.Skip\(|\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/;
export function testReduction(files) {
  const problems = []; let removedDecl = 0; let addedDecl = 0;
  for (const f of files) {
    if (!TEST_PATH.test(f.filename)) continue;
    if (f.status === 'removed') { problems.push({ code: 'TEST_FILE_REMOVED', detail: f.filename }); continue; }
    for (const line of String(f.patch || '').split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line[0] === '-' && TEST_DECL.test(line)) removedDecl++;
      if (line[0] === '+' && TEST_DECL.test(line)) addedDecl++;
      if (line[0] === '+' && SKIP_MARK.test(line)) problems.push({ code: 'TEST_SKIP_OR_ONLY_ADDED', detail: f.filename });
    }
  }
  if (removedDecl > addedDecl) problems.push({ code: 'TESTS_REDUCED', detail: `${removedDecl} test declarations removed, ${addedDecl} added` });
  return problems;
}

// ---------- does a merge trigger something live? ----------
const DEPLOYISH = /\b(az|azd)\s+(webapp|containerapp|functionapp|acr|deployment|group|staticwebapp|appservice)\b|azure\/(webapps-deploy|container-apps-deploy|functions-action|static-web-apps-deploy|cli)|docker\/build-push-action|docker\s+push|kubectl|helm\s+(upgrade|install)|terraform\s+apply|\baws\s+(s3|ecs|lambda|cloudformation)|gcloud\s|firebase\s+deploy|fastlane|testflight|upload-google-play|google-play|app-store-connect|gh\s+release|action-gh-release|create-release|release-please|semantic-release|changesets\/action|npm\s+publish|nuget\s+push|twine\s+upload|vercel|netlify|wrangler|\bdeploy(ment|ing|s)?\b|(?<!dotnet\s)\bpublish\b|^\s*environment\s*:/im;
// ("Release" as a build configuration and "dotnet publish" are ordinary build steps, not deploys.)
// A workflow named in the policy's ciWorkflows ignores only the bare words "deploy" and "publish"; every concrete deploy,
// release, publish or upload tool (az, docker push, npm publish, environment:, ...) above still flags it.
const DEPLOY_WORDS = '|\\bdeploy(ment|ing|s)?\\b|(?<!dotnet\\s)\\bpublish\\b';
if (!DEPLOYISH.source.includes(DEPLOY_WORDS)) throw new Error('merge-verify: DEPLOYISH changed; update DEPLOY_WORDS');
const DEPLOY_TOOLS = new RegExp(DEPLOYISH.source.replace(DEPLOY_WORDS, ''), DEPLOYISH.flags);
export const deployToolsIn = text => DEPLOY_TOOLS.test(String(text || '').split('\n').filter(l => !/^\s*#/.test(l)).join('\n'));
const branchMatches = (pats, branch) => pats.some(p => globToRe(p).test(branch));
const listFrom = text => { const t = String(text).trim(); if (t.startsWith('[')) return t.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean); return [t.replace(/^['"]|['"]$/g, '')].filter(Boolean); };

export function analyzeWorkflow(text, defaultBranch) {
  const lines = String(text || '').split('\n').filter(l => !/^\s*#/.test(l));
  const indentOf = l => l.length - l.trimStart().length;
  const onIdx = lines.findIndex(l => /^["']?(on|true)["']?\s*:/.test(l));
  const deployish = DEPLOYISH.test(lines.join('\n'));
  if (onIdx < 0) return { triggers: true, why: 'no readable on: block (assumed to run on a push)', deployish };
  const head = lines[onIdx].replace(/^["']?(on|true)["']?\s*:/, '').trim();
  const events = {}; // name -> sub-lines
  if (head) { for (const e of listFrom(head)) events[e] = []; }
  else {
    let base = -1; let cur = null;
    for (let i = onIdx + 1; i < lines.length; i++) {
      const l = lines[i]; if (!l.trim()) continue;
      const ind = indentOf(l); if (ind === 0) break;
      if (base < 0) base = ind;
      if (ind === base) {
        const m = /^\s*-?\s*["']?([A-Za-z_]+)["']?\s*:?\s*(.*)$/.exec(l);
        if (m) { cur = m[1]; events[cur] = m[2] ? [m[2]] : []; }
      } else if (cur) events[cur].push(l);
    }
  }
  const reasons = [];
  if ('push' in events) {
    const sub = events.push; const joined = sub.join('\n');
    const get = key => {
      const i = sub.findIndex(l => new RegExp(`^\\s*${key}\\s*:`).test(l));
      if (i < 0) return null;
      const inline = sub[i].replace(new RegExp(`^\\s*${key}\\s*:`), '').trim();
      if (inline) return listFrom(inline);
      const out = []; const bi = indentOf(sub[i]);
      for (let j = i + 1; j < sub.length; j++) { if (indentOf(sub[j]) <= bi) break; const m = /^\s*-\s*(.+)$/.exec(sub[j]); if (m) out.push(m[1].trim().replace(/^['"]|['"]$/g, '')); }
      return out;
    };
    const br = get('branches'); const bi = get('branches-ignore'); const tg = get('tags');
    if (br) { if (branchMatches(br, defaultBranch)) reasons.push('push to the default branch'); }
    else if (bi) { if (!branchMatches(bi, defaultBranch)) reasons.push('push to the default branch'); }
    else if (tg && !/branches/.test(joined)) { /* tags only: a branch push does not run it */ }
    else reasons.push('push to any branch');
  }
  if ('pull_request' in events || 'pull_request_target' in events) {
    const sub = (events.pull_request || events.pull_request_target || []).join('\n');
    if (/closed/.test(sub)) reasons.push('pull request closed (runs on merge)');
  }
  if ('workflow_run' in events) reasons.push('chained from another workflow (workflow_run)');
  return { triggers: reasons.length > 0, why: reasons.join('; '), deployish };
}

// ---------- GitHub access (injectable for tests) ----------
export function ghCli(args, input, { env } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 90000, input, maxBuffer: 64 * 1024 * 1024, ...(env === undefined ? {} : { env }) });
  if (r.error) return { ok: false, out: '', err: String(r.error.message || r.error) };
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim() };
}
const api = (gh, path) => { const r = gh(['api', path]); if (!r.ok) return { ok: false, err: r.err || r.out }; try { return { ok: true, json: JSON.parse(r.out) }; } catch { return { ok: false, err: 'unreadable JSON from GitHub' }; } };
const raw = (gh, path) => { const r = gh(['api', '-H', 'Accept: application/vnd.github.raw', path]); return r.ok ? { ok: true, text: r.out } : { ok: false, err: r.err || r.out }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function slugOf(repo) {
  if (/^[\w.-]+\/[\w.-]+$/.test(repo) && !existsSync(repo)) return repo;
  const r = spawnSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(r.stdout || '');
  if (!m) throw new Error(`REPO_UNKNOWN: ${repo} is neither owner/name nor a checkout with a github.com origin`);
  return m[1];
}

const allPages = (gh, path, key, cap) => {
  const out = [];
  for (let page = 1; page <= cap; page++) {
    const r = api(gh, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!r.ok) return { ok: false, err: r.err };
    const arr = key ? r.json[key] : r.json;
    if (!Array.isArray(arr)) return { ok: false, err: 'unexpected GitHub answer' };
    out.push(...arr);
    if (arr.length < 100) return { ok: true, items: out, complete: true };
  }
  return { ok: true, items: out, complete: false };
};

const FAIL_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']);
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const IMAGE = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?)$/i;

function readChecks(gh, repo, sha) {
  const runs = allPages(gh, `repos/${repo}/commits/${sha}/check-runs`, 'check_runs', 6);
  if (!runs.ok) return { ok: false, err: runs.err };
  const st = api(gh, `repos/${repo}/commits/${sha}/status`);
  if (!st.ok) return { ok: false, err: st.err };
  return { ok: true, runs: runs.items, complete: runs.complete, statuses: st.json.statuses || [] };
}
function judgeChecks(c, policy, baselineFailing) {
  const reasons = []; const notes = [];
  const advisory = new Set(policy.advisoryChecks);
  const runs = c.runs.filter(r => r.name !== CHECK_NAME && !advisory.has(r.name));
  for (const name of advisory) {
    if (c.runs.some(r => r.name === name)) notes.push(`advisory check run ignored for merge verification: ${name}`);
  }
  const pending = runs.filter(r => r.status !== 'completed').map(r => r.name);
  const pendingStatus = c.statuses.filter(s => s.state === 'pending').map(s => s.context);
  if (pending.length || pendingStatus.length) reasons.push({ code: 'CHECKS_PENDING', detail: [...pending, ...pendingStatus].slice(0, 10).join(', ') });
  const failing = [
    ...runs.filter(r => r.status === 'completed' && FAIL_CONCLUSIONS.has(r.conclusion)).map(r => r.name),
    ...c.statuses.filter(s => s.state === 'failure' || s.state === 'error').map(s => s.context)
  ];
  const real = [...new Set(failing)];
  const tolerated = policy.allowBaselineFailures && baselineFailing ? real.filter(n => baselineFailing.has(n)) : [];
  const blocking = real.filter(n => !tolerated.includes(n));
  if (blocking.length) reasons.push({ code: 'CHECK_FAILED', detail: blocking.slice(0, 10).join(', ') });
  if (tolerated.length) notes.push(`baseline failures tolerated (the same checks also fail on the default branch head): ${tolerated.join(', ')}`);
  const okRuns = runs.filter(r => r.status === 'completed' && OK_CONCLUSIONS.has(r.conclusion) && r.conclusion !== 'skipped').length + c.statuses.filter(s => s.state === 'success').length;
  if (okRuns < policy.minChecks) reasons.push({ code: 'TOO_FEW_CHECKS', detail: `${okRuns} passing check(s), policy needs ${policy.minChecks}` });
  let unregistered = false;
  for (const need of policy.requiredChecks) {
    const hit = runs.find(r => r.name === need) || c.statuses.find(s => s.context === need);
    if (!hit) unregistered = true;
    const good = hit && (hit.conclusion ? OK_CONCLUSIONS.has(hit.conclusion) : hit.state === 'success');
    if (!good) reasons.push({ code: 'REQUIRED_CHECK_MISSING', detail: need });
  }
  if (!c.complete) reasons.push({ code: 'CHECKS_TRUNCATED', detail: 'more than 600 check runs; not verified' });
  const pendingAny = pending.length + pendingStatus.length > 0;
  // in CI this check starts with the others, before they are even registered on the head: keep waiting for them too
  return { reasons, notes, pending: pendingAny, waiting: pendingAny || (okRuns < policy.minChecks && !blocking.length) || unregistered };
}

// ---------- the owner's approval (ci mode only) ----------
// Only these reasons are a person's call; a failing or pending check, a deploy on merge, a secret, fewer tests, a moved
// head, a conflict, a draft or a fork is never approved away.
export const APPROVABLE = new Set(['SENSITIVE_PATH', 'TOO_MANY_FILES', 'TOO_MANY_LINES', 'NOT_AGENT_BRANCH', 'NO_PACKAGE_CONFIG_CHECK']);
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export function headApproval(reviews, head, author) {
  if (!author) return null;
  const person = r => r.user?.login && r.user.type !== 'Bot' && r.user.login !== author && TRUSTED.has(r.author_association);
  const latest = new Map(); // login -> latest decisive review (a later comment does not undo a change request)
  for (const r of reviews) if (person(r) && DECISIVE.has(r.state)) latest.set(r.user.login, r);
  if ([...latest.values()].some(r => r.state === 'CHANGES_REQUESTED')) return null;
  const hit = reviews.find(r => person(r) && r.state === 'APPROVED' && r.commit_id === head && latest.get(r.user.login)?.state !== 'DISMISSED');
  return hit ? hit.user.login : null;
}

function ledgerReasons(checkout, run) {
  return import('./run-state.mjs').then(async rs => {
    const reasons = [];
    const q = await import('./questions.mjs');
    const policyFile = new URL('../../../../.config/trioharness/jev-receipt-policy.mjs', import.meta.url);
    const { JEV_RECEIPT_REQUIRED } = await import(existsSync(policyFile) ? policyFile :
      pathToFileURL(join(userInfo().homedir, '.config', 'trioharness', 'jev-receipt-policy.mjs')));
    if (typeof JEV_RECEIPT_REQUIRED !== 'boolean') throw new Error('JEV_RECEIPT_POLICY_INVALID');
    const state = rs.readState(checkout, run);
    if (!state) return [{ code: 'RUN_UNKNOWN', detail: `no ledger for run ${run} in ${checkout}` }];
    const g = state.gates || {};
    for (const need of ['guard-proof', ...(JEV_RECEIPT_REQUIRED ? ['done-jev'] : []), 'commit-push']) if (g[need]?.status !== 'passed') reasons.push({ code: 'GATE_NOT_PASSED', detail: need });
    if (g['deploy-qa'] && g['browser-test']?.status !== 'passed') reasons.push({ code: 'GATE_NOT_PASSED', detail: 'browser-test (a QA deploy was recorded)' });
    for (const [n, v] of Object.entries(g)) if ((JEV_RECEIPT_REQUIRED || n !== 'done-jev') && ['failed', 'blocked'].includes(v.status)) reasons.push({ code: 'GATE_FAILED', detail: n });
    const open = q.openQuestionsReason(checkout, run); if (open) reasons.push({ code: 'QUESTIONS_OPEN', detail: open });
    return reasons;
  });
}

// ---------- the verdict ----------
export async function evaluate({ repo, pr, expectSha, mode = 'architect', checkout, run, waitChecksSec = 0 }, { gh = ghCli, now = () => Date.now(), pause = sleep } = {}) {
  const reasons = []; const notes = []; const evidence = {};
  const result = (verdict, extra = {}) => ({ verdict, repo, pr, ...extra, reasons, notes, evidence });
  const fail = (code, detail) => reasons.push({ code, detail });

  const meta = api(gh, `repos/${repo}`);
  if (!meta.ok) { fail('GITHUB_UNREADABLE', `repository: ${meta.err}`); return result('ERROR'); }
  const def = meta.json.default_branch; evidence.defaultBranch = def;
  if (meta.json.fork) fail('FORK', 'the repository is a fork');

  // policy: default branch only
  const pol = raw(gh, `repos/${repo}/contents/${POLICY_PATH}?ref=${encodeURIComponent(def)}`);
  if (!pol.ok) return result('NOT_ENABLED', { detail: `no ${POLICY_PATH} on ${def}: this repository has not opted in to verified merges` });
  let parsed; try { parsed = JSON.parse(pol.text); } catch { fail('POLICY_INVALID', `${POLICY_PATH} on ${def} is not valid JSON`); return result('ERROR'); }
  const { errors, policy } = validatePolicy(parsed);
  if (errors.length) { fail('POLICY_INVALID', errors.join('; ')); return result('ERROR'); }
  if (!policy.enabled) return result('NOT_ENABLED', { detail: `${POLICY_PATH} has enabled:false` });
  evidence.policy = { mergeMethod: policy.mergeMethod, maxFiles: policy.maxFiles, maxChangedLines: policy.maxChangedLines };

  const pull = api(gh, `repos/${repo}/pulls/${pr}`);
  if (!pull.ok) { fail('GITHUB_UNREADABLE', `pull request: ${pull.err}`); return result('ERROR'); }
  const p = pull.json; const head = p.head?.sha; evidence.head = head; evidence.headRef = p.head?.ref;
  if (p.state !== 'open') fail('PR_NOT_OPEN', p.merged ? 'already merged' : p.state);
  if (p.draft) fail('PR_DRAFT', 'draft pull request');
  if (p.base?.ref !== def) fail('BASE_NOT_DEFAULT', `base is ${p.base?.ref}, default is ${def}`);
  if (!AGENT_BRANCH.test(p.head?.ref || '')) fail('NOT_AGENT_BRANCH', `head ${p.head?.ref}: only bambooed/*, trio/* and codeden/* task branches are auto-merged`);
  if (p.head?.repo?.full_name !== repo) fail('HEAD_FROM_FORK', 'the head is in another repository');
  if (expectSha && head !== expectSha) fail('HEAD_CHANGED', `head is ${String(head).slice(0, 12)}, expected ${String(expectSha).slice(0, 12)}`);
  if (p.mergeable === false || p.mergeable_state === 'dirty') fail('CONFLICTS', 'the PR does not merge cleanly');
  if (p.mergeable_state === 'behind') fail('BEHIND', `the default branch moved on; merge ${def} into the task branch, rerun proof, then verify again`);
  if (policy.requireBodySection && !/package and config check/i.test(p.body || '')) fail('NO_PACKAGE_CONFIG_CHECK', 'the PR description has no "Package and config check" section');
  if ((p.commits || 0) > 250) fail('TOO_MANY_COMMITS', `${p.commits} commits`);

  // files
  const files = allPages(gh, `repos/${repo}/pulls/${pr}/files`, null, 30);
  if (!files.ok) { fail('GITHUB_UNREADABLE', `file list: ${files.err}`); return result('ERROR'); }
  if (!files.complete || (p.changed_files && files.items.length < p.changed_files)) fail('DIFF_TRUNCATED', 'GitHub does not list every changed file; not verified');
  const list = files.items; evidence.files = list.length;
  const changed = list.reduce((s, f) => s + (f.additions || 0) + (f.deletions || 0), 0); evidence.changedLines = changed;
  if (list.length > policy.maxFiles) fail('TOO_MANY_FILES', `${list.length} files, policy allows ${policy.maxFiles}`);
  if (changed > policy.maxChangedLines) fail('TOO_MANY_LINES', `${changed} changed lines, policy allows ${policy.maxChangedLines}`);

  const agents = raw(gh, `repos/${repo}/contents/AGENTS.md?ref=${encodeURIComponent(def)}`);
  const extra = [...policy.extraSensitive, ...(agents.ok ? parseHighRisk(agents.text) : [])];
  const sensitive = []; const reviewed = []; const secretHits = []; const noPatch = [];
  for (const f of list) {
    for (const name of [f.filename, f.previous_filename].filter(Boolean)) {
      const why = classifyPath(name, extra);
      if (why) (policy.sensitivePaths === 'review' && !isSecretMaterial(name) && !/^\.github\/actions\//i.test(name) ? reviewed : sensitive).push(`${name} (${why})`);
    }
    if (f.status === 'removed') continue;
    const patch = f.patch;
    if (patch === undefined || patch === null) {
      const pureRename = f.status === 'renamed' && !(f.changes > 0);
      if (!pureRename && !IMAGE.test(f.filename) && (f.changes || 0) > 0) noPatch.push(f.filename);
      else if (!pureRename && !IMAGE.test(f.filename) && f.status === 'added') noPatch.push(f.filename);
      continue;
    }
    const added = patch.split('\n').filter(l => l[0] === '+' && !l.startsWith('+++')).map(l => l.slice(1)).join('\n');
    const h = findSecrets(added); if (h.length) secretHits.push(`${f.filename} (${h[0].rule})`);
  }
  if (sensitive.length) fail('SENSITIVE_PATH', [...new Set(sensitive)].slice(0, 12).join('; '));
  if (reviewed.length) notes.push(`sensitive paths merge on review (sensitivePaths "review" in ${POLICY_PATH}): ${[...new Set(reviewed)].slice(0, 12).join('; ')}`);
  if (secretHits.length) fail('SECRET_SHAPED_LINE', secretHits.slice(0, 8).join('; '));
  if (noPatch.length) fail('NO_PATCH_TO_SCAN', `${noPatch.slice(0, 8).join(', ')} (binary or too large for GitHub to show; not scanned)`);
  for (const t of testReduction(list)) fail(t.code, t.detail);

  // commit messages
  const commits = allPages(gh, `repos/${repo}/pulls/${pr}/commits`, null, 3);
  if (!commits.ok) fail('GITHUB_UNREADABLE', `commits: ${commits.err}`);
  else { const hit = commits.items.find(c => findSecrets(c.commit?.message || '').length); if (hit) fail('SECRET_IN_COMMIT_MESSAGE', String(hit.sha).slice(0, 12)); }

  // does merging trigger anything live?
  const wf = api(gh, `repos/${repo}/contents/.github/workflows?ref=${encodeURIComponent(def)}`);
  let deployOnMerge = false;
  const judgeWorkflow = (path, text, label) => {
    const a = analyzeWorkflow(text, def);
    if (a.triggers && a.deployish && (policy.ciWorkflows || []).includes(path) && !deployToolsIn(text)) notes.push(`${label} runs on ${a.why}; the words deploy/publish are ignored (listed in ciWorkflows of ${POLICY_PATH}; no deploy tool found)`);
    else if (a.triggers && a.deployish) { deployOnMerge = true; fail('DEPLOY_ON_MERGE', `${label} runs on ${a.why} and looks like a deploy, release, publish or upload`); }
    else if (a.triggers) notes.push(`${label} runs on ${a.why} (no deploy-like step found)`);
  };
  if (wf.ok && Array.isArray(wf.json)) {
    for (const f of wf.json.filter(x => /\.ya?ml$/i.test(x.name))) {
      const t = raw(gh, `repos/${repo}/contents/${f.path}?ref=${encodeURIComponent(def)}`);
      if (!t.ok) { fail('WORKFLOW_UNREADABLE', f.path); continue; }
      judgeWorkflow(f.path, t.text, f.path);
    }
  } else if (!wf.ok && !/Not Found|404/i.test(wf.err || '')) fail('WORKFLOW_UNREADABLE', `.github/workflows: ${wf.err}`);
  // sensitivePaths "review" lets a PR change workflows, so every workflow it adds, changes or renames is read at the PR
  // head as data only (never run) and judged fail-closed, by content rather than by trigger parsing: a deploy-like
  // workflow (for a ciWorkflows entry: a deploy tool), or one that calls a reusable workflow or a local action that
  // merge-verify cannot follow, is DEPLOY_ON_MERGE whatever its triggers say.
  if (policy.sensitivePaths === 'review') {
    for (const f of list.filter(x => x.status !== 'removed' && /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(x.filename))) {
      const label = `${f.filename} at the PR head`;
      const t = raw(gh, `repos/${repo}/contents/${f.filename}?ref=${encodeURIComponent(head)}`);
      if (!t.ok) { fail('WORKFLOW_UNREADABLE', label); continue; }
      const a = analyzeWorkflow(t.text, def);
      const deployish = (policy.ciWorkflows || []).includes(f.filename) ? deployToolsIn(t.text) : a.deployish;
      if (unfollowableUses(t.text)) { deployOnMerge = true; fail('DEPLOY_ON_MERGE', `${label} calls a reusable workflow or a local action; merge-verify cannot follow it, so a person decides`); }
      else if (deployish) { deployOnMerge = true; fail('DEPLOY_ON_MERGE', `${label} looks like a deploy, release, publish or upload; a PR may not change a deploy-like workflow without a person, whatever its triggers`); }
      else if (a.triggers) notes.push(`${label} runs on ${a.why} (no deploy-like step found)`);
    }
  }

  // checks (wait for pending or not yet registered ones when asked)
  const deadline = now() + waitChecksSec * 1000;
  let c; let judged;
  for (;;) {
    c = readChecks(gh, repo, head);
    if (!c.ok) { fail('GITHUB_UNREADABLE', `checks: ${c.err}`); break; }
    let baseline = null;
    if (policy.allowBaselineFailures) {
      const br = api(gh, `repos/${repo}/branches/${encodeURIComponent(def)}`);
      const bc = br.ok ? readChecks(gh, repo, br.json.commit.sha) : { ok: false };
      if (bc.ok) baseline = new Set([...bc.runs.filter(r => r.status === 'completed' && FAIL_CONCLUSIONS.has(r.conclusion)).map(r => r.name), ...bc.statuses.filter(s => ['failure', 'error'].includes(s.state)).map(s => s.context)]);
    }
    judged = judgeChecks(c, policy, baseline);
    if (!judged.waiting || now() >= deadline) break;
    await pause(20000);
  }
  if (judged) { reasons.push(...judged.reasons); notes.push(...judged.notes); }

  if (checkout && run && mode === 'architect') reasons.push(...await ledgerReasons(resolve(checkout), run));

  // ci only: what is left is a person's call and an owner/member/collaborator approved THIS head (the Architect never uses this)
  if (mode === 'ci' && reasons.length && reasons.every(r => APPROVABLE.has(r.code))) {
    const rv = allPages(gh, `repos/${repo}/pulls/${pr}/reviews`, null, 10);
    const by = rv.ok ? headApproval(rv.items, head, p.user?.login) : null;
    if (!rv.ok) notes.push(`reviews unreadable (${rv.err}); no approval counted`);
    else if (by) {
      evidence.approvedBy = by; evidence.acceptedByApproval = reasons.splice(0);
      notes.push(`approved by ${by} on this exact head ${String(head).slice(0, 12)}: ${evidence.acceptedByApproval.map(r => r.code).join(', ')} accepted by human approval`);
    }
  }

  const verdict = reasons.length === 0 ? 'PASS' : reasons.some(r => r.code === 'DEPLOY_ON_MERGE') ? 'DEPLOY_ON_MERGE' : reasons.some(r => r.code === 'GITHUB_UNREADABLE' || r.code === 'POLICY_INVALID') ? 'ERROR' : 'NEEDS_APPROVAL';
  return result(verdict, { head, policy });
}

// ---------- merge and after ----------
export async function mergePr(opts, deps = {}) {
  const gh = deps.gh || ghCli;
  if (!opts.expectSha) return { verdict: 'ERROR', merged: false, reasons: [{ code: 'EXPECT_SHA_REQUIRED', detail: 'pass --expect-sha <head sha you verified>' }], notes: [], evidence: {} };
  const v = await evaluate({ ...opts, mode: 'architect' }, deps);
  if (v.verdict !== 'PASS') return { ...v, merged: false };
  const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[v.policy.mergeMethod];
  const r = gh(['pr', 'merge', String(opts.pr), '--repo', opts.repo, flag, '--match-head-commit', opts.expectSha]);
  if (!r.ok) return { ...v, verdict: 'MERGE_REFUSED', merged: false, detail: String(r.err || r.out).slice(0, 300), hint: 'GitHub (a ruleset or branch protection) refused the merge. Do not work around it: ask for the approval card with this verdict as evidence.' };
  return { ...v, verdict: 'MERGED', merged: true };
}

const DEPLOY_NAME = /deploy|release|publish|prod|upload|ship|testflight|play/i;
export async function postMerge({ repo, pr, waitSec = 120 }, { gh = ghCli, now = () => Date.now(), pause = sleep } = {}) {
  const reasons = []; const notes = []; const evidence = {};
  const end = now() + waitSec * 1000; let p;
  for (;;) {
    const r = api(gh, `repos/${repo}/pulls/${pr}`);
    if (!r.ok) return { verdict: 'ERROR', repo, pr, reasons: [{ code: 'GITHUB_UNREADABLE', detail: r.err }], notes, evidence };
    p = r.json; if (p.merged || now() >= end) break; await pause(5000);
  }
  if (!p.merged) return { verdict: 'POST_ATTENTION', repo, pr, reasons: [{ code: 'NOT_MERGED', detail: 'the PR is not merged' }], notes, evidence };
  const sha = p.merge_commit_sha; const def = p.base.ref; evidence.mergeCommit = sha; evidence.defaultBranch = def;
  const cmp = api(gh, `repos/${repo}/compare/${sha}...${encodeURIComponent(def)}`);
  if (!cmp.ok || !['identical', 'ahead'].includes(cmp.json.status)) reasons.push({ code: 'MERGE_NOT_ON_DEFAULT', detail: cmp.ok ? `compare says ${cmp.json.status}` : cmp.err });
  let runs = [];
  for (;;) {
    const r = api(gh, `repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`);
    runs = r.ok ? (r.json.workflow_runs || []) : [];
    if (!runs.some(x => x.status !== 'completed') || now() >= end) break;
    await pause(10000);
  }
  evidence.runs = runs.map(x => ({ name: x.name, event: x.event, status: x.status, conclusion: x.conclusion }));
  for (const x of runs) {
    if (DEPLOY_NAME.test(`${x.name} ${x.path || ''}`)) reasons.push({ code: 'DEPLOY_STARTED', detail: `${x.name} (${x.event}, ${x.status})` });
    else if (x.status === 'completed' && FAIL_CONCLUSIONS.has(x.conclusion)) reasons.push({ code: 'DEFAULT_BRANCH_RED', detail: `${x.name}: ${x.conclusion}` });
    else if (x.status !== 'completed') notes.push(`${x.name} is still running`);
  }
  return { verdict: reasons.length ? 'POST_ATTENTION' : 'POST_OK', repo, pr, reasons, notes, evidence };
}

// ---------- re-run the required check after the owner approved ----------
// A review does not re-run the check (a pull_request_review trigger would run the workflow file from the PR), so after
// the approval someone runs `recheck` (or presses Re-run on the check in GitHub) and the check sees the approval.
export function recheck({ repo, pr }, { gh = ghCli } = {}) {
  const out = (verdict, extra = {}) => ({ verdict, repo, pr, ...extra });
  const pull = api(gh, `repos/${repo}/pulls/${pr}`);
  if (!pull.ok) return out('ERROR', { detail: `pull request: ${pull.err}` });
  const head = pull.json.head?.sha;
  const runs = api(gh, `repos/${repo}/actions/runs?head_sha=${head}&per_page=100`);
  if (!runs.ok) return out('ERROR', { head, detail: `workflow runs: ${runs.err}` });
  const mine = (runs.json.workflow_runs || []).filter(x => x.name === CHECK_NAME || /(^|\/)merge-verify\.ya?ml$/.test(x.path || ''))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);
  const last = mine[0];
  if (!last) return out('NO_RUN', { head, detail: `no ${CHECK_NAME} workflow run for head ${String(head).slice(0, 12)}; is the workflow on the default branch?` });
  const run = { id: last.id, url: last.html_url, status: last.status, conclusion: last.conclusion };
  if (last.status !== 'completed') return out('RUN_IN_PROGRESS', { head, run, detail: 'the check is still running; run recheck again once it has finished' });
  const r = gh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${last.id}/rerun`]);
  if (r.ok) return out('RERUN_REQUESTED', { head, run, detail: `${CHECK_NAME} run ${last.id} re-runs and will see the approvals on this head` });
  const err = String(r.err || r.out).slice(0, 300);
  if (/\b403\b|forbidden|not accessible by integration/i.test(err)) return out('RERUN_FORBIDDEN', { head, run, detail: err, hint: 'GitHub refused the re-run (403): the GitHub App or token used here needs the repository permission "Actions: Read and write". The owner grants it, or presses Re-run on the merge-verify check in the pull request.' });
  return out('ERROR', { head, run, detail: err });
}

// ---------- installing it into a repo and the ruleset the owner approves ----------
export function rulesetJson(check = CHECK_NAME) {
  return {
    name: 'Verified merge', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    // Copy bypass_actors from the ruleset this one replaces, so people who can bypass today still can.
    bypass_actors: [],
    rules: [
      { type: 'deletion' }, { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: check }] } }
    ]
  };
}
export function install(checkout, skillDir) {
  const out = []; const dest = join(checkout, '.github', 'merge-verify');
  mkdirSync(dest, { recursive: true });
  for (const f of ['merge-verify.mjs', 'secret-patterns.mjs', 'is-main.mjs', 'issues-failure-log.mjs']) { copyFileSync(join(skillDir, 'scripts', f), join(dest, f)); out.push(`.github/merge-verify/${f}`); }
  mkdirSync(join(checkout, '.github', 'workflows'), { recursive: true });
  copyFileSync(join(skillDir, 'templates', 'repo', 'github', 'merge-verify.example.yml'), join(checkout, '.github', 'workflows', 'merge-verify.yml')); out.push('.github/workflows/merge-verify.yml');
  mkdirSync(join(checkout, '.trioharness'), { recursive: true });
  const pf = join(checkout, POLICY_PATH);
  if (!existsSync(pf)) { writeFileSync(pf, `${JSON.stringify({ ...DEFAULT_POLICY, enabled: true }, null, 2)}\n`); out.push(POLICY_PATH); }
  return out;
}

// ---------- CLI ----------
function parseArgs(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; } else o._.push(argv[i]); } return o; }
const here = dirname(fileURLToPath(import.meta.url));

export async function main(argv = process.argv.slice(2), { loadIssues = () => import('./issues.mjs') } = {}) {
  const o = parseArgs(argv); const cmd = o._[0];
  const print = v => console.log(JSON.stringify(v, null, 2));
  try {
    if (cmd === 'ruleset') { print(rulesetJson(typeof o.check === 'string' ? o.check : CHECK_NAME)); return 0; }
    if (cmd === 'install') {
      if (!o.repo) throw new Error('--repo <checkout> is required');
      const files = install(resolve(o.repo), typeof o.skill === 'string' ? resolve(o.skill) : resolve(here, '..'));
      print({ wrote: files, next: ['Commit these on a task branch and open the PR (every one of these paths is sensitive, so this PR is always an approval card).', 'After it is merged, the owner approves ONE card: replace the manual merge-approval ruleset by the output of `merge-verify.mjs ruleset` (copy the old bypass_actors; disable the old ruleset, do not delete it).', 'Until then merge-verify still works as a local check and a merge falls back to the card.'] });
      return 0;
    }
    if (!['check', 'merge', 'post', 'ci', 'recheck'].includes(cmd)) { console.error('usage: merge-verify.mjs check|merge|post|ci|recheck|install|ruleset (see the file header)'); return 1; }
    if (!o.repo || !o.pr) throw new Error('--repo and --pr are required');
    const repo = slugOf(String(o.repo)); const pr = parseInt(o.pr, 10);
    if (!Number.isInteger(pr) || pr < 1) throw new Error('--pr must be a pull request number');
    if (cmd === 'recheck') { const r = recheck({ repo, pr }); print(r); console.error(`${r.verdict}: ${r.hint || r.detail}`); return r.verdict === 'RERUN_REQUESTED' ? 0 : 2; }
    const wait = parseInt(o['wait-checks-sec'] || (cmd === 'ci' ? '1500' : '0'), 10) || 0;
    let v;
    if (cmd === 'post') v = await postMerge({ repo, pr, waitSec: parseInt(o['wait-sec'] || '120', 10) });
    else if (cmd === 'merge') v = await mergePr({ repo, pr, expectSha: o['expect-sha'], checkout: o.checkout, run: o.run, waitChecksSec: wait });
    else v = await evaluate({ repo, pr, expectSha: typeof o['expect-sha'] === 'string' ? o['expect-sha'] : undefined, mode: cmd === 'ci' ? 'ci' : 'architect', checkout: o.checkout, run: o.run, waitChecksSec: wait });
    print(v);
    console.error(`${v.verdict}${v.reasons?.length ? `: ${v.reasons.map(r => r.code).join(', ')}` : ''}`);
    const code = ['PASS', 'MERGED', 'POST_OK'].includes(v.verdict) ? 0 : 2;
    // Kept local so installed merge checks do not require the run-state helpers.
    const validRunId = run => typeof run === 'string' && /^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(run) && run !== '.' && run !== '..';
    if (v.verdict === 'MERGED' && validRunId(o.run)) {
      const ledger = resolve(typeof o.checkout === 'string' ? o.checkout : '.');
      const key = typeof o.key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(o.key) ? o.key : undefined;
      let category = 'IMPORT_FAILED';
      try {
        const mod = await loadIssues();
        category = 'OTHER';
        await mod.transitionForEvent('merged', { repo, ledger, run: o.run, target: undefined, sha: v.head, revision: undefined, toSha: undefined, toRevision: undefined, ...(key ? { key } : {}) });
      } catch {
        appendFailure({ ledger, run: o.run, event: 'merged', category, key });
      }
    }
    return code;
  } catch (e) { console.error(e.message); return 1; }
}
if (isMain(import.meta.url)) main().then(c => process.exit(c));
