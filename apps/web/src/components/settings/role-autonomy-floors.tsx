import {
  AutonomyLevel,
  REVIEW_TEAM_ROLES,
  roleAutonomyFloor,
  TEAM_ROLE_TAGS,
  type TeamRole,
} from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { AUTONOMY } from "@/components/thread/autonomy";
import { useClient } from "@/lib/api";
import { NETWORK_KEY } from "./network-password";
import { SettingRow, useSettings } from "./settings-ui";

const roles: [string, TeamRole | "agent"][] = [
  ["Agent (untagged)", "agent"],
  ...Object.entries(TEAM_ROLE_TAGS).map(([tag, role]): [string, TeamRole] => [
    tag.slice(1, -1),
    role,
  ]),
];

export function RoleAutonomyFloors() {
  const { settings, update } = useSettings();
  const client = useClient();
  const network = useQuery({ queryKey: NETWORK_KEY, queryFn: () => client.network.status() });
  const { roleFloors } = settings.autonomy;
  return (
    <SettingRow
      label="Role supervision floors"
      help="PM-started sessions inherit the project default unless the local role setting requires more supervision. The action guard still applies. Edit these settings from this computer."
      stacked
    >
      <ul className="divide-y divide-border">
        {roles.map(([label, role]) => {
          const review = role !== "agent" && REVIEW_TEAM_ROLES.has(role);
          const floor = roleAutonomyFloor(role, roleFloors);
          return (
            <li key={role} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <label className="text-sm" htmlFor={`role-autonomy-${role}`}>
                {label}
                <span className="block text-2xs text-muted-foreground">
                  {floor.source === "project"
                    ? "Project default"
                    : `${AUTONOMY[floor.level].label} · Local setting`}
                  {review ? " (read-only review scope)" : ""}
                </span>
              </label>
              <select
                id={`role-autonomy-${role}`}
                aria-label={`${label} supervision floor`}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                disabled={network.data?.remote !== false}
                value={roleFloors[role] ?? ""}
                onChange={(event) => {
                  const value = AutonomyLevel.safeParse(event.target.value);
                  update({
                    autonomy: { roleFloors: { [role]: value.success ? value.data : null } },
                  });
                }}
              >
                <option value="">Inherit project default</option>
                {AutonomyLevel.options.map((level) => (
                  <option key={level} value={level}>
                    {AUTONOMY[level].label}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </SettingRow>
  );
}
