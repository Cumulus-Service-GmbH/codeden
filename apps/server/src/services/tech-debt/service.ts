import {
  type NewEvent,
  type Project,
  TechDebtAction,
  type TechDebtFinding,
  type TechDebtFindingInput,
  TechDebtIssue,
  type TechDebtList,
  type TechDebtResolution,
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

function mergeFindings(
  existing: TechDebtFinding[],
  incoming: TechDebtFinding[],
  ignoreCase = false,
) {
  const ids = new Set(existing.map((finding) => finding.id));
  const identity = ({ location, text }: TechDebtFinding) =>
    JSON.stringify(ignoreCase ? [location.toLowerCase(), text.toLowerCase()] : [location, text]);
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

function recordFinding(input: TechDebtFindingInput): TechDebtFinding {
  return {
    ...input,
    id: debtId(`${input.location}\n${input.text}`),
    source: null,
    status: "open",
    sessionId: null,
    reason: null,
  };
}

function isClosed({ status }: TechDebtFinding) {
  return status === "fixed" || status === "dismissed";
}

function resolutionEvent(
  projectId: string,
  sessionId: string | null,
  resolution: Omit<TechDebtResolution, "receipt" | "reason"> & {
    receipt: string | null;
    reason: string | null;
  },
): NewEvent {
  return { type: "tech_debt.resolved", sessionId, payload: { projectId, ...resolution } };
}

function failedIssue(view: TechDebtView) {
  // Older views stored the error without an issue reference.
  return view.importErrorIssue ?? (view.importError === undefined ? null : view.issue);
}

function clearImportError({
  importError: _error,
  importErrorIssue: _issue,
  ...view
}: TechDebtView) {
  return view;
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
      const issue = view.importErrorIssue ?? (view.imported ? null : view.issue);
      return issue ? (await this.mergeIssue(view, issue)).view : view;
    });
  }

  importIssue(
    project: Project,
    issue: string,
    { restrictToProject = false }: { restrictToProject?: boolean } = {},
  ): Promise<TechDebtView> {
    return this.inProject(project, async () => {
      const view = this.get(project.id);
      return (
        await this.mergeIssue(view, this.importTarget(project, view, issue, restrictToProject))
      ).view;
    });
  }

  importCounts(project: Project, issue: string, restrictToProject: boolean) {
    return this.inProject(project, async () => {
      const view = this.get(project.id);
      const target = this.importTarget(project, view, issue, restrictToProject);
      const result = await this.mergeIssue(view, target);
      if (result.error !== undefined) throw badRequest(result.error);
      const imported = result.view.findings.length - view.findings.length;
      return { imported, duplicates: result.entries - imported };
    });
  }

  private importTarget(project: Project, view: TechDebtView, issue: string, restrict: boolean) {
    const target = TechDebtIssue.parse(issue);
    if (restrict) {
      const repo =
        project.kind === "github" ? `${project.github.owner}/${project.github.repo}` : null;
      const [source] = target.toLowerCase().split("#");
      if (source !== repo?.toLowerCase() && target.toLowerCase() !== view.issue?.toLowerCase()) {
        throw badRequest("Use an issue from this project's repository or its tracking issue");
      }
    }
    return target;
  }

  recordMany(project: Project, rows: TechDebtFindingInput[]) {
    return this.inProject(project, async () => {
      const view = this.get(project.id);
      const findings = mergeFindings(view.findings, rows.map(recordFinding));
      const recorded = findings.length - view.findings.length;
      if (recorded) this.save({ ...view, findings });
      return { recorded, duplicates: rows.length - recorded };
    });
  }

  resolve(project: Project, resolutions: TechDebtResolution[], sessionId: string | null) {
    return this.inProject(project, async () => {
      const view = this.get(project.id);
      const findings = new Map(view.findings.map((finding) => [finding.id, finding]));
      const prefixes = new Map<string, string | null>();
      for (const id of findings.keys()) {
        const prefix = id.slice(0, 8);
        prefixes.set(prefix, prefixes.has(prefix) ? null : id);
      }
      const audit: NewEvent[] = [];
      let unknown = 0;
      let alreadyResolved = 0;
      for (const { id, status, reason, receipt } of resolutions) {
        // The ledger also accepts unambiguous eight-character IDs used in disposition reports.
        const target =
          findings.get(id) ?? (id.length === 8 ? findings.get(prefixes.get(id) ?? "") : undefined);
        if (!target) {
          unknown++;
        } else if (isClosed(target)) {
          alreadyResolved++;
        } else {
          findings.set(target.id, { ...target, status, reason, resolutionReceipt: receipt });
          audit.push(
            resolutionEvent(project.id, sessionId, { id: target.id, status, reason, receipt }),
          );
        }
      }
      if (audit.length) this.save({ ...view, findings: [...findings.values()] }, audit);
      return { resolved: audit.length, unknown, alreadyResolved };
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

  private async mergeIssue(view: TechDebtView, issue: string) {
    const target = issue.toLowerCase();
    let result: Awaited<ReturnType<TechDebtIssuePort["read"]>>;
    try {
      result = await this.issues.read(issue);
    } catch (error) {
      const importError = errorMessage(error);
      const unchanged =
        importError === view.importError && failedIssue(view)?.toLowerCase() === target;
      return {
        view: unchanged ? view : this.save({ ...view, importError, importErrorIssue: issue }),
        error: importError,
      };
    }
    const entries = issueFindings(issue, result.body, result.date);
    const findings = mergeFindings(view.findings, entries, true);
    const imported = view.imported || view.issue?.toLowerCase() === target;
    const clearsError = failedIssue(view)?.toLowerCase() === target;
    if (!clearsError && imported === view.imported && findings === view.findings) {
      return { view, entries: entries.length };
    }
    return {
      view: this.save({
        ...(clearsError ? clearImportError(view) : view),
        imported,
        findings,
      }),
      entries: entries.length,
    };
  }

  act(project: Project, input: TechDebtAction): Promise<TechDebtView> {
    return this.inProject(project, async () => {
      const action = TechDebtAction.parse(input);
      const view = this.get(project.id);
      switch (action.action) {
        case "configure": {
          if (action.issue === view.issue) return view;
          const failed = failedIssue(view)?.toLowerCase();
          const clearsError =
            failed &&
            view.issue?.toLowerCase() === failed &&
            action.issue?.toLowerCase() !== failed;
          return this.save({
            ...(clearsError ? clearImportError(view) : view),
            issue: action.issue,
            imported: false,
          });
        }
        case "record": {
          const findings = mergeFindings(view.findings, [recordFinding(action.finding)]);
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
          if (isClosed(finding)) {
            throw badRequest("This finding is already closed");
          }
          const issue = view.issue;
          if (issue && (!finding.source || finding.source.toLowerCase() === issue.toLowerCase())) {
            await this.serial(`issue:${issue.toLowerCase()}`, () =>
              syncDebtTick(this.issues, issue, finding),
            );
          }
          return this.save(
            {
              ...view,
              findings: view.findings.map((row) =>
                row.id === finding.id ? { ...row, status, reason } : row,
              ),
            },
            [resolutionEvent(project.id, null, { id: finding.id, status, reason, receipt: null })],
          );
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

  private save(view: TechDebtView, audit: NewEvent[] = []): TechDebtView {
    this.store.append([
      ...audit,
      { type: "tech_debt.updated", sessionId: null, payload: { view } },
    ]);
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
