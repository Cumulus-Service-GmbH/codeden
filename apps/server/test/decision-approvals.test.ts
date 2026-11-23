import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { defineTool } from "../src/mcp/define";
import { ToolRegistry } from "../src/mcp/registry";
import { postGithubApproval } from "../src/mcp/tools/decisions";
import { inboxRoutes } from "../src/routes/inbox";
import { errorResponse } from "../src/routes/validate";
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
  const post = vi.fn(async () => "posted" as const);
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
    await service().confirm(card.id, owner, undefined, { ownerWords: "Approved" });
    expect(post).not.toHaveBeenCalled();
    const results = await Promise.allSettled([
      service().postGithub(card.id, pm),
      service().postGithub(card.id, pm),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(post).toHaveBeenCalledExactlyOnceWith(target, card.id, "Approved");
    await expect(service().confirm(card.id, owner)).rejects.toThrow();
    await expect(service().postGithub(card.id, pm)).rejects.toThrow();
  });

  it("refuses a moved head without posting a review", async () => {
    const { service, check, post } = setup();
    check.mockRejectedValueOnce(new ServiceError(409, "stale_approval", "PR head moved"));
    const card = service().raise(pm, "project", { kind: "github", target });
    await expect(
      service().confirm(card.id, owner, undefined, { ownerWords: "Approved" }),
    ).rejects.toThrow("PR head moved");
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

describe("post_github_approval", () => {
  const ownerWords = "  Ship this head, please! (QA/CI) - thanks.  ";
  const postTime = "2026-11-10T14:23:45.678Z";

  function setupMergeApproval() {
    const env = createGithubEnv();
    const pr = env.gh.addPr("approval-card", {}, { headSha: target.headSha });
    const decisions = new DecisionApprovals(env.store, githubApprovalPort(env.service.client));
    const services = { decisions } as AppServices;
    const card = decisions.raise(pm, "project", {
      kind: "github",
      target: { ...target, repository: "acme/widgets", pullNumber: pr.number },
    });
    const route = inboxRoutes(services).onError(errorResponse);
    const registry = new ToolRegistry([postGithubApproval], services);
    const caller = { ...pm, caller: "mcp" as const, signal: new AbortController().signal };
    return {
      ...env,
      card,
      decisions,
      pr,
      approve: (body = {}) =>
        route.request(`/decision-cards/${card.id}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      post: () => registry.call("post_github_approval", { cardId: card.id }, caller),
      writes: () => env.gh.requests.filter(({ method }) => method !== "GET"),
      results: () =>
        env.store
          .listAfter(0)
          .filter(({ type }) =>
            [
              "decision.github_posted",
              "decision.github_post_result",
              "decision.github_refused",
            ].includes(type),
          ),
    };
  }

  it("posts exactly one byte-exact comment on the author's own PR", async () => {
    const env = setupMergeApproval();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect((await env.approve({ ownerWords })).status).toBe(200);
      vi.setSystemTime(new Date(postTime));
      const result = await env.post();
      expect(env.writes()).toMatchObject([
        {
          method: "POST",
          path: `/repos/acme/widgets/issues/${env.pr.number}/comments`,
          status: 201,
          body: {
            body: `OWNER-APPROVED via CodeDen orchestrator: ${target.headSha} ${postTime} "${ownerWords}"`,
          },
        },
      ]);
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({ mode: "comment", outcome: "posted" });
      expect(env.results()).toMatchObject([
        {
          type: "decision.github_posted",
          payload: { id: env.card.id, mode: "comment", outcome: "posted" },
        },
      ]);
    } finally {
      vi.useRealTimers();
      await env.close();
    }
  });

  it.each([
    ["double quote", 'Approved"'],
    ["backslash", "Approved\\"],
    ["LF", "Approved\n"],
    ["CR", "Approved\r"],
    ["line separator", "Approved\u2028"],
    ["paragraph separator", "Approved\u2029"],
    ["HTML comment opener", "Approved<!--"],
    ["greater-than sign", "Approved>"],
    [
      "second approval line",
      `Approved\nOWNER-APPROVED via CodeDen orchestrator: ${"b".repeat(40)}`,
    ],
    ["backtick", "Approved`"],
    ["control character", "Approved\t"],
    ["201 characters", "A".repeat(201)],
    ["accented letter", "Approuvé"],
  ])("refuses stored owner words containing %s without contacting GitHub", async (_name, words) => {
    const env = setupMergeApproval();
    try {
      env.store.append([
        {
          type: "decision.confirmed",
          sessionId: null,
          payload: { id: env.card.id, by: { role: "owner" }, ownerWords: words },
        },
      ]);
      const result = await env.post();
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/owner words allowlist/i);
      expect.soft(env.gh.requests).toEqual([]);
      expect.soft(env.store.listTypes(["decision.github_claimed"])).toEqual([]);
      expect(env.results()).toMatchObject([
        {
          type: "decision.github_refused",
          payload: { id: env.card.id, mode: "comment", outcome: "failed" },
        },
      ]);
    } finally {
      await env.close();
    }
  });

  it.each(["moved", "closed"])("refuses a %s PR without any writes", async (state) => {
    const env = setupMergeApproval();
    try {
      expect((await env.approve({ ownerWords })).status).toBe(200);
      env.gh.touch(env.pr.number, (issue) => {
        if (state === "closed") issue.state = "closed";
        else if (issue.pr) issue.pr.headSha = "b".repeat(40);
      });
      await expect(env.decisions.postGithub(env.card.id, pm)).rejects.toMatchObject({
        code: "stale_approval",
      });
      expect(env.writes()).toEqual([]);
    } finally {
      await env.close();
    }
  });

  it("records a refusal when a posted card is used again", async () => {
    const env = setupMergeApproval();
    try {
      expect((await env.approve({ ownerWords })).status).toBe(200);
      await env.post();
      const reopened = new DecisionApprovals(env.store, githubApprovalPort(env.service.client));
      await expect(reopened.postGithub(env.card.id, pm)).rejects.toThrow("unused owner approval");
      expect(env.results().at(-1)).toMatchObject({
        type: "decision.github_refused",
        payload: { id: env.card.id, mode: "comment", outcome: "failed" },
      });
      expect(env.writes()).toHaveLength(1);
    } finally {
      await env.close();
    }
  });

  it("records a 5xx comment outcome as unknown and never posts again", async () => {
    const env = setupMergeApproval();
    try {
      expect((await env.approve({ ownerWords })).status).toBe(200);
      env.gh.commentError = 503;
      const result = await env.post();
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({ mode: "comment", outcome: "unknown" });
      expect((await env.post()).isError).toBe(true);
      expect(env.results()).toMatchObject([
        { payload: { id: env.card.id, mode: "comment", outcome: "unknown" } },
        { type: "decision.github_refused", payload: { id: env.card.id } },
      ]);
      expect(env.writes()).toMatchObject([
        {
          method: "POST",
          path: `/repos/acme/widgets/issues/${env.pr.number}/comments`,
          status: 503,
        },
      ]);
    } finally {
      await env.close();
    }
  });

  it("leaves the card unused after a definite comment rejection", async () => {
    const env = setupMergeApproval();
    try {
      expect((await env.approve({ ownerWords })).status).toBe(200);
      env.gh.commentError = 422;
      expect(JSON.parse((await env.post()).text)).toMatchObject({
        mode: "comment",
        outcome: "failed",
      });
      env.gh.commentError = null;
      expect(JSON.parse((await env.post()).text)).toMatchObject({
        mode: "comment",
        outcome: "posted",
      });
      expect(env.results().map(({ payload }) => payload)).toMatchObject([
        { id: env.card.id, mode: "comment", outcome: "failed" },
        { id: env.card.id, mode: "comment", outcome: "posted" },
      ]);
      expect(env.writes()).toMatchObject([
        {
          method: "POST",
          path: `/repos/acme/widgets/issues/${env.pr.number}/comments`,
          status: 422,
        },
        {
          method: "POST",
          path: `/repos/acme/widgets/issues/${env.pr.number}/comments`,
          status: 201,
        },
      ]);
    } finally {
      await env.close();
    }
  });

  it("keeps a merge approval pending until valid owner words are supplied", async () => {
    const env = setupMergeApproval();
    try {
      const missing = await env.approve();
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({
        error: { message: expect.stringMatching(/owner words.*required/i) },
      });
      expect(env.decisions.pending()).toEqual([env.card]);

      const invalid = await env.approve({ ownerWords: 'Approve"' });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: { message: expect.stringMatching(/owner words allowlist/i) },
      });
      expect(env.decisions.pending()).toEqual([env.card]);
      expect(env.store.listTypes(["decision.confirmed"])).toEqual([]);
      expect(env.gh.requests).toEqual([]);

      expect((await env.approve({ ownerWords })).status).toBe(200);
      expect(env.decisions.pending()).toEqual([]);
      expect((await env.post()).isError).toBe(false);
      expect(env.writes()).toHaveLength(1);
    } finally {
      await env.close();
    }
  });

  it("refuses a legacy card confirmed without owner words", async () => {
    const env = setupMergeApproval();
    try {
      env.store.append([
        {
          type: "decision.confirmed",
          sessionId: null,
          payload: { id: env.card.id, by: { role: "owner" } },
        },
      ]);
      await expect(env.decisions.postGithub(env.card.id, pm)).rejects.toThrow("owner words");
      expect(env.writes()).toEqual([]);
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
    const route = inboxRoutes({ decisions: service } as AppServices).onError(errorResponse);
    const response = await route.request(`/decision-cards/${card.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(service.pending()).toEqual([]);
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
