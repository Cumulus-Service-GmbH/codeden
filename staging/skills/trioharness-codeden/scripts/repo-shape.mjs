#!/usr/bin/env node
// TrioHarness Lean — repository shape gate (gate 0).
// Gate 1 needs a real default branch: `origin/<default>` is the base of every candidate and the
// merge target the pre-push hook protects. A repository whose remote default is a task branch
// (bambooed/*, trio/*, codex/*, a dated slice) or which has no default branch at all cannot be
// based, guarded or merged correctly, so the harness checks the shape before anything else.
//
// Audits by default. Fixing is applied only with --apply, and --apply without the repository's
// exact standing-authorization line in AGENTS.md exits 2 with the line to add.
//
// What --apply can do, and nothing else: `git fetch <remote> <source>`, `git branch <want> FETCH_HEAD`
// (never -f), `git push -u <remote> <want>:<want>` (never --force, only a ref creation), `git remote
// set-head`, `gh repo edit --repo <this remote's URL> --default-branch <want>`. The new branch is always
// cut from a branch THAT EXISTS ON THE REMOTE, fetched at that moment — never from local HEAD, a local
// branch or a cached tracking ref — so nothing unpushed can ever be published as the default.
//
// Usage:
//   node repo-shape.mjs [--repo .] [--remote origin] [--want main] [--json]
//   node repo-shape.mjs --apply [--repo .] [--remote origin] [--want main]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './is-main.mjs';

// Branch names that are task output, never a default branch.
export const TASK_BRANCH_PATTERNS = [
  /^codeden\//i, /^bambooed\//i, /^trio\//i, /^codex\//i, /^claude\//i, /^agent\//i,
  /^(feat|feature|fix|chore|hotfix|wip|slice|task|harness)[-/]/i,
  /^[a-z-]*\d{8}$/i,            // harnessloop20260921 and friends
  /^.+-\d{8}(-\d+)?$/i
];
export const isTaskBranch = name => TASK_BRANCH_PATTERNS.some(re => re.test(String(name || '')));
export const CONVENTIONAL_DEFAULT = /^(main|master|develop|trunk)$/i;
export const BRANCH_NAME_OK = CONVENTIONAL_DEFAULT;   // --want may only name a conventional default branch

// The one line a repository's AGENTS.md carries to let the Architect fix its own shape without asking.
// It is matched as an exact line (trimmed), from AGENTS.md only: repository content is untrusted input,
// so a sentence that merely mentions the words must not count.
export const STANDING_AUTHORIZATION_LINE =
  '- Repository shape: standing authorization to create the default branch and set it on the remote when missing or task-shaped.';
export function hasStandingAuthorization(agentsText) {
  const want = STANDING_AUTHORIZATION_LINE.replace(/^-\s*/, '').trim();
  return String(agentsText || '').split(/\r?\n/).some(l => l.replace(/^[-*]\s*/, '').trim() === want);
}
export function readAgents(repo) {
  const p = join(repo, 'AGENTS.md');
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

// Pure classification. `verdict` decides the action; `ok` is the only verdict that needs nothing.
//   facts: { localBranches[], remoteBranches[], remoteDefault|null, want, hasRemote, hasCommits }
export function classifyShape(facts) {
  const want = facts.want || 'main';
  const remoteBranches = facts.remoteBranches || [];
  if (!BRANCH_NAME_OK.test(want)) return { verdict: 'want-invalid', ok: false, action: 'ask', reasons: [`--want "${want}" must be one of main, master, develop, trunk`] };
  if (!facts.hasCommits) {
    return { verdict: 'empty-repo', ok: false, action: 'ask',
      reasons: ['repository has no commits — nothing can be based on a default branch yet'] };
  }
  if (!facts.hasRemote) {
    return { verdict: 'no-remote', ok: false, action: 'ask',
      reasons: ['no remote configured — the base SHA cannot come from a remote default branch'] };
  }
  if (remoteBranches.includes(want) && facts.remoteDefault === want) {
    return { verdict: 'ok', ok: true, action: 'none', defaultBranch: want, reasons: [`remote default is ${want}`] };
  }
  // A conventional default under another name (master, develop, trunk) is a correct shape, not a
  // repair target: creating a second default beside it would split the history. Report, use it.
  if (facts.remoteDefault && CONVENTIONAL_DEFAULT.test(facts.remoteDefault) && remoteBranches.includes(facts.remoteDefault)) {
    return { verdict: 'ok', ok: true, action: 'none', defaultBranch: facts.remoteDefault,
      reasons: [`remote default is ${facts.remoteDefault} (not ${want}); base every run on ${facts.remoteDefault} and pass --want ${facts.remoteDefault}`] };
  }
  // A deliberate default under a non-conventional name (release, stable, v2) is the owner's choice: the standing
  // authorization covers a missing or task-shaped default only, so anything else is asked, never changed.
  if (remoteBranches.includes(want) && facts.remoteDefault && !isTaskBranch(facts.remoteDefault)) {
    return { verdict: 'default-differs', ok: false, action: 'ask', want, defaultBranch: facts.remoteDefault,
      reasons: [`${want} exists but the remote default is ${facts.remoteDefault}, which is not a task branch; the user decides whether to change it (base this run on ${facts.remoteDefault} or pass --want ${facts.remoteDefault})`] };
  }
  if (remoteBranches.includes(want) && facts.remoteDefault !== want) {
    return { verdict: 'default-not-set', ok: false, action: 'set-default', want, defaultBranch: want,
      reasons: [`${want} exists on the remote but the remote default is ${facts.remoteDefault || '(unset)'}`] };
  }
  // The new default is cut only from a branch that exists on the remote. Local branches and HEAD are
  // never a source: they may hold unpushed, private or dirty history.
  const from = remoteBranches.find(b => CONVENTIONAL_DEFAULT.test(b))
    || (facts.remoteDefault && remoteBranches.includes(facts.remoteDefault) ? facts.remoteDefault : null);
  const taskShaped = facts.remoteDefault ? isTaskBranch(facts.remoteDefault) : false;
  if (!from) {
    return { verdict: 'no-remote-source', ok: false, action: 'ask', want,
      reasons: [`the remote has no ${want} and no branch to cut it from (remote default: ${facts.remoteDefault || 'unset'}; remote branches: ${remoteBranches.join(', ') || 'none'}) — the user chooses the source and pushes it`] };
  }
  return {
    verdict: taskShaped ? 'task-shaped-default' : 'no-default-branch',
    ok: false,
    action: 'create-and-set',
    want,
    from,
    defaultBranch: want,
    reasons: [
      taskShaped
        ? `the remote default ${facts.remoteDefault} is a task branch, not a default branch`
        : `the remote has no ${want} branch (default: ${facts.remoteDefault || 'unset'})`
    ]
  };
}

// The steps the fix takes, in order, as plain commands — so an audit prints exactly what --apply runs.
// `state` lets the plan skip steps already done, which makes --apply safe to rerun after a partial run.
export function fixPlan({ action, want, from }, { remote = 'origin', repoUrl = null, state = {} } = {}) {
  const gh = repoUrl ? [['gh', ['repo', 'edit', '--repo', repoUrl, '--default-branch', want]]] : [];
  if (action === 'set-default') return gh;
  if (action !== 'create-and-set') return [];
  if (!from) throw new Error('SHAPE_NO_SOURCE: refusing to cut a default branch from local HEAD');
  const steps = [];
  if (!state.localExists) steps.push(['git', ['fetch', remote, from]], ['git', ['branch', want, 'FETCH_HEAD']]);
  if (!state.remoteExists) steps.push(['git', ['push', '-u', remote, `${want}:${want}`]]);
  steps.push(['git', ['remote', 'set-head', remote, want]]);
  return steps.concat(gh);
}

// gh must act on THIS remote's repository, never whichever one it resolves from the cwd (a fork with
// `upstream` would otherwise get its default branch changed). Only GitHub URLs are passed through.
export function githubRepoUrl(remoteUrl) {
  const u = String(remoteUrl || '').trim();
  const m = u.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

// Network git never prompts for credentials and never hangs a gate.
export const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
export const NET_TIMEOUT_MS = 120000;

export function inspectShape(repo, { remote = 'origin', want = 'main', gitRun } = {}) {
  const git = gitRun || ((...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV, timeout: NET_TIMEOUT_MS }));
  let hasCommits = true;
  try { git('rev-parse', 'HEAD'); } catch { hasCommits = false; }
  let hasRemote = true;
  try { hasRemote = git('remote').split('\n').map(s => s.trim()).includes(remote); } catch { hasRemote = false; }
  let remoteBranches = [], remoteDefault = null, remoteReachable = false, remoteUrl = null;
  if (hasRemote) {
    try { remoteUrl = git('remote', 'get-url', remote).trim(); } catch { remoteUrl = null; }
    // The live remote first: the local refs/remotes/<remote>/HEAD symref is a clone-time cache.
    try {
      const out = git('ls-remote', '--symref', remote);
      remoteReachable = true;
      const m = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
      remoteDefault = m ? m[1] : null;
      remoteBranches = out.split('\n').filter(l => /\trefs\/heads\//.test(l))
        .map(l => String(l.split(/\s+/)[1] || '').replace('refs/heads/', '')).filter(Boolean);
    } catch { remoteReachable = false; }
    if (!remoteReachable) {
      try { remoteDefault = (git('symbolic-ref', `refs/remotes/${remote}/HEAD`).trim().split('/').pop()) || null; } catch { remoteDefault = null; }
      try { remoteBranches = git('branch', '-r', '--format=%(refname:short)').split('\n').map(s => s.trim()).filter(s => s.startsWith(`${remote}/`) && !s.endsWith('/HEAD')).map(s => s.slice(remote.length + 1)); } catch { remoteBranches = []; }
    }
  }
  let localBranches = [];
  try { localBranches = git('branch', '--format=%(refname:short)').split('\n').map(s => s.trim()).filter(Boolean); } catch { localBranches = []; }
  const facts = { localBranches, remoteBranches, remoteDefault, want, hasRemote, hasCommits, remoteReachable, remoteUrl };
  const verdict = classifyShape(facts);
  // Without a reachable remote nothing about its shape is proven: never repair from cached refs.
  if (hasRemote && !remoteReachable && !verdict.ok) {
    return { facts, ...verdict, action: 'ask', verdict: 'remote-unreachable', reasons: [`${remote} is unreachable; shape cannot be verified from cached refs`, ...verdict.reasons] };
  }
  return { facts, ...verdict };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const has = n => argv.includes(`--${n}`);
  const repo = resolve(opt('repo') || '.');
  const remote = opt('remote') || 'origin';
  const want = opt('want') || 'main';
  const firstLine = e => String(e.stderr || e.message || e).split('\n').map(s => s.trim()).filter(Boolean).find(l => /blocked|fatal|error|rejected/i.test(l)) || String(e.message).split('\n')[0];
  try {
    const result = inspectShape(repo, { remote, want });
    const repoUrl = githubRepoUrl(result.facts.remoteUrl);
    const state = {
      localExists: result.facts.localBranches.includes(want),
      remoteExists: result.facts.remoteBranches.includes(want)
    };
    // A local branch already named <want> is pushed only if it is exactly the remote source head,
    // fetched now. Anything else (an older cut, an unpushed private commit) is the user's call.
    if (result.action === 'create-and-set' && state.localExists && !state.remoteExists) {
      let same = false, detail = '';
      try {
        execFileSync('git', ['-C', repo, 'fetch', remote, result.from], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV, timeout: NET_TIMEOUT_MS });
        const local = execFileSync('git', ['-C', repo, 'rev-parse', `refs/heads/${want}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const fetched = execFileSync('git', ['-C', repo, 'rev-parse', 'FETCH_HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        same = local === fetched;
        detail = `local ${want} is ${local.slice(0, 12)}, ${remote}/${result.from} is ${fetched.slice(0, 12)}`;
      } catch (e) { detail = firstLine(e); }
      if (!same) {
        result.action = 'ask'; result.ok = false; result.verdict = 'local-branch-conflict';
        result.reasons = [`a local branch ${want} already exists and is not the remote source head (${detail}) — the harness never pushes or moves a branch it did not create; delete or rename it yourself, or push it yourself`];
      }
    }
    const plan = result.action === 'ask' ? [] : fixPlan(result, { remote, repoUrl, state });
    const authorized = hasStandingAuthorization(readAgents(repo));
    const report = { repo, remote, want, ...result, repoUrl, plan: plan.map(([c, a]) => `${c} ${a.join(' ')}`), authorized, applied: [] };
    const advise = () => { if (result.ok && result.defaultBranch && result.defaultBranch !== want) process.stdout.write(`default branch: ${result.defaultBranch} — base every run on ${remote}/${result.defaultBranch} and pass --want ${result.defaultBranch}\n`); };

    if (has('json') && !has('apply')) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exitCode = result.ok ? 0 : 2; }
    else if (!has('apply')) {
      process.stdout.write(`SHAPE ${result.verdict}${result.ok ? '' : ` — ${result.reasons.join('; ')}`}\n`);
      advise();
      process.stdout.write(`remote default: ${result.facts.remoteDefault || '(unset)'} | remote branches: ${result.facts.remoteBranches.join(', ') || '(none)'}\n`);
      if (plan.length) {
        process.stdout.write(`fix (${authorized ? 'authorized by AGENTS.md — rerun with --apply' : 'NOT authorized'}):\n`);
        for (const line of report.plan) process.stdout.write(`  ${line}\n`);
        if (!repoUrl && result.action !== 'none') process.stdout.write(`  (remote is not a GitHub URL: the remote default must be set by hand after the push)\n`);
        if (!authorized) process.stdout.write(`to authorize, add exactly this line to the repository AGENTS.md:\n  ${STANDING_AUTHORIZATION_LINE}\n`);
      }
      process.exitCode = result.ok ? 0 : 2;
    } else {
      if (result.ok) { process.stdout.write('SHAPE ok — nothing to change\n'); advise(); process.exitCode = 0; }
      else if (result.action === 'ask') {
        process.stderr.write(`SHAPE_BLOCKED: ${result.verdict} — ${result.reasons.join('; ')}. This needs the user, not an automatic fix.\n`);
        process.exitCode = 2;
      } else if (!authorized) {
        process.stderr.write(`SHAPE_NOT_AUTHORIZED: ${result.verdict}. Add exactly this line to the repository AGENTS.md (then rerun):\n${STANDING_AUTHORIZATION_LINE}\n`);
        process.exitCode = 2;
      } else {
        // The pre-push hook lets this one ref CREATION through only while this marker is set, and only
        // when the remote ref does not exist yet. No other command in the harness sets it.
        const env = { ...GIT_ENV, TRIOHARNESS_SHAPE_CREATE: want };
        for (const [cmd, args] of plan) {
          try {
            execFileSync(cmd, cmd === 'git' ? ['-C', repo, ...args] : args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: NET_TIMEOUT_MS });
            report.applied.push(`${cmd} ${args.join(' ')}`);
          } catch (e) {
            const why = firstLine(e);
            if (cmd === 'gh') {
              process.stdout.write(`applied: ${report.applied.join(' | ') || '(none)'}\n`);
              process.stderr.write(`SHAPE_PARTIAL: ${want} exists on ${remote} but the remote default could not be set (${why}). Set it once in the repository settings, or run: gh repo edit --repo ${repoUrl} --default-branch ${want}\n`);
              process.exitCode = 2;
              break;
            }
            process.stdout.write(`applied: ${report.applied.join(' | ') || '(none)'}\n`);
            process.stderr.write(`SHAPE_FAILED: ${cmd} ${args.join(' ')} — ${why}. Rerunning --apply resumes at this step; never bypass a hook to get past it.\n`);
            process.exitCode = 2;
            break;
          }
        }
        if (process.exitCode === undefined || process.exitCode === 0) {
          if (!repoUrl && result.action !== 'none') {
            process.stdout.write(`applied: ${report.applied.join(' | ')}\n`);
            process.stderr.write(`SHAPE_PARTIAL: ${want} is on ${remote}, but ${remote} is not a GitHub URL, so the remote default must be set by hand in the hosting provider.\n`);
            process.exitCode = 2;
          } else {
            process.stdout.write(`SHAPE fixed — ${report.applied.join(' | ')}\n`);
            process.exitCode = 0;
          }
        }
      }
    }
  } catch (e) { process.stderr.write(`SHAPE: ${e.message}\n`); process.exitCode = 3; }
}
