import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@codeden/contracts";
import { expect, it } from "vitest";
import { resolveAutonomy } from "../src/services/sessions/autonomy-policy";

it("classifies a bare tilde like the account home", () => {
  const project = join(tmpdir(), "fixture-repo");
  const settings = Settings.parse({}).autonomy;
  const scope = (path: string) =>
    resolveAutonomy("writer", "Install tools", { paths: [path] }, project, settings);
  expect(scope("~")).toEqual(scope(homedir()));
  expect(scope("~").guardedInstall).toBe(true);
});
