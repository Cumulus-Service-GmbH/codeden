import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useProjectActions } from "@/lib/project-actions";
import { useSnapshot } from "@/lib/queries";
import { SettingRow, SettingsSection } from "./settings-ui";

/**
 * Settings > General: per project, whether providers the machine's security rules don't cover
 * (`capabilities.enforcesSecurityRules` false) may run its sessions
 * (`Project.allowUnenforcedProviders`). Off by default, which refuses them for every role.
 */
export function ProviderSecuritySettings() {
  const projects = useSnapshot().data?.projects;
  const { setAllowUnenforcedProviders } = useProjectActions();
  return (
    <SettingsSection
      title="Providers without enforced security rules"
      description="Some providers aren't covered by this machine's security rules (the guard on Claude Code sessions and Codex's execpolicy), so nothing stops them from doing what those rules forbid, such as reading secrets or writing to production. They're off for every project until you allow them for that project. Allow them only for projects that don't touch cloud resources, databases, secrets, production or app stores."
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
              onCheckedChange={(on) => void setAllowUnenforcedProviders(project, on)}
            />
          </SettingRow>
        ))
      )}
    </SettingsSection>
  );
}
