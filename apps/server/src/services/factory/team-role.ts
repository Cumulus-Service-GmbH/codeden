import {
  defaultTeam,
  type ModelInfo,
  type Project,
  type ReasoningEffort,
  resolveTeam,
  type Team,
  teamMember,
  teamRoleOfTitle,
} from "@codeden/contracts";
import { teamStartChoice } from "../sessions/team-start";

/** Apply a Team member's pins to a PM start. Models are from that member's provider. */
export function applyTeamRole(
  input: { title?: string; provider?: string; model?: string; effort?: ReasoningEffort },
  team: Team,
  models: readonly ModelInfo[],
) {
  const member = teamMember(team, teamRoleOfTitle(input.title));
  if (!member) return { choice: input };

  const resolve = (id: string) => models.find((model) => model.id === id)?.resolvedId ?? id;
  const tag = input.title?.match(/^\[[^\]]+\]/)?.[0];
  for (const field of ["provider", "model", "effort"] as const) {
    const pinned = member[field];
    const given = field === "provider" && input.provider === "auto" ? undefined : input[field];
    if (pinned === null || given === undefined || pinned === given) continue;
    if (field === "model" && resolve(pinned) === resolve(given)) continue;
    return {
      mismatch: `TEAM_MISMATCH: ${tag} in this project's Team is ${member.provider} / ${member.model ?? "default"} / ${member.effort ?? "any"}; got ${field} ${given}`,
    };
  }
  return { choice: teamStartChoice(input, member) };
}

/** The selected named Team, the project’s default named Team, or its factory Team. */
export function projectTeamLayer(project: Pick<Project, "teams">, tuning: Team, teamId?: string) {
  const teams = project.teams;
  return (
    teams?.teams.find(({ id }) => id === teamId)?.team ??
    teams?.teams.find(({ id }) => id === teams.defaultTeamId)?.team ??
    tuning
  );
}

/**
 * A loop's tuning with its Team resolved the way sessions resolve it: the project's Team over
 * the default Team (Settings → Team). Never saved back into the loop.
 */
export function teamTuning<T extends { team: Team }>(
  ctx: { settings: { get(): { teamSetup: { remembered: boolean; team: Team } } } },
  tuning: T,
  project: Pick<Project, "teams">,
): T {
  return {
    ...tuning,
    team: resolveTeam({
      defaults: defaultTeam(ctx.settings.get()),
      project: projectTeamLayer(project, tuning.team),
    }).team,
  };
}
