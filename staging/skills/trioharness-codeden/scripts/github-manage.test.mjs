import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, audit, verifiedMerge } from './github-setup.mjs';
import { rulesetJson } from './merge-verify.mjs';

const OLD = { id: 11, name: 'Require approval before merge', enforcement: 'active', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }], rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }] };
const NOAPPROVAL = { id: 12, name: 'No force push', enforcement: 'active', target: 'branch', bypass_actors: [], rules: [{ type: 'non_fast_forward' }] };

function world(over = {}) {
  const w = {
    info: { id: 1, private: true, default_branch: 'main', allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false, delete_branch_on_merge: true, security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } },
    ref: { id: 2, private: true, default_branch: 'main', allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false, delete_branch_on_merge: true },
    alerts: true, rulesets: [OLD, NOAPPROVAL], refRulesets: [{ id: 7, name: 'Require approval before merge' }],
    files: { 'AGENTS.md': 'x', '.github/workflows/ci.yml': 'x', '.github/pull_request_template.md': 'x', '.trioharness/merge-policy.json': '{"version":1,"enabled":true}', '.github/workflows/merge-verify.yml': 'x', '.github/merge-verify/merge-verify.mjs': 'x' },
    prs: [{ number: 4, head: { sha: 'f'.repeat(40) } }], checks: { ['f'.repeat(40)]: [{ name: 'merge-verify', conclusion: 'success' }] },
    patched: [], posted: [], calls: [], patchFails: [], postFails: false, ...over
  };
  return w;
}
function fakeGh(w) {
  return (args, input) => {
    const a = args.join(' '); w.calls.push(a);
    const ok = o => ({ ok: true, out: typeof o === 'string' ? o : JSON.stringify(o) }); const no = e => ({ ok: false, out: '', err: e || 'Not Found' });
    if (args.includes('-H')) { const m = /contents\/(.+?)\?ref=/.exec(a); return m && w.files[m[1]] != null ? ok(w.files[m[1]]) : no(); }
    if (a === 'api repos/o/r') return ok(w.info);
    if (a === 'api repos/o/ref') return ok(w.ref);
    if (a === 'api repos/o/r/vulnerability-alerts') return w.alerts ? ok('') : no();
    if (a === 'api repos/o/r/rulesets') return ok(w.rulesets.map(r => ({ id: r.id, name: r.name, enforcement: r.enforcement })));
    if (a === 'api repos/o/ref/rulesets') return ok(w.refRulesets);
    let m = /^api repos\/o\/r\/rulesets\/(\d+)$/.exec(a); if (m) return ok(w.rulesets.find(r => r.id === +m[1]));
    if (a.startsWith('api repos/o/r/pulls?state=all')) return ok(w.prs);
    m = /commits\/([0-9a-f]+)\/check-runs/.exec(a); if (m) return ok({ check_runs: w.checks[m[1]] || [] });
    m = /^api -X PUT repos\/o\/r\/rulesets\/(\d+) --input -$/.exec(a); if (m) { if (w.patchFails.includes(+m[1])) return no('Forbidden'); w.patched.push({ id: +m[1], body: JSON.parse(input) }); return ok({}); }
    if (a === 'api -X POST repos/o/r/rulesets --input -') { if (w.postFails) return no('Forbidden'); w.posted.push(JSON.parse(input)); return ok({}); }
    if (a.startsWith('api -X')) return ok({});
    return no(`unexpected ${a}`);
  };
}
const mv = (w, o = {}) => verifiedMerge({ repo: 'o/r', ...o }, { gh: fakeGh(w), ruleset: rulesetJson() });

test('converge never creates a repository; it only fills in what is missing on one that exists', () => {
  const w = world(); w.info = null;
  const gh = (args) => (args.join(' ') === 'api repos/o/r' ? { ok: false, out: '', err: 'Not Found' } : { ok: true, out: '{}' });
  const r = apply({ repo: 'o/r', reference: 'o/ref', confirm: true, existing: true }, { gh });
  assert.equal(r.failed[0].id, 'create'); assert.match(r.failed[0].note, /never creates/); assert.equal(r.done.length, 0);
});

test('audit is read-only and lists every gap with the fix', () => {
  const w = world({ alerts: false, files: { 'AGENTS.md': 'x' }, rulesets: [], info: { ...world().info, allow_squash_merge: true, security_and_analysis: {} } });
  const r = audit({ repo: 'o/r', reference: 'o/ref' }, { gh: fakeGh(w) });
  const ids = r.gaps.map(g => g.id);
  for (const id of ['settings', 'alerts', 'scanning', 'rulesets', 'default-branch', 'file:.github/workflows/ci.yml', 'file:.trioharness/merge-policy.json', 'file:.github/workflows/merge-verify.yml', 'verified-merge']) assert.ok(ids.includes(id), id);
  assert.ok(r.ok.includes('private')); assert.ok(r.gaps.every(g => g.fix));
  assert.ok(w.calls.every(c => !/-X (PATCH|POST|PUT|DELETE)/.test(c)), 'audit never writes');
  const clean = audit({ repo: 'o/r', reference: 'o/ref' }, { gh: fakeGh(world()) });
  assert.deepEqual(clean.gaps.map(g => g.id), ['verified-merge']);
  assert.equal(audit({ repo: 'o/r', reference: 'o/ref' }, { gh: () => ({ ok: false, out: '', err: 'x' }) }).error.length > 0, true);
});

test('verified-merge without --confirm changes nothing and says exactly what it would do', () => {
  const w = world(); const r = mv(w);
  assert.equal(r.plan, true); assert.equal(w.posted.length, 0); assert.equal(w.patched.length, 0);
  assert.ok(r.steps.some(s => /add the "Verified merge" ruleset.*1 actor/.test(s))); assert.ok(r.steps.some(s => /DISABLE \(not delete\) "Require approval before merge"/.test(s)));
});

test('the switch adds the new ruleset FIRST (with the old bypass actors), then disables the old one, never deleting', () => {
  const w = world(); const r = mv(w, { confirm: true });
  assert.deepEqual(r.blocked, []);
  assert.equal(w.posted.length, 1); assert.equal(w.posted[0].name, 'Verified merge'); assert.deepEqual(w.posted[0].bypass_actors, OLD.bypass_actors);
  assert.deepEqual(w.patched, [{ id: 11, body: { enforcement: 'disabled' } }], 'only the approval ruleset is disabled; the force-push ruleset stays');
  const iPost = w.calls.findIndex(c => c.includes('-X POST')); const iPatch = w.calls.findIndex(c => c.includes('-X PUT'));
  assert.ok(iPost >= 0 && iPost < iPatch, 'added before the old one is loosened');
  assert.ok(w.calls.every(c => !/-X DELETE/.test(c)));
  assert.match(r.rollback, /--rollback --restore 11/);
});

test('it refuses without proof: no policy, no files, never seen passing, or the policy disabled', () => {
  for (const [over, id] of [[{ files: { ...world().files, '.trioharness/merge-policy.json': '{"version":1,"enabled":false}' } }, 'policy'], [{ files: { ...world().files, '.github/workflows/merge-verify.yml': undefined } }, 'files'], [{ checks: {} }, 'proof'], [{ prs: [] }, 'proof']]) {
    const w = world(over); const r = mv(w, { confirm: true });
    assert.ok(r.blocked.some(b => b.id === id), id); assert.equal(w.posted.length, 0, id); assert.equal(w.patched.length, 0, id);
  }
  const failing = world({ checks: { ['f'.repeat(40)]: [{ name: 'merge-verify', conclusion: 'failure' }] } });
  assert.ok(mv(failing, { confirm: true }).blocked.some(b => b.id === 'proof'), 'a failing check is not proof');
});

test('if adding the new ruleset fails nothing is loosened; if disabling the old one fails it stays active (stricter, never unprotected)', () => {
  let w = world({ postFails: true }); let r = mv(w, { confirm: true });
  assert.ok(r.blocked.some(b => b.id === 'add')); assert.equal(w.patched.length, 0);
  w = world({ patchFails: [11] }); r = mv(w, { confirm: true });
  assert.ok(r.blocked.some(b => b.id === 'disable' && /still active/.test(b.note))); assert.equal(r.rollback, null);
});

test('running it twice does not add a second ruleset', () => {
  const w = world({ rulesets: [OLD, NOAPPROVAL, { id: 20, name: 'Verified merge', enforcement: 'active', rules: [] }] });
  const r = mv(w, { confirm: true }); assert.equal(w.posted.length, 0); assert.ok(r.done.some(d => d.id === 'already'));
});

test('rollback re-enables the listed rulesets and disables Verified merge', () => {
  const w = world({ rulesets: [{ ...OLD, enforcement: 'disabled' }, NOAPPROVAL, { id: 20, name: 'Verified merge', enforcement: 'active', rules: [] }] });
  const r = mv(w, { rollback: true, restore: ['11'] });
  assert.deepEqual(w.patched.map(p => [p.id, p.body.enforcement]), [[11, 'active'], [20, 'disabled']]); assert.deepEqual(r.blocked, []);
});

test('an existing but switched-off Verified merge is switched ON before the old ruleset is disabled', () => {
  const w = world({ rulesets: [OLD, NOAPPROVAL, { id: 20, name: 'Verified merge', enforcement: 'disabled', rules: [] }] });
  const r = mv(w, { confirm: true });
  assert.deepEqual(w.patched.map(p => [p.id, p.body.enforcement]), [[20, 'active'], [11, 'disabled']]); assert.deepEqual(r.blocked, []);
  const w2 = world({ rulesets: [OLD, { id: 20, name: 'Verified merge', enforcement: 'disabled', rules: [] }], patchFails: [20] });
  const r2 = mv(w2, { confirm: true }); assert.ok(r2.blocked.some(b => b.id === 'activate')); assert.equal(w2.patched.length, 0, 'the old ruleset stays active');
});
