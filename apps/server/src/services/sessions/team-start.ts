import {
  type ReasoningEffort,
  resolveTeam,
  type StartSessionRequest,
  type TeamMember,
  teamMember,
  teamRoleName,
  teamRoleOfTitle,
} from "@codeden/contracts";
import { badRequest } from "../errors";
import { derivePurpose } from "./conflicts";

/**
 * A start with a Team role (the composer's Team choice): the title gets the role's tag, and a
 * provider, model or effort the request leaves unset comes from the resolved Team (the project's
 * Team, then the default Team), field by field, when the provider is unset or is the member's own.
 * What the user set explicitly wins: it is the session's own choice.
 */
export function withTeamRole(
  req: StartSessionRequest,
  teams: Parameters<typeof resolveTeam>[0],
): StartSessionRequest {
  const role = req.teamRole ?? teamRoleOfTitle(req.title);
  if (!role) return req;
  const tag = `[${teamRoleName(role)}]`;
  const base = req.title ?? derivePurpose(req.purpose, req.input?.text);
  const title = (base.startsWith(tag) ? base : `${tag} ${base}`).slice(0, 200);
  const member = teamMember(resolveTeam(teams).team, role);
  if (!member && (!req.provider || req.provider === "auto")) {
    throw badRequest(`Set the ${teamRoleName(role)} in Settings → Team`, "TEAM_ROLE_UNSET");
  }
  return member ? teamStartChoice({ ...req, title }, member) : { ...req, title };
}

/** Fill absent session pins only from a member on the selected provider. */
export function teamStartChoice<
  T extends { provider?: string; model?: string; effort?: ReasoningEffort },
>(req: T, member: TeamMember): T {
  const unsetProvider = !req.provider || req.provider === "auto";
  const fills = unsetProvider || req.provider === member.provider;
  return {
    ...req,
    ...(unsetProvider ? { provider: member.provider } : {}),
    ...(fills && !req.model && member.model ? { model: member.model } : {}),
    ...(fills && !req.effort && member.effort ? { effort: member.effort } : {}),
  };
}
