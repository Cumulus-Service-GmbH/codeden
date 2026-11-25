#!/usr/bin/env node
// Claude Code and Codex PreToolUse guard.
// CodeDen worktrees are identified by cwd or CLAUDE_PROJECT_DIR.
// Outside CodeDen the shell checks cover secrets, the keychain and SQL.
// Blocks (exit 2) actions the dark factory must never take on its own:
// force/hook-bypassing pushes, pushes to the default branch, admin or --auto merges,
// API merges, repo deletion, GitHub secrets/variables/auth, Azure/deploy CLIs,
// credential reads, hook tampering.
// Allowed for PM/worker sessions (2026-11-20): gh pr merge (--merge/--squash/--rebase,
// --match-head-commit, --delete-branch; not --auto, not --admin), gh pr review --approve,
// gh run rerun, gh workflow run, and gh ruleset reads.
// PM-started sessions must carry a Team role tag and match the session Team, or the exported Default Team outside a session.
// Azure (2026-11-21, replaces the blanket az/azd block): read-only verbs anywhere; get-access-token only captured or piped;
// writes only when every resource, group and app named is on the qa/test list of ~/.config/trioharness/azure-targets.json;
// deploy.mjs --target qa/test allowed; anything unclassifiable is blocked with what is missing.
// Exact PRD writes in the card allowlist can ask for owner approval in supervised Claude sessions.
// Reviewer bypass (2026-11-21): a direct `codex exec` whose -m/--model/-c model= is not a codex model of a role in
// ~/.config/trioharness/team.json, and a direct `agy -p|--print|--prompt` (the primary Code Reviewer runs only through
// ~/.codex/bin/gemini-review.mjs, which the skills' team-review.mjs calls), are blocked.
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

let azureProgramIndex, checkAzureUrl, checkExecution, isAssignment, launcherTarget, launcherName, programName,
  interpreterScriptIndex, checkSourceContent, collectHeredocs, SCRIPT_SECRET_FAMILY, resolveScriptPath;
let matchPrdCard, matchWebDeployCard, withOutputNone, isDeployDryRun, reservePrdCard, creationType, describeCreation, describeCreationTemplate,
  matchAccessCard, dbopsQuery, dbopsLanVerbs;
async function loadGuardRules() {
  ({
    azureProgramIndex, checkAzureUrl, checkExecution, isAssignment, launcherTarget, launcherName, programName,
    interpreterScriptIndex, checkSourceContent, collectHeredocs, SCRIPT_SECRET_FAMILY, resolveScriptPath,
  } = await import("./codeden-guard-secrets.mjs"));
  ({ matchPrdCard, matchWebDeployCard, withOutputNone, isDeployDryRun, reservePrdCard, creationType, describeCreation, describeCreationTemplate,
    matchAccessCard, dbopsQuery, dbopsLanVerbs } =
    await import("./codeden-guard-prd-cards.mjs"));
}

const WT_ROOT = resolve(process.env.CODEDEN_HOME || `${homedir()}/.codeden`, "wt") + sep;

const inCodeDen = path => typeof path === "string" && (resolve(path) + sep).startsWith(WT_ROOT);
let teamLib, teamLoadError;
try {
  teamLib = await import(new URL("../../.config/trioharness/team-lib.mjs", import.meta.url));
} catch (error) {
  teamLoadError = `TEAM_LOAD_FAILED: ${error.message}`;
}
const loadTeam = file => {
  if (teamLoadError) throw new Error(teamLoadError);
  return teamLib.loadTeam(file ?? teamLib.teamFile({ real: true }));
};
const codeDenScope = (cwd, project = process.env.CLAUDE_PROJECT_DIR, codex = false) => {
  const defaultRoot = codex ? join(userInfo().homedir, ".codeden", "wt") + sep : null;
  return [cwd, project].some(path => inCodeDen(path) ||
    defaultRoot && typeof path === "string" && (resolve(path) + sep).startsWith(defaultRoot));
};

const PROSE_FILE = /\.(?:md|txt|rst|adoc|json)$/i;
const SHELL_FILE = /\.(?:sh|bash|zsh|command)$/i;
const SHELL_HEADER = /^#![^\r\n]*[\/\s](?:sh|bash|zsh|dash|ksh|fish)(?=\s|$)/i;
const NON_POSIX_FILE = /\.(?:ps1|psm1|bat|cmd)$/i;
const SOURCE_FILE = /\.(?:py|js|mjs|cjs|ts|rb|pl|php)$/i;
const SHELL_CONTROL = /^(?:if|then|elif|else|do|while|until|coproc|\{|!)$/;
const commandHead = (value, syntax = value) => isAssignment(value) || value === syntax && SHELL_CONTROL.test(value);
const COMPOUND_CLOSE = new Map([
  ["if", "fi"], ["while", "done"], ["until", "done"], ["for", "done"], ["select", "done"], ["case", "esac"],
]);

// Redirections may appear before the executable or between its arguments.
function commandWords(words, describe = false) {
  const operands = [];
  const redirects = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const syntax = describe ? word.syntax : word;
    const redirect = /^(?:&>>?|\d*(?:<<<|<<-|<<|<>|<&|<|>>|>\||>&|>))(.*)$/.exec(syntax);
    if (!redirect || syntax.startsWith("<(")) { operands.push(word); continue; }
    let target;
    const next = describe ? words[i + 1]?.syntax : words[i + 1];
    // A quoted, attached target is included in the raw word but absent from syntax.
    if (!redirect[1] && (!describe || word.raw === syntax) && next !== undefined && !/^(?:&>|\d*[<>])/.test(next)) {
      target = words[++i];
    } else if (describe) {
      const prefix = syntax.slice(0, syntax.length - redirect[1].length);
      target = { value: word.value.slice(prefix.length), syntax: redirect[1] };
    }
    redirects.push(describe ? { ...word, target } : word);
  }
  return { operands, redirects };
}

export function checkHookInput(input, targets, project = process.env.CLAUDE_PROJECT_DIR) {
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  if (tool === "mcp__codeden__start_session") return checkStartSession(ti, undefined, input.cwd);
  if (!codeDenScope(input.cwd || process.cwd(), project)) {
    return tool === "Bash" ? checkOutsideBash(String(ti.command || ""), targets) : null;
  }
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const denial = checkLedgerPath(String(ti.file_path || ti.notebook_path || ""), input.cwd);
    if (denial) return denial;
  }
  if (tool === "Bash") return checkCommand(String(ti.command || ""), targets, 0, { cwd: input.cwd || process.cwd() });
  if (tool === "Agent" || tool === "Task") return checkAgentPin(ti, "claude", undefined, input.cwd);
  const path = String(ti.file_path || ti.notebook_path || "");
  const pathDenial = checkPath(path);
  if (pathDenial || PROSE_FILE.test(path)) return pathDenial;
  const texts = tool === "Write" ? [ti.content] : tool === "Edit" ? [ti.new_string] :
    tool === "MultiEdit" ? (ti.edits || []).map(edit => edit.new_string) : [];
  for (const text of texts.filter(value => typeof value === "string")) {
    const inspect = (command, capturedOutput) => checkCommand(command, targets, 0, { capturedOutput });
    const denial = SHELL_FILE.test(path) || SHELL_HEADER.test(text)
      ? checkCommand(text, targets, 0, { scriptContent: true })
      : NON_POSIX_FILE.test(path) ? checkCommand(text, targets, 0, { structural: false })
      : SOURCE_FILE.test(path) ? structuralSizeDenial(text) ?? checkSourceContent(text, inspect) : null;
    if (denial) return "script content: " + denial;
  }
  return null;
}

function checkCodexInput(input) {
  const { tool_name: tool, tool_input: ti, cwd } = input;
  if (typeof tool !== "string" || !tool) return "expected Codex tool_name";
  if (tool === "mcp__codeden__start_session") return checkStartSession(ti, undefined, cwd);
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    return codeDenScope(cwd, undefined, true) ? checkLedgerPath(String(ti?.file_path || ti?.notebook_path || ""), cwd) : null;
  }
  if (tool !== "Bash" && tool !== "spawn_agent" && tool !== "Agent") return null;
  if (!ti || typeof ti !== "object" || Array.isArray(ti)) return "expected Codex tool_input object";
  if (tool !== "Bash") return checkAgentPin(ti, "codex", undefined, cwd);
  if (typeof ti.command !== "string" || typeof cwd !== "string" || !isAbsolute(cwd)) {
    return "expected Codex Bash command and absolute cwd";
  }
  return codeDenScope(cwd, undefined, true)
    ? checkCommand(ti.command, undefined, 0, { codex: true, cwd })
    : checkOutsideBash(ti.command);
}

function prdInspectionLimit(command, depth) {
  const limit = depth > 16 ? "nested command exceeds inspection depth" : structuralSizeDenial(command);
  if (limit && /(?:^|[^\w-])(?:az(?:\.exe|\.cmd)?|azd|azcmagent|terraform|pulumi|gh|dbops|deploy\.mjs|new-az[\w-]+)(?![\w-])/i
    .test(command.replace(/["'\\]/g, ""))) return limit;
  return null;
}

function checkOutsideBash(cmd, targets, depth = 0) {
  if (cmd.includes("provision-authority-mount")) return "authority mount requires an owner approval card";
  return checkRawShellSecrets(cmd) ??
    checkSecrets(cmd, targets, depth, false, checkOutsideBash, { structural: false, outsideCodeDen: true }) ??
    (matchWebDeployCard(cmd, () => targets ?? defaultAzureTargets(), { outputNone: false })
      ? "card-gated PRD action: run it in a Supervised Claude CodeDen session"
      : null);
}

async function main() {
  const codex = process.argv[2] === "codex";
  let input;
  let parsing = false;
  try {
    let raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) raw += chunk;
    parsing = true;
    input = JSON.parse(raw);
    parsing = false;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected a hook input object");
    const bash = input.tool_name === "Bash" && typeof input.tool_input?.command === "string";
    if (!codex && !bash && !["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(input.tool_name) && input.tool_name !== "mcp__codeden__start_session" &&
        !inCodeDen(input.cwd || process.cwd()) && !inCodeDen(process.env.CLAUDE_PROJECT_DIR)) return;
    if (input.tool_name !== "mcp__codeden__start_session" || codex) await loadGuardRules();
    let reason = codex ? checkCodexInput(input) : checkHookInput(input);
    const scopedBash = bash && codeDenScope(input.cwd || process.cwd(), undefined, codex);
    if (scopedBash) {
      const command = input.tool_input.command;
      const cwd = input.cwd || process.cwd();
      const creation = checkResourceCreation(command, cwd);
      if (creation && !/^(?:command exceeds 64 KB|nested command exceeds inspection depth)\b/.test(reason ?? "")) {
        const secretDenial = checkResourceCompanionSecrets(command, cwd);
        reason = secretDenial ?? reason;
        // Recheck all the existing restrictions, deferring only this creation's target
        // classification. A resource card cannot authorize a second shell operation.
        const simple = matchResourceCard(command, cwd);
        if (simple) {
          reason = secretDenial ?? checkCreationPrdTokens(simple) ??
            checkCommand(command, undefined, 0, { cwd, deferCreation: simple.type });
          if (!reason && !codex && input.permission_mode === "default") {
            const ledgerDenial = reservePrdCard(command, input.session_id, "resource:" + simple.type);
            if (!ledgerDenial) return ask(simple.reason);
            reason = simple.reason + "; " + ledgerDenial;
          }
        }
        if (!reason || (!secretDenial && !simple && /names no resource|not on the qa\/test list/.test(reason))) reason = creation;
      }
    }
    if (!codex && reason && scopedBash) {
      const command = input.tool_input.command;
      const cwd = input.cwd || process.cwd();
      const card = matchPrdCard(command, cwd, defaultAzureTargets) ?? literalAccessCard(command);
      if (card) {
        // Recheck the exact simple command with only its classified write deferred.
        const inspect = card.sqlIdentity ? command.replace(card.sqlIdentity, "authority-target-id") : command;
        reason = card.scope === "repo-settings" && card.denial ? card.denial :
          checkCommand(inspect, undefined, 0, { cwd, deferPrdWrite: card.scope });
        if (!reason) {
          if (card.denial) reason = card.denial;
          else if (input.permission_mode !== "default") {
            const mode = typeof input.permission_mode === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(input.permission_mode)
              ? input.permission_mode : input.permission_mode == null ? "missing" : "unknown";
            reason = `card-gated PRD action: run it in a Supervised Claude session so the owner gets an approval card (in ${mode} an ask would be auto-allowed)`;
          } else {
            const details = card.details?.(input.session_id) ?? card;
            const approvalReason = details.reason;
            reason = details.denial ?? (approvalReason ? reservePrdCard(details.ledgerCommand ?? command, input.session_id, card.id, { claim: details.claim }) : "card-gated PRD action: invalid card details");
            if (!reason) return ask(approvalReason,
              details.command ? { ...input.tool_input, command: details.command } : undefined);
          }
        }
      }
    }
    if (reason) {
      const guidance = codex ? "" : " This is a factory rule; leave it to the merge queue or to Moshe.";
      process.stderr.write(`Blocked by codeden-guard: ${reason}.${guidance}\n`);
      process.exitCode = 2;
    }
  } catch (error) {
    if (codex || ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "mcp__codeden__start_session"].includes(input?.tool_name) || inCodeDen(input?.cwd || process.cwd()) || inCodeDen(process.env.CLAUDE_PROJECT_DIR)) {
      const detail = parsing ? "invalid JSON on stdin" : error.message;
      process.stderr.write(`codeden-guard internal error: ${detail}\n`);
      process.exitCode = 2;
    }
  }
}

function ask(approvalReason, updatedInput) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: approvalReason, updatedInput,
  } }) + "\n");
}

export function checkCommand(cmd, targets, depth = 0, options = {}) {
  if (depth > 16) return "nested command exceeds inspection depth";
  const c = cmd.replace(/\s+/g, " ");
  const rules = [
    [/\bgit\b[^|;&]*\bpush\b[^|;&]*(\s--force\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s--force-with-lease\b|\s--force-if-includes\b|\s--mirror\b|\s\+[\w./-]+)/, "force or mirror push"],
    [/--no-verify\b/, "--no-verify bypasses hooks"],
    [/\bgit\b[^|;&]*\bpush\b[^|;&]*[\s:](origin\s+)?(HEAD:)?(refs\/heads\/)?(main|master|develop)\b(?![\w/-])/, "push to a default branch"],
    [/\bgit\b[^|;&]*\bpush\b[^|;&]*(\s--delete\b|\s-d\b|\s:[\w./-]+)/, "deleting a remote branch"],
    [/\bgit\b[^|;&]*\bconfig\b[^|;&]*core\.hooksPath/, "changing core.hooksPath"],
    [/\.git\/hooks\b/, "touching .git/hooks"],
    [/\bgh\s+pr\s+merge\b[^|;&]*\s--admin\b/, "merging with --admin bypasses branch protection"],
    [/\bgh\s+pr\s+merge\b[^|;&]*\s--auto\b/, "gh pr merge --auto (merge directly with --match-head-commit instead)"],
    [/\bgh\s+api\b[^|;&]*\/(merge|merges)\b/, "merging through the GitHub API"],
    [/\bgh\s+(repo\s+(edit|delete|archive|rename)|secret|variable|auth\s+(token|refresh|login|logout))\b/, "GitHub settings, secrets or auth"],
    [/\bgh\s+release\s+(create|delete|upload)\b/, "creating or changing releases"],
    [/\b(kubectl|terraform\s+destroy|vercel\s+(deploy|--prod)|fly\s+deploy|netlify\s+deploy)\b/, "deploy CLI"],
    [/\bterraform\b(?:\s+-chdir=\S+)?\s+apply\b/, "deploy CLI"],
  ];
  for (const [re, why] of rules) if (re.test(c)) return why;
  // az reads `@<path>` values from local files: env and secret flags must never load a file into an app.
  const prdScope = depth === 0 && isDeployDryRun(cmd) ? "deploy dry-run" : options.deferPrdWrite;
  const nested = (text, config, level, literalOnly, overrides) =>
    checkCommand(text, config, level, { ...options, deferPrdWrite: undefined, deferCreation: undefined, hookCwd: options.hookCwd ?? options.cwd, ...overrides, ...(literalOnly && { structural: false }) });
  const joined = joinContinuations(cmd);
  const reviewerCwd = options.cwd ?? options.hookCwd;
  const liveDenial = checkLedgerCommand(cmd, options.cwd) ?? checkRawShellSecrets(cmd) ?? checkGitHubEnvironment(joined) ??
    (["ruleset", "branch-protection", "repo-settings", "actions-cleanup"].includes(options.deferPrdWrite) ? null : checkApiWriteScope(cmd) ?? checkApiWrites(c)) ??
    checkRawSecretForms(cmd, joined, targets, depth, true) ??
    checkAzureTokenOutput(cmd, options.capturedOutput) ?? checkAzureCommands(cmd, targets, true, undefined, prdScope, options.deferCreation) ??
    checkRunningRef(cmd, true) ?? checkReviewerBypass(cmd, undefined, true, reviewerCwd);
  if (liveDenial) return liveDenial;

  return structuralSizeDenial(cmd) ?? checkRawSecretForms(cmd, joined, targets, depth) ??
    checkSecretStructure(cmd, joined, targets, depth, false, nested, options) ??
    checkAzure(cmd, targets, options.capturedOutput, prdScope, options.deferCreation) ??
    checkRunningRef(cmd) ?? checkRunningRef(joined) ??
    checkReviewerBypass(cmd, undefined, false, reviewerCwd) ?? checkReviewerBypass(joined, undefined, false, reviewerCwd);
}

const SHELL_SECRET_RULES = [
  [/\bsecurity\s+find-(generic|internet)-password\b/, "reading the macOS keychain"],
  [/(^|[\s;&|])(printenv|env)\s*($|[|;&])/, "dumping the environment"],
  [/\b(cat|less|more|head|tail|bat)\s+[^|;&]*(\.env(\.[\w-]+)?|id_rsa|id_ed25519|\.npmrc|\.netrc|credentials(\.json)?|auth\.json|jev\.env)(\s|$)/, "reading a credential file"],
];

function checkRawShellSecrets(executable) {
  const compact = executable.replace(/\s+/g, " ");
  for (const [pattern, reason] of SHELL_SECRET_RULES) if (pattern.test(compact)) return reason;
  if (/\bsecurity\s+find-(generic|internet)-password\b/.test(normalizeCmd(executable))) return "reading the macOS keychain";
  return null;
}

function advanceParser(previous, next) {
  if (!(next > previous)) throw new Error("shell parser cursor did not advance");
  return next;
}

// Shell-like split into commands and words. Quoted text stays in one word.
export function shellCommands(cmd, { start = 0, stop = cmd.length, substitutions, describeWords = false, legacy = false, heredocSpans, casePatterns = false } = {}) {
  const cmds = []; let words = []; let w = null; let q = null;
  let syntax = "";
  let wordStart = start;
  let piped = false;
  const groups = [];
  const groupPiped = () => groups.some(group => group.piped);
  const compoundPrefix = () =>
    words.every(word => commandHead(word.value ?? word, word.syntax)) ||
    /^time(?: -p)?$/.test(words.map(word => word.syntax ?? word).join(" "));
  const endWord = () => {
    if (!legacy && q === null && w !== null && w === syntax && compoundPrefix()) {
      const closer = COMPOUND_CLOSE.get(syntax);
      if (typeof closer === "string") groups.push({ kind: closer, piped, caseStage: casePatterns && syntax === "case" ? "header" : undefined, start: wordStart });
      else if (groups.at(-1)?.kind === syntax) groups.pop();
    }
    const group = groups.at(-1);
    if (w !== null && group?.caseStage === "header" && group.start !== wordStart) {
      if (group.caseSubject && w === "in" && syntax === "in") {
        group.caseStage = "pattern";
        words = [];
        w = null;
      } else {
        group.caseSubject = true;
      }
    }
    if (w !== null) words.push(describeWords ? { value: w, syntax, raw: cmd.slice(wordStart, cursor), start: wordStart, end: cursor, piped } : w);
    w = null;
    syntax = "";
  };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  let cursor = start;
  for (let i = start; i < stop; i = advanceParser(cursor, i + 1)) {
    cursor = i;
    const heredoc = heredocSpans?.get(i);
    if (heredoc && heredoc.end > i) { i = heredoc.end - 1; continue; }
    const caseGroup = groups.at(-1);
    if (!q && w === null && caseGroup?.caseStage === "pattern") {
      if (/\s/.test(cmd[i])) continue;
      if (cmd[i] === "#") {
        while (i + 1 < stop && cmd[i + 1] !== "\n") i++;
        continue;
      }
      if (/^esac(?=$|[\s;&|])/.test(cmd.slice(i, stop))) {
        groups.pop();
        i += 3;
        continue;
      }
      const pattern = /^\(?(?:'[^']*'|"[^"]*"|\\[\s\S]|[^)'"\\;])*\)/.exec(cmd.slice(i, stop));
      if (pattern) {
        caseGroup.caseStage = "body";
        i += pattern[0].length - 1;
        continue;
      }
    }
    if (w === null) wordStart = i;
    const ch = cmd[i];
    const span = q !== "'" && substitutions?.get(i);
    if (span) {
      if (span.marker === "<(" && w !== null && !syntax.endsWith("=")) {
        endWord();
        wordStart = i;
      }
      w = (w ?? "") + span.marker;
      syntax += span.marker;
      i = span.end - 1;
      continue;
    }
    if (substitutions && !q && w === null && ch === "#") {
      while (i + 1 < stop && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (q) {
      if (ch === q) {
        q = null;
      } else if (q === '"' && ch === "\\" && i + 1 < stop) {
        w += cmd[++i];

      } else {
        w += ch;
        if (q === '"' && /[$`]/.test(ch)) syntax += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; w ??= ""; continue; }
    if (ch === "\\" && i + 1 < stop) {
      w = (w ?? "") + cmd[++i];

      continue;
    }
    if (!legacy && w === null && (ch === "{" || ch === "}") && /[\s;&|()]|^$/.test(cmd[i + 1] ?? "")) {
      if (ch === "{" && compoundPrefix()) {
        endCmd();
        groups.push({ kind: "{", piped });
        continue;
      }
      if (ch === "}" && !words.length && groups.at(-1)?.kind === "{") {
        groups.pop();
        piped = groupPiped();
        continue;
      }
    }
    if (!legacy && (ch === "&" && (/[<>]$/.test(syntax) || cmd[i + 1] === ">") ||
        ch === "|" && /^\d*>$/.test(syntax))) {
      w = (w ?? "") + ch; syntax += ch; continue;
    }
    if (!legacy && (ch === "<" || ch === ">") && w !== null && !/^(?:\d*[<>]+|&>*)$|^\d+$/.test(syntax)) {
      endWord();
      wordStart = i;
    }
    if (/[;&|\n()]/.test(ch)) {
      const hadWords = w !== null || words.length > 0;
      endCmd();
      if (legacy) continue;
      if (ch === ";" && groups.at(-1)?.caseStage === "body" && /^[;&]/.test(cmd[i + 1] ?? "")) {
        groups.at(-1).caseStage = "pattern";
        i += cmd[i + 1] === ";" && cmd[i + 2] === "&" ? 2 : 1;
      }
      if (ch === "(") groups.push({ kind: "(", piped });
      if (ch === ")" && groups.at(-1)?.kind === "(") groups.pop();
      if (ch === "|" && cmd[i + 1] !== "|" && cmd[i - 1] !== "|") {
        piped = true;
        if (cmd[i + 1] === "&") i++;
      }
      else if ((ch !== "\n" && ch !== "(") || hadWords) piped = groupPiped();
      continue;
    }
    if (/\s/.test(ch)) { endWord(); continue; }
    w = (w ?? "") + ch;
    syntax += ch;
  }
  cursor = stop;
  endCmd();
  return cmds;
}

function resolveTeamRole(team, ref) {
  return typeof ref === "string" ? ref.split(/\.|\[(\d+)\]/).filter(Boolean)
    .reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, team.roles) : undefined;
}

function teamPins(team, provider, members) {
  const roles = Object.values(team.roles || {});
  const { primary, fallback } = team.roles?.codeReviewer || {};
  const pins = members ? Object.values(members) : [...roles, primary, ...Object.values(fallback ?? {}).flat()];
  return pins.filter(pin => pin?.provider === provider && teamLib.isConfiguredPin(pin));
}

function loadSessionTeam(teamFile, cwd, resolvedFile) {
  let app;
  if (resolvedFile) {
    try { app = teamLib.trustedTeamFile(resolvedFile, { repo: cwd }); }
    catch (error) { throw new Error(`TEAM_FILE_INVALID: ${error.message}`); }
  }
  const team = loadTeam(teamFile);
  return app ? teamLib.applyAppTeam(team, app) : team;
}

export function teamCodexModels(file, cwd = process.cwd(), resolvedFile = process.env.TEAM_FILE) {
  const team = loadSessionTeam(file, cwd, resolvedFile);
  return new Set(teamPins(team, "codex", team.app && team.memberPins).map(pin => pin.model));
}

const claudeTeamAgents = new Set(["trio-code-reviewer"]);

export function checkAgentPin(input, provider, teamFile, cwd = process.cwd(), resolvedFile = process.env.TEAM_FILE) {
  const claude = provider === "claude";
  if (claude ? input.subagent_type === "fork" || (input.model == null && !claudeTeamAgents.has(input.subagent_type))
    : input.agent_type == null && input.model == null && input.reasoning_effort == null) return null;
  if (teamLoadError) return teamLoadError;

  let team;
  try { team = loadSessionTeam(teamFile, cwd, resolvedFile); }
  catch (error) { return error.message; }
  const members = team.app && team.memberPins;
  if (claude) {
    const agents = team.claudeAgents;
    const ref = Object.hasOwn(agents, input.subagent_type) ? agents[input.subagent_type] : undefined;
    const fallbackWriter = /^codeReviewer\.fallback\.([^[]+)\[0\]$/.exec(ref)?.[1];
    const key = fallbackWriter ? "reviewerFallback" : ref;
    const pin = members ? members[key] : resolveTeamRole(team, ref);
    if (ref && !teamLib.isConfiguredPin(pin)) return teamLib.unsetRole(key);
    if (members && ref && input.effort != null && input.effort !== pin.effort) return `TEAM_MISMATCH: Pass the ${teamLib.roleLabel(key)} effort from Settings → Team`;
    const candidates = ref ? [pin].filter(pin => pin?.provider === provider &&
      (!fallbackWriter || teamLib.vendorOf(team, pin.provider) !== teamLib.vendorOf(team, fallbackWriter))) : teamPins(team, provider, members);
    const aliases = [...new Set(candidates.map(({ model }) => model?.match(/^([a-z]+)$/)?.[1] ??
      model?.match(/^claude-([a-z]+)-/)?.[1]).filter(alias => alias && alias !== "default"))].sort();
    if (ref && input.model == null) {
      return `TEAM_MISMATCH: Pass the ${teamLib.roleLabel(key)} model from Settings → Team (allowed alias: ${aliases.join(", ") || "none"})`;
    }
    return aliases.includes(input.model) ? null : `Claude agent model must use a Team alias (allowed: ${aliases.join(", ") || "none"})`;
  }

  const agents = team.codexAgents;
  const { agent_type: agent, model, reasoning_effort: effort } = input;
  let pins;
  if (agent == null) {
    pins = teamPins(team, provider, members);
  } else {
    if (typeof agent !== "string" || !Object.hasOwn(agents, agent)) {
      return `Codex agent_type must be omitted or one of ${Object.keys(agents).join(", ")}`;
    }
    const ref = agents[agent];
    const pin = members ? members[ref] : resolveTeamRole(team, ref);
    if (!teamLib.isConfiguredPin(pin)) return teamLib.unsetRole(ref);
    pins = pin.provider === provider ? [pin] : [];
    if (members && (model == null || effort == null)) return `TEAM_MISMATCH: Pass the ${teamLib.roleLabel(ref)} model and effort from Settings → Team`;
  }
  if (pins.some(pin => (model == null || model === pin.model) &&
      (effort == null || (pin.effort != null && effort === pin.effort)))) return null;
  const allowed = pins.map(pin => pin.model + (pin.effort ? "/" + pin.effort : "")).join(", ");
  return `Codex agent overrides must match a Team pin (allowed: ${allowed})`;
}

function shellHeredocSpans(cmd) {
  const spans = new Map();
  if (cmd.includes("<<")) substitutionSpans(cmd, true, spans);
  return spans;
}

function* legacyAndHeredocCommands(cmd, legacyOnly) {
  yield* shellCommands(cmd, { legacy: true });
  if (legacyOnly) return;
  const heredocSpans = shellHeredocSpans(cmd);
  if (heredocSpans.size) yield* shellCommands(cmd, { heredocSpans });
}

export function checkReviewerBypass(cmd, models, legacyOnly = false, cwd = process.cwd()) {
  for (const words of legacyAndHeredocCommands(cmd, legacyOnly)) {
    for (let i = 0; i < words.length; i++) {
      const name = basename(words[i]);
      if (name === "agy" && words.slice(i + 1).some((x) => x === "-p" || x === "--print" || x === "--prompt" || x.startsWith("--prompt=") || x.startsWith("--print="))) {
        return "agy -p outside the review wrapper (run the Code Reviewer through the skill's team-review.mjs, which calls ~/.codex/bin/gemini-review.mjs)";
      }
      if (name !== "codex" || !["exec", "e"].includes(words.slice(i + 1).find((x) => !x.startsWith("-")))) continue;
      const rest = words.slice(i + 1);
      const asked = [];
      rest.forEach((x, j) => {
        if (x === "-m" || x === "--model") asked.push(rest[j + 1] || "");
        else if (x.startsWith("--model=")) asked.push(x.slice(8));
        else if (/^-m./.test(x)) asked.push(x.slice(2));
        else if ((x === "-c" || x === "--config") && /^model\s*=/.test(rest[j + 1] || "")) asked.push((rest[j + 1] || "").replace(/^model\s*=\s*/, "").replace(/^["']|["']$/g, ""));
      });
      if (!asked.length) continue;
      if (teamLoadError) return teamLoadError;
      let allowed = models;
      if (!allowed) { try { allowed = teamCodexModels(undefined, cwd); } catch (error) { return error.message; } }
      const bad = asked.find((m) => !allowed.has(m));
      if (bad !== undefined) return `codex exec -m ${bad || "<empty>"}: not a codex model of any Team role (${[...allowed].join(", ")})`;
    }
  }
  return null;
}

const API_REPO_ROOT = /^repos\/[^/]+\/[^/?]+\/?(\?|$)/;
const ACTIONS_CLEANUP_ENDPOINT = /(?:^|\/)repos\/[^/]+\/[^/]+\/actions\/(?:artifacts\/[^/?#]+|runs\/[^/?#]+\/logs)(?:[/?#]|$)/i;

function checkGitHubEnvironment(command) {
  const substitutions = new Map(substitutionSpans(command, true).map(span => [span.start, span]));
  const commands = shellCommands(command, { substitutions }).map(segment => commandWords(segment).operands);
  const controlled = /^(?:(?:GH_[A-Z_]+|GITHUB_TOKEN|PAGER|LESS(?:OPEN|CLOSE)?|SHELL|BASH_ENV|ENV|PATH|LD_[A-Z_]+|DYLD_[A-Z_]+)(?:=|$))/;
  const hasGitHub = commands.some(words => words.some(word => programName(word) === "gh"));
  if (!hasGitHub) return null;
  for (const words of commands) {
    const gh = words.findIndex(word => programName(word) === "gh");
    const prefix = gh === -1 ? words : words.slice(0, gh);
    if (prefix.some(word => word.includes("=") && controlled.test(word)) ||
        prefix.some((word, index) => /^(?:-u|--unset)$/.test(word) && controlled.test(prefix[index + 1] ?? "") ||
          /^(?:-u|--unset=)./.test(word) && controlled.test(word.replace(/^(?:-u|--unset=)/, ""))) ||
        /^(?:export|unset|declare|typeset|readonly)$/.test(prefix[0] ?? "") && prefix.slice(1).some(word => controlled.test(word))) {
      return "GitHub CLI environment overrides are refused; use the configured GitHub CLI environment";
    }
  }
  return null;
}

function decodeApiArgument(arg) {
  try { return decodeURIComponent(arg); } catch { return arg; }
}

function checkApiWriteScope(command) {
  const joined = joinContinuations(command);
  const substitutions = new Map(substitutionSpans(joined, true).map(span => [span.start, span]));
  for (const segment of shellCommands(joined, { substitutions })) {
    const words = commandWords(segment).operands;
    const curl = words.findIndex(word => programName(word) === "curl");
    const curlArgs = curl >= 0 ? words.slice(curl + 1) : [];
    if (curlArgs.some(word => /^(?:--url=)?https:\/\/api\.github\.com\//i.test(word) && ACTIONS_CLEANUP_ENDPOINT.test(decodeApiArgument(word))) &&
        curlArgs.some((word, index) => /^(?:-X=?|--request=)DELETE$/i.test(word) ||
          /^(?:-X|--request)$/.test(word) && /^DELETE$/i.test(curlArgs[index + 1] ?? ""))) {
      return "GitHub Actions cleanup requires the exact gh api owner-card form";
    }
    const gh = words.findIndex((word, i) => programName(word) === "gh" && words[i + 1] === "api");
    if (gh < 0) continue;
    const args = words.slice(gh + 2);
    let endpoint;
    let write = false;
    let opaqueBody = false;
    let changesIssues = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        endpoint ??= args[i + 1];
        break;
      }
      const option = /^(--[^=]+)(?:=(.*))?$|^-i*([XfFHqtp])(?:=?(.*))?$/s.exec(arg);
      if (!option) {
        if (!arg.startsWith("-")) endpoint ??= arg;
        continue;
      }
      const flag = option[1] ?? "-" + option[3];
      if (!/^(?:-[XfFHqtp]|--(?:method|field|raw-field|input|header|hostname|jq|template|cache|preview))$/.test(flag)) continue;
      const value = (option[1] ? option[2] : option[4] || undefined) ?? args[++i];
      if (/^(?:-X|--method)$/.test(flag)) write ||= value !== "GET";
      else if (/^(?:-[fF]|--(?:field|raw-field|input))$/.test(flag)) {
        write = true;
        changesIssues ||= /^has_issues=/i.test(value ?? "");
        opaqueBody ||= flag === "--input" || /^query=\s*[@$`]/.test(value ?? "");
      }
    }
    const decoded = args.map(decodeApiArgument).join(" ");
    const graphql = /(?:^|\/)graphql(?:[/?#]|$)/i.test(decodeApiArgument(endpoint ?? ""));
    write ||= graphql && /\bmutation\b/i.test(decoded);
    if (!write) continue;
    if (!endpoint || /[$`*?\[\]{}]|^~|[<>]\(/.test(endpoint)) return "GitHub API writes require a fully literal endpoint";
    if (ACTIONS_CLEANUP_ENDPOINT.test(decodeApiArgument(endpoint))) {
      return "GitHub Actions cleanup requires the exact gh api owner-card form";
    }
    if (changesIssues && API_REPO_ROOT.test(decodeApiArgument(endpoint).replace(/^(?:https:\/\/[^/]+)?\//i, ""))) {
      return "GitHub repository settings write (has_issues requires the exact typed-field owner card)";
    }
    if (/rulesets/i.test(decoded) || graphql && /ruleset/i.test(decoded)) {
      return "GitHub API write (rulesets require the exact dbops card form)";
    }
    if (graphql && /BranchProtectionRule/i.test(decoded)) {
      return "GitHub GraphQL branch protection mutations are refused; use the REST card form";
    }
    if (/\bbranches\/[^\s]+\/protection(?:[/?#\s]|$)/i.test(decoded)) {
      return "GitHub API write (branch protection requires the exact card form)";
    }
    if (graphql && opaqueBody) return "GitHub GraphQL opaque request body";
  }
  return null;
}

function checkApiWrites(c) {
  const calls = c.match(/\bgh\s+api\b.*?(?=\bgh\s|[|;&]|$)/g) || [];
  for (const call of calls) {
    if (!/\s(-X|--method)[\s=]*['"]?(PUT|PATCH|DELETE)\b/i.test(call)) continue;
    const paths = (call.match(/repos\/[^\s'"]+/g) || []);
    if (/\s(-X|--method)[\s=]*['"]?DELETE\b/i.test(call) && paths.some((p) => API_REPO_ROOT.test(p))) return "deleting a repository";
    return "GitHub API write (settings/protection)";
  }
  return null;
}

// The session Team takes precedence over the generated Settings mirror for each role.
const START_TEAM_ROLES = new Map([
  ["[architect]", "architect"], ["[writer]", "writer"], ["[ui writer]", "uiWriter"],
  ["[agents.md writer]", "agentsMdWriter"], ["[plan reviewer]", "planReviewer"],
  ["[code reviewer]", "reviewer"], ["[code reviewer fallback]", "reviewerFallback"],
  ["[investigator]", "investigator"], ["[browser tester]", "browserTester"],
  ["[browser operator]", "browserOperator"], ["[arbiter]", "arbiter"],
]);

export function checkStartSession(ti = {}, teamFile, cwd = process.cwd(), resolvedFile = process.env.TEAM_FILE) {
  if (teamLoadError) return teamLoadError;
  let team;
  try { team = loadSessionTeam(teamFile, cwd, resolvedFile); }
  catch (error) { return error.message; }
  const tag = String(ti?.title || "").trim().match(/^\[[^\]]+\]/)?.[0];
  const role = START_TEAM_ROLES.get(tag?.toLowerCase());
  if (!role) return 'start_session needs a Team role tag at the start of its title, e.g. "[Writer] <what>", plus that role\'s pins from Team';
  return teamLib.isConfiguredPin(team.memberPins[role]) ? null : teamLib.unsetRole(role);
}

// ---- Azure (az / azd / deploy.mjs) ----------------------------------------------------------------------------------
const AZ_READ_VERBS = new Set(["show", "list", "get", "exists", "check", "version", "check-name", "check-name-availability", "get-values", "get-value", "query", "logs"]);
const AZ_NAME_FLAGS = new Set(["--name", "-n", "--app", "--target", "--vault-name", "--registry", "-r", "--server", "--account-name", "--environment", "-e", "--slot", "--resource"]);
const AZ_REVISION_FLAGS = new Set(["--revision", "--revision-name"]); // <app>--<suffix>: classified as its app
const AZ_RG_FLAGS = new Set(["--resource-group", "-g"]);
const AZ_SUB_OPTION = /--sub(?:s(?:c(?:r(?:i(?:p(?:t(?:i(?:o(?:n)?)?)?)?)?)?)?)?)?/;
const AZ_SUB_FLAG = new RegExp(`^${AZ_SUB_OPTION.source}$`, "i");
const AZ_ID_FLAGS = new Set(["--ids", "--scope", "--id", "--resource-id"]);

let cachedAzureTargets;
let azureTargetsError;
function defaultAzureTargets() {
  if (azureTargetsError) throw azureTargetsError;
  try { return cachedAzureTargets ??= loadAzureTargets(); }
  catch (error) { azureTargetsError = error; throw error; }
}

export function loadAzureTargets(file = join(userInfo().homedir, ".config", "trioharness", "azure-targets.json")) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const names = (env, kind) => new Set((j[env]?.[kind] || []).map((e) => String(e.name).toLowerCase()));
  const union = (...sets) => new Set(sets.flatMap((s) => [...s]));
  return {
    okResources: union(names("qa", "apps"), names("qa", "resources"), names("test", "apps"), names("test", "resources")),
    okGroups: union(names("qa", "resourceGroups"), names("test", "resourceGroups")),
    okDeploy: union(names("qa", "deployTargets"), names("test", "deployTargets")),
    stagingDatabases: union(names("qa", "databases"), names("test", "databases")),
    prdApps: names("prd", "apps"),
    prdAppLocations: new Map((j.prd?.apps || []).map(app => [app.name.toLowerCase(), app])),
    mobileAppLocations: new Map([...(j.test?.apps || []), ...(j.prd?.apps || [])].map(app => [app.name, app])),
    grantPrincipals: j.prd?.grantPrincipals,
    allowedCreates: j.prd?.allowedCreates,
    evidencePublisherGrants: j.prd?.evidencePublisherGrants,
    evidencePublisherPrincipalId: j.prd?.evidencePublisherPrincipalId,
    prdDeploy: names("prd", "deployTargets"),
    prd: union(names("prd", "apps"), names("prd", "resources"), names("prd", "resourceGroups"), names("prd", "deployTargets")),
    sharedGroups: names("shared", "resourceGroups"),
    sharedSubs: names("shared", "subscriptions"),
    shared: names("shared", "resources"),
    anyToken: (j.prd?.patterns || []).filter((p) => p.scope === "any-token").map((p) => new RegExp(p.regex, "i")),
    unlisted: (j.prd?.patterns || []).filter((p) => p.scope === "unlisted-names").map((p) => new RegExp(p.regex, "i")),
  };
}

// Names in an Azure resource ID: the subscription, the group after resourceGroups/, resources after providers/<ns>/<type>/.
function idParts(id) {
  const seg = String(id).split("/").filter(Boolean); const out = { groups: [], resources: [], subs: [] };
  for (let i = 0; i < seg.length - 1; i++) {
    const k = seg[i].toLowerCase();
    if (k === "subscriptions") out.subs.push(seg[i + 1]);
    else if (k === "resourcegroups") out.groups.push(seg[i + 1]);
    else if (k === "providers") { for (let j = i + 3; j < seg.length; j += 2) out.resources.push(seg[j]); break; }
  }
  return out;
}

export function checkAzure(cmd, targets, capturedOutput, deferPrdWrite, deferCreation) {
  const joined = joinContinuations(cmd);
  const inspect = (text, prdScope) => checkAzureTokenOutput(text, capturedOutput) ??
    checkAzureCommands(text, targets, false, undefined, prdScope, deferCreation) ??
    checkAzureCommands(text, targets, true, undefined, prdScope, deferCreation);
  const heredocs = (text, prdScope) => checkAzureCommands(text, targets, false, shellHeredocSpans(text), prdScope, deferCreation);
  return inspect(cmd, deferPrdWrite) ?? (cmd === joined ? null : inspect(joined)) ??
    heredocs(cmd, deferPrdWrite) ?? (cmd === joined ? null : heredocs(joined));
}

function checkAzureTokenOutput(cmd, capturedOutput) {
  if (capturedOutput) return null;
  // get-access-token: never printed. Allowed only captured in $( ... ) or piped into another command.
  for (const m of cmd.matchAll(/\baz\s+account\s+get-access-token\b[^;&|)\n]*/gi)) {
    const before = cmd.slice(0, m.index); const after = cmd.slice(m.index + m[0].length);
    if (!/\$\(\s*$/.test(before) && !/^\s*\|(?!\|)/.test(after)) return "az account get-access-token would print a token: capture it in $( ... ) or pipe it into the command that uses it";
  }
  return null;
}

function isDeploymentInspection(path) {
  return path.length === 3 && path[0] === "deployment" &&
    /^(group|sub|mg|tenant)$/.test(path[1]) && /^(what-if|validate)$/.test(path[2]);
}

function checkAzureCommands(cmd, targets, legacy, heredocSpans, deferPrdWrite, deferCreation) {
  if (cmd.includes("provision-authority-mount") && deferPrdWrite !== "provision-authority-mount.mjs") {
    return "authority mount requires an owner approval card";
  }
  let t = targets || null; const T = () => t || (t = defaultAzureTargets());
  for (const segment of shellCommands(cmd, { legacy, heredocSpans })) {
    const words = legacy ? segment : commandWords(segment).operands;
    let i = 0;
    if (legacy) {
      while (i < words.length && (isAssignment(words[i]) ||
        ["sudo", "command", "exec", "time", "nohup", "env"].includes(words[i]))) i++;
    } else {
      while (i < words.length && commandHead(words[i])) i++;
      i = executableIndexAfterLaunchers(words, i);
    }
    let head = basename(words[i] || "");
    if (!legacy) head = head.toLowerCase();
    // This additional pass skips heredoc data and recognizes Azure behind unknown wrappers.
    let fallback = false;
    if (heredocSpans && i < words.length && head !== "azd" && !AZURE_DATA_COMMAND.test(programName(words[i])) &&
        azureProgramIndex(words.slice(i)) < 0) {
      const later = words.findIndex((word, index) => index > i && !word.startsWith("-") && !word.includes("=") &&
        azureProgramIndex([word]) === 0 && AZURE_COMMAND_GROUP.test(words[index + 1] ?? ""));
      if (later >= 0) {
        i = later;
        fallback = true;
      }
    }
    const offset = legacy ? -1 : azureProgramIndex(words.slice(i));
    if (offset >= 0) {
      i += offset;
      if (/^-[A-Za-z]*m$/.test(words[i])) i++;
      head = "az";
    }
    if (head === "node" && words.slice(i + 1).some((w) => basename(w) === "deploy.mjs")) {
      if (deferPrdWrite === "deploy dry-run") continue;
      const rest = words.slice(i + 1); const k = rest.findIndex((w) => w === "--target" || w.startsWith("--target="));
      const target = k < 0 ? null : (rest[k].includes("=") ? rest[k].split("=")[1] : rest[k + 1]);
      if (!target) continue; // deploy.mjs refuses a run without --target by itself
      let tg; try { tg = T(); } catch { return "deploy.mjs while ~/.config/trioharness/azure-targets.json is unreadable"; }
      const v = target.toLowerCase();
      if (tg.prd.has(v) && deferPrdWrite === "deploy.mjs") continue;
      if (tg.prd.has(v)) return "deploy.mjs --target " + target + ": a PRD target (production stays with Moshe)";
      if (!tg.okDeploy.has(v)) return "deploy.mjs --target " + target + ": not a qa/test deploy target in ~/.config/trioharness/azure-targets.json";
      continue;
    }
    if (head === "provision-authority-mount.mjs" ||
        ["node", "nodejs"].includes(head) && words.slice(i + 1).some(word => basename(word) === "provision-authority-mount.mjs")) {
      if (deferPrdWrite === "provision-authority-mount.mjs") continue;
      return "authority mount requires an owner approval card";
    }
    if (head !== "az" && head !== "azd") continue;
    const rest = words.slice(i + 1);
    const firstFlag = legacy ? rest.findIndex(word => word.startsWith("-")) : -1;
    const verbs = legacy ? rest.slice(0, firstFlag < 0 ? rest.length : firstFlag).map(word => word.toLowerCase()) :
      azurePath(rest.map(value => ({ value }))).map(({ value }) => value.toLowerCase());
    if (rest.includes("--help") || rest.includes("-h") || (!verbs.length && rest.includes("--version"))) continue;
    if (!verbs.length) {
      if (legacy && head === "az") {
        const path = azurePath(rest.map(value => ({ value }))).map(word => word.value.toLowerCase());
        if (deferCreation === creationType(head, path, rest) || isDeploymentInspection(path)) continue;
      }
      if (fallback) continue;
      return head + " with no command: cannot classify";
    }
    const last = verbs[verbs.length - 1];
    if (head === "az" && verbs[0] === "account" && last === "get-access-token") continue; // checked above
    const azdWrite = head === "azd" && verbs[0] === "env" && ["set", "new", "select", "refresh"].includes(verbs[1]);
    if (head === "az" && isDeploymentInspection(verbs)) continue;
    if (!azdWrite && (AZ_READ_VERBS.has(last) || /^(show|list|get)-/.test(last))) continue; // read-only verb
    // A write (or an unknown verb): classify every name it touches.
    const what = head + " " + verbs.join(" ");
    let tg; try { tg = T(); } catch { return what + ": a write while ~/.config/trioharness/azure-targets.json is unreadable"; }
    if (deferPrdWrite === what) continue; // The complete argv matched a card-gated write of this kind.
    const mobileApp = rest.some(word =>
      /(?:^|[^a-z0-9-])mobile-api-(?:test|prod)(?:$|[^a-z0-9-])/i.test(word.replace(/^-n(?=mobile-api-)/i, "")));
    if (what === "az containerapp secret set" && mobileApp ||
        what === "az rest" && mobileApp && rest.some((word, index) => {
          const method = /^(?:--(?:m|me|met|meth|metho|method)(?:=(.*))?|-m(?:=(.*)|(.+))?)$/i.exec(word);
          return method && !/^get$/i.test(method[1] ?? method[2] ?? method[3] ?? rest[index + 1] ?? "");
        })) {
      return what + ": mobile app changes require an exact owner approval card";
    }
    if (what === "az storage container create" &&
        rest.some(word => /(?:^|=)(?:erpurereportattachprd|mobile-prd-[a-z0-9-]+)$/i.test(word))) {
      return what + ": mobile attachment containers require an exact owner approval card";
    }
    if (what === "az keyvault secret set" &&
        rest.some(word => /(?:^|=)report-attachment-evidence-pin-prod$/i.test(word))) {
      return what + ": the evidence pin requires an exact owner approval card";
    }
    const named = { resources: [], groups: [], subs: [] };
    rest.forEach((w, j) => {
      const eq = w.startsWith("--") && w.includes("=");
      const flag = eq ? w.split("=")[0] : w; const val = eq ? w.split("=").slice(1).join("=") : rest[j + 1];
      if (!val) return;
      if (AZ_NAME_FLAGS.has(flag) && !val.startsWith("-")) named.resources.push(val);
      else if (AZ_REVISION_FLAGS.has(flag) && !val.startsWith("-")) named.resources.push(val.includes("--") ? val.split("--")[0] : val);
      else if (AZ_RG_FLAGS.has(flag)) named.groups.push(val);
      else if (legacy ? flag === "--subscription" : AZ_SUB_FLAG.test(flag)) named.subs.push(val);
      else if (AZ_ID_FLAGS.has(flag)) { const p = idParts(val); named.resources.push(...p.resources); named.groups.push(...p.groups); named.subs.push(...p.subs); }
    });
    const lower = (a) => a.map((x) => x.toLowerCase());
    const res = lower(named.resources); const groups = lower(named.groups); const subs = lower(named.subs);
    const okNames = new Set([...tg.okResources, ...tg.okGroups]);
    const dbopsRegistry = res.includes("crawrnu4mgjcpja") || rest.some((word, i) => {
      const [flag, value = rest[i + 1]] = word.split("=", 2);
      return /^--reg(?:i(?:s(?:t(?:r(?:y)?)?)?)?)?$/.test(flag) && value === "crawrnu4mgjcpja";
    });
    if ((what === "az acr build" || what === "az acr import") && dbopsRegistry &&
        rest.some(word => /^(?:[^=]+=)?dbops(?:-mig)?(?::|$)/i.test(word))) {
      return what + " names the PRD dbops image repository";
    }
    const ids = rest.map(word =>
      word.replace(/^--url=/i, "").replace(/^https:\/\/management\.azure\.com(?=\/)/i, "").split(/[?#]/, 1)[0])
      .filter(word => /^\/(?:subscriptions|providers|resourcegroups)\//i.test(word)).map(idParts);
    const prd = [...res, ...groups, ...subs, ...lower(ids.flatMap(id => [...id.resources, ...id.groups, ...id.subs]))]
      .find(value => tg.prd.has(value));
    if (prd && what === "az containerapp ingress traffic set") {
      return what + ": production traffic requires an owner card with named revision weights";
    }
    if (prd) return what + " names PRD " + prd + " (production stays with Moshe)";
    const prdToken = rest.find((w) => tg.anyToken.some((re) => re.test(w)) && !okNames.has(w.toLowerCase()));
    if (prdToken) return what + " names a PRD system (" + prdToken.slice(0, 60) + ": ERPureAI / ERPURE-SQL are production)";
    const unlistedPrd = [...res, ...groups].find((x) => !okNames.has(x) && !tg.shared.has(x) && !tg.sharedGroups.has(x) && tg.unlisted.some((re) => re.test(x)));
    if (unlistedPrd) return what + " names " + unlistedPrd + ", treated as PRD (ERPURE names are production unless listed as qa/test)";
    if (deferCreation === what && creationType(head, verbs, rest)) {
      if (what === "azd up" || what === "azd provision" ||
          /(?:^| )(?:run-command|token|credential|ad-admin)(?: |$)/.test(what) ||
          rest.some((word, index) => {
            const mode = /^--mo(?:d(?:e)?)?(?:=(.*))?$/i.exec(word);
            return mode && /^complete$/i.test(mode[1] ?? rest[index + 1] ?? "");
          })) {
        return what + ": sensitive operation is outside the resource card scope";
      }
      if ([...res, ...groups].some(value => tg.shared.has(value) || tg.sharedGroups.has(value))) {
        return what + ": shared with PRD; name an explicit qa/test resource";
      }
      if (subs.some(sub => !tg.sharedSubs.has(sub))) return what + ": subscription is not listed";
      continue;
    }
    if (!res.length && !groups.length) return what + ": names no resource, group or app; name the qa/test resource (--name / --resource-group / --scope) so it can be checked";
    const badRes = res.filter((x) => !tg.okResources.has(x));
    if (badRes.length) return what + ": " + badRes.join(", ") + " not on the qa/test list of ~/.config/trioharness/azure-targets.json" + (badRes.some((x) => tg.shared.has(x)) ? " (shared resource: writes need an explicit qa/test entry)" : "");
    const badGroup = groups.filter((g) => !tg.okGroups.has(g) && !(tg.sharedGroups.has(g) && res.length));
    if (badGroup.length) return what + ": resource group " + badGroup.join(", ") + (badGroup.some((g) => tg.sharedGroups.has(g)) ? " is shared with PRD and the command names no qa/test resource" : " is not on the qa/test list");
    const badSub = subs.filter((s) => !tg.sharedSubs.has(s));
    if (badSub.length) return what + ": subscription " + badSub.join(", ") + " is not listed";
  }
  return null;
}

// running-ref.mjs (2026-11-21): production is never probed from CodeDen. --include-prod is a person's flag outside CodeDen.
export const RUNNING_REF_TEMP_REQUIRE_TARGET = false;
export function checkRunningRef(cmd, legacyOnly = false) {
  for (const words of legacyAndHeredocCommands(cmd, legacyOnly)) {
    const k = words.findIndex((w) => basename(w) === "running-ref.mjs");
    if (k < 0) continue;
    const rest = words.slice(k + 1);
    if (rest.some((w) => w === "--include-prod" || w.startsWith("--include-prod="))) return "running-ref.mjs --include-prod probes production; prd is never probed from CodeDen (a person runs it outside CodeDen)";
    if (RUNNING_REF_TEMP_REQUIRE_TARGET && rest[0] === "check" && !rest.some((w) => w === "--target" || w.startsWith("--target=")) && !/(^|\s)RUNNING_REF_TARGETS=\S/.test(cmd)) return "running-ref.mjs check without --target would probe production with the running-ref.mjs installed now (fixed version coming); pass --target <non-prod names from your repo's deploy.json, e.g. mobile-api-test>";
  }
  return null;
}

// ---- Secret stop-gap v2 (2026-11-21) --------------------------------------------------------------------------------
// The app connection string in erpure vaults points at PRODUCTION ERPureAI with a write-capable login. Pure deny: reading
// secret VALUES of a prd-classified or erpure* (or unresolvable) vault/app is blocked; metadata-only reads stay allowed. Any
// SQL client or driver against ERPURE-SQL is blocked until the ERPureAI_QA allowlist lands. Matching runs on a normalised
// copy of the raw command alongside a shell-aware view of program paths and arguments.
const ERPURE_SQL_HOST = /erpure-?sql|149\.97\.246\.130|149\.97\.63106|2506225282|0x9561f682/i;
const AZ_TOKEN = /(?<![a-z0-9_-])az(?:\.cmd|\.exe)?(?![a-z0-9_.-])/;
const AZ_REST_ENDPOINT = /\/secrets|listsecrets|\/config\/appsettings\/list|\/config\/connectionstrings\/list|publishingcredentials|listkeys|listappsettings|listfunctionappsettings/;
const AZ_DEBUG = /(?:^|\s)--(?:deb|verb)/i;
const AZ_LITERAL_GROUP = /^(keyvault|containerapp|webapp|functionapp|staticwebapp|logicapp|account|rest)$/;

const MAX_SECRET_COMMAND_BYTES = 64 * 1024;
const COMMAND_SUBSTITUTION = /\$\(|`/;
const SQL_IP = 0x9561f682;
const AZ_COMMAND = /(^|[^a-z0-9_-])az(\.cmd|\.exe)? /;
const SECRET_TOKEN_TYPE = /(?:^|\s)--resource-t(?:y(?:p(?:e)?)?)?(?:=|\s+)(?:vault|database|sql|synapse|oss-?rdbms)(?=\s|$)/;
const SECRET_TOKEN_RESOURCE = /vault\.azure\.net|database\.windows\.net|vault\.azure|sql\.azuresynapse|cfa8b339-?82a2-?471a-?a3c9-?0fc0be7a4093|022907d3-?0f1b-?48f7-?badc-?1ba6abab6d66|\boss-?rdbms\b/;

function namesSqlHost(command) {
  if (ERPURE_SQL_HOST.test(command)) return true;
  for (const [, nat64, prefix] of command.matchAll(/(?:(?<![\w:.])|(?<=\btcp:))(?:(64:ff9b::)|([0:]+)ffff:)9561:f682(?![\w:.])/g)) {
    if (nat64 || /^(?:0{1,4}:){5}$/.test(prefix) ||
        /^(?:(?:0{1,4}:){0,4}:|::)(?:0{1,4}:){0,4}$/.test(prefix) &&
        prefix.split(':').filter(Boolean).length < 5) return true;
  }
  for (const [address] of command.matchAll(/(?<![\w.])(?:0x[\da-f]+|\d+)(?:\.(?:0x[\da-f]+|\d+)){0,3}(?![\w.])/g)) {
    const parts = address.split('.');
    if (parts.length === 1) {
      if (/^0[0-9]*[89]/.test(address)) continue;
      const integer = /^0[0-7]+$/.test(address) ? BigInt(`0o${address}`) : BigInt(address);
      if (BigInt.asUintN(32, integer) === BigInt(SQL_IP)) return true;
      continue;
    }
    const numbers = parts.map(part => {
      if (part.startsWith('0x')) return Number(part);
      if (part.startsWith('0')) return /^[0-7]+$/.test(part) ? Number.parseInt(part, 8) : NaN;
      return Number(part);
    });
    const last = numbers.pop();
    const remainingBytes = 4 - numbers.length;
    if (last < 256 ** remainingBytes && numbers.every(number => number < 256) &&
        numbers.reduce((prefix, byte) => prefix * 256 + byte, 0) * 256 ** remainingBytes + last === SQL_IP) return true;
  }
  return false;
}

const SQL_RUNNERS = /(^|[^a-z0-9_-])(sqlcmd|go-sqlcmd|osql|isql|tsql|invoke-sqlcmd|bcp|mssql-cli|sqlpackage|python3?|node|deno|bun|pwsh|powershell|dotnet|java|go|ruby|perl|php)(\.exe|\.ps1)?(?![a-z0-9_-])|-s\s|-h\s|\/t?(source|target)?servername:|\/tsn:|\/ssn:|--server|serverinstance|server\s*=|data\s*source\s*=|sqlcmdserver/i;
const SQL_CLIENT_NAMES = "sqlcmd|go-sqlcmd|osql|isql|tsql|invoke-sqlcmd|bcp|mssql-cli|sqlpackage";
const SQL_CLIENTS = new RegExp(`(^|[^a-z0-9_-])(?:${SQL_CLIENT_NAMES})(?![a-z0-9_-])`, "i");
const SQL_CLIENT_NAME = new RegExp(`^(?:${SQL_CLIENT_NAMES})$`);
const META_FIELD = /^(name|id|contenttype|tags(\.[A-Za-z0-9_-]+)?|attributes(\.[A-Za-z0-9_]+)?)$/i;
const APP_META = /^(name|id|location|type|tags(\.[A-Za-z0-9_-]+)?|properties\.(latestrevisionname|latestreadyrevisionname|provisioningstate|runningstatus|active|createdtime|trafficweight|healthstate|replicas|configuration\.ingress\.fqdn|configuration\.activerevisionsmode))$/i;
// Deploy preflight reads on erpureai-webchat only (azure-targets.json prd.apps): container count, images, ingress traffic.
// Granted only to one parsed az containerapp show with exactly the pinned name, group and subscription, and only with
// the strict projection grammar (each item a whole field, or label:field inside {...}).
const APP_PREFLIGHT = /^(length\(properties\.template\.containers\)|properties\.template\.containers\[\]\.image|properties\.configuration\.ingress\.traffic)$/i;
const APP_META_WEBCHAT = new RegExp(`${APP_META.source}|${APP_PREFLIGHT.source}`, "i");
const WEBCHAT = "erpureai-webchat";
const WEBCHAT_ENV_EQ_QUERY = '(properties.template.containers[].env[] || `[]`) | {issuer:((@[?name==`"ReportAttachments__AudienceMappings__0__Actor__Issuer"`] | [0]).secretRef != `null` || (@[?name==`"ReportAttachments__ApprovedDeployment__Issuer"`] | [0]).secretRef != `null`) && `{"equal":null,"reason":"secretref"}` || (type((@[?name==`"ReportAttachments__AudienceMappings__0__Actor__Issuer"`] | [0]).value) != `"string"` || type((@[?name==`"ReportAttachments__ApprovedDeployment__Issuer"`] | [0]).value) != `"string"`) && `{"equal":null,"reason":"missing"}` || {equal:(@[?name==`"ReportAttachments__AudienceMappings__0__Actor__Issuer"`] | [0]).value == (@[?name==`"ReportAttachments__ApprovedDeployment__Issuer"`] | [0]).value},environment:((@[?name==`"ReportAttachments__AudienceMappings__0__Environment"`] | [0]).secretRef != `null` || (@[?name==`"ReportAttachments__ApprovedDeployment__Environment"`] | [0]).secretRef != `null`) && `{"equal":null,"reason":"secretref"}` || (type((@[?name==`"ReportAttachments__AudienceMappings__0__Environment"`] | [0]).value) != `"string"` || type((@[?name==`"ReportAttachments__ApprovedDeployment__Environment"`] | [0]).value) != `"string"`) && `{"equal":null,"reason":"missing"}` || {equal:(@[?name==`"ReportAttachments__AudienceMappings__0__Environment"`] | [0]).value == (@[?name==`"ReportAttachments__ApprovedDeployment__Environment"`] | [0]).value},storageAccount:((@[?name==`"ReportAttachments__AudienceMappings__0__StorageAccount"`] | [0]).secretRef != `null` || (@[?name==`"ReportAttachments__ApprovedDeployment__StorageAccount"`] | [0]).secretRef != `null`) && `{"equal":null,"reason":"secretref"}` || (type((@[?name==`"ReportAttachments__AudienceMappings__0__StorageAccount"`] | [0]).value) != `"string"` || type((@[?name==`"ReportAttachments__ApprovedDeployment__StorageAccount"`] | [0]).value) != `"string"`) && `{"equal":null,"reason":"missing"}` || {equal:(@[?name==`"ReportAttachments__AudienceMappings__0__StorageAccount"`] | [0]).value == (@[?name==`"ReportAttachments__ApprovedDeployment__StorageAccount"`] | [0]).value}}';
function webchatEnvReadback(raw, targets) {
  const prefix = `az containerapp show -n ${WEBCHAT} -g `;
  const query = 'properties.template.containers[].env[].{name:name,set:!!(value||secretRef),on:value==`"true"`}';
  const suffixes = [query, WEBCHAT_ENV_EQ_QUERY].map(query => ` --query '${query}' -o json`);
  const command = raw.trim();
  if (!command.startsWith(prefix) || !suffixes.some(suffix => command.endsWith(suffix))) return false;
  const pin = (targets ?? defaultAzureTargets()).prdAppLocations?.get(WEBCHAT);
  if (!pin?.resourceGroup || !pin?.subscription ||
      ![pin.resourceGroup, pin.subscription].every(value => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value))) return false;
  return suffixes.some(suffix => command === `${prefix}${pin.resourceGroup} --subscription ${pin.subscription}${suffix}`);
}
const webchatMemo = { text: null, targets: null, result: false };
const SHOW_FLAGS = { "-n": "name", "--name": "name", "-g": "rg", "--resource-group": "rg", "--subscription": "sub", "--query": "q", "-q": "q", "-o": "o", "--output": "o" };
function webchatShow(text, targets) {
  if (webchatMemo.text === text && webchatMemo.targets === targets) return webchatMemo.result;
  webchatMemo.text = text; webchatMemo.targets = targets; webchatMemo.result = false;
  const pin = targets?.prdAppLocations?.get(WEBCHAT);
  if (!pin?.resourceGroup || !pin?.subscription || Buffer.byteLength(String(text)) > MAX_SECRET_COMMAND_BYTES) return false;
  const segments = [...shellCommands(joinContinuations(String(text)))];
  if (segments.length !== 1) return false;
  const [program, group, verb, ...args] = segments[0];
  if (program !== "az" || group !== "containerapp" || verb !== "show") return false;
  const seen = new Map();
  for (let i = 0; i < args.length; i++) {
    const inline = args[i].startsWith("--") && args[i].includes("=");
    const flag = inline ? args[i].slice(0, args[i].indexOf("=")) : args[i];
    const value = inline ? args[i].slice(flag.length + 1) : args[++i];
    const key = Object.hasOwn(SHOW_FLAGS, flag) ? SHOW_FLAGS[flag] : null;
    if (!key || value === undefined || seen.has(key)) return false;
    seen.set(key, value);
  }
  return webchatMemo.result = seen.get("name") === WEBCHAT && seen.get("rg") === pin.resourceGroup && seen.get("sub") === pin.subscription;
}
const appMeta = (text, targets) => webchatShow(text, targets) ? APP_META_WEBCHAT : APP_META;
function strictFields(q, re) {
  const text = q.trim();
  const hash = /^\{.*\}$/s.test(text);
  const body = hash || /^\[.*\]$/s.test(text) ? text.slice(1, -1) : text;
  const items = [""];
  let quote = null;
  for (const ch of body) {
    if (quote) { if (ch === quote) quote = null; } else if (ch === "'" || ch === '"') quote = ch; else if (ch === ",") { items.push(""); continue; }
    items[items.length - 1] += ch;
  }
  return !quote && items.every((raw) => {
    const it = raw.trim();
    if (!it) return false;
    const colon = /^(?:'[^']*'|"[^"]*")/.exec(it)?.[0].length ?? it.indexOf(":");
    if (colon < 0) return re.test(it);
    return hash && it[colon] === ":" && /^(?:[A-Za-z_][A-Za-z0-9_]*|'[^'\\]*'|"[^"\\]*")$/.test(it.slice(0, colon).trim()) && re.test(it.slice(colon + 1).trim());
  });
}
export const normalizeCmd = (raw) => String(raw).replace(/\\\r?\n/g, " ").replace(/[\x60"'\\]/g, "").replace(/\s+/g, " ").toLowerCase();
// Every --query/-q value in the raw command (quote-aware); null when one is glued to other text (concatenated quotes).
function queries(raw, legacy = false) {
  const out = [];
  const pattern = legacy
    ? /(?:^|\s)(?:--query|-q)(?:\s+|=)("([^"]*)"|'([^']*)'|([^\s"']+))(\S*)/g
    : /(?:^|\s)(?:--q[^\s=]*|-q)(?:\s+|=)("([^"]*)"|'([^']*)'|([^\s"']+))(\S*)/g;
  for (const m of String(raw).matchAll(pattern)) { if (m[5]) return null; out.push((m[2] ?? m[3] ?? m[4] ?? "").trim()); }
  return out;
}
function onlyFields(q, re) {
  if (!q || /value/i.test(q)) return false;
  if (re === APP_META_WEBCHAT) return strictFields(q, re);
  const items = q.replace(/^[\[{]|[\]}]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 && items.every((it) => re.test((it.includes(":") ? it.slice(it.indexOf(":") + 1) : it).trim()));
}
const joinContinuations = command => command.replace(/\\\r?\n/g, "");

function isSimpleCommand(command) {

  // Consume quoted and escaped text before inspecting shell syntax.
  const tokens = /"(?:(?:\\[\s\S])|[^"\\])*"|'[^']*'|\\[^\r\n]|[;&|\r\n#<>()"'$`{}*?\[]/g;
  for (const [token] of command.matchAll(tokens)) {
    if (!token.startsWith("'") && token.includes("$")) return false;
    if (token.startsWith('"') && token.replace(/\\[\s\S]/g, "").includes("`")) return false;
    if (token.length === 1) return false;
  }
  return true;
}

export function metadataOnlyQuery(command, re = META_FIELD) {
  // The live exception rejects debug/verbose text anywhere in the original command.
  if (/--(?:debug|verbose)/i.test(command)) return false;
  command = command.replace(/^(?:[ \t]*cd[ \t]+[\w./-]+[ \t]*&&[ \t]*)+/, "");
  if (re === APP_META || re === APP_META_WEBCHAT) {
    const [words = [], ...rest] = shellCommands(command, { describeWords: true, substitutions: new Map() });
    if (!rest.length && programName(words[0]?.value ?? "") === "az" &&
        words.some((_, i) => quotedMetadataValue(words, i))) {
      for (let i = words.length - 1; i >= 0; i--) {
        if (!quotedMetadataValue(words, i)) continue;
        const { start, end, raw } = words[i];
        command = command.slice(0, start) + raw.replace(/"\$.*"$/, "placeholder") + command.slice(end);
      }
    }
  }
  const joined = joinContinuations(command);
  if ([command, joined].some(form => !isSimpleCommand(form) || AZ_DEBUG.test(normalizeCmd(form)) || /--(?:debug|verbose)/i.test(form))) return false;
  const q = queries(command);
  if (q?.length !== 1 || !onlyFields(q[0], re)) return false;
  const [[program, ...args] = []] = shellCommands(joined);
  if (!program || !/^az(?:\.cmd|\.exe)?$/i.test(basename(program))) return false;
  const flags = args.flatMap((arg, i) => {
    if (/^(--q[^\s=]*|-q)$/.test(arg)) return [args[i + 1]];
    if (/^(--q[^\s=]*|-q)=/.test(arg)) return [arg.slice(arg.indexOf("=") + 1)];
    return [];
  });
  return flags.length === 1 && onlyFields(flags[0], re);
}

// Locate substitutions without interpreting their output.
function substitutionSpans(command, shellAware = false, heredocSpans) {
  const spans = [];
  const stack = [];
  let outerQuote;
  const outer = { redirects: [] };
  let cursor = -1;
  for (let i = 0; i < command.length; i = advanceParser(cursor, i + 1)) {
    cursor = i;
    const ch = command[i];
    const frame = stack.at(-1);
    const context = frame ?? outer;
    if (context.body?.end <= i) context.body = null;
    context.body = context.heredocs?.get(i) ?? context.body;
    const body = context.body;
    if (body) {
      if (body.quoted || i >= body.contentEnd) { i = body.end - 1; continue; }
      if (ch === "\\" && /[\\$`\n]/.test(command[i + 1] ?? "")) { i++; continue; }
    }
    if (!body && !frame && shellAware) {
      if (ch === "\\" && outerQuote !== "'") { i++; continue; }
      if (ch === outerQuote) { outerQuote = null; continue; }
      if (outerQuote === "'") continue;
      if (!outerQuote && (ch === "'" || ch === '"')) { outerQuote = ch; continue; }
      if (!outerQuote && ch === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]))) {
        while (i + 1 < command.length && command[i + 1] !== "\n") i++;
        continue;
      }
    }
    if (frame?.backtick) {
      if (ch === "\\") { i++; continue; }
      if (ch !== "`") continue;
    } else if (frame && !body) {
      if (ch === "\\" && (frame.quote !== "'" || frame.ansi)) { i++; continue; }
      if (frame.quote && ch === frame.quote) { frame.quote = null; continue; }
      if (frame.quote === "'") continue;
    }

    if (shellAware && !body && !frame?.backtick && !(frame ? frame.quote : outerQuote)) {
      if (frame && ch === "#" && /[\s;&|()]/.test(command[i - 1])) {
        while (i + 1 < command.length && command[i + 1] !== "\n") i++;
        continue;
      }
      if (ch === "<" && command[i - 1] !== "<" && /^<<[^<]/.test(command.slice(i, i + 3))) {
        (context.redirects ??= []).push({ start: i, syntax: "<<" });
      } else if (ch === "\n" && context.redirects?.length) {
        const bodies = [];
        collectHeredocs(command, context.redirects, bodies);
        context.redirects = [];
        for (const item of bodies) {
          (context.heredocs ??= new Map()).set(item.start, item);
          heredocSpans?.set(item.start, item);
        }
      }
    }

    const paren = command[i + 1] === "(" &&
      (ch === "$" || shellAware && !body && !(frame?.quote || !frame && outerQuote) && (ch === "<" || ch === ">"));
    if (!frame?.backtick && (paren || ch === "`")) {
      const marker = paren ? command.slice(i, i + 2) : ch;
      stack.push({ start: i, marker, backtick: !paren, depth: 1, quote: null, ansi: false });
      if (paren) i++;
      continue;
    }
    if (!frame || body) continue;
    if (!frame.backtick) {
      if (frame.quote) continue;
      if (ch === "'" || ch === '"') {
        frame.quote = ch;
        frame.ansi = ch === "'" && command[i - 1] === "$";
        continue;
      }
      if (ch === "(") frame.depth++;
      if (ch !== ")" || --frame.depth > 0) continue;
    }
    stack.pop();
    spans.push({ start: frame.start, marker: frame.marker, end: i + 1, outer: !stack.length });
  }
  return spans;
}

// Keep the legacy stripped and space-joined detection views.
function substitutionViews(command) {
  const spans = substitutionSpans(command).filter(span => span.outer);
  if (!spans.length) return [];
  let end = 0;
  const pieces = spans.map(({ start, end: stop }) => {
    const piece = command.slice(end, start);
    end = stop;
    return piece;
  });
  pieces.push(command.slice(end));
  return [pieces.join(""), pieces.join(" ")];
}


function isPlainWord(word, { allowIPv6 = false } = {}) {
  if (/[$`*?]|^~(?!\/)|[{}]|[<>]\(/.test(word)) return false;
  // SQL server syntax also uses brackets around literal IPv6 addresses.
  for (const [, content] of word.matchAll(/\[([^\[\]]+)\]/g)) {
    if (!allowIPv6 || isIP(content) !== 6) return false;
  }
  return true;
}

// Match a command path independently of the executable or wrapper that supplied it.
const AZ_FAMILIES = [
  ["vault-export", "keyvault secret (?:download|backup|restore|recover)"],
  ["vault-show", "keyvault secret show"],
  ["vault-versions", "keyvault secret list-versions"],
  ["vault-list", "keyvault secret list"],
  ["app-secret-show", "containerapp (?:job )?secret show"],
  ["app-secret-list", "containerapp (?:job )?secret list"],
  ["app-metadata", "containerapp (?:revision |job )?(?:show|list)"],
  ["app-config", "(?:webapp|functionapp|staticwebapp|logicapp) config (?:appsettings|connection-string) list|staticwebapp appsettings list",
    "(?:webapp|functionapp) config (?:appsettings|connection-string) list"],
  ["app-keys", "(?:webapp|functionapp|staticwebapp|logicapp) deployment list-publishing-[\\w-]+|functionapp (?:function )?keys list",
    "(?:webapp|functionapp) deployment list-publishing-(?:profiles|credentials)|functionapp (?:function )?keys list"],
  ["token", "account get-access-token"],
  ["rest", "rest", "rest\\b"],
].map(([family, path, legacy = path]) => ({
  family,
  path: new RegExp(`^(?:${path})(?: |$)`),
  legacy: new RegExp(`${AZ_COMMAND.source}(?:${legacy})`),
}));
const LIVE_APP_METADATA = new RegExp(AZ_COMMAND.source + "containerapp (?:revision )?(?:show|list)");
const AZ_WRAPPER_FAMILY = /(?:^| )(?:keyvault secret|containerapp (?:job )?secret|config appsettings|config connection-string|get-access-token|rest|containerapp (?:revision |job )?(?:show|list)|staticwebapp appsettings|deployment list-publishing-[\w-]+|keys list)(?: |$)/;
const AZURE_COMMAND_GROUP = /^(?:group|keyvault|containerapp|webapp|functionapp|staticwebapp|logicapp|storage|acr|account|sql|rest|deployment|role|ad|aks|monitor|network|vm|cosmosdb|redis|servicebus|eventhub|apim|resource|login|logout|config|extension|bicep)$/i;
const AZURE_DATA_COMMAND = /^(?:for|case|select|in|echo|printf|rg|grep|git|gh|command|type|which|whence|test|true|false|:|awk|gawk|mawk|nawk|find|cat|sed|sort|tee|node|bun|deno|python[\w.-]*|perl|ruby|php|sh|bash|zsh|dash|ksh|fish|pwsh|powershell)$/;
const UNRELATED_PROGRAMS = /^(?:echo|printf|grep|rg|test|true|false|:)$/;
const AZ_GLOBAL_OPTION = String.raw`(?:--out(?:p(?:u(?:t)?)?)?|-o|--q[^\s=]*|-q|${AZ_SUB_OPTION.source})`;
const AZ_GLOBAL_VALUE = new RegExp(`^${AZ_GLOBAL_OPTION}$`, "i");
const AZ_LEGACY_GLOBALS = new RegExp(
  String.raw`((?<![a-z0-9_-])az(?:\.cmd|\.exe)? )(?:(?:--debug|--verbose|--only-show-errors) |${AZ_GLOBAL_OPTION}(?:=| )\S+ )+`, "g");

const METADATA_COMMAND = " (single command, no pipes, redirects, variables or substitutions)";

function executableIndexAfterLaunchers(words, start = 0) {
  let index = start;
  while (index < words.length) {
    const target = launcherTarget(words[index], words.slice(index + 1));
    if (target < 0) break;
    index += target + 1;
  }
  return index;
}

function azurePath(args) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const { value } = args[i];
    const flag = value.split("=")[0];
    if (AZ_GLOBAL_VALUE.test(flag)) {
      if (flag === value) i++;
    } else if (/^--(?:debug|verbose|only-show-errors)$/i.test(flag)) {
      continue;
    } else if (value.startsWith("-")) {
      break;
    } else words.push(args[i]);
  }
  return words;
}

function resourceCreation(words) {
  let start = words.findIndex(word => !commandHead(word));
  if (start < 0) return null;
  start = executableIndexAfterLaunchers(words, start);
  const azure = azureProgramIndex(words.slice(start));
  const head = azure >= 0 ? "az" : programName(words[start]);
  const offset = azure > 0 ? azure + (/^-[A-Za-z]*m$/.test(words[start + azure]) ? 1 : 0) : 0;
  const args = words.slice(start + offset + 1);
  if (args.some(word => /^(?:--help|-h)$/i.test(word))) return null;
  const path = head === "az" ? azurePath(args.map(value => ({ value }))).map(word => word.value.toLowerCase()) :
    (head === "terraform" ? args.filter(word => !word.startsWith("-chdir=")) : args)
      .slice(0, 1).map(word => word.toLowerCase());
  return describeCreation(head, path, args);
}

const literalCardWord = /^(?:[A-Za-z0-9_.\/~:@=+-]+|'[A-Za-z0-9_.\/~:@=+ -]*'|"[A-Za-z0-9_.\/~:@=+ -]*")$/;

function literalAccessCard(command) {
  if (structuralSizeDenial(command) || /[\x00-\x08\x0a-\x1f\x7f]/.test(command)) return null;
  const [words, ...other] = shellCommands(command, { describeWords: true });
  if (!words?.length || other.length) return null;
  let end = 0;
  for (const word of words) {
    const raw = end === 0 && word.raw.startsWith("~/") ? word.raw.slice(1) : word.raw;
    if (!/^(?:[A-Za-z0-9_./:@=+,-]|\\['"]|'[^']*'|"(?:[^"`$!\\]|\\["`$\\])*")+$/.test(raw) ||
        !/^[ \t]*$/.test(command.slice(end, word.start))) return null;
    end = word.end;
  }
  if (!/^[ \t]*$/.test(command.slice(end))) return null;
  // Quoting the tilde prevents the shell from expanding the installed path.
  if (words[0].value.startsWith("~/") && words[0].raw !== words[0].value) return null;
  return matchAccessCard(words.map(word => word.value));
}

function matchResourceCard(command, cwd) {
  // An exact, literal command can be bound to one card. In particular, do
  // not authorize input-dependent or repeated execution through launchers.
  if (/[^\x20-\x7e\t]/.test(command)) return null;
  const [words, ...other] = shellCommands(command, { describeWords: true });
  if (!words?.length || other.length) return null;
  let end = 0;
  for (const word of words) {
    if (!literalCardWord.test(word.raw) || !/^[ \t]*$/.test(command.slice(end, word.start))) return null;
    end = word.end;
  }
  if (!/^[ \t]*$/.test(command.slice(end))) return null;
  const values = words.map(word => word.value);
  let start = 0;
  while (start < values.length) {
    const offset = launcherTarget(values[start], values.slice(start + 1));
    if (offset < 0) break;
    const launcher = launcherName(values[start]);
    if (launcher === "timeout" ? offset !== 1 || !/^\d+(?:[smhd])?$/.test(values[start + 1]) :
        !/^(?:sudo|env|nohup)$/.test(launcher) || offset !== 0) return null;
    start += offset + 1;
  }
  // Cards only for the literal program words: a path-qualified head (./az) or `python -m azure.cli` runs code the
  // agent may control, so those forms keep the plain denial.
  if (values[start] === "pwsh" || values[start] === "powershell") {
    const [profile, flag, ...args] = values.slice(start + 1);
    if (/^-noprofile$/i.test(profile) && /^-(?:c|command)$/i.test(flag) && /^new-az[\w-]+(?: |$)/i.test(args.join(" "))) {
      return completeResourceCard(resourceCreation(args.join(" ").split(/ +/)), cwd);
    }
    return null;
  }
  if (values[start] !== "az" && values[start] !== "azcmagent") return null;
  if (values[start] === "az") {
    const output = withOutputNone(values.slice(start + 1));
    return output ? completeResourceCard(resourceCreation(["az", ...output.rest]), cwd) : null;
  }
  return completeResourceCard(resourceCreation(values.slice(start)), cwd);
}

function completeResourceCard(creation, cwd) {
  if (!creation?.name || !creation.group || !creation.region || creation.type === "az storage container-rm create") return null;
  const exactFlags = ["--name", "--resource-group", "--location", "--template-file", "--template-uri", "--template-spec"];
  if (creation.args.some(arg => {
    const [flag] = arg.split("=");
    return flag.startsWith("--") && exactFlags.some(full => flag !== full && full.startsWith(flag));
  })) return null;
  const targets = defaultAzureTargets();
  if (/^az (?:deployment|stack) /.test(creation.type) || /^new-az.*deployment$/.test(creation.type)) {
    if (!targets.okGroups.has(creation.group.toLowerCase()) ||
        !/^(?:az (?:deployment|stack) group create|new-azresourcegroupdeployment)$/.test(creation.type)) return null;
    const template = describeCreationTemplate(creation, cwd);
    if (!template) return null;
    creation.reason += "; " + template;
  }
  if (/^(?:pulumi up|terraform apply|az (?:role assignment create|ad (?:sp create-for-rbac|app create)|rest|sql db (?:copy|restore)|aks nodepool add))$/.test(creation.type)) return null;
  return creation;
}

function checkCreationPrdTokens(creation) {
  const targets = defaultAzureTargets();
  const shared = [creation.name, creation.group, creation.region].map(word => word.toLowerCase())
    .find(word => targets.shared.has(word) || targets.sharedGroups.has(word) || targets.prd.has(word));
  if (shared) return creation.type + " names a shared or PRD target " + shared;
  if (creation.type.startsWith("az ") || creation.type.startsWith("azd ")) return null;
  const prd = creation.args.map(word => word.split("=").at(-1).toLowerCase()).find(word =>
    targets.prd.has(word) || targets.anyToken.some(pattern => pattern.test(word)) ||
    !targets.okResources.has(word) && !targets.okGroups.has(word) && targets.unlisted.some(pattern => pattern.test(word)));
  return prd ? creation.type + " names PRD " + prd : null;
}

function checkResourceCreation(command, cwd, depth = 0, literalOnly = false, writtenScripts) {
  if (depth > 16 || structuralSizeDenial(command)) {
    const limit = prdInspectionLimit(command, depth);
    return limit && "NEW RESOURCE: " + limit;
  }
  const executable = joinContinuations(command);
  // Reuse the existing launcher, interpreter, script, and substitution traversal.
  const inspect = (text, _targets, level, literal, options) =>
    checkResourceCreation(text, options?.cwd ?? cwd, level, literal, options?.writtenScripts);
  const scan = checkSecretCommands(executable, undefined, depth, inspect, false, {
    cwd, structural: !literalOnly, resourceScan: true, writtenScripts,
  });
  return scan.denial?.startsWith("NEW RESOURCE:") ? scan.denial : null;
}

function checkResourceCompanionSecrets(command, cwd) {
  // The legacy pass can stop on an Azure write before inspecting later segments.
  const inspect = (text, targets, depth, literal, options) =>
    checkRawShellSecrets(text) ?? checkSecrets(text, targets, depth, false, inspect, {
      cwd, ...options, structural: !literal,
    });
  return inspect(command, undefined, 0);
}

function sensitiveAzureTarget(command, targets) {
  if (/erpure|\bmobile-api-test\b/.test(command)) return true;
  const prd = targets?.prd ?? defaultAzureTargets().prd;
  return command.split(/[^a-z0-9_.-]+/).some(word => prd.has(word) || prd.has(word.replace(/\.vault\.azure\.net$/, "")));
}

const QUERY_FLAG = /^(?:--q[^\s=]*|-q)(?:=|$)/i;
const METADATA_VALUE_FLAG = /^(?:-g|-n|--name|--resource-group|--subscription|--tenant|--vault-name)$/;
const QUOTED_VARIABLE = /^"\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})"$/;

function quotedMetadataValue(words, index) {
  const raw = words[index].raw;
  const equal = raw.indexOf("=");
  return equal > 0 ? METADATA_VALUE_FLAG.test(raw.slice(0, equal)) && QUOTED_VARIABLE.test(raw.slice(equal + 1)) :
    METADATA_VALUE_FLAG.test(words[index - 1]?.value) && QUOTED_VARIABLE.test(raw);
}

function queryValueAt(words, i) {
  return QUERY_FLAG.test(words[i - 1]?.value ?? "") && !words[i - 1].value.includes("=");
}

function metadataOnlyArgs(words, fields) {
  if (words.some(word => AZ_DEBUG.test(word.value.toLowerCase()))) return false;
  const values = words.flatMap(({ value }, i) => {
    if (!QUERY_FLAG.test(value)) return [];
    return [value.includes("=") ? value.slice(value.indexOf("=") + 1) : words[i + 1]?.value];
  });
  return values.length === 1 && onlyFields(values[0], fields);
}

function literalArmAudience(words) {
  const resources = words.flatMap(({ value }, i) => {
    if (!/^--res(?:o(?:u(?:r(?:c(?:e)?)?)?)?)?(?:=|$)/.test(value)) return [];
    return [value.includes("=") ? value.slice(value.indexOf("=") + 1) : words[i + 1]?.value];
  });
  return resources.length === 1 && /^https:\/\/management\.azure\.com\/?$/.test(resources[0]) &&
    !words.some(({ value }) => /^--resource-t|^--scope(?:=|$)/.test(value));
}

function checkAzurePath(program, args, raw, targets) {
  const name = programName(program.value);
  const words = [program, ...args];
  const values = words.map(word => word.value);
  const target = executableIndexAfterLaunchers(values);
  const xargs = values.slice(0, target).some(value => launcherName(value) === "xargs");
  const azureIndex = azureProgramIndex(values.slice(target));
  const launcher = target + azureIndex;
  const direct = azureIndex >= 0;
  const offset = direct && /^-[A-Za-z]*m$/.test(words[launcher].value) ? 2 : 1;
  const scriptIndex = direct ? -1 : interpreterScriptIndex(values.slice(target));
  const pathArgs = direct ? words.slice(launcher + offset) :
    scriptIndex >= 0 ? words.slice(target + scriptIndex + 1) : args;
  let path = azurePath(pathArgs);
  const argv = normalizeCmd(pathArgs.map(({ value }) => value).join(" "));
  let pathText = path.map(({ value }) => value.toLowerCase()).join(" ");
  if (!direct && UNRELATED_PROGRAMS.test(name)) return null;
  if (!direct && AZ_WRAPPER_FAMILY.test(pathText)) {
    const groupIndex = path.findIndex(({ value }) => AZ_LITERAL_GROUP.test(value.toLowerCase()));
    if (groupIndex > 0) {
      path = path.slice(groupIndex);
      pathText = path.map(({ value }) => value.toLowerCase()).join(" ");
    }
  }
  const [group, subgroup, action] = pathText.split(" ", 3);
  const pathLength = /^(?:keyvault|containerapp|webapp|functionapp|staticwebapp|logicapp)$/.test(group)
    ? (/^(?:config|job|function)$/.test(subgroup) || subgroup === "revision" && action !== "show" && action !== "list" ? 4 : 3)
    : 2;
  const dynamicPath = path.slice(0, pathLength).some(word => !isPlainWord(word.syntax));
  const family = AZ_FAMILIES.find(({ path }) => path.test(pathText))?.family;
  if (direct && xargs && (path.length < 2 ||
      /^(?:keyvault|containerapp|webapp|functionapp|staticwebapp|logicapp|account|rest)$/.test(group))) {
    return "unresolved input in an Azure secret/config command";
  }

  if ((!isPlainWord(program.syntax) && AZ_WRAPPER_FAMILY.test(pathText)) ||
      (direct && (dynamicPath || !isPlainWord(words[launcher].syntax))) ||
      (dynamicPath && (AZ_WRAPPER_FAMILY.test(pathText) || /(?:^| )function keys(?: |$)/.test(pathText)))) {
    return "nonliteral Azure executable or subcommand in a secret/config command";
  }
  const arm = family === "token" && literalArmAudience(pathArgs);
  const metadata = family === "app-metadata" && metadataOnlyArgs(pathArgs, appMeta(raw, targets));
  const permittedVariables = family === "vault-list" || arm || metadata;
  const unresolved = xargs || pathArgs.some((word, i) =>
    !(permittedVariables && quotedMetadataValue(pathArgs, i)) &&
    !(family === "vault-list" && queryValueAt(pathArgs, i) && /^\[\]\.[\w.]+$/.test(word.value)) &&
    (!isPlainWord(word.syntax) || /(^|[\s=])@|\{\}|\bxargs\b/.test(word.value)));
  if (family && unresolved) {
    return [program, ...args].some(({ syntax }) => COMMAND_SUBSTITUTION.test(syntax))
      ? "command substitution in an Azure secret/config command"
      : "unresolved input in an Azure secret/config command";
  }
  if (!family && (!direct || !/(?:^|\s)--sh/.test(argv))) return null;
  if (/^containerapp job secret (?:show|list)(?: |$)/.test(pathText)) return "Azure Container Apps job secret read";
  if (/^containerapp job (?:show|list)(?: |$)/.test(pathText) && !metadata) {
    return "Azure Container Apps job show/list requires a metadata-only --query";
  }

  return checkAzureFamily(family, argv, raw, () => sensitiveAzureTarget(argv, targets), false, false, false, targets);
}

function checkAzureFamily(family, argv, raw, getSensitive, legacyUnresolved, liveMatch = false, liveOnly = false, targets) {
  if (family === "token" && (SECRET_TOKEN_RESOURCE.test(argv) || SECRET_TOKEN_TYPE.test(argv))) return "Azure token for Key Vault or SQL";
  if (family === "rest" && (/vault\.azure\.net/.test(argv) || AZ_REST_ENDPOINT.test(argv))) return "az rest against a secret store or config list endpoint";
  const showValues = /--show-[vs]|(?:^|\s)--sh/.test(argv);
  if ((family === "token" || family === "rest") && !showValues) return null;
  const sensitive = getSensitive();
  if (!sensitive && !legacyUnresolved) return null;
  const target = sensitive ? " on an erpure/prd vault or app" : " on an unresolved vault or app";
  if (showValues) return "--show-values/--show-secrets" + target;
  const debug = AZ_DEBUG.test(argv) || /--(?:debug|verbose)/.test(argv);
  const metadata = fields => {
    if (!liveOnly && !metadataOnlyQuery(raw, fields)) return false;
    if (!liveMatch && !liveOnly) return true;
    const query = queries(raw, true);
    return query?.length === 1 && !/--debug|--verbose/i.test(raw) && onlyFields(query[0], fields);
  };
  switch (family) {
    case "vault-export": return "Azure secret export or recovery" + target;
    case "vault-show":
      return metadata(META_FIELD) ? null : "az keyvault secret show requires a metadata-only --query" + target + METADATA_COMMAND;
    case "vault-versions":
      return debug || /value/.test(argv) ? "az keyvault secret list-versions with values" + target : null;
    case "vault-list": return debug ? "az keyvault secret list with debug output" + target : null;
    case "app-secret-show": return "az containerapp secret show" + target;
    case "app-config": return "connection strings / app settings list" + target;
    case "app-keys": return "publishing credentials or function keys" + target;
    case "app-metadata":
      return metadata(appMeta(raw, targets)) ? null : "az containerapp show/list requires a metadata-only --query" + target + METADATA_COMMAND;
    default: return null;
  }
}

function sqlServerFlag(name, arg) {
  if (/^(?:sqlcmd|go-sqlcmd|osql|isql|tsql|bcp)$/.test(name)) {
    const match = arg.match(name === "tsql" ? /^-[SH](?:[=:]?([\s\S]+))?$/ : /^-S(?:[=:]?([\s\S]+))?$/);
    if (match) return match;
  }
  if (name === "sqlpackage") {
    const match = arg.match(/^\/(?:sourceservername|targetservername|ssn|tsn):([\s\S]*)$/i);
    if (match) return match;
  }
  if (name === "invoke-sqlcmd") return arg.match(/^-serverinstance(?::([\s\S]*))?$/i);
  return arg.match(/^--server(?:=([\s\S]*))?$/i);
}

function trackScriptWrites(writer, args, redirects, heredocs, cwd, writtenScripts) {
  let body;
  if (writer === "tee" || writer === "cat" && args.every(word => /^(?:--|-)$/.test(word.value))) {
    const input = redirects.findLast(({ syntax }) => /^(?:0?[<]|0>)/.test(syntax));
    body = heredocs.get(input && input.start + input.syntax.indexOf("<<"));
  }
  if ((writer === "echo" || writer === "printf") && args.every(word => isPlainWord(word.syntax))) {
    const values = args.map(word => word.value);
    if (writer === "echo" && values.every(value => !/^-|\\/.test(value))) body = values.join(" ") + "\n";
    if (writer === "printf") {
      const [format, ...data] = values;
      if (format === "%s") body = data.join("");
      else if (format === "%s\\n") body = (data.length ? data : [""]).join("\n") + "\n";
      else if (format !== undefined && /^(?:[^%\\]|\\n)*$/.test(format)) body = format.replace(/\\n/g, "\n");
    }
  }
  const outputs = redirects.filter(({ syntax, target }) =>
    /^(?:&>>?|\d*(?:<>|>))/.test(syntax) &&
    (!/^\d*>&/.test(syntax) || !/^(?:\d+-?|-)$/.test(target?.value ?? "")));
  if (writer === "tee") {
    outputs.push(...args.filter(word => !word.value.startsWith("-")).map(target => ({ target })));
  }
  const stdoutTargets = outputs.filter(({ syntax }) => /^(?:1?>|&>)/.test(syntax ?? ""));
  const stdoutDuplicated = redirects.some(({ syntax }) => /^1?>&/.test(syntax));
  for (const { target, syntax } of outputs) {
    if (!target?.value || !isPlainWord(target.syntax)) continue;
    const path = resolveScriptPath(cwd ?? "/", target.value);
    const known = !syntax || /^(?:1?>[>|]?)(?!&)/.test(syntax) && stdoutTargets.length === 1 && !stdoutDuplicated;
    const earlier = writtenScripts.get(path);
    // Keep previous candidates because a conditional overwrite might not run.
    const separator = earlier && !syntax?.includes(">>") ? "\n" : "";
    writtenScripts.set(path, earlier === null || !known || body === undefined ? null : (earlier ?? "") + separator + body);
  }
  // Unknown writers are beyond this pass; track explicit redirects and known output operands.
  const outputOperands = [];
  if (/^(?:cp|install|sponge|mv)$/.test(writer)) outputOperands.push(args.at(-1));
  for (const [i, word] of args.entries()) {
    if (writer === "dd" && word.value.startsWith("of=")) {
      outputOperands.push({ ...word, value: word.value.slice(3) });
    }
    if (/^(?:curl|sort|wget)$/.test(writer)) {
      const option = writer === "wget" ? /^(-O|--output-document)(?:=?(.*))$/ : /^(-o|--output)(?:=?(.*))$/;
      const match = option.exec(word.value);
      if (match) outputOperands.push(match[2] ? { ...word, value: match[2] } : args[i + 1]);
    }
  }
  for (const word of outputOperands) {
    if (word?.value && !word.value.startsWith("-") && isPlainWord(word.syntax)) {
      writtenScripts.set(resolveScriptPath(cwd ?? "/", word.value), null);
    }
  }
}

function isDbopsProgram(value, cwd, scriptOperand = false) {
  if (!value) return false;
  if (/^dbops(?:\.mjs)?$/.test(programName(value))) return true;
  if (!cwd || !scriptOperand && !value.includes("/")) return false;
  let fd;
  try {
    const home = userInfo().homedir;
    const filename = realpathSync(resolve(cwd, value.replace(/^~(?=\/)/, home)));
    if (filename === join(home, ".trioharness/db-ops/dbops") ||
        filename === join(home, ".trioharness/db-ops/dbops.mjs")) return true;
    fd = openSync(filename, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return false;
    const bytes = Buffer.alloc(256);
    const length = readSync(fd, bytes);
    const header = bytes.toString("utf8", 0, length);
    return header.startsWith('#!/bin/sh\nexec node "$(dirname "$0")/dbops.mjs" "$@"') ||
      header.startsWith("#!/usr/bin/env node\n// db-ops: run SQL against the hoster's SQL servers");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function checkDbopsAction(args, deferred) {
  const [verb, ...rest] = args;
  if (!verb || !isPlainWord(verb.syntax)) return "dbops requires a literal supported subcommand";
  if (["audit", "allowlist", "--help"].includes(verb.value)) return null;
  if (verb.value === "query") {
    const query = rest.every(word => isPlainWord(word.syntax)) && dbopsQuery(rest.map(word => word.value));
    if (query && (query.catalog || deferred === "dbops query")) return null;
    return "DB read requires the owner's approval and literal query arguments";
  }
  if (verb.value === "migrate") {
    if (deferred === "dbops migrate") return null;
    const plan = rest.some(word => word.value === "--plan" && isPlainWord(word.syntax));
    const confirmation = rest.some(word => /^--confirm-(?:prd|staging)(?:=|$)/.test(word.value));
    if (plan && !confirmation && rest.every(word =>
      isPlainWord(word.syntax) && !/(?:^|=)~/.test(word.syntax))) return null;
    return "card-gated DB migration requires the owner's approval";
  }
  if (dbopsLanVerbs.has(verb.value)) {
    return deferred === "dbops LAN" ? null : "erpure LAN/host action requires the owner's approval";
  }
  return "unsupported dbops subcommand";
}

function checkErpureLinux(name, args, deferred) {
  if (!args.some(word => /(?:^|[^\w-])erpure-linux(?![\w-])/i.test(word))) return null;
  if (!/^(?:az|ssh|scp|sftp|rsync|mosh|nc|ncat|netcat|curl|wget|telnet|ftp)$/.test(name)) return null;
  if (name === "az") {
    const verb = azurePath(args.map(value => ({ value }))).at(-1)?.value;
    if (AZ_READ_VERBS.has(verb) || /^(?:show|list|get)-/.test(verb)) return null;
  }
  if (name === "az" && (deferred === "az ssh arc" || deferred?.startsWith("az connectedmachine run-command "))) return null;
  return "erpure-linux access requires an approved az ssh arc or az connectedmachine run-command";
}

function checkSecretCommands(command, targets, depth, checkShell, inlineSource, options = {}) {
  const heredocSpans = new Map();
  const spans = substitutionSpans(command, true, heredocSpans).sort((a, b) => a.start - b.start);
  const substitutions = new Map(spans.map(span => [span.start, span]));
  const ranges = [null, ...spans.map(span => ({
    start: span.start + span.marker.length, stop: span.end - 1, span,
  }))];
  // A separator starts one scan of the indentation on its line. Bound the name scan.
  const functionPattern = /(?:^|[;\n{(]|&&|\|\||\b(?:then|do|else)(?=[^\S\n]))[^\S\n]*(?:function\s+([^\s;&|(){}<>'"]{1,128})(?:\s*\(\s*\))?|([^\s;&|(){}<>'"]{1,128})\s*\(\s*\))\s*(?:[({]|(?:if|while|until|for|select|case)\b)/g;
  const functions = new Set([...command.matchAll(functionPattern)].map(match => match[1] ?? match[2]));
  let azure = false;
  let accessDenial;
  const structural = !inlineSource && options.structural !== false;
  const heredocs = new Map([...heredocSpans.values()].map(body =>
    [body.redirectStart, command.slice(body.start, body.contentEnd)]));
  for (const range of ranges) {
    let cwd = options.cwd;
    const segments = shellCommands(command, { ...range, substitutions, describeWords: true,
      heredocSpans: inlineSource ? undefined : heredocSpans, casePatterns: structural })
      .map(segment => commandWords(segment, true));
    const writtenScripts = options.writtenScripts ?? new Map();
    for (const { operands: words, redirects } of segments) {
      const index = words.findIndex(({ value, syntax }) => !commandHead(value, syntax));
      if (index < 0) continue;
      const program = words[index];
      const args = words.slice(index + 1);
      if (!inlineSource && options.structural !== false && program.value === "cd" && cwd !== undefined) {
        const directory = args[args[0]?.value === "--" ? 1 : 0];
        cwd = !directory ? homedir() : isPlainWord(directory.syntax) && !/^[-+]/.test(directory.value) &&
          (cwd || isAbsolute(directory.value) || directory.value.startsWith("~/")) ?
          resolveScriptPath(cwd ?? "/", directory.value) : null;
      }
      if (!options.resourceScan && !inlineSource && options.structural !== false && program.piped && functions.has(program.value)) {
        return { denial: "pipe into a shell function executes unchecked input" };
      }
      const inspect = (text, shell, literalOnly, overrides) =>
        shell || options.resourceScan ? checkShell(text, targets, depth + 1, shell ? literalOnly : true,
          { cwd, writtenScripts, ...overrides }) : checkSecrets(text, targets, depth + 1, true, checkShell, options);
      if (options.resourceScan) {
        const creation = resourceCreation(words.slice(index).map(word => word.value));
        if (creation) return { denial: creation.reason };
      }
      const values = words.map(({ value }) => value);
      const executableIndex = executableIndexAfterLaunchers(values, index);
      const executable = words[executableIndex];
      const operands = words.slice(executableIndex + 1);
      const name = programName(executable?.value);
      const scriptIndex = interpreterScriptIndex(values.slice(executableIndex), true) - 1;
      const dbopsArgs = isDbopsProgram(executable?.value, cwd) ? operands :
        scriptIndex >= 0 && operands[scriptIndex] && isPlainWord(operands[scriptIndex].syntax) &&
          isDbopsProgram(operands[scriptIndex].value, cwd, true) ? operands.slice(scriptIndex + 1) : null;
      if (!options.resourceScan && !options.outsideCodeDen) {
        // These launchers can add arguments that the hook never sees, including a query's user-table flag.
        if (dbopsArgs && values.slice(index, executableIndex).some(value => /^(?:xargs|parallel)$/.test(launcherName(value)))) {
          accessDenial ??= "dbops requires explicit arguments without xargs or parallel";
        }
        accessDenial ??= dbopsArgs ? checkDbopsAction(dbopsArgs, options.deferPrdWrite) :
          checkErpureLinux(name, values.slice(executableIndex + 1), options.deferPrdWrite);
      }
      const policyScan = options.resourceScan;
      if (policyScan && name === "eval" && operands.every(word => isPlainWord(word.syntax))) {
        const denial = inspect(operands.map(word => word.value).join(" "), true);
        if (denial) return { denial };
      }
      const denial = (policyScan ? null : checkAzurePath(program, args, command, targets)) ??
        (!inlineSource && options.structural !== false ? checkExecution(program, args, isPlainWord, inspect, {
          ...options, cwd, redirects, heredocs, writtenScripts, hookCwd: options.hookCwd ?? options.cwd,
          scriptContent: options.scriptContent && ![program, ...args].some(word => SCRIPT_SECRET_FAMILY.test(word.value)),
        }) : null) ??
        (policyScan ? null : checkAzureUrl(program, [program, ...args], isPlainWord));
      if (denial && (!options.resourceScan || denial.startsWith("NEW RESOURCE:"))) return { denial };
      if (!inlineSource && options.structural !== false && cwd !== null) {
        trackScriptWrites(programName(program.value), args, redirects, heredocs, cwd, writtenScripts);
      }
      if (policyScan) continue;
      const literalAzure = azureProgramIndex(values.slice(executableIndex)) >= 0;
      azure ||= literalAzure && !values.slice(index, executableIndex).some(value => launcherName(value) === "xargs");
      if (!literalAzure && !isPlainWord(program.syntax) &&
          /az.*(?:keyvault|containerapp|configappsettings|getaccesstoken)/.test(alnumView([program, ...args].map(word => word.value).join(" ")))) {
        return { denial: "nonliteral Azure executable in a secret/config command" };
      }
      if (name === "security" && !isPlainWord(operands[0]?.syntax ?? "")) {
        return { denial: "reading the macOS keychain (nonliteral security operation)" };
      }
      if (!isPlainWord(executable.syntax) && namesSqlHost(operands.map(word => word.value).join(" ").toLowerCase())) {
        return { denial: "nonliteral executable naming ERPURE-SQL" };
      }
      if (!SQL_CLIENT_NAME.test(name)) continue;
      for (const [i, arg] of operands.entries()) {
        const flag = sqlServerFlag(name, arg.value);
        if (!flag) continue;
        const server = flag[1] || operands[i + 1]?.value || "";
        if (!isPlainWord(server, { allowIPv6: true })) {
          return { denial: "a SQL client whose server is nonliteral (cannot be checked against ERPURE-SQL; name the server literally)" };
        }
      }
    }
  }
  return { azure, denial: accessDenial };
}

const AZ_SECRET_ALNUM = /keyvault|secretshow|secretdownload|secretbackup|secretrestore|secretrecover|listversions|containerappsecret|containerappjobsecret|appsettings|connectionstring|getaccesstoken|listsecrets|showvalues|showsecrets|listkeys|publishingcredentials|publishingprofiles|listfunctionappsettings/;
const KEYCHAIN_ALNUM = /findgenericpassword|findinternetpassword|dumpkeychain|exportkeychain/;
const alnumView = form => form.toLowerCase().replace(/[^a-z0-9]/g, "");
const DBOPS_PROGRAM = resolve(homedir(), ".trioharness/db-ops/dbops");

function dynamicSqlClient(command) {
  return shellCommands(command).some(segment => {
    const { operands } = commandWords(segment);
    const head = operands.findIndex(word => !commandHead(word));
    if (head < 0) return false;
    const index = executableIndexAfterLaunchers(operands, head);
    const path = operands[index];
    if (path.startsWith("/") || path.startsWith("~/")) {
      if (resolveScriptPath("/", path) === DBOPS_PROGRAM) return false;
    }
    return operands.slice(index).some(word => SQL_CLIENT_NAME.test(programName(word)));
  });
}

function hasDynamicText(command) {
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[\s\S]|[$`{}*?\[]/g;
  for (const [token] of command.matchAll(tokens)) {
    if (token.startsWith("'") && token.length > 1) continue;
    if (token.startsWith('"') && token.length > 1) {
      if (/[$`{}]/.test(token)) return true;
    } else if (/[$`{}]/.test(token) || /^[*?\[]$/.test(token)) return true;
  }
  return shellCommands(command).some(words => words.some(word => /^(?:.*=)?@|\bxargs\b/i.test(word)));
}

function literalMetadataWithBraces(command) {
  const normalized = normalizeCmd(command);
  const withoutQueryBraces = command.replace(/(\s(?:--q[^\s=]*|-q)(?:\s+|=))"([^"]*)"/g,
    (_, flag, query) => flag + '"' + query.replace(/[{}]/g, "") + '"');
  return !hasDynamicText(withoutQueryBraces) &&
    (/^az keyvault secret show /.test(normalized) && metadataOnlyQuery(command) ||
     /^az containerapp (?:(?:job|revision) )?(?:show|list) /.test(normalized) && metadataOnlyQuery(command, APP_META));
}

function incidentalVaultList(command) {
  // Preserve the existing literal metadata list after a standalone date display.
  return /^echo "\$\(date\)"; az keyvault secret list --vault-name [\w-]+$/.test(command.trim());
}

export function checkSecrets(cmd, targets, depth = 0, inlineSource = false, checkShell = checkCommand, options = {}) {
  const raw = String(cmd);
  if (depth > 16) return "nested command exceeds inspection depth";
  const joined = joinContinuations(raw);
  return checkRawSecretForms(raw, joined, targets, depth) ??
    checkSecretStructure(raw, joined, targets, depth, inlineSource, checkShell, options);
}

function rawSqlView(joined) {
  return joined.toLowerCase().replace(/[`"'\\]/g, " ");
}

function checkRawSecretForms(raw, joined, targets, depth, liveOnly) {
  const sqlDenial = checkSqlForm(rawSqlView(joined));
  if (sqlDenial) return sqlDenial;
  if (depth === 0 && webchatEnvReadback(raw, targets)) return null;
  const unresolved = /\$|`|\{\}|xargs/.test(joined) || /\$|`|\{\}|xargs/.test(raw);
  for (const s of new Set([normalizeCmd(raw), normalizeCmd(joined)])) {
    const denial = checkSecretForm(s, raw, unresolved || s.includes("xargs"), targets, liveOnly);
    if (denial) return denial;
  }
  return null;
}

function structuralSizeDenial(raw) {
  return Buffer.byteLength(raw) > MAX_SECRET_COMMAND_BYTES ? "command exceeds 64 KB (too large for structural analysis)" : null;
}

function checkSecretStructure(raw, joined, targets, depth, inlineSource, checkShell, options) {
  const sizeDenial = structuralSizeDenial(raw);
  if (sizeDenial) {
    if (!options.outsideCodeDen) return sizeDenial;
    const nameScan = joined.toLowerCase();
    if ([nameScan, nameScan.replace(/["'\\]/g, "")].some(form => AZ_TOKEN.test(form) || SQL_CLIENTS.test(form))) {
      return "command exceeds 64 KB and names Azure CLI or a SQL client (too large to check safely)";
    }
  }
  if (depth === 0 && webchatEnvReadback(raw, targets)) return null;
  const originals = [...new Set([raw, joined])];
  const substitutions = originals.flatMap(form => COMMAND_SUBSTITUTION.test(form) ? substitutionViews(form) : []);
  const forms = substitutions.map(normalizeCmd);
  const unresolved = /\$|`|\{\}|xargs/.test(joined) || /\$|`|\{\}|xargs/.test(raw);
  for (const s of new Set(forms)) {
    const denial = checkSecretForm(s, raw, unresolved || s.includes("xargs"), targets);
    if (denial) return denial;
  }
  const structured = checkSecretCommands(joined, targets, depth, checkShell, inlineSource, options);
  if (structured.denial) return structured.denial;
  const heuristicAlnum = alnumView(joined);
  if (KEYCHAIN_ALNUM.test(heuristicAlnum) ||
      substitutions.some(form => KEYCHAIN_ALNUM.test(alnumView(form)))) return "reading the macOS keychain";
  const dynamic = hasDynamicText(joined);
  if (dynamic && dynamicSqlClient(joined) &&
      (heuristicAlnum.includes("erpure") ||
        [rawSqlView(joined), ...substitutions.map(normalizeCmd), heuristicAlnum].some(namesSqlHost))) {
    return "dynamic text in a SQL command naming ERPURE-SQL";
  }
  if (!structured.azure && dynamic && AZ_SECRET_ALNUM.test(heuristicAlnum) &&
      (AZ_TOKEN.test(normalizeCmd(joined)) || /(?:^|[;|&\n])\s*[^\s]*[$`{][^\s]*\s+(?:keyvault|containerapp)\s+secret/i.test(joined)) &&
      !literalMetadataWithBraces(raw) && !incidentalVaultList(joined)) {
    return "dynamic text in an Azure secret/config command";
  }
  return null;
}

function checkSqlForm(s) {
  // SQL: any client or driver command naming ERPURE-SQL (or its IP in any encoding); SQL clients with a variable server.
  const separatedHost = s.replace(/\b(?:tcp|np|lpc|admin):|(?<=-s)(?:tcp|np|lpc|admin):/g, " ")
    .replace(/(?<![\w-])-s(?=[\d:])/g, "-s ")
    .replace(/-serverinstance[:=]\s*/g, "-serverinstance ");
  if ((SQL_RUNNERS.test(s) && namesSqlHost(s)) ||
      (separatedHost !== s && SQL_RUNNERS.test(separatedHost) && namesSqlHost(separatedHost))) return "a SQL client or driver against ERPURE-SQL (production). Use dbops: `~/.trioharness/db-ops/dbops query 59917 <database> \"<SELECT …>\"` for reads (read-only), and for writes `~/.trioharness/db-ops/dbops migrate <key> <db> --script <file.sql> --plan`, then `--confirm-staging` (staging) or `--confirm-prd <sha256>` (PRD) after an approval card";
  if (SQL_CLIENTS.test(s) && (/(-s|--server|-serverinstance|server\s*=|data\s*source\s*=)\s*\$/i.test(s) || /sqlcmdserver\s*=/i.test(s))) return "a SQL client whose server comes from a variable (cannot be checked against ERPURE-SQL; name the server literally). For ERPURE-SQL use dbops (read-only `dbops query`), and for writes `~/.trioharness/db-ops/dbops migrate <key> <db> --script <file.sql> --plan`, then `--confirm-staging` (staging) or `--confirm-prd <sha256>` (PRD) after an approval card";
  return null;
}

function checkSecretForm(s, raw, unresolved, targets, liveOnly) {
  const sqlDenial = checkSqlForm(s);
  if (sqlDenial) return sqlDenial;
  // Retain the baseline's coverage of embedded command text and normalized splices.
  // The argv path is authoritative for new family and unresolved-input checks.
  if (!AZ_COMMAND.test(s)) return null;
  let sensitive;
  const getSensitive = () => sensitive ??= sensitiveAzureTarget(s, targets);
  const pathView = s.replace(AZ_LEGACY_GLOBALS, "$1");
  for (const { family, legacy } of AZ_FAMILIES) {
    if (!legacy.test(pathView)) continue;
    const liveMatch = family === "app-metadata" ? LIVE_APP_METADATA.test(s) : legacy.test(s);
    if (liveOnly && !liveMatch) continue;
    const denial = checkAzureFamily(family, s, raw, getSensitive, unresolved, liveMatch, liveOnly, targets);
    if (denial) return denial;
  }
  return /--show-(values|secrets)/.test(s) ? checkAzureFamily(undefined, s, raw, getSensitive, unresolved) : null;
}

const LEDGER_NAME = /(?:^|[^\w-])prd-card-ledger(?:\.d|\.jsonl)(?![\w-])/;
const LEDGER_DENIAL = "touching the PRD approval card ledger";
const LEDGER_CONFIG = /(?:^|\/)\.config\/trioharness\/?$/;

function checkLedgerPath(path, cwd = process.cwd()) {
  if (!path) return null;
  const absolute = resolveScriptPath(cwd, path);
  return LEDGER_NAME.test(path) || LEDGER_NAME.test(absolute) || LEDGER_CONFIG.test(absolute) ? LEDGER_DENIAL : null;
}

function checkLedgerCommand(command, cwd = process.cwd()) {
  if (LEDGER_NAME.test(command)) return LEDGER_DENIAL;
  cwd ??= process.cwd();
  if (!/trioharness|\bcd\b/.test(command) && !cwd.includes("trioharness")) return null;
  if (structuralSizeDenial(command)) return LEDGER_DENIAL;
  for (const segment of shellCommands(joinContinuations(command), { describeWords: true })) {
    const { operands, redirects } = commandWords(segment, true);
    const words = operands.map(word => word.value);
    const first = words.findIndex(word => !commandHead(word));
    const index = executableIndexAfterLaunchers(words, first < 0 ? words.length : first);
    const head = programName(words[index] ?? "");
    const args = words.slice(index + 1);
    if (head === "cd" && args.length) cwd = resolveScriptPath(cwd, args.at(-1));
    const protectedTarget = value => {
      const operand = value.replace(/^[-\w]+=/, "").replace(/^\$\{?HOME\}?\//, "~/");
      const path = resolveScriptPath(cwd, operand);
      return LEDGER_NAME.test(path) || /(?:^|\/)\.config\/trioharness(?:$|[*?\[]|\/[^\s]*[*?\[])/.test(path);
    };
    if (redirects.some(word => /^(?:&>|\d*>)/.test(word.syntax) && word.target && protectedTarget(word.target.value)) ||
        !/^(?:cd|pwd|ls|stat|cat|rg|grep|echo|printf|test|true|false)$/.test(head) &&
          args.some(arg => protectedTarget(arg))) return LEDGER_DENIAL;
  }
  return null;
}

export function checkPath(p) {
  if (!p) return null;
  const rules = [
    [/(^|\/)\.git\/hooks\//, "editing .git/hooks"],
    [/(^|\/)\.husky\//, "editing git hooks (.husky)"],
    [/(^|\/)\.claude\/settings(\.local)?\.json$/, "editing Claude settings/hooks"],
    [/(^|\/)\.codex\/config\.toml$/, "editing Codex config"],
    [/(^|\/)\.env(\.[\w-]+)?$/, "writing a .env file"],
  ];
  for (const [re, why] of rules) if (re.test(p)) return why;
  return null;
}

// Match Node's resolved entry path when the hook is launched through a symlink.
function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1)); }
  catch { return false; }
}

if (isMain(import.meta.url)) await main();
else await loadGuardRules();
