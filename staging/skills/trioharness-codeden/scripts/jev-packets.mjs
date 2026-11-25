import { createHash } from 'node:crypto';

export const RUBRIC = 'codeden-jev/1';
const hash = value => createHash('sha256').update(value).digest('hex');
export const packetDigest = packet => {
  const { attempt, after, ...judged } = packet;
  return hash(JSON.stringify(judged));
};

export function readRequirements(bytes, expectedDigest) {
  if (hash(bytes) !== expectedDigest) throw new Error('JEV_REQUIREMENTS_CHANGED: owner requirements digest differs');
  return JSON.parse(bytes);
}

function requireValue(condition, path) {
  if (!condition) throw new Error(`JEV_PACKET_INVALID: ${path}`);
}

const text = value => typeof value === 'string' && Boolean(value.trim());
const index = (value, count) => Number.isInteger(value) && value >= 0 && value < count;
const list = (value, path, empty = false) => {
  requireValue(Array.isArray(value) && (empty || value.length > 0), path);
  return value;
};

function planEvidence(source, criteria) {
  const evidence = list(source.evidence, 'evidence').map((entry, n) => {
    requireValue(text(entry?.file) && text(entry.excerpt), `evidence[${n}].file/excerpt`);
    return { file: entry.file, excerpt: entry.excerpt };
  });
  const refs = (indices, path) => list(indices, path).map(i => {
    requireValue(index(i, evidence.length), `${path}: evidence[${i}] is missing`);
    return evidence[i];
  });
  const changes = list(source.changes, 'changes').map((entry, n) => {
    const path = `changes[${n}]`;
    requireValue(text(entry?.file) && text(entry.change), path);
    const claims = list(entry.claims, `${path}.claims`).map((claim, c) => {
      const label = `${path}.claims[${c}]`;
      requireValue(index(claim?.criterion, criteria.length), `${label}.criterion`);
      const cited = refs(claim.evidence, `${label}.evidence`);
      requireValue(cited.some(e => e.file === entry.file), `${label}: cite ${entry.file}`);
      return { criterion: claim.criterion, evidence: cited };
    });
    return { file: entry.file, change: entry.change, claims };
  });
  const proof = list(source.proof, 'proof').map((entry, n) => {
    requireValue(['red', 'final'].includes(entry?.phase) && text(entry.command) && text(entry.expected), `proof[${n}]`);
    return { phase: entry.phase, command: entry.command, expected: entry.expected };
  });
  requireValue(proof.some(p => p.phase === 'final'), 'proof: final command required');
  const checks = list(source.checks, 'checks', true).map((entry, n) => {
    requireValue(text(entry?.check) && text(entry.before) && text(entry.after), `checks[${n}]`);
    return { check: entry.check, before: entry.before, after: entry.after, evidence: refs(entry.evidence, `checks[${n}].evidence`) };
  });
  requireValue(checks.length <= 12 && new Set(checks.map(c => c.check)).size === checks.length, 'checks: at most 12 uniquely named checks');
  return { changes, checks, proof };
}

function doneEvidence(source, criteria) {
  const baseline = source.baseline;
  const sha = /^[a-f0-9]{40}$/;
  requireValue(sha.test(baseline?.base) && sha.test(baseline?.head) && baseline.base !== baseline.head && text(baseline.diff), 'baseline: base, head and diff required');
  const runs = list(source.runs, 'runs').map((entry, n) => {
    const path = `runs[${n}]`;
    requireValue(['red', 'final'].includes(entry?.phase) && text(entry.command) && text(entry.output), path);
    requireValue(Number.isInteger(entry.exit) && entry.exit >= 0 && entry.exit <= 255 && (entry.phase === 'final' ? entry.exit === 0 : entry.exit > 0), `${path}.exit`);
    const targets = list(entry.criteria, `${path}.criteria`);
    requireValue(targets.every(i => index(i, criteria.length)), `${path}.criteria contains an unknown criterion`);
    return { phase: entry.phase, command: entry.command, exit: entry.exit, output: entry.output, criteria: targets };
  });
  for (const n of criteria.keys()) {
    requireValue(runs.some(run => run.phase === 'final' && run.criteria.includes(n)), `criteria[${n}] needs a final run`);
  }
  return { baseline: { base: baseline.base, head: baseline.head, diff: baseline.diff }, runs };
}

export function buildPacket(gate, requirements, source, model = requirements?.model) {
  requireValue(text(model) && !/(?:^|[-_/])latest$/i.test(model), 'owner requirements must pin a model version');
  requireValue(text(requirements?.objective), 'owner objective');
  const criteria = list(requirements.criteria, 'owner criteria');
  requireValue(criteria.every(text), 'owner criteria');
  requireValue(['plan', 'done'].includes(gate) && source && typeof source === 'object', 'packet source');
  const evidence = gate === 'plan' ? planEvidence(source, criteria) : doneEvidence(source, criteria);
  return { rubric: RUBRIC, model, objective: requirements.objective, criteria: [...criteria], ...evidence };
}

// Replays scores without dispatching, changing a threshold, or writing an acceptance receipt.
export async function explain(gateName, packet, answers, model) {
  const { evaluate } = await import('./jev.mjs');
  return evaluate(gateName, packet, answers, model);
}
