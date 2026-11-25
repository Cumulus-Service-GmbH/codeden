#!/usr/bin/env node
// Result receipts are evidence of file identity/retrieval, not proof a skill was followed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { isMain } from './is-main.mjs';

export const ROLE_SKILLS = Object.freeze({
  architect: ['brainstorming', 'writing-plans', 'verification-before-completion'],
  writer: ['test-driven-development', 'verification-before-completion'],
  'plan-reviewer': ['writing-plans'],
  'code-reviewer': ['requesting-code-review'],
  investigator: ['context7-mcp', 'systematic-debugging'],
  'browser-tester': ['frontend-design'],
  'agents-md-writer': ['context7-mcp']
});
const shortName = name => typeof name === 'string' ? name.split(':').at(-1) : '';
// Optional Architect-assigned triggers preserve existing callers; omitted means no trigger.
const CONDITIONAL_SKILLS = Object.freeze({
  'executing-plan': ['EXECUTING_PLAN', ['writer'], 'executing-plans'],
  'review-feedback': ['REVIEW_FEEDBACK', ['architect', 'writer'], 'receiving-code-review'],
  'selecting-tree': ['SELECTING_TREE', ['architect'], 'using-git-worktrees'],
  closing: ['CLOSING', ['architect'], 'finishing-a-development-branch'],
  'requesting-review': ['REQUESTING_REVIEW', ['architect'], 'requesting-code-review'],
  'intake-exploration': ['INTAKE_EXPLORATION', ['architect'], 'brainstorming']
});
export function checkReceipts({ role, tier, file, ui, failure, externalApis, ...triggers }) {
  const missing = [];
  if (!Object.hasOwn(ROLE_SKILLS, role || '') || !['trivial', 'lean', 'standard'].includes(tier)) return ['INPUT_INVALID'];
  if ([ui, failure, externalApis].some(v => !['yes', 'no'].includes(v))) return ['FLAGS_INVALID: --ui/--failure/--external-apis yes|no required'];
  if (Object.keys(CONDITIONAL_SKILLS).some(flag => triggers[flag] !== undefined && !['yes', 'no'].includes(triggers[flag]))) return ['FLAGS_INVALID: conditional triggers must be yes|no'];
  if (tier === 'trivial') return missing;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return ['RESULT_FILE_MISSING']; }
  text = text.split(/\r?\n/).slice(0, 30).join('\n');
  const field = key => new RegExp(`^${key}: (.*)$`, 'm').exec(text)?.[1];
  const array = key => {
    try { const a = JSON.parse(field(key)); if (!Array.isArray(a)) throw new Error(); return a; }
    catch { missing.push(`${key}_FORMAT`); return []; }
  };
  const skills = array('SKILLS');
  for (const [fieldName, expected] of [['UI_PACKET', ui], ['FAILURE', failure], ['EXTERNAL_APIS', externalApis]]) if (field(fieldName) !== expected) missing.push(`FLAGS_MISMATCH:${fieldName}`);
  const required = tier === 'lean' ? (role === 'writer' ? ['test-driven-development', 'verification-before-completion'] : []) : [...ROLE_SKILLS[role]];
  for (const [flag, [fieldName, roles, name]] of Object.entries(CONDITIONAL_SKILLS)) {
    const expected = triggers[flag] || 'no';
    if (triggers[flag] !== undefined && field(fieldName) !== expected) missing.push(`FLAGS_MISMATCH:${fieldName}`);
    if (expected === 'yes' && roles.includes(role)) required.push(name);
  }
  if (ui === 'yes' && role === 'writer') required.push('frontend-design');
  if (failure === 'yes' && role === 'writer') required.push('systematic-debugging');
  if (tier === 'standard' && externalApis === 'yes' && role === 'writer') required.push('context7-mcp');
  for (const name of required) if (!skills.some(s => shortName(s?.name) === name)) missing.push(`SKILL_MISSING:${name}`);
  const inside = (root, path) => path.startsWith(root + sep);
  const roots = ['.claude/skills', '.codex/skills', '.claude/plugins/cache', '.codex/plugins/cache'].map(p => join(homedir(), p)).filter(existsSync).map(p => realpathSync(p));
  let runDir;
  for (let dir = dirname(resolve(file)); dirname(dir) !== dir; dir = dirname(dir)) if (basename(dirname(dir)) === 'runs') { runDir = realpathSync(dir); break; }
  const fromResult = path => isAbsolute(path) ? path : resolve(dirname(file), path);
  for (const s of skills) {
    if (!s || typeof s.name !== 'string' || typeof s.version !== 'string' || !s.version || typeof s.path !== 'string' || !/^[a-f0-9]{64}$/i.test(s.sha256 || '')) { missing.push('SKILL_RECEIPT_INVALID'); continue; }
    try {
      const path = realpathSync(fromResult(s.path));
      if (!roots.some(root => inside(root, path))) { missing.push(`SKILL_ROOT:${s.name}`); continue; }
      if (basename(path) !== 'SKILL.md' || !statSync(path).isFile()) throw new Error();
      const bytes = readFileSync(path);
      if (createHash('sha256').update(bytes).digest('hex') !== s.sha256.toLowerCase()) missing.push(`SKILL_HASH:${s.name}`);
      const name = /^name:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(bytes.toString('utf8'))?.[1]?.trim();
      if (shortName(name) !== shortName(s.name)) missing.push(`SKILL_NAME:${s.name}`);
    } catch { missing.push(`SKILL_FILE:${s.name}`); }
  }
  const external = externalApis;
  if (!['yes', 'no'].includes(external)) missing.push('EXTERNAL_APIS_MISSING');
  const docsNeeded = external === 'yes' || (tier === 'standard' && ['investigator', 'agents-md-writer'].includes(role));
  if (docsNeeded) {
    const docs = array('DOCS');
    if (!docs.length) missing.push('DOCS_MISSING');
    if (!field('DEPRECATIONS')?.trim()) missing.push('DEPRECATIONS_MISSING');
    let start;
    try {
      const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
      start = state.startedAt || state.createdAt || state.history?.[0]?.at;
    } catch { /* missing owning run start refuses docs */ }
    if (!Number.isFinite(Date.parse(start))) missing.push('RUN_START_MISSING');
    for (const d of docs) {
      if (!d || ['libraryId', 'servedVersion', 'url', 'date', 'proof'].some(k => typeof d[k] !== 'string' || !d[k].trim()) || !/^https?:\/\//.test(d.url)) { missing.push('DOCS_RECEIPT_INVALID'); continue; }
      if (!Number.isFinite(Date.parse(d.date)) || !Number.isFinite(Date.parse(start)) || Date.parse(d.date) < Date.parse(start) || Date.parse(d.date) > Date.now()) missing.push(`DOCS_DATE:${d.libraryId}`);
      try {
        const proofPath = realpathSync(fromResult(d.proof));
        if (!runDir || !inside(join(runDir, 'proof/docs'), proofPath)) { missing.push(`DOCS_PROOF_PATH:${d.libraryId}`); continue; }
        const proof = readFileSync(proofPath, 'utf8');
        let metadata;
        try { metadata = JSON.parse(proof); } catch {
          metadata = Object.fromEntries(proof.split('\n').map(line => /^(libraryId|servedVersion|url|date):\s*(.*?)\s*$/.exec(line)).filter(Boolean).map(m => [m[1], m[2]]));
        }
        if (!metadata || ['libraryId', 'servedVersion', 'url', 'date'].some(k => metadata[k] !== d[k])) missing.push(`DOCS_PROOF_FIELDS:${d.libraryId}`);
      } catch { missing.push(`DOCS_PROOF_MISSING:${d.libraryId}`); }
    }
  }
  return [...new Set(missing)];
}
export function runCli(argv, output = s => process.stdout.write(s)) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (![...['--role', '--tier', '--file', '--ui', '--failure', '--external-apis'], ...Object.keys(CONDITIONAL_SKILLS).map(flag => `--${flag}`)].includes(argv[i]) || !argv[i + 1] || opts[argv[i].slice(2)]) { output('INPUT_INVALID\n'); return 2; }
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.file) { output('INPUT_INVALID\n'); return 2; }
  opts.externalApis = opts['external-apis'];
  const missing = checkReceipts(opts);
  output(missing.length ? `RECEIPT_CHECK: FAIL\n${missing.join('\n')}\n` : 'RECEIPT_CHECK: PASS\n');
  return missing.length ? 2 : 0;
}
if (isMain(import.meta.url)) process.exitCode = runCli(process.argv.slice(2));
