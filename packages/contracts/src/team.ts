import { z } from "zod";
import { AutonomyLevel, ProviderId, ReasoningEffort } from "./common";

/** The roles a project can configure for factory and PM-started work. */
export const TeamRole = z.enum([
  "architect",
  "writer",
  "uiWriter",
  "agentsMdWriter",
  "planReviewer",
  "reviewer",
  "reviewerFallback",
  "arbiter",
  "investigator",
  "browserTester",
  "browserOperator",
  /** Selects a model for card-gated work. Existing permission rules still apply. */
  "operator",
]);
export type TeamRole = z.infer<typeof TeamRole>;

/** Minimum supervision by Team role and purpose. "agent" covers untagged sessions. */
export const AutonomyPolicy = z.partialRecord(
  TeamRole.or(z.literal("agent")),
  z.record(z.string().trim().min(1).max(300), AutonomyLevel),
);
export type AutonomyPolicy = z.infer<typeof AutonomyPolicy>;

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
  "[Arbiter]": "arbiter",
  "[Investigator]": "investigator",
  "[Browser Tester]": "browserTester",
  "[Browser Operator]": "browserOperator",
  "[Operator]": "operator",
};

/** Display name from the role's canonical title tag. */
export function teamRoleName(role: TeamRole): string {
  return (
    Object.keys(TEAM_ROLE_TAGS)
      .find((tag) => TEAM_ROLE_TAGS[tag] === role)
      ?.slice(1, -1) ?? role
  );
}

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

/** The owner-set round limits shared by the Team's reviewers and Arbiter. */
export const TeamReviewLimits = z.strictObject({
  /** Maximum model review rounds for one item, including escalation. */
  totalRounds: z.int().min(1).max(12).default(8),
  /** Code review rounds before an unresolved item can go to the Arbiter. */
  reviewerRounds: z.int().min(1).max(5).default(2),
});
export type TeamReviewLimits = z.infer<typeof TeamReviewLimits>;

/** Default Team limits and project overrides. A null field restores inheritance. */
export const TeamReviewLimitSettings = z.strictObject({
  defaults: TeamReviewLimits.prefault({}),
  projects: z
    .record(
      z.string().min(1),
      z.strictObject({
        totalRounds: TeamReviewLimits.shape.totalRounds.unwrap().nullable().optional(),
        reviewerRounds: TeamReviewLimits.shape.reviewerRounds.unwrap().nullable().optional(),
      }),
    )
    .default({}),
});
export type TeamReviewLimitSettings = z.infer<typeof TeamReviewLimitSettings>;

/** Resolve each project field independently, including its provenance for the UI and tools. */
export function resolveTeamReviewLimits(settings: TeamReviewLimitSettings, projectId: string) {
  const project = Object.hasOwn(settings.projects, projectId)
    ? settings.projects[projectId]
    : undefined;
  return {
    limits: {
      totalRounds: project?.totalRounds ?? settings.defaults.totalRounds,
      reviewerRounds: project?.reviewerRounds ?? settings.defaults.reviewerRounds,
    },
    sources: {
      totalRounds: project?.totalRounds == null ? "default" : "project",
      reviewerRounds: project?.reviewerRounds == null ? "default" : "project",
    },
  } as const;
}

/** The event log timestamps this authenticated change with its envelope timestamp. */
export const TeamReviewLimitsAudit = z.object({
  actor: z.literal("owner"),
  oldValue: TeamReviewLimitSettings,
  newValue: TeamReviewLimitSettings,
});

/**
 * A session's effective Team, role by role: the session's own choice for its role (from its
 * `[Role]` title tag) over the project's Team over the default Team (Settings, Factory > Team).
 * Nothing else supplies a model: a role none of them sets is absent.
 */
export function resolveTeam(layers: {
  defaults: readonly TeamMember[];
  project: readonly TeamMember[];
  session?: TeamMember | null;
  /** The effective Team captured at run admission. Later Settings edits do not change it. */
  approved?: readonly TeamMember[];
}): { team: Team; sources: Partial<Record<TeamRole, TeamSource>> } {
  const byRole = new Map<TeamRole, { member: TeamMember; source: TeamSource }>();
  if (!layers.approved) {
    for (const member of layers.defaults) byRole.set(member.role, { member, source: "default" });
  }
  // Approved snapshots historically record only the members, without their original sources.
  for (const member of layers.approved ?? layers.project)
    byRole.set(member.role, { member, source: "project" });
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
  /** The limits consumed by the Team review tools, independent of the Arbiter's model. */
  arbiterLimits: z
    .object({
      reviewFixRounds: TeamReviewLimits.shape.reviewerRounds,
      totalRounds: TeamReviewLimits.shape.totalRounds,
    })
    .optional(),
  /** Identifies the session Team as the source for the exported round limits. */
  arbiterSettingsSource: z.literal(TEAM_FILE_ENV).optional(),
  updatedAt: z.string(),
});
export type TeamFile = z.infer<typeof TeamFile>;

/** Live Team pins, their source, and the count of projects overriding each Default Team role. */
export const TeamDiagnostics = z.object({
  team: Team,
  sources: z.partialRecord(TeamRole, TeamSource),
  overrides: z.partialRecord(TeamRole, z.int().nonnegative()),
});
export type TeamDiagnostics = z.infer<typeof TeamDiagnostics>;

/** Count each project's effective override once per role. */
export function countTeamOverrides(projects: readonly Team[]): TeamDiagnostics["overrides"] {
  const counts: TeamDiagnostics["overrides"] = {};
  for (const project of projects) {
    for (const { role } of project) counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}
