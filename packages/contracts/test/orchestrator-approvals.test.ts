import { describe, expect, it } from "vitest";
import {
  ApprovalRequestItem,
  DecideApprovalInput,
  DecideApprovalOutput,
  EventEnvelope,
  ListPendingApprovalsOutput,
  PendingApproval,
  parseCardToken,
  RuntimeResponse,
} from "../src";

const prefix = "[codeden-card v1 scope=db-read class=delegable]";
const at = "2026-11-23T08:00:00.000Z";

describe("orchestrator approval contracts", () => {
  it.each([
    [`${prefix} Review`, { scope: "db-read", cls: "delegable" }],
    [
      "[codeden-card v1 scope=resource:group class=owner-only]",
      { scope: "resource:group", cls: "owner-only" },
    ],
    [` ${prefix}`, null],
    [`${prefix} ${prefix}`, null],
    [prefix.replace("v1", "v2"), null],
    [prefix.replace("db-read", "_read"), null],
    [`${prefix}Review`, null],
    [`${prefix}\n`, null],
    [undefined, null],
  ])("parses %s", (reason, expected) => {
    expect(parseCardToken(reason)).toEqual(expected);
  });

  it("round-trips approval requests, decisions and their global audit event", () => {
    const item = ApprovalRequestItem.parse({
      kind: "approval_request",
      status: "in_progress",
      id: "item",
      requestId: "request",
      action: "command",
      title: "Read database",
      hookReason: prefix,
      decidedBy: "orchestrator",
    });
    expect(item).toMatchObject({ hookReason: prefix, decidedBy: "orchestrator" });
    const response = { kind: "approval", decision: "allow_once", decidedBy: "orchestrator" };
    expect(RuntimeResponse.parse(response)).toEqual(response);
    const pending = {
      id: "inbox:session:request",
      kind: "tool_approval",
      projectId: "project",
      sessionId: "session",
      title: item.title,
      hookReason: prefix,
      delegable: true,
    };
    expect(ListPendingApprovalsOutput.parse({ approvals: [pending] })).toEqual({
      approvals: [pending],
    });
    expect(PendingApproval.safeParse({ ...pending, delegable: false }).success).toBe(false);
    expect(PendingApproval.safeParse({ ...pending, ownerOnly: "secrets" }).success).toBe(false);
    expect(PendingApproval.safeParse({ ...pending, url: "https://example.invalid" }).success).toBe(
      false,
    );
    const decision = { id: pending.id, decision: "approve", reason: "Read-only" };
    expect(DecideApprovalInput.parse({ ...decision, reason: " Read-only " })).toEqual(decision);
    expect(DecideApprovalInput.safeParse({ ...decision, reason: " " }).success).toBe(false);
    expect(DecideApprovalInput.safeParse({ ...decision, id: "a".repeat(301) }).success).toBe(false);
    expect(DecideApprovalInput.safeParse({ ...decision, actor: "owner" }).success).toBe(false);
    const output = { id: pending.id, decision: "approve", decidedAt: at };
    expect(DecideApprovalOutput.parse(output)).toEqual(output);
    const event = {
      type: "approval.decided_by_orchestrator",
      seq: 1,
      ts: at,
      sessionId: null,
      payload: {
        ...decision,
        kind: pending.kind,
        projectId: pending.projectId,
        sessionId: pending.sessionId,
        orchestratorSessionId: "orchestrator",
        title: pending.title,
        at,
      },
    };
    expect(EventEnvelope.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });
});
