import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { countDispatch, readState, registerWorker, reserveReviewLaunch, finishWorker } from './run-state.mjs';
import { loadTeam, loadTeamPolicy } from './team.mjs';
import { exportedTeam } from '../../../../.config/trioharness/team-export.mjs';

const launcher = fileURLToPath(new URL('./invoke-lane.mjs', import.meta.url));
const fixtureRoots = [];
const newFixtureRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'invoke-lane-'));
  fixtureRoots.push(root);
  return root;
};
after(() => {
  for (const root of fixtureRoots) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
const policy = loadTeamPolicy();
const laneHome = Object.fromEntries(['claude', 'gpt', 'missing-writer', 'gpt-no-writer', 'other-writer'].map(engine => {
  const root = newFixtureRoot();
  const config = join(root, '.config', 'trioharness');
  mkdirSync(config, { recursive: true });
  const gpt = engine.startsWith('gpt');
  const team = [
    ...(['missing-writer', 'gpt-no-writer'].includes(engine) ? [] : [{ role: 'writer', provider: gpt ? 'claude' : 'codex', model: 'settings-writer', effort: 'medium' }]),
    { role: 'planReviewer', provider: gpt ? 'codex' : 'claude', model: 'settings-plan', effort: 'high' },
    { role: 'reviewer', provider: engine === 'other-writer' ? 'codex' : 'agy', model: 'settings-primary', effort: 'high' },
    { role: 'reviewerFallback', provider: gpt ? 'codex' : 'claude', model: 'settings-review', effort: 'high' },
  ];
  writeFileSync(join(config, 'team.json'), JSON.stringify(exportedTeam({ team, sources: Object.fromEntries(team.map(({ role }) => [role, 'default'])) })));
  const { arbiterLimits, ...fixturePolicy } = structuredClone(policy);
  writeFileSync(join(config, 'team-policy.json'), JSON.stringify(fixturePolicy));
  writeFileSync(join(config, 'team-sync.mjs'), '');
  return [engine, root];
}));
const TEAM_CLAUDE_REVIEW_MODEL = loadTeam(join(laneHome.claude, '.config', 'trioharness', 'team.json')).roles.codeReviewer.fallback.codex[0].model;
const laneEnv = (env, engine) => ({ ...env, TEAM_FILE: '', TRIOHARNESS_TEAM_HOME: laneHome[engine] ?? laneHome.claude });
const git = (repo, ...args) => {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const makeRepo = ({ featureCommit = false, dirty = false } = {}) => {
  const root = newFixtureRoot();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file.txt'), 'TOKEN\n', 'utf8');
  git(repo, 'add', 'file.txt');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', base);
  if (featureCommit || dirty) writeFileSync(join(repo, 'file.txt'), 'TOKEN SENTINEL\n', 'utf8');
  if (featureCommit) {
    git(repo, 'add', 'file.txt');
    git(repo, 'commit', '-qm', 'feature');
  }
  return { root, repo, base, head: git(repo, 'rev-parse', 'HEAD') };
};
const makeSiblingRepo = root => {
  const repo = join(root, 'sibling');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file.txt'), 'SIBLING\n', 'utf8');
  git(repo, 'add', 'file.txt');
  git(repo, 'commit', '-qm', 'base');
  return repo;
};
const runRootOutput = (repo, name = 'review.json') => {
  const output = join(dirname(repo), '.trioharness-direct', 'runs', 'test-run', name);
  mkdirSync(dirname(output), { recursive: true });
  return output;
};
const promotionLockOwner = repo => {
  const worktreeRoot = resolve(git(repo, 'rev-parse', '--show-toplevel'));
  const repositoryGitCommonDir = resolve(worktreeRoot, git(repo, 'rev-parse', '--git-common-dir'));
  const key = createHash('sha256').update(JSON.stringify({ repositoryGitCommonDir, worktreeRoot })).digest('hex');
  return { schema: 1, repositoryGitCommonDir, worktreeRoot, key };
};
const promotionLockPath = (output, repo) => join(dirname(output), `PROMOTION_LOCK.${promotionLockOwner(repo).key}.json`);
const promotionLockPaths = output => readdirSync(dirname(output)).filter(name => /^PROMOTION_LOCK(?:\.[0-9a-f]{64})?\.json$/.test(name));
const hasPromotionLock = output => promotionLockPaths(output).length > 0;
const readPromotionLock = (output, repo) => JSON.parse(readFileSync(promotionLockPath(output, repo), 'utf8'));
const launchArgs = args => {
  const role = args[args.indexOf('--role') + 1];
  if (!role.startsWith('reviewer') || args.includes('--brief')) return args;
  return [...args, '--brief', args[args.indexOf('--prompt') + 1]];
};
const runLauncher = (args, env = process.env, engine = args[args.indexOf('--review-engine') + 1]) => spawnSync(process.execPath, [launcher, ...launchArgs(args)], {
  encoding: 'utf8', windowsHide: true, env: laneEnv(env, engine), timeout: 30000
});
const writePrompt = (repo, text, name = 'prompt.txt') => {
  const path = join(dirname(repo), name);
  writeFileSync(path, text, 'utf8');
  return path;
};
const jsonLine = value => JSON.stringify(value);
const reviewText = ({ decision = 'CLEAN', protectedState = 'VERIFIED', summary = 'HIGH: 0; MEDIUM: 0; LOW: 0; OUT_OF_SCOPE_RISK: 0', finding = 'NONE' } = {}) => `REVIEW_DECISION: ${decision}
REVIEW_SCOPE: PR_DIFF
PROTECTED_BEHAVIOR_DISPOSITION:
- PB-1 ${protectedState} — file.txt TOKEN
CORRECTION_DELTA_DISPOSITION:
- file.txt REVIEWED — exact candidate bytes inspected
MATERIAL_FINDINGS:
- ${finding}
NON_FINDINGS:
- REV-1 covered
ROUND_SUMMARY:
- ${summary}
RUNTIME_ASSERTION:
- runtime record inspected`;
const runtimeInit = (overrides = {}) => ({
  type: 'system', subtype: 'init', model: TEAM_CLAUDE_REVIEW_MODEL, effort: 'high', apiKeySource: 'none',
  mcp_servers: [], plugins: [], custom_commands: [], hooks: [], ...overrides
});
const resultRecord = (result, overrides = {}) => ({
  type: 'result', subtype: 'success', is_error: false, model: TEAM_CLAUDE_REVIEW_MODEL, result, usage: { input_tokens: 10, output_tokens: 5 }, ...overrides
});
let mockBin;
const makeMockEnv = (repo, records, capturePath = join(dirname(repo), 'captured-stdin.txt')) => {
  if (process.platform !== 'win32') throw new Error('These native CLI fixtures require Windows; refusing to fall through to installed model CLIs.');
  const bin = mockBin || (mockBin = newFixtureRoot());
  if (!existsSync(join(bin, 'headroom.exe'))) {
    copyFileSync(process.execPath, join(bin, 'headroom.exe'));
    writeFileSync(join(bin, 'claude.cmd'), '@echo 2.1.257\r\n', 'utf8');
  const codexEntry = join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  mkdirSync(dirname(codexEntry), { recursive: true });
  writeFileSync(join(bin, 'codex.cmd'), '@rem mock\r\n', 'utf8');
  writeFileSync(codexEntry, `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const fs=require('fs');fs.writeFileSync(process.env.CAPTURE_PATH,s);const i=process.argv.indexOf('--output-last-message');if(i>=0)fs.writeFileSync(process.argv[i+1],process.env.MOCK_CODEX_OUTPUT||'');});`, 'utf8');
  }
  const gitPath = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/)[0];
  assert.ok(gitPath.endsWith('.exe'));
  return {
    ...process.env,
    PATH: [bin, dirname(gitPath), join(process.env.SystemRoot, 'System32')].join(';'),
    // Intercept only the native-node headroom stand-in, independent of cwd.
    NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(`if(process.execPath.toLowerCase().endsWith('headroom.exe')){const fs=await import('node:fs');const path=await import('node:path');const cp=await import('node:child_process');let s='';for await(const c of process.stdin)s+=c;const args=process.argv.slice(2);fs.writeFileSync(process.env.CAPTURE_PATH,s);fs.writeFileSync(process.env.CAPTURE_PATH+'.args.json',JSON.stringify(args));const exitCode=Number(process.env.MOCK_EXIT_CODE||'0');if(args.includes('codex')){const sibling=process.env.MOCK_OUT_OF_ROOT_REPO;const change=process.env.MOCK_OUT_OF_ROOT_CHANGE;if(sibling&&change){const file=path.join(sibling,'file.txt');if(change==='untracked')fs.writeFileSync(path.join(sibling,'outside.txt'),'OUTSIDE\\n');else{fs.appendFileSync(file,'CHANGED\\n');if(change==='staged'||change==='head'){cp.execFileSync('git',['add','file.txt'],{cwd:sibling});if(change==='head')cp.execFileSync('git',['commit','-qm','outside'],{cwd:sibling});}}}const outputIndex=args.indexOf('--output-last-message');if(outputIndex>=0)fs.writeFileSync(args[outputIndex+1],process.env.MOCK_CODEX_OUTPUT||'');if(process.env.MOCK_STREAM)process.stdout.write(process.env.MOCK_STREAM+'\\n');process.exit(exitCode)}fs.mkdirSync('.claude',{recursive:true});fs.writeFileSync('.claude/settings.local.json','{}');if(process.env.MOCK_DRIFT)fs.appendFileSync(path.join(process.env.MOCK_REPO,'file.txt'),'drift\\n');process.stdout.write(process.env.MOCK_STREAM+'\\n');process.exit(exitCode);}`).toString('base64')}`,
    MOCK_REPO: repo,
    CAPTURE_PATH: capturePath,
    MOCK_STREAM: records.join('\n')
  };
};
const reviewPrompt = ({ sha, local = false, extra = '' }) => {
  const impact = { 'REV-1': { callers: ['file.txt::SENTINEL'], consumers: ['file.txt::TOKEN'], dependencies: ['file.txt::TOKEN'], tests: ['file.txt::TOKEN'], invariant: 'SENTINEL invariant' } };
  return `CODE_REVIEW_TARGET: ${local ? 'LOCAL_PRECOMMIT' : '#1'}
${local ? 'FROZEN_LOCAL_ARTIFACT: fixture\n' : ''}CODE_REVIEW_MODE: PLAIN_TEXT_SAFE_MODE
FROZEN_SOURCE_SHA: ${sha}
REVIEW_CORRECTION_MODE: INVENTORY
REVIEW_KNOWN_FINDING_IDS_JSON: ["REV-1"]
REVIEW_CHANGED_PATHS_JSON: ["file.txt"]
REVIEW_IMPACT_MAP_JSON: ${JSON.stringify(impact)}
REVIEW_PROTECTED_BEHAVIORS_JSON: [{"id":"PB-1","invariant":"preserve","requiredSourceEvidence":["file.txt::TOKEN"],"requiredRegressionEvidence":["file.txt::TOKEN"]}]
${extra}`;
};
test('code review defaults to a cross-vendor fallback for Codex-written code', () => {
  const fx = makeRepo({ dirty: true });
  const output = runRootOutput(fx.repo);
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.base, local: true }));
  const result = runLauncher(['--role', 'reviewer', '--repo', fx.repo, '--output', output, '--prompt', prompt, '--dry-run', 'true']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /claude\/settings-review\(high\)/);
});

test('code review rejects stale caller evidence from source search', () => {
  const { repo, base } = makeRepo({ dirty: true });
  const output = runRootOutput(repo);
  const prompt = writePrompt(repo, reviewPrompt({ sha: base, local: true })
    .replace('file.txt::SENTINEL', 'file.txt::MISSING_CALLER'));
  const result = runLauncher(['--role', 'reviewer', '--repo', repo, '--output', output, '--prompt', prompt, '--dry-run', 'true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REVIEW_PACKET_STALE_EVIDENCE/);
  assert.equal(existsSync(output), false);
});

test('code review refuses a same-vendor fallback when no cross-vendor fallback is set', () => {
  const fx = makeRepo({ dirty: true });
  const output = runRootOutput(fx.repo);
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.base, local: true }));
  const args = ['--role', 'reviewer', '--writer', 'codex', '--repo', fx.repo, '--output', output, '--prompt', prompt, '--dry-run', 'true'];
  const result = spawnSync(process.execPath, [launcher, ...launchArgs(args)], { encoding: 'utf8', env: laneEnv(process.env, 'gpt'), timeout: 30000 });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /no cross-vendor reviewer.*codex/i);
});

test('review ledger does not impose an arbitrary round cap', () => {
  const fx = makeRepo({ dirty: true });
  const output = runRootOutput(fx.repo);
  const ledger = join(dirname(output), 'CODE_REVIEW_ROUNDS.jsonl');
  const rounds = Array.from({ length: 4 }, (_, round) => JSON.stringify({ status: 'completed', round })).join('\n') + '\n';
  writeFileSync(ledger, rounds);
  const base = reviewPrompt({ sha: fx.base, local: true });
  const args = ['--role', 'reviewer', '--repo', fx.repo, '--output', output, '--dry-run', 'true'];
  const passed = runLauncher([...args, '--prompt', writePrompt(fx.repo, base)]);
  assert.equal(passed.status, 0, passed.stderr + passed.stdout);
  assert.equal(readFileSync(ledger, 'utf8'), rounds);
  const obsolete = runLauncher([...args, '--prompt', writePrompt(fx.repo, base), '--closure-review', 'USER_APPROVED_POST_CAP_DELTA_ONLY']);
  assert.match(obsolete.stderr, /CODE_REVIEW_CLOSURE_OVERRIDE_OBSOLETE/);
});
const executorPrompt = ({ sha, gate = 'git diff --check', extra = '', guardRoots = [] }) => {
  const handoff = { 'TASK-1': { callers: 'caller', dependencies: 'Node/Git', risks: 'gate', invariant: 'preserve', verification: 'focused', noTouch: 'outside' } };
  const closure = { 'TASK-1': { callers: ['caller'], paths: ['file.txt'], dependencies: ['Node/Git'], risks: ['gate'], invariant: 'preserve', negativeProof: 'reject unsafe' } };
  return `FROZEN_SOURCE_SHA: ${sha}
EXECUTOR_SCOPE_LOCK: APPROVED
EXECUTOR_TASK_IDS_JSON: ["TASK-1"]
EXECUTOR_APPROVED_OWNED_PATHS_JSON: ["file.txt"]
EXECUTOR_HANDOFF_JSON: ${JSON.stringify(handoff)}
EXECUTOR_CALLER_CLOSURE_JSON: ${JSON.stringify(closure)}
EXECUTOR_PROTECTED_BEHAVIORS_JSON: [{"id":"GATES-PRESERVED","invariant":"preserve","requiredSourceEvidence":["file.txt::TOKEN"],"requiredRegressionEvidence":["file.txt::TOKEN"]}]
EXECUTOR_CORRECTION_MODE: INITIAL
GUARD_ROOTS_JSON: ${JSON.stringify(guardRoots)}
EXECUTOR_REQUIRED_GATES_JSON: ${JSON.stringify([gate])}
${extra}`;
};
const executorResult = `EXECUTOR_REMEDIATION_RESULT:
- TASK-1 FIXED — file.txt — focused proof
VERIFICATION_RUN:
- focused — passed
CROSS_IMPACT_CHECK:
- GATES-PRESERVED — preserved
CALLER_CLOSURE_RESULT:
- TASK-1 CALLERS: caller | PATHS: file.txt | DEPENDENCIES: Node/Git | RISKS: gate | PROOF: reject unsafe
SCOPE_ESCALATION:
- NONE`;
const fastPathResult = `FASTPATH_REMEDIATION_RESULT:
- TASK-1 FIXED — file.txt
FOCUSED_PROOF:
- npm test — passed
SCOPE_CONFIRMATION:
- PATHS: file.txt | HEAD: UNCHANGED | OWNED_ONLY: CONFIRMED
SCOPE_ESCALATION:
- NONE`;

test('required gates reject shell grammar, expansion, control characters, and output writes', () => {
  const unsafe = [
    'git diff --check | echo bad', 'git diff --check || echo bad', 'git diff --check && echo bad',
    'git diff --check $(echo bad)', 'git diff --check $HOME', 'git diff --check %PATH%',
    'git diff --check `echo bad`', 'git diff --check "x|y"', 'git diff --check\\ --output=owned',
    'git diff --check --output=owned', 'git diff --check\t--stat'
  ];
  const { repo, head } = makeRepo();
  for (const gate of unsafe) {
    const prompt = writePrompt(repo, executorPrompt({ sha: head, gate }));
    const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', join(dirname(repo), 'dry.json'), '--dry-run', 'true']);
    assert.notEqual(result.status, 0, `unsafe gate passed: ${gate}`);
  }
});

test('required gates accept ordinary quoted project paths', () => {
  const { repo, head } = makeRepo();
  mkdirSync(join(repo, 'dir with space'));
  writeFileSync(join(repo, 'dir with space', 'test.csproj'), '<Project />\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
  const prompt = writePrompt(repo, executorPrompt({ sha: git(repo, 'rev-parse', 'HEAD'), gate: 'dotnet test "dir with space/test.csproj" --no-restore' }));
  const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', join(dirname(repo), 'dry.json'), '--dry-run', 'true']);
  assert.equal(result.status, 0, result.stderr);
});

test('executor source evidence fails before launch or receipt mutation in dry-run and live preflight', async t => {
  for (const dryRun of [true, false]) for (const evidence of ['missing.txt::TOKEN', 'file.txt::MISSING']) {
    await t.test(`${dryRun ? 'dry' : 'live'} ${evidence}`, () => {
      const { repo, head } = makeRepo();
      const output = runRootOutput(repo, 'executor.json');
      const prompt = writePrompt(repo, executorPrompt({ sha: head }).replace('"requiredSourceEvidence":["file.txt::TOKEN"]', `"requiredSourceEvidence":["${evidence}"]`));
      const capture = join(dirname(repo), 'executor-stdin.txt');
      const env = makeMockEnv(repo, [], capture);
      env.MOCK_CODEX_OUTPUT = executorResult;
      writeFileSync(output, 'prior failed receipt\n');
      const before = readdirSync(dirname(output));
      const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output, ...(dryRun ? ['--dry-run', 'true'] : [])], env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /executor preflight protected-behavior evidence is incomplete/);
      assert.equal(existsSync(capture), false);
      assert.equal(readFileSync(output, 'utf8'), 'prior failed receipt\n');
      assert.deepEqual(readdirSync(dirname(output)), before);
      assert.equal(git(repo, 'status', '--porcelain'), '');
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    });
  }
});

test('executor source preflight permits regression evidence to be created by the writer', () => {
  const { repo, head } = makeRepo();
  const output = runRootOutput(repo, 'executor.json');
  const prompt = writePrompt(repo, executorPrompt({ sha: head }).replace('"requiredRegressionEvidence":["file.txt::TOKEN"]', '"requiredRegressionEvidence":["file.txt::NEW_REGRESSION"]'));
  const dry = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output, '--dry-run', 'true']);
  assert.equal(dry.status, 0, dry.stderr);
  const capture = join(dirname(repo), 'executor-stdin.txt');
  const env = makeMockEnv(repo, [], capture);
  env.MOCK_CODEX_OUTPUT = executorResult;
  const live = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', runRootOutput(repo, 'live.json')], env);
  assert.notEqual(live.status, 0);
  assert.ok(existsSync(capture));
  assert.match(live.stderr, /executor lane protected-behavior evidence is incomplete/);
});

test('two heartbeat lines preserve a live receipt byte-for-byte', () => {
  const { repo } = makeRepo();
  const output = join(dirname(repo), 'live.json');
  const original = 'LIVE RECEIPT\n';
  writeFileSync(output, original);
  writeFileSync(`${output}.heartbeat.jsonl`, `${jsonLine({ pid: process.pid, at: 'old' })}\n${jsonLine({ pid: process.pid, at: 'new' })}\n`);
  const prompt = writePrompt(repo, 'explore');
  const env = makeMockEnv(repo, []);
  const result = runLauncher(['--role', 'explorer', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LANE_ALREADY_RUNNING/);
  assert.equal(readFileSync(output, 'utf8'), original);
  assert.equal(readdirSync(dirname(repo)).some(name => name.includes('.interrupted-')), false);
});

for (const { name, home, writer, status, provider } of [
  { name: 'refuses a missing writer', home: 'missing-writer', status: 2 },
  { name: 'uses the explicit writer', home: 'gpt-no-writer', writer: 'claude', status: 0, provider: 'codex' },
  { name: 'uses the Team Writer', home: 'gpt', status: 0, provider: 'codex' },
]) {
  test(`review dry-run ${name}`, () => {
    const { repo, base } = makeRepo({ dirty: true });
    const output = runRootOutput(repo);
    const prompt = writePrompt(repo, reviewPrompt({ sha: base, local: true }));
    const args = ['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output, '--dry-run', 'true'];
    if (writer) args.push('--writer', writer);
    const result = runLauncher(args, process.env, home);
    assert.equal(result.status, status, result.stderr);
    if (provider) {
      const receipt = JSON.parse(readFileSync(output, 'utf8'));
      assert.match(receipt.primary, new RegExp(`^${provider}/`));
    } else assert.match(result.stderr, /TEAM_ROLE_UNSET: Set the Writer in Settings → Team.*--writer/);
  });
}

test('R13 review dry-run refuses a Claude fallback for a writer outside the Team Writer slot', () => {
  const { repo, base } = makeRepo({ dirty: true });
  const prompt = writePrompt(repo, reviewPrompt({ sha: base, local: true }));
  const result = runLauncher(['--role', 'reviewer', '--writer', 'agy', '--repo', repo, '--prompt', prompt,
    '--output', runRootOutput(repo), '--dry-run', 'true'], process.env, 'other-writer');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Claude reviews only code from the Team's Writer/);
});

test('review dry-run preserves an existing context and writes only sidecars', () => {
  const { repo, base } = makeRepo({ dirty: true });
  const output = runRootOutput(repo);
  writeFileSync(output, 'LIVE\n');
  writeFileSync(`${output}.review-context.json`, 'ORIGINAL CONTEXT\n');
  const prompt = writePrompt(repo, reviewPrompt({ sha: base, local: true }));
  const result = runLauncher(['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output, '--dry-run', 'true']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'LIVE\n');
  assert.equal(readFileSync(`${output}.review-context.json`, 'utf8'), 'ORIGINAL CONTEXT\n');
  assert.ok(existsSync(`${output}.dry-run.json`));
  const receipt = JSON.parse(readFileSync(`${output}.dry-run.json`, 'utf8'));
  assert.ok(receipt.promptBytes > receipt.sourcePacketBytes);
  const outsideRun = runLauncher(['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', join(dirname(repo), 'outside.json'), '--dry-run', 'true']);
  assert.match(outsideRun.stderr, /CODE_REVIEW_RUN_REQUIRED/);
  assert.notEqual(outsideRun.status, 0);
});

test('revalidation rejects legacy evidence without immutable prompt/context/blob identity', () => {
  const { repo, head } = makeRepo({ featureCommit: true });
  const output = runRootOutput(repo);
  const text = reviewText();
  writeFileSync(output, `${jsonLine(runtimeInit())}\n${jsonLine(resultRecord(text))}\n`);
  writeFileSync(`${output}.review-context.json`, '{"schema":1}\n');
  writeFileSync(`${output}.monitor.json`, JSON.stringify({ role: 'reviewer', output, exitCode: 0, timedOut: false, stderrBytes: 0, selectedReviewerEngine: `claude/${TEAM_CLAUDE_REVIEW_MODEL}(high)` }));
  const prompt = writePrompt(repo, reviewPrompt({ sha: head }));
  const before = readFileSync(`${output}.review-context.json`);
  const result = runLauncher(['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output, '--revalidate-existing', 'true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REVIEW_REVALIDATION_REJECTED/);
  assert.deepEqual(readFileSync(`${output}.review-context.json`), before);
});

test('captured reviewer stdin contains each validated evidence map once plus Scope Guard', () => {
  const { repo, head } = makeRepo({ featureCommit: true });
  const output = runRootOutput(repo);
  const prompt = writePrompt(repo, reviewPrompt({ sha: head }));
  const capture = join(dirname(repo), 'review-stdin.txt');
  const env = makeMockEnv(repo, [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText()))], capture);
  const result = runLauncher(['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.equal(result.status, 0, result.stderr);
  const input = readFileSync(capture, 'utf8');
  const args = JSON.parse(readFileSync(`${capture}.args.json`, 'utf8'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash,PowerShell');
  assert.equal(args[args.indexOf('--model') + 1], TEAM_CLAUDE_REVIEW_MODEL);
  assert.equal(args[args.indexOf('--add-dir') + 1], repo);
  assert.equal(existsSync(join(repo, '.claude')), false);
  assert.ok(existsSync(join(`${output}.runtime`, '.claude', 'settings.local.json')));
  assert.match(input, /Complete the current task with the minimum sufficient change/);
  assert.match(input, /Outcome.*Non-goals.*Files.*Proof/s);
  assert.equal(input.match(/SENTINEL invariant/g)?.length, 1);
  assert.equal(input.match(/REVIEW_IMPACT_MAP_JSON/g)?.length || 0, 0);
});

test('complete Fable review artifact recovers from a nonzero Claude process exit', () => {
  const { repo, head } = makeRepo({ featureCommit: true });
  const output = runRootOutput(repo);
  const prompt = writePrompt(repo, reviewPrompt({ sha: head }));
  const env = makeMockEnv(repo, [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText()))]);
  env.MOCK_EXIT_CODE = '17';
  const result = runLauncher(['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.equal(result.status, 0, result.stderr);
  const monitor = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8'));
  assert.equal(monitor.modelExitCode, 17);
  assert.equal(monitor.runtime.verified, true);
});

test('captured executor stdin carries Scope Guard, owned paths, and protected evidence without full-gate repetition', () => {
  const { repo, head } = makeRepo();
  const output = runRootOutput(repo, 'executor.json');
  const prompt = writePrompt(repo, executorPrompt({ sha: head }));
  const capture = join(dirname(repo), 'executor-stdin.txt');
  const env = makeMockEnv(repo, [], capture);
  env.MOCK_CODEX_OUTPUT = executorResult;
  const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.equal(result.status, 0, result.stderr);
  const input = readFileSync(capture, 'utf8');
  const args = JSON.parse(readFileSync(`${capture}.args.json`, 'utf8'));
  assert.ok(args.includes('codex'));
  assert.ok(args.includes('--no-mcp'));
  assert.equal(args[args.indexOf('--code-memory') + 1], 'none');
  assert.ok(args.includes('--ignore-user-config'));
  assert.match(input, /Complete the current task with the minimum sufficient change/);
  assert.match(input, /EXECUTOR_APPROVED_OWNED_PATHS_JSON: \["file.txt"\]/);
  assert.match(input, /file\.txt::TOKEN/);
  assert.doesNotMatch(input, /run the supplied verification commands/i);
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  assert.equal(existsSync(`${output}.lane-telemetry.json`), false);
});

const makeDeltaFixture = () => {
  const fixture = makeRepo();
  writeFileSync(join(fixture.repo, 'preserved.txt'), 'BASE\n');
  git(fixture.repo, 'add', 'preserved.txt');
  git(fixture.repo, 'commit', '-qm', 'preserved base');
  const head = git(fixture.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(fixture.repo, 'preserved.txt'), 'PRIOR CANDIDATE\n');
  writeFileSync(join(fixture.repo, 'prior-new.txt'), 'PRIOR NEW FILE\n');
  const prompt = writePrompt(fixture.repo, executorPrompt({ sha: head, extra: `EXECUTOR_DELTA_IN_PLACE: APPROVED\nEXECUTOR_BASELINE_WORKTREE: ${fixture.repo}\nEXECUTOR_DELTA_ALLOWED_PATHS_JSON: ["file.txt"]\nEXECUTOR_BASELINE_PRESERVED_PATHS_JSON: ["preserved.txt","prior-new.txt"]` }).replace('EXECUTOR_CORRECTION_MODE: INITIAL', 'EXECUTOR_CORRECTION_MODE: DELTA'));
  const env = makeMockEnv(fixture.repo, []);
  env.MOCK_CODEX_OUTPUT = executorResult;
  return { ...fixture, head, prompt, env, output: runRootOutput(fixture.repo, 'delta.json') };
};

test('DELTA accepts dirty preserved baseline outside ownership with a one-file correction', () => {
  const { repo, head, prompt, env, output } = makeDeltaFixture();
  env.MOCK_OUT_OF_ROOT_REPO = repo;
  env.MOCK_OUT_OF_ROOT_CHANGE = 'tracked';
  const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(repo, 'preserved.txt'), 'utf8'), 'PRIOR CANDIDATE\n');
  assert.equal(readFileSync(join(repo, 'prior-new.txt'), 'utf8'), 'PRIOR NEW FILE\n');
  assert.match(readFileSync(join(repo, 'file.txt'), 'utf8'), /CHANGED/);
});

test('executor source preflight uses current DELTA predecessor bytes rather than frozen HEAD', () => {
  const { repo, prompt, output } = makeDeltaFixture();
  writeFileSync(prompt, readFileSync(prompt, 'utf8').replace('"requiredSourceEvidence":["file.txt::TOKEN"]', '"requiredSourceEvidence":["preserved.txt::PRIOR CANDIDATE","prior-new.txt::PRIOR NEW FILE"]'));
  const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output, '--dry-run', 'true']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(repo, 'preserved.txt'), 'utf8'), 'PRIOR CANDIDATE\n');
  assert.equal(readFileSync(join(repo, 'prior-new.txt'), 'utf8'), 'PRIOR NEW FILE\n');
});

test('DELTA rejects changed or missing preserved files, new unowned files, and HEAD movement', () => {
  for (const fault of ['mutate', 'missing', 'unowned', 'head']) {
    const { repo, prompt, env, output } = makeDeltaFixture();
    if (fault === 'head' || fault === 'unowned') {
      env.MOCK_OUT_OF_ROOT_REPO = repo;
      env.MOCK_OUT_OF_ROOT_CHANGE = fault === 'head' ? 'head' : 'untracked';
    } else {
      const code = `if(process.execPath.toLowerCase().endsWith('headroom.exe')){const fs=await import('node:fs');${fault === 'mutate' ? `fs.appendFileSync(${JSON.stringify(join(repo, 'preserved.txt'))},'MUTATED');` : `fs.unlinkSync(${JSON.stringify(join(repo, 'prior-new.txt'))});`}}`;
      env.NODE_OPTIONS = `--import=data:text/javascript;base64,${Buffer.from(code).toString('base64')} ${env.NODE_OPTIONS}`;
    }
    const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
    assert.notEqual(result.status, 0, fault);
    const failure = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8')).failure;
    assert.match(failure, fault === 'head' ? /changed HEAD/ : fault === 'unowned' ? /outside EXECUTOR_APPROVED_OWNED_PATHS_JSON: outside.txt/ : /changed immutable preserved baseline files/);
  }
});

test('standard executor result requires each protected behavior ID in CROSS_IMPACT_CHECK', () => {
  const compliant = makeRepo();
  const compliantOutput = runRootOutput(compliant.repo, 'protected-behavior-compliant.json');
  const compliantPrompt = writePrompt(compliant.repo, executorPrompt({ sha: compliant.head }));
  const compliantCapture = join(dirname(compliant.repo), 'protected-behavior-compliant-stdin.txt');
  const compliantEnv = makeMockEnv(compliant.repo, [], compliantCapture);
  compliantEnv.MOCK_CODEX_OUTPUT = executorResult;
  const compliantResult = runLauncher(['--role', 'executor-sol', '--repo', compliant.repo, '--prompt', compliantPrompt, '--output', compliantOutput], compliantEnv);
  assert.equal(compliantResult.status, 0, compliantResult.stderr);
  assert.match(readFileSync(compliantCapture, 'utf8'), /Each protected-behavior ID must appear verbatim at the beginning of its CROSS_IMPACT_CHECK line/);

  const idless = makeRepo();
  const idlessOutput = runRootOutput(idless.repo, 'protected-behavior-idless.json');
  const idlessPrompt = writePrompt(idless.repo, executorPrompt({ sha: idless.head }));
  const idlessEnv = makeMockEnv(idless.repo, []);
  idlessEnv.MOCK_CODEX_OUTPUT = executorResult.replace('- GATES-PRESERVED — preserved', '- rate-limit invariant — preserved');
  const idlessResult = runLauncher(['--role', 'executor-sol', '--repo', idless.repo, '--prompt', idlessPrompt, '--output', idlessOutput], idlessEnv);
  assert.notEqual(idlessResult.status, 0);
  assert.match(JSON.parse(readFileSync(`${idlessOutput}.monitor.json`, 'utf8')).failure, /omitted protected behavior IDs: GATES-PRESERVED/);
});

test('opt-in executor telemetry records usage, model activity, and the task ledger', () => {
  const { repo, head } = makeRepo();
  const output = runRootOutput(repo, 'telemetry.json');
  const prompt = writePrompt(repo, executorPrompt({ sha: head }));
  const records = [
    jsonLine({ type: 'turn.started' }),
    jsonLine({ type: 'item.started', item: { id: 'read', type: 'command_execution', command: 'Get-Content file.txt', status: 'in_progress' } }),
    jsonLine({ type: 'item.completed', item: { id: 'read', type: 'command_execution', command: 'Get-Content file.txt', status: 'completed' } }),
    jsonLine({ type: 'item.started', item: { id: 'red', type: 'command_execution', command: 'npm test', status: 'in_progress' } }),
    jsonLine({ type: 'item.completed', item: { id: 'red', type: 'command_execution', command: 'npm test', status: 'completed' } }),
    jsonLine({ type: 'item.completed', item: { id: 'edit', type: 'file_change', status: 'completed' } }),
    jsonLine({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 7, reasoning_output_tokens: 3 } })
  ];
  const env = makeMockEnv(repo, records);
  env.MOCK_CODEX_OUTPUT = executorResult;
  env.DIRECT_LANE_TELEMETRY = '1';
  env.DIRECT_EXECUTOR_SOL_REASONING_EFFORT = 'high';
  const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.equal(result.status, 0, result.stderr);
  const monitor = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8'));
  assert.equal(monitor.modelExitCode, 0);
  assert.equal(monitor.failureClassification, null);
  assert.ok(monitor.timing.model.elapsedMs >= 0);
  assert.ok(monitor.timing.verification.elapsedMs >= 0);
  const telemetry = JSON.parse(readFileSync(`${output}.lane-telemetry.json`, 'utf8'));
  assert.equal(telemetry.taskId, 'test-run');
  assert.equal(telemetry.requestedReasoningEffort, 'high');
  assert.deepEqual(telemetry.usage, { inputTokens: 100, nonCachedInputTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 10, cacheWriteReported: true, reasoningTokens: 3, outputTokens: 7 });
  assert.equal(telemetry.providerReportedUsage.length, 1);
  assert.equal(telemetry.modelActivity.turns.length, 1);
  assert.equal(telemetry.modelActivity.toolMix.commandExecutions, 2);
  assert.equal(telemetry.modelActivity.toolMix.fileReadCommands, 1);
  assert.equal(telemetry.modelActivity.toolMix.testInvocations, 1);
  assert.equal(telemetry.modelActivity.preEditRedProof.testInvocations, 1);
  assert.equal(telemetry.modelActivity.packetRereadAssessment, 'not-observable-from-event-stream');
  const taskLedger = readFileSync(join(dirname(output), 'DIRECT_LANE_LEDGER.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(taskLedger.length, 1);
  assert.equal(taskLedger[0].taskId, 'test-run');
  const args = JSON.parse(readFileSync(`${env.CAPTURE_PATH}.args.json`, 'utf8'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
});

test('telemetry marks a provider cache-write bucket absent rather than zero', () => {
  const { repo, head } = makeRepo();
  const output = runRootOutput(repo, 'cache-write-absent.json');
  const prompt = writePrompt(repo, executorPrompt({ sha: head }));
  const env = makeMockEnv(repo, [jsonLine({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7, reasoning_output_tokens: 3 } })]);
  env.MOCK_CODEX_OUTPUT = executorResult;
  env.DIRECT_LANE_TELEMETRY = '1';
  const result = runLauncher(['--role', 'executor-terra', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.equal(result.status, 0, result.stderr);
  const telemetry = JSON.parse(readFileSync(`${output}.lane-telemetry.json`, 'utf8'));
  assert.equal(telemetry.usage.cacheWriteReported, false);
  assert.equal(telemetry.usage.cacheWriteTokens, null);
  assert.equal(telemetry.usage.nonCachedInputTokens, null);
  assert.deepEqual(telemetry.pricing, {
    model: 'gpt-5.6-terra',
    costUsd: null,
    status: 'unpriced',
    reason: 'official-provider-rate-not-configured'
  });
});

test('guarded dry-run records only declared roots and HEADs without launching or changing repositories', async t => {
  for (const enabled of [false, true]) {
    await t.test(enabled ? 'enabled' : 'disabled', () => {
      const { root, repo, head } = makeRepo();
      const sibling = makeSiblingRepo(root);
      git(repo, 'worktree', 'add', '--detach', join(root, 'undeclared-worktree'), head);
      writeFileSync(join(sibling, 'outside.txt'), 'pre-existing\n');
      const siblingHead = git(sibling, 'rev-parse', 'HEAD');
      const before = [repo, sibling].map(path => ({
        status: git(path, 'status', '--porcelain'),
        index: readFileSync(join(path, '.git', 'index')),
        files: readdirSync(path).sort()
      }));
      const output = runRootOutput(repo, `dry-coverage-${enabled}.json`);
      const prompt = writePrompt(repo, executorPrompt({ sha: head, guardRoots: [repo, sibling] }));
      const env = makeMockEnv(repo, []);
      env.DIRECT_OUT_OF_ROOT_GUARD = enabled ? '1' : '0';
      const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output, '--dry-run', 'true'], env);
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(readFileSync(output, 'utf8'));
      if (enabled) {
        assert.deepEqual(receipt.outOfRootGuard.monitoredRoots.map(path => resolve(path)), [resolve(sibling)]);
        assert.deepEqual(receipt.outOfRootGuard.declaredRoots.map(path => resolve(path)).sort(), [resolve(repo), resolve(sibling)].sort());
        assert.equal(resolve(receipt.outOfRootGuard.primaryRoot), resolve(repo));
        assert.equal(receipt.outOfRootGuard.status, 'observed');
        assert.deepEqual(receipt.outOfRootGuard.discoveryErrors, []);
        assert.equal(receipt.outOfRootGuard.snapshots.length, 2);
        const siblingSnapshot = receipt.outOfRootGuard.snapshots.find(item => resolve(item.root) === resolve(sibling));
        assert.equal(siblingSnapshot.head, siblingHead);
        assert.equal(siblingSnapshot.observed, true);
        assert.deepEqual(siblingSnapshot.untrackedPaths, ['outside.txt']);
        assert.equal(receipt.outOfRootGuard.snapshots.find(item => resolve(item.root) === resolve(repo)).head, head);
      } else assert.equal(receipt.outOfRootGuard, undefined);
      assert.equal(existsSync(env.CAPTURE_PATH), false);
      assert.equal(existsSync(`${output}.monitor.json`), false);
      assert.equal(existsSync(`${output}.launch-runtime.json`), false);
      for (const [index, path] of [repo, sibling].entries()) {
        assert.deepEqual(readFileSync(join(path, '.git', 'index')), before[index].index);
        assert.deepEqual(readdirSync(path).sort(), before[index].files);
        assert.equal(git(path, 'status', '--porcelain'), before[index].status);
      }
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
      assert.equal(git(sibling, 'rev-parse', 'HEAD'), siblingHead);
      assert.equal(readFileSync(join(sibling, 'outside.txt'), 'utf8'), 'pre-existing\n');
    });
  }
});

test('declared guard rejects missing roots in dry-run and live preflight without launching', async t => {
  for (const dryRun of [true, false]) {
    await t.test(dryRun ? 'dry-run' : 'live-preflight', () => {
      const { root, repo, head } = makeRepo();
      const missing = join(root, 'missing');
      const output = runRootOutput(repo, `missing-root-${dryRun}.json`);
      const prompt = writePrompt(repo, executorPrompt({ sha: head, guardRoots: [missing] }));
      const env = makeMockEnv(repo, []);
      env.DIRECT_OUT_OF_ROOT_GUARD = '1';
      const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output, ...(dryRun ? ['--dry-run', 'true'] : [])], env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /OUT_OF_ROOT_OBSERVATION_FAILED/);
      const receipt = JSON.parse(readFileSync(dryRun ? output : `${output}.monitor.json`, 'utf8'));
      assert.ok(receipt.outOfRootGuard.declaredRoots.includes(missing));
      assert.ok(receipt.outOfRootGuard.discoveryErrors.some(item => item.root === missing));
      assert.equal(existsSync(env.CAPTURE_PATH), false);
      assert.equal(git(repo, 'status', '--porcelain'), '');
    });
  }
});

test('out-of-root guard fails writer lanes when sibling Git state changes', async t => {
  for (const [change, expected] of [
    ['tracked', 'trackedModified'],
    ['staged', 'stagedModified'],
    ['untracked', 'untrackedChanged'],
    ['head', 'headMoved']
  ]) {
    await t.test(change, () => {
      const { root, repo, head } = makeRepo();
      const sibling = makeSiblingRepo(root);
      const output = runRootOutput(repo, `out-of-root-${change}.json`);
      const prompt = writePrompt(repo, executorPrompt({ sha: head, guardRoots: [sibling] }));
      const env = makeMockEnv(repo, []);
      env.MOCK_CODEX_OUTPUT = executorResult;
      env.MOCK_OUT_OF_ROOT_REPO = sibling;
      env.MOCK_OUT_OF_ROOT_CHANGE = change;
      env.DIRECT_OUT_OF_ROOT_GUARD = '1';
      const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
      assert.notEqual(result.status, 0, result.stderr);
      const monitor = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8'));
      assert.equal(monitor.failureClassification, 'out-of-root-modification');
      assert.equal(monitor.outOfRootGuard.status, 'modified');
      const finding = monitor.outOfRootGuard.findings.find(item => resolve(item.root) === resolve(sibling));
      assert.ok(finding);
      assert.equal(finding.changes[expected], true);
      assert.ok(finding.paths.includes(change === 'untracked' ? 'outside.txt' : 'file.txt'));
      const telemetry = JSON.parse(readFileSync(`${output}.lane-telemetry.json`, 'utf8'));
      assert.equal(telemetry.terminal.failureClassification, 'out-of-root-modification');
      assert.equal(telemetry.outOfRootGuard.status, 'modified');
      assert.equal(git(repo, 'status', '--porcelain'), '');
    });
  }
});

test('out-of-root guard preserves defaults and checks dirty siblings on marker throws', async t => {
  for (const scenario of ['off', 'unchanged-dirty', 'existing-untracked', 'marker-throw']) {
    await t.test(scenario, () => {
      const { root, repo, head } = makeRepo();
      const sibling = makeSiblingRepo(root);
      writeFileSync(join(sibling, 'outside.txt'), 'pre-existing\n');
      const output = runRootOutput(repo, `${scenario}.json`);
      const prompt = writePrompt(repo, executorPrompt({ sha: head, guardRoots: [sibling] }));
      const env = makeMockEnv(repo, []);
      env.DIRECT_OUT_OF_ROOT_GUARD = scenario === 'off' ? '0' : '1';
      env.MOCK_CODEX_OUTPUT = scenario === 'marker-throw' ? 'missing markers' : executorResult;
      env.MOCK_OUT_OF_ROOT_REPO = sibling;
      env.MOCK_OUT_OF_ROOT_CHANGE = scenario === 'unchanged-dirty' ? '' : 'untracked';
      const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
      const monitor = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8'));
      const expectedFailure = !['off', 'unchanged-dirty'].includes(scenario);
      assert.equal(result.status, expectedFailure ? 1 : 0, result.stderr);
      if (expectedFailure) {
        assert.equal(monitor.failureClassification, 'out-of-root-modification');
        const ledger = readFileSync(join(dirname(output), 'DIRECT_LANE_LEDGER.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
        assert.equal(ledger.length, 1);
        assert.equal(ledger[0].outOfRootGuard.status, 'modified');
      }
      if (scenario === 'unchanged-dirty') assert.equal(monitor.outOfRootGuard.status, 'clean');
    });
  }
});

test('out-of-root guard covers explicitly declared distant repositories and worktrees', async t => {
  for (const kind of ['workspace', 'worktree']) {
    await t.test(kind, () => {
      const { root, repo, head } = makeRepo();
      let sibling;
      if (kind === 'workspace') {
        mkdirSync(join(root, 'nested'));
        sibling = makeSiblingRepo(join(root, 'nested'));
      } else {
        sibling = join(newFixtureRoot(), 'linked');
        git(repo, 'worktree', 'add', '--detach', sibling, head);
      }
      const output = runRootOutput(repo, `${kind}.json`);
      const prompt = writePrompt(repo, executorPrompt({ sha: head, guardRoots: [sibling] }));
      const env = makeMockEnv(repo, []);
      env.DIRECT_OUT_OF_ROOT_GUARD = '1';
      env.MOCK_CODEX_OUTPUT = executorResult;
      env.MOCK_OUT_OF_ROOT_REPO = sibling;
      env.MOCK_OUT_OF_ROOT_CHANGE = 'untracked';
      const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
      assert.equal(result.status, 1, result.stderr);
      const monitor = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8'));
      assert.equal(monitor.failureClassification, 'out-of-root-modification');
      assert.ok(monitor.outOfRootGuard.findings.some(item => resolve(item.root) === resolve(sibling) && item.paths.includes('outside.txt')));
    });
  }
});

test('retired graph options refuse before model launch', async t => {
  for (const name of ['DIRECT_EXECUTOR_ORIENTATION', 'DIRECT_GRAFT_WORKTREE_SYNC', 'DIRECT_GRAFT_LSP']) {
    await t.test(name, () => {
      const { repo, head } = makeRepo();
      const prompt = writePrompt(repo, executorPrompt({ sha: head }));
      const env = { ...process.env, [name]: '1' };
      const output = runRootOutput(repo, 'removed-option.json');
      const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output, '--dry-run', 'true'], env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /graft removed; opt-in executor\/sync unavailable/);
      assert.equal(existsSync(output), false);
    });
  }
});

test('telemetry records tokenizer-derived packet and launch token counts', () => {
  const { repo, head } = makeRepo();
  const output = runRootOutput(repo, 'token-counts.json');
  const prompt = writePrompt(repo, executorPrompt({ sha: head }));
  const env = makeMockEnv(repo, []);
  const tokenizerResult = { version: 'test', counts: { rawPacket: 17, launchPrompt: 41 } };
  const tokenizerHook = Buffer.from([
    "import childProcess from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const originalSpawnSync = childProcess.spawnSync;',
    `childProcess.spawnSync = (command, args, options) => command === 'python' ? { status: 0, stdout: ${JSON.stringify(JSON.stringify(tokenizerResult))}, stderr: '', error: null } : originalSpawnSync(command, args, options);`,
    'syncBuiltinESMExports();'
  ].join('\n')).toString('base64');
  env.NODE_OPTIONS = `${env.NODE_OPTIONS} --import=data:text/javascript;base64,${tokenizerHook}`;
  env.MOCK_CODEX_OUTPUT = executorResult;
  env.DIRECT_LANE_TELEMETRY = '1';
  const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.equal(result.status, 0, result.stderr);
  const tokenCounts = JSON.parse(readFileSync(`${output}.lane-telemetry.json`, 'utf8')).packet.tokenCounts;
  assert.deepEqual(tokenCounts, {
    tokenizer: { library: 'tiktoken', version: 'test', encoding: 'o200k_base', status: 'estimated', basis: 'explicit-o200k_base-for-unmapped-model-alias' },
    rawPacketTokens: 17,
    launchPromptTokens: 41,
  });
});

test('fast-path contract accepts the narrow result without repeating unreachable behavior IDs', () => {
  const { repo, head } = makeRepo();
  const output = runRootOutput(repo, 'fast-path.json');
  const prompt = writePrompt(repo, executorPrompt({ sha: head, extra: 'EXECUTOR_FASTPATH_CONTRACT: APPROVED\nEXECUTOR_FASTPATH_MAX_CHANGED_LINES: 24' }));
  const env = makeMockEnv(repo, []);
  env.MOCK_CODEX_OUTPUT = fastPathResult;
  env.DIRECT_FASTPATH_EXECUTOR_CONTRACT = '1';
  const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fastPathResult.includes('GATES-PRESERVED'), false);
});

test('opt-in telemetry records a preflight throw before model launch', () => {
  const { repo, head } = makeRepo();
  const output = runRootOutput(repo, 'preflight.json');
  const prompt = writePrompt(repo, executorPrompt({ sha: head, gate: 'npm test; echo unsafe' }));
  const env = makeMockEnv(repo, []);
  env.DIRECT_LANE_TELEMETRY = '1';
  const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output, '--dry-run', 'true'], env);
  assert.notEqual(result.status, 0);
  const monitor = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8'));
  assert.equal(monitor.modelExitCode, null);
  assert.equal(monitor.phase, 'failed');
  assert.equal(monitor.failureClassification, 'preflight-throw');
  assert.equal(monitor.timing.model.elapsedMs, null);
});

test('opt-in telemetry records a child spawn error as a terminal lane failure', () => {
  const { repo, head } = makeRepo();
  const output = runRootOutput(repo, 'spawn-error.json');
  const prompt = writePrompt(repo, executorPrompt({ sha: head }));
  const env = makeMockEnv(repo, []);
  const forceSpawnErrorHook = Buffer.from([
    "import childProcess from 'node:child_process';",
    "import { EventEmitter } from 'node:events';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "childProcess.spawn = () => { const child = new EventEmitter(); for (const name of ['stdin', 'stdout', 'stderr']) { child[name] = new EventEmitter(); child[name].end = done => { if (typeof done === 'function') done(); }; } child.pid = null; queueMicrotask(() => child.emit('error', Object.assign(new Error('forced spawn failure'), { code: 'ENOENT' }))); return child; };",
    'syncBuiltinESMExports();'
  ].join('\n')).toString('base64');
  env.NODE_OPTIONS = `${env.NODE_OPTIONS} --import=data:text/javascript;base64,${forceSpawnErrorHook}`;
  env.DIRECT_LANE_TELEMETRY = '1';
  const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.notEqual(result.status, 0);
  const monitor = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8'));
  assert.equal(monitor.phase, 'failed');
  assert.equal(monitor.modelExitCode, null);
  assert.equal(monitor.failureClassification, 'spawn-error');
  assert.ok(monitor.spawnError);
  const telemetry = JSON.parse(readFileSync(`${output}.lane-telemetry.json`, 'utf8'));
  assert.equal(telemetry.terminal.failureClassification, 'spawn-error');
  assert.equal(telemetry.timing.model.elapsedMs, null);
});

test('review rejects terminal byte drift and revalidates only the exact committed precommit candidate', () => {
  const drift = makeRepo({ dirty: true });
  const driftOutput = runRootOutput(drift.repo);
  const driftPrompt = writePrompt(drift.repo, reviewPrompt({ sha: drift.base, local: true }));
  const driftEnv = makeMockEnv(drift.repo, [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText()))]);
  driftEnv.MOCK_DRIFT = '1';
  const rejected = runLauncher(['--role', 'reviewer', '--repo', drift.repo, '--prompt', driftPrompt, '--output', driftOutput], driftEnv);
  assert.notEqual(rejected.status, 0);
  assert.match(JSON.parse(readFileSync(`${driftOutput}.monitor.json`, 'utf8')).failure, /REVIEW_ARTIFACT_DRIFT/);
  assert.equal(hasPromotionLock(driftOutput), false);

  const fx = makeRepo({ dirty: true });
  const output = runRootOutput(fx.repo);
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.base, local: true }));
  const args = ['--role', 'reviewer', '--repo', fx.repo, '--prompt', prompt, '--output', output];
  const env = makeMockEnv(fx.repo, [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText()))]);
  const reviewed = runLauncher(args, env);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(hasPromotionLock(output), false);
  git(fx.repo, 'add', 'file.txt'); git(fx.repo, 'commit', '-qm', 'reviewed');
  const revalidated = runLauncher([...args, '--revalidate-existing', 'true'], env);
  assert.equal(revalidated.status, 0, revalidated.stderr);
  assert.equal(readPromotionLock(output, fx.repo).frozenSourceSha, git(fx.repo, 'rev-parse', 'HEAD'));
  git(fx.repo, 'update-index', '--chmod=+x', 'file.txt'); git(fx.repo, 'commit', '-qm', 'mode drift');
  const stale = runLauncher([...args, '--revalidate-existing', 'true'], env);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /REVIEW_REVALIDATION_REJECTED/);
});

test('repository-scoped promotion locks isolate repositories and preserve same-owner blocking', () => {
  const repoA = makeRepo({ featureCommit: true });
  const repoB = makeSiblingRepo(repoA.root);
  git(repoB, 'update-ref', 'refs/remotes/origin/main', git(repoB, 'rev-parse', 'HEAD'));
  writeFileSync(join(repoB, 'file.txt'), 'SIBLING TOKEN SENTINEL\n', 'utf8');
  git(repoB, 'add', 'file.txt'); git(repoB, 'commit', '-qm', 'feature');
  const outputA = runRootOutput(repoA.repo, 'review-a.json');
  const promptA = writePrompt(repoA.repo, reviewPrompt({ sha: repoA.head }), 'review-a-prompt.txt');
  const reviewA = runLauncher(['--role', 'reviewer', '--repo', repoA.repo, '--prompt', promptA, '--output', outputA], makeMockEnv(repoA.repo, [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText()))]));
  assert.equal(reviewA.status, 0, reviewA.stderr);
  const ownerLockA = readPromotionLock(outputA, repoA.repo);
  assert.deepEqual(ownerLockA.owner, promotionLockOwner(repoA.repo));

  // A verified legacy lock must be resolved to A and ignored for a B lane.
  const legacyPath = join(dirname(outputA), 'PROMOTION_LOCK.json');
  const legacyLockA = { ...ownerLockA }; delete legacyLockA.owner;
  writeFileSync(legacyPath, `${JSON.stringify(legacyLockA, null, 2)}\n`, 'utf8');
  rmSync(promotionLockPath(outputA, repoA.repo));
  const outputB = runRootOutput(repoB, 'executor-b.json');
  const promptB = writePrompt(repoB, executorPrompt({ sha: git(repoB, 'rev-parse', 'HEAD') }), 'executor-b-prompt.txt');
  const foreignLock = runLauncher(['--role', 'executor-sol', '--repo', repoB, '--prompt', promptB, '--output', outputB, '--dry-run', 'true']);
  assert.equal(foreignLock.status, 0, foreignLock.stderr);

  // Restoring the A lock keeps its protected baseline binding effective for A.
  const driftLockA = { ...ownerLockA, frozenSourceSha: repoA.base };
  writeFileSync(promotionLockPath(outputA, repoA.repo), `${JSON.stringify(driftLockA, null, 2)}\n`, 'utf8');
  rmSync(legacyPath);
  const blockedA = runLauncher(['--role', 'executor-sol', '--repo', repoA.repo, '--prompt', writePrompt(repoA.repo, executorPrompt({ sha: repoA.head, extra: 'EXECUTOR_POST_REVIEW_CORRECTION: USER_APPROVED\nPOST_REVIEW_AUTHORIZATION_REF: fixture' }), 'executor-a-prompt.txt'), '--output', runRootOutput(repoA.repo, 'executor-a.json'), '--dry-run', 'true']);
  assert.notEqual(blockedA.status, 0);
  assert.match(blockedA.stderr, /POST_REVIEW_BASELINE_DRIFT_BLOCKED/);

  // A second review in B retains A's lock and writes an independent B lock.
  const promptReviewB = writePrompt(repoB, reviewPrompt({ sha: git(repoB, 'rev-parse', 'HEAD') }), 'review-b-prompt.txt');
  const reviewB = runLauncher(['--role', 'reviewer', '--repo', repoB, '--prompt', promptReviewB, '--output', runRootOutput(repoB, 'review-b.json')], makeMockEnv(repoB, [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText()))]));
  assert.equal(reviewB.status, 0, reviewB.stderr);
  assert.equal(promotionLockPaths(outputA).length, 2);
  assert.notEqual(readPromotionLock(outputA, repoA.repo).owner.key, readPromotionLock(outputB, repoB).owner.key);
  assert.equal(readFileSync(join(dirname(outputA), 'CODE_REVIEW_ROUNDS.jsonl'), 'utf8').trim().split(/\r?\n/).length, 2);
});

test('ambiguous legacy promotion lock fails closed', () => {
  const { repo, head } = makeRepo();
  const output = runRootOutput(repo, 'ambiguous-lock.json');
  writeFileSync(join(dirname(output), 'PROMOTION_LOCK.json'), `${JSON.stringify({ schema: 1, frozenSourceSha: head }, null, 2)}\n`, 'utf8');
  const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', writePrompt(repo, executorPrompt({ sha: head }), 'ambiguous-lock-prompt.txt'), '--output', output, '--dry-run', 'true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PROMOTION_LOCK_OWNER_AMBIGUOUS/);
});

test('terminal error result cannot satisfy review markers', () => {
  const { repo, head } = makeRepo({ featureCommit: true });
  const output = runRootOutput(repo);
  const prompt = writePrompt(repo, reviewPrompt({ sha: head }));
  const errorResult = resultRecord(reviewText(), { subtype: 'error_during_execution', is_error: true });
  const env = makeMockEnv(repo, [jsonLine(runtimeInit()), jsonLine(errorResult)]);
  const result = runLauncher(['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output], env);
  assert.notEqual(result.status, 0);
  assert.equal(hasPromotionLock(output), false);
});

test('revalidation rejects a substituted structurally valid reviewer transcript', () => {
  const fx = makeRepo({ dirty: true });
  const output = runRootOutput(fx.repo);
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.base, local: true }));
  const args = ['--role', 'reviewer', '--repo', fx.repo, '--prompt', prompt, '--output', output];
  const env = makeMockEnv(fx.repo, [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText()))]);
  const reviewed = runLauncher(args, env);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  git(fx.repo, 'add', 'file.txt'); git(fx.repo, 'commit', '-qm', 'reviewed');
  writeFileSync(output, `${jsonLine(runtimeInit())}\n${jsonLine(resultRecord(reviewText().replace('covered', 'different review covered')))}\n`);
  const rejected = runLauncher([...args, '--revalidate-existing', 'true'], env);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /original reviewer transcript hash/);
  assert.equal(hasPromotionLock(output), false);
});

test('plan and code runtime require top-level records and reject model or effort contradictions', async t => {
  await t.test('plan review launches Opus 5 at xhigh exactly once', () => {
    const { repo } = makeRepo();
    const output = runRootOutput(repo, 'plan-success.json');
    const prompt = writePrompt(repo, 'OPUS_PLAN_GATE: INITIAL_ONLY\nPLAN_REVIEW_PACKET: fixture');
    const plan = 'PLAN_DECISION: APPROVE\nMATERIAL_FINDINGS:\n- NONE\nNEEDS_EVIDENCE:\n- NONE\nACCEPTED_BOUNDARIES:\n- fixture';
    const env = makeMockEnv(repo, [
      jsonLine(runtimeInit({ model: 'claude-opus-5', effort: 'xhigh' })),
      jsonLine(resultRecord(plan, { model: 'claude-opus-5', effort: 'xhigh', apiKeySource: 'none' }))
    ]);
    const result = runLauncher(['--role', 'reviewer-plan', '--repo', repo, '--prompt', prompt, '--output', output], env);
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(`${env.CAPTURE_PATH}.args.json`, 'utf8'));
    assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5');
    assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
    assert.ok(existsSync(join(dirname(output), 'FABLE_INITIAL_PLAN_RECEIPT.json')));
  });
  await t.test('plan runtime cannot be attested by a Headroom banner', () => {
    const { repo } = makeRepo();
    const output = runRootOutput(repo, 'plan.json');
    const prompt = writePrompt(repo, 'FABLE_PLAN_GATE: INITIAL_ONLY\nPLAN_REVIEW_PACKET: fixture');
    const plan = 'PLAN_DECISION: APPROVE\nMATERIAL_FINDINGS:\n- NONE\nNEEDS_EVIDENCE:\n- NONE\nACCEPTED_BOUNDARIES:\n- fixture';
    const banner = 'Headroom {"model":"claude-opus-5","effort":"xhigh","apiKeySource":"none","mcp_servers":[]}';
    const env = makeMockEnv(repo, [banner, jsonLine({ type: 'result', subtype: 'success', is_error: false, result: plan })]);
    const result = runLauncher(['--role', 'reviewer-plan', '--repo', repo, '--prompt', prompt, '--output', output], env);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(dirname(output), 'FABLE_INITIAL_PLAN_RECEIPT.json')), false);
  });
  for (const [name, override] of [['model', { model: 'claude-opus-5' }], ['previous Fable model', { model: 'claude-fable-5' }], ['invalid dotted Fable ID', { model: 'claude-fable-5.1' }], ['effort', { effort: 'low' }]]) {
    await t.test(`${name} contradiction`, () => {
      const { repo, head } = makeRepo({ featureCommit: true });
      const output = runRootOutput(repo);
      const prompt = writePrompt(repo, reviewPrompt({ sha: head }));
      const env = makeMockEnv(repo, [jsonLine(runtimeInit(override)), jsonLine(resultRecord(reviewText()))]);
      const result = runLauncher(['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output], env);
      assert.notEqual(result.status, 0);
      assert.equal(hasPromotionLock(output), false);
    });
  }
});

test('promotion decision fails closed for material findings, nonzero summary, and undeclared PASS', () => {
  const cases = [
    reviewText({ decision: 'FINDINGS', finding: 'REV-2 [HIGH] in scope defect' }),
    reviewText({ decision: 'FINDINGS', summary: 'HIGH: 2; MEDIUM: 0; LOW: 0; OUT_OF_SCOPE_RISK: 0', finding: 'REV-2 material defect' }),
    reviewText({ decision: 'PASS' })
  ];
  for (const text of cases) {
    const { repo, head } = makeRepo({ featureCommit: true });
    const output = runRootOutput(repo);
    const prompt = writePrompt(repo, reviewPrompt({ sha: head }));
    const env = makeMockEnv(repo, [jsonLine(runtimeInit()), jsonLine(resultRecord(text))]);
    const result = runLauncher(['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output], env);
    assert.ok(existsSync(env.CAPTURE_PATH), `mock not reached: ${result.stderr}`);
    const monitor = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8'));
    assert.equal(monitor.runtime.verified, true, result.stderr);
    if (text.includes('HIGH: 2')) assert.equal(result.status, 0, result.stderr);
    else assert.match(monitor.failure, /review promotion decision rejected/);
    assert.equal(hasPromotionLock(output), false, text);
  }
});

test('summary LOW annotation preserves counts and permits hash-bound format recovery', () => {
  for (const [summary, passes] of [
    ['HIGH: 0; MEDIUM: 0; LOW: 1 (new LOW; prior deferred LOW retained); OUT_OF_SCOPE_RISK: 0', true],
    ['HIGH: 0; MEDIUM: 0; LOW: (missing count); OUT_OF_SCOPE_RISK: 0', false],
    ['HIGH: 0; MEDIUM: 0; LOW: 1 (HIGH: 2); OUT_OF_SCOPE_RISK: 0', false]
  ]) {
    const { repo, base } = makeRepo({ dirty: true });
    const output = runRootOutput(repo);
    const prompt = writePrompt(repo, reviewPrompt({ sha: base, local: true }));
    const env = makeMockEnv(repo, [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText({ summary })))]);
    const args = ['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output];
    const result = runLauncher(args, env);
    assert.equal(result.status === 0, passes, result.stderr);
    if (!passes) continue;
    const monitorPath = `${output}.monitor.json`;
    const monitor = JSON.parse(readFileSync(monitorPath, 'utf8'));
    monitor.exitCode = 1;
    monitor.failure = 'review promotion decision rejected: missing, duplicated, or malformed ROUND_SUMMARY counts';
    delete monitor.reviewClosureError;
    writeFileSync(monitorPath, JSON.stringify(monitor));
    const transcript = readFileSync(output);
    const capture = readFileSync(env.CAPTURE_PATH);
    const recovered = runLauncher([...args, '--revalidate-existing', 'true'], env);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(readFileSync(output), transcript);
    assert.deepEqual(readFileSync(env.CAPTURE_PATH), capture);
  }
});

test('review disposition separators preserve literal IDs and tokens', () => {
  for (const [line, passes, deltaLine] of [
    ['- PB-1 VERIFIED — evidence', true], ['- PB-1 — VERIFIED — evidence', true],
    ['- PB-1 – VERIFIED — evidence', true], ['- PB-1 - VERIFIED — evidence', true],
    ['- PB-1\t —\tVERIFIED — evidence', true], ['- PB-1', false],
    ['- PB-1 REGRESSED — evidence', false], ['- OTHER VERIFIED — evidence', false],
    ['- PB-1 APPROVED — evidence', false], ['- PB-1 VERIFIED_EXTRA — evidence', false],
    ['- PB-1 VERIFIED — evidence', true, '- file.txt — REVIEWED — evidence'],
    ['- PB-1 VERIFIED — evidence', true, '- file.txt – REVIEWED — evidence'],
    ['- PB-1 VERIFIED — evidence', true, '- file.txt - REVIEWED — evidence'],
    ['- PB-1 VERIFIED — evidence', false, '- file.txt'],
    ['- PB-1 VERIFIED — evidence', false, '- wrong.txt REVIEWED — evidence'],
    ['- PB-1 VERIFIED — evidence', false, '- file.txt APPROVED — evidence'],
    ['- PB-1 VERIFIED — evidence', false, '- file.txt — REGRESSED — evidence']
  ]) {
    const { repo, base } = makeRepo({ dirty: true });
    const output = runRootOutput(repo);
    const prompt = writePrompt(repo, reviewPrompt({ sha: base, local: true }));
    const text = reviewText().replace('- PB-1 VERIFIED — file.txt TOKEN', line)
      .replace('- file.txt REVIEWED — exact candidate bytes inspected', deltaLine ?? '- file.txt REVIEWED — exact candidate bytes inspected');
    const env = makeMockEnv(repo, [jsonLine(runtimeInit()), jsonLine(resultRecord(text))]);
    const args = ['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output];
    const result = runLauncher(args, env);
    assert.equal(result.status === 0, passes, `${line}: ${result.stderr}`);
    assert.equal(hasPromotionLock(output), false);
    assert.match(readFileSync(env.CAPTURE_PATH, 'utf8'), /Example: "- PB-1 VERIFIED/);
    if (line === '- PB-1 — VERIFIED — evidence') {
      const monitorPath = `${output}.monitor.json`;
      const monitor = JSON.parse(readFileSync(monitorPath, 'utf8'));
      monitor.exitCode = 1;
      monitor.reviewClosureError = 'review lane has incomplete or regressed protected behavior dispositions: PB-1. Review is incomplete.';
      writeFileSync(monitorPath, JSON.stringify(monitor));
      const transcript = readFileSync(output);
      const capture = readFileSync(env.CAPTURE_PATH);
      const recovered = runLauncher([...args, '--revalidate-existing', 'true'], env);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.deepEqual(readFileSync(output), transcript);
      assert.deepEqual(readFileSync(env.CAPTURE_PATH), capture);
      assert.equal(hasPromotionLock(output), false);
    }
  }
});

test('incomplete evidence rejects, while evidenced regression is a counted finding and never promotes', () => {
  for (const state of ['INCOMPLETE', 'REGRESSED']) {
    const { repo, head } = makeRepo({ featureCommit: true });
    const output = runRootOutput(repo);
    const prompt = writePrompt(repo, reviewPrompt({ sha: head }));
    const text = state === 'REGRESSED'
      ? reviewText({ decision: 'FINDINGS', protectedState: state, finding: 'REV-2 [severity: HIGH] regression', summary: 'HIGH: 1; MEDIUM: 0; LOW: 0; OUT_OF_SCOPE_RISK: 0' })
      : reviewText({ protectedState: state });
    const env = makeMockEnv(repo, [jsonLine(runtimeInit()), jsonLine(resultRecord(text))]);
    const result = runLauncher(['--role', 'reviewer', '--repo', repo, '--prompt', prompt, '--output', output], env);
    assert.ok(existsSync(env.CAPTURE_PATH), result.stderr);
    assert.equal(hasPromotionLock(output), false);
    if (state === 'REGRESSED') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(readFileSync(join(dirname(output), 'CODE_REVIEW_ROUNDS.jsonl'), 'utf8')).status, 'completed');
    } else {
      assert.notEqual(result.status, 0);
      assert.match(JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8')).failure, /incomplete or regressed protected behavior/);
    }
  }
});

test('duplicate final gates execute once and gate failures remain terminally truthful', async t => {
  await t.test('deduplicates while preserving the first order', () => {
    const { repo, head } = makeRepo();
    const promptText = executorPrompt({ sha: head }).replace('["git diff --check"]', '["git diff --check","git diff --check"]');
    const prompt = writePrompt(repo, promptText);
    const output = runRootOutput(repo, 'executor.json');
    const env = makeMockEnv(repo, []); env.MOCK_CODEX_OUTPUT = executorResult;
    const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(`${output}.post-gates.json`, 'utf8')).records.length, 1);
  });
  await t.test('post-gate failure is visible to status mode', () => {
    const { repo, head } = makeRepo();
    const prompt = writePrompt(repo, executorPrompt({ sha: head, gate: 'git diff --check missing-ref' }));
    const output = runRootOutput(repo, 'executor.json');
    const env = makeMockEnv(repo, []); env.MOCK_CODEX_OUTPUT = executorResult;
    const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
    assert.notEqual(result.status, 0);
    const status = runLauncher(['--status', 'true', '--output', output]);
    assert.equal(JSON.parse(status.stdout).status, 'failed');
  });
  await t.test('throw after model completion is visible to status mode', () => {
    const { repo, head } = makeRepo();
    const prompt = writePrompt(repo, executorPrompt({ sha: head }));
    const output = runRootOutput(repo, 'executor.json');
    const env = makeMockEnv(repo, []); env.MOCK_CODEX_OUTPUT = 'missing required markers';
    const result = runLauncher(['--role', 'executor-sol', '--repo', repo, '--prompt', prompt, '--output', output], env);
    assert.notEqual(result.status, 0);
    const status = runLauncher(['--status', 'true', '--output', output]);
    assert.equal(JSON.parse(status.stdout).status, 'failed');
  });
});

// Stop at the paid process boundary; no installed model CLI can run in these fixtures.
const paidFailure = (result, output) => result.stderr + (existsSync(`${output}.monitor.json`) ? JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8')).failure || '' : '');
const paidBoundary = fx => {
  writeFileSync(join(fx.repo, '.git/info/exclude'), '.trioharness-direct/\n');
  const calls = join(fx.root, 'paid-calls.log'), preload = join(fx.root, 'paid-boundary.mjs');
  writeFileSync(preload, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const sync = cp.spawnSync, spawn = cp.spawn;
const fs = await import('node:fs');
const open = fs.default.openSync, write = fs.default.writeFileSync;
fs.default.openSync = (p, flags, ...rest) => { if (String(p).startsWith(${JSON.stringify(join(fx.repo, '.trioharness-direct'))}) && /[wa]/.test(String(flags))) appendFileSync(${JSON.stringify(join(fx.root,'candidate-writes.log'))}, String(p)+'\\n'); return open(p,flags,...rest) };
fs.default.writeFileSync = (p,...rest) => { if (String(p).startsWith(${JSON.stringify(join(fx.repo, '.trioharness-direct'))})) appendFileSync(${JSON.stringify(join(fx.root,'candidate-writes.log'))}, String(p)+'\\n'); return write(p,...rest) };
cp.spawnSync = (name, args, options) => {
  if (name === 'claude') return { status: 0, stdout: '2.1.257', stderr: '' };
  if (name === 'where.exe') return { status: 0, stdout: process.execPath, stderr: '' };
  return sync(name, args, options);
};
cp.spawn = (name, args, options) => {
  if (args[0] === 'wrap' && (args.includes('claude') || args.includes('codex'))) {
    appendFileSync(${JSON.stringify(calls)}, 'paid\\n');
    if (process.env.MOCK_REVIEW_LAST_MESSAGE) fs.default.writeFileSync(args[args.indexOf('--output-last-message')+1], process.env.MOCK_REVIEW_LAST_MESSAGE);
    if (process.env.MOCK_REVIEW_STREAM) return spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(process.env.MOCK_REVIEW_STREAM))'], options);
    const failure=process.env.MOCK_REVIEW_FAILURE || 'ran';
    if(failure==='throw-enoent'){const e=new Error('missing headroom');e.code='ENOENT';throw e}
    if(failure==='enoent') return spawn('definitely-missing-review-command',[],options);
    if(failure==='last-message-429') fs.default.writeFileSync(args[args.indexOf('--output-last-message')+1], 'model work');
    const ran=failure==='ran'||failure==='ran-429';
    const err=failure.includes('429')?'HTTP 429 rate limit':failure==='auth'?'Authentication failed before request':'PAID_LAUNCH_FIXTURE';
    const record={type:'assistant',message:{content:[{type:'text',text:'model work'}]},usage:{input_tokens:1,output_tokens:1}};
    return spawn(process.execPath,['-e', 'process.stdin.resume();process.stdin.on("end",()=>{'+(ran?'process.stdout.write('+JSON.stringify(JSON.stringify(record)+'\\n')+');':'')+'process.stderr.write('+JSON.stringify(err)+');process.exit(1)})'],options);
  }
  return spawn(name, args, options);
};
syncBuiltinESMExports();`);
  return { env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, calls,
    count: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0 };
};
for (const [role, engine] of [['reviewer', 'claude'], ['reviewer-opus', 'claude'], ['reviewer', 'gpt']]) test(`paid review cap covers ${role}/${engine} and retains failed attempts`, () => {
  const fx = makeRepo({ dirty: true }), boundary = paidBoundary(fx);
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.base, local: true }));
  const attempt = (n, extra = []) => runLauncher(['--role', role, '--review-engine', engine, '--repo', fx.repo, '--prompt', prompt, '--output', runRootOutput(fx.repo, `cap-${n}.json`), ...extra], boundary.env);
  // Existing dispatch reserves the first round; launching it must not charge twice.
  const counterRepo = role === 'reviewer' && engine === 'claude' ? fx.root : fx.repo;
  const budget = () => readState(fx.root, 'test-run') || readState(counterRepo, 'test-run');
  countDispatch(counterRepo, 'test-run', role === 'reviewer-opus' ? role : 'code-reviewer');
  const dry = attempt('dry', ['--dry-run', 'true']); assert.equal(dry.status, 0, dry.stderr);
  const stale = writePrompt(fx.repo, reviewPrompt({ sha: fx.base, local: true }).replaceAll('file.txt::TOKEN', 'file.txt::MISSING'), 'stale.txt');
  const invalid = runLauncher(['--role', role, '--review-engine', engine, '--repo', fx.repo, '--prompt', stale, '--output', runRootOutput(fx.repo, 'invalid.json')], boundary.env);
  assert.notEqual(invalid.status, 0); assert.equal(boundary.count(), 0);
  assert.equal(budget().loops['code-review'], 1);
  for (const n of [1, 2]) {
    const result = attempt(n); assert.match(paidFailure(result, runRootOutput(fx.repo, `cap-${n}.json`)), /PAID_LAUNCH_FIXTURE/);
    assert.equal(boundary.count(), n);
    assert.equal(budget().loops['code-review'], n);
    assert.doesNotMatch(budget().status || '', /^parked:/);
  }
  assert.notEqual(attempt('revalidate', ['--revalidate-existing', 'true']).status, 0);
  assert.equal(budget().loops['code-review'], 2);
  const third = attempt(3); assert.match(third.stderr, /LOOP_CAP:code-review|RUN_PARKED/, third.stderr);
  assert.equal(boundary.count(), 2);
});
test('concurrent paid review launches cannot exceed two', async () => {
  const fx = makeRepo({ dirty: true }), boundary = paidBoundary(fx);
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.base, local: true }));
  const results = await Promise.all(Array.from({ length: 6 }, (_, n) => new Promise((resolveRun, reject) => {
    const engine = n % 2 ? 'gpt' : 'claude';
    const child = spawn(process.execPath, [launcher, '--role', 'reviewer', '--review-engine', engine, '--repo', fx.repo, '--prompt', prompt, '--brief', prompt, '--output', runRootOutput(fx.repo, `concurrent-${n}.json`)], { env: laneEnv(boundary.env, engine), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', x => stderr += x); child.stdout.resume();
    child.on('error', reject); child.on('close', code => resolveRun({ code, stderr: paidFailure({ stderr }, runRootOutput(fx.repo, `concurrent-${n}.json`)) }));
  })));
  assert.equal(results.filter(r => /PAID_LAUNCH_FIXTURE/.test(r.stderr)).length, 2, JSON.stringify(results));
  assert.equal(boundary.count(), 2);
  assert.equal(existsSync(join(fx.repo, '.trioharness-direct')), false, 'direct review metadata stays outside frozen candidate');
  assert.equal(readState(fx.root, 'test-run').loops['code-review'], 2);
});

for (const failure of ['enoent', 'throw-enoent', '429', 'auth', 'ran-429', 'last-message-429']) test(`fix2 M2-a ${failure} refunds only before model work`, () => {
  const fx=makeRepo({ dirty:true }), boundary=paidBoundary(fx), prompt=writePrompt(fx.repo,reviewPrompt({sha:fx.base,local:true}));
  const attempt=n=>runLauncher(['--role','reviewer','--review-engine',failure==='last-message-429'?'gpt':'claude','--repo',fx.repo,'--prompt',prompt,'--output',runRootOutput(fx.repo,`refund-${n}.json`)],{...boundary.env,MOCK_REVIEW_FAILURE:failure});
  const worked=['ran-429','last-message-429'].includes(failure);
  const limit=worked?2:3;
  for(let n=0;n<limit;n++) {
    assert.notEqual(attempt(n).status,0);
    assert.equal(readState(fx.root,'test-run').loops['code-review'],worked?n+1:0);
  }
  if(worked) assert.match(attempt('cap').stderr,/LOOP_CAP:code-review|RUN_PARKED/);
});
test('fix2 M2-b legacy candidate dispatch ledger is read without any candidate writes', () => {
  const fx=makeRepo({dirty:true}), boundary=paidBoundary(fx), prompt=writePrompt(fx.repo,reviewPrompt({sha:fx.base,local:true}));
  countDispatch(fx.repo,'test-run','code-reviewer');
  const file=join(fx.repo,'.trioharness-direct/runs/test-run/state.json'), before=readFileSync(file,'utf8');
  const result=runLauncher(['--role','reviewer','--repo',fx.repo,'--prompt',prompt,'--output',runRootOutput(fx.repo)],boundary.env);
  assert.match(paidFailure(result, runRootOutput(fx.repo)),/PAID_LAUNCH_FIXTURE/);
  assert.equal(readFileSync(file,'utf8'),before);
  assert.equal(existsSync(join(fx.root,'candidate-writes.log')),false);
  assert.equal(readState(fx.root,'test-run').loops['code-review'],1);
});
for(const coordinator of ['alternate','canonical']) test(`fix2 M2-b alternate receipt layout shares ${coordinator} coordinator state`,()=>{
  const fx=makeRepo({dirty:true}), boundary=paidBoundary(fx), prompt=writePrompt(fx.repo,reviewPrompt({sha:fx.base,local:true}));
  const alt=join(fx.root,'trioharness-direct-runs/test-run');mkdirSync(alt,{recursive:true});
  const dir=coordinator==='alternate'?alt:join(fx.root,'.trioharness-direct/runs/test-run');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'state.json'),JSON.stringify({run:'test-run',gates:{},history:[],dispatches:{'code-reviewer':1},loops:{'code-review':1}}));
  const result=runLauncher(['--role','reviewer','--repo',fx.repo,'--prompt',prompt,'--output',join(alt,'review.json')],boundary.env);
  assert.match(paidFailure(result, join(alt,'review.json')),/PAID_LAUNCH_FIXTURE/);
  const current=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));
  assert.equal(current.loops['code-review'],1);assert.equal(current.loops['code-review-launch'],1);
});
test('fix2 M2-b cap refusal records terminal failed status',()=>{
  const fx=makeRepo({dirty:true}), boundary=paidBoundary(fx), prompt=writePrompt(fx.repo,reviewPrompt({sha:fx.base,local:true}));
  countDispatch(fx.root,'test-run','code-reviewer');countDispatch(fx.root,'test-run','code-reviewer');
  const dir=join(fx.root,'.trioharness-direct/runs/test-run');
  writeFileSync(join(dir,'CODE_REVIEW_ROUNDS.jsonl'),[0,1].map(round=>JSON.stringify({status:'completed',round})).join('\n')+'\n');
  const output=runRootOutput(fx.repo,'refused.json');
  assert.notEqual(runLauncher(['--role','reviewer','--repo',fx.repo,'--prompt',prompt,'--output',output],boundary.env).status,0);
  const status=runLauncher(['--status','true','--output',output]);
  assert.equal(JSON.parse(status.stdout).status,'failed');
  assert.equal(boundary.count(),0);
});

for (const order of [['alternate', 'canonical'], ['canonical', 'alternate']]) test(`batch2 F2 review budget cannot split across ${order.join(' then ')}`, () => {
  const fx = makeRepo({ dirty: true }), boundary = paidBoundary(fx);
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.base, local: true }));
  const dirs = { alternate: join(fx.root, 'trioharness-direct-runs/test-run'), canonical: join(fx.root, '.trioharness-direct/runs/test-run') };
  mkdirSync(dirs[order[0]], { recursive: true });
  writeFileSync(join(dirs[order[0]], 'state.json'), JSON.stringify({ run: 'test-run', gates: {}, history: [] }));
  for (const [index, layout] of [order[0], order[0], order[1], order[1]].entries()) {
    const output = join(dirs[layout], `review-${index}.json`);
    const result = runLauncher(['--role', 'reviewer', '--repo', fx.repo, '--prompt', prompt, '--output', output], boundary.env);
    if (index < 2) assert.match(paidFailure(result, output), /PAID_LAUNCH_FIXTURE/);
    else assert.match(paidFailure(result, output), /LOOP_CAP:code-review|RUN_PARKED/);
    assert.equal(boundary.count(), Math.min(index + 1, 2));
  }
});

test('closure root launcher preserves the dispatched reservation, worker and output identity', () => {
  const fx = makeRepo({ featureCommit: true });
  const output = runRootOutput(fx.repo);
  countDispatch(fx.root, 'test-run', 'code-reviewer', undefined, { reservation: 'bound-review' });
  registerWorker(fx.root, 'test-run', { id: 'named-reviewer', role: 'code-reviewer', reviewReservation: 'bound-review' });
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.head }));
  const env = { ...paidBoundary(fx).env, MOCK_REVIEW_STREAM: [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText())), ''].join('\n') };
  const result = runLauncher(['--role', 'reviewer', '--repo', fx.repo, '--prompt', prompt, '--output', output,
    '--worker', 'named-reviewer', '--review-reservation', 'bound-review'], env);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(join(dirname(output), 'CODE_REVIEW_ROUNDS.jsonl'), 'utf8'));
  assert.equal(receipt.reservation, 'bound-review');
  const state = readState(fx.root, 'test-run');
  assert.equal(state.closureObligations.length, 1);
  assert.equal(state.closureObligations[0].id, receipt.reservation);
  assert.equal(state.closureObligations[0].reservation, receipt.reservation);
  assert.equal(state.closureObligations[0].worker, 'named-reviewer');
  assert.equal(state.closureObligations[0].output, output);
  assert.equal(state.loops['code-review'], 1);
  assert.equal(state.loops['code-review-launch'], 1);
  assert.equal(existsSync(join(fx.repo, '.trioharness-direct')), false);
});

test('closure AMEND F3 revalidation recovers the original reservation without another launch', () => {
  for (const layout of ['.trioharness-direct/runs', 'trioharness-direct-runs']) {
    const fx = makeRepo({ featureCommit: true }), boundary = paidBoundary(fx);
    const dir = join(fx.root, layout, 'test-run'); mkdirSync(dir, { recursive: true });
    const output = join(dir, 'review.json');
    const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.head }));
    const env = { ...boundary.env, MOCK_REVIEW_STREAM: [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText())), ''].join('\n') };
    const args = ['--role', 'reviewer', '--repo', fx.repo, '--prompt', prompt, '--output', output];
    const initial = runLauncher(args, env); assert.equal(initial.status, 0, initial.stderr);
    const ledger = join(dir, 'CODE_REVIEW_ROUNDS.jsonl');
    const original = JSON.parse(readFileSync(ledger, 'utf8'));
    assert.ok(original.reservation);
    const before = readState(fx.root, 'test-run');
    rmSync(ledger);
    rmSync(promotionLockPath(output, fx.repo));
    const result = runLauncher([...args, '--revalidate-existing', 'true'], env);
    assert.equal(result.status, 0, result.stderr);
    const restored = JSON.parse(readFileSync(ledger, 'utf8'));
    assert.equal(restored.reservation, original.reservation);
    assert.deepEqual(readState(fx.root, 'test-run'), before);
    assert.equal(boundary.count(), 1, 'revalidation must not call a model');
  }
});

test('closure AMEND G2 revalidation repairs an output receipt with the current reservation', () => {
  for (const previousReservation of [undefined, 'previous']) {
    const fx = makeRepo({ featureCommit: true }), boundary = paidBoundary(fx);
    const output = runRootOutput(fx.repo);
    reserveReviewLaunch(fx.root, 'test-run', { reservation: 'previous', output });
    registerWorker(fx.root, 'test-run', { id: 'previous', role: 'code-reviewer', reviewReservation: 'previous' });
    finishWorker(fx.root, 'test-run', 'previous', 'failed');
    const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.head }));
    const env = { ...boundary.env, MOCK_REVIEW_STREAM: [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText())), ''].join('\n') };
    const args = ['--role', 'reviewer', '--repo', fx.repo, '--prompt', prompt, '--output', output];
    const initial = runLauncher(args, env); assert.equal(initial.status, 0, initial.stderr);
    const ledger = join(dirname(output), 'CODE_REVIEW_ROUNDS.jsonl');
    const original = JSON.parse(readFileSync(ledger, 'utf8'));
    const stale = { ...original }; delete stale.reservation;
    if (previousReservation) stale.reservation = previousReservation;
    writeFileSync(ledger, [original, stale].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const before = readState(fx.root, 'test-run');
    rmSync(promotionLockPath(output, fx.repo));
    const result = runLauncher([...args, '--revalidate-existing', 'true'], env);
    assert.equal(result.status, 0, result.stderr);
    const repaired = readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(repaired.at(-1).reservation, original.reservation);
    assert.deepEqual(repaired[0], original, 'the earlier correct receipt is preserved');
    assert.deepEqual(repaired[1], stale, 'historical receipt is preserved');
    assert.deepEqual(readState(fx.root, 'test-run'), before);
    assert.equal(boundary.count(), 1, 'receipt repair must not launch a model');
    rmSync(promotionLockPath(output, fx.repo));
    const again = runLauncher([...args, '--revalidate-existing', 'true'], env);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, repaired.length, 'an already-bound receipt is not duplicated');
    assert.equal(boundary.count(), 1);
  }
});


for (const binding of ['newer same-output', 'missing original', 'wrong original output']) test(`closure binding R3 revalidation preserves transcript identity with ${binding}`, () => {
  const fx = makeRepo({ featureCommit: true }), boundary = paidBoundary(fx);
  const output = runRootOutput(fx.repo);
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.head }));
  const env = { ...boundary.env, MOCK_REVIEW_STREAM: [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText())), ''].join('\n') };
  const args = ['--role', 'reviewer', '--repo', fx.repo, '--prompt', prompt, '--output', output];
  const initial = runLauncher(args, env); assert.equal(initial.status, 0, initial.stderr);
  const ledger = join(dirname(output), 'CODE_REVIEW_ROUNDS.jsonl');
  const original = JSON.parse(readFileSync(ledger, 'utf8'));
  if (binding === 'newer same-output') {
    reserveReviewLaunch(fx.root, 'test-run', { reservation: 'newer', output });
    // Keep a stale last receipt so repair must recover the transcript's own reservation.
    writeFileSync(ledger, [original, { ...original, reservation: 'newer' }].map(JSON.stringify).join('\n') + '\n');
  } else {
    const file = join(fx.root, '.trioharness-direct/runs/test-run/state.json');
    const current = readState(fx.root, 'test-run');
    if (binding === 'missing original') current.closureObligations = [];
    else current.closureObligations[0].output = `${output}.other`;
    writeFileSync(file, JSON.stringify(current));
  }
  const before = readFileSync(ledger, 'utf8');
  rmSync(promotionLockPath(output, fx.repo));
  const result = runLauncher([...args, '--revalidate-existing', 'true'], env);
  assert.equal(result.status, 0, result.stderr);
  const after = readFileSync(ledger, 'utf8');
  if (binding === 'newer same-output') {
    const repaired = after.trim().split('\n').map(JSON.parse);
    assert.equal(repaired.at(-1).reservation, original.reservation, 'repair belongs to the original transcript, never the newer reservation');
    assert.equal(repaired.length, 3);
  } else assert.equal(after, before, 'unknown original binding must leave the ledger byte-identical');
  assert.equal(boundary.count(), 1);
});


test('closure binding R3 GPT synthesized transcript retains its original reservation for repair', () => {
  const fx = makeRepo({ featureCommit: true }), boundary = paidBoundary(fx);
  const output = runRootOutput(fx.repo);
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.head }));
  const env = { ...boundary.env, MOCK_REVIEW_LAST_MESSAGE: reviewText(),
    MOCK_REVIEW_STREAM: [jsonLine({ type: 'turn.started' }), jsonLine({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }), ''].join('\n') };
  const args = ['--role', 'reviewer', '--review-engine', 'gpt', '--repo', fx.repo, '--prompt', prompt, '--output', output];
  const initial = runLauncher(args, env); assert.equal(initial.status, 0, initial.stderr);
  const ledger = join(dirname(output), 'CODE_REVIEW_ROUNDS.jsonl');
  const original = JSON.parse(readFileSync(ledger, 'utf8'));
  const monitor = JSON.parse(readFileSync(`${output}.monitor.json`, 'utf8'));
  assert.equal(monitor.reviewReservation, original.reservation);
  rmSync(ledger); rmSync(promotionLockPath(output, fx.repo));
  const result = runLauncher([...args, '--revalidate-existing', 'true'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(ledger, 'utf8')).reservation, original.reservation);
  assert.equal(boundary.count(), 1);
});


test('explicit binding D5 direct terminal-worker relaunch keeps new context and runtime sidecars intact', () => {
  const fx = makeRepo({ featureCommit: true }), boundary = paidBoundary(fx);
  const dir = join(fx.root, '.trioharness-direct/runs/test-run/workers'); mkdirSync(dir, { recursive: true });
  const output = join(dir, 'w.json');
  countDispatch(fx.root, 'test-run', 'code-reviewer'); registerWorker(fx.root, 'test-run', { id: 'w', role: 'code-reviewer' });
  reserveReviewLaunch(fx.root, 'test-run', { worker: 'w', reservation: 'old', output }); finishWorker(fx.root, 'test-run', 'w', 'failed');
  const prompt = writePrompt(fx.repo, reviewPrompt({ sha: fx.head }));
  const env = { ...boundary.env, MOCK_REVIEW_STREAM: [jsonLine(runtimeInit()), jsonLine(resultRecord(reviewText())), ''].join('\n') };
  const result = runLauncher(['--role', 'reviewer', '--repo', fx.repo, '--prompt', prompt, '--output', output, '--worker', 'w', '--review-reservation', 'new'], env);
  assert.equal(result.status, 0, result.stderr);
  for (const suffix of ['', '.review-context.json', '.launch-runtime.json', '.monitor.json']) assert.equal(existsSync(output + suffix), true, suffix);
  assert.equal(boundary.count(), 1);
  assert.equal(readState(fx.root, 'test-run').closureObligations.find(o => o.reservation === 'old').output, output);
});

for (const role of ['executor-sol', 'reviewer']) {
  test(`R7 invoke-lane refuses a model literal in the ${role} prompt before launch`, () => {
    const { repo } = makeRepo();
    const prompt = writePrompt(repo, 'Use gpt-6.2-example.');
    const output = runRootOutput(repo);
    const result = runLauncher(['--role', role, '--repo', repo, '--prompt', prompt, '--output', output, '--dry-run', 'true']);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes(`PACKET_MODEL_LITERAL: ${prompt}:1: gpt-6.2-example`), result.stderr);
    assert.equal(existsSync(`${output}.dry-run.json`), false);
  });
}

for (const role of ['reviewer', 'executor-sol']) {
  test(`R12 invoke-lane scans the ${role} prompt and requires its brief verbatim`, () => {
    const fx = makeRepo({ dirty: true });
    if (role === 'executor-sol') git(fx.repo, 'commit', '-qam', 'frozen change');
    const instructions = 'Inspect the frozen work.';
    const packet = role === 'reviewer' ? reviewPrompt({ sha: fx.base, local: true }) : executorPrompt({ sha: git(fx.repo, 'rev-parse', 'HEAD') });
    const prompt = writePrompt(fx.repo, `${packet}\n${instructions}\nUse gpt-6.2-example.`);
    const brief = writePrompt(fx.repo, instructions, 'brief.md');
    const output = runRootOutput(fx.repo);
    const args = ['--role', role, '--repo', fx.repo, '--prompt', prompt, '--brief', brief, '--output', output, '--dry-run', 'true'];
    const refused = runLauncher(args);
    assert.equal(refused.status, 2, refused.stderr);
    assert.ok(refused.stderr.includes(`PACKET_MODEL_LITERAL: ${prompt}:`), refused.stderr);
  });

  test(`R12 invoke-lane refuses the ${role} brief when absent from the prompt`, () => {
    const fx = makeRepo({ dirty: true });
    if (role === 'executor-sol') git(fx.repo, 'commit', '-qam', 'frozen change');
    const packet = role === 'reviewer' ? reviewPrompt({ sha: fx.base, local: true }) : executorPrompt({ sha: git(fx.repo, 'rev-parse', 'HEAD') });
    const prompt = writePrompt(fx.repo, packet);
    const brief = writePrompt(fx.repo, 'Inspect the frozen work.', 'brief.md');
    const result = runLauncher(['--role', role, '--repo', fx.repo, '--prompt', prompt, '--brief', brief, '--output', runRootOutput(fx.repo), '--dry-run', 'true']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /brief does not match the prompt/);
  });
}

test('R12 invoke-lane allows a model ID only in its embedded frozen diff', () => {
  const fx = makeRepo({ dirty: true });
  const baseline = join(fx.root, 'baseline');
  git(fx.repo, 'worktree', 'add', '--detach', baseline, fx.base);
  rmSync(join(baseline, 'file.txt'));
  writeFileSync(join(fx.repo, 'file.txt'), 'TOKEN SENTINEL gpt-6.2-example\n');
  const manifest = JSON.stringify({ schema: 1, baseSha: fx.base, files: [
    { path: 'file.txt', state: 'deleted', mode: '000000', blobOid: null, sha256: null, contentBase64: null }
  ] });
  const manifestPath = writePrompt(fx.repo, manifest, 'manifest.json');
  const instructions = 'Inspect the frozen work.';
  const packet = reviewPrompt({ sha: fx.base, local: true, extra: `${instructions}
REVIEW_BASELINE_WORKTREE: ${baseline}
REVIEW_BASELINE_SHA: ${fx.base}
REVIEW_PREDECESSOR_MANIFEST: ${manifestPath}
REVIEW_PREDECESSOR_MANIFEST_SHA256: ${createHash('sha256').update(manifest).digest('hex')}
REVIEW_CORRECTION_DELTA_PATHS_JSON: ["file.txt"]
` }).replace('REVIEW_CORRECTION_MODE: INVENTORY', 'REVIEW_CORRECTION_MODE: RECONCILIATION');
  const prompt = writePrompt(fx.repo, packet);
  const brief = writePrompt(fx.repo, instructions, 'brief.md');
  const output = runRootOutput(fx.repo);
  const result = runLauncher(['--role', 'reviewer', '--repo', fx.repo, '--prompt', prompt, '--brief', brief, '--output', output, '--dry-run', 'true']);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(output, 'utf8'));
  assert.match(receipt.reviewContext.sourceDiff.content, /^\+.*gpt-6\.2-example/m);
});

for (const role of ['reviewer', 'reviewer-plan', 'reviewer-opus']) {
  test(`R11 invoke-lane requires a separate brief for ${role}`, () => {
    const fx = makeRepo({ dirty: true });
    writeFileSync(join(fx.repo, 'file.txt'), 'TOKEN SENTINEL gpt-6.2-example\n');
    const diff = git(fx.repo, 'diff', fx.base);
    const prompt = writePrompt(fx.repo, `${reviewPrompt({ sha: fx.base, local: true })}\n${diff}`);
    const output = runRootOutput(fx.repo);
    const result = spawnSync(process.execPath, [launcher, '--role', role, '--repo', fx.repo,
      '--prompt', prompt, '--output', output, '--dry-run', 'true'],
    { encoding: 'utf8', env: laneEnv(process.env, 'claude') });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--brief is required for review roles/);
    assert.doesNotMatch(result.stderr, /PACKET_MODEL_LITERAL/);
  });
}
