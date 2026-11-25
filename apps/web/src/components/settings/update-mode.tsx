import { FORK_BUILD, type InstallSource, type UpdateMode } from "@codeden/contracts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUpdates } from "@/lib/updates";
import { SettingRow, useSettings } from "./settings-ui";

const NPM_HELP: Record<UpdateMode, string> = {
  off: "Never asks the npm registry for new versions.",
  notify:
    "Asks the npm registry for the latest version on start and every 6 hours (nothing else is sent) and offers a one-click update.",
  auto: "Also downloads new versions in the background; they start the next time you open CodeDen.",
};

const DESKTOP_HELP: Record<UpdateMode, string> = {
  off: "Never asks GitHub Releases for new versions.",
  notify:
    "Asks GitHub Releases for the latest version on start and every 6 hours (nothing else is sent) and offers a one-click update.",
  auto: "Also downloads new versions in the background; they install when you quit CodeDen.",
};

/** Help text for where this install gets its updates from. */
export function updateModeHelp(mode: UpdateMode, source: InstallSource | undefined): string {
  return (source === "desktop" ? DESKTOP_HELP : NPM_HELP)[mode];
}

/** Settings > General > Updates (§16, §17): off, notify, or install automatically. */
export function UpdateModeSetting() {
  const { settings, update } = useSettings();
  const { data } = useUpdates();
  const mode = FORK_BUILD && settings.updates.mode === "auto" ? "notify" : settings.updates.mode;
  const help = FORK_BUILD
    ? mode === "off"
      ? "Never checks GitHub Releases for new versions."
      : "Checks for fork updates and shows upstream releases for porting. Updates require Update now in the macOS desktop app."
    : updateModeHelp(mode, data?.source);
  return (
    <SettingRow label="Updates" help={help}>
      <Select value={mode} onValueChange={(v) => update({ updates: { mode: v as UpdateMode } })}>
        <SelectTrigger size="sm" className="w-44" data-testid="update-mode">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">Off</SelectItem>
          <SelectItem value="notify">Notify me</SelectItem>
          {!FORK_BUILD && <SelectItem value="auto">Install automatically</SelectItem>}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}
