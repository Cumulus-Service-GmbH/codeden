import { AutonomyLevel, type AutonomyPolicy, type TeamRole } from "@codeden/contracts";
import { badRequest } from "../errors";

function stricter(a?: AutonomyLevel, b?: AutonomyLevel): AutonomyLevel | undefined {
  if (!a || !b) return a ?? b;
  return AutonomyLevel.options.indexOf(a) <= AutonomyLevel.options.indexOf(b) ? a : b;
}

export function resolveAutonomy(
  role: TeamRole | null,
  purpose: string,
  ...policies: (AutonomyPolicy | undefined)[]
): AutonomyLevel | undefined {
  const key = purpose.trim().toLowerCase();
  const gated = /\b(prd|prod|production|provision\w*|migrat\w*|install\w*)\b/i.test(key);
  return policies.reduce<AutonomyLevel | undefined>(
    (floor, policy) => {
      const rules = policy?.[role ?? "agent"];
      const level = Object.entries(rules ?? {}).find(([name]) => name.toLowerCase() === key)?.[1];
      return stricter(floor, level ?? rules?.["*"]);
    },
    gated ? "supervised" : undefined,
  );
}

export function assertAutonomy(
  requested: AutonomyLevel | undefined,
  floor: AutonomyLevel | undefined,
): void {
  if (requested && floor && stricter(requested, floor) !== requested) {
    throw badRequest(
      `Autonomy policy requires ${floor} or more supervision. Requested ${requested}.`,
      "autonomy_policy",
    );
  }
}
