import type { AdmissionStatus, Session } from "@codeden/contracts";
import { emptyStartMeta, type SessionRepo } from "./repo";

const ACTIVE = new Set(["starting", "running", "waiting"]);

export class SessionAdmission {
  private readonly reserved = new Map<string, Session["role"]>();
  private readonly held = new Set<string>();

  constructor(
    private readonly repo: SessionRepo,
    private readonly limit: () => number,
    private readonly projectCount: () => number,
    private readonly onRelease?: () => void,
  ) {}

  tryReserve(id: string, role: Session["role"], head = false): boolean {
    const { agents, controls, active, exemption } = this.counts();
    if (agents.has(id) || controls.has(id)) return true;
    if (role === "agent" || controls.size >= exemption) {
      if (active >= this.limit() || (!head && this.waiters().length > 0)) return false;
    }
    this.reserved.set(id, role);
    return true;
  }

  release(id: string): void {
    if (this.reserved.delete(id)) this.onRelease?.();
  }

  hold(id: string): void {
    this.held.add(id);
  }

  unhold(id: string): void {
    if (this.held.delete(id)) this.onRelease?.();
  }

  scheduleDrain(): void {
    this.onRelease?.();
  }

  isHeld(id: string): boolean {
    return this.held.has(id);
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

  dequeue(id: string): void {
    const meta = this.repo.find(id)?.startMeta;
    if (!meta?.admission) return;
    this.repo.setStartMeta(id, () => ({ ...meta, admission: null }));
    this.onRelease?.();
  }

  waiters() {
    return this.repo
      .admissionRows()
      .flatMap(({ id, status, meta }) =>
        meta?.admission ? [{ id, status, ...meta.admission }] : [],
      )
      .sort((a, b) => a.seq - b.seq);
  }

  free(): number {
    return Math.max(0, this.limit() - this.counts().active - this.waiters().length);
  }

  status(): AdmissionStatus {
    const { active, controls } = this.counts();
    return {
      limit: this.limit(),
      active,
      control: controls.size,
      waiting: this.waiters().map(({ id, status, since }, index) => ({
        sessionId: id,
        kind: status === "queued" ? "start" : "turn",
        since,
        place: index + 1,
      })),
    };
  }

  private counts() {
    const agents = new Set(this.held);
    const controls = new Set<string>();
    for (const [id, role] of this.reserved) (role === "agent" ? agents : controls).add(id);
    for (const row of this.repo.admissionRows()) {
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
