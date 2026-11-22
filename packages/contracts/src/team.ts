import { z } from "zod";
import { ProviderId, ReasoningEffort } from "./common";

/** The roles a project can configure for factory and PM-started work. */
export const TeamRole = z.enum([
  "architect",
  "writer",
  "uiWriter",
  "agentsMdWriter",
  "planReviewer",
  "reviewer",
  "investigator",
  "browserTester",
  "browserOperator",
]);
export type TeamRole = z.infer<typeof TeamRole>;

/** A role's provider and optional pins. Null means the model or effort is unpinned. */
export const TeamMember = z.object({
  role: TeamRole,
  provider: ProviderId.refine((provider) => provider !== "auto"),
  model: z.string().min(1).nullable().default(null),
  effort: ReasoningEffort.nullable().default(null),
});
export type TeamMember = z.infer<typeof TeamMember>;

/** At most one member per role. Saving the array replaces the entire Team. */
export const Team = z
  .array(TeamMember)
  .max(9)
  .refine((team) => new Set(team.map((member) => member.role)).size === team.length, {
    message: "Team roles must be unique",
  });
export type Team = z.infer<typeof Team>;

/** The title prefixes that select a Team role. */
export const TEAM_ROLE_TAGS: Record<string, TeamRole> = {
  "[Architect]": "architect",
  "[Writer]": "writer",
  "[UI Writer]": "uiWriter",
  "[AGENTS.md Writer]": "agentsMdWriter",
  "[Plan Reviewer]": "planReviewer",
  "[Code Reviewer]": "reviewer",
  "[Investigator]": "investigator",
  "[Browser Tester]": "browserTester",
  "[Browser Operator]": "browserOperator",
};

/** Only the first bracketed tag at the start of the title selects a role. */
export function teamRoleOfTitle(title: string | undefined): TeamRole | null {
  const tag = title?.match(/^\[[^\]]+\]/)?.[0];
  return tag ? (TEAM_ROLE_TAGS[tag] ?? null) : null;
}

/** Find the configured member for a role, if any. */
export function teamMember(team: readonly TeamMember[] | undefined, role: TeamRole | null) {
  return team?.find((member) => member.role === role);
}

/**
 * Environment variable that names a session's Team file. Agent sessions inherit it, so the tools
 * they run (review and role scripts) take each role's provider, model and effort from the
 * project's Team. It has no `CODEDEN_` prefix because those variables are not passed to agents.
 */
export const TEAM_FILE_ENV = "TEAM_FILE";

/** A project's Team as written to the file named by `TEAM_FILE`; rewritten whenever the Team changes. */
export const TeamFile = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  /** The project's folder and its worktrees folder: tools use this Team only for code inside them. */
  roots: z.array(z.string().min(1)).min(1),
  team: Team,
  updatedAt: z.string(),
});
export type TeamFile = z.infer<typeof TeamFile>;
