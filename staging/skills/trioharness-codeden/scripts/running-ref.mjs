#!/usr/bin/env node
// TrioHarness Lean — running-ref gate (gate 0b). A task is based on the freshly fetched default branch of origin,
// but QA or production may be running code that is NOT on that branch (an unmerged branch deployed by hand,
// a hotfix, a build from a deleted branch). Work cut from the default branch then silently drops that code, and
// a deploy of it silently replaces it. This gate reads what each declared environment really runs, compares it
// with the live default branch and, when they differ in the dangerous way, forces a question card BEFORE any
// tree is cut. Read-only: it fetches, reads health endpoints and writes one record; it never deploys.
//
// Environments come from, in order: `<repo>/.trioharness/environments.json` (names + health URL + SHA field, for
// repos that must not get deploy rights yet) and the `health` blocks of `<repo>/.trioharness/deploy.json` targets.
// A repo that declares nothing is `not-configured`: nothing is enforced for it (bootstrap offers to declare them).
//
// Verdict per environment:
//   same           running SHA == default tip
//   behind         running SHA is an ancestor of the default tip (the default moved on; normal)
//   unmerged       BLOCKING: running SHA is not on the default branch (n commits exist only elsewhere)
//   unknown-commit BLOCKING: the SHA reported is in no branch of this repository (deleted branch, dirty build, other repo)
//   unverified     the environment did not report a usable SHA (down, no health path, no field): a warning, listed in the report
//
// Usage:
//   node running-ref.mjs check   --repo <main checkout> [--run <id>] [--remote origin] [--default main] [--target <name>] [--json]
//        Repeat --target or pass comma-separated names. RUNNING_REF_TARGETS=test,qa applies when no --target is given.
//        exit 0 nothing blocking · 2 blocking drift (ask the card, then `resolve`) · 3 error
//   node running-ref.mjs card    --repo <main checkout> --run <id>        the question card JSON to feed `questions.mjs ask`
//   node running-ref.mjs resolve --repo <main checkout> --run <id> --set Q-<n>   record the user's answer (the card must be answered)
//   node running-ref.mjs show    --repo <main checkout> --run <id>
// The base gate cannot pass in a repo that declares environments until `check --run` recorded the result and any
// blocking drift was answered (run-state.mjs enforces this through runningRefReason).
import { resolve } from 'node:path';
import { readHealthSha } from './deploy.mjs';
import { readSets } from './questions.mjs';
import { validRunId } from './ids.mjs';
import { isMain } from './is-main.mjs';
import {
  environmentsConfigured, gitIn, isProtectedClass, loadEnvironments, probePlan,
  resolveRemoteDefault, shaReader, withoutReplacements
} from './running-ref-targets.mjs';
import {
  SIGNATURE_REASON, loadRunningRefKey, readRecord, readVerifiedRecord, writeSignedRecord
} from './running-ref-mac.mjs';

export { environmentsConfigured, gitIn, loadEnvironments, readRecord, readVerifiedRecord };
export { ENVIRONMENTS_PATH, selectEnvironments } from './running-ref-targets.mjs';
export const BLOCKING = new Set(['unmerged', 'unknown-commit']);
export const CARD_QUESTION_ID = 'runningref';
export const CHOICES = { a: 'main-only', b: 'stop', c: 'overwrite-ok' };

// Pure given an injected `git(args) -> stdout` (throws on failure).
export function classifyRunning(reported, defaultSha, git, { remote = 'origin' } = {}) {
  git = withoutReplacements(git);
  if (typeof reported !== 'string' || !/^[0-9a-f]{7,40}$/i.test(reported.trim())) return { status: 'unverified', reason: 'no usable commit SHA reported' };
  const s = reported.trim().toLowerCase();
  const resolveCommit = x => { try { return git(['rev-parse', '--verify', '--quiet', `${x}^{commit}`]).trim() || null; } catch { return null; } };
  let full = resolveCommit(s);
  if (!full) { try { git(['fetch', '--quiet', remote, s]); } catch { /* the host may refuse a fetch by SHA */ } full = resolveCommit(s); }
  if (!full) return { status: 'unknown-commit', sha: s.slice(0, 12) };
  if (full === defaultSha) return { status: 'same', sha: full.slice(0, 12) };
  let isAncestor = false;
  try { git(['merge-base', '--is-ancestor', full, defaultSha]); isAncestor = true; } catch { /* not an ancestor */ }
  if (isAncestor) {
    let behind = null; try { behind = Number(git(['rev-list', '--count', `${full}..${defaultSha}`]).trim()); } catch { /* count is informational */ }
    return { status: 'behind', sha: full.slice(0, 12), behindBy: behind };
  }
  let only = null, subjects = [], branches = [];
  try { only = Number(git(['rev-list', '--count', `${defaultSha}..${full}`]).trim()); } catch { /* informational */ }
  try { subjects = git(['log', '--format=%s', '-n', '5', `${defaultSha}..${full}`]).split(/\r?\n/).map(l => l.trim().slice(0, 100)).filter(Boolean); } catch { /* informational */ }
  try { branches = git(['branch', '-r', '--contains', full]).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.includes('->')).slice(0, 3); } catch { /* informational */ }
  return { status: 'unmerged', sha: full.slice(0, 12), onlyHere: only, subjects, branches };
}

const fetchHealth = (url, options) => fetch(url, { ...options, method: 'GET', redirect: 'error' });

export async function checkRunningRef(repo, {
  remote = 'origin', branch, readSha = readHealthSha, git = gitIn(repo),
  now = new Date().toISOString(), targets, azureTargetsFile, log = () => {}
} = {}) {
  git = withoutReplacements(git);
  const def = resolveRemoteDefault(git, remote, branch);
  const { envs, names, classes, declared, omitted } = probePlan(shaReader(git, def.sha), targets, azureTargetsFile);
  if (!names.length) return { configured: false, verdict: 'not-configured', blocking: false, at: now, envs: [] };

  const results = [];
  const prdProbes = [];
  for (const name of names) {
    const { health } = envs[name];
    const kind = classes.get(name);
    if (isProtectedClass(kind)) {
      const suffix = kind === 'conflict' ? ' (classification conflict)' : '';
      const line = `prd read-only probe: ${name} ${health.url} at ${new Date().toISOString()}, user-approved full check${suffix}`;
      prdProbes.push(line);
      log(line);
    }
    let response;
    try { response = await readSha(health, fetchHealth); }
    catch { results.push({ name, status: 'unverified', reason: 'health endpoint not reachable' }); continue; }
    if (!response?.ok) {
      results.push({ name, status: 'unverified', reason: `health endpoint answered ${response?.status ?? 'an error'}` });
      continue;
    }
    results.push({ name, ...classifyRunning(response.sha, def.sha, git, { remote }) });
  }
  const blocking = results.some(r => BLOCKING.has(r.status));
  const verdict = blocking ? 'blocking-drift' : results.some(r => r.status === 'unverified') ? 'unverified' : 'ok';
  const result = {
    configured: true, verdict, blocking, at: now, remote, branch: def.branch, base: def.sha, envs: results
  };
  if (prdProbes.length) result.prdProbes = prdProbes;
  if (targets !== undefined) Object.assign(result, {
    targets: names, selected: true, declared, omitted, omittedProd: omitted,
    defaultBranch: def.branch, defaultSha: def.sha,
    omittedProdLine: `prod targets omitted by scope (azure-targets.json): ${omitted.join(', ') || 'none'}; default branch ${def.branch}@${def.sha.slice(0, 12)} via ls-remote`
  });
  return result;
}

export function recordRunningRef(repo, runId, result, { keyFile } = {}) {
  return writeSignedRecord(repo, runId, { ...result, resolved: null }, { keyFile, create: true });
}

const label = r => r.status === 'unmerged'
  ? `${r.name} runs ${r.sha}, ${r.onlyHere ?? 'some'} commit(s) that are not on the default branch`
  : `${r.name} runs ${r.sha}, a commit that is on no branch of this repository`;

// The question card the Architect asks (questions.mjs ask --file). One question, three fixed options, no free text.
export function buildCard(record) {
  const bad = (record?.envs || []).filter(r => BLOCKING.has(r.status));
  if (!bad.length) throw new Error('NO_BLOCKING_DRIFT: nothing to ask');
  const names = bad.map(r => r.name).join(', ');
  const detail = bad.map(label).join('; ');
  return { questions: [{
    id: CARD_QUESTION_ID, header: 'Running code', multiSelect: false,
    question: `${names} ${bad.length > 1 ? 'run' : 'runs'} code that is not on ${record.remote}/${record.branch} (${detail}). How should this task proceed?`.slice(0, 399).replace(/[.?!]*$/, '') + '?',
    options: [
      { id: 'a', label: `Base on ${record.branch}, leave ${names.length > 18 ? 'those environments' : names} alone`.slice(0, 60), description: `The task is cut from ${record.branch}. Deploying it to ${names} is refused, so the running code is not replaced.` },
      { id: 'b', label: 'Stop: bring that code into the repo first', description: 'This task ends. A separate task merges or promotes the running code so the repository matches what runs.' },
      { id: 'c', label: `Base on ${record.branch} and accept replacing it`.slice(0, 60), description: `The task is cut from ${record.branch}; a later deploy may replace what ${names} runs. Code that exists only there is lost from it.` }
    ],
    recommended: 'a',
    why: 'Nothing running is overwritten and nothing is built on a base that lacks the live code.'
  }] };
}

// Turns an answered (or assumed, unattended) card into the recorded resolution.
export function resolveRunningRef(repo, runId, setId, { now = new Date().toISOString(), keyFile } = {}) {
  const rec = readVerifiedRecord(repo, runId, { keyFile });
  if (!rec) throw new Error('RUNNING_REF_NOT_CHECKED: run `running-ref.mjs check --run <id>` first');
  if (!rec.blocking) throw new Error('NOTHING_TO_RESOLVE: the check found no blocking drift');
  const set = readSets(repo, runId).find(s => s.id === setId);
  if (!set) throw new Error(`SET_UNKNOWN: ${setId}`);
  if (!['answered', 'assumed'].includes(set.status)) throw new Error(`SET_NOT_ANSWERED: ${setId} is ${set.status}; the run stays stopped until the user answers`);
  if (!set.card?.questions?.some(q => q.id === CARD_QUESTION_ID)) throw new Error(`SET_NOT_RUNNING_REF: ${setId} is not the card from running-ref.mjs card`);
  const answer = set.answers?.[CARD_QUESTION_ID];
  const choice = CHOICES[answer];
  if (!choice) throw new Error('ANSWER_INVALID: not an option of the running-ref card');
  const envs = rec.envs.filter(r => BLOCKING.has(r.status)).map(r => r.name);
  const shas = Object.fromEntries(rec.envs.filter(r => BLOCKING.has(r.status)).map(r => [r.name, r.sha]));
  rec.resolved = { choice, set: setId, via: set.status === 'assumed' ? 'assumed (unattended)' : (set.answeredVia || 'card'), at: now, envs, shas };
  writeSignedRecord(repo, runId, rec, { keyFile });
  return rec.resolved;
}

function uncheckedEnvironmentsReason(repo, git, rec) {
  const reason = rec ? 'the recorded check found no environments. Run the check again' : SIGNATURE_REASON;
  try { git(['remote', 'get-url', 'origin']); }
  catch {
    let remotes;
    try { remotes = git(['remote']).trim(); } catch { /* cannot establish a local-only repo */ }
    if (remotes === '') return environmentsConfigured(repo) ? reason : null;
    throw new Error('RUNNING_REF_REMOTE_UNREADABLE: could not resolve origin or establish that the repo has no remotes');
  }
  const { sha, branch } = resolveRemoteDefault(git);
  const declared = Object.keys(loadEnvironments(repo, { read: shaReader(git, sha) })).length > 0;
  if (declared) return reason;
  if (environmentsConfigured(repo)) {
    return `environments are declared only in the working tree, not on origin/${branch}: push them (merge) first, then run the check again`;
  }
  return null;
}

function requireCurrentDefault(sha, branch, def) {
  if (sha !== def.sha || branch !== def.branch) {
    throw new Error(`the remote default is now ${def.branch}@${def.sha.slice(0, 12)}. Run the check again`);
  }
}

function checkSelectedRecord(rec, git, azureTargetsFile) {
  const selected = rec.targets;
  if (!Array.isArray(selected) || !selected.length || selected.some(name => typeof name !== 'string' || !name) ||
      new Set(selected).size !== selected.length || !Array.isArray(rec.envs)) {
    throw new Error('running-ref record has an invalid selection. Run the check again');
  }
  const def = resolveRemoteDefault(git);
  probePlan(shaReader(git, def.sha), selected, azureTargetsFile);
  requireCurrentDefault(rec.defaultSha, rec.defaultBranch, def);
  const probed = rec.envs.map(e => e?.name);
  if (rec.base !== def.sha || probed.length !== selected.length || selected.some(name => !probed.includes(name))) {
    throw new Error('running-ref record is inconsistent with its selected targets or base. Run the check again');
  }
}

export function runningRefReason(repo, runId, { git = gitIn(repo), keyFile, azureTargetsFile } = {}) {
  if (!validRunId(runId)) return null;
  git = withoutReplacements(git);
  try {
    const rec = readVerifiedRecord(repo, runId, { keyFile });
    if (!rec || rec.configured === false) return uncheckedEnvironmentsReason(repo, git, rec);
    if (rec.selected === true) checkSelectedRecord(rec, git, azureTargetsFile);
    else if (['selected', 'targets', 'omitted', 'defaultSha'].some(key => Object.hasOwn(rec, key))) {
      return 'running-ref record carries selection data without a valid selected flag. Run the check again';
    } else {
      requireCurrentDefault(rec.base, rec.branch, resolveRemoteDefault(git));
    }
    const known = new Set(['same', 'behind', 'unverified', ...BLOCKING]);
    if (!Array.isArray(rec.envs) || rec.envs.some(e => !known.has(e?.status))) {
      return 'running-ref record has a probe result with an unknown status. Run the check again';
    }
    const choice = rec.resolved?.choice;
    if (choice === 'stop') return 'the user chose to stop until the running code is brought into the repository: record the base gate as blocked and end the run';
    if ((rec.blocking || rec.envs.some(e => BLOCKING.has(e.status))) && !Object.values(CHOICES).includes(choice)) {
      return 'an environment runs code that is not on the default branch: ask the card (`running-ref.mjs card`, then `questions.mjs ask`), end the turn, and record the answer with `running-ref.mjs resolve`';
    }
    return null;
  } catch (error) { return error.message; }
}

export async function main([cmd, ...argv], {
  keyFile, azureTargetsFile, readSha, git,
  out = value => process.stdout.write(value), err = value => process.stderr.write(value)
} = {}) {
  const opt = n => {
    const flag = `--${n}`;
    const i = argv.findIndex(arg => arg === flag || arg.startsWith(`${flag}=`));
    if (i < 0) return undefined;
    return argv[i] === flag ? (argv[i + 1]?.startsWith('--') ? '' : argv[i + 1] ?? '') : argv[i].slice(flag.length + 1);
  };
  const repo = resolve(opt('repo') || '.');
  const runId = opt('run');
  const json = value => out(`${JSON.stringify(value, null, 2)}\n`);
  const report = line => err(`RUNNING-REF: ${line}\n`);
  try {
    if (opt('include-prod') !== undefined) {
      throw new Error('RUNNING_REF_INCLUDE_PROD_REFUSED: --include-prod is never supported; the full check already probes prd read-only at /health, /api/health or /build-info');
    }
    if (cmd === 'check') {
      const targetFlags = argv.flatMap((arg, i) => {
        if (arg.startsWith('--target=')) return [arg.slice('--target='.length)];
        if (arg !== '--target') return [];
        const value = argv[i + 1];
        return [value && !value.startsWith('--') ? value : ''];
      });
      const targets = targetFlags.length ? targetFlags.flatMap(value => value.split(',')) : process.env.RUNNING_REF_TARGETS?.split(',');
      if (runId !== undefined) {
        if (!validRunId(runId)) throw new Error('RUN_ID_INVALID');
        loadRunningRefKey({ keyFile, create: true });
      }
      const result = await checkRunningRef(repo, {
        remote: opt('remote'), branch: opt('default'), targets, azureTargetsFile, readSha, git, log: report
      });
      if (result.omittedProdLine) report(result.omittedProdLine);
      for (const r of result.envs) report(`${r.name}: ${r.status}${r.status === 'unmerged' ? ` (${r.onlyHere ?? '?'} commit(s) only there)` : r.status === 'behind' ? ` (default is ${r.behindBy ?? '?'} ahead)` : r.reason ? ` (${r.reason})` : ''}`);
      json(runId ? recordRunningRef(repo, runId, result, { keyFile }) : result);
      return result.blocking ? 2 : 0;
    }
    if (cmd === 'card') {
      const rec = readVerifiedRecord(repo, runId, { keyFile });
      if (!rec) throw new Error(`RUNNING_REF_NOT_CHECKED: ${SIGNATURE_REASON}`);
      json(buildCard(rec));
    } else if (cmd === 'resolve') json(resolveRunningRef(repo, runId, opt('set'), { keyFile }));
    else if (cmd === 'show') json(readRecord(repo, runId));
    else throw new Error('USAGE: check|card|resolve|show');
    return 0;
  } catch (error) { report(error.message); return 3; }
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
