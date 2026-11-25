import { type ChecklistStatus, Session } from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import type { SessionRepo } from "../sessions/repo";
import { type ChecklistService, checklistWorkStatus } from "./checklist-service";

export class ChecklistListener {
  private unsubscribe?: () => void;
  private readonly lastSignal = new Map<string, { work: string; waiting: boolean }>();

  constructor(
    store: EventStore,
    private readonly repo: Pick<SessionRepo, "agentsOf" | "find">,
    private readonly checklist: ChecklistService,
  ) {
    for (const projectId of checklist.projectIds()) {
      for (const session of repo.agentsOf(projectId)) {
        this.lastSignal.set(session.id, signalFor(session, checklistWorkStatus(session)));
      }
    }
    this.unsubscribe = store.subscribe((events) => {
      for (const event of events) {
        if (event.type !== "session.created" && event.type !== "session.updated") continue;
        const parsed = Session.safeParse((event.payload as { session?: unknown }).session);
        if (!parsed.success || !parsed.data.projectId) continue;
        const session = parsed.data;
        const status = checklistWorkStatus(session);
        const signal = signalFor(session, status);
        queueMicrotask(() => {
          if (!this.unsubscribe) return;
          const previous = this.lastSignal.get(session.id);
          const work = previous?.work === signal.work ? undefined : status;
          const waiting =
            (previous?.waiting ?? false) === signal.waiting ? undefined : signal.waiting;
          if (previous?.work === signal.work && waiting === undefined) {
            this.lastSignal.set(session.id, signal);
            return;
          }
          try {
            if (waiting === undefined) this.checklist.markWork(session, work);
            else this.checklist.markWork(session, work, undefined, waiting);
            this.lastSignal.set(session.id, signal);
          } catch (error) {
            console.error(
              `[codeden] Checklist status update failed for session ${session.id}`,
              error,
            );
          }
        });
      }
    });
  }

  onWorkSignal(sessionId: string, signal: "started" | "done" | "blocked"): void {
    const session = this.repo.find(sessionId)?.session;
    if (session && !session.archivedAt) {
      this.checklist.markWork(session, signal === "started" ? "doing" : signal);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.lastSignal.clear();
  }
}

function signalFor(session: Session, status: ChecklistStatus | undefined) {
  return {
    work: JSON.stringify([
      status,
      session.status,
      session.result,
      session.startError?.message,
      session.workKey,
    ]),
    waiting: !session.archivedAt && session.status === "waiting",
  };
}
