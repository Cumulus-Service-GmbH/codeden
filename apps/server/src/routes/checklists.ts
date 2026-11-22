import { SetChecklistEnforceRequest } from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { jsonBody } from "./validate";

export function checklistRoutes(s: AppServices) {
  return new Hono().put("/:projectId/enforce", jsonBody(SetChecklistEnforceRequest), (c) =>
    c.json(s.checklist.setEnforce(c.req.param("projectId"), c.req.valid("json").enforce)),
  );
}
