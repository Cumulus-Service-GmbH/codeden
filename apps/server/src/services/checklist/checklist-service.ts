import { randomBytes } from "node:crypto";
import { type ChecklistChange, type ChecklistItem, ProjectChecklist } from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projectChecklists, projects } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { badRequest, notFound } from "../errors";

type ReplaceItem = Pick<ChecklistItem, "text"> & Partial<Pick<ChecklistItem, "id" | "status">>;
type PatchItem = Pick<ChecklistItem, "id"> & Partial<Pick<ChecklistItem, "text" | "status">>;
type ChecklistUpdate = { items: ReplaceItem[] } | { patch?: PatchItem[]; remove?: string[] };

export class ChecklistService {
  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
  ) {}

  list(): ProjectChecklist[] {
    return this.db
      .select({ checklist: projectChecklists.checklist })
      .from(projectChecklists)
      .all()
      .map((row) => row.checklist);
  }

  get(projectId: string): ProjectChecklist | undefined {
    return this.db
      .select({ checklist: projectChecklists.checklist })
      .from(projectChecklists)
      .where(eq(projectChecklists.projectId, projectId))
      .get()?.checklist;
  }

  update(projectId: string, op: ChecklistUpdate): ProjectChecklist {
    const project = this.db
      .select({ archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!project) throw notFound("Project not found");
    if (project.archivedAt !== null) throw badRequest("Project is archived");

    const previous = this.get(projectId);
    const oldItems = previous?.items ?? [];
    const oldById = new Map(oldItems.map((item) => [item.id, item]));
    const updatedAt = new Date().toISOString();
    const makeItem = (id: string, text: string, status: ChecklistItem["status"]): ChecklistItem => {
      const old = oldById.get(id);
      return old?.text === text && old.status === status ? old : { id, text, status, updatedAt };
    };

    let items: ChecklistItem[];
    if ("items" in op) {
      items = op.items.map(({ id, text, status }) =>
        makeItem(id ?? randomBytes(9).toString("base64url"), text, status ?? "todo"),
      );
    } else {
      const next = new Map(oldById);
      const patched = new Set<string>();
      for (const { id, text, status } of op.patch ?? []) {
        if (patched.has(id)) throw badRequest(`Duplicate checklist item id: ${id}`);
        patched.add(id);
        const old = oldById.get(id);
        const nextText = text ?? old?.text;
        if (nextText === undefined) throw badRequest(`New checklist item ${id} needs text`);
        next.set(id, makeItem(id, nextText, status ?? old?.status ?? "todo"));
      }
      for (const id of op.remove ?? []) next.delete(id);
      items = [...next.values()];
    }

    const nextById = new Map(items.map((item) => [item.id, item]));
    if (nextById.size !== items.length) throw badRequest("Duplicate checklist item ids");
    if (
      items.length === oldItems.length &&
      items.every((item, index) => item === oldItems[index])
    ) {
      return previous ?? { projectId, items: [], changes: [], updatedAt };
    }

    const changes: ChecklistChange[] = [];
    for (const { id, text, status } of items) {
      const from = oldById.get(id)?.status ?? null;
      if (from !== status) changes.push({ itemId: id, text, from, to: status });
    }
    for (const { id, text, status } of oldItems) {
      if (!nextById.has(id)) changes.push({ itemId: id, text, from: status, to: null });
    }
    const checklist = ProjectChecklist.parse({
      projectId,
      items,
      changes: changes.slice(0, 20),
      updatedAt,
    });
    this.store.append([{ type: "checklist.updated", sessionId: null, payload: { checklist } }]);
    return checklist;
  }
}

/** Render the same progress and item IDs for the orchestrator and the PM. */
export function formatChecklist(checklist: ProjectChecklist | undefined): string {
  const items = checklist?.items ?? [];
  const done = items.filter((item) => item.status === "done").length;
  const percent = items.length ? Math.round((done / items.length) * 100) : 0;
  return [
    `${done}/${items.length} done · ${percent}%`,
    ...items.map(({ id, text, status }) => `- [${status}] ${text} (${id})`),
  ].join("\n");
}
