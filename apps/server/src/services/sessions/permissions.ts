import type { AutonomyLevel, ProviderInfo, Role } from "@codeden/contracts";

/**
 * Why a session cannot use a permission level on a provider, or null when it can. The
 * `read_only` level needs a provider that enforces it natively (`capabilities.readOnly`,
 * §11.2). Read-only roles (orchestrator, PMs) are read-only at every level, so they need it
 * too: a provider that says it can't enforce read-only (`readOnly: false`) can't run them. An
 * unknown provider (the runner is not connected yet) is let through: the provider refuses at
 * start.
 */
export function readOnlyUnsupported(
  role: Role,
  level: AutonomyLevel,
  provider: ProviderInfo | undefined,
): string | null {
  if (!provider) return null;
  if (role !== "agent") {
    if (provider.capabilities.readOnly !== false) return null;
    return `${provider.displayName} can't run a ${role === "pm" ? "PM" : "orchestrator"}: those are read-only, and it can't enforce read-only`;
  }
  if (level !== "read_only") return null;
  if (provider.capabilities.readOnly) return null;
  return `${provider.displayName} cannot run sessions with read-only permissions`;
}

/**
 * Why a session cannot use plan mode, or null when it can: agent sessions only, on a provider
 * that reports `capabilities.planMode` (never decided by provider id). An unknown provider
 * (the runner is not connected yet) is let through, as for `read_only`.
 */
export function planModeUnsupported(role: Role, provider: ProviderInfo | undefined): string | null {
  if (role !== "agent") return "Only agent sessions have plan mode";
  if (!provider || provider.capabilities.planMode) return null;
  return `${provider.displayName} has no plan mode`;
}

/**
 * Why a session cannot use the `supervised` level on a provider, or null when it can: the
 * provider must enforce it (`capabilities.supervised` not false), since Supervised promises
 * that every edit and command reaches the user. An unknown provider is let through, as above.
 */
export function supervisedUnsupported(
  level: AutonomyLevel,
  provider: ProviderInfo | undefined,
): string | null {
  if (level !== "supervised" || !provider || provider.capabilities.supervised !== false) {
    return null;
  }
  return `${provider.displayName} can't enforce Supervised: not every edit and command is sure to reach you`;
}

/**
 * Why a project's sessions cannot run on a provider for which the machine's security rules
 * aren't enforced (`capabilities.enforcesSecurityRules` not true: absent counts as not enforced),
 * or null when they can: every role, unless the project allows such providers
 * (`Project.allowUnenforcedProviders`, off by default). The orchestrator never can. Fail closed:
 * nothing looks at what the work is. An unknown provider (the runner not connected yet) is let
 * through here; the runner refuses it at start the same way.
 */
export function securityRulesUnenforced(
  provider: ProviderInfo | undefined,
  project: { allowUnenforcedProviders: boolean } | null | undefined,
  role: Role,
): string | null {
  if (!provider || provider.capabilities.enforcesSecurityRules === true) return null;
  // The orchestrator never takes a project's exception, even when one is named.
  if (role !== "orchestrator" && project?.allowUnenforcedProviders) return null;
  return `${provider.displayName} isn't covered by this machine's security rules, so this project doesn't allow it. Turn on "Allow providers without enforced security rules" in the project's settings to use it.`;
}
