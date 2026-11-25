import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function localRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const { GIT_TEMPLATE_DIR, ...env } = process.env;
  execFileSync('git', ['init', '-q'], {
    cwd: repo,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  });
  return repo;
}
