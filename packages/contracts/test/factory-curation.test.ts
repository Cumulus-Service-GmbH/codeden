import { expect, it } from "vitest";
import { CurationProposal } from "../src/factory-curation";

it("round trips scoped replace and prune operations", () => {
  const shared = { baseSha: "a".repeat(40), evidence: "lesson-1", section: "## Proof" };
  const proposal = {
    operations: [
      { ...shared, path: "AGENTS.md", op: "replace", replacement: "Run the focused suite." },
      { ...shared, path: ".codeden/VISION.md", op: "prune" },
    ],
  };
  expect(CurationProposal.parse(JSON.parse(JSON.stringify(proposal)))).toEqual(proposal);
  for (const patch of [{ op: "append" }, { path: "docs/DESIGN.md" }]) {
    expect(
      CurationProposal.safeParse({ operations: [{ ...proposal.operations[0], ...patch }] }).success,
    ).toBe(false);
  }
});
