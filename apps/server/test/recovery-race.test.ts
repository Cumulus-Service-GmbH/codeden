import { join } from "node:path";
import type { RunnerCommandName, RunnerCommandOf, Session } from "@codeden/contracts";
import { FakeProvider } from "@codeden/providers";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ensureHome } from "../src/paths";
import { createServices } from "../src/services/container";
import type { RunnerPort, RunnerRouter } from "../src/services/runner-port";
import { MemorySecretStore } from "../src/services/secrets";
import type { SessionLauncher } from "../src/services/sessions/launcher";
import {
  RESTART_CONTINUE_MESSAGE,
  type RecoveryDeps,
  SessionRecovery,
} from "../src/services/sessions/recovery";
import type { SessionRepo } from "../src/services/sessions/repo";
import type { SessionService } from "../src/services/sessions/session-service";
import { SettingsStore } from "../src/settings-store";
import { sampleSession } from "./helpers";
import { createGithubEnv } from "./support/github-env";

/**
 * Recovery after a runner connects, with a session started on that runner while its
 * `runner.status` request is in flight (the CI flake in restart-recovery.test.ts): the new
 * session turns `running` before the reply is handled, and the reply does not list it. And
 * with a cut-off session that comes back by another path (a message, Retry or queued
 * delivery) while recovery is still resuming the ones before it.
 */
describe("session recovery", () => {
  function setup(
    initial: Session[],
    runners?: (home: RunnerPort) => RunnerRouter,
    sweepVendorHistory?: RecoveryDeps["sweepVendorHistory"],
  ) {
    const sessions = new Map(initial.map((s) => [s.id, s]));
    const repo = {
      list: ({ status }: { status?: string[] }) =>
        [...sessions.values()].filter((s) => !status || status.includes(s.status)),
      find: (id: string) => {
        const session = sessions.get(id);
        return session ? { session } : undefined;
      },
      update: (id: string, change: (session: Session) => Session) => {
        const session = sessions.get(id);
        if (session) sessions.set(id, change(session));
      },
      closeOrphanedTurns: vi.fn(() => 0),
      // Their cut-off turns are work turns (a cut-off compaction: compaction-restart.test.ts).
      rootTurnIds: () => [],
      turn: () => null,
    } as unknown as SessionRepo;
    const continueAfterRestart = vi.fn(async (_id: string, _text: string): Promise<void> => {});
    // Sessions with a message, Retry or queued delivery on its way to the runner.
    const delivering = new Set<string>();
    const service = {
      launching: new Map<string, Promise<void>>(),
      isDelivering: (id: string) => delivering.has(id),
      continueAfterRestart,
      sessionsWithQueuedMessages: () => [],
      releaseOutboxes: () => undefined,
    } as unknown as SessionService;
    const fail = vi.fn();
    const launcher = { fail } as unknown as SessionLauncher;
    let onStatus: () => void = () => undefined;
    // The sessions the runner hosts right now (`runner.status` reports them).
    const hosted = new Set<string>();
    const runner = {
      request: vi.fn(async () => {
        onStatus();
        return {
          sessions: [...hosted].map((sessionId) => ({ sessionId })),
          ptys: [],
          journal: { lastSeq: 0, unacked: 0 },
          draining: false,
        };
      }),
      providers: () => [{ id: "fake", capabilities: { resume: true } }],
    } as unknown as RunnerPort;
    const recovery = new SessionRecovery({
      repo,
      sessions: service,
      launcher,
      runner,
      runners: runners?.(runner),
      ...(sweepVendorHistory ? { sweepVendorHistory } : {}),
    });
    return {
      recovery,
      repo,
      sessions,
      continueAfterRestart,
      fail,
      hosted,
      delivering,
      whileStatusInFlight: (fn: () => void) => {
        onStatus = fn;
      },
    };
  }

  it("leaves alone a session that started while runner.status was in flight", async () => {
    const t = setup([{ ...sampleSession, id: "new", status: "starting", provider: "fake" }]);
    t.whileStatusInFlight(() => {
      const s = t.sessions.get("new");
      if (s) t.sessions.set("new", { ...s, status: "running" });
    });
    await t.recovery.onRunnerReady();
    expect(t.fail).not.toHaveBeenCalled();
    expect(t.continueAfterRestart).not.toHaveBeenCalled();
    expect(t.sessions.get("new")?.status).toBe("running");
  });

  it("only resumes the cut-off sessions of the runner that became ready", async () => {
    const other = {
      request: vi.fn(async () => ({
        sessions: [],
        ptys: [],
        journal: { lastSeq: 0, unacked: 0 },
        draining: false,
      })),
      providers: () => [{ id: "fake", capabilities: { resume: true } }],
    } as unknown as RunnerPort;
    const cut = {
      ...sampleSession,
      status: "running",
      provider: "fake",
      resumeToken: "r",
    } as const;
    const t = setup(
      [
        { ...cut, id: "at-home" },
        { ...cut, id: "on-b", runnerId: "r-b" },
      ],
      (home) => ({
        home: () => home,
        forSession: (id) => (id === "on-b" ? other : home),
        forRunnerId: (runnerId) => (runnerId === "r-b" ? other : home),
      }),
    );
    await t.recovery.onRunnerReady("r-b");
    expect(other.request).toHaveBeenCalledWith({ name: "runner.status" }, 10_000);
    expect(t.continueAfterRestart.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["on-b"]);
    await t.recovery.onRunnerReady("r-home");
    expect(t.continueAfterRestart.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "on-b",
      "at-home",
    ]);
  });

  it("still resumes a session whose turn was cut off before the runner was ready", async () => {
    const t = setup([
      { ...sampleSession, id: "cut", status: "running", provider: "fake", resumeToken: "r1" },
    ]);
    await t.recovery.onRunnerReady();
    expect(t.continueAfterRestart).toHaveBeenCalledWith("cut", expect.any(String));
    // Turns and approvals the dead runner left open are closed before resuming.
    expect(t.repo.closeOrphanedTurns).toHaveBeenCalledWith("cut");
    expect(t.fail).not.toHaveBeenCalled();
  });

  it("leaves alone a cut-off session resumed by another path while an earlier one resumes", async () => {
    const cut = { ...sampleSession, provider: "fake", resumeToken: "r" } as const;
    const t = setup([
      { ...cut, id: "first", status: "running" },
      { ...cut, id: "second", status: "interrupted" },
    ]);
    t.continueAfterRestart.mockImplementation(async (id) => {
      if (id === "first") {
        // Resuming the first takes a while. Meanwhile the user sends "second" a message:
        // the runner opens it and its new turn starts.
        t.hosted.add("second");
        const s = t.sessions.get("second");
        if (s) t.sessions.set("second", { ...s, status: "running" });
        await Promise.resolve();
        return;
      }
      // The runner refuses a second turn while one is running.
      if (t.hosted.has(id)) {
        throw Object.assign(new Error("A turn is already running"), { code: "turn_running" });
      }
    });

    await t.recovery.onRunnerReady();

    expect(t.continueAfterRestart.mock.calls.map((c) => c[0])).toEqual(["first"]);
    // The live turn of "second" and its approvals stay open, and it is not marked failed.
    expect(t.repo.closeOrphanedTurns).not.toHaveBeenCalledWith("second");
    expect(t.fail).not.toHaveBeenCalled();
    expect(t.sessions.get("second")?.status).toBe("running");
  });

  it("resumes every cut-off session once", async () => {
    const cut = { ...sampleSession, provider: "fake", resumeToken: "r" } as const;
    const t = setup([
      { ...cut, id: "first", status: "running" },
      { ...cut, id: "second", status: "interrupted" },
    ]);
    await t.recovery.onRunnerReady();
    expect(t.continueAfterRestart.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
    expect(t.repo.closeOrphanedTurns).toHaveBeenCalledTimes(2);
    expect(t.fail).not.toHaveBeenCalled();
  });

  it("leaves alone a cut-off session with a message on its way to the runner", async () => {
    const cut = { ...sampleSession, provider: "fake", resumeToken: "r" } as const;
    const t = setup([
      { ...cut, id: "first", status: "running" },
      { ...cut, id: "second", status: "interrupted" },
    ]);
    t.continueAfterRestart.mockImplementation(async (id) => {
      // While the first resumes, the user's message to "second" is sent; the runner hasn't
      // answered yet, but the turn's first events already turned it `running`.
      if (id === "first") {
        t.delivering.add("second");
        const s = t.sessions.get("second");
        if (s) t.sessions.set("second", { ...s, status: "running" });
      }
    });
    await t.recovery.onRunnerReady();
    expect(t.continueAfterRestart.mock.calls.map((c) => c[0])).toEqual(["first"]);
    expect(t.repo.closeOrphanedTurns).not.toHaveBeenCalledWith("second");
    expect(t.fail).not.toHaveBeenCalled();
  });

  it("does not fail a session whose turn the runner says is already running", async () => {
    const t = setup([
      { ...sampleSession, id: "cut", status: "running", provider: "fake", resumeToken: "r" },
    ]);
    t.continueAfterRestart.mockRejectedValue(
      Object.assign(new Error("A turn is already running"), { code: "turn_running" }),
    );
    await t.recovery.onRunnerReady();
    expect(t.continueAfterRestart).toHaveBeenCalledWith("cut", expect.any(String));
    expect(t.fail).not.toHaveBeenCalled();
  });

  it("then sweeps what a crash left in providers' own apps, after resuming", async () => {
    const order: string[] = [];
    const sweep = vi.fn(async (_runner: RunnerPort, skip: (id: string) => boolean) => {
      order.push("sweep");
      expect(skip("on-its-way")).toBe(true);
      expect(skip("idle")).toBe(false);
      return { hidden: [], failed: 0 };
    });
    const t = setup(
      [{ ...sampleSession, id: "cut", status: "running", provider: "fake", resumeToken: "r" }],
      undefined,
      sweep,
    );
    t.continueAfterRestart.mockImplementation(async () => {
      order.push("resume");
    });
    t.delivering.add("on-its-way");
    await t.recovery.onRunnerReady();
    await vi.waitFor(() => expect(order).toEqual(["resume", "sweep"]));
  });

  it("finishes recovery without waiting for the sweep, and recovers a reconnect during one", async () => {
    // The sweep takes a while (a short-lived provider process per provider).
    let finishSweep: () => void = () => undefined;
    const sweep = vi.fn(
      () =>
        new Promise<{ hidden: string[]; failed: number }>((resolve) => {
          finishSweep = () => resolve({ hidden: [], failed: 0 });
        }),
    );
    const cut = { ...sampleSession, provider: "fake", resumeToken: "r" } as const;
    const t = setup([{ ...cut, id: "first", status: "running" }], undefined, sweep);
    // A resumed session is hosted by the runner again.
    t.continueAfterRestart.mockImplementation(async (id) => {
      t.hosted.add(id);
    });

    let recovered = false;
    void t.recovery.onRunnerReady().then(() => {
      recovered = true;
    });
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(recovered).toBe(true));
    expect(t.continueAfterRestart.mock.calls.map((c) => c[0])).toEqual(["first"]);

    // The runner drops and reconnects while the sweep still runs, cutting off another turn.
    t.sessions.set("second", { ...cut, id: "second", status: "running" });
    await t.recovery.onRunnerReady();
    expect(t.continueAfterRestart.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
    // The reconnect's own sweep waits for the one in progress, then runs.
    expect(sweep).toHaveBeenCalledTimes(1);
    finishSweep();
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(2));
    finishSweep();
  });
});

describe("admission during restart recovery", () => {
  it.each([false, true])("resumes in candidate order (hosted session: %s)", async (keepHosted) => {
    const env = createGithubEnv();
    onTestFinished(() => env.close());
    const candidates = Array.from({ length: 6 }, (_, index) =>
      env.addSession({
        status: "running",
        resumeToken: `resume-${index}`,
        createdAt: `2026-11-07T10:00:0${index}.000Z`,
      }),
    ).reverse();
    const live = keepHosted
      ? env.addSession({ status: "waiting", resumeToken: "live" })
      : undefined;
    const liveBefore = live && env.repo.get(live.id);
    const hosted = new Set(live ? [live.id] : []);
    const starts: RunnerCommandOf<"session.start">[] = [];
    const runner: RunnerPort = {
      isConnected: () => true,
      runnerId: () => "r1",
      providers: () => [
        {
          id: "fake",
          displayName: "Fake",
          capabilities: new FakeProvider().capabilities(),
          models: [],
        },
      ],
      mcpProxyUrl: () => null,
      waitForConnection: async () => true,
      request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
        switch (command.name) {
          case "runner.status":
            return { sessions: [...hosted].map((sessionId) => ({ sessionId })) };
          case "session.send":
            throw Object.assign(new Error("Unknown session"), { code: "unknown_session" });
          case "session.start":
            starts.push(command);
            hosted.add(command.sessionId);
            return { resumeToken: command.options.resumeToken };
          default:
            throw new Error(`Unexpected runner command: ${command.name}`);
        }
      }) as RunnerPort["request"],
    };
    const paths = ensureHome(join(env.dir, "home"));
    const settings = new SettingsStore(paths.settings);
    settings.update({ limits: { maxActiveSessions: 4 } });
    const { admission, lifecycle, recovery } = createServices({
      db: env.db.db,
      store: env.store,
      paths,
      settings,
      runner,
      secrets: new MemorySecretStore(),
      userHome: env.dir,
    });
    const reserve = vi.spyOn(admission, "tryReserve");
    const delivered = () => starts.map(({ sessionId, input }) => [sessionId, input?.text]);
    const continuation = ({ id }: Session) => [id, RESTART_CONTINUE_MESSAGE];
    const immediate = live ? 3 : 4;

    await recovery.onRunnerReady();

    expect(delivered()).toEqual(candidates.slice(0, immediate).map(continuation));
    expect(admission.status()).toMatchObject({
      active: 4,
      waiting: candidates.slice(immediate).map(({ id }, index) => ({
        sessionId: id,
        kind: "turn",
        place: index + 1,
      })),
    });
    if (live) {
      expect(env.repo.get(live.id)).toEqual(liveBefore);
      expect(reserve.mock.calls.map(([id]) => id)).not.toContain(live.id);
      return;
    }

    for (const [index, { id }] of candidates.slice(0, 2).entries()) {
      env.repo.update(id, (s) => ({ ...s, status: "idle" }));
      lifecycle.drainQueue();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(delivered()).toEqual(candidates.slice(0, immediate + index + 1).map(continuation));
    }
    expect(admission.status().waiting).toEqual([]);
  });
});
