import { AutonomyLevel, type AutonomyPolicy, type TeamRole } from "@codeden/contracts";
import { badRequest } from "../errors";

export function stricter(a?: AutonomyLevel, b?: AutonomyLevel): AutonomyLevel | undefined {
  if (!a || !b) return a ?? b;
  return AutonomyLevel.options.indexOf(a) <= AutonomyLevel.options.indexOf(b) ? a : b;
}

function purposeTokens(purpose: string): string {
  return (purpose.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

export function resolveAutonomy(
  role: TeamRole | null,
  purpose: string,
  ...policies: (AutonomyPolicy | undefined)[]
): AutonomyLevel | undefined {
  const key = purpose.trim().toLowerCase();
  const gated = /\b(prd|prod|production|provision\w*|migrat\w*|install\w*)\b/i.test(key);
  const tokens = ` ${purposeTokens(key)} `;
  return policies.reduce<AutonomyLevel | undefined>(
    (floor, policy) => {
      const rules = policy?.[role ?? "agent"];
      let level: AutonomyLevel | undefined;
      for (const [name, rule] of Object.entries(rules ?? {})) {
        const phrase = purposeTokens(name);
        if (phrase && tokens.includes(` ${phrase} `)) level = stricter(level, rule);
      }
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
