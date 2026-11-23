import { tmpdir } from "node:os";
import { AutonomyLevel, type SessionOptions } from "@codeden/contracts";
import { expect, it } from "vitest";
import { buildQueryOptions } from "../src/claude/options";
import { codexConfigOverrides, codexPolicy } from "../src/codex/config";

const session: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "full",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

const permissionModes = {
  read_only: "default",
  supervised: "default",
  auto: "acceptEdits",
  full: "bypassPermissions",
};

it.each(AutonomyLevel.options)("keeps Claude hooks under %s autonomy", (autonomy) => {
  const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [async () => ({})] }] };
  const options = buildQueryOptions({
    session: { ...session, autonomy },
    executable: { kind: "native", path: "/bin/claude" },
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    hooks,
    abortController: new AbortController(),
  });
  expect(options.permissionMode).toBe(permissionModes[autonomy]);
  expect(options.hooks).toBe(hooks);
  if (options.settingSources !== undefined) {
    expect(options.settingSources).toContain("user");
  }
  expect(options.settings ?? {}).not.toHaveProperty("disableAllHooks");
  for (const flag of ["bare", "settings", "setting-sources"]) {
    expect(options.extraArgs ?? {}).not.toHaveProperty(flag);
  }
  expect(
    Object.keys(options.env ?? {}).filter((key) => /DISABLE.*HOOK|CLAUDE_CODE_SIMPLE/i.test(key)),
  ).toEqual([]);
});

it("keeps Codex sandbox, approvals and guard configuration under Full autonomy", () => {
  const policy = codexPolicy("full");
  expect(policy.sandbox).toBe("workspace-write");
  expect(policy.approvalPolicy).not.toBe("never");
  expect(
    Object.keys(codexConfigOverrides(session)).filter((key) =>
      /rules|execpolicy|exec_policy|hooks|approval_policy|sandbox_mode|dangerously/i.test(key),
    ),
  ).toEqual([]);
});
