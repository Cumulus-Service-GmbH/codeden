import { createHash, randomUUID } from "node:crypto";
import {
  type ChecklistChange,
  type ChecklistItem,
  type ChecklistProposal,
  type ChecklistStatus,
  type InboxItem,
  type NewEvent,
  ProjectChecklist,
  ReviewedChecklistPlan,
  type Session,
} from "@codeden/contracts";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projectChecklists, projects, sessions } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { closedItem, InboxService } from "../inbox-service";

type ItemMetadata = {
  note?: string;
  eta?: string | null;
  needsOwner?: ChecklistItem["needsOwner"] | null;
};
type ReplaceItem = Pick<ChecklistItem, "text"> &
  Partial<Pick<ChecklistItem, "id" | "status">> &
  ItemMetadata;
type PatchItem = Pick<ChecklistItem, "id"> &
  Partial<Pick<ChecklistItem, "text" | "status">> &
  ItemMetadata;
type ChecklistUpdate = { items: ReplaceItem[] } | { patch?: PatchItem[]; remove?: string[] };

export const CHECKLIST_CARD_ID_PREFIX = "checklist-approval:";

export const WAITING_FOR_OWNER = "Waiting for your answer";

export function normalizeChecklistPurpose(purpose: string): string {
  return purpose.replace(/[\r\n]+/g, " ").trim();
}

export function sameChecklistPurpose(left: string, right: string): boolean {
  return (
    normalizeChecklistPurpose(left).toLowerCase() === normalizeChecklistPurpose(right).toLowerCase()
  );
}

export class ChecklistService {
  private readonly linkReservations = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
    private readonly inbox = new InboxService(db, store, () => async () => {}),
    private readonly notifyPm?: (projectId: string, message: string) => void,
  ) {}

  list(): ProjectChecklist[] {
    return this.db
      .select({ checklist: projectChecklists.checklist })
      .from(projectChecklists)
      .all()
      .map((row) => row.checklist);
  }

  projectIds(): string[] {
    return this.db
      .select({ id: projects.id })
      .from(projects)
      .all()
      .map(({ id }) => id);
  }

  get(projectId: string): ProjectChecklist | undefined {
    return this.db
      .select({ checklist: projectChecklists.checklist })
      .from(projectChecklists)
      .where(eq(projectChecklists.projectId, projectId))
      .get()?.checklist;
  }

  update(
    projectId: string,
    op: ChecklistUpdate,
    options: { requestApproval?: boolean; reason?: string; replacePending?: boolean } = {},
  ): ProjectChecklist {
    const project = this.db
      .select({ archivedAt: projects.archivedAt, name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!project) throw notFound("Project not found");
    if (project.archivedAt !== null) throw badRequest("Project is archived");

    const previous = this.get(projectId);
    const updatedAt = new Date().toISOString();
    const current = previous ?? { projectId, items: [], changes: [], updatedAt };
    const oldItems = current.items;
    const oldById = new Map(oldItems.map((item) => [item.id, item]));
    const makeItem = (
      id: string,
      text: string,
      status: ChecklistStatus,
      metadata: ItemMetadata,
    ): ChecklistItem => {
      const old = oldById.get(id);
      const next = { ...old, id, text, status, updatedAt, ...itemMetadata(old, metadata) };
      return old?.text === text && sameProgress(old, next) ? old : next;
    };

    let items: ChecklistItem[];
    if ("items" in op) {
      items = op.items.map(({ id, text, status, ...metadata }) =>
        makeItem(
          id ?? randomUUID(),
          text,
          status ?? (id ? oldById.get(id)?.status : undefined) ?? "todo",
          metadata,
        ),
      );
    } else {
      const next = new Map(oldById);
      const patched = new Set<string>();
      for (const { id, text, status, ...metadata } of op.patch ?? []) {
        if (patched.has(id)) throw badRequest(`Duplicate checklist item id: ${id}`);
        patched.add(id);
        const old = oldById.get(id);
        const nextText = text ?? old?.text;
        if (nextText === undefined) throw badRequest(`New checklist item ${id} needs text`);
        next.set(id, makeItem(id, nextText, status ?? old?.status ?? "todo", metadata));
      }
      for (const id of op.remove ?? []) next.delete(id);
      items = [...next.values()];
    }

    const nextById = new Map(items.map((item) => [item.id, item]));
    const itemOrder = new Map(items.map((item, index) => [item.id, index]));
    if (nextById.size !== items.length) throw badRequest("Duplicate checklist item ids");
    const changed =
      items.length !== oldItems.length || items.some((item, index) => item !== oldItems[index]);
    if (
      (current.plan || current.pending?.plan) &&
      (options.requestApproval ||
        items.length !== oldItems.length ||
        items.some(
          (item, index) => item.id !== oldItems[index]?.id || item.text !== oldItems[index]?.text,
        ))
    )
      throw conflict("Submit a reviewed plan revision to change the checklist scope");
    if (!changed && !options.requestApproval) return current;
    const next = ProjectChecklist.parse({ ...current, items, updatedAt });
    const progressChanges: ChecklistChange[] = [];
    const structural: ChecklistChange[] = [];
    const liveItems = new Map<string, ChecklistItem>();
    const additionMetadata: NonNullable<ChecklistProposal["additionMetadata"]> = [];
    for (const item of items) {
      const { id, text, status, note, eta, needsOwner } = item;
      const old = oldById.get(id);
      if (!old) {
        structural.push({ itemId: id, text, from: null, to: status, at: updatedAt });
        if (note !== undefined || eta !== undefined || needsOwner !== undefined) {
          additionMetadata.push({ id, note, eta, needsOwner });
        }
      } else {
        if (old.text !== text) {
          if (old.startPurpose !== undefined) {
            const purpose = normalizeChecklistPurpose(text);
            if (!purpose || purpose.length > 300) {
              throw badRequest("Reword this item using a start purpose of 1 to 300 characters");
            }
          }
          structural.push({
            itemId: id,
            text,
            textBefore: old.text,
            from: status,
            to: status,
            at: updatedAt,
          });
        }
        if (!sameProgress(old, item)) liveItems.set(id, { ...item, text: old.text });
      }
      progressChanges.push(...itemChanges(old, item, old?.text ?? text, updatedAt));
    }
    for (const { id, text, status } of oldItems) {
      if (!nextById.has(id)) {
        structural.push({ itemId: id, text, from: status, to: null, at: updatedAt });
      }
    }

    if (current.state === "approved") {
      if (!structural.length) {
        return changed ? this.save({ ...next, changes: progressChanges.slice(0, 20) }) : current;
      }
      if (current.pending && !options.replacePending) throw pendingConflict(current.pending);

      const live = liveItems.size
        ? {
            ...current,
            items: oldItems.map((item) => liveItems.get(item.id) ?? item),
            changes: progressChanges.filter(({ itemId }) => oldById.has(itemId)).slice(0, 20),
            updatedAt,
          }
        : current;
      return this.propose(live, project.name, "expand", structural, {
        reason: options.reason,
        order: items.map(({ id }) => id),
        ...(additionMetadata.length ? { additionMetadata } : {}),
      });
    }

    const { pending, ...draft } = next;
    const checklist = {
      ...draft,
      state: "draft" as const,
      changes: changed
        ? [...progressChanges, ...structural]
            .sort(
              (a, b) =>
                (itemOrder.get(a.itemId) ?? items.length) -
                (itemOrder.get(b.itemId) ?? items.length),
            )
            .slice(0, 20)
        : current.changes,
      ...(pending && !structural.length ? { pending } : {}),
    };
    if (options.requestApproval) {
      const diff = items.map(({ id, text, status }) => ({
        itemId: id,
        text,
        from: null,
        to: status,
      }));
      return this.propose({ ...checklist, pending }, project.name, "approve", diff, {
        reason: options.reason,
      });
    }
    const superseded = structural.length ? this.supersede(pending, updatedAt) : [];
    const saved = this.save(checklist, superseded);
    if (superseded.length) this.notifySuperseded(projectId, pending);
    return saved;
  }

  proposePlan(projectId: string, input: ReviewedChecklistPlan): ProjectChecklist {
    const plan = ReviewedChecklistPlan.parse(input);
    const tasks = plan.tasks.map(({ id, text }) => ({ id, text }));
    if (createHash("sha256").update(JSON.stringify(tasks)).digest("hex") !== plan.sha) {
      throw badRequest("Reviewed SHA does not match the plan tasks");
    }
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (byId.size !== tasks.length) throw badRequest("Duplicate plan task IDs");
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw notFound("Project not found");
    if (project.archivedAt !== null) throw badRequest("Project is archived");
    const current = this.get(projectId) ?? {
      projectId,
      items: [],
      changes: [],
      updatedAt: new Date().toISOString(),
    };
    if (current.plan?.sha === plan.sha || current.pending?.plan?.sha === plan.sha) return current;
    const previous = new Map(current.items.map((item) => [item.id, item]));
    const diff: ChecklistChange[] = [];
    for (const { id, text } of tasks) {
      const old = previous.get(id);
      if (old?.text !== text) {
        diff.push({
          itemId: id,
          text,
          textBefore: old?.text,
          from: old?.status ?? null,
          to: old?.status ?? "todo",
        });
      }
    }
    for (const old of current.items) {
      if (!byId.has(old.id))
        diff.push({ itemId: old.id, text: old.text, from: old.status, to: null });
    }
    return this.propose(current, project.name, current.plan ? "expand" : "approve", diff, { plan });
  }

  setEnforce(projectId: string, enforce: boolean): ProjectChecklist {
    const checklist = this.get(projectId);
    if (checklist?.state !== "approved")
      throw conflict("Approve the checklist before changing enforcement");
    if (checklist.plan && !enforce) throw conflict("A pinned plan must be enforced");
    if ((checklist.enforce ?? false) === enforce) return checklist;
    return this.save({ ...checklist, enforce, updatedAt: new Date().toISOString() });
  }

  expansionForStart(projectId: string, projectName: string, startPurpose: string): string {
    const purpose = normalizeChecklistPurpose(startPurpose);
    const checklist = this.get(projectId);
    if (!checklist) throw notFound("No checklist for this project");
    if (checklist.plan || checklist.pending?.plan)
      throw conflict("Work outside the pinned plan requires a reviewed revision");
    const pending = checklist.pending;
    if (
      pending?.startPurpose !== undefined &&
      sameChecklistPurpose(pending.startPurpose, purpose) &&
      pending.diff[0]
    ) {
      return pending.diff[0].itemId;
    }
    if (checklist.state === "approved" && pending) throw pendingConflict(pending);
    if (checklist.items.length >= 200)
      throw conflict("The approved checklist already has 200 items");
    const id = randomUUID();
    this.propose(
      checklist,
      projectName,
      "expand",
      [{ itemId: id, text: purpose, from: null, to: "todo" }],
      { startPurpose: purpose },
    );
    return id;
  }

  decide(inboxItemId: string, status: "resolved" | "dismissed"): InboxItem {
    const card = this.inbox.get(inboxItemId);
    if (card.kind !== "checklist_approval") throw badRequest("Expected a checklist approval card");
    const checklist = card.projectId ? this.get(card.projectId) : undefined;
    const pending = checklist?.pending;
    const updatedAt = new Date().toISOString();
    if (card.status !== "open") {
      if (checklist && pending?.inboxItemId === card.id) {
        this.save({ ...checklist, pending: undefined, updatedAt });
      }
      return card;
    }
    if (!checklist || !pending || pending.id !== card.itemId || pending.inboxItemId !== card.id) {
      const closed = closedItem(card, "dismissed", { note: "Superseded" }, updatedAt);
      this.store.append([this.cardEvent("inbox.updated", closed)]);
      return closed;
    }

    const { pending: _, ...current } = checklist;
    const next = { ...current, updatedAt };
    if (status === "resolved") {
      if (pending.plan) {
        const previous = new Map(next.items.map((item) => [item.id, item]));
        next.plan = pending.plan;
        next.state = "approved";
        next.enforce = true;
        next.approvedAt = updatedAt;
        next.items = pending.plan.tasks.map(({ id, text }) => {
          const old = previous.get(id);
          if (old?.text === text) return { ...old, startPurpose: text };
          if (old) return { ...old, text, startPurpose: text, updatedAt };
          const scopeAddition =
            current.state === "approved" ? { approvedAt: updatedAt } : undefined;
          return { id, text, startPurpose: text, status: "todo", updatedAt, scopeAddition };
        });
        const approved = new Map(next.items.map((item) => [item.id, item]));
        next.changes = pending.diff.slice(0, 20).map((change) => ({
          ...change,
          from: previous.get(change.itemId)?.status ?? null,
          to: approved.get(change.itemId)?.status ?? null,
          at: updatedAt,
        }));
      } else if (pending.kind === "approve") {
        next.state = "approved";
        next.approvedAt = updatedAt;
      } else {
        const items = new Map(next.items.map((item) => [item.id, item]));
        const changes: ChecklistChange[] = [];
        const addedIds = new Set<string>();
        const additionMetadata = new Map(
          pending.additionMetadata?.map((entry) => [entry.id, entry]),
        );
        for (const change of pending.diff) {
          const { itemId, text, from, to } = change;
          const item = items.get(itemId);
          if (to === null) items.delete(itemId);
          else if (from === null) {
            addedIds.add(itemId);
            items.set(itemId, {
              id: itemId,
              text,
              status: to,
              updatedAt,
              ...itemMetadata(undefined, additionMetadata.get(itemId) ?? {}),
              ...(current.state === "approved" ? { scopeAddition: { approvedAt: updatedAt } } : {}),
              ...(pending.startPurpose === undefined ? {} : { startPurpose: pending.startPurpose }),
            });
          } else if (item) {
            items.set(itemId, {
              ...item,
              text,
              updatedAt,
              ...(item.startPurpose === undefined
                ? {}
                : { startPurpose: normalizeChecklistPurpose(text) }),
            });
          }
          changes.push({
            ...change,
            from: item?.status ?? from,
            to: item && to !== null ? item.status : to,
            at: updatedAt,
          });
          if (!item && to !== null) {
            const added = items.get(itemId);
            if (added) changes.push(...itemChanges(undefined, added, text, updatedAt));
          }
        }
        next.items = insertApprovedItems(items, addedIds, pending.order ?? []);
        next.changes = changes.slice(0, 20);
      }
    }
    const closed = closedItem(card, status, null, updatedAt);
    this.save(next, [this.cardEvent("inbox.updated", closed)]);
    if (pending.startPurpose) {
      this.notifyPm?.(
        next.projectId,
        status === "resolved"
          ? `Checklist expansion approved for "${pending.startPurpose}". Start again with checklistItemId ${pending.diff[0]?.itemId}.`
          : `Checklist expansion for "${pending.startPurpose}" was not approved.`,
      );
    }
    return closed;
  }

  updateItem(
    projectId: string,
    itemId: string,
    change: { status?: ChecklistStatus } & ItemMetadata,
    caller: Pick<Session, "id" | "parentSessionId" | "role">,
  ): ProjectChecklist {
    const checklist = this.get(projectId);
    const item = checklist?.items.find((entry) => entry.id === itemId);
    if (!checklist || !item) throw notFound("Checklist item not found");
    if (caller.role !== "pm" && (caller.role !== "agent" || !checklistLinked(item, caller))) {
      throw forbidden("Your session is not linked to this checklist item");
    }
    return this.changeItems(checklist, [item], (entry) => ({
      ...entry,
      status: change.status ?? entry.status,
      ...itemMetadata(entry, change),
    }));
  }

  reserveLink(projectId: string, item: ChecklistItem): (() => void) | undefined {
    const key = JSON.stringify([projectId, item.id]);
    const reserved = this.linkReservations.get(key) ?? 0;
    const ids = item.sessionIds ?? [];
    if (ids.length + reserved >= 200 && this.activeLinks(ids).size + reserved >= 200) {
      return;
    }
    this.linkReservations.set(key, reserved + 1);
    return () => {
      const count = this.linkReservations.get(key) ?? 0;
      if (count <= 1) this.linkReservations.delete(key);
      else this.linkReservations.set(key, count - 1);
    };
  }

  private activeLinks(ids: string[]): Set<string> {
    const rows = this.db
      .select({ id: sessions.id, status: sessions.status, archivedAt: sessions.archivedAt })
      .from(sessions)
      .where(inArray(sessions.id, ids))
      .all();
    return new Set(
      rows
        .filter(
          ({ status, archivedAt }) =>
            !archivedAt && status !== "completed" && status !== "failed" && status !== "stopped",
        )
        .map(({ id }) => id),
    );
  }

  link(projectId: string, itemId: string, session: Session): boolean {
    const checklist = this.get(projectId);
    const item = checklist?.items.find((entry) => entry.id === itemId);
    if (!checklist || !item || session.projectId !== projectId) return false;
    let sessionIds = item.sessionIds ?? [];
    if (!sessionIds.includes(session.id)) {
      if (sessionIds.length >= 200) {
        const active = this.activeLinks(sessionIds);
        const oldest = sessionIds.findIndex((id) => !active.has(id));
        if (oldest === -1) return false;
        sessionIds = sessionIds.filter((_, index) => index !== oldest);
      }
      sessionIds = [...sessionIds, session.id];
    }
    const status = checklistWorkStatus(session);
    this.changeItems(checklist, [item], (entry) => ({
      ...entry,
      status: workStatus(entry, status),
      sessionIds,
      ...(session.status === "waiting" && !session.archivedAt && !entry.needsOwner
        ? { needsOwner: { reason: WAITING_FOR_OWNER, sessionId: session.id, source: "work" } }
        : {}),
    }));
    return true;
  }

  markWork(
    session: Session,
    status: ChecklistStatus | undefined,
    itemId?: string,
    waiting?: boolean,
  ): boolean {
    const checklist = session.projectId ? this.get(session.projectId) : undefined;
    const linked = checklist?.items.filter(
      (item) => (itemId === undefined || item.id === itemId) && checklistLinked(item, session),
    );
    if (!checklist || !linked?.length) return false;
    this.changeItems(checklist, linked, (item) => {
      const next = { ...item, status: workStatus(item, status) };
      if (waiting === true && !item.needsOwner) {
        next.needsOwner = { reason: WAITING_FOR_OWNER, sessionId: session.id, source: "work" };
      }
      if (
        waiting === false &&
        item.needsOwner?.sessionId === session.id &&
        item.needsOwner.source === "work"
      ) {
        const ids = item.sessionIds ?? [];
        const replacement = this.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.projectId, checklist.projectId),
              eq(sessions.status, "waiting"),
              ne(sessions.id, session.id),
              isNull(sessions.archivedAt),
              or(inArray(sessions.id, ids), inArray(sessions.parentSessionId, ids)),
            ),
          )
          .orderBy(sessions.id)
          .get();
        next.needsOwner = replacement
          ? { reason: WAITING_FOR_OWNER, sessionId: replacement.id, source: "work" }
          : undefined;
      }
      return next;
    });
    return true;
  }

  private changeItems(
    checklist: ProjectChecklist,
    selected: ChecklistItem[],
    change: (item: ChecklistItem) => ChecklistItem,
  ): ProjectChecklist {
    const changes: ChecklistChange[] = [];
    const updatedAt = new Date().toISOString();
    const items = checklist.items.map((item) => {
      if (!selected.includes(item)) return item;
      const next = change(item);
      if (sameProgress(item, next)) return item;
      changes.push(...itemChanges(item, next, item.text, updatedAt));
      return { ...next, updatedAt };
    });
    return items.some((item, index) => item !== checklist.items[index])
      ? this.save({ ...checklist, items, changes: changes.slice(0, 20), updatedAt })
      : checklist;
  }

  private propose(
    checklist: ProjectChecklist,
    projectName: string,
    kind: ChecklistProposal["kind"],
    diff: ChecklistChange[],
    details: Pick<
      ChecklistProposal,
      "reason" | "startPurpose" | "order" | "additionMetadata" | "plan"
    >,
  ): ProjectChecklist {
    const requestedAt = new Date().toISOString();
    const pending = {
      id: randomUUID(),
      kind,
      diff: diff.map((change) => ({ ...change, at: requestedAt })),
      inboxItemId: `${CHECKLIST_CARD_ID_PREFIX}${randomUUID()}`,
      requestedAt,
      ...details,
    };
    const { reason } = details;
    const title = details.plan
      ? "Approve the reviewed plan"
      : kind === "approve"
        ? "Approve the checklist"
        : "Expand the checklist";
    const lines = diff.map(({ from, to, text, textBefore }) => {
      if (from === null) return `+ ${text}`;
      if (to === null) return `- ${text}`;
      return `~ ${textBefore} → ${text}`;
    });
    const card: InboxItem = {
      id: pending.inboxItemId,
      kind: "checklist_approval",
      status: "open",
      priority: "normal",
      notify: "needs_you",
      title: `${title}: ${projectName}`,
      body: [...lines, ...(reason ? ["", reason] : [])].join("\n"),
      projectId: checklist.projectId,
      itemId: pending.id,
      sessionId: null,
      threadId: null,
      requestId: null,
      issue: null,
      pr: null,
      automationRunId: null,
      createdAt: requestedAt,
      updatedAt: requestedAt,
      resolvedAt: null,
      resolution: null,
    };
    const superseded = this.supersede(checklist.pending, requestedAt);
    const saved = this.save({ ...checklist, pending, updatedAt: requestedAt }, [
      ...superseded,
      this.cardEvent("inbox.created", card),
    ]);
    if (superseded.length) this.notifySuperseded(checklist.projectId, checklist.pending);
    return saved;
  }

  private notifySuperseded(projectId: string, pending: ChecklistProposal | undefined): void {
    if (pending?.startPurpose !== undefined) {
      this.notifyPm?.(
        projectId,
        `Checklist expansion for "${pending.startPurpose}" was superseded (card ${pending.inboxItemId}).`,
      );
    }
  }

  private supersede(pending: ChecklistProposal | undefined, at: string): NewEvent[] {
    const card = pending && this.inbox.find(pending.inboxItemId);
    return card?.status === "open"
      ? [this.cardEvent("inbox.updated", closedItem(card, "dismissed", { note: "Superseded" }, at))]
      : [];
  }

  private cardEvent(type: "inbox.created" | "inbox.updated", item: InboxItem): NewEvent {
    return { type, sessionId: null, payload: { item } };
  }

  private save(value: ProjectChecklist, events: NewEvent[] = []): ProjectChecklist {
    const checklist = ProjectChecklist.parse(value);
    this.store.append([
      { type: "checklist.updated", sessionId: null, payload: { checklist } },
      ...events,
    ]);
    return checklist;
  }
}

function insertApprovedItems(
  items: Map<string, ChecklistItem>,
  addedIds: Set<string>,
  proposedOrder: string[],
): ChecklistItem[] {
  const current = [...items.keys()].filter((id) => !addedIds.has(id));
  for (const [index, id] of proposedOrder.entries()) {
    if (!addedIds.has(id)) continue;
    const previous = proposedOrder.slice(0, index).findLast((id) => current.includes(id));
    const next = proposedOrder.slice(index + 1).find((id) => current.includes(id));
    const position =
      previous !== undefined
        ? current.indexOf(previous) + 1
        : next !== undefined
          ? current.indexOf(next)
          : current.length;
    current.splice(position, 0, id);
    addedIds.delete(id);
  }
  return [...current, ...addedIds].flatMap((id) => {
    const item = items.get(id);
    return item ? [item] : [];
  });
}

function itemMetadata(old: ChecklistItem | undefined, patch: ItemMetadata) {
  const note = patch.note ?? old?.note;
  const eta = patch.eta === undefined ? old?.eta : (patch.eta ?? undefined);
  let needsOwner = old?.needsOwner;
  if (patch.needsOwner !== undefined) {
    needsOwner = undefined;
    if (patch.needsOwner) {
      const { source: _source, ...manual } = patch.needsOwner;
      needsOwner = manual;
    }
  }
  return {
    ...(note !== undefined ? { note } : {}),
    ...(eta !== undefined || old?.eta !== undefined ? { eta } : {}),
    ...(needsOwner !== undefined || old?.needsOwner !== undefined ? { needsOwner } : {}),
  };
}

function sameProgress(old: ChecklistItem, next: ChecklistItem): boolean {
  return (
    old.status === next.status &&
    old.note === next.note &&
    old.sessionIds === next.sessionIds &&
    old.eta === next.eta &&
    old.needsOwner?.reason === next.needsOwner?.reason &&
    old.needsOwner?.sessionId === next.needsOwner?.sessionId &&
    old.needsOwner?.source === next.needsOwner?.source
  );
}

function itemChanges(
  old: ChecklistItem | undefined,
  next: ChecklistItem,
  text: string,
  at: string,
): ChecklistChange[] {
  const { id: itemId, status: to } = next;
  const changes: ChecklistChange[] = [];
  if (old && old.status !== to) changes.push({ itemId, text, from: old.status, to, at });
  if (!old?.needsOwner && next.needsOwner) {
    changes.push({ itemId, text, from: to, to, at, needsOwner: true });
  }
  return changes;
}

function pendingConflict(pending: ChecklistProposal) {
  return conflict(
    `Checklist card ${pending.inboxItemId} is already open. Wait for the owner to decide.`,
  );
}

export function checklistLinked(
  item: ChecklistItem,
  session: Pick<Session, "id" | "parentSessionId">,
): boolean {
  return (
    item.sessionIds?.some((id) => id === session.id || id === session.parentSessionId) ?? false
  );
}

export function checklistWorkStatus(session: Session): ChecklistStatus | undefined {
  if (session.archivedAt) return;
  if (session.status === "failed") return "blocked";
  switch (session.result?.outcome) {
    case "success":
      return "done";
    case "failed":
    case "blocked":
      return "blocked";
    case "partial":
      return "doing";
  }
  if (session.status === "starting" || session.status === "running") return "doing";
  if (session.status === "completed") return "done";
}

function workStatus(item: ChecklistItem, status: ChecklistStatus | undefined): ChecklistStatus {
  return status === undefined || (item.status === "done" && status === "doing")
    ? item.status
    : status;
}

/** Render the same progress and item IDs for the orchestrator and the PM. */
export function formatChecklist(
  checklist: ProjectChecklist | undefined,
  caller?: Pick<Session, "id" | "parentSessionId">,
): string {
  const items = checklist?.items ?? [];
  const done = items.filter((item) => item.status === "done").length;
  const percent = items.length ? Math.round((done / items.length) * 100) : 0;
  return [
    `${done}/${items.length} done · ${percent}%`,
    ...items.map((item) => {
      const { id, text, status } = item;
      const linked = caller && checklistLinked(item, caller) ? " · linked to your session" : "";
      return `- [${status}] ${text} (${id})${linked}`;
    }),
  ].join("\n");
}
