#!/usr/bin/env node
// TrioHarness Lean — verify an extracted transfer package against its MANIFEST.sha256.txt.
//   node verify-manifest.mjs <package-dir> [--manifest <file>] [--workers 8] [--strict]
// Manifest lines are "<sha256>  <relative path>  <bytes>"; paths may contain spaces and may use Windows backslashes.
// The manifest does not list itself. Paths that are absolute or climb out of the package are refused, never read.
// Symlinks are refused (a link could point outside the package); hard links cannot be detected. By default only listed files are checked: pass --strict to
// also flag files in the package that the manifest does not list (the manifest itself excepted).
// Exit 0 = every listed file matches; 1 = problems; 3 = usage error. Prints:
//   manifest lines: N, parsed: N, verified OK: N, problems: N
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './is-main.mjs';

const LINE = /^([0-9a-fA-F]{64})  (.+)  (\d+)$/;

// Windows manifests use "\"; normalise to "/" before any check. Returns null for an unsafe path.
export function safeRel(rel) {
  const p = rel.replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\0')) return null;
  const parts = p.split('/');
  if (parts.some(s => s === '..' || s === '')) return null;
  return parts.join('/');
}

export function parseManifest(text) {
  const entries = [], problems = [];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  for (const line of lines) {
    const m = line.match(LINE);
    if (!m) { problems.push({ line: line.slice(0, 80), problem: 'unparseable line' }); continue; }
    const rel = safeRel(m[2]);
    if (!rel) { problems.push({ line: m[2].slice(0, 80), problem: 'unsafe path (absolute or climbs out of the package)' }); continue; }
    entries.push({ hash: m[1].toLowerCase(), rel, bytes: Number(m[3]) });
  }
  return { total: lines.length, entries, problems };
}

function sha256File(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', c => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

function walk(root, dir = root, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(root, full, out); else out.push(relative(root, full).split(/[\\/]/).join('/'));
  }
  return out;
}

export async function verify(dir, { manifest, workers = 8, strict = false } = {}) {
  const root = resolve(dir);
  const mf = manifest ? resolve(manifest) : join(root, 'MANIFEST.sha256.txt');
  if (!existsSync(mf)) throw new Error(`MANIFEST_MISSING: ${mf}`);
  const realRoot = realpathSync(root);
  const { total, entries, problems } = parseManifest(readFileSync(mf, 'utf8'));
  if (!entries.length) problems.push({ line: '(manifest)', problem: 'the manifest lists no files, so nothing was verified' });
  let ok = 0, next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const e = entries[next++];
      const file = resolve(root, ...e.rel.split('/'));
      let st; try { st = lstatSync(file); } catch (err) { problems.push({ line: e.rel, problem: err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'missing' : `unreadable: ${err.code}` }); continue; }
      if (st.isSymbolicLink()) { problems.push({ line: e.rel, problem: 'is a symbolic link (refused)' }); continue; }
      if (!st.isFile()) { problems.push({ line: e.rel, problem: 'not a regular file' }); continue; }
      let real; try { real = realpathSync(file); } catch (err) { problems.push({ line: e.rel, problem: `unreadable: ${err.code}` }); continue; }
      const rel = relative(realRoot, real);
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) { problems.push({ line: e.rel, problem: 'resolves outside the package (a parent folder is a link)' }); continue; }
      if (st.size !== e.bytes) { problems.push({ line: e.rel, problem: `size ${st.size} differs from ${e.bytes}` }); continue; }
      try { if ((await sha256File(file)) === e.hash) ok++; else problems.push({ line: e.rel, problem: 'hash differs' }); } catch (err) { problems.push({ line: e.rel, problem: `unreadable: ${err.code || err.message}` }); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(32, workers)) }, worker));
  if (strict) {
    const listed = new Set(entries.map(e => e.rel)); const self = relative(root, mf).split(/[\\/]/).join('/');
    for (const f of walk(root)) if (!listed.has(f) && f !== self) problems.push({ line: f, problem: 'not listed in the manifest (extra file)' });
  }
  return { total, parsed: entries.length, ok, problems };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--manifest', '--workers'].includes(argv[i - 1])));
  if (!dir) { process.stderr.write('USAGE: verify-manifest.mjs <package-dir> [--manifest <file>] [--workers 8] [--strict]\n'); process.exit(3); }
  verify(dir, { manifest: opt('manifest'), workers: Number(opt('workers')) || 8, strict: argv.includes('--strict') }).then(r => {
    process.stdout.write(`manifest lines: ${r.total}, parsed: ${r.parsed}, verified OK: ${r.ok}, problems: ${r.problems.length}\n`);
    for (const p of r.problems.slice(0, 20)) process.stdout.write(`  ${p.problem}: ${p.line}\n`);
    if (r.problems.length > 20) process.stdout.write(`  … ${r.problems.length - 20} more\n`);
    process.exitCode = r.problems.length ? 1 : 0;
  }).catch(e => { process.stderr.write(`VERIFY: ${e.message}\n`); process.exitCode = 3; });
}
