import { createHash } from "node:crypto";
import {
  type ProjectTeams,
  resolveTeam,
  type StartTeamRun,
  type TeamMember,
  TeamRun,
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

/** Read the approved-checklist projection when pinned-plan support is available. */
export function resolveApprovedTeamPlan(
  checklist: unknown,
  projectId: string,
  request: StartTeamRun,
): { revision: string; items: TeamRun["items"] } | undefined {
  if (
    !checklist ||
    typeof checklist !== "object" ||
    !("projectId" in checklist) ||
    checklist.projectId !== projectId ||
    !("state" in checklist) ||
    checklist.state !== "approved" ||
    !("approvedAt" in checklist) ||
    typeof checklist.approvedAt !== "string" ||
    !Number.isFinite(Date.parse(checklist.approvedAt)) ||
    !("plan" in checklist) ||
    !checklist.plan ||
    typeof checklist.plan !== "object"
  )
    return;
  const { plan } = checklist;
  if (
    !("sha" in plan) ||
    typeof plan.sha !== "string" ||
    !("reviewRef" in plan) ||
    typeof plan.reviewRef !== "string" ||
    !plan.reviewRef ||
    !("tasks" in plan) ||
    !Array.isArray(plan.tasks) ||
    ("planSha" in request ? request.planSha !== plan.sha : request.checklistId !== projectId)
  )
    return;
  const parsed = TeamRun.shape.items.safeParse(
    plan.tasks.map((task: unknown) =>
      task && typeof task === "object" && "id" in task && "text" in task
        ? { id: task.id, text: task.text, dependsOn: [], criteria: [task.text] }
        : undefined,
    ),
  );
  if (!parsed.success || !parsed.data.length) return;
  const pinned = JSON.stringify(parsed.data.map(({ id, text }) => ({ id, text })));
  const revision = createHash("sha256").update(pinned).digest("hex");
  if (revision === plan.sha) return { revision, items: parsed.data };
}
