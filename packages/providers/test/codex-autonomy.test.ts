import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AutonomyLevel, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSession } from "../src/codex/session";
import { FakeProvider } from "../src/fake/adapter";
import type { FakeSession } from "../src/fake/session";
import { osTempRoots } from "../src/policy/paths";

const base: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

const fakeCodex = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-codex", "app-server.mjs"),
};

type Logged = { method: string; params: Record<string, unknown> };
const requests = (file: string): Logged[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

const sessions: CodexSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  delete process.env.FAKE_CODEX_LOG;
});

describe("Codex autonomy changes", () => {
  it("carries the new approval and sandbox policy on the next turn/start", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "codeden-codex-autonomy-")), "requests.log");
    process.env.FAKE_CODEX_LOG = log;
    const session = new CodexSession(base, { executable: fakeCodex });
    sessions.push(session);
    let completed = 0;
    void (async () => {
      for await (const e of session.events as AsyncIterable<AgentEvent>) {
        if (e.type === "turn.completed") completed++;
      }
    })();
    const turn = async (text: string) => {
      const target = completed + 1;
      await session.send({ text, attachments: [] });
      const deadline = Date.now() + 5000;
      while (completed < target) {
        if (Date.now() > deadline) throw new Error(`turn "${text}" did not complete`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await session.start();
    const start = requests(log).find((r) => r.method === "thread/start");
    expect(start?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const config = (start?.params.config ?? {}) as Record<string, unknown>;
    expect(config["sandbox_workspace_write.writable_roots"]).toEqual([...osTempRoots()]);

    await turn("first");
    await session.setAutonomy("full");
    await turn("second");
    await turn("third");
    await session.setAutonomy("supervised");
    await turn("fourth");

    const turns = requests(log).filter((r) => r.method === "turn/start");
    expect(turns.map((t) => t.params.approvalPolicy)).toEqual([
      undefined,
      "on-request",
      "on-request",
      "untrusted",
    ]);
    expect(turns[1]?.params.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [...osTempRoots()],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(turns[3]?.params.sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
    });
  });
  async function pendingCommand(autonomy: AutonomyLevel, command: string) {
    const root = mkdtempSync(join(tmpdir(), "codeden-codex-pending-"));
    const log = join(root, "requests.log");
    const script = join(root, "requests.json");
    writeFileSync(
      script,
      JSON.stringify([
        {
          method: "item/commandExecution/requestApproval",
          params: { itemId: "pending", command, cwd: root, environmentId: null },
        },
      ]),
    );
    const session = new CodexSession(
      {
        ...base,
        cwd: root,
        autonomy,
        env: { FAKE_CODEX_LOG: log, FAKE_CODEX_REQUESTS: script },
      },
      { executable: fakeCodex },
    );
    sessions.push(session);
    const events: AgentEvent[] = [];
    void (async () => {
      for await (const event of session.events) events.push(event);
    })();
    await session.start();
    await session.send({ text: "Start command", attachments: [] });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item.started",
          item: expect.objectContaining({ requestId: "pending" }),
        }),
      ),
    );
    return { session, events, log };
  }

  it.each(["auto", "full"] as const)(
    "auto-resolves a pending command when raised to %s",
    async (level) => {
      const { session, events, log } = await pendingCommand("supervised", "pwd");
      await session.setAutonomy(level);
      await vi.waitFor(() =>
        expect(requests(log)).toContainEqual({
          method: "answer:item/commandExecution/requestApproval",
          params: { decision: "accept" },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          item: expect.objectContaining({
            requestId: "pending",
            status: "completed",
            decision: "allow_once",
            decidedBy: "policy",
            decisionReason: "Auto-resolved by autonomy change.",
          }),
        }),
      );
    },
  );

  it.each([
    ["supervised", "full", "echo ok > /definitely-outside-worktree/approval-fixture"],
    ["supervised", "auto", "git push --force origin main"],
    ["supervised", "read_only", "pwd"],
  ] as const)(
    "leaves the request open when changing from %s to %s for %s",
    async (from, to, command) => {
      const { session, log } = await pendingCommand(from, command);
      await session.setAutonomy(to);
      expect(requests(log).some((r) => r.method.startsWith("answer:"))).toBe(false);
      await expect(
        session.respond("pending", { kind: "approval", decision: "deny" }),
      ).resolves.toBeUndefined();
      await vi.waitFor(() =>
        expect(requests(log)).toContainEqual({
          method: "answer:item/commandExecution/requestApproval",
          params: { decision: "decline" },
        }),
      );
    },
  );
});

describe("Fake autonomy changes", () => {
  it("skips the scripted command approval once the session is on full", async () => {
    const session = (await new FakeProvider().openSession(base)) as FakeSession;
    const events: AgentEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    await session.setAutonomy("full");
    expect(session.autonomy).toBe("full");
    await session.send({ text: "go [approval]", attachments: [] });
    const deadline = Date.now() + 5000;
    while (!events.some((e) => e.type === "turn.completed")) {
      if (Date.now() > deadline) throw new Error("turn did not complete");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(
      events.some((e) => e.type === "item.started" && e.item.kind === "approval_request"),
    ).toBe(false);
    await session.close();
  });
});
