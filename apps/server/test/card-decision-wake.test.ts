import {
  InboxItem,
  NOTICE_BATCH_CODE,
  NoticeBatchData,
  RoleMessageResponse,
  StartSessionResponse,
  ThreadItemsPage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

describe("card decision wakes", () => {
  let h: Harness;
  const target = {
    kind: "merge_verify",
    repository: "org/repo",
    pullNumber: 10,
    headSha: "a".repeat(40),
  } as const;

  beforeAll(async () => {
    h = await startHarness({
      github: { sync: false },
      orchestration: { wake: { debounceMs: 20, maxWaitMs: 100 } },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  async function updates(sessionId: string, cardId: string) {
    const { session } = await h.detail(sessionId);
    if (!session.rootThreadId) return undefined;
    const res = await h.api(
      "GET",
      `/sessions/${sessionId}/threads/${session.rootThreadId}/items?limit=500`,
    );
    const notices = ThreadItemsPage.parse(res.body).items.flatMap(({ item }) =>
      item.kind === "notice" && item.code === NOTICE_BATCH_CODE
        ? NoticeBatchData.parse(item.data).notices
        : [],
    );
    const found = notices.filter((notice) => notice.id === `card.decided:${cardId}`);
    return found.length ? found : undefined;
  }

  it.each(["approve", "deny"] as const)("wakes the idle PM once on %s", async (decision) => {
    const { sessionId } = RoleMessageResponse.parse(
      (
        await h.api("POST", `/orchestration/projects/${h.projectId}/pm/messages`, {
          input: { text: "Check the merge gate" },
        })
      ).body,
    );
    await waitUntil(async () => (await h.detail(sessionId)).session.status === "idle");
    const { decisions, github, orchestration } = h.server.services;
    const card = decisions.raise({ role: "pm", projectId: h.projectId, sessionId }, h.projectId, {
      kind: "github",
      target,
    });
    const check = vi.spyOn(github.client, "run");
    check.mockResolvedValueOnce({ data: { state: "open", head: { sha: target.headSha } } });
    const path = `/inbox/decision-cards/${card.id}/${decision}`;
    const input = decision === "approve" ? { ownerWords: "Approved" } : undefined;
    try {
      expect((await h.api("POST", path, input)).status).toBe(200);
      expect((await h.api("POST", path, input)).status).toBe(403);
    } finally {
      check.mockRestore();
    }

    expect(await waitUntil(() => updates(sessionId, card.id), 5_000)).toEqual([
      expect.objectContaining({
        type: "card.decided",
        sessionId,
        data: {
          cardId: card.id,
          kind: "merge_verify",
          decision,
          decidedAt: expect.any(String),
          target,
        },
      }),
    ]);
    await waitUntil(async () => (await h.detail(sessionId)).session.status === "idle");
    expect(orchestration.notices.undelivered("pm", h.projectId)).toEqual([]);
    expect(await updates(sessionId, card.id)).toHaveLength(1);
  });

  it("delivers an inbox runtime approval to its agent session", async () => {
    const started = StartSessionResponse.parse(
      (
        await h.api("POST", "/sessions", {
          projectId: h.projectId,
          provider: "fake",
          autonomy: "supervised",
          input: { text: "[approval] Check the guard" },
        })
      ).body,
    );
    if (started.status !== "started") throw new Error(`Unexpected start result: ${started.status}`);
    const { sessionId } = started;
    const card = await waitUntil(async () =>
      InboxItem.array()
        .parse((await h.api("GET", "/inbox?status=open")).body)
        .find((item) => item.sessionId === sessionId && item.kind === "approval"),
    );
    expect(
      (
        await h.api("POST", `/inbox/${card.id}/resolve`, {
          status: "resolved",
          response: { kind: "approval", decision: "deny" },
        })
      ).status,
    ).toBe(200);
    expect(await waitUntil(() => updates(sessionId, card.id), 5_000)).toEqual([
      expect.objectContaining({
        type: "card.decided",
        sessionId,
        data: expect.objectContaining({ cardId: card.id, decision: "deny" }),
      }),
    ]);
  });
});
