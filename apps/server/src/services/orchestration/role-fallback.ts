import type { ProviderSwitchData } from "@codeden/contracts";
import { localDateTime } from "../automations/cron";

/** "Orchestrator" or "PM", to start a sentence about the role. */
export const roleName = (role: "orchestrator" | "pm") => (role === "pm" ? "PM" : "Orchestrator");

/**
 * The line shown in the role's chat and the inbox. `names` are the providers' names for people
 * (`from`, `to` and, for a reset, the provider whose limit reset).
 */
export function switchText(
  data: ProviderSwitchData,
  names: { from: string; to: string },
  tz: string,
): string {
  const until = data.retryAt ? ` (until ${localDateTime(new Date(data.retryAt), tz)})` : "";
  switch (data.reason) {
    case "usage_limit":
      return `Switched from ${names.from} to ${names.to}: ${names.from} hit its usage limit${until}.`;
    case "no_fallback":
      return `${names.from} hit its usage limit${until} and no eligible Team provider is ready to take over.`;
  }
}
