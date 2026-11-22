import path from "node:path";
import type { CanUseTool, Options, PermissionResult, Query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, ItemOf, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncQueue } from "../src/async-queue";
import { ClaudeSession } from "../src/claude/session";

function stubSdk() {
  const launches: Options[] = [];
  const messages = new AsyncQueue<Record<string, unknown>>();
  const query = ((params: { options: Options }) => {
    launches.push(params.options);
    return {
      [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      setPermissionMode: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      mcpServerStatus: async () => [],
      close: () => messages.close(),
    } as unknown as Query;
  }) as ConstructorParameters<typeof ClaudeSession>[1]["query"];
  return { query, launches, messages };
}

const cwd = path.resolve(import.meta.dirname, "..");
const base: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd,
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

const sessions: ClaudeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

const marked = "[approval-required]  Review this call";
const echo = { command: "echo hi" };
const write = { file_path: path.join(cwd, "example.txt"), content: "x" };
const forcePush = { command: "git push --force" };
const once = ["allow_once", "deny"];
const ordinary = ["allow_once", "allow_session", "deny"];

function open(autonomy: SessionOptions["autonomy"]) {
  const sdk = stubSdk();
  const events: AgentEvent[] = [];
  const approvals: ItemOf<"approval_request">[] = [];
  const session = new ClaudeSession(
    { ...base, autonomy },
    { executable: { kind: "native", path: "/bin/claude" }, query: sdk.query },
  );
  sessions.push(session);
  void (async () => {
    for await (const event of session.events) {
      events.push(event);
      if (event.type === "item.started" && event.item.kind === "approval_request") {
        approvals.push(event.item);
      }
    }
  })();
  const options = sdk.launches[0] as Options;
  const canUseTool = options.canUseTool as CanUseTool;
  let n = 0;
  const permission = (tool: string, input: Record<string, unknown>, decisionReason?: string) => {
    n += 1;
    return canUseTool(tool, input, {
      signal: new AbortController().signal,
      toolUseID: `t${n}`,
      requestId: `r${n}`,
      decisionReason,
    } as never) as Promise<PermissionResult>;
  };
  const card = async (count = 1) => {
    await vi.waitFor(() => expect(approvals).toHaveLength(count), { timeout: 500, interval: 5 });
    return approvals[count - 1] as ItemOf<"approval_request">;
  };
  const answer = (
    item: ItemOf<"approval_request">,
    decision: "allow_once" | "allow_session" | "deny",
  ) => session.respond(item.requestId, { kind: "approval", decision });
  const pushAsk = () =>
    sdk.messages.push({
      type: "system",
      subtype: "hook_response",
      hook_name: "PreToolUse:Bash",
      hook_event: "PreToolUse",
      outcome: "success",
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: marked },
      }),
    });
  return { session, permission, approvals, card, answer, pushAsk, messages: sdk.messages, events };
}

describe("Claude settings hooks that require approval", () => {
  it.each(["read_only", "supervised", "auto", "full"] as const)(
    "offers allow once and deny at %s",
    async (autonomy) => {
      const run = open(autonomy);
      const tool = autonomy === "read_only" ? "Read" : "Bash";
      const input = autonomy === "read_only" ? { file_path: write.file_path } : echo;
      const first = run.permission(tool, input, marked);
      const card = await run.card();
      expect(card.options).toEqual(once);
      expect(card.reason).toMatch(/Review this call$/);
      expect(card.reason).not.toContain("[approval-required]");
      await run.answer(card, "allow_once");
      await expect(first).resolves.toEqual({ behavior: "allow", updatedInput: input });

      const second = run.permission(tool, input, marked);
      const next = await run.card(2);
      expect(next.options).toEqual(once);
      await run.answer(next, "deny");
      await expect(second).resolves.toMatchObject({ behavior: "deny" });
    },
  );

  it("rejects allow_session and keeps the card pending, then allows only once", async () => {
    const run = open("supervised");
    const markedCall = run.permission("Bash", echo, marked);
    const card = await run.card();
    await expect(run.answer(card, "allow_session")).rejects.toMatchObject({
      code: "invalid_answer",
    });
    await run.answer(card, "allow_once");
    await expect(markedCall).resolves.toMatchObject({ behavior: "allow" });

    const unmarkedCall = run.permission("Bash", echo);
    const next = await run.card(2);
    expect(next.options).toEqual(ordinary);
    await run.answer(next, "deny");
    await expect(unmarkedCall).resolves.toMatchObject({ behavior: "deny" });
  });

  it("asks even after the ordinary card was allowed for the session", async () => {
    const run = open("supervised");
    const unmarkedCall = run.permission("Bash", echo);
    await run.answer(await run.card(), "allow_session");
    await expect(unmarkedCall).resolves.toMatchObject({ behavior: "allow" });

    const markedCall = run.permission("Bash", echo, marked);
    const card = await run.card(2);
    expect(card.options).toEqual(once);
    await run.answer(card, "deny");
    await expect(markedCall).resolves.toMatchObject({ behavior: "deny" });
  });

  it("uses the hook response when CodeDen's own reason hides the marker", async () => {
    const run = open("auto");
    run.pushAsk();
    const call = run.permission(
      "Bash",
      forcePush,
      "Force-pushes, which can overwrite remote history",
    );
    const card = await run.card();
    expect(card.options).toEqual(once);
    await run.answer(card, "allow_once");
    await expect(call).resolves.toMatchObject({ behavior: "allow" });

    const next = run.permission("Bash", forcePush);
    const ordinaryCard = await run.card(2);
    expect(ordinaryCard.options).toEqual(ordinary);
    await run.answer(ordinaryCard, "deny");
    await expect(next).resolves.toMatchObject({ behavior: "deny" });
  });

  it("clears leftover asks at the end of a turn", async () => {
    const run = open("full");
    await run.session.send({ text: "go", attachments: [] });
    run.pushAsk();
    run.messages.push({ type: "result", subtype: "success", usage: {} });
    await vi.waitFor(() =>
      expect(run.events.some((event) => event.type === "turn.completed")).toBe(true),
    );
    await expect(run.permission("Bash", echo)).resolves.toMatchObject({ behavior: "allow" });
    expect(run.approvals).toHaveLength(0);
  });

  it("still asks after switching from auto to full", async () => {
    const run = open("auto");
    run.pushAsk();
    await run.session.setAutonomy("full");
    const call = run.permission("Bash", echo, marked);
    const card = await run.card();
    expect(card.options).toEqual(once);
    await run.answer(card, "allow_once");
    await expect(call).resolves.toMatchObject({ behavior: "allow" });
    await expect(run.permission("Bash", echo)).resolves.toMatchObject({ behavior: "allow" });
    expect(run.approvals).toHaveLength(1);
  });

  it.each(["auto", "full"] as const)("allows an unmarked safe command at %s", async (autonomy) => {
    const run = open(autonomy);
    await expect(run.permission("Bash", echo, "some reason")).resolves.toMatchObject({
      behavior: "allow",
    });
    expect(run.approvals).toHaveLength(0);
  });

  it.each([
    ["supervised", "Write", write],
    ["auto", "Bash", forcePush],
  ] as const)("keeps the ordinary card at %s for %s", async (autonomy, tool, input) => {
    const run = open(autonomy);
    const call = run.permission(tool, input);
    const card = await run.card();
    expect(card.options).toEqual(ordinary);
    await run.answer(card, "deny");
    await expect(call).resolves.toMatchObject({ behavior: "deny" });
  });

  it.each([undefined, marked])("denies read-only writes with reason %j", async (reason) => {
    const run = open("read_only");
    await expect(run.permission("Write", write, reason)).resolves.toMatchObject({
      behavior: "deny",
    });
    expect(run.approvals).toHaveLength(0);
  });
});
