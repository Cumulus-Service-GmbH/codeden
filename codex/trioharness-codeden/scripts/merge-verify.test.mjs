import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeWorkflow, classifyPath, evaluate, install, mergePr, parseHighRisk, postMerge, rulesetJson, testReduction, validatePolicy, DEFAULT_POLICY } from './merge-verify.mjs';
import { JEV_RECEIPT_REQUIRED } from '../../../../.config/trioharness/jev-receipt-policy.mjs';
import * as MV from './merge-verify.mjs'; // newer exports (recheck) through the namespace

const here = dirname(fileURLToPath(import.meta.url));
const HEAD = 'a'.repeat(40); const BASEHEAD = 'b'.repeat(40); const MERGE = 'c'.repeat(40);
const AWS = `AKIA${'ABCDEFGHIJKLMNOP'}`; // built at runtime so this file itself is not secret-shaped

const POLICY = { version: 1, enabled: true, mergeMethod: 'merge', maxFiles: 10, maxChangedLines: 200 };
const CI_SAFE = 'name: ci\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: dotnet build -c Release\n      - run: dotnet publish -c Release -o out\n      - run: dotnet test\n';
const CI_DEPLOY = 'name: ci\non:\n  push:\n    branches: [main]\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: azure/webapps-deploy@v3\n';
const goodFile = { filename: 'src/Orders/Service.cs', status: 'modified', additions: 10, deletions: 2, changes: 12, patch: '@@ -1,2 +1,3 @@\n-old\n+new line\n+another' };
const testFile = { filename: 'tests/Orders/ServiceTests.cs', status: 'modified', additions: 8, deletions: 0, changes: 8, patch: '@@ -1 +1,3 @@\n+[Fact]\n+public void Works() {}\n+// ok' };

function world(over = {}) {
  const w = {
    meta: { default_branch: 'main', fork: false }, policy: JSON.stringify(POLICY), agents: null,
    pull: { number: 5, state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: 'clean', changed_files: 2, commits: 1, body: '## Package and config check\nnone', user: { login: 'trio-bot[bot]', type: 'Bot' }, base: { ref: 'main' }, head: { ref: 'bambooed/20261028-fix-abcd', sha: HEAD, repo: { full_name: 'o/r' } }, merge_commit_sha: MERGE },
    files: [goodFile, testFile], commits: [{ sha: HEAD, commit: { message: 'Fix the thing' } }],
    workflows: { 'ci.yml': CI_SAFE },
    runs: { [HEAD]: [{ name: 'build', status: 'completed', conclusion: 'success' }], [BASEHEAD]: [{ name: 'build', status: 'completed', conclusion: 'success' }] },
    statuses: {}, merged: false, mergeFails: false, compare: 'ahead', actionRuns: [], reviews: [], reruns: [], rerunErr: null, calls: [], ...over
  };
  return w;
}
function fakeGh(w) {
  return (args) => {
    w.calls.push(args.join(' '));
    const ok = o => ({ ok: true, out: typeof o === 'string' ? o : JSON.stringify(o) });
    const no = e => ({ ok: false, out: '', err: e || 'Not Found' });
    if (args[0] === 'pr' && args[1] === 'merge') { if (w.mergeFails) return no('base branch policy prohibits the merge'); w.merged = true; return ok(''); }
    if (args[0] !== 'api') return no('unexpected');
    const rawMode = args.includes('-H');
    const path = args[args.length - 1].replace(/^repos\/o\/r/, '');
    const [p0] = path.split('?');
    if (p0 === '') return ok(w.meta);
    if (p0 === '/contents/.trioharness/merge-policy.json') return w.policy == null ? no() : ok(w.policy);
    if (p0 === '/contents/.trioharness/secret-allow.txt') return w.secretAllow == null ? no() : ok(w.secretAllow);
    if (p0 === '/contents/AGENTS.md') return w.agents == null ? no() : ok(w.agents);
    if (p0 === '/contents/.github/workflows') return Object.keys(w.workflows).length ? ok(Object.keys(w.workflows).map(n => ({ name: n, path: `.github/workflows/${n}` }))) : no();
    const wf = /^\/contents\/\.github\/workflows\/(.+)$/.exec(p0); if (wf) return w.workflows[wf[1]] != null ? ok(w.workflows[wf[1]]) : no();
    if (p0 === '/pulls/5') return ok({ ...w.pull, merged: w.merged || w.pull.merged });
    if (p0 === '/pulls/5/files') return ok(/page=1/.test(path) ? w.files : []);
    if (p0 === '/pulls/5/commits') return ok(/page=1/.test(path) ? w.commits : []);
    if (p0 === '/pulls/5/reviews') { const pg = +(/[?&]page=(\d+)/.exec(path)?.[1] || 1); return ok(w.reviews.slice((pg - 1) * 100, pg * 100)); }
    if (/^\/actions\/runs\/\d+\/rerun$/.test(p0)) { if (w.rerunErr) return no(w.rerunErr); w.reruns.push(+p0.split('/')[3]); return ok(''); }
    let m = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(p0); if (m) { const r = w.runs[m[1]] || []; return ok({ total_count: r.length, check_runs: /page=1/.test(path) ? r : [] }); }
    m = /^\/commits\/([0-9a-f]+)\/status$/.exec(p0); if (m) return ok({ statuses: w.statuses[m[1]] || [] });
    if (p0 === '/branches/main') return ok({ commit: { sha: BASEHEAD } });
    if (/^\/compare\//.test(p0)) return ok({ status: w.compare });
    if (p0 === '/actions/runs') return ok({ workflow_runs: w.actionRuns });
    void rawMode; return no(`unexpected ${path}`);
  };
}
const run = async (w, extra = {}) => evaluate({ repo: 'o/r', pr: 5, expectSha: HEAD, ...extra }, { gh: fakeGh(w), now: () => 0, pause: async () => {} });
const codes = v => v.reasons.map(r => r.code);

test('a boring PR in an opted-in repo passes, and the policy is read from the default branch only', async () => {
  const w = world(); const v = await run(w);
  assert.equal(v.verdict, 'PASS', JSON.stringify(v.reasons));
  assert.ok(w.calls.some(c => c.includes('contents/.trioharness/merge-policy.json?ref=main')));
  assert.ok(v.notes.some(n => /ci\.yml runs on push to the default branch \(no deploy-like step found\)/.test(n)), 'dotnet Release/publish is not a deploy');
});

test('no policy, or enabled:false, means not opted in: nothing is auto-merged', async () => {
  assert.equal((await run(world({ policy: null }))).verdict, 'NOT_ENABLED');
  assert.equal((await run(world({ policy: JSON.stringify({ ...POLICY, enabled: false }) }))).verdict, 'NOT_ENABLED');
  const bad = await run(world({ policy: '{nope' })); assert.equal(bad.verdict, 'ERROR'); assert.ok(codes(bad).includes('POLICY_INVALID'));
  const bad2 = await run(world({ policy: JSON.stringify({ ...POLICY, mergeMethod: 'yolo' }) })); assert.equal(bad2.verdict, 'ERROR');
});

test('each sensitive path class needs a person: workflows, deploy config, dependencies, migrations, auth, harness, hooks', async () => {
  for (const f of ['.github/workflows/ci.yml', '.github/merge-verify/merge-verify.mjs', '.trioharness/merge-policy.json', 'AGENTS.md', 'deploy.json', 'infra/main.bicep', 'Dockerfile', 'package.json', 'package-lock.json', 'src/App/App.csproj', 'Directory.Packages.props', 'global.json', 'src/Data/Migrations/001_init.cs', 'db/schema.sql', 'src/Auth/Login.cs', 'appsettings.Production.json', '.husky/pre-commit', 'certs/site.pem']) {
    const v = await run(world({ files: [goodFile, { filename: f, status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '+x' }] }));
    assert.equal(v.verdict, 'NEEDS_APPROVAL', f); assert.ok(codes(v).includes('SENSITIVE_PATH'), f);
  }
  for (const f of ['src/Orders/Pricing.cs', 'docs/guide.md', 'tests/OrderTests.cs', 'web/app/page.tsx', 'README.md']) assert.equal(classifyPath(f), null, f);
  assert.equal(classifyPath('old/a.txt', []), null);
});

test('a rename out of a sensitive path is still sensitive', async () => {
  const v = await run(world({ files: [{ filename: 'src/x.txt', previous_filename: 'package.json', status: 'renamed', additions: 0, deletions: 0, changes: 0 }] }));
  assert.ok(codes(v).includes('SENSITIVE_PATH'));
});

test('repo high-risk paths from AGENTS.md and policy extraSensitive are honoured; template placeholders are not', async () => {
  const md = '# A\n\n## High-risk paths\nChanges here ...:\n- `AGENTS.md`\n- `<e.g. src/Auth/>`\n- `src/Billing/`\n\n## Next\n- `ignored/`\n';
  assert.deepEqual(parseHighRisk(md), ['AGENTS.md', 'src/Billing/']);
  const v = await run(world({ agents: md, files: [{ filename: 'src/Billing/Invoice.cs', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '+x' }] }));
  assert.ok(codes(v).includes('SENSITIVE_PATH'));
  const v2 = await run(world({ policy: JSON.stringify({ ...POLICY, extraSensitive: ['src/Pricing/*.cs'] }), files: [{ filename: 'src/Pricing/A.cs', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '+x' }] }));
  assert.ok(codes(v2).includes('SENSITIVE_PATH'));
});

test('a secret-shaped added line, a secret in a commit message, and an unscannable file all stop it', async () => {
  const f = { filename: 'src/a.cs', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: `@@ -1 +1 @@\n+var k = "${AWS}";` };
  assert.ok(codes(await run(world({ files: [f] }))).includes('SECRET_SHAPED_LINE'));
  assert.ok(codes(await run(world({ commits: [{ sha: HEAD, commit: { message: `key ${AWS}` } }] }))).includes('SECRET_IN_COMMIT_MESSAGE'));
  const big = { filename: 'src/huge.cs', status: 'modified', additions: 500, deletions: 0, changes: 500 };
  assert.ok(codes(await run(world({ files: [big], pull: { ...world().pull, changed_files: 1 } }))).includes('NO_PATCH_TO_SCAN'));
  const img = { filename: 'web/logo.png', status: 'added', additions: 0, deletions: 0, changes: 0 };
  assert.equal((await run(world({ files: [goodFile, img] }))).verdict, 'PASS');
});

test('tests may not shrink: removed test files, removed declarations, added skips', async () => {
  assert.ok(codes(await run(world({ files: [{ filename: 'tests/a.test.ts', status: 'removed', additions: 0, deletions: 9, changes: 9 }] }))).includes('TEST_FILE_REMOVED'));
  const less = { filename: 'tests/OrderTests.cs', status: 'modified', additions: 0, deletions: 4, changes: 4, patch: '@@ -1,4 +0,0 @@\n-[Fact]\n-public void A() {}\n-[Fact]\n-public void B() {}' };
  assert.ok(codes(await run(world({ files: [less] }))).includes('TESTS_REDUCED'));
  const skip = { filename: 'tests/a.test.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: "+  it.skip('later', () => {})" };
  assert.ok(codes(await run(world({ files: [skip] }))).includes('TEST_SKIP_OR_ONLY_ADDED'));
  assert.deepEqual(testReduction([testFile]), []);
});

test('size, drafts, base, forks, branch shape, conflicts, behind, changed head and a missing "Package and config check" each stop it', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ ...goodFile, filename: `src/f${i}.cs` }));
  assert.ok(codes(await run(world({ files: many, pull: { ...world().pull, changed_files: 11 } }))).includes('TOO_MANY_FILES'));
  assert.ok(codes(await run(world({ files: [{ ...goodFile, additions: 300, changes: 300 }] }))).includes('TOO_MANY_LINES'));
  const P = world().pull;
  for (const [over, code] of [[{ draft: true }, 'PR_DRAFT'], [{ base: { ref: 'dev' } }, 'BASE_NOT_DEFAULT'], [{ head: { ...P.head, ref: 'feature/x' } }, 'NOT_AGENT_BRANCH'], [{ head: { ...P.head, repo: { full_name: 'x/y' } } }, 'HEAD_FROM_FORK'], [{ mergeable_state: 'dirty', mergeable: false }, 'CONFLICTS'], [{ mergeable_state: 'behind' }, 'BEHIND'], [{ body: 'no section' }, 'NO_PACKAGE_CONFIG_CHECK'], [{ state: 'closed' }, 'PR_NOT_OPEN']]) {
    assert.ok(codes(await run(world({ pull: { ...P, ...over } }))).includes(code), code);
  }
  assert.ok(codes(await run(world(), { expectSha: 'd'.repeat(40) })).includes('HEAD_CHANGED'));
  assert.ok(codes(await run(world({ meta: { default_branch: 'main', fork: true } }))).includes('FORK'));
});

test('checks: failing, pending, too few; baseline failures only tolerated when allowed and the same check fails on the default branch', async () => {
  const fail = { name: 'e2e', status: 'completed', conclusion: 'failure' };
  const ok = { name: 'build', status: 'completed', conclusion: 'success' };
  assert.ok(codes(await run(world({ runs: { [HEAD]: [ok, fail], [BASEHEAD]: [ok] } }))).includes('CHECK_FAILED'));
  assert.ok(codes(await run(world({ runs: { [HEAD]: [ok, { name: 'slow', status: 'in_progress' }], [BASEHEAD]: [ok] } }))).includes('CHECKS_PENDING'));
  assert.ok(codes(await run(world({ runs: { [HEAD]: [], [BASEHEAD]: [] } }))).includes('TOO_FEW_CHECKS'));
  assert.ok(codes(await run(world({ runs: { [HEAD]: [{ name: 'only-skipped', status: 'completed', conclusion: 'skipped' }], [BASEHEAD]: [] } }))).includes('TOO_FEW_CHECKS'));
  const tol = JSON.stringify({ ...POLICY, allowBaselineFailures: true });
  const same = await run(world({ policy: tol, runs: { [HEAD]: [ok, fail], [BASEHEAD]: [ok, fail] } }));
  assert.equal(same.verdict, 'PASS'); assert.ok(same.notes.some(n => /baseline failures tolerated.*e2e/.test(n)));
  assert.ok(codes(await run(world({ policy: tol, runs: { [HEAD]: [ok, fail], [BASEHEAD]: [ok] } }))).includes('CHECK_FAILED'), 'a new failure is never baseline');
  assert.ok(codes(await run(world({ runs: { [HEAD]: [ok, fail], [BASEHEAD]: [ok, fail] } }))).includes('CHECK_FAILED'), 'tolerance is off by default');
  assert.ok(codes(await run(world({ statuses: { [HEAD]: [{ context: 'ci/legacy', state: 'failure' }] } }))).includes('CHECK_FAILED'));
  assert.ok(codes(await run(world({ policy: JSON.stringify({ ...POLICY, requiredChecks: ['security-scan'] }) }))).includes('REQUIRED_CHECK_MISSING'));
  // its own check never counts against itself
  assert.equal((await run(world({ runs: { [HEAD]: [ok, { name: 'merge-verify', status: 'in_progress' }], [BASEHEAD]: [ok] } }))).verdict, 'PASS');
});

test('pending checks are waited for only when asked, and the wait ends when they finish', async () => {
  const ok = { name: 'build', status: 'completed', conclusion: 'success' };
  const w = world({ runs: { [HEAD]: [ok, { name: 'slow', status: 'in_progress' }], [BASEHEAD]: [ok] } });
  let t = 0; let polls = 0;
  const v = await evaluate({ repo: 'o/r', pr: 5, expectSha: HEAD, waitChecksSec: 120 }, { gh: fakeGh(w), now: () => t, pause: async () => { polls++; t += 20000; if (polls === 2) w.runs[HEAD][1] = { name: 'slow', status: 'completed', conclusion: 'success' }; } });
  assert.equal(v.verdict, 'PASS'); assert.equal(polls, 2);
  const w2 = world({ runs: { [HEAD]: [ok, { name: 'slow', status: 'in_progress' }], [BASEHEAD]: [ok] } });
  t = 0; const v2 = await evaluate({ repo: 'o/r', pr: 5, expectSha: HEAD, waitChecksSec: 40 }, { gh: fakeGh(w2), now: () => t, pause: async () => { t += 20000; } });
  assert.ok(codes(v2).includes('CHECKS_PENDING'));
});

test('in CI the check waits for checks that are not registered on the head yet, then judges them; after the deadline the reasons stand', async () => {
  const ok = { name: 'build-test', status: 'completed', conclusion: 'success' };
  const w = world({ runs: { [HEAD]: [], [BASEHEAD]: [] } });
  let t = 0; let polls = 0;
  const v = await evaluate({ repo: 'o/r', pr: 5, expectSha: HEAD, mode: 'ci', waitChecksSec: 1500 }, { gh: fakeGh(w), now: () => t, pause: async () => { polls++; t += 20000; if (polls === 2) w.runs[HEAD] = [ok]; } });
  assert.equal(v.verdict, 'PASS', JSON.stringify(v.reasons)); assert.ok(!codes(v).includes('TOO_FEW_CHECKS')); assert.equal(polls, 2);
  // a required check that has not appeared yet is waited for even when another check already passed
  const w2 = world({ policy: JSON.stringify({ ...POLICY, requiredChecks: ['build-test'] }), runs: { [HEAD]: [{ name: 'lint', status: 'completed', conclusion: 'success' }], [BASEHEAD]: [] } });
  t = 0; polls = 0;
  const v2 = await evaluate({ repo: 'o/r', pr: 5, expectSha: HEAD, mode: 'ci', waitChecksSec: 1500 }, { gh: fakeGh(w2), now: () => t, pause: async () => { polls++; t += 20000; w2.runs[HEAD] = [...w2.runs[HEAD], ok]; } });
  assert.equal(v2.verdict, 'PASS', JSON.stringify(v2.reasons)); assert.equal(polls, 1);
  t = 0; polls = 0;
  const v3 = await evaluate({ repo: 'o/r', pr: 5, expectSha: HEAD, mode: 'ci', waitChecksSec: 40 }, { gh: fakeGh(world({ runs: { [HEAD]: [], [BASEHEAD]: [] } })), now: () => t, pause: async () => { polls++; t += 20000; } });
  assert.ok(codes(v3).includes('TOO_FEW_CHECKS')); assert.equal(polls, 2, 'gave up at the deadline, not before');
  t = 0; polls = 0;
  const v4 = await evaluate({ repo: 'o/r', pr: 5, expectSha: HEAD, mode: 'ci', waitChecksSec: 1500 }, { gh: fakeGh(world({ runs: { [HEAD]: [{ name: 'build-test', status: 'completed', conclusion: 'failure' }], [BASEHEAD]: [] } })), now: () => t, pause: async () => { polls++; t += 20000; } });
  assert.ok(codes(v4).includes('CHECK_FAILED')); assert.equal(polls, 0, 'a failure is final: no waiting');
});

const SENS = { filename: 'package.json', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '+x' };
const review = (over = {}) => ({ user: { login: 'moshe', type: 'User' }, author_association: 'OWNER', state: 'APPROVED', commit_id: HEAD, ...over });
const ci = async (w, extra = {}) => run(w, { mode: 'ci', ...extra });

test('ci: an owner approval on this exact head accepts the sensitive reasons; the Architect never uses approvals', async () => {
  const w = world({ files: [goodFile, SENS], reviews: [review()] });
  const v = await ci(w);
  assert.equal(v.verdict, 'PASS', JSON.stringify(v.reasons)); assert.equal(v.evidence.approvedBy, 'moshe');
  assert.deepEqual(v.evidence.acceptedByApproval.map(r => r.code), ['SENSITIVE_PATH']);
  assert.ok(v.notes.some(n => /approved by moshe on this exact head .*SENSITIVE_PATH accepted by human approval/.test(n)), JSON.stringify(v.notes));
  const a = await run(world({ files: [goodFile, SENS], reviews: [review()] }));
  assert.equal(a.verdict, 'NEEDS_APPROVAL'); assert.ok(codes(a).includes('SENSITIVE_PATH'));
  const wm = world({ files: [goodFile, SENS], reviews: [review()] });
  assert.equal((await mergePr({ repo: 'o/r', pr: 5, expectSha: HEAD }, { gh: fakeGh(wm), now: () => 0, pause: async () => {} })).merged, false);
  assert.ok(!wm.calls.some(c => c.includes('/reviews')) && !wm.calls.some(c => c.startsWith('pr merge')), 'merge never reads approvals');
  // size, branch name and the missing PR section are a person's call too; reviews are read across pages
  const many = Array.from({ length: 11 }, (_, i) => ({ ...goodFile, filename: `src/f${i}.cs` }));
  const comments = Array.from({ length: 100 }, () => review({ state: 'COMMENTED' }));
  const v2 = await ci(world({ files: many, pull: { ...world().pull, changed_files: 11, body: 'x', head: { ...world().pull.head, ref: 'feature/x' } }, reviews: [...comments, review()] }));
  assert.equal(v2.verdict, 'PASS', JSON.stringify(v2.reasons));
  assert.deepEqual(v2.evidence.acceptedByApproval.map(r => r.code).sort(), ['NOT_AGENT_BRANCH', 'NO_PACKAGE_CONFIG_CHECK', 'TOO_MANY_FILES']);
});

test('ci: no approval counts when it is on an older commit, by a bot, by the PR author, by an outsider, or later turned into changes requested', async () => {
  const P = world().pull;
  for (const [why, over] of [
    ['older commit', { reviews: [review({ commit_id: 'e'.repeat(40) })] }],
    ['bot', { reviews: [review({ user: { login: 'helper[bot]', type: 'Bot' } })] }],
    ['PR author', { pull: { ...P, user: { login: 'moshe', type: 'User' } }, reviews: [review()] }],
    ['outsider', { reviews: [review({ author_association: 'CONTRIBUTOR' })] }],
    ['changes requested later', { reviews: [review(), review({ state: 'CHANGES_REQUESTED' }), review({ state: 'COMMENTED' })] }],
    ['another owner requests changes', { reviews: [review(), review({ user: { login: 'dana', type: 'User' }, state: 'CHANGES_REQUESTED' })] }],
    ['dismissed', { reviews: [review({ state: 'DISMISSED' })] }],
    ['no author known', { pull: { ...P, user: null }, reviews: [review()] }]
  ]) {
    const v = await ci(world({ files: [goodFile, SENS], ...over }));
    assert.equal(v.verdict, 'NEEDS_APPROVAL', why); assert.ok(codes(v).includes('SENSITIVE_PATH'), why); assert.equal(v.evidence.approvedBy, undefined, why);
  }
});

test('ci: an approval never accepts a hard reason (failed check, deploy on merge, secret, fewer tests, moved head)', async () => {
  const fail = { name: 'e2e', status: 'completed', conclusion: 'failure' }; const ok = { name: 'build', status: 'completed', conclusion: 'success' };
  const v = await ci(world({ files: [goodFile, SENS], reviews: [review()], runs: { [HEAD]: [ok, fail], [BASEHEAD]: [ok] } }));
  assert.equal(v.verdict, 'NEEDS_APPROVAL'); assert.ok(codes(v).includes('CHECK_FAILED') && codes(v).includes('SENSITIVE_PATH'));
  assert.equal((await ci(world({ files: [goodFile, SENS], reviews: [review()], workflows: { 'deploy.yml': CI_DEPLOY } }))).verdict, 'DEPLOY_ON_MERGE');
  const secret = { filename: 'src/a.cs', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: `@@ -1 +1 @@\n+var k = "${AWS}";` };
  assert.ok(codes(await ci(world({ files: [SENS, secret], reviews: [review()] }))).includes('SECRET_SHAPED_LINE'));
  assert.ok(codes(await ci(world({ files: [SENS, { filename: 'tests/a.test.ts', status: 'removed', additions: 0, deletions: 9, changes: 9 }], reviews: [review()] }))).includes('TEST_FILE_REMOVED'));
  assert.ok(codes(await ci(world({ files: [goodFile, SENS], reviews: [review({ commit_id: 'd'.repeat(40) })] }), { expectSha: 'd'.repeat(40) })).includes('HEAD_CHANGED'));
});

test('recheck re-runs the latest merge-verify run for the PR head and says clearly when GitHub refuses (403)', async () => {
  const runs = [{ id: 7, name: 'ci', path: '.github/workflows/ci.yml', status: 'completed', created_at: '2026-10-28T11:00:00Z' },
    { id: 8, name: 'merge-verify', path: '.github/workflows/merge-verify.yml', status: 'completed', conclusion: 'failure', created_at: '2026-10-28T09:00:00Z' },
    { id: 9, name: 'merge-verify', path: '.github/workflows/merge-verify.yml', status: 'completed', conclusion: 'failure', created_at: '2026-10-28T10:00:00Z', html_url: 'https://github.com/o/r/actions/runs/9' }];
  let w = world({ actionRuns: runs }); let r = MV.recheck({ repo: 'o/r', pr: 5 }, { gh: fakeGh(w) });
  assert.equal(r.verdict, 'RERUN_REQUESTED', JSON.stringify(r)); assert.equal(r.run.id, 9); assert.deepEqual(w.reruns, [9]);
  assert.ok(w.calls.includes(`api repos/o/r/actions/runs?head_sha=${HEAD}&per_page=100`));
  assert.ok(w.calls.includes('api -X POST repos/o/r/actions/runs/9/rerun'));
  w = world({ actionRuns: runs, rerunErr: 'gh: Resource not accessible by integration (HTTP 403)' }); r = MV.recheck({ repo: 'o/r', pr: 5 }, { gh: fakeGh(w) });
  assert.equal(r.verdict, 'RERUN_FORBIDDEN'); assert.match(r.hint, /Actions: Read and write/); assert.match(r.hint, /owner/);
  w = world({ actionRuns: [runs[0]] }); r = MV.recheck({ repo: 'o/r', pr: 5 }, { gh: fakeGh(w) });
  assert.equal(r.verdict, 'NO_RUN'); assert.ok(!w.calls.some(c => c.includes('-X POST')));
  w = world({ actionRuns: [{ ...runs[2], status: 'in_progress' }] }); r = MV.recheck({ repo: 'o/r', pr: 5 }, { gh: fakeGh(w) });
  assert.equal(r.verdict, 'RUN_IN_PROGRESS'); assert.ok(!w.calls.some(c => c.includes('-X POST')));
  const wf = readFileSync(join(here, '..', 'templates', 'repo', 'github', 'merge-verify.example.yml'), 'utf8');
  assert.doesNotMatch(wf.replace(/^#.*$/gm, ''), /pull_request_review/, 'a review trigger would run the workflow file from the PR'); assert.match(wf, /recheck/);
});

test('merging must not trigger a deploy: a deploy-like workflow on the default branch makes it DEPLOY_ON_MERGE', async () => {
  const v = await run(world({ workflows: { 'ci.yml': CI_SAFE, 'deploy.yml': CI_DEPLOY } }));
  assert.equal(v.verdict, 'DEPLOY_ON_MERGE'); assert.ok(v.reasons.some(r => r.code === 'DEPLOY_ON_MERGE' && /deploy\.yml/.test(r.detail)));
  assert.equal((await run(world({ workflows: {} }))).verdict, 'PASS', 'no workflows at all is fine');
});

test('workflow trigger analysis: branch filters, ignores, tags only, closed PRs, workflow_run, inline lists', () => {
  const t = (on, extra = '  build:\n    steps:\n      - run: echo hi\n') => analyzeWorkflow(`name: x\n${on}\njobs:\n${extra}`, 'main');
  assert.equal(t('on:\n  push:\n    branches: [main]').triggers, true);
  assert.equal(t('on:\n  push:\n    branches:\n      - develop').triggers, false);
  assert.equal(t('on:\n  push:\n    branches:\n      - "release/**"\n      - main').triggers, true);
  assert.equal(t('on:\n  push:\n    branches-ignore:\n      - main').triggers, false);
  assert.equal(t('on:\n  push:\n    tags:\n      - "v*"').triggers, false);
  assert.equal(t('on:\n  push:').triggers, true);
  assert.equal(t('on: push').triggers, true);
  assert.equal(t('on: [pull_request, workflow_dispatch]').triggers, false);
  assert.equal(t('on:\n  pull_request:\n    types: [closed]').triggers, true);
  assert.equal(t('on:\n  workflow_run:\n    workflows: [ci]').triggers, true);
  assert.equal(t('on:\n  schedule:\n    - cron: "0 3 * * *"').triggers, false);
  assert.equal(analyzeWorkflow('name: x\njobs: {}', 'main').triggers, true, 'unreadable means assume it runs');
  assert.equal(t('on: push', '  b:\n    steps:\n      - run: gh release create v1\n').deployish, true);
  assert.equal(t('on: push', '  b:\n    steps:\n      - run: dotnet build -c Release\n      - run: dotnet publish\n').deployish, false);
});

test('merge: only a PASS is merged, with the verified head pinned; a refusal is reported, never worked around', async () => {
  const w = world(); const r = await mergePr({ repo: 'o/r', pr: 5, expectSha: HEAD }, { gh: fakeGh(w), now: () => 0, pause: async () => {} });
  assert.equal(r.verdict, 'MERGED'); assert.equal(r.merged, true);
  const call = w.calls.find(c => c.startsWith('pr merge')); assert.match(call, /--repo o\/r/); assert.match(call, /--merge/); assert.match(call, new RegExp(`--match-head-commit ${HEAD}`)); assert.doesNotMatch(call, /--admin|--auto/);
  const w2 = world({ mergeFails: true }); const r2 = await mergePr({ repo: 'o/r', pr: 5, expectSha: HEAD }, { gh: fakeGh(w2), now: () => 0, pause: async () => {} });
  assert.equal(r2.verdict, 'MERGE_REFUSED'); assert.equal(r2.merged, false); assert.match(r2.hint, /approval card/);
  const w3 = world({ files: [{ filename: 'package.json', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '+x' }] });
  const r3 = await mergePr({ repo: 'o/r', pr: 5, expectSha: HEAD }, { gh: fakeGh(w3), now: () => 0, pause: async () => {} });
  assert.equal(r3.merged, false); assert.ok(!w3.calls.some(c => c.startsWith('pr merge')), 'no merge call at all');
  const r4 = await mergePr({ repo: 'o/r', pr: 5 }, { gh: fakeGh(world()) }); assert.equal(r4.verdict, 'ERROR');
  const w5 = world({ policy: JSON.stringify({ ...POLICY, mergeMethod: 'squash' }) }); await mergePr({ repo: 'o/r', pr: 5, expectSha: HEAD }, { gh: fakeGh(w5), now: () => 0, pause: async () => {} });
  assert.match(w5.calls.find(c => c.startsWith('pr merge')), /--squash/);
});

test('after a merge: on the default branch, nothing deploy-like started, default branch not red', async () => {
  const deps = w => ({ gh: fakeGh(w), now: () => 0, pause: async () => {} });
  let w = world({ merged: true, actionRuns: [{ name: 'ci', event: 'push', status: 'completed', conclusion: 'success' }] });
  assert.equal((await postMerge({ repo: 'o/r', pr: 5, waitSec: 0 }, deps(w))).verdict, 'POST_OK');
  w = world({ merged: true, actionRuns: [{ name: 'Deploy to QA', event: 'push', status: 'in_progress' }] });
  const d = await postMerge({ repo: 'o/r', pr: 5, waitSec: 0 }, deps(w)); assert.equal(d.verdict, 'POST_ATTENTION'); assert.ok(codes(d).includes('DEPLOY_STARTED'));
  w = world({ merged: true, actionRuns: [{ name: 'ci', event: 'push', status: 'completed', conclusion: 'failure' }] });
  assert.ok(codes(await postMerge({ repo: 'o/r', pr: 5, waitSec: 0 }, deps(w))).includes('DEFAULT_BRANCH_RED'));
  w = world({ merged: true, compare: 'behind' }); assert.ok(codes(await postMerge({ repo: 'o/r', pr: 5, waitSec: 0 }, deps(w))).includes('MERGE_NOT_ON_DEFAULT'));
  w = world(); assert.ok(codes(await postMerge({ repo: 'o/r', pr: 5, waitSec: 0 }, deps(w))).includes('NOT_MERGED'));
});

test('a run ledger with gates not passed, or an open question card, stops the Architect; a finished one does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mv-ledger-')); const runId = '20261028-fix-abcd';
  const rd = join(dir, '.trioharness-direct', 'runs', runId); mkdirSync(rd, { recursive: true });
  const gates = s => Object.fromEntries(['guard-proof', 'done-jev', 'commit-push'].map(g => [g, { status: s }]));
  writeFileSync(join(rd, 'state.json'), JSON.stringify({ run: runId, gates: gates('in_progress') }));
  assert.ok(codes(await run(world(), { checkout: dir, run: runId })).includes('GATE_NOT_PASSED'));
  writeFileSync(join(rd, 'state.json'), JSON.stringify({ run: runId, gates: gates('passed') }));
  assert.equal((await run(world(), { checkout: dir, run: runId })).verdict, 'PASS');
  writeFileSync(join(rd, 'state.json'), JSON.stringify({ run: runId, gates: { ...gates('passed'), 'deploy-qa': { status: 'passed' } } }));
  assert.ok(codes(await run(world(), { checkout: dir, run: runId })).includes('GATE_NOT_PASSED'), 'a QA deploy needs its browser test');
  assert.ok(codes(await run(world(), { checkout: dir, run: 'no-such-run-1234' })).includes('RUN_UNKNOWN'));
});

test('the ruleset the owner approves requires the check and a PR, forbids force pushes and deletion, and has no bypass of its own', () => {
  const r = rulesetJson(); assert.equal(r.enforcement, 'active'); assert.deepEqual(r.bypass_actors, []);
  const types = r.rules.map(x => x.type); for (const t of ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']) assert.ok(types.includes(t), t);
  assert.deepEqual(r.rules.find(x => x.type === 'required_status_checks').parameters.required_status_checks, [{ context: 'merge-verify' }]);
  assert.equal(r.rules.find(x => x.type === 'required_status_checks').parameters.strict_required_status_checks_policy, true);
});

test('policy validation rejects unknown methods and silly limits; defaults are off', () => {
  assert.equal(DEFAULT_POLICY.enabled, false);
  assert.ok(validatePolicy({ ...POLICY, maxFiles: 0 }).errors.length); assert.ok(validatePolicy({ ...POLICY, maxChangedLines: 99999 }).errors.length);
  assert.ok(validatePolicy({ ...POLICY, extraSensitive: [3] }).errors.length); assert.ok(validatePolicy([]).errors.length);
  assert.deepEqual(validatePolicy(POLICY).errors, []);
});

test('install writes the check, its three helper files and a policy once, and never overwrites an existing policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mv-install-'));
  const skill = resolve(here, '..');
  const out = install(dir, skill);
  for (const f of ['.github/merge-verify/merge-verify.mjs', '.github/merge-verify/secret-patterns.mjs', '.github/merge-verify/is-main.mjs', '.github/workflows/merge-verify.yml', '.trioharness/merge-policy.json']) { assert.ok(out.includes(f), f); assert.ok(existsSync(join(dir, f)), f); }
  const wf = readFileSync(join(dir, '.github/workflows/merge-verify.yml'), 'utf8');
  assert.match(wf, /pull_request_target/); assert.match(wf, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/); assert.match(wf, /persist-credentials: false/);
  assert.doesNotMatch(wf, /github\.event\.pull_request\.head\.(ref|repo)/, 'the PR is never checked out');
  writeFileSync(join(dir, '.trioharness/merge-policy.json'), '{"version":1,"enabled":false}\n');
  const again = install(dir, skill); assert.ok(!again.includes('.trioharness/merge-policy.json')); assert.match(readFileSync(join(dir, '.trioharness/merge-policy.json'), 'utf8'), /"enabled":false/);
});

const S6_MERGE_GOLDEN = {"stdout": "{\n  \"verdict\": \"MERGED\",\n  \"repo\": \"o/r\",\n  \"pr\": 5,\n  \"head\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\n  \"policy\": {\n    \"version\": 1,\n    \"enabled\": true,\n    \"mergeMethod\": \"merge\",\n    \"maxFiles\": 10,\n    \"maxChangedLines\": 200,\n    \"extraSensitive\": [],\n    \"allowBaselineFailures\": false,\n    \"requiredChecks\": [],\n    \"requireBodySection\": true,\n    \"minChecks\": 1\n  },\n  \"reasons\": [],\n  \"notes\": [\n    \".github/workflows/ci.yml runs on push to the default branch (no deploy-like step found)\"\n  ],\n  \"evidence\": {\n    \"defaultBranch\": \"main\",\n    \"policy\": {\n      \"mergeMethod\": \"merge\",\n      \"maxFiles\": 10,\n      \"maxChangedLines\": 200\n    },\n    \"head\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\n    \"headRef\": \"bambooed/20261028-fix-abcd\",\n    \"files\": 2,\n    \"changedLines\": 20\n  },\n  \"merged\": true\n}\n", "stderr": "MERGED\n", "code": 0};
import { chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function s6MergeFixture() {
  const root=mkdtempSync(join(tmpdir(),'s6-mv-')); const bin=join(root,'bin'); mkdirSync(bin);
  const calls=join(root,'calls.jsonl');
  const script = '#!/usr/bin/env node\nconst fs=require("node:fs");fs.appendFileSync('+JSON.stringify(calls)+',JSON.stringify({args:process.argv.slice(2),env:process.env})+"\\n");if(process.argv[2]==="env"){process.stdout.write(JSON.stringify(process.env));process.exit(0);}const BASEHEAD='+JSON.stringify(BASEHEAD)+';const w='+JSON.stringify(world())+';const fakeGh='+fakeGh.toString()+';const r=fakeGh(w)(process.argv.slice(2));process.stdout.write(r.out||"");process.stderr.write(r.err||"");process.exitCode=r.ok?0:1;';
  writeFileSync(join(bin,'gh'),script); chmodSync(join(bin,'gh'),0o755);
  const rd=join(root,'.trioharness-direct','runs','s6-mv');mkdirSync(rd,{recursive:true});
  writeFileSync(join(rd,'state.json'),JSON.stringify({gates:Object.fromEntries(['guard-proof','done-jev','commit-push'].map(g=>[g,{status:'passed'}]))}));
  return {root,rd,bin,calls,argv:['merge','--repo','o/r','--pr','5','--expect-sha',HEAD,'--checkout',root,'--run','s6-mv']};
}
async function s6WithGh(t, fn) {
  const prev=process.env.PATH; process.env.PATH=t.bin+':'+prev;
  try{return await fn();} finally {process.env.PATH=prev;}
}
async function s6Main(t, deps) {
  let stdout='',stderr='';const out=console.log,err=console.error;
  console.log=s=>{stdout+=s+'\n';};console.error=s=>{stderr+=s+'\n';};
  try {return {code:await MV.main(t.argv,deps), get stdout(){return stdout;},get stderr(){return stderr;}};}
  finally {console.log=out;console.error=err;}
}
test('hf5b1e-s6-p-mv-01 main without injected hook retains base golden bytes',async()=>{
  const t=s6MergeFixture();assert.deepEqual(await s6WithGh(t,()=>s6Main(t)),S6_MERGE_GOLDEN);
});
test('hf5b1e-s6-p-mv-02 ghCli without env preserves the caller environment',async()=>{
  const t=s6MergeFixture();await s6WithGh(t,()=>{
    const before={...process.env};const r=MV.ghCli(['env']);assert.equal(r.ok,true);assert.deepEqual(JSON.parse(r.out),before);assert.deepEqual({...process.env},before);
  });
});

import { pathToFileURL } from 'node:url';
function s6FailureLines(t) {const f=join(t.rd,'issues-failures.jsonl');assert.ok(existsSync(f),'durable hook failure log exists');return readFileSync(f,'utf8').trim().split('\n').map(s=>JSON.parse(s));}
function s6Allowlisted(line,event,category) {
  assert.ok(Object.keys(line).every(k=>['v','kind','ts','run','event','category','key'].includes(k)));assert.equal(line.v,1);assert.equal(line.kind,'failure');assert.equal(line.event,event);assert.equal(line.category,category);assert.equal(new Date(line.ts).toISOString(),line.ts);
}
test('hf5b1e-s6-d-mv-01 merged main calls transition after printing with complete options',async()=>{
  const t=s6MergeFixture();const calls=[];const result=await s6WithGh(t,()=>s6Main(t,{loadIssues:async()=>({transitionForEvent:async(event,opts)=>{calls.push({event,opts});}})}));
  assert.equal(calls.length,1);assert.equal(calls[0].event,'merged');assert.deepEqual(calls[0].opts,{repo:'o/r',ledger:t.root,run:'s6-mv',target:undefined,sha:HEAD,revision:undefined,toSha:undefined,toRevision:undefined});assert.deepEqual(result,S6_MERGE_GOLDEN);
  for(const argv of [t.argv.filter((a,i,all)=>a!=='--run' && all[i-1]!=='--run'),['check',...t.argv.slice(1)]]) {let called=false;const original=t.argv;t.argv=argv;await s6WithGh(t,()=>s6Main(t,{loadIssues:async()=>{called=true;return {};}}));t.argv=original;assert.equal(called,false);}
});
test('hf5b1e-s6-d-mv-02 failed pending throwing or rejecting hooks retain golden bytes',async()=>{
  let invoked=0;
  for(const loadIssues of [async()=>({transitionForEvent:async()=>{invoked++;return {ok:false,pending:true};}}),async()=>({transitionForEvent:async()=>{invoked++;throw new Error('hook')}}),async()=>{invoked++;throw new Error('import')}]) {
    const t=s6MergeFixture();assert.deepEqual(await s6WithGh(t,()=>s6Main(t,{loadIssues})),S6_MERGE_GOLDEN);
  }assert.equal(invoked,3);
});
test('hf5b1e-s6-d-mv-03 missing and broken imports append one import-stage failure',async()=>{
  for(const broken of [false,true]) {const t=s6MergeFixture();const file=join(t.root,'broken.mjs');if(broken)writeFileSync(file,'export const = ;');
    const result=await s6WithGh(t,()=>s6Main(t,{loadIssues:()=>import(pathToFileURL(file).href)}));assert.deepEqual(result,S6_MERGE_GOLDEN);const lines=s6FailureLines(t);assert.equal(lines.length,1);s6Allowlisted(lines[0],'merged','IMPORT_FAILED');assert.equal(lines[0].run,'s6-mv');
  }
});
test('hf5b1e-s6-d-mv-04 thrown credential-shaped errors never enter host output or records',async()=>{
  for(const value of ['pass'+'word=ab1','https://'+'user:pw@host/x']) {const t=s6MergeFixture();const e=new Error(value);e.code=value;e.name=value;
    const result=await s6WithGh(t,()=>s6Main(t,{loadIssues:async()=>({transitionForEvent:async()=>{throw e;}})}));assert.deepEqual(result,S6_MERGE_GOLDEN);const lines=s6FailureLines(t);assert.equal(lines.length,1);s6Allowlisted(lines[0],'merged','OTHER');assert.doesNotMatch(JSON.stringify(lines)+result.stdout+result.stderr,/password|user:pw|Error/);
  }
});
test('hf5b1e-s6-d-mv-05 owner merge retains host env while injected issue runner scrubs it',async()=>{
  const t=s6MergeFixture();const saved=process.env.GH_TOKEN;process.env.GH_TOKEN=['host','sentinel'].join('-');let observed;
  try {const result=await s6WithGh(t,()=>s6Main(t,{loadIssues:async()=>({transitionForEvent:async()=>{const env={...process.env};for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GH_HOST','GH_REPO'])delete env[key];env.GH_PROMPT_DISABLED='1';observed=MV.ghCli(['env'],undefined,{env});}})}));assert.ok(observed,'issue runner invoked');assert.deepEqual(result,S6_MERGE_GOLDEN);assert.equal(JSON.parse(observed.out).GH_TOKEN,undefined);
    const calls=readFileSync(t.calls,'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(calls.find(c=>c.args[0]==='pr').env.GH_TOKEN,process.env.GH_TOKEN);
  }finally{if(saved===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=saved;}
});
test('hf5b1e-s6-d-mv-06 ghCli optional env is exact and does not mutate caller',async()=>{
  const t=s6MergeFixture();await s6WithGh(t,()=>{const before={...process.env};const env={PATH:process.env.PATH,S6_ENV:'explicit',...(process.platform==='darwin'?{__CF_USER_TEXT_ENCODING:before.__CF_USER_TEXT_ENCODING}:{})};const r=MV.ghCli(['env'],'input',{env});assert.equal(r.ok,true);assert.deepEqual(JSON.parse(r.out),env);assert.deepEqual({...process.env},before);});
});


test('v3 pin: credential source still needs owner approval for current and previous names', async () => {
  assert.equal(classifyPath('src/credentials.rs'), 'secret-file');
  for (const file of [
    { filename: 'src/credentials.rs', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '+pub fn credentials() {}' },
    { filename: 'src/renamed.rs', previous_filename: 'src/credentials.rs', status: 'renamed', additions: 1, deletions: 0, changes: 1, patch: '+pub fn credentials() {}' }
  ]) {
    const verdict = await run(world({ files: [file], secretAllow: 'src/credentials.rs name # reviewed source\n' }));
    assert.equal(verdict.verdict, 'NEEDS_APPROVAL', JSON.stringify(verdict));
    assert.ok(codes(verdict).includes('SENSITIVE_PATH'));
  }
});

test('local audit with Jev suspended still blocks CI, secret hits and moved heads', async t => {
  const checkout = mkdtempSync(join(tmpdir(), 'mv-jev-suspended-'));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  const runId = '20261124-no-jev';
  const dir = join(checkout, '.trioharness-direct', 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    run: runId, gates: { 'guard-proof': { status: 'passed' }, 'commit-push': { status: 'passed' } },
  }));
  const local = { checkout, run: runId };
  const result = await run(world(), local);
  if (JEV_RECEIPT_REQUIRED) assert.ok(codes(result).includes('GATE_NOT_PASSED'));
  else assert.equal(result.verdict, 'PASS', JSON.stringify(result.reasons));
  const failed = world({ runs: { [HEAD]: [{ name: 'build', status: 'completed', conclusion: 'failure' }] } });
  assert.ok(codes(await run(failed, local)).includes('CHECK_FAILED'));
  const secret = { ...goodFile, patch: `@@ -1 +1 @@\n+key = "${AWS}"` };
  assert.ok(codes(await run(world({ files: [secret] }), local)).includes('SECRET_SHAPED_LINE'));
  assert.ok(codes(await run(world(), { ...local, expectSha: 'd'.repeat(40) })).includes('HEAD_CHANGED'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    run: runId, gates: Object.fromEntries(['guard-proof', 'commit-push', 'done-jev'].map(gate =>
      [gate, { status: 'passed' }])),
  }));
  assert.equal((await run(world(), local)).verdict, 'PASS');
});
