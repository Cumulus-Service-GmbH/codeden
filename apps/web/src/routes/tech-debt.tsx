import { Link } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { TechDebtBadge } from "@/components/project/tech-debt-badge";
import { ProjectTile } from "@/components/shell/sidebar/project-group";
import { useSnapshot } from "@/lib/queries";
import { useTechDebtSummaries } from "@/lib/tech-debt-queries";
import { PageHeader } from "./page-header";

export function TechDebtPage() {
  const snapshot = useSnapshot();
  const summaries = useTechDebtSummaries();
  const projects = snapshot.data?.projects.filter((project) => !project.archivedAt) ?? [];
  const byProject = new Map(summaries.data?.map((summary) => [summary.projectId, summary]));
  const error = snapshot.error ?? summaries.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={<ListTodo />} title="Tech debt" />
      <div className="min-h-0 overflow-auto p-4 sm:p-5">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
        {(snapshot.isPending || summaries.isPending) && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading tech debt…
          </p>
        )}
        {snapshot.isSuccess && projects.length === 0 && (
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        )}
        {summaries.data && projects.length > 0 && (
          <ul className="max-w-3xl divide-y divide-border overflow-hidden rounded-lg border border-border">
            {projects.map((project) => {
              const { open = 0, importError } = byProject.get(project.id) ?? {};
              return (
                <li key={project.id}>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.id }}
                    search={{ tab: "tech_debt" }}
                    className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  >
                    <ProjectTile project={project} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{project.name}</p>
                      {importError && (
                        <p className="mt-1 break-words text-xs text-destructive">{importError}</p>
                      )}
                    </div>
                    {open > 0 ? (
                      <TechDebtBadge count={open} />
                    ) : (
                      <span
                        role="img"
                        aria-label="0 open tech debt"
                        className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums"
                      >
                        0
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
