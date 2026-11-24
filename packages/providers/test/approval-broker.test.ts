import type { AgentEvent } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { ApprovalBroker } from "../src/approvals";

describe("ApprovalBroker", () => {
  it("keeps a dangerous approval pending after a session-wide response", async () => {
    const broker = new ApprovalBroker(() => {});
    const answer = broker.request(
      { threadId: "t1", turnId: "u1" },
      {
        id: "approval-r1",
        status: "in_progress",
        kind: "approval_request",
        requestId: "r1",
        action: "secrets",
        title: "Read a credential file",
        options: ["allow_once", "allow_session", "deny"],
      },
    );
    expect(() => broker.respond("r1", { kind: "approval", decision: "allow_session" })).toThrow(
      "This action requires a separate approval each time.",
    );
    expect(broker.has("r1")).toBe(true);
    broker.respond("r1", { kind: "approval", decision: "deny" });
    await expect(answer).resolves.toEqual({ kind: "approval", decision: "deny" });
  });

  it("records who decided: the user by default, or CodeDen's policy", async () => {
    const events: AgentEvent[] = [];
    const broker = new ApprovalBroker((e) => events.push(e));
    const ctx = { threadId: "t1", turnId: "u1" };
    const item = (requestId: string) => ({
      id: `approval-${requestId}`,
      kind: "approval_request" as const,
      status: "in_progress" as const,
      requestId,
      action: "git_destructive" as const,
      title: "Run `git push --force`",
      options: ["allow_once" as const, "allow_session" as const, "deny" as const],
    });
    const byUser = broker.request(ctx, item("r1"));
    broker.respond("r1", { kind: "approval", decision: "allow_once" });
    await byUser;
    const byPolicy = broker.request(ctx, item("r2"));
    broker.respond("r2", {
      kind: "approval",
      decision: "deny",
      message: "Nobody is watching",
      decidedBy: "policy",
    });
    await byPolicy;
    const done = events.filter((e) => e.type === "item.completed");
    expect(done.map((e) => (e as { item: { decidedBy?: string } }).item.decidedBy)).toEqual([
      "user",
      "policy",
    ]);
  });
});
