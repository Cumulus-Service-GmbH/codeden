import path from "node:path";
import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, RunnerCommand, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../../apps/server/src/db/client";
import { EventStore } from "../../../apps/server/src/events/store";
import { sessionRoutes } from "../../../apps/server/src/routes/sessions";
import type { AppServices } from "../../../apps/server/src/services/container";
import { emptyStartMeta, SessionRepo } from "../../../apps/server/src/services/sessions/repo";
import {
  SessionService,
  type SessionServiceDeps,
} from "../../../apps/server/src/services/sessions/session-service";
import { sampleSession } from "../../../apps/server/test/helpers";
import {
  planLevelChanges,
  sessionsKeepingLevel,
} from "../../../apps/web/src/lib/project-permissions";
import { KEEP_PLANNING } from "../src/claude/plan-review";
import { ClaudeSession } from "../src/claude/session";

/**
 * A stand-in for the SDK's `query()`: records options and the permission modes the CLI took,
 * refuses the modes in `refuse`, and lets a test deliver SDK messages (`deliver`) as if the CLI
 * sent them.
 */
function stubSdk() {
  const launches: Options[] = [];
  const modes: PermissionMode[] = [];
  const beforeMode = vi.fn(async (_mode: PermissionMode) => {});
  const refuse = new Set<PermissionMode>();
  let deliver: (message: unknown) => void = () => {};
  let exit = () => {};
  const query = ((params: { options: Options }) => {
    launches.push(params.options);
    const inbox: unknown[] = [];
    let wake = () => {};
    let ended = false;
    deliver = (message) => {
      inbox.push(message);
      wake();
    };
    exit = () => {
      ended = true;
      wake();
    };
    const q = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (inbox.length === 0 && !ended) await new Promise<void>((r) => (wake = r));
          const value = inbox.shift();
          return value === undefined ? { done: true as const, value } : { done: false, value };
        },
      }),
      setPermissionMode: async (mode: PermissionMode) => {
        await beforeMode(mode);
        if (refuse.has(mode)) throw new Error(`Cannot set permission mode to ${mode}`);
        modes.push(mode);
      },
      setModel: async () => undefined,
      interrupt: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      close: () => exit(),
    };
    return q as unknown as Query;
  }) as unknown as ConstructorParameters<typeof ClaudeSession>[1]["query"];
  return {
    query,
    launches,
    modes,
    beforeMode,
    refuse,
    deliver: (m: unknown) => deliver(m),
    exit: () => exit(),
  };
}

// A worktree outside the OS temp directory, and Claude's plans folder outside both.
const cwd = path.resolve(import.meta.dirname, "..");
const plans = path.join(path.parse(cwd).root, "claude-home", ".claude", "plans");

const base: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd,
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: true,
};

const sessions: ClaudeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const settle = () => new Promise((r) => setTimeout(r, 20));

function open(sdk: ReturnType<typeof stubSdk>, opts: Partial<SessionOptions> = {}) {
  const events: AgentEvent[] = [];
  const session = new ClaudeSession(
    { ...base, ...opts },
    {
      executable: { kind: "native", path: "/bin/claude" } as never,
      query: sdk.query,
      notesRoots: [plans],
    },
  );
  sessions.push(session);
  void (async () => {
    for await (const e of session.events) events.push(e);
  })();
  const options = sdk.launches[0] as Options;
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
  const canUseTool = options.canUseTool as CanUseTool;
  const preToolUse = async (
    tool: string,
    input: Record<string, unknown>,
    permission_mode?: PermissionMode,
  ) => {
    const out = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: input,
        cwd,
        permission_mode,
      } as never,
      "t",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    return out.hookSpecificOutput?.permissionDecision ?? "none";
  };
  const permission = (tool: string, input: Record<string, unknown>, id: string) =>
    canUseTool(tool, input, {
      signal: new AbortController().signal,
      toolUseID: id,
      requestId: `r-${id}`,
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    } as never) as Promise<PermissionResult>;
  const items = (kind: string) =>
    events.flatMap((e) =>
      (e.type === "item.started" || e.type === "item.completed") && e.item.kind === kind
        ? [e.item]
        : [],
    );
  const planUpdates = () =>
    events.filter((e) => e.type === "session.updated" && e.planMode !== undefined);
  return { session, events, preToolUse, permission, items, planUpdates };
}

const toolResult = (id: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});

const inWorktree = { file_path: path.join(cwd, "src", "x.ts"), content: "x" };
const planFile = { file_path: path.join(plans, "quiet-river.md"), content: "# Plan" };

describe("Claude plan mode", () => {
  it("starts in plan mode and stays there while the level changes", async () => {
    const sdk = stubSdk();
    const { session } = open(sdk, { autonomy: "full" });
    expect(sdk.launches[0]).toMatchObject({
      permissionMode: "plan",
      // So the session can switch to bypassPermissions once the plan is approved.
      allowDangerouslySkipPermissions: true,
    });
    await session.setAutonomy("supervised");
    expect(sdk.modes).toEqual(["plan"]);
  });

  it("refuses edits and writing commands while planning, even under Full", async () => {
    const sdk = stubSdk();
    const { session, preToolUse, permission } = open(sdk, { autonomy: "full" });
    expect(await preToolUse("Write", inWorktree)).toBe("deny");
    expect(await permission("Edit", { ...inWorktree, old_string: "a" }, "t1")).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("Plan mode"),
    });
    expect(await preToolUse("Bash", { command: "rm -rf src" })).toBe("deny");
    // Reading, checks and Claude's own plan file are fine.
    expect(await preToolUse("Bash", { command: "git status" })).toBe("none");
    expect(await preToolUse("Read", { file_path: inWorktree.file_path })).toBe("none");
    expect(await preToolUse("Write", planFile)).toBe("none");

    await session.setPlanMode(false);
    expect(sdk.modes).toEqual(["bypassPermissions"]);
    expect(await preToolUse("Write", inWorktree)).toBe("none");
    expect(await preToolUse("Bash", { command: "rm -rf src" })).toBe("none");
  });

  it("refuses writing commands at every level, through the hook and canUseTool", async () => {
    const writes = [
      "sort -o src/plan-bypass.txt README.md",
      "sort.exe /O src/plan-bypass.txt README.md",
      "sort /output:src/plan-bypass.txt README.md",
      "sort -'o' src/plan-bypass.txt README.md",
      'sort -"o" src/plan-bypass.txt README.md',
      "find -- . -fprint src/list.txt",
      "find -- . -delete",
      "git diff --output=src/plan-bypass.txt",
      "git branch feature",
      "ls & touch src/x.txt",
      "sort --output=src/plan-bypass.txt README.md",
      "uniq README.md src/copy.md",
      "find . -fprint src/list.txt",
      "Write-Output (Remove-Item src -Recurse)",
    ];
    for (const autonomy of ["read_only", "supervised", "auto", "full"] as const) {
      const { preToolUse, permission } = open(stubSdk(), { autonomy });
      for (const command of writes) {
        expect(await preToolUse("Bash", { command }), `${autonomy}: ${command}`).toBe("deny");
        expect(await permission("Bash", { command }, `b-${autonomy}`)).toMatchObject({
          behavior: "deny",
        });
      }
      expect(await preToolUse("Write", inWorktree), autonomy).toBe("deny");
      expect(await permission("Write", inWorktree, `w-${autonomy}`)).toMatchObject({
        behavior: "deny",
      });
    }
  });

  it("lets a planning agent write its plan file at every level", async () => {
    for (const autonomy of ["read_only", "auto", "full"] as const) {
      const { preToolUse, permission } = open(stubSdk(), { autonomy });
      expect(await preToolUse("Write", planFile), autonomy).toBe("none");
      expect(await permission("Write", planFile, `p-${autonomy}`)).toMatchObject({
        behavior: "allow",
      });
    }
    // Supervised asks for every edit, the plan file too, but never refuses it.
    const supervised = open(stubSdk(), { autonomy: "supervised" });
    expect(await supervised.preToolUse("Write", planFile)).toBe("ask");
  });

  it("keeps the plan file writable when the level drops to read-only while planning", async () => {
    const { session, preToolUse } = open(stubSdk(), { autonomy: "auto" });
    await session.setAutonomy("read_only");
    expect(await preToolUse("Write", planFile)).toBe("none");
    expect(await preToolUse("Write", inWorktree)).toBe("deny");
    expect(await preToolUse("Bash", { command: "sort -o src/x.txt README.md" })).toBe("deny");
    // Out of plan mode the read_only level refuses every edit again, notes included.
    await session.setPlanMode(false);
    expect(await preToolUse("Write", planFile)).toBe("deny");
    // Read-only roles (orchestrator, PMs) never get the notes exception.
    const role = open(stubSdk(), { autonomy: "auto", readOnly: true, role: "pm" });
    expect(await role.preToolUse("Write", planFile)).toBe("deny");
  });

  it("rejects a mode change the CLI refuses, and sends it again when retried", async () => {
    const sdk = stubSdk();
    const { session, preToolUse } = open(sdk, { planMode: false });
    sdk.refuse.add("plan");
    await expect(session.setPlanMode(true)).rejects.toThrow(/plan/);
    expect(sdk.modes).toEqual([]);
    // CodeDen's own policy plans already, so nothing is edited meanwhile.
    expect(await preToolUse("Write", inWorktree)).toBe("deny");
    // The retry (CodeDen kept the change pending) reaches the CLI again.
    sdk.refuse.delete("plan");
    await session.setPlanMode(true);
    expect(sdk.modes).toEqual(["plan"]);
  });

  it("falls back to acceptEdits for Full, and rejects when the fallback is refused too", async () => {
    const sdk = stubSdk();
    const { session } = open(sdk, { autonomy: "full" });
    sdk.refuse.add("bypassPermissions");
    await session.setPlanMode(false);
    expect(sdk.modes).toEqual(["acceptEdits"]);
    sdk.refuse.add("acceptEdits");
    await expect(session.setAutonomy("full")).rejects.toThrow(/acceptEdits/);
  });

  it("keeps the prior Full fallback without repeating corrections", async () => {
    const sdk = stubSdk();
    const { session, preToolUse, items } = open(sdk, { autonomy: "full" });
    sdk.refuse.add("bypassPermissions");
    await session.setPlanMode(false);
    await session.send({ text: "Check mode", attachments: [] });
    await preToolUse("Write", inWorktree, "acceptEdits");
    await settle();
    expect(sdk.modes).toEqual(["acceptEdits"]);
    expect(items("notice")).toEqual([]);
  });

  it("surfaces a pending plan-mode refusal across an autonomy change", async () => {
    const sdk = stubSdk();
    const { session } = open(sdk, { planMode: false });
    const refusal = Promise.withResolvers<void>();
    sdk.beforeMode.mockImplementationOnce(() => refusal.promise);
    const switching = session.setPlanMode(true);
    await vi.waitFor(() => expect(sdk.beforeMode).toHaveBeenCalledWith("plan"));
    await session.setAutonomy("full");
    refusal.reject(new Error("Plan mode unavailable"));
    await expect(switching).rejects.toThrow("Plan mode unavailable");
  });

  it.each([
    ["the tool result", toolResult("exit")],
    ["turn end", { type: "result", subtype: "success" }],
  ])("recognizes the Full plan transition after %s", async (_end, completion) => {
    const sdk = stubSdk();
    const { session, items, permission } = open(sdk, { autonomy: "full" });
    await session.send({ text: "Plan this change", attachments: [] });
    const approved = permission("ExitPlanMode", { plan: "Change x" }, "exit");
    await vi.waitFor(() => expect(items("approval_request")).toHaveLength(1));
    await session.respond("r-exit", { kind: "approval", decision: "allow_once" });
    await approved;
    sdk.deliver({ type: "system", subtype: "status", permissionMode: "acceptEdits" });
    await settle();
    expect(sdk.modes).toEqual([]);
    expect(items("notice")).toEqual([]);
    const update = Promise.withResolvers<void>();
    sdk.beforeMode.mockImplementationOnce(() => update.promise);
    sdk.deliver(completion);
    await vi.waitFor(() => expect(sdk.beforeMode).toHaveBeenCalledWith("bypassPermissions"));
    sdk.deliver({ type: "system", subtype: "status", permissionMode: "acceptEdits" });
    await settle();
    update.resolve();
    await settle();
    expect(sdk.beforeMode.mock.calls).toEqual([["bypassPermissions"]]);
    expect(sdk.modes).toEqual(["bypassPermissions"]);
    expect(items("notice")).toEqual([]);
  });

  it("recognizes the previous mode while a configuration change is pending", async () => {
    const sdk = stubSdk();
    const { session, items, preToolUse } = open(sdk, { planMode: false });
    await session.send({ text: "Check mode", attachments: [] });
    const update = Promise.withResolvers<void>();
    sdk.beforeMode.mockImplementationOnce(() => update.promise);
    const switching = session.setAutonomy("supervised");
    await preToolUse("Read", inWorktree, "acceptEdits");
    await vi.waitFor(() => expect(sdk.beforeMode).toHaveBeenCalledWith("default"));
    sdk.deliver({ type: "system", subtype: "status", permissionMode: "acceptEdits" });
    await settle();
    update.resolve();
    await switching;
    await settle();
    expect(sdk.modes).toEqual(["default"]);
    expect(items("notice")).toEqual([]);
  });

  it("approving the plan continues at the session's permission level", async () => {
    const sdk = stubSdk();
    const { session, preToolUse, permission, items, planUpdates } = open(sdk);
    await session.send({ text: "plan it", attachments: [] });

    let result: PermissionResult | undefined;
    void permission("ExitPlanMode", { plan: "## Plan\n1. Change x" }, "p1").then((r) => {
      result = r;
    });
    await settle();
    expect(items("plan")).toMatchObject([{ kind: "plan", text: "## Plan\n1. Change x" }]);
    const [approval] = items("approval_request");
    expect(approval).toMatchObject({ action: "plan", options: ["allow_once", "deny"] });
    if (approval?.kind !== "approval_request") throw new Error("no approval");

    await session.respond(approval.requestId, { kind: "approval", decision: "allow_once" });
    await settle();
    expect(result).toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    expect(planUpdates()).toEqual([{ type: "session.updated", planMode: false }]);
    expect(await preToolUse("Write", inWorktree)).toBe("none");

    // Once ExitPlanMode has run, the level is set again in case the CLI chose its own mode.
    expect(sdk.modes).toEqual([]);
    sdk.deliver(toolResult("p1"));
    await settle();
    expect(sdk.modes).toEqual(["acceptEdits"]);
    // Out of plan mode, level changes reach the CLI again.
    await session.setAutonomy("supervised");
    expect(sdk.modes).toEqual(["acceptEdits", "default"]);
  });

  it("drops a delayed Full fallback from the post-plan reset after switching to Supervised", async () => {
    const sdk = stubSdk();
    const { session, permission, items } = open(sdk, { autonomy: "full" });
    const exitPlan = permission("ExitPlanMode", { plan: "Change x" }, "exit");
    await vi.waitFor(() => expect(items("approval_request")).toHaveLength(1));
    await session.respond("r-exit", { kind: "approval", decision: "allow_once" });
    await exitPlan;

    const refusal = Promise.withResolvers<void>();
    sdk.beforeMode.mockImplementationOnce(() => refusal.promise);
    sdk.deliver(toolResult("exit"));
    await vi.waitFor(() => expect(sdk.beforeMode).toHaveBeenCalledWith("bypassPermissions"));
    const switched = session.setAutonomy("supervised");
    refusal.reject(new Error("Full unavailable"));
    await switched;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sdk.modes).toEqual(["default"]);
  });

  it.each(["plan approval", "autonomy change"] as const)(
    "ends in Supervised when the %s comes first",
    async (first) => {
      const sdk = stubSdk();
      const { session, permission, preToolUse, items } = open(sdk, { autonomy: "full" });
      await session.send({ text: "Plan this change", attachments: [] });
      const exitPlan = permission("ExitPlanMode", { plan: "Change x" }, "exit");
      await vi.waitFor(() => expect(items("approval_request")).toHaveLength(1));
      const write = Promise.withResolvers<void>();
      sdk.beforeMode.mockImplementationOnce(() => write.promise);
      const approve = async () => {
        await session.respond("r-exit", { kind: "approval", decision: "allow_once" });
        return exitPlan;
      };
      const earlyApproval = first === "plan approval" ? await approve() : undefined;
      const switching = session.setAutonomy("supervised");
      const changeMode = earlyApproval ? "default" : "plan";
      await vi.waitFor(() => expect(sdk.beforeMode).toHaveBeenCalledWith(changeMode));
      const approval = earlyApproval ?? (await approve());
      const exitMode = earlyApproval ? "acceptEdits" : "default";
      expect(approval).toMatchObject({
        behavior: "allow",
        updatedPermissions: [{ type: "setMode", mode: exitMode, destination: "session" }],
      });
      // The CLI applies the approval's mode while the explicit write is still pending.
      sdk.modes.push(exitMode);
      await preToolUse("Read", inWorktree, exitMode);
      sdk.deliver(toolResult("exit"));
      write.resolve();
      await switching;
      await vi.waitFor(() => expect(sdk.modes.at(-1)).toBe("default"));
      await settle();
      expect(sdk.modes).toEqual([exitMode, changeMode, "default"]);
      expect(sdk.beforeMode.mock.calls).toEqual([[changeMode], ["default"]]);
      expect(items("notice")).toEqual([]);
    },
  );

  it("reasserts default after approving a plan in Supervised", async () => {
    const sdk = stubSdk();
    const { session, permission, items } = open(sdk, { autonomy: "supervised" });
    const exitPlan = permission("ExitPlanMode", { plan: "Change x" }, "exit");
    await vi.waitFor(() => expect(items("approval_request")).toHaveLength(1));
    await session.respond("r-exit", { kind: "approval", decision: "allow_once" });
    await expect(exitPlan).resolves.toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
    });
    sdk.deliver(toolResult("exit"));
    await vi.waitFor(() => expect(sdk.modes.at(-1)).toBe("default"));
  });

  it.each(["allow_once", "allow_session"] as const)(
    "keeps a Supervised %s approval in default mode",
    async (approval) => {
      const sdk = stubSdk();
      const { session, permission, items } = open(sdk, { autonomy: "supervised", planMode: false });
      const input = approval === "allow_once" ? { command: "pwd" } : { command: "ls -la" };
      const decision = permission("Bash", input, "read");
      await vi.waitFor(() => expect(items("approval_request")).toHaveLength(1));
      expect(sdk.modes).toEqual(["default"]);
      await session.respond("r-read", { kind: "approval", decision: approval, decidedBy: "user" });
      await expect(decision).resolves.toEqual({
        behavior: "allow",
        updatedInput: { command: expect.any(String) },
        updatedPermissions: [],
      });
      expect(sdk.modes).toEqual(["default", "default"]);
      if (approval === "allow_session") {
        await expect(permission("Bash", input, "read-again")).resolves.toEqual({
          behavior: "allow",
          updatedInput: { command: expect.any(String) },
          updatedPermissions: [],
        });
        expect(sdk.modes).toEqual(["default", "default", "default"]);
        expect(items("approval_request")).toHaveLength(2);
      }
    },
  );

  it("keeps Claude's native mode locked after applying a project level to an open session", async () => {
    const sdk = stubSdk();
    const { session, permission, items } = open(sdk, { autonomy: "supervised", planMode: false });
    const database = openDatabase(":memory:");
    try {
      const repo = new SessionRepo(database.db, new EventStore(database.db));
      const row = {
        ...sampleSession,
        projectId: "p1",
        provider: "claude",
        autonomy: "supervised",
        status: "waiting",
      } as const;
      repo.create(row, emptyStartMeta());
      const sessions = new SessionService({
        repo,
        runner: {
          providers: () => [{ id: "claude", capabilities: { supervised: true } }],
          request: async (command: RunnerCommand) => {
            if (command.name !== "session.configure" || !command.autonomy) {
              throw new Error("Expected an explicit autonomy change");
            }
            await session.setAutonomy(command.autonomy);
            return { revision: command.revision };
          },
        },
      } as unknown as SessionServiceDeps);
      const app = sessionRoutes({ sessions } as AppServices, "token");
      const patch = async (autonomy: typeof row.autonomy | "full") => {
        const response = await app.request("/s1", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ autonomy }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ autonomy });
      };

      const pending = permission("Bash", { command: "pwd" }, "before-bulk");
      await vi.waitFor(() => expect(items("approval_request")).toHaveLength(1));
      await patch("full");

      const keeping = sessionsKeepingLevel([repo.get(row.id)], row.projectId, "supervised");
      const [change] = planLevelChanges(keeping, "supervised", []);
      expect(change).toMatchObject({ from: "full", to: "supervised", raises: false });
      if (change?.to !== "supervised") throw new Error("Expected the project's permission level");
      await patch(change.to);
      expect(sdk.modes.at(-1)).toBe("default");
      const beforeApproval = sdk.modes.length;
      await session.respond("r-before-bulk", { kind: "approval", decision: "allow_once" });
      await expect(pending).resolves.toMatchObject({ behavior: "allow", updatedPermissions: [] });
      expect(sdk.modes.slice(beforeApproval).every((mode) => mode === "default")).toBe(true);

      await patch("full");
      expect(sdk.modes.at(-1)).toBe("bypassPermissions");
      expect(repo.get(row.id).autonomy).toBe("full");
    } finally {
      database.close();
    }
  });

  it.each(["init", "status", "hook"] as const)(
    "warns and corrects native mode drift from %s",
    async (source) => {
      const sdk = stubSdk();
      const { session, items, preToolUse } = open(sdk, { autonomy: "supervised", planMode: false });
      await session.send({ text: "Check mode", attachments: [] });
      if (source === "hook") {
        expect(await preToolUse("Write", inWorktree, "acceptEdits")).toBe("ask");
      } else {
        sdk.deliver({ type: "system", subtype: source, permissionMode: "acceptEdits" });
      }
      await vi.waitFor(() =>
        expect(items("notice")).toMatchObject([
          { level: "warning", code: "claude_permission_mode_drift" },
        ]),
      );
      await vi.waitFor(() => expect(sdk.modes).toEqual(["default", "default"]));
    },
  );

  it("reasserts default at resume, after configuration and on query restart", async () => {
    const sdk = stubSdk();
    const { session } = open(sdk, {
      autonomy: "supervised",
      planMode: false,
      resumeToken: "prior",
    });
    expect(sdk.launches[0]).toMatchObject({ resume: "prior", permissionMode: "default" });
    await vi.waitFor(() => expect(sdk.modes).toEqual(["default"]));
    await session.configure({ model: "claude-sonnet" });
    expect(sdk.modes).toEqual(["default", "default"]);
    sdk.exit();
    await settle();
    await session.send({ text: "Continue", attachments: [] });
    expect(sdk.launches[1]).toMatchObject({ resume: "prior", permissionMode: "default" });
    await vi.waitFor(() => expect(sdk.modes).toEqual(["default", "default", "default"]));
  });

  it("declining keeps it planning, with the user's feedback", async () => {
    const sdk = stubSdk();
    const { session, preToolUse, permission, items, planUpdates } = open(sdk);
    await session.send({ text: "plan it", attachments: [] });

    const first = permission("ExitPlanMode", { plan: "v1" }, "p1");
    await settle();
    const [approval] = items("approval_request");
    if (approval?.kind !== "approval_request") throw new Error("no approval");
    await session.respond(approval.requestId, {
      kind: "approval",
      decision: "deny",
      message: "Split step 2 in two",
    });
    expect(await first).toEqual({ behavior: "deny", message: "Split step 2 in two" });

    const second = permission("ExitPlanMode", { plan: "v2" }, "p2");
    await settle();
    const again = items("approval_request").at(-1);
    if (again?.kind !== "approval_request") throw new Error("no approval");
    await session.respond(again.requestId, { kind: "approval", decision: "deny" });
    expect(await second).toEqual({ behavior: "deny", message: KEEP_PLANNING });

    expect(planUpdates()).toEqual([]);
    expect(await preToolUse("Write", inWorktree)).toBe("deny");
    expect(sdk.modes).toEqual([]);
  });

  it("turns plan mode on and off live, and a restarted query keeps the current state", async () => {
    const sdk = stubSdk();
    const { session, preToolUse } = open(sdk, { planMode: false });
    expect(sdk.launches[0]?.permissionMode).toBe("acceptEdits");
    await session.setPlanMode(true);
    expect(sdk.modes).toEqual(["plan"]);
    expect(await preToolUse("Write", inWorktree)).toBe("deny");

    sdk.exit();
    await settle();
    await session.send({ text: "again", attachments: [] });
    expect(sdk.launches[1]?.permissionMode).toBe("plan");

    await session.setPlanMode(false);
    expect(sdk.modes).toEqual(["plan", "acceptEdits"]);
  });
});
