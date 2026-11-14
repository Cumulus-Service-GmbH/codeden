import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/mcp/registry";
import { factorySubmitReview } from "../src/mcp/tools/factory/builder";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * Non-blocking review follow-ups (#339). `security.concerns` blocks the merge, so an approval
 * can't carry one: the reviewer puts what can wait in `followUps`, which never start a revise
 * round and are filed as issues once the pull request merges.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const s = factorySteps(() => env);

/** The reviewer's `factory_submit_review` call, through the MCP tool over the real factory. */
function submit(id: string, args: Record<string, unknown>) {
  const services = { sessionRepo: env.repo, factory: env.factory };
  const registry = new ToolRegistry([factorySubmitReview], services as never);
  return registry.call("factory_submit_review", args, {
    role: "agent",
    sessionId: s.item(id).reviewerSessionId as string,
    projectId: env.project.id,
    caller: "mcp",
    signal: new AbortController().signal,
  });
}

/** The non-blocking finding the reviewer of PR #331 approved with, three times. */
const NOTE = "Archiving deletes unpushed commits in a container; fix before phase 4b";

const toBuilder = (builder: string) => env.messages.filter((m) => m.sessionId === builder);

describe("review follow-ups (#339)", () => {
  it("merges an approval with follow-ups, then files each follow-up as an issue once", async () => {
    env = createFactoryEnv();
    s.enable();
    const { id, pr, builder } = await s.verifying();
    const res = await submit(id, {
      ...APPROVE,
      followUps: [{ title: NOTE, severity: "medium", area: "runner" }],
    });
    expect(res.isError, res.text).toBe(false);
    await s.tick();
    expect(s.item(id).checks.find((c) => c.name === "security")?.state).toBe("pass");
    expect(s.item(id).stage).toBe("watching");
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
    // The builder was never asked to fix a follow-up.
    expect(toBuilder(builder)).toHaveLength(0);
    await s.tick();
    await s.tick();
    const filed = env.gh.issues.filter((i) => i.title === NOTE);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.body).toContain(pr.ref.url);
    expect(filed[0]?.labels.length).toBeGreaterThan(0);
  });

  it("refuses an approval with security concerns: they block the merge", async () => {
    env = createFactoryEnv();
    s.enable();
    const { id, builder } = await s.verifying();
    const res = await submit(id, { ...APPROVE, security: { concerns: [NOTE] } });
    expect.soft(res.isError, "factory_submit_review accepted it").toBe(true);
    expect.soft(res.text).toMatch(/request_changes/);
    expect.soft(res.text).toMatch(/followUps/);
    // Nothing was recorded, so the approval doesn't become a failed check and a revise round
    // in which the builder is asked to fix what the reviewer said doesn't block.
    await s.tick();
    expect.soft(s.item(id)).toMatchObject({ stage: "verifying", attempts: 0 });
    expect(toBuilder(builder).map((m) => m.text)).toEqual([]);
  });

  it("still sends request_changes with security concerns to a revise round", async () => {
    env = createFactoryEnv();
    s.enable();
    const { id, builder } = await s.verifying();
    const res = await submit(id, {
      ...APPROVE,
      verdict: "request_changes",
      summary: "Builds the query from user input",
      security: { concerns: ["SQL injection in query()"] },
    });
    expect(res.isError, res.text).toBe(false);
    await s.tick();
    expect(s.item(id)).toMatchObject({ stage: "building", attempts: 1 });
    expect(s.lastMessageTo(builder)).toContain("- security: Reviewer: SQL injection in query()");
  });
});
