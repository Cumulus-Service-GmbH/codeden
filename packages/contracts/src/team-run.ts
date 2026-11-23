import { z } from "zod";
import { ReasoningEffort } from "./common";
import { Team, TeamMember } from "./team";

const id = z.string().min(1);
const commitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Run budgets. Admission also bounds parallel workers by the current active-session cap. */
export const TeamRunSettings = z.object({
  maxParallel: z.int().min(1).max(64),
  maxAssignments: z.int().min(1),
  maxRounds: z.int().min(1),
});
export type TeamRunSettings = z.infer<typeof TeamRunSettings>;

/** One named Team's role overrides and run budgets. */
export const NamedTeam = z.object({
  id,
  name: id,
  team: Team,
  limits: TeamRunSettings,
});
export type NamedTeam = z.infer<typeof NamedTeam>;

/** The project's Team list with exactly one default, identified by its stable ID. */
export const ProjectTeams = z
  .object({ defaultTeamId: id, teams: z.array(NamedTeam).min(1) })
  .refine(({ defaultTeamId, teams }) => teams.some((team) => team.id === defaultTeamId), {
    message: "Default Team must exist",
    path: ["defaultTeamId"],
  })
  .refine(({ teams }) => new Set(teams.map((team) => team.id)).size === teams.length, {
    message: "Team IDs must be unique",
    path: ["teams"],
  });
export type ProjectTeams = z.infer<typeof ProjectTeams>;

/** Start request scoped to the calling PM's project. The service verifies plan approval. */
export const StartTeamRun = z.union([
  z.strictObject({
    teamId: id.optional(),
    planSha: commitSha,
  }),
  z.strictObject({ teamId: id.optional(), checklistId: id }),
]);
export type StartTeamRun = z.infer<typeof StartTeamRun>;

/** Durable context for resuming an assignment or explaining why it is waiting. */
export const TeamWorkerCheckpoint = z.object({
  summary: z.string(),
  nextSteps: z.string(),
  blocker: z.string().nullable(),
  updatedAt: z.int().nonnegative(),
});
export type TeamWorkerCheckpoint = z.infer<typeof TeamWorkerCheckpoint>;

/** The result of checking the reviewed candidate, bound to its commit and item history. */
export const TeamWorkerJev = z.object({
  status: z.enum(["pending", "pass", "revise", "unavailable", "owner decision"]),
  receipt: z
    .object({
      head: commitSha,
      historyPath: id,
      historySha256: z.string().regex(/^[0-9a-f]{64}$/),
      /** The receipt covers this prefix of the append-only history. */
      historyBytes: z.int().nonnegative().optional(),
      inputSha256: z.string().optional(),
      reasons: z.array(z.string()).optional(),
      /** Exact scores returned by the done gate. */
      scores: z.record(z.string(), z.number().min(0).max(1)).optional(),
    })
    .optional(),
});
export type TeamWorkerJev = z.infer<typeof TeamWorkerJev>;

/** Provenance of a shared review recorded for the assignment's build history. */
export const TeamReviewRecord = z.object({
  provider: TeamMember.shape.provider,
  model: id,
  effort: ReasoningEffort,
  slot: z.enum(["primary", "fallback"]),
  receipt: id,
  head: commitSha,
  historySha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type TeamReviewRecord = z.infer<typeof TeamReviewRecord>;

/** One assignment in the run. Runner resources are absent until provisioned. */
export const TeamWorker = z.object({
  sessionId: id.nullable(),
  itemId: id,
  provider: TeamMember.shape.provider,
  model: id.nullable(),
  effort: ReasoningEffort.nullable(),
  branch: id.nullable(),
  worktree: id.nullable(),
  status: z.enum(["queued", "running", "waiting", "completed", "failed", "stopped"]),
  dependsOn: z.array(id),
  attempt: z.int().nonnegative(),
  /** The persisted session is still responsible for completing this attempt after restart. */
  reconciling: z.boolean().optional(),
  /** When this attempt started, used to estimate remaining time. */
  startedAt: z.int().nonnegative().optional(),
  checkpoint: TeamWorkerCheckpoint.nullable(),
  jev: TeamWorkerJev.optional(),
  /** Candidate that was sent back for a blocking review finding. */
  deltaBase: commitSha.optional(),
  /** Whether the previous review requested a fix for a blocking finding. */
  blockingReview: z.boolean().optional(),
  /** The worktree's pinned starting commit. */
  baseHead: commitSha.optional(),
  /** Original candidate that must be retained in a conflict resolution. */
  resolutionHead: commitSha.optional(),
  /** Assembler commit from which the resolution checkout was created. */
  resolutionBase: commitSha.optional(),
  /** Current coordinator step, retained when an assignment is blocked. */
  step: z.enum(["writing", "review", "delta", "Arbiter", "Jev", "merge"]).optional(),
  /** Latest progress line sent to the Architect. */
  progress: id.optional(),
  /** Latest review invocation and the history digest supplied to it. */
  reviewRunId: id.optional(),
  reviews: z.array(TeamReviewRecord).optional(),
  historySha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** The single ruling after a fix delta still has a blocking finding. */
  arbiter: z
    .object({
      verdict: z.enum(["FIX REQUIRED", "DOWNGRADE TO LOW"]),
      reason: id,
      historySha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    })
    .optional(),
  /** The first product refusal, retained across worker attempts for the single reviewer escalation. */
  jevRefusal: TeamWorkerJev.shape.receipt,
});
export type TeamWorker = z.infer<typeof TeamWorker>;

/** Application-authored inputs that wake the run's Architect. */
export const TeamCoordinationMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("worker_finished"), itemId: id, attempt: z.int().positive() }),
  z.object({ type: z.literal("worker_failed"), itemId: id, attempt: z.int().positive() }),
  z.object({ type: z.literal("review_done"), itemId: id, attempt: z.int().positive() }),
  z.object({ type: z.literal("continue"), itemId: id.optional(), progress: id.optional() }),
]);
export type TeamCoordinationMessage = z.infer<typeof TeamCoordinationMessage>;

/** Persisted Team run, including the pinned plan and the resolved role assignments. */
export const TeamRun = z.object({
  id,
  projectId: id,
  teamId: id,
  teamName: id,
  team: Team,
  limits: TeamRunSettings,
  revision: id,
  items: z.array(
    z.object({
      id,
      text: id,
      dependsOn: z.array(id),
      /** Owner-approved criteria, in their original wording and order. */
      criteria: z.array(id).min(1).optional(),
    }),
  ),
  assembler: id,
  /** The run-owned merge checkout, separate from the Architect session. */
  assemblerWorktree: id.optional(),
  coordinatorId: id.nullable(),
  workers: z.array(TeamWorker),
  status: z.enum(["running", "waiting", "ready"]),
  notice: z.string().nullable(),
});
export type TeamRun = z.infer<typeof TeamRun>;
