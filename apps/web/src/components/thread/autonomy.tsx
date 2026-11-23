import type { AutonomyLevel, ProviderInfo } from "@codeden/contracts";
import { Eye, type LucideIcon, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The permission levels of an agent session (§11.2), from Read-only to Full, with one plain
 * line each. Stored as `autonomy`; shown everywhere as "Permissions".
 */
export const AUTONOMY: Record<
  AutonomyLevel,
  { label: string; short: string; description: string; icon: LucideIcon; tone: string }
> = {
  read_only: {
    label: "Read-only",
    short: "Read-only",
    description: "Can read and run checks, but never edits files, commits or pushes.",
    icon: Eye,
    tone: "text-chart-1",
  },
  supervised: {
    label: "Supervised",
    short: "Supervised",
    description: "Asks before edits and commands.",
    icon: ShieldAlert,
    tone: "text-chart-2",
  },
  auto: {
    label: "Auto",
    short: "Auto",
    description: "Works freely in its worktree and asks only for risky actions.",
    icon: ShieldCheck,
    tone: "text-status-done",
  },
  full: {
    label: "Full",
    short: "Full",
    description: "Never asks.",
    icon: ShieldOff,
    tone: "text-status-waiting",
  },
};

/** The ladder in order, least to most permissive. */
export const AUTONOMY_LEVELS: AutonomyLevel[] = ["read_only", "supervised", "auto", "full"];

/**
 * Whether a provider can run the `read_only` level (`capabilities.readOnly`). Unknown
 * providers (not connected) are treated as able to, the server checks again at start.
 */
export function supportsReadOnly(provider: ProviderInfo | undefined): boolean {
  return provider ? provider.capabilities.readOnly === true : true;
}

/**
 * Whether a provider can enforce the `supervised` level (`capabilities.supervised` not false):
 * every edit and command reaches the user. Unknown providers are treated as able to.
 */
export function supportsSupervised(provider: ProviderInfo | undefined): boolean {
  return provider?.capabilities.supervised !== false;
}

/** Why Read-only is unavailable: the provider (by its display name) can't enforce it. */
export function readOnlyUnavailableReason(providerName: string | undefined): string {
  return `${providerName ?? "This provider"} can't enforce read-only.`;
}

/** Why Supervised is unavailable: the provider can't make every edit and command ask. */
export function supervisedUnavailableReason(providerName: string | undefined): string {
  return `${providerName ?? "This provider"} can't enforce Supervised: not every edit and command is sure to ask you.`;
}

export function AutonomyBadge({ level, className }: { level: AutonomyLevel; className?: string }) {
  const a = AUTONOMY[level];
  return (
    <span
      title={`Permissions: ${a.description}`}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-md border border-border/80 px-2 text-2xs text-muted-foreground",
        className,
      )}
    >
      <a.icon className={cn("size-3", a.tone)} />
      {a.short}
    </span>
  );
}

/**
 * Why a permission level is unavailable on the chosen provider, or null: Read-only and
 * Supervised need a provider that enforces them (its capabilities), named in the reason.
 */
export function levelUnavailableReason(
  level: AutonomyLevel,
  support: { readOnly: boolean; supervised: boolean },
  providerName: string | undefined,
): string | null {
  if (level === "read_only" && !support.readOnly) return readOnlyUnavailableReason(providerName);
  if (level === "supervised" && !support.supervised) {
    return supervisedUnavailableReason(providerName);
  }
  return null;
}
