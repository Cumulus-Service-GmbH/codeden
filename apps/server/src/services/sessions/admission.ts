import { type AdmissionStatus, AT_CAPACITY_CODE, type Session } from "@codeden/contracts";
import { runnerErrorCode } from "../runner-port";
import { isTurnRunningError } from "./outbox-holds";
import { emptyStartMeta, type SessionRepo } from "./repo";

const ACTIVE = new Set(["starting", "running", "waiting"]);

export function isSendBusyError(error: unknown): boolean {
  return isTurnRunningError(error) || runnerErrorCode(error) === AT_CAPACITY_CODE;
}

export class SessionAdmission {
  private readonly reserved = new Map<string, Session["role"]>();

  constructor(
    private readonly repo: SessionRepo,
    private readonly limit: () => number,
    private readonly projectCount: () => number,
    private readonly onRelease?: () => void,
    private readonly checking: () => Iterable<string> = () => [],
  ) {}

  tryReserve(id: string, role: Session["role"], head = false): boolean {
    const rows = this.repo.admissionRows();
    const { agents, controls, active, exemption } = this.counts(rows);
    if (this.reserved.has(id) || rows.some((row) => row.id === id && ACTIVE.has(row.status))) {
      return true;
    }
    // Keep the slot reserved when a new turn takes over from a check run.
    if (!agents.has(id) && (role === "agent" || controls.size >= exemption)) {
      if (active + (head ? 0 : this.waiters(rows).length) >= this.limit()) return false;
    }
    this.reserved.set(id, role);
    return true;
  }

  release(id: string): void {
    if (this.reserved.delete(id)) this.onRelease?.();
  }

  scheduleDrain(): void {
    this.onRelease?.();
  }

  enqueue(id: string): void {
    const meta = this.repo.find(id)?.startMeta;
    if (meta?.admission) {
      this.scheduleDrain();
      return;
    }
    const seq = (this.waiters().at(-1)?.seq ?? 0) + 1;
    this.repo.setStartMeta(id, () => ({
      ...(meta ?? emptyStartMeta()),
      admission: { seq, since: new Date().toISOString() },
    }));
    this.onRelease?.();
  }

  runNext(id: string): boolean {
    const waiters = this.waiters();
    const head = waiters[0];
    const meta = this.repo.find(id)?.startMeta;
    const admission = meta?.admission;
    if (!head || !admission || !waiters.some((entry) => entry.id === id)) return false;
    if (head.id !== id) {
      this.repo.setStartMeta(id, () => ({
        ...meta,
        admission: { ...admission, seq: head.seq - 1 },
      }));
    }
    this.scheduleDrain();
    return true;
  }

  dequeue(id: string): void {
    const meta = this.repo.find(id)?.startMeta;
    if (!meta?.admission) return;
    this.repo.setStartMeta(id, () => ({ ...meta, admission: null }));
    this.onRelease?.();
  }

  waiters(rows = this.repo.admissionRows()) {
    return rows
      .flatMap(({ id, status, meta }) =>
        meta?.admission ? [{ id, status, ...meta.admission }] : [],
      )
      .sort((a, b) => a.seq - b.seq);
  }

  free(except?: string): number {
    const rows = this.repo.admissionRows();
    const { active, agents, controls, exemption } = this.counts(rows);
    const credit =
      except && (agents.has(except) || (controls.has(except) && controls.size > exemption));
    return Math.max(0, this.limit() - active - this.waiters(rows).length) + (credit ? 1 : 0);
  }

  status(): AdmissionStatus {
    const rows = this.repo.admissionRows();
    const { active, controls } = this.counts(rows);
    return {
      limit: this.limit(),
      active,
      control: controls.size,
      waiting: this.waiters(rows).map(({ id, status, since }, index) => ({
        sessionId: id,
        kind: status === "queued" ? "start" : "turn",
        since,
        place: index + 1,
      })),
    };
  }

  private counts(rows: ReturnType<SessionRepo["admissionRows"]>) {
    // Check runs count toward the limit but never wait; several finishing at once can exceed it.
    const agents = new Set<string>();
    for (const id of this.checking()) agents.add(id);
    const controls = new Set<string>();
    for (const [id, role] of this.reserved) (role === "agent" ? agents : controls).add(id);
    for (const row of rows) {
      if (ACTIVE.has(row.status)) (row.role === "agent" ? agents : controls).add(row.id);
    }
    const exemption = 1 + this.projectCount();
    return {
      agents,
      controls,
      exemption,
      active: agents.size + Math.max(0, controls.size - exemption),
    };
  }
}
