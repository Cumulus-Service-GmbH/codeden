import type {
  ChecklistChange,
  ChecklistItem,
  ChecklistProposal,
  ChecklistStatus,
  InboxItem,
  ProjectChecklist,
  Session,
} from "@codeden/contracts";

/** True once the owner approved the checklist (an absent state is a draft). */
export function isApproved(checklist: ProjectChecklist): boolean {
  return checklist.state === "approved";
}

/** "Draft" or "Approved · locked" for the section's state chip. */
export function stateLabel(checklist: ProjectChecklist): string {
  return isApproved(checklist) ? "Approved · locked" : "Draft";
}

/** What the pending owner card asks for. */
export function proposalLabel(kind: ChecklistProposal["kind"]): string {
  return kind === "expand" ? "Expansion requested" : "Approval requested";
}

/** Why the card was raised: its reason, else the purpose of the PM start it expands for. */
export function proposalDetail(proposal: ChecklistProposal): string | null {
  return proposal.reason?.trim() || proposal.startPurpose?.trim() || null;
}

export type DiffSign = "+" | "−" | "~";

/** What approving an addition applies to the new item besides its text. */
export interface DiffAddition {
  status: ChecklistStatus;
  eta?: string;
  needsOwner?: string;
}

export interface DiffLine {
  sign: DiffSign;
  text: string;
  addition?: DiffAddition;
  /** The item's short id, set only when another line or current item would read the same. */
  id?: string;
}

/**
 * A proposal's diff as short lines: `+ text` added (with the initial status, ETA and owner ask
 * approval applies, from the proposal's addition metadata), `− text` removed,
 * `~ before → after` for a changed text, and `~ text: from → to` for a status change. When
 * another line or one of the checklist's `items` would read the same, the line carries the
 * item's short id (`sharedLabelIds`) so the owner can tell which one changes.
 */
export function diffLines(
  diff: readonly ChecklistChange[],
  additionMetadata: ChecklistProposal["additionMetadata"] = [],
  items: readonly Pick<ChecklistItem, "id" | "text">[] = [],
): DiffLine[] {
  const ids = sharedLabelIds(diff, items);
  const metaById = new Map(additionMetadata.map((m) => [m.id, m]));
  return diff.map((change) => {
    const line = lineOf(change, metaById.get(change.itemId));
    const id = ids.get(change.itemId);
    return id === undefined ? line : { ...line, id };
  });
}

/**
 * The short ids of the items whose diff label or current text reads the same as another
 * item's once rendered (runs of whitespace collapsed, so `Fix  cart` reads as `Fix cart`), so each of those lines (diff lines and current items alike) can show its id. A short
 * id is the id's first 8 characters, longer when that would still leave two of them the same.
 */
export function sharedLabelIds(
  diff: readonly ChecklistChange[],
  items: readonly Pick<ChecklistItem, "id" | "text">[] = [],
): Map<string, string> {
  const idsByLabel = new Map<string, Set<string>>();
  const note = (text: string | undefined, id: string) => {
    if (text === undefined) return;
    const label = renderedLabel(text);
    const ids = idsByLabel.get(label) ?? new Set<string>();
    ids.add(id);
    idsByLabel.set(label, ids);
  };
  for (const item of items) note(item.text, item.id);
  for (const change of diff) {
    note(change.text, change.itemId);
    note(change.textBefore, change.itemId);
    note(lineOf(change, undefined).text, change.itemId);
  }
  const shared = new Set<string>();
  for (const ids of idsByLabel.values()) if (ids.size > 1) for (const id of ids) shared.add(id);
  const all = [...shared];
  let length = 8;
  while (new Set(all.map((id) => id.slice(0, length))).size < all.length) length++;
  return new Map(all.map((id) => [id, id.slice(0, length)]));
}

/** A label as the page shows it: HTML collapses runs of whitespace and drops it at the ends. */
function renderedLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function lineOf(
  change: ChecklistChange,
  meta: NonNullable<ChecklistProposal["additionMetadata"]>[number] | undefined,
): DiffLine {
  if (change.from === null) {
    const addition: DiffAddition = { status: change.to ?? "todo" };
    if (meta?.eta) addition.eta = meta.eta;
    if (meta?.needsOwner) addition.needsOwner = meta.needsOwner.reason;
    return { sign: "+", text: change.text, addition };
  }
  if (change.to === null) return { sign: "−", text: change.text };
  if (change.textBefore !== undefined && change.textBefore !== change.text)
    return { sign: "~", text: `${change.textBefore} → ${change.text}` };
  return { sign: "~", text: `${change.text}: ${change.from} → ${change.to}` };
}

/** What approving a draft of `count` items does; `below` when the items are listed under it. */
export function approvalSummary(count: number, below: boolean): string {
  if (count === 0) return "Approving locks the empty list as it is now.";
  if (count === 1) return `Approving locks ${below ? "the item below" : "this item"} as it is now.`;
  return `Approving locks ${below ? `the ${count} items below` : `these ${count} items`} as they are now.`;
}

/** The checklist whose pending proposal is the given inbox card, if any. */
export function checklistForCard(
  checklists: readonly ProjectChecklist[] | undefined,
  inboxItemId: string,
): (ProjectChecklist & { pending: ChecklistProposal }) | undefined {
  return checklists?.find(
    (c): c is ProjectChecklist & { pending: ChecklistProposal } =>
      c.pending?.inboxItemId === inboxItemId,
  );
}

export type DecisionOutcome =
  | "approved"
  | "rejected"
  | "superseded"
  | "already_approved"
  | "already_rejected";

/** Slack for a card closed just before the call started (same machine, so the clocks agree). */
const ALREADY_SLACK_MS = 2000;

/**
 * What an Approve / Reject call actually did, from the card the server returned: a newer
 * proposal superseded it, it was decided earlier (either way), or it took this decision.
 */
export function decisionOutcome(
  approve: boolean,
  card: Pick<InboxItem, "status" | "resolution" | "resolvedAt">,
  startedAt: number,
): DecisionOutcome {
  const { resolution } = card;
  if (
    card.status === "dismissed" &&
    resolution !== null &&
    typeof resolution === "object" &&
    !Array.isArray(resolution) &&
    resolution.note === "Superseded"
  )
    return "superseded";
  const approved = card.status === "resolved";
  const earlier =
    card.status === "open" ||
    approved !== approve ||
    (card.resolvedAt !== null && Date.parse(card.resolvedAt) < startedAt - ALREADY_SLACK_MS);
  if (earlier) return approved ? "already_approved" : "already_rejected";
  return approved ? "approved" : "rejected";
}

/** The toast for a decision's outcome: a title and, when the decision didn't apply, why. */
export function decisionToast(outcome: DecisionOutcome): {
  tone: "success" | "info";
  title: string;
  description?: string;
} {
  switch (outcome) {
    case "approved":
      return { tone: "success", title: "Checklist change approved" };
    case "rejected":
      return { tone: "success", title: "Checklist change rejected" };
    case "superseded":
      return {
        tone: "info",
        title: "This proposal was replaced",
        description: "A newer proposal took its place, so nothing changed.",
      };
    case "already_approved":
      return { tone: "info", title: "Already approved", description: "Nothing changed." };
    case "already_rejected":
      return {
        tone: "info",
        title: "Already decided",
        description: "It was rejected or closed earlier, so nothing changed.",
      };
  }
}

/** A linked session's label: its title from the snapshot, else the first 8 characters of its id. */
export function sessionLabel(
  sessionId: string,
  sessions: readonly Pick<Session, "id" | "title">[] | undefined,
): string {
  const title = sessions?.find((s) => s.id === sessionId)?.title?.trim();
  return title || sessionId.slice(0, 8);
}
