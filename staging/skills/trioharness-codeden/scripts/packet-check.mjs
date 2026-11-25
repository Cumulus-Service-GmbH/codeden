#!/usr/bin/env node
// GENERATED: copy of ~/.config/trioharness/skill-scripts/packet-check.mjs written by team-sync.mjs, don't edit by hand.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { applyAppTeam, loadTeam, trustedTeamFile } = await import(
  existsSync(new URL('./team.mjs', import.meta.url)) ? './team.mjs' : '../team-lib.mjs'
);
// These aliases also occur in legacy invoke-lane protocol names.
export const alias = { closureReview: 'opus', initialPlan: 'fable' };
const generic = new RegExp(`\\b(?:(?:claude|gpt|gemini|deepseek|qwen|kimi|glm|llama|mistral|grok|o[0-9])-[a-z0-9._-]*[0-9][a-z0-9._-]*|${alias.closureReview}|sonnet|haiku|${alias.initialPlan})\\b`, 'giu');
const escape = token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function modelLiterals(text, team) {
  const members = [...(team?.app?.team ?? team?.team ?? []), ...(team?.mirror?.team ?? [])];
  const names = [...new Set(members.map(({ model }) => model).filter(model => typeof model === 'string' && /[\d/.-]/.test(model)))]
    .sort((a, b) => b.length - a.length).map(escape);
  const configured = names.length ? new RegExp(`\\b(?:${names.join('|')})\\b`, generic.flags) : null;
  return text.split(/\r\n|\r|\n/).flatMap((line, i) => {
    const candidates = [...line.matchAll(generic), ...(configured ? line.matchAll(configured) : [])];
    let end = 0;
    return candidates.sort((a, b) => a.index - b.index || b[0].length - a[0].length).flatMap(({ 0: match, index }) => {
      if (index < end) return [];
      end = index + match.length;
      return [{ line: i + 1, match }];
    });
  });
}

export function assertPacketModelFree(text, file, team) {
  const matches = modelLiterals(text, team);
  if (matches.length) throw new Error(matches.map(({ line, match }) => `PACKET_MODEL_LITERAL: ${file}:${line}: ${match}`).join('\n'));
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  try {
    const [file, extra] = process.argv.slice(2);
    if (!file || extra !== undefined) throw new Error('Usage: node packet-check.mjs <packet>');
    let team = loadTeam();
    if (process.env.TEAM_FILE) team = applyAppTeam(team, trustedTeamFile(process.env.TEAM_FILE));
    assertPacketModelFree(readFileSync(file, 'utf8'), file, team);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
