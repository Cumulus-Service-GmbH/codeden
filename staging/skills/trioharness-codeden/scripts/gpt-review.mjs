// TrioHarness Lean — GPT review engine for invoke-lane.mjs (--review-engine gpt).
// Runs the existing reviewer / reviewer-plan contracts through Codex exec in a read-only sandbox and
// converts the result into the same terminal-record shape the launcher already validates, so every
// downstream gate (required markers, receipts, revalidation, promotion lock) applies unchanged.
import { isConfiguredPin, unsetRole } from './team.mjs';

export function gptReviewArgs({ model, effort, repo, lastMessagePath, role = 'reviewerFallback' }) {
  if (!isConfiguredPin({ provider: 'codex', model, effort })) throw new Error(unsetRole(role));
  return ['wrap', 'codex', '--no-mcp', '--code-memory', 'none', '--',
    'exec', '--ignore-user-config', '--sandbox', 'read-only', '--disable', 'hooks', '--ephemeral', '--json',
    '--skip-git-repo-check', '--model', model, '-c', `model_reasoning_effort="${effort}"`,
    '-C', repo, '--output-last-message', lastMessagePath, '-'];
}

export function parseEvents(text) {
  return String(text || '').split(/\r\n?|\n/).map(l => l.trim()).filter(Boolean)
    .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

const modelFieldsIn = events => {
  const found = [];
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'model' || k === 'model_slug') && typeof x === 'string') found.push(x);
      else walk(x, depth + 1);
    }
  };
  events.forEach(e => walk(e, 0));
  return found;
};

// Verified only when: the turn completed without error events, a final message exists, no runtime record
// names a different model, the direct API key was removed (subscription auth), and the launch was isolated.
export function verifyGptRuntime({ launch, events, lastMessage, expectedModel, expectedEffort }) {
  const completed = events.some(e => e.type === 'turn.completed');
  const failed = events.some(e => e.type === 'turn.failed' || e.type === 'error');
  const models = modelFieldsIn(events);
  const modelContradiction = models.some(m => m !== expectedModel);
  const isolated = Boolean(launch?.engine === 'codex' && launch.sandbox === 'read-only' && launch.ignoreUserConfig && launch.noMcp && launch.hooksDisabled);
  const apiKeySource = launch?.directApiKeyRemoved ? 'none' : 'environment';
  const usage = events.filter(e => e.type === 'turn.completed').at(-1)?.usage || null;
  return {
    verified: Boolean(completed && !failed && typeof lastMessage === 'string' && lastMessage.trim() && !modelContradiction
      && launch?.requestedModel === expectedModel && launch?.requestedEffort === expectedEffort && apiKeySource === 'none' && isolated),
    engine: 'codex',
    model: models[0] || launch?.requestedModel || null,
    modelEvidence: models.length ? 'runtime-reported' : 'requested-only (codex exec reported no model field; no fallback route configured)',
    effort: launch?.requestedEffort || null,
    apiKeySource,
    mcpIsolated: isolated,
    customizationIsolated: isolated,
    usage
  };
}

// Same record shape the launcher reads for Claude reviews: one init record and one terminal result record.
export function synthesizeReviewStream({ model, effort, lastMessage, events, launch }) {
  const failed = events.some(e => e.type === 'turn.failed' || e.type === 'error');
  const usage = events.filter(e => e.type === 'turn.completed').at(-1)?.usage || null;
  const common = { model, effort, apiKeySource: launch?.directApiKeyRemoved ? 'none' : 'environment', engine: 'codex' };
  const init = { type: 'system', subtype: 'init', ...common, mcp_servers: [], plugins: [], slash_commands: [], hooks: [] };
  const result = { type: 'result', subtype: failed || !lastMessage ? 'error' : 'success', is_error: Boolean(failed || !lastMessage), result: lastMessage || '', usage, ...common };
  return `${JSON.stringify(init)}\n${JSON.stringify(result)}\n`;
}
