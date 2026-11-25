import { expect, it } from "vitest";
import { type ItemOf, plainReadTargets, sessionApprovalBlockReason } from "../src";

it.each([
  ["cat README.md", ["README.md"]],
  ["rg -n match README.md", ["README.md"]],
  ["git show HEAD:README.md", ["README.md"]],
  ["git log -5 --oneline", []],
  ["git diff --cached -- README.md", ["README.md"]],
  ["ls -la", []],
  ["sed -n '1,20p' README.md", ["README.md"]],
  ["head -n 5 README.md", ["README.md"]],
  ["tail -n 5 README.md", ["README.md"]],
  ["nl -ba README.md", ["README.md"]],
])("recognizes the narrow read grammar for %s", (command, paths) => {
  expect(plainReadTargets({ action: "command", toolName: "Bash", command })).toEqual(paths);
});

it.each([
  "cat ~/.codeden/settings.json",
  "cat .codeden/settings.json",
  "cat Library/Keychains/login.keychain-db",
  "cat jev.env",
  "cat prod.env",
  "cat credentials.json",
  "cat private.key",
  "cat README.md | tee other",
  "cat README.md > other",
  "cat README.md < other",
  "python3 - <<'PY'\nprint(42)\nPY",
  "node -e '0'",
  "curl https://example.test",
  "sed -n '1w other' README.md",
  "git diff --output=other",
  "git status",
])("refuses unsafe or unverifiable input %s", (command) => {
  expect(plainReadTargets({ action: "command", toolName: "Bash", command })).toBeUndefined();
});

it("does not widen release 1 standing grants", () => {
  const item: ItemOf<"approval_request"> = {
    kind: "approval_request",
    status: "in_progress",
    id: "approval",
    requestId: "request",
    action: "command",
    title: "Read file",
    toolName: "Bash",
    command: "nl -ba README.md",
    options: ["allow_once", "allow_session", "deny"],
  };
  expect(plainReadTargets(item)).toEqual(["README.md"]);
  expect(sessionApprovalBlockReason(item)).toBeDefined();
});
