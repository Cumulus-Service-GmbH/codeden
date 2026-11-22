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
    })
    .optional(),
});
export type TeamWorkerJev = z.infer<typeof TeamWorkerJev>;

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
  /** When this attempt started, used to estimate remaining time. */
  startedAt: z.int().nonnegative().optional(),
  checkpoint: TeamWorkerCheckpoint.nullable(),
  jev: TeamWorkerJev.optional(),
  /** The first product refusal, retained across worker attempts for the single reviewer escalation. */
  jevRefusal: TeamWorkerJev.shape.receipt,
});
export type TeamWorker = z.infer<typeof TeamWorker>;

/** Application-authored inputs that wake the run's Architect. */
export const TeamCoordinationMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("worker_finished"), itemId: id, attempt: z.int().positive() }),
  z.object({ type: z.literal("worker_failed"), itemId: id, attempt: z.int().positive() }),
  z.object({ type: z.literal("review_done"), itemId: id, attempt: z.int().positive() }),
  z.object({ type: z.literal("continue") }),
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
  items: z.array(z.object({ id, text: id, dependsOn: z.array(id) })),
  assembler: id,
  coordinatorId: id.nullable(),
  workers: z.array(TeamWorker),
  status: z.enum(["running", "waiting", "ready"]),
  notice: z.string().nullable(),
});
export type TeamRun = z.infer<typeof TeamRun>;
