import {
  type Project,
  TechDebtAction,
  type TechDebtFinding,
  type TechDebtFindingInput,
  TechDebtIssue,
  type TechDebtList,
  type TechDebtSummary,
  TechDebtView,
} from "@codeden/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projectTechDebt, sessions } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { badRequest, errorMessage, notFound } from "../errors";
import { ACTIVE_SESSION_STATUSES } from "../sessions/conflicts";
import { debtId, issueFindings, syncDebtTick, type TechDebtIssuePort } from "./issue";

type StartFix = (project: Project, findings: TechDebtFinding[]) => Promise<string>;

function mergeFindings(existing: TechDebtFinding[], incoming: TechDebtFinding[]) {
  const ids = new Set(existing.map((finding) => finding.id));
  const identity = (finding: TechDebtFinding) => JSON.stringify([finding.location, finding.text]);
  const entries = new Set(existing.map(identity));
  const added = incoming.filter((finding) => {
    const key = identity(finding);
    if (ids.has(finding.id) || entries.has(key)) return false;
    ids.add(finding.id);
    entries.add(key);
    return true;
  });
  return added.length ? [...existing, ...added] : existing;
}

function recordFinding(input: TechDebtFindingInput, source: "backfill" | null): TechDebtFinding {
  return {
    ...input,
    id: debtId(`${input.location}\n${input.text}`),
    source,
    status: "open",
    sessionId: null,
    reason: null,
  };
}

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
      return this.mergeIssue(view, view.issue);
    });
  }

  importIssue(
    project: Project,
    issue: string,
    { seed, restrictToProject = false }: { seed?: string; restrictToProject?: boolean } = {},
  ): Promise<TechDebtView> {
    return this.inProject(project, async () => {
      const view = this.get(project.id);
      const target = TechDebtIssue.parse(issue);
      if (restrictToProject) {
        const repo =
          project.kind === "github" ? `${project.github.owner}/${project.github.repo}` : null;
        const [source] = target.toLowerCase().split("#");
        if (source !== repo?.toLowerCase() && target.toLowerCase() !== view.issue?.toLowerCase()) {
          throw badRequest("Use an issue from this project's repository or its tracking issue");
        }
      }
      if (seed && view.seeds.includes(seed)) return view;
      return this.mergeIssue(view, target, seed);
    });
  }

  backfill(project: Project, seed: string, inputs: TechDebtFindingInput[]): Promise<TechDebtView> {
    return this.inProject(project, async () => {
      const view = this.get(project.id);
      if (view.seeds.includes(seed)) return view;
      const findings = mergeFindings(
        view.findings,
        inputs.map((input) => recordFinding(input, "backfill")),
      );
      return this.save({ ...view, findings, seeds: [...view.seeds, seed] });
    });
  }

  summaries(projects: Project[]): TechDebtSummary[] {
    const views = new Map(
      this.db
        .select()
        .from(projectTechDebt)
        .all()
        .map((row) => [row.projectId, row.view]),
    );
    return projects
      .filter((project) => !project.archivedAt)
      .map(({ id: projectId }) => {
        const view = views.get(projectId);
        const open = view?.findings.filter((finding) => finding.status === "open").length ?? 0;
        return {
          projectId,
          open,
          ...(view?.importError === undefined ? {} : { importError: view.importError }),
        };
      });
  }

  private async mergeIssue(
    view: TechDebtView,
    issue: string,
    seed?: string,
  ): Promise<TechDebtView> {
    const configured = view.issue ?? issue;
    let result: Awaited<ReturnType<TechDebtIssuePort["read"]>>;
    try {
      result = await this.issues.read(issue);
    } catch (error) {
      const importError = errorMessage(error);
      return importError === view.importError && view.issue === configured
        ? view
        : this.save({ ...view, issue: configured, importError });
    }
    const findings = mergeFindings(view.findings, issueFindings(issue, result.body, result.date));
    const imported = view.imported || configured.toLowerCase() === issue.toLowerCase();
    if (
      !seed &&
      view.issue === configured &&
      view.imported === imported &&
      view.importError === undefined &&
      findings === view.findings
    )
      return view;
    const { importError: _importError, ...rest } = view;
    return this.save({
      ...rest,
      issue: configured,
      imported,
      findings,
      seeds: seed ? [...view.seeds, seed] : view.seeds,
    });
  }

  act(project: Project, input: TechDebtAction): Promise<TechDebtView> {
    return this.inProject(project, async () => {
      const action = TechDebtAction.parse(input);
      const view = this.get(project.id);
      switch (action.action) {
        case "configure": {
          if (action.issue === view.issue) return view;
          const { importError: _importError, ...rest } = view;
          return this.save({ ...rest, issue: action.issue, imported: false });
        }
        case "record": {
          const findings = mergeFindings(view.findings, [recordFinding(action.finding, null)]);
          return findings === view.findings ? view : this.save({ ...view, findings });
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
    const row = this.db
      .select()
      .from(projectTechDebt)
      .where(eq(projectTechDebt.projectId, projectId))
      .get();
    return TechDebtView.parse(
      row?.view ?? { projectId, issue: null, imported: false, findings: [] },
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
