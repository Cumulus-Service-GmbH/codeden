import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  constants,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_RUNS_FILE_ENV, ChildRunList, WORKER_REPORT_PATH } from "@codeden/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startServer } from "../src/server";
import { childRunsFile, readChildRuns } from "../src/services/sessions/child-runs";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-child-runs-"));
});
afterEach(async () => {
  await removeTree(dir);
});

const line = (status: string, at: string) =>
  `${JSON.stringify({ id: "w1", role: "planReviewer", provider: "codex", model: "m", effort: "high", status, at, detail: null })}\n`;

// Reading needs no-follow opening; where the platform lacks it only the unavailable case below applies.
const noFollow = it.runIf(Boolean(constants.O_NOFOLLOW));

noFollow("passes CHILD_RUNS_FILE and lists what the session's tools logged", () => {
  const runs = join(dir, "child-runs");
  const launcher = new SessionLauncher({
    repo: { find: () => undefined },
    runner: { mcpProxyUrl: () => null },
    home: join(dir, "home"),
    childRunsDir: runs,
  } as unknown as LauncherDeps);
  const path = launcher.sessionOptions(sampleSession).env?.[CHILD_RUNS_FILE_ENV];
  expect(path).toBe(childRunsFile(runs, sampleSession.id));
  expect(readChildRuns(runs, sampleSession.id)).toEqual({ runs: [], skipped: 0, available: true });
  appendFileSync(path as string, line("running", "2026-11-22T21:00:00.000Z"));
  appendFileSync(path as string, "garbage\n");
  appendFileSync(path as string, line("succeeded", "2026-11-22T21:05:00.000Z"));
  const list = readChildRuns(runs, sampleSession.id);
  expect(list.skipped).toBe(1);
  expect(list.runs).toMatchObject([
    { id: "w1", status: "succeeded", endedAt: "2026-11-22T21:05:00.000Z" },
  ]);
});

noFollow("reads only a regular file and refuses unsafe session ids", () => {
  const runs = join(dir, "child-runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(dir, "elsewhere.jsonl"), line("running", "2026-11-22T21:00:00.000Z"));
  symlinkSync(join(dir, "elsewhere.jsonl"), childRunsFile(runs, "s2"));
  expect(() => readChildRuns(runs, "s2")).toThrow();
  expect(() => childRunsFile(runs, "../x")).toThrow(/unsafe/);
});

noFollow("drops only a partial first line when the log is longer than its 1 MB window", () => {
  const runs = join(dir, "child-runs");
  mkdirSync(runs, { recursive: true });
  // 256-byte report lines with unique ids: 4096 of them fill the window exactly.
  const report = (i: number) => {
    const base = JSON.stringify({
      id: `w${i}`,
      role: "r",
      provider: "codex",
      model: null,
      effort: null,
      status: "running",
      at: "2026-11-22T21:00:00.000Z",
      detail: "",
    });
    return `${base.replace('"detail":""', `"detail":"${"x".repeat(255 - base.length)}"`)}\n`;
  };
  const lines = Array.from({ length: 4096 }, (_, i) => report(i)).join("");
  expect(Buffer.byteLength(lines)).toBe(1024 * 1024);
  // The window starts exactly at a line start: every line in it is whole.
  writeFileSync(childRunsFile(runs, "s3"), `${"y".repeat(99)}\n${lines}`);
  expect(readChildRuns(runs, "s3")).toMatchObject({ skipped: 0 });
  expect(readChildRuns(runs, "s3").runs).toHaveLength(4096);
  // The window starts one byte into a line: that line is dropped, nothing else.
  writeFileSync(childRunsFile(runs, "s4"), `${"y".repeat(99)}\n${lines}z`);
  expect(readChildRuns(runs, "s4").runs).toHaveLength(4095);
});

it("is unavailable, never read through a link, where no-follow opening is missing", () => {
  const runs = join(dir, "child-runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(childRunsFile(runs, "s5"), line("running", "2026-11-22T21:00:00.000Z"));
  expect(readChildRuns(runs, "s5", 0)).toEqual({ runs: [], skipped: 0, available: false });
});

it("registers only against the live bearer's parent and lists provider subagents with it", async () => {
  const log: string[] = [];
  const token = randomUUID();
  const server = await startServer({
    port: 0,
    dataDir: dir,
    token,
    runner: false,
    checkSetupOnStart: false,
    log: (message) => log.push(message),
  });
  try {
    const parent = { ...sampleSession, id: "parent" };
    const sibling = { ...sampleSession, id: "sibling" };
    for (const session of [parent, sibling]) {
      server.store.append([
        { type: "session.created", sessionId: session.id, payload: { session } },
      ]);
    }
    const tokens = server.services.mcpTokens;
    const mcp = tokens.mint({ role: "agent", sessionId: parent.id, projectId: parent.projectId });
    const worker = tokens.workerToken(mcp);
    expect(worker).toBeDefined();
    expect(tokens.verify(worker)).toBeUndefined();

    const report = JSON.parse(line("running", "2026-11-22T21:00:00.000Z"));
    const post = (token: string | undefined, body: unknown) =>
      fetch(server.url + WORKER_REPORT_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const list = async (id: string) => {
      const response = await fetch(`${server.url}/api/sessions/${id}/child-runs`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      return ChildRunList.parse(await response.json()).runs;
    };
    expect((await post(undefined, report)).status).toBe(401);
    expect((await post(mcp, report)).status).toBe(401);
    expect((await post(worker, { ...report, detail: worker })).status).toBe(400);
    expect((await post(worker, { ...report, sessionId: sibling.id })).status).toBe(204);
    expect(await list(parent.id)).toMatchObject([{ id: "w1", status: "running" }]);
    expect(await list(sibling.id)).toEqual([]);

    expect(
      (
        await post(worker, {
          ...report,
          status: "succeeded",
          at: "2026-11-22T21:05:00.000Z",
          receipt: "review-123",
        })
      ).status,
    ).toBe(204);
    const native = {
      type: "item.completed",
      threadId: "root",
      turnId: "turn",
      item: {
        kind: "subagent",
        id: "worker",
        status: "completed",
        childThreadId: "child",
        agentType: "investigator",
      },
    } as const;
    server.store.append([{ type: "agent.item.completed", sessionId: parent.id, payload: native }]);
    expect(await list(parent.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "w1",
          status: "succeeded",
          receipt: "review-123",
          startedAt: report.at,
        }),
        expect.objectContaining({
          id: "subagent:worker",
          role: "investigator",
          status: "succeeded",
        }),
      ]),
    );
    tokens.revoke(mcp);
    expect((await post(worker, report)).status).toBe(401);
    expect(log.some((message) => message.includes(worker ?? "") || message.includes(mcp))).toBe(
      false,
    );
  } finally {
    await server.close();
  }
});
