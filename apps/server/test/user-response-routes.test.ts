import { Settings } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { inboxRoutes } from "../src/routes/inbox";
import { sessionRoutes } from "../src/routes/sessions";
import type { AppServices } from "../src/services/container";

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

it("strips server-authored metadata from public start, send and steer inputs", async () => {
  const start = vi.fn(async (_request: unknown) => ({ status: "started", sessionId: "s1" }));
  const send = vi.fn(async () => ({ status: "sent" }));
  const steer = vi.fn(async () => {});
  const services = {
    sessions: { start, send, steer },
    settings: { get: () => Settings.parse({}) },
    orchestration: { conflicts: { closeReplaced: vi.fn() } },
  } as unknown as AppServices;
  const app = sessionRoutes(services, "token");
  const input = {
    text: "Hello",
    from: "codeden",
    relayedForUser: true,
    checksRound: 3,
    teamCoordination: { type: "worker_finished", itemId: "a", attempt: 1 },
  };

  expect((await app.request("/", post({ projectId: "project", input }))).status).toBe(200);
  expect((await app.request("/s1/messages", post({ input }))).status).toBe(200);
  expect((await app.request("/s1/steer", post({ input }))).status).toBe(200);
  const userInput = { text: "Hello", attachments: [] };
  expect(start.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ input: userInput }));
  expect(send).toHaveBeenCalledWith("s1", expect.objectContaining({ input: userInput }));
  expect(steer).toHaveBeenCalledWith("s1", userInput);
});

describe("the user's own answer routes", () => {
  it("stamp an approval as the user's, whatever the body claims", async () => {
    const respond = vi.fn(async () => {});
    const app = sessionRoutes({ sessions: { respond } } as unknown as AppServices, "token");
    const res = await app.request(
      "/s1/respond",
      post({
        requestId: "r1",
        response: { kind: "approval", decision: "allow_once", decidedBy: "pm" },
      }),
    );
    expect(res.status).toBe(200);
    expect(respond).toHaveBeenCalledWith("s1", {
      requestId: "r1",
      response: { kind: "approval", decision: "allow_once", decidedBy: "user" },
    });
  });

  it("stamp an inbox approval as the user's and leave answers alone", async () => {
    const resolve = vi.fn(async () => ({}));
    const app = inboxRoutes({ inbox: { resolve } } as unknown as AppServices);
    await app.request("/i1/resolve", post({ response: { kind: "approval", decision: "deny" } }));
    await app.request(
      "/i2/resolve",
      post({ response: { kind: "answer", answers: { q1: ["yes"] } } }),
    );
    expect(resolve).toHaveBeenNthCalledWith(1, "i1", {
      status: "resolved",
      response: { kind: "approval", decision: "deny", decidedBy: "user" },
    });
    expect(resolve).toHaveBeenNthCalledWith(2, "i2", {
      status: "resolved",
      response: { kind: "answer", answers: { q1: ["yes"] } },
    });
  });
});
