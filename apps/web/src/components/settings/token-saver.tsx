import type { Project, Role, SettingsPatch, TokenSaverLevel } from "@codeden/contracts";
import { useClient } from "@/lib/api";
import { useSnapshotData } from "@/lib/queries";
import { Segmented, SettingRow, SettingsSection, useSettings } from "./settings-ui";

const INHERIT = "inherit";
const LEVELS: { value: TokenSaverLevel; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "lite", label: "Lite" },
  { value: "full", label: "Full" },
  { value: "ultra", label: "Ultra" },
];
const ROLES: { role: Role; label: string }[] = [
  { role: "orchestrator", label: "Orchestrator" },
  { role: "pm", label: "Project managers" },
  { role: "agent", label: "Agent sessions" },
];

/** Providers whose system prompt holds for the whole conversation (`capabilities.systemPrompt`). */
function useCoveredProviders(): string {
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const names = providers.filter((p) => p.capabilities.systemPrompt).map((p) => p.displayName);
  return names.length > 0 ? names.join(", ") : "providers that keep it for the whole conversation";
}

/** Settings > General: the token saver's global level and per-role defaults (#602). */
export function TokenSaverSettingsSection() {
  const { settings, update } = useSettings();
  const covered = useCoveredProviders();
  const ts = settings.tokenSaver;
  return (
    <SettingsSection
      title="Token saver"
      description={`Adds a short note to each session's system prompt: answer tersely, write the least code, search narrowly. Exact technical terms and the words not, never, no and only are kept, and security warnings, irreversible steps and text that leaves the session stay in full sentences. Lite is the mildest; Full and Ultra cut more prose. Applies to sessions started or resumed after a change, on ${covered}. Projects can override it in their settings.`}
    >
      <SettingRow label="Default level" stacked>
        <Segmented<TokenSaverLevel>
          value={ts.default}
          onChange={(level) => update({ tokenSaver: { default: level } })}
          options={LEVELS}
        />
      </SettingRow>
      {ROLES.map(({ role, label }) => (
        <SettingRow key={role} label={label} stacked>
          <Segmented<TokenSaverLevel | typeof INHERIT>
            value={ts.roles[role] ?? INHERIT}
            onChange={(v) =>
              update({ tokenSaver: { roles: { [role]: v === INHERIT ? null : v } } })
            }
            options={[{ value: INHERIT, label: "Default" }, ...LEVELS]}
          />
        </SettingRow>
      ))}
    </SettingsSection>
  );
}

/** Project page > Settings: this project's token saver level, or the global one (#602). */
export function ProjectTokenSaverRow({ project }: { project: Project }) {
  const client = useClient();
  const level = useSnapshotData(
    (s) => s.settings.tokenSaver.projects[project.id]?.level,
    undefined,
  );
  const set = (v: TokenSaverLevel | typeof INHERIT) =>
    void client.updateSettings({
      tokenSaver: { projects: { [project.id]: v === INHERIT ? null : { level: v } } },
    } as SettingsPatch);
  return (
    <SettingRow
      label="Token saver"
      help="Default: the level from Settings → General → Token saver for each role. Applies to sessions started or resumed after a change."
      stacked
    >
      <Segmented<TokenSaverLevel | typeof INHERIT>
        value={level ?? INHERIT}
        onChange={set}
        options={[{ value: INHERIT, label: "Default" }, ...LEVELS]}
      />
    </SettingRow>
  );
}
