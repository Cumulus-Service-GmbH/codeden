import { DiskHygieneCommand } from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { jsonBody } from "./validate";

/** Local Settings controls and the last built-in automation report. */
export function diskHygieneRoutes(s: AppServices) {
  return new Hono()
    .get("/", (c) => c.json(s.diskHygiene.status()))
    .post("/", jsonBody(DiskHygieneCommand), async (c) =>
      c.json(await s.diskHygiene.command(c.req.valid("json"))),
    );
}
