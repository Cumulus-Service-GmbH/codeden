import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const hash = text => createHash('sha256').update(text).digest('hex');

test('mobile issuer cards accept both command forms with the same pinned approval', t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'guard-issuer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hook = new URL('./codeden-guard.mjs', import.meta.url);
  const preload = join(root, 'mock-home.mjs');
  writeFileSync(preload, `
    import os from 'node:os';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    os.userInfo = () => ({ homedir: ${JSON.stringify(root)}, uid: ${userInfo().uid} });
    for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
      childProcess[method] = () => process.exit(97);
    }
    syncBuiltinESMExports();
  `);
  const dir = join(root, 'wt', 'webchatmobile', 'issuer-fixture');
  const lockDir = join(root, '.claude/skills/trioharness-lean/scripts');
  const script = join(dir, 'scripts/mobile-release/issue-migration-authority.mjs');
  const lock = join(lockDir, 'run-lock.mjs');
  mkdirSync(join(dir, 'scripts/mobile-release'), { recursive: true });
  mkdirSync(lockDir, { recursive: true });

  // Keep the real hash checks, using inert files with digests local to this fixture.
  const pins = [
    [script, /(?<=const mobileIssuerSha = ")[a-f0-9]{64}/],
    ...['run-lock.mjs', 'secret-patterns.mjs', 'is-main.mjs'].map(file =>
      [join(lockDir, file), new RegExp('(?<="' + file.replaceAll('.', '\\.') + '": ")[a-f0-9]{64}')]),
  ];
  const moduleName = 'codeden-guard-prd-cards.mjs';
  const hooks = mkdtempSync(join(root, 'issuer-hooks-'));
  let source = readFileSync(new URL('./' + moduleName, import.meta.url), 'utf8');
  for (const [file, pin] of pins) {
    const contents = `throw new Error(${JSON.stringify('Offline fixture: ' + file)});\n`;
    assert.match(source, pin);
    writeFileSync(file, contents);
    source = source.replace(pin, hash(contents));
  }
  writeFileSync(join(hooks, moduleName), source);
  const issuerHook = join(hooks, 'codeden-guard.mjs');
  copyFileSync(hook, issuerHook);
  copyFileSync(new URL('./codeden-guard-secrets.mjs', import.meta.url), join(hooks, 'codeden-guard-secrets.mjs'));

  const evidence = '/tmp/deploy-x4/a0-refresh.fixture/TEST-evidence.json';
  const sha = '123456789abc'.repeat(3) + '1234';
  const command = [
    'MOBILE_APPROVED_EVIDENCE_SHA256=' + 'a'.repeat(64),
    'MOBILE_APPROVED_A0_SHA256=' + 'b'.repeat(64),
    'node', lock, 'run', '--name', 'a0-migration-authority-test', '--', 'node', script,
    '--env', 'TEST', '--sha', sha, '--evidence', evidence, '--data-source', 'tcp:149.97.246.130,59917',
    '--initial-catalog', 'ERPureAI', '--attestation-ref', 'codeden-fixture:test-a0-attest:20261125',
    '--authorize', 'a0:TEST:' + sha.slice(0, 12) + ':aaaaaaaaaaaa', '--generation', '2',
    '--ttl-hours', '24', '--receipt', evidence.replace('evidence', 'receipt'),
  ].join(' ');
  const explicit = `cd ${dir} && ${command}`;
  function runIssuer(input, { dir: cwd = dir, id = randomUUID() } = {}) {
    return spawnSync(process.execPath, ['--import', preload, issuerHook], {
      input: JSON.stringify({
        tool_name: 'Bash', tool_input: { command: input }, cwd, permission_mode: 'default', session_id: id,
      }),
      env: { ...process.env, CODEDEN_HOME: root, CLAUDE_PROJECT_DIR: dir, CODEDEN_GUARD_LEDGER: join(root, 'ledger') },
      encoding: 'utf8',
    });
  }
  function ask(input, options) {
    const result = runIssuer(input, options);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'ask');
    assert.match(output.permissionDecisionReason, /mobile migration authority issuance/);
    assert.match(output.updatedInput.command, /--import/);
    return output;
  }
  function deny(input, options) {
    const result = runIssuer(input, options);
    assert.equal(result.status, 2, result.stdout || result.stderr);
    assert.match(result.stderr, /ERPURE-SQL/i);
    assert.equal(result.stdout, '');
  }

  const approved = ask(explicit, { id: 'mobile-issuer-shared' });
  assert.deepEqual(ask(command), approved);
  const replay = runIssuer(command, { id: 'mobile-issuer-shared' });
  assert.equal(replay.status, 2, replay.stderr);
  assert.equal(replay.stdout, '');
  assert.match(replay.stderr, /card already raised/);

  const otherMobile = join(dir, '../other');
  const otherProject = join(dir, '../../other/issuer-fixture');
  const otherScript = script.replace(dir, otherProject);
  mkdirSync(otherMobile);
  mkdirSync(join(otherProject, 'scripts/mobile-release'), { recursive: true });
  copyFileSync(script, otherScript);
  deny(command, { dir: otherMobile });
  deny(command.replace(script, otherScript), { dir: otherProject });
  deny(`cd ${otherMobile} && ${command}`);
  deny(command.replace('--ttl-hours 24', '--ttl-hours 25'));
  deny(command + ' --extra value');
  deny(command.replace(script, join(dir, 'unapproved.mjs')));
  deny('sqlcmd -S tcp:149.97.246.130,59917');
  writeFileSync(script, 'throw new Error("Modified offline fixture");\n');
  deny(command);
});
