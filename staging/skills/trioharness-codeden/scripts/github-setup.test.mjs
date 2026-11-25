import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, cleanRuleset, setupSteps, verifiedMerge } from './github-setup.mjs';

function fakeGh(state) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    const a = args.join(' ');
    const ok = out => ({ ok: true, out: typeof out === 'string' ? out : JSON.stringify(out) });
    if (a === 'api repos/o/ref') return ok({ id: 1, private: true, allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false, delete_branch_on_merge: true });
    if (a === 'api repos/o/new') return state.exists ? ok({ id: 2, private: state.private ?? true }) : (state.created ? ok({ id: 2, private: state.createdPrivate ?? true }) : { ok: false, out: '', err: 'Not Found' });
    if (args[0] === 'repo' && args[1] === 'create') { state.created = true; state.createArgs = args; return ok(''); }
    if (a === 'api repos/o/ref/rulesets') return ok([{ id: 7, name: 'Require approval before merge' }]);
    if (a === 'api repos/o/ref/rulesets/7') return ok({ id: 7, name: 'Require approval before merge', enforcement: 'active', source: 'o/ref', node_id: 'x', _links: {}, rules: [{ type: 'pull_request' }], conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } } });
    if (a === 'api repos/o/new/rulesets') return ok(state.existingRulesets || []);
    if (a === 'api -X POST repos/o/new/rulesets --input -') { state.posted = JSON.parse(input); return ok({}); }
    if (a === 'api -X PATCH repos/o/new --input -') { const b = JSON.parse(input); if (b.security_and_analysis && state.noScanning) return { ok: false, out: '', err: 'not available' }; return ok({}); }
    if (a.includes('vulnerability-alerts') || a.includes('automated-security-fixes')) return ok('');
    if (a.startsWith('api -X PUT user/installations')) return state.appFails ? { ok: false, out: '', err: 'Forbidden' } : ok('');
    return { ok: false, out: '', err: `unexpected ${a}` };
  };
  return { gh, calls };
}

test('plan changes nothing; apply without --confirm is a plan too', () => {
  const s = {}; const { gh, calls } = fakeGh(s);
  const r = apply({ repo: 'o/new', reference: 'o/ref' }, { gh });
  assert.equal(r.plan, true); assert.equal(calls.length, 0); assert.ok(r.steps.length >= 5);
});

test('apply creates a PRIVATE repo, copies settings and the ruleset without ids, and lists the owner-only steps', () => {
  const s = {}; const { gh, calls } = fakeGh(s);
  const r = apply({ repo: 'o/new', reference: 'o/ref', source: '/tmp/x', description: 'd', confirm: true }, { gh });
  assert.deepEqual(r.failed, []);
  assert.ok(s.createArgs.includes('--private') && !s.createArgs.includes('--public'));
  assert.ok(r.done.some(d => d.id === 'create') && r.done.some(d => d.id === 'rulesets') && r.done.some(d => d.id === 'settings'));
  assert.equal(s.posted.name, 'Require approval before merge'); for (const k of ['id', 'node_id', 'source', '_links']) assert.ok(!(k in s.posted), k);
  assert.ok(r.ownerSteps.some(x => /approver token/.test(x)));
  assert.ok(calls.every(c => !c.args.includes('delete') && !c.args.includes('DELETE')), 'never deletes anything');
});

test('a public or non-private result stops; an existing private repo is not recreated; an existing ruleset is not duplicated', () => {
  let s = { exists: true, private: false }; let { gh } = fakeGh(s);
  let r = apply({ repo: 'o/new', reference: 'o/ref', confirm: true }, { gh });
  assert.equal(r.failed[0].id, 'create'); assert.match(r.failed[0].note, /PUBLIC/); assert.equal(r.done.length, 0);
  s = { createdPrivate: false }; ({ gh } = fakeGh(s));
  r = apply({ repo: 'o/new', reference: 'o/ref', confirm: true }, { gh });
  assert.match(r.failed[0].note, /did not come back as private/);
  s = { exists: true, existingRulesets: [{ name: 'Require approval before merge' }] }; ({ gh } = fakeGh(s));
  r = apply({ repo: 'o/new', reference: 'o/ref', confirm: true }, { gh });
  assert.equal(s.posted, undefined); assert.ok(r.skipped.some(x => /already exists/.test(x.note)));
});

test('things gh refuses are reported as skipped or owner steps, never worked around', () => {
  const s = { noScanning: true, appFails: true }; const { gh } = fakeGh(s);
  const r = apply({ repo: 'o/new', reference: 'o/ref', confirm: true }, { gh });
  assert.ok(r.skipped.some(x => x.id === 'scanning') && r.skipped.some(x => x.id === 'app'));
  assert.ok(r.ownerSteps.some(x => /GitHub App/.test(x)));
});

test('bad slugs are refused; cleanRuleset drops server fields only', () => {
  assert.throws(() => apply({ repo: 'bad', reference: 'o/ref' }, { gh: () => ({}) }), /USAGE/);
  assert.deepEqual(cleanRuleset({ id: 1, name: 'n', rules: [], _links: {} }), { name: 'n', rules: [] });
  assert.ok(setupSteps({ repo: 'o/n', reference: 'o/r' }).some(s => s.id === 'rulesets'));
});

test('verified-merge switches rulesets on and off with PUT (GitHub answers PATCH on a ruleset with 404)', () => {
  const calls = []; const ok = o => ({ ok: true, out: JSON.stringify(o) });
  const old = { id: 11, name: 'Require approval before merge', enforcement: 'active', bypass_actors: [], rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }] };
  const files = { '.trioharness/merge-policy.json': '{"version":1,"enabled":true}', '.github/workflows/merge-verify.yml': 'x', '.github/merge-verify/merge-verify.mjs': 'x' };
  const gh = sets => (args, input) => {
    const a = args.join(' '); calls.push({ a, input });
    if (args.includes('-H')) { const m = /contents\/(.+?)\?ref=/.exec(a); return m && files[m[1]] ? { ok: true, out: files[m[1]] } : { ok: false, out: '', err: 'Not Found' }; }
    if (a === 'api repos/o/r') return ok({ id: 1, default_branch: 'main' });
    if (a === 'api repos/o/r/rulesets') return ok(sets);
    if (a === 'api repos/o/r/rulesets/11') return ok(old);
    if (a.startsWith('api repos/o/r/pulls?')) return ok([{ number: 4, head: { sha: 'f'.repeat(40) } }]);
    if (/check-runs/.test(a)) return ok({ check_runs: [{ name: 'merge-verify', conclusion: 'success' }] });
    if (/^api -X PUT repos\/o\/r\/rulesets\/\d+ --input -$/.test(a) || a === 'api -X POST repos/o/r/rulesets --input -') return ok({});
    return { ok: false, out: '', err: 'Not Found' };
  };
  const r1 = verifiedMerge({ repo: 'o/r', confirm: true }, { gh: gh([{ id: 11, name: old.name, enforcement: 'active' }, { id: 20, name: 'Verified merge', enforcement: 'disabled' }]), ruleset: { name: 'Verified merge' } });
  const r2 = verifiedMerge({ repo: 'o/r', rollback: true, restore: ['11'] }, { gh: gh([{ id: 11, name: old.name, enforcement: 'disabled' }, { id: 20, name: 'Verified merge', enforcement: 'active' }]) });
  assert.deepEqual(r1.blocked, []); assert.deepEqual(r2.blocked, []);
  const writes = calls.filter(c => /rulesets\/\d+/.test(c.a) && /-X /.test(c.a));
  assert.deepEqual(writes.map(c => [c.a, JSON.parse(c.input).enforcement]), [
    ['api -X PUT repos/o/r/rulesets/20 --input -', 'active'], ['api -X PUT repos/o/r/rulesets/11 --input -', 'disabled'],
    ['api -X PUT repos/o/r/rulesets/11 --input -', 'active'], ['api -X PUT repos/o/r/rulesets/20 --input -', 'disabled']]);
  assert.ok(calls.every(c => !/-X PATCH repos\/o\/r\/rulesets/.test(c.a)), 'never PATCH on a ruleset');
});
