import type { Project } from "@codeden/contracts";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useProjectActions } from "@/lib/project-actions";
import { useSnapshot, useSnapshotData } from "@/lib/queries";
import { SettingRow, SettingsSection } from "./settings-ui";

/**
 * Settings > General: per project, whether providers the machine's security rules don't cover
 * (`capabilities.enforcesSecurityRules` not true, named in the section) may run its sessions
 * (`Project.allowUnenforcedProviders`). Off by default, which refuses them for every role.
 */
export function ProviderSecuritySettings() {
  const projects = useSnapshot().data?.projects;
  const providers = useSnapshotData((s) => s.runner.providers, []);
  // Named from their capabilities: every provider that doesn't declare the rules enforced.
  const uncovered = providers
    .filter((p) => p.capabilities.enforcesSecurityRules !== true)
    .map((p) => p.displayName);
  const { setAllowUnenforcedProviders } = useProjectActions();
  // One change at a time per project, so an earlier request can't land after a later one.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const change = async (project: Project, on: boolean) => {
    setSaving((s) => new Set(s).add(project.id));
    try {
      await setAllowUnenforcedProviders(project, on);
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(project.id);
        return next;
      });
    }
  };
  return (
    <SettingsSection
      title="Providers without enforced security rules"
      description={`Some providers aren't covered by this machine's security rules (the guard on Claude Code sessions and Codex's execpolicy), so nothing stops them from doing what those rules forbid, such as reading secrets or writing to production. They're off for every project until you allow them for that project. Allow them only for projects that don't touch cloud resources, databases, secrets, production or app stores.${uncovered.length ? ` On this machine: ${uncovered.join(", ")}.` : ""}`}
    >
      {projects === undefined ? (
        <div className="px-4 py-3.5" role="status" aria-label="Loading projects">
          <Skeleton className="h-4 w-1/3" />
        </div>
      ) : projects.length === 0 ? (
        <p className="px-4 py-3.5 text-2xs text-muted-foreground">
          Add a project to choose this per project.
        </p>
      ) : (
        projects.map((project) => (
          <SettingRow
            key={project.id}
            label={project.name}
            help={
              project.allowUnenforcedProviders
                ? "Allowed: such providers can run this project's sessions."
                : "Not allowed: such providers are refused for every role in this project."
            }
          >
            <Switch
              aria-label={`Allow providers without enforced security rules in ${project.name}`}
              checked={project.allowUnenforcedProviders}
              disabled={saving.has(project.id)}
              onCheckedChange={(on) => void change(project, on)}
            />
          </SettingRow>
        ))
      )}
    </SettingsSection>
  );
}
