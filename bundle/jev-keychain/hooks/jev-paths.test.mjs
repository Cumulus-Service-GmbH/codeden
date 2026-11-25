import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

test('Jev guard matches protected wildcard and ancestor operands without trusting aliases', t => {
  const root = realFixture(t);
  const home = join(root, 'home');
  const config = join(home, '.config', 'trioharness');
  const reader = join(config, 'jev-keyring-runtime/bin/jev-keychain-reader');
  mkdirSync(dirname(reader), { recursive: true });
  writeFileSync(reader, '', { mode: 0o500 });
  writeFileSync(join(config, 'jev.env'), '# fixture');
  symlinkSync(home, join(root, 'alias-home'));
  symlinkSync(reader, join(root, 'alias-reader'));
  mkdirSync(join(root, 'ordinary'));
  const script = join(home, '.claude/skills/trioharness-codeden/scripts/jev.mjs');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, 'const reader = "/fixture/jev-keychain-reader";');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { checkExecution, checkSourceContent } from ${JSON.stringify(new URL('./codeden-guard-secrets.mjs', import.meta.url).href)};
    const word = value => ({ value, syntax: value });
    const check = (program, args, redirects = [], cwd = process.cwd()) =>
      checkExecution(word(program), args.map(word), value => !/[?*]/.test(value), () => null,
        { cwd, redirects: redirects.map(target => ({ target: word(target) })) });
    const reader = ${JSON.stringify(reader)};
    for (const [id, program, args, redirects] of [
      ['5.R1 / 6.R1', 'cp', ['-R', './@(alias-home|ordinary)', './out']],
      ['5.R1 / 6.R2', 'cp', ['-R', './alias-hom{e..e}', './out']],
      ['5.R2 / 6.R3', 'tar', ['-cBC./alias-home', 'ordinary']],
      ['5.R3 / 6.R4', 'tar', ['--directory=\${HOME}/.config', 'ordinary']],
      ['5.R4 / 6.R5', 'cp', ['-R', '/', './out']],
      ['5.R4 / 6.R5', 'cp', ['-R', './alias-hom?/../home', './out']],
      ['5.R5 / 6.R6', 'printf', ['%s', 'fixture'], ['./alias-hom?/.config/trioharness/jev.en?']],
      ['9.R1 / 9.R2', './alias-reader', ['present']],
      ['9.R1 / 9.R2', reader.replace('/bin/', '/bin/../bin/'), ['present']],
      ['10.R2', 'cp', ['-R', './alias-home/.config/trioharness', './out']],
    ]) assert.match(check(program, args, redirects) ?? '', /Jev credentials/, id);
    assert.equal(check(reader, ['present']), null);
    assert.equal(check('node', [${JSON.stringify(script)}]), null);
    assert.match(check('node', [${JSON.stringify(script.replace('/scripts/', '/scripts/../scripts/'))}]), /Jev credentials/);
    assert.equal(check('test', ['-d', './alias-home']), null);
    assert.equal(check('ls', ['/']), null);
    assert.equal(check('cat', ['./ordinar?']), null);
    assert.match(checkSourceContent('ready = true; run("/fixture/jev-keychain-reader", ready)', () => null), /Jev credentials/);
  `], { cwd: root, env: { HOME: home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

function realFixture(t) {
  const root = mkdtempSync(join(process.cwd(), '.jev-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
