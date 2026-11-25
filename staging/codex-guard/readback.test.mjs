import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkHookInput, loadAzureTargets } from '../guard/codeden-guard.mjs';

const formatter = fileURLToPath(new URL('./readback.mjs', import.meta.url));
const compare = {
  issuer: { equal: true },
  environment: { equal: false },
  storageAccount: { equal: true },
};

function format(args, input) {
  const result = spawnSync(process.execPath, [formatter, ...args], {
    encoding: 'utf8',
    input: JSON.stringify(input),
  });
  return [result.status, result.stdout, result.stderr];
}

test('names mode prints only names from the guarded projection', () => {
  assert.deepEqual(format(['names'], [
    { name: 'FIRST', set: true, on: false },
    { name: 'SECOND', set: false, on: false },
  ]), [0, '["FIRST","SECOND"]\n', '']);
});

test('equality prints only the selected pair verdict', () => {
  assert.deepEqual(format(['equality', 'issuer'], compare), [0, 'match\n', '']);
  assert.deepEqual(format(['equality', 'environment'], compare), [0, 'no-match\n', '']);
});

test('rejects raw values, extra arguments and indeterminate comparisons without echoing input', () => {
  const denial = [2, '', 'readback denied\n'];
  assert.deepEqual(format(['names'], [{ name: 'FIRST', value: 'fixture-value' }]), denial);
  assert.deepEqual(format(['names'], [{ name: 'FIRST', set: true, on: true, value: 'fixture-value' }]), denial);
  assert.deepEqual(format(['names', '--show-values'], []), denial);
  assert.deepEqual(format(['equality', 'issuer', 'fixture-expected'], compare), denial);
  assert.deepEqual(format(['value'], compare), denial);
  assert.deepEqual(format(['equality', 'issuer'], { ...compare, issuer: { equal: 'fixture-value' } }), denial);
  for (const reason of ['secretref', 'missing']) {
    assert.deepEqual(format(['equality', 'issuer'], { ...compare, issuer: { equal: null, reason } }), denial);
  }
});

test('the documented route accepts both pinned commands and denies value-returning variants', () => {
  const targets = loadAzureTargets(new URL('../guard/fixtures/azure-targets.json', import.meta.url));
  targets.prdApps.add('erpureai-webchat');
  targets.prd.add('erpureai-webchat');
  targets.prdAppLocations.set('erpureai-webchat', {
    resourceGroup: 'fixture-group',
    subscription: 'fixture-subscription',
  });
  const runbook = readFileSync(new URL('./readback.md', import.meta.url), 'utf8');
  const commands = runbook.match(/^az containerapp show .+$/gm);
  assert.equal(commands?.length, 2);
  const check = command => checkHookInput({
    tool_name: 'Bash',
    tool_input: { command },
    cwd: process.cwd(),
  }, targets);
  for (const template of commands) {
    const command = template.replace('PINNED_GROUP', 'fixture-group')
      .replace('PINNED_SUBSCRIPTION', 'fixture-subscription');
    assert.equal(check(command), null);
    assert.ok(check(command + ' --debug'));
    assert.ok(check(command.replace('fixture-group', 'wrong-group')));
    assert.ok(check(command.replace(/--query '.*'/, "--query 'properties.template.containers[].env[].value'")));
    assert.ok(check(command.split(' --query ')[0]));
  }
  assert.ok(check("az webapp config appsettings list -n erpureai-webchat --query '[].value' -o json"));
});
