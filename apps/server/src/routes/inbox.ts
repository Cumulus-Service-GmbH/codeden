import {
  DismissInboxRequest,
  ListInboxQuery,
  ResolveInboxRequest,
  RestoreInboxRequest,
} from "@codeden/contracts";
import { Hono } from "hono";
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
    .get("/", queryOf(ListInboxQuery), (c) => c.json(s.inbox.list(c.req.valid("query"))))
    .get("/decision-cards", (c) => c.json(s.decisions.pending()))
    .post("/decision-cards/:id/approve", async (c) => {
      await s.decisions.confirm(c.req.param("id"), {
        role: "owner",
        projectId: null,
        sessionId: null,
      });
      return c.json({ approved: true });
    })
    .get("/counts", (c) => c.json(s.inbox.counts()))
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
      const req = body.response ? { ...body, response: asUserResponse(body.response) } : body;
      return c.json(await s.inbox.resolve(c.req.param("id"), req));
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
