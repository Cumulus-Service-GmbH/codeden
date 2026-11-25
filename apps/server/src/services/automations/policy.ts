import type { Automation, GitHubIssueRef, Project, Settings } from "@codeden/contracts";
import { conflict } from "../errors";
import { githubCloneUrl } from "../git-broker";
import { sameGithubRepo } from "../projects/reconcile";

const AUDITED_TEMPLATES = new Set([
  "dependency-updates",
  "issue-triage",
  "security-audit",
  "stale-pr-follow-up",
  "test-coverage",
]);

export function auditedAutomation(automation: Pick<Automation, "templateId"> | undefined) {
  return Boolean(automation?.templateId && AUDITED_TEMPLATES.has(automation.templateId));
}

export function automationBlocked(
  project: Project,
  settings: Pick<Settings, "automations" | "factory">,
  projectEnabled: boolean,
): string | null {
  if (project.archivedAt || !settings.automations.enabled || !projectEnabled) {
    return "Automations are off for this project.";
  }
  if (project.killSwitch || settings.factory.killSwitch) return "The factory kill switch is on.";
  return null;
}

export function automationFork(project: Project) {
  const fork = project.kind === "github" ? project.github.forkRemote : undefined;
  if (!fork || project.kind !== "github") {
    throw conflict(
      "Configure this project's automation fork remote first.",
      "automation_fork_required",
    );
  }
  if (fork.remote.toLowerCase() === "origin" || sameGithubRepo(project.github, fork)) {
    throw conflict(
      "The automation fork remote must differ from upstream origin.",
      "automation_upstream",
    );
  }
  return {
    ...fork,
    remoteUrl: githubCloneUrl(fork.owner, fork.repo),
    defaultBranch: project.github.defaultBranch,
  };
}

export function isForkIssue(issue: GitHubIssueRef, fork: ReturnType<typeof automationFork>) {
  return (
    issue.url.toLowerCase() ===
    `https://github.com/${fork.owner}/${fork.repo}/issues/${issue.number}`.toLowerCase()
  );
}
