import { mkdtempSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@codeden/contracts";
import { expect, it } from "vitest";
import { writeJsonFile } from "../src/json-file";
import { SettingsStore } from "../src/settings-store";
import { removeTree } from "./support/remove-tree";

it("keeps a stored token saver level of ultra after loading with the aligned code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeden-token-saver-upgrade-"));
  try {
    const file = join(dir, "settings.json");
    const legacySettings: Settings = {
      ...Settings.parse({}),
      tokenSaver: {
        default: "ultra",
        roles: { orchestrator: null, pm: "full", agent: null },
        projects: { "project-1": { level: "lite" } },
      },
    };
    writeJsonFile(file, legacySettings);
    const savedAt = new Date("2025-01-01T00:00:00Z");
    utimesSync(file, savedAt, savedAt);
    const savedMtime = statSync(file).mtimeMs;
    const savedBytes = readFileSync(file);

    const store = new SettingsStore(file);

    expect(store.reset).toBeNull();
    expect(store.get().tokenSaver).toEqual(legacySettings.tokenSaver);
    expect(readFileSync(file)).toEqual(savedBytes);
    expect(statSync(file).mtimeMs).toBe(savedMtime);
  } finally {
    await removeTree(dir);
  }
});
