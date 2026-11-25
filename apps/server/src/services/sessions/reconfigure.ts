import type { Session, UpdateSessionRequest } from "@codeden/contracts";
import { conflict } from "../errors";
import { type RunnerPort, runnerErrorCode } from "../runner-port";
import { withLoopSetting } from "./checks";
import { type AutonomyAudit, emptyStartMeta, type PendingConfig, type SessionRepo } from "./repo";

/** The recorded revision also survives a failed or delayed configure. */
export function configRevision(repo: SessionRepo, id: string): number {
  return repo.find(id)?.startMeta?.configRevision ?? 0;
}

function unconfirmed(unsupported = false) {
  return conflict(
    unsupported
      ? "The runner cannot apply the current session settings live. Stop and resume the session to apply them."
      : "The runner has not confirmed the current session autonomy and settings.",
    "config_unconfirmed",
  );
}

/** Recheck after awaiting a configure and immediately before starting provider work. */
export function assertConfigRevision(repo: SessionRepo, id: string, revision: number): void {
  if (configRevision(repo, id) !== revision) throw unconfirmed();
}

function clearPending(repo: SessionRepo, id: string, revision: number, applied?: PendingConfig) {
  if (configRevision(repo, id) !== revision) return;
  repo.setStartMeta(id, (m) => {
    const { pendingConfig, ...meta } = m ?? emptyStartMeta();
    if (!applied || !pendingConfig) return meta;
    const rest = { ...pendingConfig };
    for (const key of Object.keys(applied) as (keyof PendingConfig)[]) delete rest[key];
    return Object.keys(rest).length === 0 ? meta : { ...meta, pendingConfig: rest };
  });
}

/** A successful open used the recorded settings for this revision. */
export function confirmOpenedConfig(repo: SessionRepo, id: string, revision: number): void {
  if (repo.find(id)?.startMeta?.pendingConfig) clearPending(repo, id, revision);
}

async function configure(
  repo: SessionRepo,
  runner: RunnerPort,
  id: string,
  revision: number,
  change: PendingConfig,
  timeout?: number,
): Promise<void> {
  const row = repo.get(id);
  const result = await runner.request(
    {
      name: "session.configure",
      sessionId: id,
      revision,
      ...change,
      // Older rows may contain stale values left by the previous retry path.
      ...(change.autonomy !== undefined && { autonomy: row.autonomy }),
      ...(change.planMode !== undefined && { planMode: row.planMode ?? false }),
    },
    timeout,
  );
  if (result?.revision !== revision) throw unconfirmed();
  clearPending(repo, id, revision, change);
}

/** Record settings and their pending revision together before issuing live configuration. */
export async function updateSession(
  repo: SessionRepo,
  runner: RunnerPort,
  id: string,
  req: UpdateSessionRequest,
  audit?: AutonomyAudit,
  refreshAutonomy = false,
): Promise<Session> {
  const change: PendingConfig = {
    ...(req.model !== undefined && { model: req.model }),
    ...(req.effort !== undefined && { effort: req.effort }),
    ...(req.autonomy !== undefined && { autonomy: req.autonomy }),
    ...(req.planMode !== undefined && { planMode: req.planMode }),
  };
  const updatesConfig = Object.keys(change).length > 0;
  const owner = audit && "owner" in audit;
  const session = repo.update(
    id,
    (s) => ({
      ...s,
      ...change,
      ...((req.untilChecksPass !== undefined || req.checkRounds !== undefined) && s.checks
        ? { checks: withLoopSetting(s.checks, req) }
        : {}),
      ...(req.title !== undefined ? { title: req.title } : {}),
    }),
    audit,
    updatesConfig
      ? (m) => ({
          ...(m ?? emptyStartMeta()),
          ...(!refreshAutonomy &&
            req.autonomy !== undefined && {
              ...(!owner && m?.autonomyChoice !== undefined && { autonomyChoice: req.autonomy }),
              ownerAutonomyOverride: owner ? req.autonomy : undefined,
            }),
          configRevision: (m?.configRevision ?? 0) + 1,
          pendingConfig: { ...m?.pendingConfig, ...change },
        })
      : undefined,
  );
  const meta = repo.find(id)?.startMeta;
  if (change.autonomy === undefined && change.planMode === undefined) return session;
  const pending = meta?.pendingConfig;
  const live: PendingConfig = {
    ...(pending?.autonomy !== undefined && { autonomy: pending.autonomy }),
    ...(pending?.planMode !== undefined && { planMode: pending.planMode }),
  };
  // Refusal or timeout leaves the already-recorded settings pending, at their own revision.
  await configure(repo, runner, id, meta?.configRevision ?? 0, live, 10_000).catch(() => {});
  return repo.get(id);
}

/** Confirm the latest pending configuration before sending input or compacting. */
export async function applyPendingConfig(
  repo: SessionRepo,
  runner: RunnerPort,
  session: Session,
  liveOnly = false,
): Promise<number> {
  for (;;) {
    const meta = repo.find(session.id)?.startMeta;
    const revision = meta?.configRevision ?? 0;
    const pending = meta?.pendingConfig;
    if (!pending) return revision;
    const change = liveOnly
      ? {
          ...(pending.autonomy !== undefined && { autonomy: pending.autonomy }),
          ...(pending.planMode !== undefined && { planMode: pending.planMode }),
        }
      : pending;
    try {
      // A model-only update can acknowledge its revision for steering without changing the
      // model during a running turn. The model remains pending for the next turn.
      await configure(repo, runner, session.id, revision, change);
      if (liveOnly && configRevision(repo, session.id) === revision) return revision;
    } catch (error) {
      const code = runnerErrorCode(error);
      if (code === "unknown_session") throw error;
      if (configRevision(repo, session.id) === revision) throw unconfirmed(code === "unsupported");
    }
  }
}
