import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEvent, type SessionOptions } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { ApprovalBroker } from "../src/approvals";
import { handleServerRequest } from "../src/codex/approvals";
import {
  codexConfigOverrides,
  codexPolicy,
  codexSandboxPolicy,
  codexWritableRoots,
  toCodexInput,
} from "../src/codex/config";
import { parseCodexLoginStatus } from "../src/codex/detect";
import type { ServerRequest } from "../src/codex/protocol";
import { osTempRoots } from "../src/policy/paths";

const T = "thread-x";
const TURN = "turn-1";

describe("Codex approvals", () => {
  const ctx = { threadId: "s1:thread-root", turnId: TURN };
  const run = async (req: object, answer: object) => {
    const events: AgentEvent[] = [];
    const broker = new ApprovalBroker((e) => events.push(AgentEvent.parse(e)));
    const pending = handleServerRequest(req as ServerRequest, {
      broker,
      risk: { cwd: "/w", platform: "linux" },
      ctx: () => ctx,
      filePaths: () => ["/w/a.ts"],
    });
    const started = events[0];
    if (started?.type !== "item.started" || !("requestId" in started.item))
      throw new Error("no request");
    broker.respond(started.item.requestId, answer as never);
    return { result: await pending, events };
  };

  it.each([
    ["cat README.md", {}, true],
    ["cat README.md", { reason: "[codeden-card v1 scope=db-read class=owner-only]" }, false],
    ["cat README.md", { kind: "writeStdin" }, false],
    ["cat README.md", { networkApprovalContext: {} }, false],
    ["cat README.md", { commandActions: [{ command: "cat different.md" }] }, false],
    ["cat README.md > out", {}, false],
    ["cat README.md > out", { commandActions: [{ command: "cat README.md" }] }, false],
    ["cat README.md", { environmentId: "remote" }, false],
    ["cat README.md", { approvalId: "subcommand" }, false],
    ["git show HEAD:README.md", {}, false],
    [
      "git --no-pager --no-optional-locks -c core.fsmonitor=false show --no-ext-diff --no-textconv HEAD:README.md",
      {},
      true,
    ],
    [
      "git --no-pager --no-optional-locks -c core.fsmonitor=false log --no-show-signature --no-notes --no-decorate -5 --oneline",
      {},
      true,
    ],
    [
      "git --no-pager --no-optional-locks -c core.fsmonitor=false diff --no-ext-diff --no-textconv --cached -- README.md",
      {},
      true,
    ],
    ["rg --no-config needle README.md", {}, true],
    ["rg needle README.md", {}, false],
    ["cat jev.env", {}, false],
    ["python3 - <<'PY'\nprint(42)\nPY", {}, false],
  ] as const)("rechecks orchestrator eligibility for %s %j", async (command, patch, allowed) => {
    const root = mkdtempSync(join(tmpdir(), "codex-verified-read-"));
    try {
      writeFileSync(join(root, "README.md"), "fixture");
      writeFileSync(join(root, ".git"), "gitdir: fixture");
      const events: AgentEvent[] = [];
      const broker = new ApprovalBroker((event) => events.push(event));
      const pending = handleServerRequest(
        {
          method: "item/commandExecution/requestApproval",
          id: 0,
          params: {
            threadId: T,
            turnId: TURN,
            itemId: "approval",
            command,
            cwd: root,
            environmentId: null,
            kind: "command",
            startedAtMs: 1,
            ...patch,
          },
        } as ServerRequest,
        {
          broker,
          risk: { cwd: root },
          ctx: () => ctx,
          filePaths: () => [],
        },
      );
      const started = events[0];
      if (started?.type !== "item.started" || started.item.kind !== "approval_request") {
        throw new Error("Expected a pending approval");
      }
      const { requestId } = started.item;
      const decide = () =>
        broker.respond(requestId, {
          kind: "approval",
          decision: "allow_once",
          decidedBy: "orchestrator",
        });
      if (allowed) {
        expect(started.item.toolInput).toEqual({ command });
        decide();
      } else {
        expect(started.item.toolInput).toBeUndefined();
        expect(decide).toThrow("requires the owner");
        broker.respond(requestId, { kind: "approval", decision: "deny" });
      }
      expect(await pending).toEqual({ decision: allowed ? "accept" : "decline" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["cat README.md", "cat README.md", {}, true],
    ["/bin/sh -c 'cat README.md'", "cat README.md", {}, true],
    ["/bin/zsh -fc 'rg --no-config needle README.md'", "rg --no-config needle README.md", {}, true],
    ["cat README.md", "cat README.md", { environmentId: "remote" }, false],
    [
      "cat README.md",
      "cat README.md",
      { additionalPermissions: { network: { enabled: true } } },
      false,
    ],
    ["cat README.md", "cat README.md", { kind: "humanCommand" }, false],
    ["cat README.md", "cat README.md", { availableDecisions: ["decline", "cancel"] }, false],
    ["/bin/sh -c 'cat README.md > out'", "cat README.md", {}, false],
    ["/bin/sh -c 'cat README.md | tee out'", "cat README.md", {}, false],
    ["/bin/sh -c 'cat jev.env'", "cat README.md", {}, false],
    ["/bin/sh -c 'cat README.md'", "cat different.md", {}, false],
    ["/bin/sh -c 'cat README.md' trailing", "cat README.md", {}, false],
    ["/bin/sh -c 'cat README.md'", "cat README.md", { reason: "Owner approval required" }, false],
    ["/bin/sh -c 'curl https://example.invalid'", "cat README.md", {}, false],
    ["/bin/sh -c 'node -e 0'", "cat README.md", {}, false],
    ["/bin/zsh -c 'cat README.md'", "cat README.md", {}, false],
    ["/tmp/bash -c 'cat README.md'", "cat README.md", {}, false],
    ["/bin/zsh -lc 'cat README.md'", "cat README.md", {}, false],
    ["cat README.md", "cat README.md", { command: ["cat", "README.md"] }, false],
    ["git status --short --branch", "git status --short --branch", {}, false],
    ["rg needle README.md", "rg needle README.md", {}, false],
  ] as const)("handles a Codex 0.172 approval for %s (%s)", async (raw, action, patch, allowed) => {
    const root = mkdtempSync(join(tmpdir(), "codex-local-approval-"));
    try {
      writeFileSync(join(root, "README.md"), "fixture");
      const events: AgentEvent[] = [];
      const broker = new ApprovalBroker((event) => events.push(event));
      const pending = handleServerRequest(
        {
          method: "item/commandExecution/requestApproval",
          id: 4,
          params: {
            kind: "command",
            threadId: T,
            turnId: TURN,
            itemId: "exec",
            startedAtMs: 1,
            environmentId: "local",
            command: raw,
            cwd: root,
            commandActions: [
              { type: "read", command: action, name: "README.md", path: join(root, "README.md") },
            ],
            availableDecisions: ["accept", "decline", "cancel"],
            ...patch,
          },
        } as ServerRequest,
        {
          broker,
          risk: { cwd: root },
          autonomy: () => ("command" in patch ? "auto" : "supervised"),
          ctx: () => ctx,
          filePaths: () => [],
        },
      );
      const started = events[0];
      if (started?.type !== "item.started" || started.item.kind !== "approval_request") {
        throw new Error("Expected an approval request");
      }
      const { requestId, toolInput } = started.item;
      const approve = () =>
        broker.respond(requestId, {
          kind: "approval",
          decision: "allow_once",
          decidedBy: "orchestrator",
        });
      if (allowed) {
        expect(toolInput).toEqual({ command: action });
        approve();
      } else {
        expect(toolInput).toBeUndefined();
        expect(approve).toThrow("requires the owner");
        broker.respond(requestId, { kind: "approval", decision: "deny" });
      }
      expect(await pending).toEqual({ decision: allowed ? "accept" : "decline" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps command approvals both ways and flags risky commands", async () => {
    const { result, events } = await run(
      {
        method: "item/commandExecution/requestApproval",
        id: 0,
        params: {
          threadId: T,
          turnId: TURN,
          itemId: "c1",
          command: "git push --force",
          cwd: "/w",
          startedAtMs: 1,
          environmentId: null,
        },
      },
      { kind: "approval", decision: "allow_once" },
    );
    expect(result).toEqual({ decision: "accept" });
    expect(events[0]).toMatchObject({
      item: { kind: "approval_request", action: "git_destructive", command: "git push --force" },
    });
    expect(events[1]).toMatchObject({
      item: { status: "completed", decision: "allow_once", decidedBy: "user" },
    });
  });

  it("maps file change approvals and denials", async () => {
    const { result, events } = await run(
      {
        method: "item/fileChange/requestApproval",
        id: 1,
        params: { threadId: T, turnId: TURN, itemId: "p1", startedAtMs: 1 },
      },
      { kind: "approval", decision: "deny" },
    );
    expect(result).toEqual({ decision: "decline" });
    expect(events[0]).toMatchObject({ item: { action: "file_change", paths: ["/w/a.ts"] } });
    expect(events[1]).toMatchObject({ item: { status: "declined" } });
  });

  it("maps user input questions", async () => {
    const { result } = await run(
      {
        method: "item/tool/requestUserInput",
        id: 2,
        params: {
          threadId: T,
          turnId: TURN,
          itemId: "q1",
          isBlocking: true,
          autoResolutionMs: null,
          questions: [
            {
              id: "lang",
              header: "Lang",
              question: "Which?",
              isOther: false,
              isSecret: false,
              options: [{ label: "TS", description: "" }],
            },
          ],
        },
      },
      { kind: "answer", answers: { lang: ["TS"] } },
    );
    expect(result).toEqual({ answers: { lang: { answers: ["TS"] } } });
  });
});

describe("Codex config", () => {
  const opts: SessionOptions = {
    sessionId: "s",
    role: "agent",
    cwd: "/w",
    autonomy: "auto",
    mcpServers: [
      {
        transport: "http",
        name: "codeden",
        url: "http://127.0.0.1:1/mcp",
        headers: { Authorization: "Bearer t" },
      },
    ],
    additionalDirectories: ["/extra"],
    planMode: false,
  };

  it("maps autonomy to sandbox and approval policy", () => {
    expect(codexPolicy("supervised")).toMatchObject({
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
    expect(codexPolicy("auto")).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      networkAccess: false,
    });
    // Full asks too, so escalations reach CodeDen's policy, which approves all but writes
    // outside the worktree (./codex-policy.test.ts).
    expect(codexPolicy("full")).toMatchObject({
      approvalPolicy: "on-request",
      networkAccess: true,
    });
  });

  it("injects MCP servers and writable roots as config overrides", () => {
    expect(codexConfigOverrides(opts, ["/tmp"])).toEqual({
      "sandbox_workspace_write.network_access": false,
      "sandbox_workspace_write.writable_roots": ["/extra", "/tmp"],
      "mcp_servers.codeden": {
        url: "http://127.0.0.1:1/mcp",
        http_headers: { Authorization: "Bearer t" },
      },
    });
  });

  it("lets the sandbox write the OS temp directory in auto and full only", () => {
    const temp = ["/tmp", "/var/folders/x/T"];
    expect(codexWritableRoots({ ...opts, autonomy: "full" }, temp)).toEqual(["/extra", ...temp]);
    expect(codexWritableRoots({ ...opts, autonomy: "supervised" }, temp)).toEqual(["/extra"]);
    expect(codexWritableRoots({ ...opts, readOnly: true }, temp)).toEqual(["/extra"]);
    expect(
      codexConfigOverrides({ ...opts, autonomy: "supervised", additionalDirectories: [] }, temp),
    ).not.toHaveProperty("sandbox_workspace_write.writable_roots");
    // The defaults come from the running platform.
    expect(codexWritableRoots({ ...opts, additionalDirectories: [] })).toEqual([...osTempRoots()]);
  });

  it("builds the per-turn sandbox override for each level", () => {
    expect(codexSandboxPolicy({ ...opts, autonomy: "full" }, ["/tmp"])).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/extra", "/tmp"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(codexSandboxPolicy({ ...opts, autonomy: "supervised" }, ["/tmp"])).toMatchObject({
      type: "workspaceWrite",
      writableRoots: ["/extra"],
      networkAccess: false,
    });
    expect(codexSandboxPolicy({ ...opts, readOnly: true }, ["/tmp"])).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
  });

  it("converts input with images", () => {
    expect(
      toCodexInput({
        text: "x",
        attachments: [
          { type: "image", mediaType: "image/png", source: { type: "base64", data: "AAAA" } },
        ],
      }),
    ).toEqual([
      { type: "text", text: "x", text_elements: [] },
      { type: "image", url: "data:image/png;base64,AAAA" },
    ]);
  });

  it("parses login status", () => {
    expect(parseCodexLoginStatus("Logged in using ChatGPT", 0)).toEqual({
      loggedIn: true,
      authMethod: "chatgpt",
    });
    expect(parseCodexLoginStatus("Logged in using an API key - sk-***", 0)).toEqual({
      loggedIn: true,
      authMethod: "api_key",
    });
    expect(parseCodexLoginStatus("Not logged in", 1)).toEqual({
      loggedIn: false,
      authMethod: null,
    });
    expect(parseCodexLoginStatus("", null)).toEqual({ loggedIn: null, authMethod: null });
  });
});
