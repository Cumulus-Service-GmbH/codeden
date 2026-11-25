// Durable, best-effort issue-hook failures. Independent of issues.mjs and host authorization.
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const ISSUE_EVENTS = Object.freeze(['writer-start', 'pr-open', 'merged', 'deployed-qa', 'deployed-prod', 'rollback', 'installed']);
export const FAILURE_CATEGORIES = Object.freeze(['IMPORT_FAILED', 'RUNNER_FAILED', 'GH_UNAVAILABLE', 'IDENTITY_UNVERIFIED', 'OTHER']);
const RUN_ID = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const ISSUE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

// Only named, validated fields enter the record. In particular, no error object is accepted.
export function appendFailure({ ledger, run, event, category, key } = {}) {
  try {
    if (typeof ledger !== 'string' || !ledger || typeof run !== 'string' || !RUN_ID.test(run) || run === '.' || run === '..' || !ISSUE_EVENTS.includes(event)) return;
    const dir = join(ledger, '.trioharness-direct', 'runs', run);
    if (!existsSync(join(dir, 'state.json'))) return;
    const record = { v: 1, kind: 'failure', ts: new Date().toISOString(), run, event, category: FAILURE_CATEGORIES.includes(category) ? category : 'OTHER' };
    if (typeof key === 'string' && ISSUE_KEY.test(key)) record.key = key;
    appendFileSync(join(dir, 'issues-failures.jsonl'), `${JSON.stringify(record)}\n`, { flag: 'a' });
  } catch { /* the host's output and exit code always win */ }
}
