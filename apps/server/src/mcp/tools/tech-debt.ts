import {
  ImportTechDebtCounts,
  ImportTechDebtInput,
  RecordTechDebtCounts,
  RecordTechDebtInput,
  ResolveTechDebtCounts,
  ResolveTechDebtInput,
} from "@codeden/contracts";
import { z } from "zod";
import { defineTool, type ServerToolContext, ToolError } from "../define";
import { projectFor } from "./shared/helpers";

function accessibleProject(
  input: { projectId?: string | undefined },
  { services, role, projectId }: ServerToolContext<"global">,
) {
  const id = role === "pm" ? projectId : input.projectId;
  if (!id || (role === "pm" && input.projectId && input.projectId !== id)) {
    throw new ToolError("Give an accessible project id");
  }
  return projectFor(services, id);
}

/** Read the same ledger the owner sees, scoped to the PM's project when called by a PM. */
export const listTechDebt = defineTool({
  name: "list_tech_debt",
  description:
    "List LOW review findings and their status. Pass projectId as the orchestrator. A PM always reads its own project.",
  roles: ["pm", "orchestrator"],
  scope: "global",
  input: z.strictObject({ projectId: z.string().min(1).optional() }),
  handler: async (input, ctx) => ctx.services.techDebt.list(accessibleProject(input, ctx)),
});

/** Record LOW findings in the project's ledger. */
export const recordTechDebt = defineTool({
  name: "record_tech_debt",
  description:
    "Record a LOW review finding with its file, line and receipt or pass a findings array. Returns counts only. Pass projectId as the orchestrator.",
  roles: ["pm", "orchestrator"],
  scope: "global",
  input: RecordTechDebtInput,
  handler: async (input, ctx) => {
    const project = accessibleProject(input, ctx);
    const now = new Date().toISOString();
    const rows = ("findings" in input ? input.findings : [input]).map(
      ({ location, text, receipt, date, pr }) => ({
        location,
        text,
        receipt,
        date: date ?? now,
        pr: pr ?? null,
      }),
    );
    return RecordTechDebtCounts.parse(await ctx.services.techDebt.recordMany(project, rows));
  },
});

/** Merge LOW checklist entries from a GitHub issue into the project's ledger. */
export const importTechDebt = defineTool({
  name: "import_tech_debt",
  description:
    "Import LOW review findings from a GitHub issue, ignoring case when matching duplicates. Returns counts only. Pass projectId as the orchestrator. A PM may use its repository or the project's tracking issue.",
  roles: ["pm", "orchestrator"],
  scope: "global",
  input: ImportTechDebtInput,
  handler: async (input, ctx) => {
    const project = accessibleProject(input, ctx);
    return ImportTechDebtCounts.parse(
      await ctx.services.techDebt.importCounts(project, input.issue, ctx.role === "pm"),
    );
  },
});

/** Resolve findings in the local ledger with evidence and return disposition counts. */
export const resolveTechDebt = defineTool({
  name: "resolve_tech_debt",
  description:
    "Resolve LOW findings in the local ledger as fixed or dismissed. Pass ids with a shared status, reason and receipt, or a resolutions array with those fields per id. Returns counts only. Pass projectId as the orchestrator.",
  roles: ["pm", "orchestrator"],
  scope: "global",
  input: ResolveTechDebtInput,
  handler: async (input, ctx) => {
    const project = accessibleProject(input, ctx);
    const resolutions =
      "resolutions" in input
        ? input.resolutions
        : input.ids.map((id) => ({
            id,
            status: input.status,
            reason: input.reason,
            receipt: input.receipt,
          }));
    return ResolveTechDebtCounts.parse(
      await ctx.services.techDebt.resolve(project, resolutions, ctx.sessionId),
    );
  },
});
