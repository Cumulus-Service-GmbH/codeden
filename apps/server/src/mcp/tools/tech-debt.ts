import { ImportTechDebtInput, RecordTechDebtInput } from "@codeden/contracts";
import { z } from "zod";
import { defineTool, type ServerToolContext, ToolError } from "../define";
import { projectFor } from "./shared/helpers";

function accessibleProject(
  input: { projectId?: string },
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

/** Record one LOW finding in the project's ledger. */
export const recordTechDebt = defineTool({
  name: "record_tech_debt",
  description:
    "Record a LOW review finding with its file, line and review receipt. Pass projectId as the orchestrator.",
  roles: ["pm", "orchestrator"],
  scope: "global",
  input: RecordTechDebtInput,
  handler: async ({ projectId, location, text, receipt }, ctx) => {
    const project = accessibleProject({ projectId }, ctx);
    return ctx.services.techDebt.act(project, {
      action: "record",
      finding: { location, text, receipt, date: new Date().toISOString(), pr: null },
    });
  },
});

/** Merge LOW checklist entries from a GitHub issue into the project's ledger. */
export const importTechDebt = defineTool({
  name: "import_tech_debt",
  description:
    "Import LOW review findings from a GitHub issue. Pass projectId as the orchestrator. A PM may use its repository or the project's tracking issue.",
  roles: ["pm", "orchestrator"],
  scope: "global",
  input: ImportTechDebtInput,
  handler: async (input, ctx) => {
    const project = accessibleProject(input, ctx);
    return ctx.services.techDebt.importIssue(project, input.issue, {
      restrictToProject: ctx.role === "pm",
    });
  },
});
