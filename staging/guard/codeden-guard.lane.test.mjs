import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkCommand, loadAzureTargets } from "./codeden-guard.mjs";
import { matchPrdCard } from "./codeden-guard-prd-cards.mjs";

const targets = loadAzureTargets(new URL("./fixtures/azure-targets.json", import.meta.url));
const match = (command, cwd = process.cwd()) => matchPrdCard(command, cwd, () => targets);

test("protection and ruleset requests reject credential names and linked input", t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "guard-input-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "InStAlL-ToKeN.json"), "{}");
  writeFileSync(join(directory, "payload.json"), "{}");
  linkSync(join(directory, "payload.json"), join(directory, "alias.json"));
  writeFileSync(join(directory, "regular.json"), "{}");
  for (const endpoint of ["repos/example/project/branches/main/protection", "repos/Cumulus-Service-GmbH/dbops/rulesets/1"]) {
    const prefix = `gh api -X PUT ${endpoint} --input`;
    assert.match(match(`${prefix} InStAlL-ToKeN.json`, directory).details().denial, /credential/i);
    assert.match(match(`${prefix} alias.json`, directory).details().denial, /hard.link/i);
    assert.match(match(`${prefix} regular.json`, directory).details().reason, /sha256/);
  }
});

test("GitHub CLI refuses process-controlling pager declarations", () => {
  for (const variable of ["GH_PAGER", "PAGER", "GH_CONFIG_DIR", "LESSOPEN"]) {
    assert.match(checkCommand(`${variable}=fixture gh api user`, targets) ?? "", /GitHub CLI environment/);
  }
  assert.equal(checkCommand("gh api user", targets), null);
  assert.match(checkCommand("env -u GH_PAGER gh api user", targets), /GitHub CLI environment/);
  assert.match(checkCommand("export PAGER=fixture; gh api user", targets), /GitHub CLI environment/);
});

test("typed fields on repository settings are writes without an explicit method", () => {
  assert.match(checkCommand("gh api repos/example/project -F has_issues=true", targets) ?? "", /repository settings/);
  assert.match(checkCommand("gh api repos/example/project --method GET -F has_issues=true", targets) ?? "", /repository settings/);
  assert.match(checkCommand("gh api repos/example/project -Fhas_issues=true", targets) ?? "", /repository settings/);
});

test("traffic approval binds only named revisions in the registered production placement", () => {
  const [app, placement] = [...targets.prdAppLocations][0];
  const prefix = `az containerapp ingress traffic set -n ${app} -g ${placement.resourceGroup} --subscription ${placement.subscription} --revision-weight`;
  const first = match(`${prefix} ${app}--r12345678=100 -o none`);
  assert.match(first.reason, /owner's approval card/);
  assert.match(first.reason, new RegExp(app));
  assert.notEqual(first.ledgerCommand, match(`${prefix} ${app}--r12345679=100 -o none`).ledgerCommand);
  assert.equal(match(`${prefix} latest=100 -o none`), null);
  assert.equal(match(`${prefix} ${app}--r12345678=90 -o none`), null);
  assert.equal(match(`${prefix} ${app}--r12345678=100 ${app}--r12345678=0 -o none`), null);
  assert.match(checkCommand(`${prefix} latest=100 -o none`, targets), /named revision/i);
});

test("Actions cleanup accepts only exact IDs for one repository and checks the list snapshot", t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "guard-actions-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifact = "gh api -X DELETE repos/example/project/actions/artifacts/41";
  const log = "gh api -X DELETE repos/example/project/actions/runs/42/logs";
  const batch = artifact + " && " + log;
  const changed = log.replace("/42/", "/43/");
  assert.match(checkCommand(batch, targets), /Actions cleanup/);
  const approved = match(batch, directory).details();
  assert.match(approved.reason, /example\/project/);
  assert.match(approved.reason, /41.*42/);
  assert.equal(approved.ledgerCommand, match(log + " && " + artifact, directory).details().ledgerCommand);
  assert.equal(match(artifact + " && " + log.replace("/project/", "/other/"), directory), null);
  assert.equal(match(artifact + " && " + artifact, directory), null);
  assert.equal(match(artifact + " && " + log.replace("/logs", ""), directory), null);
  const filename = join(directory, "approved.tsv");
  const data = "artifact\t41\nrun-log\t42\n";
  writeFileSync(filename, data);
  const pin = createHash("sha256").update(data).digest("hex");
  const directive = " # codeden-list approved.tsv " + pin;
  assert.match(match(batch + directive, directory).details().reason, new RegExp(pin));
  assert.match(match(artifact + " && " + changed + directive, directory).details().denial, /outside/);
  writeFileSync(filename, data.replace("42", "43"));
  assert.match(match(batch + directive, directory).details().denial, /hash mismatch/);
  assert.match(checkCommand("curl --request DELETE https://api.github.com/repos/example/project/actions/artifacts/41", targets), /Actions cleanup/);
  assert.equal(checkCommand("curl https://api.github.com/repos/example/project/actions/artifacts/41", targets), null);
});

test("the whole synthetic 500-item cleanup fits under one card", () => {
  const base = "gh api -X DELETE repos/example/WebChatMobile/actions/";
  const requests = [
    ...Array.from({ length: 470 }, (_, index) => base + "artifacts/" + (10_000_000_000 + index)),
    ...Array.from({ length: 30 }, (_, index) => base + "runs/" + (20_000_000_000 + index) + "/logs"),
  ];
  const command = requests.join(" && ");
  const selection = match(command).details();
  assert.equal(selection.command, command);
  assert.equal(checkCommand(command, targets, 0, { deferPrdWrite: "actions-cleanup" }), null);
});

test("the staged hook raises one Supervised card per Actions batch", t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "guard-ledger-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const hook = fileURLToPath(new URL("./codeden-guard.mjs", import.meta.url));
  const command = "gh api -X DELETE repos/example/project/actions/artifacts/41";
  const invoke = (permission_mode, args = []) => spawnSync(process.execPath, [hook, ...args], {
    env: { ...process.env, CODEDEN_HOME: directory, CODEDEN_GUARD_LEDGER: join(directory, "ledger") },
    input: JSON.stringify({
      cwd: join(directory, "wt", "fixture"), permission_mode, session_id: "cleanup-fixture",
      tool_name: "Bash", tool_input: { command },
    }),
    encoding: "utf8",
  });
  for (const result of [invoke("acceptEdits"), invoke("default", ["codex"])]) {
    assert.equal(result.status, 2, result.stdout + result.stderr);
  }
  const first = invoke("default");
  assert.equal(first.status, 0, first.stderr);
  const decision = JSON.parse(first.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "ask");
  assert.equal(decision.updatedInput.command, command);
  const replay = invoke("default");
  assert.equal(replay.status, 2);
  assert.match(replay.stderr, /card already raised/);
});
