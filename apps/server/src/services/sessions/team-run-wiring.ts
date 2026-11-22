import { defaultTeam, EventEnvelope, StartSessionRequest } from "@codeden/contracts";
import type { AppServices } from "../container";
import { listTeamRuns, saveTeamRun } from "./team-run-projection";
import { type TeamRunPorts, TeamRuns } from "./team-runs";

export type TeamRunIntegrations = Pick<
  TeamRunPorts,
  "approvedPlan" | "vendor" | "merge" | "review" | "verify"
>;

function waitForWorktree({ sessionRepo, store }: AppServices, sessionId: string) {
  return new Promise<{ sessionId: string; branch: string; worktree: string }>((resolve, reject) => {
    const check = () => {
      const session = sessionRepo.get(sessionId);
      if (session.branch && session.worktreePath) {
        unsubscribe();
        resolve({ sessionId, branch: session.branch, worktree: session.worktreePath });
      } else if (["failed", "stopped", "interrupted"].includes(session.status)) {
        unsubscribe();
        reject(new Error(`Team worktree preparation ended with status ${session.status}`));
      }
    };
    const unsubscribe = store.subscribe((batch) => {
      if (
        batch.some((event) => event.sessionId === sessionId && event.type === "session.updated")
      ) {
        check();
      }
    });
    check();
  });
}

export function wireTeamRuns(
  services: AppServices,
  integrations: TeamRunIntegrations,
  log?: (message: string) => void,
): TeamRuns {
  const { admission, db, sessionRepo, sessions, store } = services;
  const runs = new TeamRuns(
    {
      ...integrations,
      configuration: (projectId) => {
        const settings = services.settings.get();
        const project = services.projects.get(projectId);
        return {
          teams: project.teams ?? {
            defaultTeamId: "default",
            teams: [
              {
                id: "default",
                name: "Default Team",
                team: services.factory.data.loop(projectId)?.tuning.team ?? [],
                limits: {
                  maxParallel: settings.limits.maxActiveSessions,
                  maxAssignments: 20,
                  maxRounds: 2,
                },
              },
            ],
          },
          defaults: defaultTeam(settings),
        };
      },
      freeAgentSlots: () => admission.free(),
      save: (run) => saveTeamRun(store, run),
      launch: async (member, branch, base, run, item) => {
        const checkpoint = run.workers.find((worker) => worker.itemId === item?.id)?.checkpoint;
        const title = item ? `[Writer] ${item.text}` : `[Architect] ${run.teamName}`;
        const result = await sessions.start(
          StartSessionRequest.parse({
            projectId: run.projectId,
            provider: member.provider,
            model: member.model ?? undefined,
            effort: member.effort ?? undefined,
            title: title.slice(0, 200),
            workKey: `request:${branch.replaceAll("/", "-")}`,
            startedBy: { kind: "pm" },
            parentSessionId: item ? run.coordinatorId : undefined,
            workspace: { mode: "worktree", branch, baseRef: base || undefined },
            input: {
              from: "codeden",
              text: item
                ? [item.text, checkpoint?.nextSteps].filter(Boolean).join("\n\n")
                : `Coordinate Team run ${run.id} for approved revision ${run.revision}.\n${run.items.map((entry) => entry.text).join("\n")}`,
            },
          }),
        );
        if (result.status !== "started" && result.status !== "queued") {
          throw new Error(`Session launch: ${result.status}`);
        }
        return waitForWorktree(services, result.sessionId);
      },
      coordinate: async (sessionId, message) => {
        await sessions.send(
          sessionId,
          {
            input: {
              from: "codeden",
              attachments: [],
              text: `Team: ${JSON.stringify(message)}`,
              teamCoordination: message,
            },
            whenBusy: "queue",
          },
          "codeden",
        );
      },
    },
    listTeamRuns(db),
  );

  store.subscribe((batch) => {
    for (const raw of batch) {
      if (!raw.sessionId) continue;
      const sessionId = raw.sessionId;
      let failure: string | null;
      if (raw.type === "session.updated") {
        const session = sessionRepo.find(sessionId)?.session;
        if (session?.status !== "failed" && session?.status !== "stopped") continue;
        failure = `Team worker session ${session.status}`;
      } else {
        if (
          !["agent.turn.completed", "agent.turn.failed", "agent.turn.interrupted"].includes(
            raw.type,
          )
        ) {
          continue;
        }
        const event = EventEnvelope.parse(raw);
        if (
          event.type !== "agent.turn.completed" &&
          event.type !== "agent.turn.failed" &&
          event.type !== "agent.turn.interrupted"
        ) {
          continue;
        }
        if (sessionRepo.find(sessionId)?.session.rootThreadId !== event.payload.threadId) continue;
        failure =
          event.type === "agent.turn.completed"
            ? null
            : event.type === "agent.turn.failed"
              ? event.payload.error.message
              : event.payload.reason;
      }
      queueMicrotask(() => {
        void runs
          .finishWorker(sessionId, failure)
          .catch((error) => log?.(`Team run completion: ${String(error)}`));
      });
    }
  });
  return runs;
}
