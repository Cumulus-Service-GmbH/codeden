import {
  resolveTeam,
  type StartSessionRequest,
  TEAM_ROLE_TAGS,
  type Team,
  teamMember,
} from "@codeden/contracts";

/**
 * A start with a Team role (the composer's Team choice): the title gets the role's tag, and a
 * provider, model or effort the request leaves unset comes from the resolved Team (the project's
 * Team, then the default Team). What the user set explicitly wins: it is the session's own choice.
 */
export function withTeamRole(
  req: StartSessionRequest,
  teams: { defaults: Team; project: Team },
): StartSessionRequest {
  if (!req.teamRole) return req;
  const tag = Object.keys(TEAM_ROLE_TAGS).find((t) => TEAM_ROLE_TAGS[t] === req.teamRole);
  if (!tag) return req;
  const base = req.title ?? req.purpose ?? "Work";
  const title = (base.startsWith(tag) ? base : `${tag} ${base}`).slice(0, 200);
  const member = teamMember(resolveTeam(teams).team, req.teamRole);
  const unsetProvider = !req.provider || req.provider === "auto";
  return {
    ...req,
    title,
    ...(member && unsetProvider ? { provider: member.provider } : {}),
    ...(member && unsetProvider && !req.model && member.model ? { model: member.model } : {}),
    ...(member && unsetProvider && !req.effort && member.effort ? { effort: member.effort } : {}),
  };
}
