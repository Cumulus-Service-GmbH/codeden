#!/usr/bin/env node
// TrioHarness Lean — selftest: a dress rehearsal of what an agent really does, run against THIS installed copy.
// Run it after every install (and before every release): node selftest.mjs   (exit 0 = every check passed or was skipped)
// It never touches a real repository or a real secret: everything happens in temp folders; on macOS it also does one
// round trip in a private temporary Keychain. The scripts are run through a SYMLINKED path on purpose.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, chmodSync, symlinkSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform as osPlatform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { findSecrets } from './secret-patterns.mjs';
import { hiddenPrompt } from './secret-store.mjs';
import { promptLabel, runCli } from './secrets.mjs';
import { withSelftestKeychain } from './selftest-keychain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, '..');

export function runSelftest({ platform = osPlatform(), skillDir = SKILL } = {}) {
  const results = [];
  const rec = (name, status, detail = '') => results.push({ name, status, detail: String(detail).slice(0, 300) });
  const check = (name, fn) => { try { const d = fn(); if (d === 'SKIP') rec(name, 'SKIP'); else rec(name, 'PASS', typeof d === 'string' ? d : ''); } catch (e) { rec(name, 'FAIL', e.message); } };
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };

  const T = mkdtempSync(join(tmpdir(), 'thl-selftest-'));
  const scripts = join(T, 'scripts-link');           // a symlink to the real scripts folder: what macOS /tmp looks like
  symlinkSync(join(skillDir, 'scripts'), scripts);
  const node = process.execPath;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME || T, TRIOHARNESS_HOME: join(T, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', TRIOHARNESS_AGENT: '1', ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) };
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env, ...opts });
  const sh = (name, args, opts) => run(node, [join(scripts, name), ...args], opts);
  const git = (cwd, ...a) => run('git', ['-C', cwd, ...a]);
  const secrets = (args, kc, value = '') => {
    if (!kc) throw new Error('selftest requires an explicit Keychain backend');
    let stdout = '', stderr = '';
    const io = {
      stdin: () => value + '\n',
      stdout: text => { stdout += text; },
      stderr: text => { stderr += text; }
    };
    const status = runCli(args, io, { kc, platform, env });
    must(status === 0, `${args[0]} exited ${status}`);
    must(!value || !(stdout + stderr).includes(value), `${args[0]} leaked the test value`);
    return stdout;
  };

  check('node version', () => { const [maj] = process.versions.node.split('.').map(Number); must(maj >= 20, `node ${process.versions.node} is too old (need 20+)`); return process.versions.node; });
  check('git available', () => { const r = run('git', ['--version']); must(r.status === 0, 'git missing'); return r.stdout.trim(); });

  // 1. scanner through a symlinked path: must really run
  check('guard --scan works through a symlinked path', () => {
    const clean = join(T, 'clean.txt'), dirty = join(T, 'dirty.txt'); writeFileSync(clean, 'only names here\n'); writeFileSync(dirty, ['password', '=', '"Zx9!kQ2mPpL4vR8sTt"\n'].join(' '));
    must(sh('guard.mjs', ['--scan', clean]).status === 0, 'a clean file did not exit 0');
    const d = sh('guard.mjs', ['--scan', dirty]); must(d.status === 2 && /"hits"/.test(d.stdout), `a dirty file exited ${d.status}, expected 2 with a report`);
    const sent = join(T, 'sent'); const gated = sh('guard.mjs', ['--scan', dirty, '--', node, '-e', `require('fs').writeFileSync(${JSON.stringify(sent)},'x')`]);
    must(gated.status === 2 && !existsSync(sent), 'scan-before-send started the command after a flagged scan');
  });

  // 2. a scratch repo with the real hook
  const bare = join(T, 'bare.git'), repo = join(T, 'repo');
  check('scratch repo with the real pre-push hook', () => {
    must(run('git', ['init', '--quiet', '--bare', bare]).status === 0, 'git init --bare failed');
    mkdirSync(repo); git(repo, 'init', '--quiet', '--initial-branch=main'); git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 'T');
    git(repo, 'remote', 'add', 'origin', bare); writeFileSync(join(repo, 'README.md'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'init'); git(repo, 'push', '--quiet', 'origin', 'main');
    const hook = join(repo, '.git', 'hooks', 'pre-push'); copyFileSync(join(skillDir, 'templates', 'repo', 'pre-push'), hook); chmodSync(hook, 0o755);
  });

  check('secrets: declare keychain, file and Key Vault entries; status; manifest is scanner-clean', () => {
    const noKeychain = { available: () => false };
    for (const [n, extra] of [['SELFTEST_KEYCHAIN', []], ['SELFTEST_FILE', ['--store', 'file']], ['SELFTEST_KV', ['--keyvault', 'kv-abc123/Some-Secret-Name1', '--env', 'prd']]]) {
      secrets(['declare', '--repo', repo, '--name', n, '--purpose', 'selftest', ...extra], noKeychain);
    }
    must(/SELFTEST_KV/.test(secrets(['status', '--repo', repo], noKeychain)), 'status did not list the Key Vault entry');
    const text = readFileSync(join(repo, '.trioharness', 'secrets.json'), 'utf8'); must(findSecrets(text).length === 0, 'the manifest is flagged by the secret scan');
  });

  check('template files + manifest pass guard, push on a task branch, main is refused', () => {
    git(repo, 'switch', '--quiet', '-c', 'trio/selftest');
    copyFileSync(join(skillDir, 'templates', 'repo', 'AGENTS.md'), join(repo, 'AGENTS.md'));
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    copyFileSync(join(skillDir, 'templates', 'repo', 'github', 'pull_request_template.md'), join(repo, '.github', 'pull_request_template.md'));
    copyFileSync(join(skillDir, 'templates', 'repo', 'github', 'workflows', 'ci.yml'), join(repo, '.github', 'workflows', 'ci.yml'));
    copyFileSync(join(skillDir, 'templates', 'repo', 'environments.json'), join(repo, '.trioharness', 'environments.json'));
    git(repo, 'add', '-f', '.'); const c = git(repo, 'commit', '--quiet', '-m', 'bootstrap'); must(c.status === 0, `commit failed: ${c.stderr}`);
    const g = sh('guard.mjs', ['--repo', repo, '--base', 'main', '--owned', 'AGENTS.md,.trioharness/,.github/', '--allow-main-worktree', '--tier', 'standard']);
    must(g.status === 0, `guard exited ${g.status}: ${(g.stdout.match(/"rule": "[^"]+"/g) || []).join(', ') || g.stderr.split('\n')[0]}`);
    const p = git(repo, 'push', 'origin', 'trio/selftest'); must(p.status === 0, `push of a task branch failed: ${p.stderr.split('\n').slice(0, 3).join(' ')}`);
    const bad = git(repo, 'push', 'origin', 'HEAD:main'); must(bad.status !== 0, 'an agent push to main was NOT refused');
  });

  check('a secrets.json outside .trioharness is still refused by guard and hook', () => {
    git(repo, 'switch', '--quiet', '-c', 'trio/selftest-bad'); writeFileSync(join(repo, 'secrets.json'), '{}\n'); git(repo, 'add', '-f', '.'); git(repo, 'commit', '--quiet', '-m', 'bad');
    const p = git(repo, 'push', 'origin', 'trio/selftest-bad'); must(p.status !== 0, 'the hook let secrets.json through');
  });

  check('standing orders: add, apply-list, never-list refused', () => {
    const a = sh('standing-orders.mjs', ['add', '--repo', repo, '--topic', 'runningref', '--choice', 'a', '--reason', 'selftest', '--quote', 'selftest quote', '--scope', 'user']);
    must(a.status === 0, `add exited ${a.status}: ${a.stderr}`);
    must(/runningref/.test(sh('standing-orders.mjs', ['list', '--repo', repo]).stdout), 'list did not show the order');
    must(sh('standing-orders.mjs', ['add', '--repo', repo, '--topic', 'merge', '--choice', 'a', '--reason', 'x', '--quote', 'x', '--scope', 'user']).status !== 0, 'a merge order was accepted');
  });

  check('github-setup plan changes nothing', () => {
    const r = sh('github-setup.mjs', ['plan', '--repo', 'o/new-selftest', '--reference', 'o/ref']); must(r.status === 0 && /nothing was changed/.test(r.stdout), `exit ${r.status}: ${r.stderr}`);
  });

  check('masked dialog label is accepted by the dialog check', () => {
    const v = hiddenPrompt(promptLabel('E2E_PASSWORD', 'Cumulus-Service-GmbH/WebChatMobile'), { platform: 'darwin', exec: () => 'x\n' }); must(v === 'x', 'label rejected');
  });

  // 2.35: a repo whose default branch is not "main", and the deploy guard
  const bare2 = join(T, 'bare2.git'), repo3 = join(T, 'repo3');
  check('hook: a default branch called cumulus/main (upstream file names are not scanned)', () => {
    must(run('git', ['init', '--quiet', '--bare', bare2]).status === 0, 'git init --bare failed');
    git(bare2, 'symbolic-ref', 'HEAD', 'refs/heads/cumulus/main');
    mkdirSync(repo3); git(repo3, 'init', '--quiet'); git(repo3, 'config', 'user.email', 't@example.com'); git(repo3, 'config', 'user.name', 'T');
    git(repo3, 'checkout', '--quiet', '-b', 'cumulus/main');
    mkdirSync(join(repo3, 'cloud_agents'), { recursive: true }); writeFileSync(join(repo3, 'cloud_agents', 'credentials.rs'), 'pub fn creds() {}\n'); writeFileSync(join(repo3, 'README.md'), 'x\n');
    git(repo3, 'add', '.'); git(repo3, 'commit', '--quiet', '-m', 'upstream'); git(repo3, 'remote', 'add', 'origin', bare2); git(repo3, 'push', '--quiet', 'origin', 'cumulus/main');
    git(repo3, 'remote', 'set-head', 'origin', 'cumulus/main');
    const hook = join(repo3, '.git', 'hooks', 'pre-push'); copyFileSync(join(skillDir, 'templates', 'repo', 'pre-push'), hook); chmodSync(hook, 0o755);
    git(repo3, 'switch', '--quiet', '-c', 'trio/ok'); writeFileSync(join(repo3, 'a.txt'), 'a\n'); git(repo3, 'add', '.'); git(repo3, 'commit', '--quiet', '-m', 'clean');
    const p = git(repo3, 'push', 'origin', 'trio/ok'); must(p.status === 0, `a clean task branch was refused: ${p.stderr.split('\n').slice(0, 3).join(' ')}`);
    git(repo3, 'switch', '--quiet', '-c', 'trio/bad'); writeFileSync(join(repo3, '.env'), 'A=1\n'); git(repo3, 'add', '-f', '.'); git(repo3, 'commit', '--quiet', '-m', 'bad');
    must(git(repo3, 'push', 'origin', 'trio/bad').status !== 0, 'a credential file was let through');
  });

  const deployJson = JSON.stringify({ schema: 1, targets: { qa: { subscription: 's', resourceGroup: 'rg', app: 'app-qa', outputDir: 'out', build: [{ command: 'node', args: ['-e', '0'] }], health: { url: 'http://127.0.0.1:1/health', shaField: 'sha', timeoutSeconds: 1 }, agentAllowed: true } } });
  check('deploy guard: an unreadable running commit stops the deploy', () => {
    git(repo3, 'switch', '--quiet', 'cumulus/main'); mkdirSync(join(repo3, '.trioharness'), { recursive: true }); writeFileSync(join(repo3, '.trioharness', 'deploy.json'), deployJson);
    git(repo3, 'add', '-f', '.'); git(repo3, 'commit', '--quiet', '-m', 'deploy config'); git(repo3, 'push', '--quiet', '--no-verify', 'origin', 'cumulus/main'); // scaffolding in a scratch repo: stands in for the merged PR
    const r = sh('deploy.mjs', ['--repo', repo3, '--target', 'qa', '--dry-run', '--live-retry-ms', '1']);
    must(r.status === 2 && /RUNNING_REF_UNREADABLE/.test(r.stderr), `exit ${r.status}, expected 2 with RUNNING_REF_UNREADABLE: ${r.stderr.split('\n')[0]}`);
  });
  check('deploy guard: targets come from the default branch, not the working tree', () => {
    const j = JSON.parse(deployJson); j.targets.evil = j.targets.qa; writeFileSync(join(repo3, '.trioharness', 'deploy.json'), JSON.stringify(j));
    const r = sh('deploy.mjs', ['--repo', repo3, '--target', 'evil', '--dry-run', '--live-retry-ms', '1']);
    must(r.status === 2 && /UNKNOWN_TARGET/.test(r.stderr), `exit ${r.status}, expected 2 with UNKNOWN_TARGET: ${r.stderr.split('\n')[0]}`);
  });

  // 2.36: verified merge, autopilot and the GitHub switch, exactly as an agent runs them
  check('verified merge: ruleset JSON, install into a scratch repo, the INSTALLED check script runs', () => {
    const r = sh('merge-verify.mjs', ['ruleset']); must(r.status === 0, `ruleset exited ${r.status}: ${r.stderr.split('\n')[0]}`);
    const rs = JSON.parse(r.stdout); must(rs.rules.some(x => x.type === 'required_status_checks' && x.parameters.required_status_checks[0].context === 'merge-verify'), 'the ruleset does not require merge-verify');
    const repo = join(T, 'mv-repo'); mkdirSync(repo, { recursive: true });
    const i = sh('merge-verify.mjs', ['install', '--repo', repo]); must(i.status === 0, `install exited ${i.status}: ${i.stderr.split('\n')[0]}`);
    for (const f of ['.github/merge-verify/merge-verify.mjs', '.github/merge-verify/secret-patterns.mjs', '.github/merge-verify/is-main.mjs', '.github/workflows/merge-verify.yml', '.trioharness/merge-policy.json']) must(existsSync(join(repo, f)), `${f} was not written`);
    const again = run(node, [join(repo, '.github', 'merge-verify', 'merge-verify.mjs'), 'ruleset']); must(again.status === 0 && JSON.parse(again.stdout).name === 'Verified merge', 'the copy that CI runs does not start on its own');
    const bad = sh('merge-verify.mjs', ['check', '--repo', 'o/r']); must(bad.status === 1, 'check without --pr must be a usage error');
  });
  check('autopilot: a routine card is answered, a gate is parked, promote makes ONE final card', () => {
    const repo = join(T, 'ap-repo'); mkdirSync(repo, { recursive: true }); const id = '20261028-selftest-ab12';
    const card = (q, h, text) => ({ questions: [{ id: q, header: h, question: text, why: 'The smaller, reversible choice', options: [{ id: 'a', label: 'Option A', description: 'the first choice' }, { id: 'b', label: 'Option B', description: 'the second choice' }], recommended: 'a' }] });
    const ask = (name, c) => { const f = join(T, `${name}.json`); writeFileSync(f, JSON.stringify(c)); return sh('questions.mjs', ['ask', '--repo', repo, '--run', id, '--file', f]); };
    must(sh('questions.mjs', ['autopilot', '--repo', repo, '--run', id, '--on']).status === 3, 'autopilot --on without the user\'s quote must be refused');
    must(sh('questions.mjs', ['autopilot', '--repo', repo, '--run', id, '--on', '--quote', 'selftest: autopilot please']).status === 0, 'autopilot --on with a quote failed');
    const e = ask('routine', card('e1', 'Scope', 'Which scope should the change cover?')); must(e.status === 0 && JSON.parse(e.stdout).status === 'assumed', `routine card: ${e.stderr.split('\n')[0]}`);
    const g = ask('gate', card('g1', 'Deploy', 'Deploy this build to the production app?')); must(g.status === 0 && JSON.parse(g.stdout).status === 'deferred', `gate card: ${g.stderr.split('\n')[0]}`);
    must(sh('questions.mjs', ['check', '--repo', repo, '--run', id]).status === 0, 'a parked gate must not stop the run');
    const p = sh('questions.mjs', ['promote', '--repo', repo, '--run', id]); must(p.status === 0 && JSON.parse(p.stdout).status === 'open', `promote: ${p.stderr.split('\n')[0]}`);
    must(sh('questions.mjs', ['check', '--repo', repo, '--run', id]).status === 2, 'the final approval card must be open');
  });
  check('github switch: refuses without proof and writes nothing (gh stubbed)', () => {
    if (platform === 'win32') return 'SKIP';
    const bin = join(T, 'bin'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\ncase "$*" in\n "api repos/o/r") echo \'{"default_branch":"main","private":true}\';;\n "api repos/o/r/rulesets") echo \'[]\';;\n "api repos/o/r/pulls?state=all&per_page=15") echo \'[]\';;\n *) exit 1;;\nesac\n'); chmodSync(join(bin, 'gh'), 0o755);
    const r = run(node, [join(scripts, 'github-setup.mjs'), 'verified-merge', '--repo', 'o/r', '--confirm'], { env: { ...env, PATH: `${bin}:${env.PATH}` } });
    must(r.status === 2, `exit ${r.status}, expected 2: ${r.stderr.split('\n')[0]}`);
    const out = JSON.parse(r.stdout); must(out.blocked.some(b => b.id === 'policy') && out.blocked.some(b => b.id === 'proof') && out.done.length === 0, 'it must be blocked on policy and proof and change nothing');
  });

  check('every script named in the docs exists', () => {
    const files = []; const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.(md|json|yml|txt)$|pre-push$/.test(f) && files.push(p); } };
    walk(skillDir); const missing = new Set();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/scripts\/([a-z0-9-]+\.mjs)/g)) if (!existsSync(join(skillDir, 'scripts', m[1]))) missing.add(`${m[1]} (in ${f.slice(skillDir.length + 1)})`);
    must(!missing.size, `missing: ${[...missing].join(', ')}`);
  });

  const keychainCheck = (name, exercise) => {
    let result;
    check(name, () => {
      result = withSelftestKeychain({ platform }, exercise);
      return result.skip ? 'SKIP' : undefined;
    });
    if (result?.skip) results.at(-1).detail = result.skip;
  };

  keychainCheck('macOS Keychain round trip in a temporary Keychain', kc => {
    const value = 'selftest-roundtrip-value';
    kc.set('trioharness-selftest', 'selftest', value);
    must(kc.get('trioharness-selftest', 'selftest') === value, 'read-back did not match');
    must(kc.delete('trioharness-selftest', 'selftest'), 'item was not deleted');
    must(kc.get('trioharness-selftest', 'selftest') === null, 'item still exists after deletion');
  });

  keychainCheck('macOS: secrets set --stdin, status, require and forget in a temporary Keychain', kc => {
    const repo = join(T, 'repo2');
    mkdirSync(repo);
    git(repo, 'init', '--quiet', '--initial-branch=main');
    git(repo, 'remote', 'add', 'origin', `https://github.com/selftest/selftest-${process.pid}.git`);
    const value = 'selftest-value-12345';
    const cli = (command, ...args) => secrets([command, '--repo', repo, ...args], kc, value);
    const name = 'SELFTEST_VALUE';
    cli('declare', '--name', name, '--purpose', 'selftest', '--env', 'dev', '--store', 'keychain');
    cli('set', '--name', name, '--stdin');
    must(/\bset \(keychain\)/.test(cli('status', '--check')), 'status did not show the item as set');
    cli('require', '--need', name, '--scope', 'proof', '--role', 'architect', '--', node, '-e',
      'process.exit(process.env.SELFTEST_VALUE ? 0 : 9)');
    must(/removed from the Keychain/.test(cli('forget', '--name', name)), 'forget did not remove the item');
  });

  try { rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
  const failed = results.filter(r => r.status === 'FAIL');
  return { results, failed: failed.length, passed: results.filter(r => r.status === 'PASS').length, skipped: results.filter(r => r.status === 'SKIP').length };
}

if (isMain(import.meta.url)) {
  const r = runSelftest();
  for (const x of r.results) process.stdout.write(`${x.status === 'PASS' ? 'PASS' : x.status === 'SKIP' ? 'SKIP' : 'FAIL'}  ${x.name}${x.detail ? `  — ${x.detail}` : ''}\n`);
  process.stdout.write(`SELFTEST: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped\n`);
  process.exitCode = r.failed ? 1 : 0;
}
