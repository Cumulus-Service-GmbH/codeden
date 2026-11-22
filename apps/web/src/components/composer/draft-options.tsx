import type { ProjectCheck, ProviderInfo } from "@codeden/contracts";
import { supportsReadOnly } from "@/components/thread/autonomy";
import { type DraftChoice, pickModel, type ResolvedDraft } from "@/lib/new-session";
import { ChecksToggle } from "./checks-toggle";
import { ModelPicker } from "./model-picker/model-picker";
import { AutonomyPicker, PlanToggle } from "./pickers";
import { SaverPicker, TeamRolePicker } from "./team-saver-pickers";
import { WorkspacePicker } from "./workspace-picker";

/**
 * The New session draft's options: the same provider and model picker (provider unlocked, since
 * the session doesn't exist yet), effort, permissions and Plan as a session's composer, kept in
 * the draft until the first send starts the session with them. What is offered follows the
 * provider's capabilities: effort with `reasoningEffort`, Read-only where it is enforced, Plan
 * with `planMode` (elsewhere Plan stays, disabled with the reason, and the draft keeps the choice
 * for a provider that can plan). "Keep going until checks pass" shows when the project has checks
 * (`checks`) and the permissions let the agent fix things. A project folder that isn't a git
 * repository shows where the session runs instead of a worktree (`WorkspacePicker`).
 */
export function DraftOptions({
  providers,
  choice,
  resolved,
  checks,
  projectPath,
  onChange,
}: {
  providers: ProviderInfo[];
  /** The project's checks a new session would freeze. */
  checks: ProjectCheck[];
  choice: DraftChoice;
  resolved: ResolvedDraft;
  /** The project folder, named where the session runs in it. */
  projectPath: string;
  onChange: (next: DraftChoice) => void;
}) {
  const { provider } = resolved;
  const workspace = resolved.workspace === "repo_root" && <WorkspacePicker path={projectPath} />;
  if (!provider) {
    return (
      <>
        {workspace}
        <span className="px-2 text-xs text-muted-foreground">No agent provider ready</span>
      </>
    );
  }
  return (
    <>
      {workspace}
      <ModelPicker
        providers={providers}
        // The resolved choice, defaults included: what the first send starts.
        value={{ provider: provider.id, model: resolved.model, effort: resolved.effort }}
        shortcut
        onChange={(next) => onChange(pickModel(choice, next))}
      />
      <AutonomyPicker
        value={resolved.autonomy}
        heading="Permissions for the new session"
        readOnlySupported={supportsReadOnly(provider)}
        onChange={(autonomy) => onChange({ ...choice, autonomy })}
      />
      <PlanToggle
        value={resolved.planMode}
        unavailable={
          provider.capabilities.planMode
            ? undefined
            : { provider: provider.displayName, wasOn: choice.planMode, canSwitch: true }
        }
        onChange={(planMode) => onChange({ ...choice, planMode })}
      />
      <TeamRolePicker
        value={resolved.teamRole}
        onChange={(teamRole) => onChange({ ...choice, teamRole })}
      />
      {resolved.teamProviderMissing && (
        <span className="px-2 text-2xs text-destructive">
          The Team runs this role on {resolved.teamProviderMissing}, which isn't available here
        </span>
      )}
      <SaverPicker
        value={resolved.tokenSaver}
        onChange={(tokenSaver) => onChange({ ...choice, tokenSaver })}
      />
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
