#!/usr/bin/env node
// Read-only AGENTS.md close-out check. Retire JSON: [{"line":"exact removed line","reason":"why"}].
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findSecrets } from './secret-patterns.mjs';

const normalize = text => text.replace(/\r\n/g, '\n');
// Latin-1 round-trips every byte so invalid UTF-8 cannot collapse during comparison.
const normalizeBytes = bytes => Buffer.from(normalize(bytes.toString('latin1')), 'latin1');
const lines = text => normalize(text).split('\n');
const counts = text => {
  const out = new Map();
  for (const line of lines(text)) if (line.trim()) out.set(line, (out.get(line) || 0) + 1);
  return out;
};
const protectedHeading = name => ['Stack and delivery', 'Proof commands', 'High-risk paths', 'Repository shape', 'Secrets', 'Running environments', 'Running environments and a clean end state', 'Handover', 'Handover at the round limit'].includes(name);
function sections(text) {
  const rows = lines(text), out = [];
  for (let i = 0; i < rows.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(rows[i]);
    if (!m || !protectedHeading(m[1])) continue;
    let end = i + 1;
    while (end < rows.length && !/^##\s/.test(rows[end])) end++;
    out.push({ name: m[1], text: rows.slice(i, end).join('\n') });
  }
  return out;
}
const hasAbsolutePath = text => /(^|[^\w/\\])\/+Users\//.test(text) || /C:\\+Users\\+/i.test(text);
const inside = (root, path) => path === root || path.startsWith(root + sep);
const refs = text => new Set(text.match(/\b(?:docs|Docs)\/agent-notes\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md\b/g) || []);

export function runCli(argv, output = s => process.stdout.write(s)) {
  const failures = [];
  const fail = (code, file, line = 1, rule = code) => failures.push(`${file}:${line} ${code} ${rule}`);
  // Labels never echo caller paths or file names, which themselves may contain unsafe text.
  const scan = (text, file, offset = 0, pathBudget) => {
    for (const hit of findSecrets(text)) fail('SECRET_SHAPED', file, hit.line + offset, hit.rule);
    lines(text).forEach((line, i) => {
      if (!hasAbsolutePath(line)) return;
      const remaining = pathBudget?.get(line) || 0;
      if (remaining) pathBudget.set(line, remaining - 1);
      else fail('ABSOLUTE_PATH', file, i + 1 + offset);
    });
  };
  // JSON escapes can hide unsafe data in any key or nested value, not just line/reason.
  const scanDecoded = (value, file) => {
    if (typeof value === 'string') scan(value, file);
    else if (Array.isArray(value)) value.forEach(item => scanDecoded(item, file));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      scan(key, file); scanDecoded(item, file);
    }
  };
  try {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
      if (!['--repo', '--before', '--retire', '--max-bytes', '--allow-existing-paths'].includes(argv[i]) || !argv[i + 1] || args[argv[i]]) throw new Error();
      args[argv[i]] = argv[i + 1];
    }
    if (!args['--repo'] || !args['--before']) throw new Error();
    const cap = args['--max-bytes'] === undefined ? 12288 : Number(args['--max-bytes']);
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error();
    const repo = realpathSync(resolve(args['--repo']));
    const beforeBytes = readFileSync(args['--before']);
    const before = normalize(beforeBytes.toString('utf8'));
    let pathBudget, removedPathBudget;
    if (args['--allow-existing-paths']) {
      const ref = args['--allow-existing-paths'];
      if (ref.startsWith('-')) throw new Error();
      const git = argv => execFileSync('git', ['-C', repo, ...argv], { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      const commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString('utf8').trim();
      git(['merge-base', '--is-ancestor', commit, 'HEAD']);
      const original = git(['show', `${commit}:AGENTS.md`]);
      if (!normalizeBytes(original).equals(normalizeBytes(beforeBytes))) throw new Error();
      // Final files share the committed tree's budget across repeated close-outs.
      pathBudget = counts(before);
      const entries = git(['ls-tree', '-r', '-z', commit, '--', 'docs/agent-notes/', 'Docs/agent-notes/']).toString('utf8').split('\0');
      for (const entry of entries) {
        const name = /^(?:100644|100755) blob [0-9a-f]+\t([\s\S]+\.md)$/.exec(entry)?.[1];
        if (!name) continue;
        for (const [line, n] of counts(git(['show', `${commit}:${name}`]).toString('utf8'))) {
          pathBudget.set(line, (pathBudget.get(line) || 0) + n);
        }
      }
      // Scanning removed input must not consume the final files' budget.
      removedPathBudget = counts(before);
    }
    const agentsBytes = readFileSync(join(repo, 'AGENTS.md'));
    const agents = normalize(agentsBytes.toString('utf8'));
    scan(agents, 'AGENTS.md', 0, pathBudget);
    const old = counts(before), current = counts(agents), removed = new Map();
    for (const [line, n] of old) if (n > (current.get(line) || 0)) removed.set(line, n - (current.get(line) || 0));
    lines(before).forEach((line, i) => { if (removed.has(line)) {
      scan(line, 'before', i, removedPathBudget);
    } });
    if (agentsBytes.length > cap) fail('AGENTS_TOO_LARGE', 'AGENTS.md');
    if (JSON.stringify(sections(before)) !== JSON.stringify(sections(agents))) fail('PROTECTED_SECTION_CHANGED', 'AGENTS.md');
    const claude = existsSync(join(repo, 'CLAUDE.md')) ? readFileSync(join(repo, 'CLAUDE.md'), 'utf8') : '';
    if (!/^\s*@AGENTS\.md\s*$/m.test(claude)) fail('CLAUDE_IMPORT_MISSING', 'CLAUDE.md');

    const referenced = refs(agents), overflow = new Map();
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name), name = prefix + entry.name;
        if (entry.isSymbolicLink()) { fail('OVERFLOW_UNREFERENCED', 'overflow'); continue; }
        if (entry.isDirectory()) walk(path, name + '/');
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const text = normalize(readFileSync(path, 'utf8'));
          const label = `overflow[${overflow.size + 1}]`;
          scan(text, label, 0, pathBudget); overflow.set(name, text);
          if (!referenced.has(name)) fail('OVERFLOW_UNREFERENCED', label);
          const backlink = /\[AGENTS\.md\]\(([^)]+)\)/.exec(lines(text)[0])?.[1] || /^See (\S+)$/.exec(lines(text)[0])?.[1];
          if (!backlink || resolve(dirname(path), backlink) !== join(repo, 'AGENTS.md')) fail('OVERFLOW_NO_BACKLINK', label);
        }
      }
    };
    // Read stored names so a case-insensitive filesystem cannot alias Docs to docs.
    for (const root of readdirSync(repo).filter(name => name === 'docs' || name === 'Docs')) {
      const rootPath = join(repo, root), rootInfo = lstatSync(rootPath);
      if (rootInfo.isSymbolicLink()) { fail('OVERFLOW_UNREFERENCED', 'overflow'); continue; }
      if (!rootInfo.isDirectory() || !readdirSync(rootPath).includes('agent-notes')) continue;
      const notes = join(rootPath, 'agent-notes');
      if (lstatSync(notes).isSymbolicLink() || !inside(repo, realpathSync(notes))) fail('OVERFLOW_UNREFERENCED', 'overflow');
      else walk(notes, `${root}/agent-notes/`);
    }
    const moved = new Map();
    for (const name of referenced) {
      if (!overflow.has(name)) { fail('OVERFLOW_UNREFERENCED', 'overflow'); continue; }
      for (const [line, n] of counts(overflow.get(name))) moved.set(line, (moved.get(line) || 0) + n);
    }
    let retired = [];
    if (args['--retire']) {
      const raw = readFileSync(args['--retire'], 'utf8'); scan(raw, 'retire');
      try { retired = JSON.parse(raw); } catch { fail('LOST_LINE', 'retire'); }
      if (!Array.isArray(retired)) { fail('LOST_LINE', 'retire'); retired = []; }
    }
    const retiredCounts = new Map();
    for (const [i, item] of retired.entries()) {
      scanDecoded(item, `retire[${i + 1}]`);
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['line', 'reason'].includes(key))) { fail('LOST_LINE', 'retire', i + 1); continue; }
      if (!item || typeof item.line !== 'string' || !item.line.trim() || /[\r\n]/.test(item.line) || typeof item.reason !== 'string' || !item.reason.trim()) { fail('LOST_LINE', 'retire', i + 1); continue; }
      retiredCounts.set(item.line, (retiredCounts.get(item.line) || 0) + 1);
    }
    for (const line of new Set([...removed.keys(), ...retiredCounts.keys()])) {
      const needed = Math.max(0, (removed.get(line) || 0) - (moved.get(line) || 0));
      if ((retiredCounts.get(line) || 0) !== needed) fail('LOST_LINE', 'AGENTS.md');
    }
    if (!failures.length) {
      output('AGENTS_MD_CHECK: PASS\n');
      retired.forEach((item, i) => output(`retire[${i + 1}] ${JSON.stringify({ line: item.line, reason: item.reason })}\n`));
      return 0;
    }
  } catch { fail('INPUT_INVALID', 'input'); }
  // No content or exception message is printed on a refused check.
  output([...new Set(failures)].join('\n') + '\n');
  return 2;
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = runCli(process.argv.slice(2));
