import { ChildRunReport, redactAndCount, WORKER_REPORT_PATH } from "@codeden/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { McpTokenStore } from "../mcp/tokens";
import type { SessionRepo } from "../services/sessions/repo";

/** Mounted behind CodeDen's loopback-only middleware. The bearer alone selects the parent. */
export function workerReportRoute(
  tokens: McpTokenStore,
  sessions: SessionRepo,
  installToken: string,
) {
  return new Hono().post(WORKER_REPORT_PATH, bodyLimit({ maxSize: 4096 }), async (c) => {
    const token = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const sessionId = tokens.workerSession(token);
    if (!sessionId) return c.body(null, 401);
    const input: unknown = await c.req.json().catch(() => null);
    const parsed = ChildRunReport.safeParse(input);
    if (!parsed.success) return c.body(null, 400);
    const report = parsed.data;
    const text = JSON.stringify(report);
    if (redactAndCount(text, { known: [token, installToken] }).count) {
      return c.body(null, 400);
    }
    sessions.recordWorker(sessionId, report);
    return c.body(null, 204);
  });
}
