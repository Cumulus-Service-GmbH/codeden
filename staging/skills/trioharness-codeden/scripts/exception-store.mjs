import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validRunId } from './ids.mjs';

export const runDir = (repo, run) => { if (!validRunId(run)) throw new Error('RUN_ID_INVALID'); return join(repo, '.trioharness-direct', 'runs', run); };
export const fileOf = (repo, run) => join(runDir(repo, run), 'jev-exceptions.jsonl');

export function listExceptions(repo, run) {
  const f = fileOf(repo, run); if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export const findException = (repo, run, gate, digest) => listExceptions(repo, run).find(e => e.gate === gate && e.inputSha256 === digest) || null;
