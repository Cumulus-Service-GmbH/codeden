import {
  AutonomyLevel,
  type AutonomyPolicy,
  autonomyPolicyReason,
  type Session,
  type TeamRole,
  teamRoleOfTitle,
} from "@codeden/contracts";
import type { AppServices } from "../container";
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

/** The PM must satisfy the policy at launch and the policies in force now. */
export function sessionAutonomyFloor(
  { factory, sessionRepo, settings }: Pick<AppServices, "factory" | "sessionRepo" | "settings">,
  session: Session,
): AutonomyLevel | undefined {
  const current = resolveAutonomy(
    teamRoleOfTitle(session.title ?? undefined),
    session.purpose,
    settings.get().autonomy.pmPolicy,
    session.projectId ? factory.data.loop(session.projectId)?.tuning.autonomyPolicy : undefined,
  );
  return stricter(current, sessionRepo.find(session.id)?.startMeta?.autonomyFloor);
}

export function assertAutonomy(
  requested: AutonomyLevel | undefined,
  floor: AutonomyLevel | undefined,
): void {
  const reason = requested && autonomyPolicyReason(requested, floor);
  if (reason) throw badRequest(reason, "autonomy_policy");
}
