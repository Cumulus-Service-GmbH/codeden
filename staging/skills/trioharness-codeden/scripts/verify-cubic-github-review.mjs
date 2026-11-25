#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const parse = values => Object.fromEntries(values.reduce((all, value, index) =>
  index % 2 ? all : [...all, [value.replace(/^--/, ''), values[index + 1]]], []));
const args = parse(process.argv.slice(2));
const repo = args.repo;
const pull = args.pr;
const sha = args.sha?.toLowerCase();
const output = args.output ? resolve(args.output) : null;
if (!/^[^/]+\/[^/]+$/.test(repo || '') || !/^\d+$/.test(pull || '') || !/^[0-9a-f]{40}$/.test(sha || '') || !output) {
  throw new Error('Use --repo owner/repo --pr <number> --sha <40-hex> --output <receipt>.');
}

const ghJson = endpoint => {
  const result = spawnSync('gh', ['api', '--paginate', '--slurp', endpoint], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`GitHub API read failed for ${endpoint}: ${result.stderr.trim() || 'unknown error'}`);
  const pages = JSON.parse(result.stdout);
  return Array.isArray(pages) ? pages.flat() : pages;
};

const reviews = ghJson(`repos/${repo}/pulls/${pull}/reviews`);
const marker = new RegExp(`cubic:review-post:([^:]+):${sha}:([^\\s-][^\\s]*)`, 'i');
const candidates = reviews
  .filter(review => review?.user?.login === 'cubic-dev-ai[bot]' && marker.test(review.body || ''))
  .sort((left, right) => Date.parse(right.submitted_at || 0) - Date.parse(left.submitted_at || 0));
const review = candidates[0] || null;
let receipt;
if (!review) {
  receipt = { verdict: 'BLOCK', reason: 'MISSING_EXACT_SHA_CUBIC_REVIEW', repo, pull: Number(pull), sha };
} else {
  const match = (review.body || '').match(marker);
  const reviewRunId = match?.[2] || null;
  const comments = ghJson(`repos/${repo}/pulls/${pull}/comments`);
  const inline = comments.filter(comment =>
    comment?.user?.login === 'cubic-dev-ai[bot]' &&
    typeof comment.body === 'string' &&
    reviewRunId && comment.body.includes(`cubic:review-run=${reviewRunId}`));
  const summaryIssues = Number((review.body || '').match(/\*\*(\d+)\s+issues found\b/i)?.[1] || 0);
  receipt = {
    verdict: summaryIssues === 0 && inline.length === 0 ? 'CLEAN' : 'BLOCK',
    reason: summaryIssues > 0 ? 'CUBIC_SUMMARY_HAS_FINDINGS' : inline.length > 0 ? 'CUBIC_INLINE_FINDINGS_PRESENT' : 'CLEAN',
    repo,
    pull: Number(pull),
    sha,
    reviewId: review.id,
    submittedAt: review.submitted_at,
    reviewRunId,
    summaryIssueCount: summaryIssues,
    inlineIssueCount: inline.length,
    inlineCommentIds: inline.map(comment => comment.id),
    source: 'raw GitHub PR review body and inline comments'
  };
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (receipt.verdict !== 'CLEAN') process.exit(2);
