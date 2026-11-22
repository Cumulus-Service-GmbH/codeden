import {
  type ProjectTeams,
  resolveTeam,
  type TeamMember,
  type TeamRunSettings,
  type TeamWorker,
} from "@codeden/contracts";

/** Resolve one project Team and keep its limits together with its effective role assignments. */
export function resolveRunTeam(
  configuration: ProjectTeams,
  teamId: string | undefined,
  defaults: readonly TeamMember[],
  session?: TeamMember | null,
) {
  const id = teamId ?? configuration.defaultTeamId;
  const selected = configuration.teams.find((team) => team.id === id);
  if (!selected) throw new Error(`Unknown Team: ${id}`);
  return { ...selected, ...resolveTeam({ defaults, project: selected.team, session }) };
}

/** Plan dispatch in checklist order. The caller reserves these slots before launching sessions. */
export function eligibleAssignments(
  workers: readonly TeamWorker[],
  { maxParallel, maxRounds }: Pick<TeamRunSettings, "maxParallel" | "maxRounds">,
  freeAgentSlots: number,
): string[] {
  const running = workers.filter((worker) => worker.status === "running").length;
  const slots = Math.max(0, Math.min(maxParallel - running, freeAgentSlots));
  const completed = new Set(
    workers.filter((worker) => worker.status === "completed").map((worker) => worker.itemId),
  );
  return workers
    .filter(
      (worker) =>
        (worker.status === "queued" || worker.status === "failed") &&
        worker.attempt < maxRounds &&
        worker.dependsOn.every((dependency) => completed.has(dependency)),
    )
    .slice(0, slots)
    .map((worker) => worker.itemId);
}
