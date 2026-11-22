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
  "reviewerFallback",
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
  .max(TeamRole.options.length)
  .refine((team) => new Set(team.map((member) => member.role)).size === team.length, {
    message: "Team roles must be unique",
  })
  .refine((team) => !team.some((m) => m.role === "planReviewer" && m.effort === "minimal"), {
    message: "The Plan Reviewer runs at low effort or higher, never minimal",
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
  "[Code Reviewer Fallback]": "reviewerFallback",
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

/** Where a resolved member came from: the session itself, the project's Team, or the default Team. */
export const TeamSource = z.enum(["session", "project", "default"]);
export type TeamSource = z.infer<typeof TeamSource>;

/**
 * A session's effective Team, role by role: the session's own choice for its role (from its
 * `[Role]` title tag) over the project's Team over the default Team (Settings, Factory > Team).
 * Nothing else supplies a model: a role none of them sets is absent.
 */
export function resolveTeam(layers: {
  defaults: readonly TeamMember[];
  project: readonly TeamMember[];
  session?: TeamMember | null;
}): { team: Team; sources: Partial<Record<TeamRole, TeamSource>> } {
  const byRole = new Map<TeamRole, { member: TeamMember; source: TeamSource }>();
  for (const member of layers.defaults) byRole.set(member.role, { member, source: "default" });
  for (const member of layers.project) byRole.set(member.role, { member, source: "project" });
  if (layers.session)
    byRole.set(layers.session.role, { member: layers.session, source: "session" });
  const entries = TeamRole.options.flatMap((role) => {
    const entry = byRole.get(role);
    return entry ? [entry] : [];
  });
  return {
    team: entries.map((entry) => entry.member),
    sources: Object.fromEntries(entries.map((entry) => [entry.member.role, entry.source])),
  };
}

/** A session's own choice for the role its title names, if it names one. */
export function sessionTeamMember(session: {
  title?: string | null;
  provider: string;
  model?: string | null;
  effort?: string | null;
}): TeamMember | null {
  const role = teamRoleOfTitle(session.title ?? undefined);
  if (!role) return null;
  const parsed = TeamMember.safeParse({
    role,
    provider: session.provider,
    model: session.model ?? null,
    effort: session.effort ?? null,
  });
  return parsed.success ? parsed.data : null;
}

/** A session's effective Team as written to the file named by `TEAM_FILE`; rewritten whenever it changes. */
export const TeamFile = z.object({
  version: z.literal(1),
  /** The session the file belongs to; the file is named after it. */
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  /** The project's folder and its worktrees folder: tools use this Team only for code inside them. */
  roots: z.array(z.string().min(1)).min(1),
  team: Team,
  /** Where each member came from (`resolveTeam`). */
  sources: z.partialRecord(TeamRole, TeamSource),
  updatedAt: z.string(),
});
export type TeamFile = z.infer<typeof TeamFile>;
