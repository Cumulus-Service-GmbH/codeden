import path from "node:path";
import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
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
      interrupt: async () => undefined,
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
const forcePushReason = "Force-pushes, which can overwrite remote history";
const once = ["allow_once", "deny"];
const ordinary = ["allow_once", "allow_session", "deny"];

function hookOutput(permissionDecision = "ask", permissionDecisionReason = marked) {
  return JSON.stringify({ hookSpecificOutput: { permissionDecision, permissionDecisionReason } });
}

function open(autonomy: SessionOptions["autonomy"], interruptTimeoutMs = 10_000) {
  const sdk = stubSdk();
  const events: AgentEvent[] = [];
  const approvals: ItemOf<"approval_request">[] = [];
  const session = new ClaudeSession(
    { ...base, autonomy },
    { executable: { kind: "native", path: "/bin/claude" }, query: sdk.query, interruptTimeoutMs },
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
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
  let n = 0;
  const preToolUse = (tool: string, input: Record<string, unknown>, dir: string) => {
    const toolUseId = `t${n + 1}`;
    return hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: input,
        tool_use_id: toolUseId,
        session_id: "x",
        transcript_path: "x",
        cwd: dir,
      },
      toolUseId,
      { signal: new AbortController().signal },
    );
  };
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
  const pushAsk = (tool = "Bash", padding = "") =>
    sdk.messages.push({
      type: "system",
      subtype: "hook_response",
      hook_name: `PreToolUse:${tool}`,
      hook_event: "PreToolUse",
      outcome: "success",
      stdout: `${padding}${hookOutput()}${padding}`,
    });
  return {
    session,
    permission,
    preToolUse,
    approvals,
    card,
    answer,
    pushAsk,
    messages: sdk.messages,
    events,
  };
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
      expect(card.hookReason).toBe(" Review this call");
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
    expect(next.hookReason).toBeUndefined();
    await run.answer(next, "deny");
    await expect(unmarkedCall).resolves.toMatchObject({ behavior: "deny" });
  });

  it("asks even after the ordinary card was allowed for the session", async () => {
    const run = open("supervised");
    const read = { command: "ls -la" };
    const unmarkedCall = run.permission("Bash", read);
    await run.answer(await run.card(), "allow_session");
    await expect(unmarkedCall).resolves.toMatchObject({ behavior: "allow" });

    const markedCall = run.permission("Bash", read, marked);
    const card = await run.card(2);
    expect(card.options).toEqual(once);
    await run.answer(card, "deny");
    await expect(markedCall).resolves.toMatchObject({ behavior: "deny" });
  });

  it("rejects a question answer and keeps the marked card pending", async () => {
    const run = open("auto");
    const call = run.permission("Bash", echo, marked);
    const card = await run.card();
    await expect(
      run.session.respond(card.requestId, { kind: "answer", answers: {} }),
    ).rejects.toMatchObject({ code: "invalid_answer" });
    await run.answer(card, "allow_once");
    await expect(call).resolves.toMatchObject({ behavior: "allow" });
  });

  it.each([
    [forcePush, echo],
    [echo, forcePush],
  ])(
    "keeps both overlapping Bash approvals restricted (%j first)",
    async (firstInput, secondInput) => {
      const run = open("auto");
      await run.session.send({ text: "go", attachments: [] });
      run.pushAsk();
      const first = run.permission("Bash", firstInput);
      const second = run.permission("Bash", secondInput);
      await run.card(2);
      for (const card of run.approvals) {
        expect(card.options).toEqual(once);
        await expect(run.answer(card, "allow_session")).rejects.toMatchObject({
          code: "invalid_answer",
        });
        await run.answer(card, "allow_once");
      }
      await expect(Promise.all([first, second])).resolves.toEqual([
        { behavior: "allow", updatedInput: firstInput },
        { behavior: "allow", updatedInput: secondInput },
      ]);
    },
  );

  it.each(["", "\n\n"])(
    "uses hook stdout with padding %j when CodeDen's reason hides the marker",
    async (padding) => {
      const run = open("auto");
      run.pushAsk("Bash", padding);
      const call = run.permission("Bash", forcePush, forcePushReason);
      const card = await run.card();
      expect(card.options).toEqual(once);
      await run.answer(card, "allow_once");
      await expect(call).resolves.toMatchObject({ behavior: "allow" });
    },
  );

  it.each([
    ["empty stdout with marked output", { stdout: "", output: hookOutput() }, once],
    ["error outcome", { outcome: "error" }, ordinary],
    ["deny decision", { stdout: hookOutput("deny") }, ordinary],
    ["unmarked reason", { stdout: hookOutput("ask", "Review this call") }, ordinary],
    ["another tool", { hook_name: "PreToolUse:Write" }, ordinary],
    ["missing tool name", { hook_name: "PreToolUse:" }, ordinary],
    ["PostToolUse event", { hook_event: "PostToolUse" }, ordinary],
  ] as const)("uses the expected card options for %s", async (_label, fields, options) => {
    const run = open("auto");
    run.messages.push({
      type: "system",
      subtype: "hook_response",
      hook_name: "PreToolUse:Bash",
      hook_event: "PreToolUse",
      outcome: "success",
      stdout: hookOutput(),
      ...fields,
    });
    const call = run.permission("Bash", forcePush, forcePushReason);
    const card = await run.card();
    expect(card.options).toEqual(options);
    await run.answer(card, "deny");
    await expect(call).resolves.toMatchObject({ behavior: "deny" });
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

  it("keeps marked asks after the interrupt deadline until the result", async () => {
    const interruptTimeoutMs = 100;
    const run = open("auto", interruptTimeoutMs);
    await run.session.send({ text: "go", attachments: [] });
    run.pushAsk();
    await new Promise((resolve) => setImmediate(resolve));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await run.session.interrupt();
      await vi.advanceTimersByTimeAsync(interruptTimeoutMs);
    } finally {
      vi.useRealTimers();
    }
    expect(run.events.some((event) => event.type === "turn.interrupted")).toBe(true);
    const call = run.permission("Bash", forcePush, forcePushReason);
    const card = await run.card();
    expect(card.options).toEqual(once);
    await run.answer(card, "allow_once");
    await expect(call).resolves.toMatchObject({ behavior: "allow" });

    run.messages.push({ type: "result", subtype: "success", usage: {} });
    const next = run.permission("Bash", forcePush, forcePushReason);
    const nextCard = await run.card(2);
    expect(nextCard.options).toEqual(ordinary);
    await run.answer(nextCard, "deny");
    await expect(next).resolves.toMatchObject({ behavior: "deny" });
  });

  it.each([undefined, marked])("cancels during the yield with reason %j", async (reason) => {
    const run = open("auto");
    await run.session.send({ text: "go", attachments: [] });
    const call = run.permission("Bash", forcePush, reason);
    await run.session.interrupt();
    await new Promise((resolve) => setImmediate(resolve));
    expect(run.approvals).toHaveLength(0);
    await expect(call).resolves.toEqual({
      behavior: "deny",
      message: "The request was cancelled.",
      interrupt: true,
    });
  });

  it.each([undefined, marked])("shows the Bash hook's cwd with reason %j", async (reason) => {
    const run = open("auto");
    const dir = path.dirname(cwd);
    await run.preToolUse("Bash", forcePush, dir);
    const call = run.permission("Bash", forcePush, reason);
    const card = await run.card();
    expect(card.cwd).toBe(dir);
    await run.answer(card, "deny");
    await expect(call).resolves.toMatchObject({ behavior: "deny" });
  });

  it("cancels a permission request when the session closes during the yield", async () => {
    const run = open("full");
    run.pushAsk();
    const call = run.permission("Bash", echo);
    await run.session.close();
    await expect(call).resolves.toMatchObject({ behavior: "deny", interrupt: true });
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
    const next = run.permission("Bash", echo);
    const nextCard = await run.card(2);
    expect(nextCard.options).toEqual(once);
    await run.answer(nextCard, "deny");
    await expect(next).resolves.toMatchObject({ behavior: "deny" });
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

  it("denies a read-only write after a marked hook response without raising a card", async () => {
    const run = open("read_only");
    run.pushAsk("Write");
    await new Promise((resolve) => setImmediate(resolve));
    await expect(run.permission("Write", write)).resolves.toMatchObject({ behavior: "deny" });
    expect(run.approvals).toHaveLength(0);
  });

  it.each([undefined, marked])("denies read-only writes with reason %j", async (reason) => {
    const run = open("read_only");
    await expect(run.permission("Write", write, reason)).resolves.toMatchObject({
      behavior: "deny",
    });
    expect(run.approvals).toHaveLength(0);
  });
});
