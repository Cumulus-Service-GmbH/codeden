import {
  DismissInboxRequest,
  type InboxCounts,
  inboxKindVisible,
  ListInboxQuery,
  ResolveInboxRequest,
  RestoreInboxRequest,
  SnapshotQuery,
} from "@codeden/contracts";
import { Hono } from "hono";
import { CHECKLIST_CARD_ID_PREFIX } from "../services/checklist/checklist-service";
import type { AppServices } from "../services/container";
import { retryRunFailed } from "../services/inbox-retry";
import { asUserResponse } from "./user-response";
import { jsonBody, queryOf } from "./validate";

/**
 * `/api/inbox`: list, counts, resolve in place, retry a failed run, bulk dismiss and its undo
 * (§11.1).
 */
export function inboxRoutes(s: AppServices) {
  return new Hono()
    .get("/", queryOf(ListInboxQuery), (c) => {
      const { capabilities, ...query } = c.req.valid("query");
      const declared = capabilities?.split(",") ?? [];
      return c.json(s.inbox.list(query).filter(({ kind }) => inboxKindVisible(kind, declared)));
    })
    .get("/counts", queryOf(SnapshotQuery), (c) => {
      const capabilities = c.req.valid("query").capabilities?.split(",") ?? [];
      if (inboxKindVisible("checklist_approval", capabilities)) return c.json(s.inbox.counts());
      const counts: InboxCounts = { open: 0, byProject: {}, byKind: {} };
      for (const { kind, projectId } of s.inbox.list({ status: "open" })) {
        if (!inboxKindVisible(kind, capabilities)) continue;
        counts.open++;
        if (projectId) counts.byProject[projectId] = (counts.byProject[projectId] ?? 0) + 1;
        counts.byKind[kind] = (counts.byKind[kind] ?? 0) + 1;
      }
      return c.json(counts);
    })
    .get("/decision-cards", (c) => c.json(s.decisions.pending()))
    .post("/decision-cards/:id/approve", async (c) => {
      await s.decisions.confirm(c.req.param("id"), {
        role: "owner",
        projectId: null,
        sessionId: null,
      });
      return c.json({ approved: true });
    })
    .post("/dismiss", jsonBody(DismissInboxRequest), (c) => {
      const { ids, filter, note } = c.req.valid("json");
      const scope = ids ? { ids } : { filter: filter ?? {} };
      return c.json(s.inbox.dismissMany(scope, note));
    })
    .post("/restore", jsonBody(RestoreInboxRequest), (c) =>
      c.json(s.inbox.restoreMany(c.req.valid("json").ids)),
    )
    .get("/:id", (c) => c.json(s.inbox.get(c.req.param("id"))))
    .post("/:id/resolve", jsonBody(ResolveInboxRequest), async (c) => {
      const body = c.req.valid("json");
      const id = c.req.param("id");
      if (id.startsWith(CHECKLIST_CARD_ID_PREFIX)) {
        return c.json(s.checklist.decide(id, body.status));
      }
      const req = body.response ? { ...body, response: asUserResponse(body.response) } : body;
      return c.json(await s.inbox.resolve(id, req));
    })
    .post("/:id/retry", async (c) => {
      const item = await retryRunFailed(
        {
          inbox: s.inbox,
          repo: s.sessionRepo,
          sessions: s.sessions,
          runnable: (provider) => s.factory.providerRunnableNow(provider),
        },
        c.req.param("id"),
      );
      return c.json({ item });
    });
}
