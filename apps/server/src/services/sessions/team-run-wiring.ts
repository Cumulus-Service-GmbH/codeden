import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultTeam, EventEnvelope, StartSessionRequest } from "@codeden/contracts";
import type { AppServices } from "../container";
import type { Exec } from "../exec";
import { runJevDone } from "./team-run-jev";
import { listTeamRuns, saveTeamRun } from "./team-run-projection";
import { resolveApprovedTeamPlan } from "./team-run-scheduler";
import { type TeamRunPorts, TeamRuns } from "./team-runs";

const workerRules = [
  "Stay strictly inside this assignment. Use small diffs.",
  "Write the failing test first, then the fix. Never disable, skip or weaken a test.",
  "Run only the nearest tests with VITEST_MAX_WORKERS=2. Never run the full suite.",
  "Leave changes in the checkout if you cannot commit. Never name other products.",
  "If a sibling interface is unavailable, add a small seam that fails closed.",
  "Report completed work and remaining steps in order, with one named test per acceptance criterion.",
].join("\n");

const reviewPolicy = `REVIEW POLICY (verbatim):
- Cross-vendor only. Codex-written code gets one final review by Claude Opus 5.5 high; Claude-written code gets codex gpt-6.2-astra xhigh.
- ONE final review per item. HIGH and MEDIUM need a concrete failure scenario and repro, otherwise they're LOW.
- Fix every HIGH and MEDIUM with tests, then merge. LOWs go verbatim (file:line, receipt) into a tech-debt list in your hand-off.
- Review against the item's scope only. A later fix is reviewed as a delta, with the prior findings attached.
- Small diffs. No further rounds. If something is still unresolved, it goes to the PM for an owner decision.
- No exceptions, no disabled or weakened tests, no Jev or security-rule bypass.`;

export type TeamRunIntegrations = Partial<
  Pick<
    TeamRunPorts,
    | "approvedPlan"
    | "vendor"
    | "head"
    | "merge"
    | "review"
    | "verify"
    | "gate"
    | "arbiter"
    | "defer"
  >
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

function workerResponse({ sessionRepo }: AppServices, sessionId: string): string | undefined {
  const session = sessionRepo.get(sessionId);
  for (const item of sessionRepo.rootItems(session, ["assistant_message"], 5).reverse()) {
    if (item.kind === "assistant_message" && item.text.trim()) return item.text;
  }
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
      approvedPlan: async (projectId, request) => {
        const checklist = services.checklist.get(projectId);
        if (!checklist || !("state" in checklist)) {
          throw new Error("Approved pinned-plan lookup is unavailable");
        }
        return resolveApprovedTeamPlan(checklist, projectId, request);
      },
      vendor: (member) =>
        services.runner.providers().find((provider) => provider.id === member.provider)
          ?.capabilities.modelVendor,
      seal: async (_run, worker) => {
        if (!worker.sessionId || !worker.worktree || !worker.branch) {
          throw new Error("Worker worktree unavailable");
        }
        const runner = services.runners.forSession(worker.sessionId);
        const cwd = worker.worktree;
        const { branch, files } = await runner.request({ name: "git.status", cwd });
        if (branch !== worker.branch) throw new Error("Worker checkout is on the wrong branch");
        if (files.some(({ status }) => /^(?:DD|AU|UD|UA|DU|AA|UU)$/.test(status))) {
          throw new Error("Worker checkout still contains unresolved conflicts");
        }
        if (files.length) {
          await runner.request({
            name: "git.commit",
            cwd,
            message: "feat: complete Team assignment",
          });
        }
      },
      writerResponse: (worker) => {
        if (worker.sessionId) return workerResponse(services, worker.sessionId);
      },
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
        if (worker.resolutionHead && !worker.resolutionBase) {
          throw new Error("Conflict resolution assembler base is unavailable");
        }
        return runner.request({
          name: "git.mergeTeamWorker",
          cwd: assembler.worktreePath,
          assembler: run.assembler,
          workerBranch: worker.branch,
          head,
          ...(worker.resolutionHead && worker.resolutionBase
            ? { resolutionParents: [worker.resolutionHead, worker.resolutionBase] }
            : {}),
        });
      },
      verify: async () => {
        throw new Error("Team full-suite and browser verification are unavailable");
      },
      capture: async (_run, worker) => {
        if (!worker.sessionId || !worker.worktree || !worker.baseHead || !worker.branch) {
          throw new Error("Worker candidate or base is unavailable");
        }
        const runner = services.runners.forSession(worker.sessionId);
        const cwd = worker.worktree;
        const { branches } = await runner.request({ name: "git.branches", cwd });
        const head = branches.find(({ name, remote }) => !remote && name === worker.branch)?.commit;
        if (!head) throw new Error("Worker branch head unavailable");
        const fromRef = worker.deltaBase ?? worker.baseHead;
        const diff =
          fromRef === head
            ? ""
            : (await runner.request({ name: "git.diff", cwd, fromRef, toRef: head })).diff;
        return {
          head,
          history: `\nCandidate ${head} from ${fromRef} (round ${worker.attempt})\n${workerResponse(services, worker.sessionId) ?? ""}\n\n${diff}\n`,
        };
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
        const item = run.items.find(({ id }) => id === worker.itemId);
        const refusal = worker.jev?.receipt;
        const criteria = item?.criteria?.map(
          (criterion, index) =>
            `${criterion} (met_${index}: ${refusal?.scores?.[`met_${index}`] ?? "unavailable"})`,
        );
        services.inbox.put({
          id,
          kind: "message",
          status: "open",
          priority: "high",
          notify: "needs_you",
          title: `${run.teamName} requires an owner decision`,
          body: [
            `Jev refused assignment ${worker.itemId} again.`,
            ...(refusal?.reasons ?? []),
            ...(criteria ?? []),
            refusal?.scores && JSON.stringify(refusal.scores),
          ]
            .filter(Boolean)
            .join("\n"),
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
      launch: async (member, branch, base, run, item, packet) => {
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
                ? [item.text, ...(item.criteria ?? []), workerRules, reviewPolicy, packet]
                    .filter(Boolean)
                    .join("\n\n")
                : `Coordinate Team run ${run.id} for approved revision ${run.revision}.\n${run.items.map((entry) => entry.text).join("\n")}`,
            },
          }),
        );
        if (result.status !== "started" && result.status !== "queued") {
          throw new Error(`Session launch: ${result.status}`);
        }
        const workspace = await waitForWorktree(services, result.sessionId);
        if (!item) return workspace;
        const { branches } = await services.runners.forSession(result.sessionId).request({
          name: "git.branches",
          cwd: workspace.worktree,
        });
        const baseHead = branches.find(({ name, remote }) => !remote && name === base)?.commit;
        if (!baseHead) throw new Error("Worker base commit is unavailable");
        return { ...workspace, baseHead };
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
