import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultTeam, EventEnvelope, StartSessionRequest } from "@codeden/contracts";
import type { AppServices } from "../container";
import type { Exec } from "../exec";
import { runJevDone } from "./team-run-jev";
import { listTeamRuns, saveTeamRun } from "./team-run-projection";
import { type TeamRunPorts, TeamRuns } from "./team-runs";

export type TeamRunIntegrations = Partial<
  Pick<TeamRunPorts, "approvedPlan" | "vendor" | "head" | "merge" | "review" | "verify" | "gate">
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
  exec: Exec,
  integrations: TeamRunIntegrations = {},
  log?: (message: string) => void,
): TeamRuns {
  const { admission, db, sessionRepo, sessions, store } = services;
  const runs = new TeamRuns(
    {
      approvedPlan: async () => {
        throw new Error("Approved pinned-plan lookup is unavailable");
      },
      vendor: (member) =>
        services.runner.providers().find((provider) => provider.id === member.provider)
          ?.capabilities.modelVendor,
      head: async (_run, worker) => {
        if (!worker.sessionId || !worker.worktree) throw new Error("Worker worktree unavailable");
        const runner = services.runners.forSession(worker.sessionId);
        const { branches } = await runner.request({ name: "git.branches", cwd: worker.worktree });
        const head = branches.find(
          (branch) => !branch.remote && branch.name === worker.branch,
        )?.commit;
        if (!head) throw new Error("Worker branch head unavailable");
        return head;
      },
      review: async () => {
        throw new Error("Shared Team review is unavailable");
      },
      merge: async (run, worker, head) => {
        if (!run.coordinatorId || !worker.sessionId || !worker.branch) {
          throw new Error("Team assembler or worker worktree is unavailable");
        }
        const assembler = sessionRepo.get(run.coordinatorId);
        if (!assembler.worktreePath || assembler.branch !== run.assembler) {
          throw new Error("Team assembler worktree is unavailable");
        }
        const runner = services.runners.forSession(run.coordinatorId);
        if (runner !== services.runners.forSession(worker.sessionId)) {
          throw new Error("Team assembler and worker must share a runner");
        }
        return runner.request({
          name: "git.mergeTeamWorker",
          cwd: assembler.worktreePath,
          assembler: run.assembler,
          workerBranch: worker.branch,
          head,
        });
      },
      verify: async () => {
        throw new Error("Team full-suite and browser verification are unavailable");
      },
      history: async (run, worker) => {
        const dir = join(services.paths.home, "team-history");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const key = createHash("sha256")
          .update(JSON.stringify([run.id, worker.itemId]))
          .digest("hex");
        const path = join(dir, `${key}.md`);
        try {
          await writeFile(
            path,
            `Approved plan ${run.revision}\n\n${JSON.stringify(run.items, null, 2)}\n\nAssignment ${worker.itemId}\n`,
            {
              flag: "wx",
              mode: 0o600,
            },
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        return path;
      },
      gate: async (_run, _worker, review, historyPath) => {
        if (!review.evidence || !historyPath) return { status: "unavailable" };
        return runJevDone(
          exec,
          join(services.userHome, ".claude", "skills", "trioharness-codeden", "scripts", "jev.mjs"),
          historyPath,
          { ...review.evidence, head: review.head },
        );
      },
      ownerDecision: (run, worker) => {
        const id = `team-owner-decision:${run.id}:${worker.itemId}`;
        if (services.inbox.find(id)) return;
        const now = new Date().toISOString();
        services.inbox.put({
          id,
          kind: "message",
          status: "open",
          priority: "high",
          notify: "needs_you",
          title: `${run.teamName} requires an owner decision`,
          body: `Jev refused assignment ${worker.itemId} again. ${worker.jev?.receipt?.reasons?.join("; ") ?? ""}`,
          projectId: run.projectId,
          sessionId: run.coordinatorId,
          threadId: null,
          itemId: null,
          requestId: null,
          issue: null,
          pr: null,
          automationRunId: null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
          resolution: null,
        });
      },
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
