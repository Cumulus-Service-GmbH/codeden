import type {
  ItemOf,
  ItemRecord,
  Role,
  Session,
  SessionStatus,
  SessionUsage,
  Thread,
  Turn,
  TurnUsage,
} from "@codeden/contracts";
import {
  duration,
  inlineCode,
  oneLine,
  quote,
  slug,
  tokenCount,
  usd,
  utcTime,
} from "./transcript-format";
import { type ItemContext, itemBlock, toolLine } from "./transcript-items";

/** Everything a session's Markdown export is written from (§13). */
export interface TranscriptSource {
  session: Session;
  projectName: string | null;
  /** Display name of the session's provider. */
  providerName: string;
  /** Title of the session it was forked or handed off from, when that session still exists. */
  forkedFromTitle: string | null;
  threads: Thread[];
  /** Oldest first. */
  turns: Turn[];
  items: ItemRecord[];
  /** The ledger's figures; null when they couldn't be read. */
  usage: SessionUsage | null;
  exportedAt: Date;
  /** CodeDen's version, named in the footer line. */
  version: string;
}

const STATUS: Readonly<Record<SessionStatus, string>> = {
  created: "Created",
  queued: "Queued",
  starting: "Starting",
  running: "Working",
  waiting: "Needs you",
  idle: "Idle",
  interrupted: "Interrupted",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** Who writes the replies in a session's own threads. */
const SPEAKERS: Readonly<Record<Role, string>> = {
  agent: "Agent",
  pm: "Project manager",
  orchestrator: "Orchestrator",
};

/** The export's heading: the session's title, or the role for the orchestrator and PMs. */
export function transcriptTitle(session: Session, projectName: string | null): string {
  if (session.role === "orchestrator") return "Orchestrator";
  if (session.role === "pm") {
    return projectName ? `Project manager · ${oneLine(projectName)}` : "Project manager";
  }
  return oneLine(session.title ?? session.purpose) || "Session";
}

/** `<slug of the title>-<YYYY-MM-DD>.md`, or `session-<id8>-<date>.md` for a title with no slug. */
export function transcriptFileName(
  session: Session,
  exportedAt: Date,
  projectName: string | null = null,
): string {
  const date = exportedAt.toISOString().slice(0, 10);
  const stem = slug(transcriptTitle(session, projectName)) || `session-${slug(session.id, 8)}`;
  return `${stem}-${date}.md`;
}

/**
 * A session's transcript as Markdown, to paste into an issue, a PR or a write-up: a facts list
 * with the ledger's cost (labelled as in §12.6), then each turn of the root thread with its
 * messages, plans, todos, questions, approvals, notices, one line per tool call, and subagents
 * with their own threads folded into `<details>`. Reasoning, tool output and diffs are left out.
 */
export function sessionTranscriptMarkdown(src: TranscriptSource): string {
  return `${[header(src), "---", ...body(src)].join("\n\n")}\n`;
}

// ---------------------------------------------------------------- header

function linkText(text: string): string {
  return oneLine(text).replace(/[[\]]/g, "\\$&");
}

/** The session's cost from the ledger, labelled as the app labels it (§12.6). */
export function costFact(usage: SessionUsage | null): string | null {
  if (!usage) return null;
  const t = usage.totals;
  if (t.turns === 0) return "no usage recorded yet";
  const total = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const size = `${tokenCount(total)} tokens · ${t.turns} turn${t.turns === 1 ? "" : "s"}`;
  if (t.unpricedTurns === t.turns) {
    return `Not priced (the model has no price and the provider reported no cost) · ${size}`;
  }
  const estimated = t.estimatedCostUsd > 0;
  const kind = usage.billing === "subscription" ? " API-equivalent" : "";
  const how = estimated ? " (estimated from list prices)" : "";
  const unpriced = t.unpricedTurns > 0 ? ` · ${t.unpricedTurns} not priced` : "";
  return `${usd(t.costUsd, estimated)}${kind}${how}${unpriced} · ${size}`;
}

function header(src: TranscriptSource): string {
  const s = src.session;
  const facts: string[] = [];
  if (src.projectName) facts.push(`**Project:** ${oneLine(src.projectName)}`);
  const agent = [src.providerName, s.model, s.effort ? `${s.effort} effort` : null];
  facts.push(`**Provider:** ${agent.filter(Boolean).join(" · ")}`);
  if (s.role !== "agent") facts.push(`**Role:** ${SPEAKERS[s.role]}`);
  if (s.branch) {
    const base = s.baseBranch ? ` from ${inlineCode(s.baseBranch)}` : "";
    facts.push(`**Branch:** ${inlineCode(s.branch)}${base}`);
  }
  if (s.issue) {
    const title = s.issue.title ? ` ${linkText(s.issue.title)}` : "";
    facts.push(`**Issue:** [#${s.issue.number}${title}](${s.issue.url})`);
  }
  if (s.pr) {
    const title = s.pr.title ? ` ${linkText(s.pr.title)}` : "";
    facts.push(`**Pull request:** [#${s.pr.number}${title}](${s.pr.url}) (${s.pr.state})`);
  }
  if (s.forkedFrom) {
    const how = s.forkedFrom.kind === "handoff" ? "Handed off from" : "Forked from";
    facts.push(`**${how}:** ${oneLine(src.forkedFromTitle ?? "another session")}`);
  }
  facts.push(`**Started:** ${utcTime(s.createdAt)} · **Last activity:** ${utcTime(s.updatedAt)}`);
  facts.push(`**Status:** ${STATUS[s.status]}${s.archivedAt ? " (archived)" : ""}`);
  if (s.result) facts.push(`**Result:** ${s.result.outcome}. ${oneLine(s.result.summary)}`);
  const cost = costFact(src.usage);
  if (cost) facts.push(`**Cost:** ${cost}`);
  return [
    `# ${transcriptTitle(s, src.projectName)}`,
    facts.map((f) => `- ${f}`).join("\n"),
    `_Exported from CodeDen ${src.version} on ${utcTime(src.exportedAt.toISOString())}. Reasoning, tool output and diffs are left out._`,
  ].join("\n\n");
}

// ---------------------------------------------------------------- turns and threads

/** What walking the threads needs: items by thread, the session's root, the ledger. */
interface Walk {
  src: TranscriptSource;
  byThread: Map<string, ItemRecord[]>;
  /** Threads already rendered, so a malformed link can't loop. */
  seen: Set<string>;
  root: string | null;
}

function turnCost(t: TurnUsage): string {
  const total = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const cost =
    t.costSource === "unpriced" && total > 0
      ? "not priced"
      : usd(t.costUsd, t.costSource === "estimated");
  return `${cost} · ${tokenCount(total)} tokens`;
}

function turnHeading(n: number, turn: Turn | undefined, usage: TurnUsage | undefined): string {
  const parts = [`## Turn ${n}`];
  if (turn) parts.push(utcTime(turn.startedAt));
  if (usage) parts.push(turnCost(usage));
  if (turn?.status === "running") parts.push("still running");
  if (turn?.status === "failed" || turn?.status === "interrupted") parts.push(turn.status);
  return parts.join(" · ");
}

function body(src: TranscriptSource): string[] {
  const byThread = new Map<string, ItemRecord[]>();
  for (const record of [...src.items].sort((a, b) => a.position - b.position)) {
    const list = byThread.get(record.threadId) ?? [];
    list.push(record);
    byThread.set(record.threadId, list);
  }
  const walk: Walk = {
    src,
    byThread,
    seen: new Set(),
    root: src.session.worktreePath ?? src.session.cwd,
  };
  // Subagent threads render under their card; every other thread is a conversation of turns.
  const children = new Set(
    src.items.flatMap((r) => (r.item.kind === "subagent" ? [r.item.childThreadId] : [])),
  );
  const order = [
    ...[...src.threads].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((t) => t.id),
    ...src.turns.map((t) => t.threadId),
    ...byThread.keys(),
  ];
  const roots = [...new Set(order)].filter((id) => !children.has(id));
  const blocks: string[] = [];
  let n = 0;
  for (const threadId of roots) {
    walk.seen.add(threadId);
    const turns = src.turns.filter((t) => t.threadId === threadId);
    const records = byThread.get(threadId) ?? [];
    const turnIds = [...new Set([...turns.map((t) => t.id), ...records.map((r) => r.turnId)])];
    const ctx: ItemContext = { root: walk.root, speaker: SPEAKERS[src.session.role] };
    for (const turnId of turnIds) {
      const turn = turns.find((t) => t.id === turnId);
      const usage = src.usage?.turns.find((t) => t.turnId === turnId);
      blocks.push(turnHeading(++n, turn, usage));
      blocks.push(
        ...renderItems(
          records.filter((r) => r.turnId === turnId),
          ctx,
          walk,
        ),
      );
      if (turn?.error && turn.status !== "completed") {
        const what = turn.status === "interrupted" ? "Turn interrupted" : "Turn failed";
        blocks.push(quote(`**${what}:** ${turn.error.message.trim()}`));
      }
    }
  }
  return blocks.length > 0 ? blocks : ["_No messages yet._"];
}

/** A thread's items as Markdown blocks; consecutive tool calls share one list. */
function renderItems(records: ItemRecord[], ctx: ItemContext, walk: Walk): string[] {
  const blocks: string[] = [];
  let tools: string[] = [];
  const flush = () => {
    if (tools.length > 0) blocks.push(tools.join("\n"));
    tools = [];
  };
  for (const { item } of records) {
    if (item.kind === "tool_call") {
      tools.push(toolLine(item, ctx.root));
      continue;
    }
    flush();
    const block = item.kind === "subagent" ? subagentBlock(item, walk) : itemBlock(item, ctx);
    if (block) blocks.push(block);
  }
  flush();
  return blocks;
}

/** What a subagent run cost, from the ledger's pricing of its tokens (display only, §7.3). */
function subagentCost(item: ItemOf<"subagent">, usage: SessionUsage | null): string | null {
  const cost = usage?.subagents.find((c) => c.itemId === item.id);
  if (!cost) return null;
  if (cost.costSource === "unpriced") return "not priced";
  const kind = usage?.billing === "subscription" ? " API-equivalent" : "";
  return `${usd(cost.costUsd, cost.costSource === "estimated")}${kind}`;
}

/**
 * A subagent card: who and what, its cost and stats, its result, then its own thread folded
 * into `<details>` (blank lines around the content, so GitHub renders its Markdown).
 */
function subagentBlock(item: ItemOf<"subagent">, walk: Walk): string {
  const name = item.agentType ? `Subagent ${inlineCode(item.agentType)}` : "Subagent";
  const facts: string[] = [];
  const cost = subagentCost(item, walk.src.usage);
  if (cost) facts.push(cost);
  const stats = item.stats;
  if (stats?.totalTokens !== undefined) facts.push(`${tokenCount(stats.totalTokens)} tokens`);
  if (stats?.toolUses !== undefined) {
    facts.push(`${stats.toolUses} tool call${stats.toolUses === 1 ? "" : "s"}`);
  }
  if (stats?.durationMs !== undefined) facts.push(duration(stats.durationMs));
  if (item.status === "in_progress") facts.push("still running");
  else if (item.status !== "completed") facts.push(item.status);
  const what = item.description ? `: ${oneLine(item.description)}` : "";
  const parts = [[`**${name}**${what}`, ...facts].join(" · ")];
  if (item.summary?.trim()) parts.push(quote(item.summary.trim()));

  const childId = item.childThreadId;
  const records = walk.seen.has(childId) ? [] : (walk.byThread.get(childId) ?? []);
  walk.seen.add(childId);
  const inner: string[] = [];
  if (item.prompt?.trim()) inner.push(`**Task**\n\n${item.prompt.trim()}`);
  inner.push(...renderItems(records, { root: walk.root, speaker: "Subagent" }, walk));
  if (inner.length > 0) {
    const steps = records.length;
    const label = steps > 0 ? `Its thread (${steps} step${steps === 1 ? "" : "s"})` : "Its task";
    parts.push([`<details>\n<summary>${label}</summary>`, ...inner, "</details>"].join("\n\n"));
  }
  return parts.join("\n\n");
}
