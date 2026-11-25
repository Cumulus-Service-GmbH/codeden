import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, safeRel, verify } from './verify-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
function pkg(files, { windows = false, extra = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thl-vm-'));
  const lines = [];
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body);
    lines.push(`${sha(body)}  ${windows ? rel.replace(/\//g, '\\') : rel}  ${Buffer.byteLength(body)}`);
  }
  writeFileSync(join(dir, 'MANIFEST.sha256.txt'), lines.join(windows ? '\r\n' : '\n') + extra);
  return dir;
}

test('safeRel normalises backslashes and refuses absolute or climbing paths', () => {
  assert.equal(safeRel('a\\b\\c.txt'), 'a/b/c.txt');
  for (const bad of ['..\\x', 'a/../../x', '/etc/passwd', 'C:\\x', 'C:/x', 'a//b', '']) assert.equal(safeRel(bad), null, bad);
});

test('Windows-style manifest (backslashes, CRLF, spaces in names) verifies fully', async () => {
  const dir = pkg({ 'a/b c.txt': 'one', 'top.txt': 'two', 'deep/er/x.bin': 'three' }, { windows: true });
  const r = await verify(dir);
  assert.deepEqual([r.total, r.parsed, r.ok, r.problems.length], [3, 3, 3, 0]);
  rmSync(dir, { recursive: true, force: true });
});

test('missing, changed and wrong-size files are reported; the manifest need not list itself', async () => {
  const dir = pkg({ 'a.txt': 'aaa', 'b.txt': 'bbb', 'c.txt': 'ccc' });
  rmSync(join(dir, 'a.txt')); writeFileSync(join(dir, 'b.txt'), 'bbX'); writeFileSync(join(dir, 'c.txt'), 'cc');
  const r = await verify(dir);
  assert.equal(r.ok, 0);
  assert.deepEqual(r.problems.map(p => p.problem.split(' ')[0]).sort(), ['hash', 'missing', 'size']);
  rmSync(dir, { recursive: true, force: true });
});

test('unsafe manifest paths are refused and never read; junk lines are problems, not crashes', async () => {
  const dir = pkg({ 'ok.txt': 'fine' }, { extra: `\n${sha('x')}  ..\\..\\secret  1\nnot a manifest line\n` });
  const r = await verify(dir);
  assert.equal(r.ok, 1); assert.equal(r.total, 3); assert.equal(r.parsed, 1);
  assert.equal(r.problems.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI prints the summary line and exits 0 clean, 1 with problems, 3 without a manifest', () => {
  const dir = pkg({ 'a.txt': 'aaa' });
  const run = (...a) => spawnSync(process.execPath, [join(here, 'verify-manifest.mjs'), ...a], { encoding: 'utf8' });
  let r = run(dir); assert.equal(r.status, 0); assert.match(r.stdout, /manifest lines: 1, parsed: 1, verified OK: 1, problems: 0/);
  writeFileSync(join(dir, 'a.txt'), 'bbb'); r = run(dir); assert.equal(r.status, 1);
  rmSync(join(dir, 'MANIFEST.sha256.txt')); r = run(dir); assert.equal(r.status, 3);
  assert.equal(run().status, 3);
  rmSync(dir, { recursive: true, force: true });
});

test('parseManifest: only a 64-hex hash, two spaces, a path and a byte count parse', () => {
  const { entries, problems } = parseManifest(`${'a'.repeat(64)}  dir/with space.txt  12\nshort  x  1\n${'b'.repeat(64)} onespace.txt 3\n`);
  assert.equal(entries.length, 1); assert.equal(entries[0].rel, 'dir/with space.txt'); assert.equal(problems.length, 2);
});

test('symlinks are refused (file link, and a link in a parent folder); --strict flags files the manifest does not list', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'thl-vm-out-')); writeFileSync(join(outside, 'secret.txt'), 'outside');
  const dir = pkg({ 'real.txt': 'ok' });
  let linked = true;
  try { symlinkSync(join(outside, 'secret.txt'), join(dir, 'f.txt')); symlinkSync(outside, join(dir, 'lib'), 'dir'); } catch { linked = false; }
  if (linked) {
    writeFileSync(join(dir, 'MANIFEST.sha256.txt'), [`${sha('ok')}  real.txt  2`, `${sha('outside')}  f.txt  7`, `${sha('outside')}  lib/secret.txt  7`].join('\n'));
    const r = await verify(dir);
    assert.equal(r.ok, 1); assert.equal(r.problems.length, 2);
    assert.ok(r.problems.every(p => /symbolic link|outside the package/.test(p.problem)), JSON.stringify(r.problems));
  }
  writeFileSync(join(dir, 'extra.py'), 'planted');
  assert.equal((await verify(dir)).problems.filter(p => /extra/.test(p.problem)).length, 0, 'default mode checks listed files only');
  assert.ok((await verify(dir, { strict: true })).problems.some(p => p.line === 'extra.py' && /extra file/.test(p.problem)));
  rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
});

test('an empty manifest is a failure, never a silent pass', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'thl-vm-')); writeFileSync(join(d, 'MANIFEST.sha256.txt'), '\n');
  const r = await verify(d, { strict: true });
  assert.ok(r.problems.length >= 1 && r.ok === 0);
});
