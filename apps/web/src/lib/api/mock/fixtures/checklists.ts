import type {
  ChecklistChange,
  ChecklistItem,
  InboxItem,
  ProjectChecklist,
} from "@codeden/contracts";
import { ago, ahead } from "./helpers";

function item(id: string, text: string, status: ChecklistItem["status"], m: number): ChecklistItem {
  return { id, text, status, updatedAt: ago(m) };
}

/** Sample orchestrator checklists for two projects, so the checklist sidebar has content. */
export const checklists: ProjectChecklist[] = [
  {
    projectId: "p-storefront",
    state: "approved",
    approvedAt: ago(180),
    enforce: true,
    pending: {
      id: "cp-storefront-1",
      kind: "expand",
      inboxItemId: "checklist-approval:cp-storefront-1",
      requestedAt: ago(3),
      reason: "QA found the cart badge drifts on narrow screens",
      diff: [
        { itemId: "badge", text: "Fix the cart badge position on phones", from: null, to: "doing" },
      ],
      order: ["checkout", "search", "a11y", "badge", "tests", "copy", "deploy"],
      additionMetadata: [
        {
          id: "badge",
          eta: ahead(120),
          needsOwner: { reason: "Pick the badge style", sessionId: "s-checkout" },
        },
      ],
    },
    items: [
      item("checkout", "Rebuild the checkout summary with line-item discounts", "done", 95),
      item("search", "Search results: keep filters in the URL", "done", 60),
      {
        ...item("a11y", "Fix focus order in the cart drawer", "doing", 12),
        note: "Drawer traps focus now; checking the close button",
        sessionIds: ["s-a11y", "s-checkout"],
        eta: ahead(90),
      },
      {
        ...item("tests", "Tests for the new checkout flow", "doing", 4),
        note: "Waiting on the fixture choice",
        sessionIds: ["s-checkout"],
        needsOwner: { reason: "Waiting for your answer", sessionId: "s-checkout" },
      },
      item("copy", "Review empty-cart copy with design", "todo", 120),
      {
        ...item("deploy", "Preview deploy for QA", "blocked", 30),
        scopeAddition: { approvedAt: ago(30) },
        eta: ahead(26 * 60),
      },
    ],
    changes: [
      {
        itemId: "search",
        text: "Search results: keep filters in the URL",
        from: "doing",
        to: "done",
        at: ago(60),
      },
      {
        itemId: "tests",
        text: "Tests for the new checkout flow",
        from: "doing",
        to: "doing",
        needsOwner: true,
        at: ago(4),
      },
      { itemId: "deploy", text: "Preview deploy for QA", from: null, to: "blocked", at: ago(30) },
      {
        itemId: "copy",
        text: "Review empty-cart copy with design",
        textBefore: "Review cart copy",
        from: "todo",
        to: "todo",
        at: ago(25 * 60),
      },
    ],
    updatedAt: ago(4),
  },
  {
    projectId: "p-billing",
    // Asked before the export started, so the request's copy is older than the items.
    pending: {
      id: "cp-billing-1",
      kind: "approve",
      inboxItemId: "checklist-approval:cp-billing-1",
      requestedAt: ago(40),
      reason: "The billing plan is ready to lock",
      diff: [
        {
          itemId: "webhooks",
          text: "Retry failed Stripe webhooks with backoff",
          from: null,
          to: "doing",
        },
        { itemId: "export", text: "CSV export of invoices", from: null, to: "todo" },
        { itemId: "audit", text: "Audit log for refunds", from: null, to: "todo" },
      ],
    },
    items: [
      item("webhooks", "Retry failed Stripe webhooks with backoff", "done", 240),
      {
        ...item("export", "CSV export of invoices", "doing", 25),
        eta: ahead(180),
        needsOwner: { reason: "Choose the CSV columns" },
      },
      item("audit", "Audit log for refunds", "todo", 300),
    ],
    changes: [
      {
        itemId: "webhooks",
        text: "Retry failed Stripe webhooks with backoff",
        from: "doing",
        to: "done",
      },
    ],
    updatedAt: ago(25),
  },
];

/** The server's id prefix for checklist owner cards, which the mock decides like the server. */
export const CHECKLIST_CARD_PREFIX = "checklist-approval:";

/**
 * Applies (resolved) or drops (dismissed) a checklist's pending proposal, like the server's
 * decision: an approval locks the list, an expansion applies its diff (additions to an approved
 * list are scope additions carrying their proposed ETA and owner ask, text-only edits keep the
 * live status and an explicit transition applies its proposed status).
 */
export function decideChecklist(
  checklist: ProjectChecklist,
  status: "resolved" | "dismissed",
  now: string,
): ProjectChecklist {
  const { pending, ...rest } = checklist;
  const next: ProjectChecklist = { ...rest, updatedAt: now };
  if (!pending || status === "dismissed") return next;
  if (pending.kind === "approve") return { ...next, state: "approved", approvedAt: now };
  const meta = new Map(pending.additionMetadata?.map((m) => [m.id, m]));
  const byId = new Map(next.items.map((i) => [i.id, i]));
  const added = new Set<string>();
  const changes: ChecklistChange[] = [];
  for (const change of pending.diff) {
    const { itemId, text, from, to } = change;
    const existing = byId.get(itemId);
    if (to === null) byId.delete(itemId);
    else if (from === null) {
      const m = meta.get(itemId);
      added.add(itemId);
      // The proposed owner ask applies as proposed: never with a tracking source.
      const needsOwner = m?.needsOwner && {
        reason: m.needsOwner.reason,
        ...(m.needsOwner.sessionId ? { sessionId: m.needsOwner.sessionId } : {}),
      };
      byId.set(itemId, {
        id: itemId,
        text,
        status: to,
        updatedAt: now,
        ...(m?.eta ? { eta: m.eta } : {}),
        ...(needsOwner ? { needsOwner } : {}),
        ...(next.state === "approved" ? { scopeAddition: { approvedAt: now } } : {}),
        ...(pending.startPurpose ? { startPurpose: pending.startPurpose } : {}),
      });
    } else if (existing) {
      // Like the server: a text-only edit keeps the live status; a proposed transition applies.
      const status = from !== to ? to : existing.status;
      byId.set(itemId, { ...existing, text, status, updatedAt: now });
    }
    // The change records the status the item ends with; a new owner ask is its own change.
    changes.push({
      ...change,
      from: existing?.status ?? from,
      to: existing && to !== null ? (byId.get(itemId)?.status ?? to) : to,
      at: now,
    });
    if (!existing && to !== null && byId.get(itemId)?.needsOwner)
      changes.push({ itemId, text, from: to, to, at: now, needsOwner: true });
  }
  return {
    ...next,
    items: placeAdditions([...byId.values()], added, pending.order ?? []),
    changes: changes.slice(0, 20),
  };
}

/**
 * The items in the order approval leaves them, like the server: the existing items keep their
 * current order, and each addition goes right after its nearest earlier existing neighbour in
 * the proposed `order` (else before its nearest later one, else at the end).
 */
export function placeAdditions(
  items: readonly ChecklistItem[],
  added: ReadonlySet<string>,
  order: readonly string[],
): ChecklistItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const pending = new Set([...added].filter((id) => byId.has(id)));
  const current = items.map((i) => i.id).filter((id) => !pending.has(id));
  for (const [index, id] of order.entries()) {
    if (!pending.has(id)) continue;
    const previous = order.slice(0, index).findLast((other) => current.includes(other));
    const following = order.slice(index + 1).find((other) => current.includes(other));
    const position =
      previous !== undefined
        ? current.indexOf(previous) + 1
        : following !== undefined
          ? current.indexOf(following)
          : current.length;
    current.splice(position, 0, id);
    pending.delete(id);
  }
  return [...current, ...pending].flatMap((id) => byId.get(id) ?? []);
}

/** The closed owner card a checklist decision returns (`Superseded` when nothing waited on it). */
export function closedChecklistCard(
  itemId: string,
  checklist: ProjectChecklist | undefined,
  status: "resolved" | "dismissed",
  now: string,
): InboxItem {
  const pending = checklist?.pending;
  return {
    id: itemId,
    kind: "checklist_approval",
    status: pending ? status : "dismissed",
    priority: "normal",
    notify: "needs_you",
    title: pending?.kind === "approve" ? "Approve the checklist" : "Expand the checklist",
    body: pending?.reason ?? null,
    projectId: checklist?.projectId ?? null,
    sessionId: null,
    threadId: null,
    itemId: pending?.id ?? null,
    requestId: null,
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: pending?.requestedAt ?? now,
    updatedAt: now,
    resolvedAt: now,
    resolution: pending ? null : { note: "Superseded" },
  };
}
