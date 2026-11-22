import {
  type ModelInfo,
  type ReasoningEffort,
  type Team,
  teamMember,
  teamRoleOfTitle,
} from "@codeden/contracts";
import { ToolError } from "../../mcp/define";

/** Apply a Team member's pins to a PM start. Models are from that member's provider. */
export function applyTeamRole(
  input: { title?: string; provider?: string; model?: string; effort?: ReasoningEffort },
  team: Team,
  models: readonly ModelInfo[],
) {
  const member = teamMember(team, teamRoleOfTitle(input.title));
  if (!member) return input;

  const resolve = (id: string) => models.find((model) => model.id === id)?.resolvedId ?? id;
  const tag = input.title?.match(/^\[[^\]]+\]/)?.[0];
  for (const field of ["provider", "model", "effort"] as const) {
    const pinned = member[field];
    const given = input[field];
    if (pinned === null || given === undefined || pinned === given) continue;
    if (field === "model" && resolve(pinned) === resolve(given)) continue;
    throw new ToolError(
      `TEAM_MISMATCH: ${tag} in this project's Team is ${member.provider} / ${member.model ?? "default"} / ${member.effort ?? "any"}; got ${field} ${given}`,
    );
  }
  return {
    ...input,
    provider: input.provider ?? member.provider,
    ...(member.model !== null ? { model: input.model ?? member.model } : {}),
    ...(member.effort !== null ? { effort: input.effort ?? member.effort } : {}),
  };
}
