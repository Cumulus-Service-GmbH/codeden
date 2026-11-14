import type { FactoryItem } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

let env: FactoryEnv;
afterEach(() => env?.close());

const s = factorySteps(() => env);
const items = () => env.factory.data.items(env.project.id);
const revertOf = (id: string) =>
  items().find((i) => i.source === "revert" && i.revertOf === id) as FactoryItem;

/** A feature that changes UI files, merged by the factory and watched on main. */
async function mergedUiChange() {
  s.enable("dark_factory");
  const created = s.backlogItem("Group the session list");
  await s.tick();
  const builder = s.item(created.id).builderSessionId as string;
  env.gh.openPr({
    sessionId: builder,
    title: created.title,
    files: [
      "apps/web/src/components/shell/lists.tsx",
      "apps/web/src/components/command-palette.tsx",
      "apps/server/src/services/session-fork.ts",
      "apps/server/test/session-fork.test.ts",
    ],
    evidence: true,
  });
  await env.setStatus(builder, "idle");
  await s.tick();
  s.review(created.id);
  await s.tick();
  expect(s.item(created.id).stage).toBe("watching");
  return created.id;
}

describe("factory reverts (§10.1 step 6)", () => {
  it("lets the revert of a red main pass its checks without test results or UI evidence", async () => {
    env = createFactoryEnv();
    const id = await mergedUiChange();
    env.gh.commitState.set(s.item(id).mergeSha as string, "failure");
    await s.tick();
    expect(s.item(id).stage).toBe("reverted");
    const revert = revertOf(id);
    expect(revert.reason).toBeNull();
    expect(revert.stage).toBe("verifying");
    await s.tick();
    const checks = Object.fromEntries(s.item(revert.id).checks.map((c) => [c.name, c]));
    // The revert's own CI is its test evidence; it restores code that was screenshotted before.
    expect(checks.test_results?.state).toBe("pass");
    expect(checks.ui_evidence?.state).toBe("skipped");
    expect(s.item(revert.id).stage).not.toBe("failed");
  });
});
