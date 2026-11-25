import path from "node:path";
import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../src/claude/adapter";
import { ClaudeSession } from "../src/claude/session";

/** A stand-in for the SDK's `query()`: records options and permission-mode changes. */
function stubSdk(
  opts: {
    refuseBypass?: boolean;
    dispose?: () => Promise<void>;
    setMode?: (mode: PermissionMode) => Promise<void>;
  } = {},
) {
  const launches: Options[] = [];
  const modes: PermissionMode[] = [];
  /** Ends the latest query, as if the CLI exited. */
  let exit = () => {};
  const query = ((params: { options: Options }) => {
    launches.push(params.options);
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    exit = () => finish();
    const q = {
      // Yields no messages; the stream ends when the query is closed or exits.
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await done;
          return { done: true as const, value: undefined };
        },
      }),
      setPermissionMode: async (mode: PermissionMode) => {
        if (opts.refuseBypass && mode === "bypassPermissions") throw new Error("not allowed");
        modes.push(mode);
        await opts.setMode?.(mode);
      },
      interrupt: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      close: () => finish(),
      ...(opts.dispose
        ? {
            [Symbol.asyncDispose]: async () => {
              await opts.dispose?.();
              finish();
            },
          }
        : {}),
    };
    return q as unknown as Query;
  }) as unknown as ConstructorParameters<typeof ClaudeSession>[1]["query"];
  return { query, launches, modes, exit: () => exit() };
}

// A worktree outside the OS temp directory, and a file outside both.
const cwd = path.resolve(import.meta.dirname, "..");
const outside = path.join(path.parse(cwd).root, "codeden-outside", "x.txt");

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
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

function open(sdk: ReturnType<typeof stubSdk>, opts: Partial<SessionOptions> = {}) {
  const events: AgentEvent[] = [];
  const session = new ClaudeSession(
    { ...base, ...opts },
    { executable: { kind: "native", path: "/bin/claude" } as never, query: sdk.query },
  );
  sessions.push(session);
  void (async () => {
    for await (const e of session.events) events.push(e);
  })();
  const options = sdk.launches[0] as Options;
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
  const canUseTool = options.canUseTool as CanUseTool;
  let n = 0;
  const preToolUse = async (tool: string, input: Record<string, unknown>) => {
    const out = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: input,
        tool_use_id: `t${++n}`,
        session_id: "x",
        transcript_path: "x",
        cwd,
      } as never,
      `t${n}`,
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    return out.hookSpecificOutput?.permissionDecision ?? "none";
  };
  const permission = (tool: string, input: Record<string, unknown>) => {
    n += 1;
    return canUseTool(tool, input, {
      signal: new AbortController().signal,
      toolUseID: `t${n}`,
      requestId: `r${n}`,
    } as never) as Promise<PermissionResult>;
  };
  const approvals = () =>
    events.filter((e) => e.type === "item.started" && e.item.kind === "approval_request");
  return { session, events, preToolUse, permission, approvals };
}

it("joins concurrent closes until the SDK is finished disposing", async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const dispose = vi.fn(() => promise);
  const { session } = open(stubSdk({ dispose }));
  const first = session.close();
  const completed = vi.fn();
  const second = session.close().then(completed);
  try {
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
  } finally {
    resolve();
    await Promise.all([first, second]);
  }
  expect(dispose).toHaveBeenCalledTimes(1);
});

it.each([
  [true, "chrome"],
  [false, "no-chrome"],
  [undefined, "no-chrome"],
])("launches the Claude SDK with Chrome set to %s", (chrome, flag) => {
  const sdk = stubSdk();
  open(sdk, { chrome, env: { CLAUDE_CODE_ENABLE_CFC: "1" } });
  expect(sdk.launches[0]?.extraArgs).toEqual({ [flag]: null });
});

const settle = () => new Promise((r) => setTimeout(r, 20));
const forcePush = { command: "git push --force" };
const writeOutside = { file_path: outside, content: "x" };

it.each([undefined, "prior-session"])(
  "waits for Supervised mode before acknowledging an open with resume token %s",
  async (resumeToken) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const sdk = stubSdk({ setMode: () => promise });
    const adapter = new ClaudeAdapter({
      executable: { kind: "native", path: "/synthetic/claude" },
      loadSdk: async () => ({
        query: sdk.query,
        forkSession: vi.fn(),
        getSessionMessages: vi.fn(),
      }),
    });
    const opened = vi.fn();
    const opening = adapter.openSession({ ...base, autonomy: "supervised", resumeToken });
    void opening.then(opened, opened);
    try {
      await vi.waitFor(() => expect(sdk.modes).toEqual(["default"]));
      expect(sdk.launches[0]?.permissionMode).toBe("default");
      expect(sdk.launches[0]?.resume).toBe(resumeToken);
      expect(sdk.launches[0]?.allowDangerouslySkipPermissions).toBeUndefined();
      expect(opened).not.toHaveBeenCalled();
    } finally {
      resolve();
      await (await opening).close();
    }
  },
);

it("refuses a Supervised restore and disposes the query if the native write fails", async () => {
  const dispose = vi.fn(async () => {});
  const sdk = stubSdk({
    dispose,
    setMode: async () => {
      throw new Error("Synthetic mode refusal");
    },
  });
  const adapter = new ClaudeAdapter({
    executable: { kind: "native", path: "/synthetic/claude" },
    loadSdk: async () => ({
      query: sdk.query,
      forkSession: vi.fn(),
      getSessionMessages: vi.fn(),
    }),
  });
  const opened = adapter.openSession({ ...base, autonomy: "supervised", resumeToken: "prior" });
  try {
    await expect(opened).rejects.toMatchObject({ code: "config_unconfirmed" });
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    await opened.then(
      (session) => session.close(),
      () => {},
    );
  }
});

it("waits for the current Supervised mode after reopening a formerly Full query", async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const restartMode = vi.fn(() => Promise.resolve());
  const sdk = stubSdk({ setMode: restartMode });
  const { session, events } = open(sdk, { autonomy: "full", resumeToken: "prior" });
  await session.setAutonomy("supervised");
  sdk.exit();
  await new Promise<void>((done) => setImmediate(done));
  restartMode.mockReturnValue(promise);
  const sent = vi.fn();
  const sending = session.send({ text: "Continue", attachments: [] }).then(sent);
  try {
    await vi.waitFor(() => expect(sdk.modes).toEqual(["default", "default"]));
    expect(sdk.launches[1]).toMatchObject({ permissionMode: "default", resume: "prior" });
    expect(sdk.launches[1]?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(sent).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "turn.started")).toBe(false);
  } finally {
    resolve();
    await sending;
  }
});

it("rejects input that was waiting across a change from Supervised to Full", async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const sdk = stubSdk({ setMode: (mode) => (mode === "default" ? promise : Promise.resolve()) });
  const { session } = open(sdk, { autonomy: "supervised" });
  const sending = session.send({ text: "Continue", attachments: [] });
  const proof = expect(sending).rejects.toMatchObject({ code: "config_unconfirmed" });
  const switching = session.setAutonomy("full");
  resolve();
  await switching;
  await proof;
  await expect(session.send({ text: "Full input", attachments: [] })).resolves.toBeUndefined();
});

it("refuses input after a failed tightening until a reconfigure confirms Supervised mode", async () => {
  const setMode = vi.fn<(mode: PermissionMode) => Promise<void>>();
  setMode.mockRejectedValueOnce(new Error("Synthetic mode refusal"));
  const sdk = stubSdk({ setMode });
  const { session, events } = open(sdk, { autonomy: "full" });
  await expect(session.setAutonomy("supervised")).rejects.toThrow("Synthetic mode refusal");
  await expect(session.compact()).rejects.toMatchObject({ code: "config_unconfirmed" });
  expect(events.some((event) => event.type === "turn.started")).toBe(false);

  setMode.mockResolvedValue(undefined);
  await session.setAutonomy("supervised");
  await expect(session.compact()).resolves.toBeUndefined();
  expect(sdk.modes).toEqual(["default", "default"]);
});

it("serializes competing input after the query confirms Supervised mode", async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const sdk = stubSdk({ setMode: () => promise });
  const { session } = open(sdk, { autonomy: "supervised" });
  const sending = session.send({ text: "Continue", attachments: [] });
  const compacting = session.compact();
  const result = Promise.allSettled([sending, compacting]);
  resolve();
  const outcomes = await result;
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes).toContainEqual({
    status: "rejected",
    reason: expect.objectContaining({ code: "turn_running" }),
  });
});

it.each([
  ["computer", { action: "type", text: "example" }],
  ["computer", { action: "key", text: "a" }],
  ["form_input", { ref: "ref_1", value: "example" }],
  ["javascript_tool", { text: "example" }],
] as const)(
  "refuses Chrome input through %s at both permission boundaries",
  async (name, input) => {
    const { preToolUse, permission, approvals } = open(stubSdk(), { chrome: true });
    const tool = `mcp__claude-in-chrome__${name}`;
    expect(await preToolUse(tool, input)).toBe("deny");
    expect(await permission(tool, input)).toMatchObject({ behavior: "deny" });
    expect(approvals()).toHaveLength(0);
  },
);

it.each(["supervised", "auto", "full", "read_only"] as const)(
  "requires single-use Chrome tool approval in %s",
  async (autonomy) => {
    const sdk = stubSdk();
    const { session, preToolUse, permission, approvals } = open(sdk, { autonomy, chrome: true });
    const tool = "mcp__claude-in-chrome__navigate";
    const input = { url: "https://example.com/" };
    expect(await preToolUse(tool, input)).toBe("ask");
    const decision = permission(tool, input);
    await vi.waitFor(() => expect(approvals()).toHaveLength(1));
    const first = approvals()[0];
    if (first?.type !== "item.started" || first.item.kind !== "approval_request") {
      throw new Error("Expected approval");
    }
    expect(first.item.options).toEqual(["allow_once", "deny"]);
    await expect(
      session.respond(first.item.requestId, { kind: "approval", decision: "allow_session" }),
    ).rejects.toMatchObject({ code: "invalid_answer" });
    // Only an approval the server stamped as the user's allows it, never one without a decider.
    for (const decidedBy of [undefined, "pm", "policy"] as const) {
      await expect(
        session.respond(first.item.requestId, {
          kind: "approval",
          decision: "allow_once",
          ...(decidedBy ? { decidedBy } : {}),
        }),
      ).rejects.toMatchObject({ code: "invalid_answer" });
    }
    await session.respond(first.item.requestId, {
      kind: "approval",
      decision: "allow_once",
      decidedBy: "user",
    });
    await expect(decision).resolves.toMatchObject({ behavior: "allow" });

    expect(await preToolUse(tool, input)).toBe("ask");
    const again = permission(tool, input);
    await vi.waitFor(() => expect(approvals()).toHaveLength(2));
    const second = approvals()[1];
    if (second?.type !== "item.started" || second.item.kind !== "approval_request") {
      throw new Error("Expected another approval");
    }
    await session.respond(second.item.requestId, { kind: "approval", decision: "deny" });
    await expect(again).resolves.toMatchObject({ behavior: "deny" });
  },
);

describe("Claude autonomy changes on a live session", () => {
  it("stops asking for in-worktree risky actions after a switch to full", async () => {
    const sdk = stubSdk();
    const { session, preToolUse, permission, approvals } = open(sdk);
    await session.send({ text: "go", attachments: [] });

    expect(await preToolUse("Bash", forcePush)).toBe("ask");
    await session.setAutonomy("full");
    expect(sdk.modes).toEqual(["bypassPermissions"]);
    expect(await preToolUse("Bash", forcePush)).toBe("none");
    expect(await permission("Bash", forcePush)).toMatchObject({ behavior: "allow" });
    expect(approvals()).toHaveLength(0);

    // Writes outside the worktree and temp still ask.
    expect(await preToolUse("Write", writeOutside)).toBe("ask");
    void permission("Write", writeOutside);
    await settle();
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]).toMatchObject({ item: { action: "outside_worktree" } });
  });

  it("keeps approvals that were already waiting, and asks for nothing new", async () => {
    const sdk = stubSdk();
    const { session, permission, approvals } = open(sdk);
    await session.send({ text: "go", attachments: [] });

    let answered: PermissionResult | undefined;
    void permission("Bash", forcePush).then((r) => {
      answered = r;
    });
    await settle();
    expect(approvals()).toHaveLength(1);

    await session.setAutonomy("full");
    await settle();
    expect(answered).toBeUndefined();
    expect(await permission("Bash", { command: "git push -f origin main" })).toMatchObject({
      behavior: "allow",
    });
    expect(approvals()).toHaveLength(1);

    const first = approvals()[0];
    if (first?.type !== "item.started" || first.item.kind !== "approval_request") throw new Error();
    await session.respond(first.item.requestId, { kind: "approval", decision: "allow_once" });
    await settle();
    expect(answered).toMatchObject({ behavior: "allow" });
  });

  it("tightens too: supervised asks for every command from the next call", async () => {
    const sdk = stubSdk();
    const { session, preToolUse } = open(sdk, { autonomy: "full" });
    expect(await preToolUse("Bash", { command: "ls" })).toBe("none");
    await session.setAutonomy("supervised");
    expect(sdk.modes).toEqual(["default"]);
    expect(await preToolUse("Bash", { command: "ls" })).toBe("ask");
  });

  it("falls back to acceptEdits when the CLI refuses bypassPermissions", async () => {
    const sdk = stubSdk({ refuseBypass: true });
    const { session, preToolUse } = open(sdk);
    await session.setAutonomy("full");
    expect(sdk.modes).toEqual(["acceptEdits"]);
    // CodeDen's policy still follows the new level.
    expect(await preToolUse("Bash", forcePush)).toBe("none");
  });

  it("leaves plan mode alone and starts a restarted query with the new level", async () => {
    const sdk = stubSdk();
    const { session } = open(sdk, { planMode: true });
    await session.setAutonomy("full");
    expect(sdk.modes).toEqual([]);

    const plain = stubSdk();
    const fresh = open(plain);
    expect(plain.launches[0]?.permissionMode).toBe("acceptEdits");
    await fresh.session.setAutonomy("full");
    plain.exit();
    await settle();
    await fresh.session.send({ text: "again", attachments: [] });
    expect(plain.launches).toHaveLength(2);
    expect(plain.launches[1]).toMatchObject({ permissionMode: "bypassPermissions" });
  });
});
