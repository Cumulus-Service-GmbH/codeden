import type { ProjectCheck, ProviderInfo } from "@codeden/contracts";
import { supportsReadOnly } from "@/components/thread/autonomy";
import { type DraftChoice, pickModel, type ResolvedDraft } from "@/lib/new-session";
import { ChecksToggle } from "./checks-toggle";
import { ModelPicker } from "./model-picker/model-picker";
import { AutonomyPicker, PlanToggle } from "./pickers";

/**
 * The New session draft's options: the same provider and model picker (provider unlocked, since
 * the session doesn't exist yet), effort, permissions and Plan as a session's composer, kept in
 * the draft until the first send starts the session with them. What is offered follows the
 * provider's capabilities: effort with `reasoningEffort`, Read-only where it is enforced, Plan
 * with `planMode`. "Keep going until checks pass" shows when the project has checks (`checks`)
 * and the permissions let the agent fix things.
 */
export function DraftOptions({
  providers,
  choice,
  resolved,
  checks,
  onChange,
}: {
  providers: ProviderInfo[];
  /** The project's checks a new session would freeze. */
  checks: ProjectCheck[];
  choice: DraftChoice;
  resolved: ResolvedDraft;
  onChange: (next: DraftChoice) => void;
}) {
  const { provider } = resolved;
  if (!provider) {
    return <span className="px-2 text-xs text-muted-foreground">No agent provider ready</span>;
  }
  return (
    <>
      <ModelPicker
        providers={providers}
        // The resolved choice, defaults included: what the first send starts.
        value={{ provider: provider.id, model: resolved.model, effort: resolved.effort }}
        shortcut
        onChange={(next) => onChange(pickModel(choice, next, providers))}
      />
      <AutonomyPicker
        value={resolved.autonomy}
        heading="Permissions for the new session"
        readOnlySupported={supportsReadOnly(provider)}
        onChange={(autonomy) => onChange({ ...choice, autonomy })}
      />
      {provider.capabilities.planMode && (
        <PlanToggle
          value={resolved.planMode}
          onChange={(planMode) => onChange({ ...choice, planMode })}
        />
      )}
      {checks.length > 0 && resolved.autonomy !== "read_only" && (
        <ChecksToggle
          checks={checks}
          value={{ untilPass: resolved.untilChecksPass, maxRounds: resolved.checkRounds }}
          onChange={(next) =>
            onChange({ ...choice, untilChecksPass: next.untilPass, checkRounds: next.maxRounds })
          }
        />
      )}
    </>
  );
}
