import assert from 'node:assert/strict';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const harness = dirname(resolve(root));
const pair = ['claude', 'codex'].includes(harness.split('/').at(-1))
  ? ['claude', 'codex'].map(name => resolve(harness, '..', name, 'trioharness-codeden'))
  : ['.claude', '.codex'].map(name => join(homedir(), name, 'skills', 'trioharness-codeden'));

function compareTrees(left, right) {
  const entries = readdirSync(left, { withFileTypes: true });
  assert.deepEqual(entries.map(entry => entry.name).sort(), readdirSync(right).sort(), left);
  for (const entry of entries) {
    const a = join(left, entry.name);
    const b = join(right, entry.name);
    if (entry.isDirectory()) compareTrees(a, b);
    else if (entry.isSymbolicLink()) assert.equal(readlinkSync(a), readlinkSync(b), a);
    else assert.deepEqual(readFileSync(a), readFileSync(b), a);
  }
}

test('the Claude and Codex skill trees stay byte-identical', () => compareTrees(...pair));

test('CodeDen skill documents owner policy and the installed review gate', () => {
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
  const ops = readFileSync(join(root, 'references/ops-secrets-cards.md'), 'utf8');
  const writer = readFileSync(join(root, 'templates/writer-prompt.md'), 'utf8');
  for (const rule of ['JEV_RECEIPT_REQUIRED', 'team-review.mjs" run', 'team-review.mjs" check',
    'c2.2 is pending', '8 model rounds', 'VITEST_MAX_WORKERS=2',
    '/tmp/codeden-suite.lock', 'upstream-watch', 'git cherry', 'access-control or configuration validation',
    'findings by ID and `file:line`', 'Park the lane after three consecutive stops']) {
    assert.ok(skill.includes(rule), rule);
  }
  assert.doesNotMatch(skill, /team-review\.mjs["`]? record|TYPESAFE_API_KEY|JEV_API_KEY/);
  for (const rule of ['evidencePublisherPrincipalId', 'cd <cwd> &&', 'Codex Supervised',
    'acceptEdits', 'Operator', 'once LIVE', 'launchctl', 'rollback']) {
    assert.ok(ops.includes(rule), rule);
  }
  assert.match(writer, /^## Package and config check$/m);
});


test('review uses exact Team roles and the G-B host runner from sandboxed sessions', () => {
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
  for (const rule of ['agy / Gemini 4 Neon / high', 'claude / Opus 5.5 / high',
    'claude / Opus 5.5 / xhigh', 'host-side review runner (G-B)', 'ad-hoc `claude -p`',
    'substitute one role for another', 'review its own work']) {
    assert.ok(skill.includes(rule), rule);
  }
});
