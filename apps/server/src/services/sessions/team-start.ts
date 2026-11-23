import {
  resolveTeam,
  type StartSessionRequest,
  TEAM_ROLE_TAGS,
  type Team,
  teamMember,
} from "@codeden/contracts";
import { derivePurpose } from "./conflicts";

/**
 * A start with a Team role (the composer's Team choice): the title gets the role's tag, and a
 * provider, model or effort the request leaves unset comes from the resolved Team (the project's
 * Team, then the default Team), field by field, when the provider is unset or is the member's own.
 * What the user set explicitly wins: it is the session's own choice.
 */
export function withTeamRole(
  req: StartSessionRequest,
  teams: { defaults: Team; project: Team },
): StartSessionRequest {
  if (!req.teamRole) return req;
  const tag = Object.keys(TEAM_ROLE_TAGS).find((t) => TEAM_ROLE_TAGS[t] === req.teamRole);
  if (!tag) return req;
  const base = req.title ?? derivePurpose(req.purpose, req.input?.text);
  const title = (base.startsWith(tag) ? base : `${tag} ${base}`).slice(0, 200);
  const member = teamMember(resolveTeam(teams).team, req.teamRole);
  const unsetProvider = !req.provider || req.provider === "auto";
  const fills = member && (unsetProvider || req.provider === member.provider);
  return {
    ...req,
    title,
    ...(member && unsetProvider ? { provider: member.provider } : {}),
    ...(fills && !req.model && member.model ? { model: member.model } : {}),
    ...(fills && !req.effort && member.effort ? { effort: member.effort } : {}),
  };
}
