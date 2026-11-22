import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { defineTool } from "../src/mcp/define";
import { ToolRegistry } from "../src/mcp/registry";
import type { AppServices } from "../src/services/container";
import { DecisionApprovals } from "../src/services/decision-approvals";
import { ServiceError } from "../src/services/errors";
import { githubApprovalPort } from "../src/services/github/approval-card";
import { createGithubEnv } from "./support/github-env";

const pm = { role: "pm", projectId: "project", sessionId: "pm" } as const;
const orchestrator = { role: "orchestrator", projectId: null, sessionId: "orch" } as const;
const owner = { role: "owner", projectId: null, sessionId: null } as const;
const target = {
  kind: "merge_verify",
  repository: "org/repo",
  pullNumber: 10,
  headSha: "a".repeat(40),
} as const;

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const store = new EventStore(db.db);
  const check = vi.fn(async () => {});
  const post = vi.fn(async () => {});
  const service = () => new DecisionApprovals(store, { check, post });
  return { service, check, post, store };
}

describe("decision approvals", () => {
  it("only posts after the owner's click and consumes the card across service restarts", async () => {
    const { service, post } = setup();
    const card = service().raise(pm, "project", { kind: "github", target });
    expect(post).not.toHaveBeenCalled();
    await expect(service().confirm(card.id, pm)).rejects.toThrow("owner");
    expect(post).not.toHaveBeenCalled();
    await expect(service().postGithub(card.id, pm)).rejects.toThrow();
    await service().confirm(card.id, owner);
    expect(post).not.toHaveBeenCalled();
    const results = await Promise.allSettled([
      service().postGithub(card.id, pm),
      service().postGithub(card.id, pm),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(post).toHaveBeenCalledExactlyOnceWith(target, card.id);
    await expect(service().confirm(card.id, owner)).rejects.toThrow();
    await expect(service().postGithub(card.id, pm)).rejects.toThrow();
  });

  it("refuses a moved head without posting a review", async () => {
    const { service, check, post } = setup();
    check.mockRejectedValueOnce(new ServiceError(409, "stale_approval", "PR head moved"));
    const card = service().raise(pm, "project", { kind: "github", target });
    await expect(service().confirm(card.id, owner)).rejects.toThrow("PR head moved");
    await expect(service().confirm(card.id, owner)).rejects.toThrow("unavailable");
    expect(post).not.toHaveBeenCalled();
  });

  it("restricts tier zero to the owning PM and tier two to the owner", () => {
    const { service } = setup();
    const status = { action: "get_project_status", args: {} };
    const production = { action: "production", args: {} };
    expect(() => service().authorize(pm, "project", status)).not.toThrow();
    expect(() => service().authorize(pm, "other", status)).toThrow();
    expect(() => service().authorize(orchestrator, "project", status)).toThrow();
    expect(() => service().authorize(pm, "project", production)).toThrow();
    expect(() => service().authorize(orchestrator, "project", production)).toThrow();
    expect(() => service().authorize(owner, "project", production)).not.toThrow();
  });

  it("allows only exact ordered steps under one owner approval", async () => {
    const { service, store } = setup();
    const first = { action: "stop_session", args: { sessionId: "worker" } };
    const second = { action: "resume_automation", args: { automationId: "nightly" } };
    const card = service().raise(orchestrator, "project", { kind: "plan", steps: [first, second] });
    const authorize = (step: typeof first | typeof second) =>
      service().authorize(orchestrator, "project", step, card.id);

    expect(() => authorize(first)).toThrow("confirmed card");
    await service().confirm(card.id, owner);
    expect(() => authorize(second)).toThrow("exact action and arguments");
    expect(() => authorize({ ...first, args: { sessionId: "other" } })).toThrow(
      "exact action and arguments",
    );
    expect(() => authorize(first)).not.toThrow();
    expect(() => authorize(first)).toThrow("exact action and arguments");
    expect(() => authorize(second)).not.toThrow();
    expect(() => authorize(second)).toThrow("exact action and arguments");
    expect(store.listTypes(["decision.confirmed"]).map(({ payload }) => payload)).toEqual([
      { id: card.id, by: { role: "owner" } },
    ]);
    expect(store.listTypes(["decision.step_consumed"]).map(({ payload }) => payload)).toEqual([
      { id: card.id, step: first },
      { id: card.id, step: second },
    ]);
  });

  it("refuses PM stop requests and requires a distinct second key for the orchestrator", async () => {
    const { service, store } = setup();
    const step = { action: "stop_session", args: { sessionId: "worker" } };
    expect(() => service().authorize(pm, "project", step)).toThrow();
    expect(() => service().authorize(orchestrator, "project", step)).toThrow();
    const card = service().raise(orchestrator, "project", { kind: "plan", steps: [step] });
    await expect(service().confirm(card.id, orchestrator)).rejects.toThrow();
    await expect(service().confirm(card.id, { ...pm, projectId: "other" })).rejects.toThrow();
    expect(() => service().authorize(orchestrator, "project", step, card.id)).toThrow();
    await service().confirm(card.id, pm);
    expect(() =>
      service().authorize(orchestrator, "project", { ...step, args: {} }, card.id),
    ).toThrow();
    expect(() => service().authorize(orchestrator, "project", step, card.id)).not.toThrow();
    expect(store.listAfter(0).at(-1)?.type).toBe("decision.step_consumed");
    expect(() => service().authorize(orchestrator, "project", step, card.id)).toThrow();
  });
});

describe("GitHub approval client", () => {
  it("checks the live head and posts the owner record, comment and review once", async () => {
    const env = createGithubEnv();
    try {
      const pr = env.gh.addPr(
        "approval-card",
        { author: "contributor" },
        { headSha: target.headSha },
      );
      const githubTarget = { ...target, repository: "acme/widgets", pullNumber: pr.number };
      const service = new DecisionApprovals(env.store, githubApprovalPort(env.service.client));
      const card = service.raise(pm, "project", { kind: "github", target: githubTarget });
      const writes = () => env.gh.requests.filter(({ method }) => method === "POST");
      await expect(service.postGithub(card.id, pm)).rejects.toThrow();
      expect(writes()).toEqual([]);
      await service.confirm(card.id, owner);
      expect(writes()).toEqual([]);
      env.gh.touch(pr.number, (issue) => {
        if (issue.pr) issue.pr.headSha = "b".repeat(40);
      });
      await expect(service.postGithub(card.id, pm)).rejects.toThrow("head moved");
      expect(writes()).toEqual([]);
      env.gh.touch(pr.number, (issue) => {
        if (issue.pr) issue.pr.headSha = target.headSha;
      });
      await expect(service.postGithub(card.id, pm)).rejects.toThrow();
      const next = service.raise(pm, "project", { kind: "github", target: githubTarget });
      await service.confirm(next.id, owner);
      await service.postGithub(next.id, pm);
      const reopened = new DecisionApprovals(env.store, githubApprovalPort(env.service.client));
      await expect(reopened.postGithub(next.id, pm)).rejects.toThrow();
      expect(writes()).toMatchObject([
        {
          path: `/repos/acme/widgets/issues/${pr.number}/comments`,
          status: 201,
          body: {
            body: `<!-- codeden-owner-approval:v1\n${JSON.stringify({
              ...githubTarget,
              decisionId: next.id,
            })}\n-->`,
          },
        },
        {
          path: `/repos/acme/widgets/issues/${pr.number}/comments`,
          status: 201,
          body: {
            body: `Approved by the owner in CodeDen. Decision ${next.id}. Merge-verify head: ${target.headSha}.`,
          },
        },
        {
          path: `/repos/acme/widgets/pulls/${pr.number}/reviews`,
          status: 200,
          body: { event: "APPROVE", commit_id: target.headSha },
        },
      ]);
    } finally {
      await env.close();
    }
  });
  it("leaves the owner record and comment when self-review is rejected, without replaying", async () => {
    const env = createGithubEnv();
    try {
      const pr = env.gh.addPr("self-review", {}, { headSha: target.headSha });
      const service = new DecisionApprovals(env.store, githubApprovalPort(env.service.client));
      const card = service.raise(pm, "project", {
        kind: "github",
        target: { ...target, repository: "acme/widgets", pullNumber: pr.number },
      });
      await service.confirm(card.id, owner);
      await expect(service.postGithub(card.id, pm)).rejects.toThrow("own pull request");
      await expect(service.postGithub(card.id, pm)).rejects.toThrow("unused owner approval");
      expect(env.gh.requests.filter(({ method }) => method === "POST")).toMatchObject([
        {
          path: `/repos/acme/widgets/issues/${pr.number}/comments`,
          status: 201,
          body: {
            body: `<!-- codeden-owner-approval:v1\n${JSON.stringify({
              ...target,
              repository: "acme/widgets",
              pullNumber: pr.number,
              decisionId: card.id,
            })}\n-->`,
          },
        },
        { path: `/repos/acme/widgets/issues/${pr.number}/comments`, status: 201 },
        { path: `/repos/acme/widgets/pulls/${pr.number}/reviews`, status: 422 },
      ]);
      expect(env.store.listTypes(["decision.github_posted"])).toEqual([]);
    } finally {
      await env.close();
    }
  });
});

it("approves only the selected run and environments after the owner clicks, once", async () => {
  const env = createGithubEnv();
  try {
    const runId = 42;
    env.gh.pendingDeployments.set(runId, [3, 8]);
    env.gh.pendingDeployments.set(runId + 1, [8]);
    const service = new DecisionApprovals(env.store, githubApprovalPort(env.service.client));
    const card = service.raise(pm, "project", {
      kind: "github",
      target: {
        kind: "environment_release",
        repository: "acme/widgets",
        runId,
        environmentIds: [8],
      },
    });
    const writes = () => env.gh.requests.filter(({ method }) => method === "POST");
    await expect(service.postGithub(card.id, pm)).rejects.toThrow();
    expect(writes()).toEqual([]);
    await service.confirm(card.id, owner);
    expect(writes()).toEqual([]);
    await service.postGithub(card.id, pm);
    await expect(service.postGithub(card.id, pm)).rejects.toThrow("unused owner approval");
    expect(writes()).toMatchObject([
      {
        path: "/repos/acme/widgets/actions/runs/42/pending_deployments",
        body: {
          environment_ids: [8],
          state: "approved",
          comment: expect.stringContaining(card.id),
        },
      },
    ]);
  } finally {
    await env.close();
  }
});

it("checks the card before the tool handler can run, including on the direct tool path", async () => {
  const { service } = setup();
  const decisions = service();
  const handler = vi.fn(async () => "resumed");
  const tool = defineTool({
    name: "resume_automation",
    description: "Resume an automation",
    scope: "project",
    roles: ["orchestrator"],
    input: z.strictObject({ automationId: z.string() }),
    handler,
  });
  const registry = new ToolRegistry([tool], { decisions } as AppServices);
  const step = { action: "resume_automation", args: { automationId: "audit" } };
  const caller = { ...orchestrator, caller: "mcp" as const, signal: new AbortController().signal };
  const card = decisions.raise(orchestrator, "project", { kind: "plan", steps: [step] });
  const plan = { cardId: card.id, projectId: "project" };
  expect((await registry.call(step.action, step.args, caller, plan)).isError).toBe(true);
  await decisions.confirm(card.id, owner);
  expect((await registry.call(step.action, { automationId: "other" }, caller, plan)).isError).toBe(
    true,
  );
  expect((await registry.call(step.action, step.args, caller)).isError).toBe(true);
  expect(handler).not.toHaveBeenCalled();
  expect((await registry.call(step.action, step.args, caller, plan)).isError).toBe(false);
  expect((await registry.call(step.action, step.args, caller, plan)).isError).toBe(true);
  expect(handler).toHaveBeenCalledTimes(1);
});

it.each([true, false])("records the consumed step's result when ok is %s", async (ok) => {
  const { service, store } = setup();
  const decisions = service();
  const step = { action: "merge_pull_request", args: { pullNumber: 10, headSha: target.headSha } };
  const handler = vi.fn(async () => {
    expect(store.listAfter(0).at(-1)?.type).toBe("decision.step_consumed");
    if (!ok) throw new ServiceError(409, "merge_verify_pending", "PR must pass merge verification");
    return "merged";
  });
  const tool = defineTool({
    name: "merge_pull_request",
    description: "Merge a pull request",
    scope: "project",
    roles: ["orchestrator"],
    input: z.strictObject({ pullNumber: z.number(), headSha: z.string() }),
    handler,
  });
  const registry = new ToolRegistry([tool], { decisions } as AppServices);
  const caller = { ...orchestrator, caller: "mcp" as const, signal: new AbortController().signal };
  const card = decisions.raise(orchestrator, "project", { kind: "plan", steps: [step] });
  await decisions.confirm(card.id, pm);
  const plan = { cardId: card.id, projectId: "project" };
  const result = await registry.call(step.action, step.args, caller, plan);
  expect(result.isError).toBe(!ok);
  expect((await registry.call(step.action, step.args, caller, plan)).isError).toBe(true);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(store.listAfter(0).slice(2)).toMatchObject([
    { type: "decision.step_consumed", payload: { id: card.id, step } },
    {
      type: "decision.step_result",
      sessionId: caller.sessionId,
      payload: { id: card.id, step, ok, ...(ok ? {} : { error: result.text }) },
    },
  ]);
});
