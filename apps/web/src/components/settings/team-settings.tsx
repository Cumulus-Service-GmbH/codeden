import { type Settings, TeamRole, teamMember, teamRoleName } from "@codeden/contracts";
import { useState } from "react";
import { TeamEditor } from "@/components/factory/team-editor";
import { useSnapshot, useTeamDiagnostics } from "@/lib/queries";
import { SettingRow, SettingsSection } from "./settings-ui";

export function TeamSettings() {
  const setup = useSnapshot().data?.settings.teamSetup;
  return (
    <>
      <EffectiveTeam />
      {setup && <DefaultTeamEditor key={JSON.stringify(setup)} setup={setup} />}
    </>
  );
}

function DefaultTeamEditor({ setup }: { setup: Settings["teamSetup"] }) {
  const [draft, setDraft] = useState(setup);
  return <TeamEditor tuning={draft} onChange={setDraft} />;
}

const SOURCE = { default: "Default Team", project: "Project Team", session: "Session" };

export function EffectiveTeam({ projectId }: { projectId?: string }) {
  const diagnostics = useTeamDiagnostics(projectId);
  return (
    <SettingsSection title={projectId ? "Effective Team" : "Default Team"}>
      {diagnostics.isPending && <p className="text-xs text-muted-foreground">Loading Team…</p>}
      {diagnostics.isError && (
        <p role="alert" className="text-xs">
          Could not load Team.
        </p>
      )}
      {diagnostics.data &&
        TeamRole.options.map((role) => {
          const member = teamMember(diagnostics.data.team, role);
          const source = diagnostics.data.sources[role];
          const count = diagnostics.data.overrides[role] ?? 0;
          return (
            <SettingRow
              key={role}
              label={teamRoleName(role)}
              help={
                projectId
                  ? source && SOURCE[source]
                  : `Overridden in ${count} ${count === 1 ? "project" : "projects"}`
              }
            >
              <span className="break-all text-right text-xs text-muted-foreground">
                {member
                  ? [
                      member.provider,
                      member.model ?? "Provider default",
                      member.effort ?? "Provider default",
                    ].join(" / ")
                  : "Unset"}
              </span>
            </SettingRow>
          );
        })}
    </SettingsSection>
  );
}
