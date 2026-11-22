import {
  type Project,
  TechDebtAction,
  type TechDebtFinding,
  type TechDebtList,
  type TechDebtView,
} from "@codeden/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projectTechDebt, sessions } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { badRequest, errorMessage, notFound } from "../errors";
import { ACTIVE_SESSION_STATUSES } from "../sessions/conflicts";
import { debtId, issueFindings, syncDebtTick, type TechDebtIssuePort } from "./issue";

type StartFix = (project: Project, findings: TechDebtFinding[]) => Promise<string>;

export class TechDebtService {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
    private readonly issues: TechDebtIssuePort,
    private readonly startFix: StartFix,
  ) {}

  list(project: Project): Promise<TechDebtList> {
    return this.inProject(project, async () => {
      const view = this.get(project.id);
      if (!view.issue || view.imported) return view;
      let issue: Awaited<ReturnType<TechDebtIssuePort["read"]>>;
      try {
        issue = await this.issues.read(view.issue);
      } catch (error) {
        return { ...view, importError: errorMessage(error) };
      }
      const findings = new Map(view.findings.map((finding) => [finding.id, finding]));
      for (const finding of issueFindings(view.issue, issue.body, issue.date)) {
        if (!findings.has(finding.id)) findings.set(finding.id, finding);
      }
      return this.save({ ...view, imported: true, findings: [...findings.values()] });
    });
  }

  act(project: Project, input: TechDebtAction): Promise<TechDebtView> {
    return this.inProject(project, async () => {
      const action = TechDebtAction.parse(input);
      const view = this.get(project.id);
      switch (action.action) {
        case "configure":
          return action.issue === view.issue
            ? view
            : this.save({ ...view, issue: action.issue, imported: false });
        case "record": {
          const id = debtId(JSON.stringify(action.finding));
          if (view.findings.some((finding) => finding.id === id)) return view;
          const finding: TechDebtFinding = {
            ...action.finding,
            id,
            source: null,
            status: "open",
            sessionId: null,
            reason: null,
          };
          return this.save({ ...view, findings: [...view.findings, finding] });
        }
        case "fix": {
          const selected = action.ids.map((id) => this.find(view, id));
          if (selected.some((finding) => !this.canStartFix(finding))) {
            throw badRequest("Select open findings or wait for their current fix sessions to end");
          }
          const sessionId = await this.startFix(project, selected);
          const ids = new Set(action.ids);
          return this.save({
            ...view,
            findings: view.findings.map((finding) =>
              ids.has(finding.id) ? { ...finding, sessionId, status: "in_progress" } : finding,
            ),
          });
        }
        case "fixed":
        case "dismiss": {
          const finding = this.find(view, action.id);
          const status = action.action === "fixed" ? "fixed" : "dismissed";
          const reason = action.action === "dismiss" ? action.reason : null;
          if (finding.status === status && finding.reason === reason) return view;
          if (finding.status === "fixed" || finding.status === "dismissed") {
            throw badRequest("This finding is already closed");
          }
          const issue = view.issue;
          if (issue && (!finding.source || finding.source.toLowerCase() === issue.toLowerCase())) {
            await this.serial(`issue:${issue.toLowerCase()}`, () =>
              syncDebtTick(this.issues, issue, finding),
            );
          }
          return this.save({
            ...view,
            findings: view.findings.map((row) =>
              row.id === finding.id ? { ...row, status, reason } : row,
            ),
          });
        }
      }
    });
  }

  private canStartFix(finding: TechDebtFinding): boolean {
    if (finding.status === "open") return true;
    if (finding.status !== "in_progress") return false;
    if (!finding.sessionId) return true;
    const activeSession = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, finding.sessionId),
          inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
        ),
      )
      .get();
    return !activeSession;
  }

  private get(projectId: string): TechDebtView {
    return (
      this.db.select().from(projectTechDebt).where(eq(projectTechDebt.projectId, projectId)).get()
        ?.view ?? { projectId, issue: null, imported: false, findings: [] }
    );
  }

  private save(view: TechDebtView): TechDebtView {
    this.store.append([{ type: "tech_debt.updated", sessionId: null, payload: { view } }]);
    return view;
  }

  private find(view: TechDebtView, id: string): TechDebtFinding {
    const finding = view.findings.find((row) => row.id === id);
    if (!finding) throw notFound("Tech debt finding not found");
    return finding;
  }

  private async inProject<T>(project: Project, operation: () => Promise<T>): Promise<T> {
    if (project.archivedAt) throw badRequest("Project is archived");
    return this.serial(`project:${project.id}`, operation);
  }

  private async serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.pending.get(key) ?? Promise.resolve()).then(operation, operation);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
    }
  }
}
