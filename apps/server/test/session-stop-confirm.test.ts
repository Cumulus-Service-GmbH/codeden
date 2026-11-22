import type { UserInput } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { RunnerCommandError } from "../src/runner/client";
import type { RunnerPort } from "../src/services/runner-port";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionRepo } from "../src/services/sessions/repo";
import { retireRoleSession } from "../src/services/sessions/role-retire";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";

describe("stopping a session while its runner is unreachable", () => {
  it("passes for a plain stop, fails for a confirmed one, and retirement retries it", async () => {
    const database = openDatabase(":memory:");
    try {
      const store = new EventStore(database.db);
      store.append([
        {
          type: "session.created",
          sessionId: "s1",
          payload: { session: { ...sampleSession, status: "idle" } },
        },
      ]);
      const request = vi.fn(async () => {
        throw new RunnerCommandError("runner_unavailable", "Runner is not connected");
      });
      const runner = { isConnected: () => false, providers: () => [], request };
      const sessions = new SessionService({
        repo: new SessionRepo(database.db, store),
        runner: runner as unknown as RunnerPort,
        outbox: new Outbox(database.db, store),
        tokens: { revokeSession: vi.fn() },
        inbox: { dismissRequestsForSession: vi.fn() },
        artifacts: {
          externalizeAttachments: (i: UserInput) => i,
          resolveAttachments: (i: UserInput) => i,
        },
      } as unknown as SessionServiceDeps);

      await expect(sessions.stop("s1", { confirm: true })).rejects.toMatchObject({
        code: "runner_unavailable",
      });
      const warn = vi.fn();
      await retireRoleSession(
        { stop: (id) => sessions.stop(id, { confirm: true }), revokeTokens: () => {}, warn },
        "s1",
      );
      expect(request).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenLastCalledWith(
        "Stopping archived role session s1 failed again (runner_unavailable); its tokens stay revoked",
      );
      await expect(sessions.stop("s1")).resolves.toMatchObject({ status: "stopped" });
    } finally {
      database.close();
    }
  });
});
