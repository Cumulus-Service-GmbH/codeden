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

const sources = { default: "Built-in default", policy: "Global policy", local: "Local setting" };

export function RoleAutonomyFloors() {
  const { settings, update } = useSettings();
  const client = useClient();
  const network = useQuery({ queryKey: NETWORK_KEY, queryFn: () => client.network.status() });
  const { roleFloors, pmPolicy } = settings.autonomy;
  return (
    <SettingRow
      label="Role supervision floors"
      help="These floors apply to PM-started sessions. Review-only work without a write scope defaults to Full with read-only access. Work scoped outside the project is capped at Auto. Project and purpose rules can require more supervision. Edit these settings from this computer."
      stacked
    >
      <ul className="divide-y divide-border">
        {roles.map(([label, role]) => {
          const review = role !== "agent" && REVIEW_TEAM_ROLES.has(role);
          const floor = roleAutonomyFloor(role, roleFloors, pmPolicy, review ? "full" : undefined);
          return (
            <li key={role} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <label className="text-sm" htmlFor={`role-autonomy-${role}`}>
                {label}
                <span className="block text-2xs text-muted-foreground">
                  {AUTONOMY[floor.level].label} · {sources[floor.source]}
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
                <option value="">Inherit default</option>
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
