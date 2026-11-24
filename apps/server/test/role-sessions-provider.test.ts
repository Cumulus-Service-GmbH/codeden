import { type SettingsInput, StartSessionRequest } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { withRoles } from "./support/role-env";

describe("role sessions: moving the orchestrator or a PM to another provider (§8.1)", () => {
  it(
    "retires the PM when its role's provider changes, and starts a fresh one on next use",
    withRoles(async ({ roles, repo, set, settle, stopped }) => {
      const first = await roles.ensure("pm", "p1");
      expect(first.provider).toBe("claude");
      // Its turn failed, e.g. "Not logged in".
      settle(first.id, "failed");

      await set({ providers: { pm: { provider: "codex" } } });

      expect(stopped).toEqual([first.id]);
      expect(repo.get(first.id).archivedAt).not.toBeNull();
      // The role shows as not started until its next message.
      expect(roles.find("pm", "p1")).toBeUndefined();
      expect(roles.refs().pms).toEqual({});

      const second = await roles.ensure("pm", "p1");
      expect(second.id).not.toBe(first.id);
      expect(second.provider).toBe("codex");
      expect(roles.refs().pms).toEqual({ p1: second.id });
      // Settled on the chosen provider: nothing more to retire.
      settle(second.id);
      await roles.applyProviderSettings();
      expect((await roles.ensure("pm", "p1")).id).toBe(second.id);
    }),
  );

  it(
    "leaves a session with a turn under way, and moves it when it is next used",
    withRoles(async ({ roles, repo, set, settle }) => {
      const first = await roles.ensure("orchestrator", null);
      settle(first.id, "running");
      await set({ providers: { orchestrator: { provider: "codex" } } });
      expect(repo.get(first.id).archivedAt).toBeNull();
      expect((await roles.ensure("orchestrator", null)).id).toBe(first.id);

      settle(first.id);
      const second = await roles.ensure("orchestrator", null);
      expect(second.provider).toBe("codex");
      expect(repo.get(first.id).archivedAt).not.toBeNull();
    }),
  );

  it(
    "leaves a session whose turn is on its way to the runner",
    withRoles(async ({ roles, repo, sessions, set, settle }) => {
      const first = await roles.ensure("pm", "p1");
      settle(first.id);
      // Idle in the database, but a message is being handed to the runner.
      const delivering = vi.spyOn(sessions, "isDelivering").mockReturnValue(true);
      await set({ providers: { pm: { provider: "codex" } } });
      expect(repo.get(first.id).archivedAt).toBeNull();
      expect((await roles.ensure("pm", "p1")).id).toBe(first.id);

      delivering.mockReturnValue(false);
      expect((await roles.ensure("pm", "p1")).provider).toBe("codex");
    }),
  );

  it(
    "dismisses the retired session's failed runs, whose Retry would bring it back",
    withRoles(async ({ roles, repo, inbox, set, settle }) => {
      const first = await roles.ensure("orchestrator", null);
      settle(first.id, "failed");
      const failed = inbox.raiseRunFailed(repo.get(first.id), "turn-1:failed", "Not logged in");
      expect(failed.status).toBe("open");

      await set({ providers: { orchestrator: { provider: "codex" } } });

      expect(repo.get(first.id).archivedAt).not.toBeNull();
      expect(inbox.get(failed.id)).toMatchObject({
        status: "dismissed",
        resolution: { reason: "role provider, model or effort changed" },
      });
    }),
  );

  it(
    "keeps the session for Auto, for the other role's setting and for a provider the runner lacks",
    withRoles(async ({ roles, repo, set, settle }) => {
      const pm = await roles.ensure("pm", "p1");
      settle(pm.id);
      for (const providers of [
        { pm: { provider: "auto" } },
        { orchestrator: { provider: "codex" }, agent: { provider: "codex" } },
        { pm: { provider: "gemini" } },
        { pm: { provider: "claude" } },
      ] satisfies SettingsInput["providers"][]) {
        await set({ providers });
        expect(repo.get(pm.id).archivedAt).toBeNull();
        expect((await roles.ensure("pm", "p1")).id).toBe(pm.id);
      }
    }),
  );
});

describe("role sessions: what does not move a role session (§8.1)", () => {
  it(
    "leaves the session while the runner is away, and moves it once the runner is back",
    withRoles(async ({ roles, repo, set, settle, connected, stopped }) => {
      const pm = await roles.ensure("pm", "p1");
      settle(pm.id);
      // A runner restart: its providers can't be checked, so nothing is retired on a guess.
      connected(false);
      await set({ providers: { pm: { provider: "codex" } } });
      expect((await roles.ensure("pm", "p1")).id).toBe(pm.id);
      expect(repo.get(pm.id).archivedAt).toBeNull();
      expect(stopped).toEqual([]);

      connected(true);
      const next = await roles.ensure("pm", "p1");
      expect(next.provider).toBe("codex");
      expect(repo.get(pm.id).archivedAt).not.toBeNull();
    }),
  );

  it(
    "keeps the PM when the project's own default provider changes",
    withRoles(async ({ roles, repo, set, settle, projectDefault }) => {
      const pm = await roles.ensure("pm", "p1");
      expect(pm.provider).toBe("claude");
      settle(pm.id);
      // The project's "Default agent", or `defaultProvider` in `.codeden/project.json`.
      projectDefault("codex");
      expect((await roles.ensure("pm", "p1")).id).toBe(pm.id);
      // Another role's setting changes: still nothing for this PM.
      await set({ providers: { orchestrator: { provider: "codex" } } });
      expect((await roles.ensure("pm", "p1")).id).toBe(pm.id);
      expect(repo.get(pm.id).archivedAt).toBeNull();
    }),
  );

  it(
    "starts the PM on its configured provider, model and effort before the project default",
    withRoles(async ({ roles, set, projectDefault }) => {
      projectDefault("claude");
      await set({ providers: { pm: { provider: "codex", model: "gpt-test", effort: "high" } } });
      expect(await roles.ensure("pm", "p1")).toMatchObject({
        provider: "codex",
        model: "gpt-test",
        effort: "high",
      });
    }),
  );

  it(
    "refuses a PM provider that cannot use the configured role model",
    withRoles(async ({ sessions, set }) => {
      await set({ providers: { pm: { provider: "codex", model: "gpt-test" } } });
      await expect(
        sessions.start(
          StartSessionRequest.parse({
            role: "pm",
            projectId: "p1",
            provider: "claude",
            startedBy: { kind: "user" },
          }),
        ),
      ).rejects.toThrow(/role.*codex.*claude/i);
    }),
  );

  it(
    "refuses a new PM when its configured provider is unavailable",
    withRoles(async ({ roles, set, projectDefault }) => {
      projectDefault("claude");
      await set({ providers: { pm: { provider: "gemini" } } });
      await expect(roles.ensure("pm", "p1")).rejects.toThrow(/gemini.*not available/i);
    }),
  );

  for (const role of ["pm", "orchestrator"] as const) {
    it(
      `moves the ${role} to its new model and effort after its active turn`,
      withRoles(async ({ roles, set, settle }) => {
        const projectId = role === "pm" ? "p1" : null;
        const choice = { provider: "codex", model: "first", effort: "low" } as const;
        await set({ providers: { [role]: choice } });
        const first = await roles.ensure(role, projectId);
        settle(first.id, "running");

        await set({ providers: { [role]: { ...choice, model: "second" } } });
        expect((await roles.ensure(role, projectId)).id).toBe(first.id);
        settle(first.id);
        const second = await roles.ensure(role, projectId);
        expect(second).toMatchObject({ model: "second", effort: "low" });
        expect(second.id).not.toBe(first.id);

        settle(second.id);
        await set({ providers: { [role]: { ...choice, model: "second", effort: "high" } } });
        const third = await roles.ensure(role, projectId);
        expect(third).toMatchObject({ model: "second", effort: "high" });
        expect(third.id).not.toBe(second.id);
      }),
    );
  }

  it(
    "keeps the PM when pinning its current provider with a resolved default model",
    withRoles(async ({ roles, repo, set, settle, projectDefault }) => {
      projectDefault("codex");
      const pm = await roles.ensure("pm", "p1");
      settle(pm.id);
      // The provider reports its default model once the conversation starts.
      repo.update(pm.id, (session) => ({ ...session, model: "gpt-default" }));
      await set({ providers: { pm: { provider: "codex" } } });

      expect((await roles.ensure("pm", "p1")).id).toBe(pm.id);
      expect(repo.get(pm.id)).toMatchObject({ model: "gpt-default", archivedAt: null });
    }),
  );

  it(
    "keeps a legacy PM conversation with a session-only model override",
    withRoles(async ({ roles, repo, set, settle }) => {
      await set({ providers: { pm: { provider: "codex" } } });
      const pm = await roles.ensure("pm", "p1");
      settle(pm.id);
      repo.setStartMeta(pm.id, (meta) => {
        const {
          roleModel: _model,
          roleEffort: _effort,
          ...rest
        } = meta as NonNullable<typeof meta>;
        return rest;
      });
      repo.update(pm.id, (session) => ({ ...session, model: "custom" }));

      expect((await roles.ensure("pm", "p1")).id).toBe(pm.id);
      expect(repo.get(pm.id)).toMatchObject({ model: "custom", archivedAt: null });
    }),
  );

  it(
    "keeps a session from before the setting was recorded, until the setting next changes",
    withRoles(async ({ roles, repo, set, setQuietly, settle }) => {
      const pm = await roles.ensure("pm", "p1");
      settle(pm.id);
      // As an earlier version left it: the setting already names another provider than the
      // session runs on, and nothing was recorded on the session.
      setQuietly({ providers: { pm: { provider: "codex" } } });
      repo.setStartMeta(pm.id, (meta) => {
        const { roleProvider: _, ...rest } = meta as NonNullable<typeof meta>;
        return rest;
      });
      // Its first wake after the upgrade doesn't retire it.
      expect((await roles.ensure("pm", "p1")).id).toBe(pm.id);
      expect(repo.get(pm.id).archivedAt).toBeNull();
      // Saving another setting doesn't either.
      await set({ providers: { pm: { provider: "codex" }, agent: { provider: "codex" } } });
      expect((await roles.ensure("pm", "p1")).id).toBe(pm.id);

      // Changing the role's setting does.
      await set({ providers: { pm: { provider: "claude" } } });
      expect((await roles.ensure("pm", "p1")).id).toBe(pm.id);
      await set({ providers: { pm: { provider: "codex" } } });
      const next = await roles.ensure("pm", "p1");
      expect(next.provider).toBe("codex");
      expect(repo.get(pm.id).archivedAt).not.toBeNull();
    }),
  );
});
