import {
  type ActivitySummary,
  CODEDEN_VERSION,
  countTeamOverrides,
  defaultTeam,
  type HealthResponse,
  type InboxItem,
  inboxKindVisible,
  resolveTeam,
  type Session,
  SessionSnapshotQuery,
  type SettingsPatch,
  type Snapshot,
  SnapshotQuery,
  sessionTeamMember,
  summarizeActivity,
  TeamDiagnostics,
  TeamReviewLimitSettings,
} from "@codeden/contracts";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { rowToAutomation } from "../db/rows";
import { automations, inboxItems, sessions } from "../db/schema";
import { isRemoteRequest } from "../security";
import type { AppServices } from "../services/container";
import { badRequest, forbidden, notFound } from "../services/errors";
import { archivedSessionCounts, snapshotSessions } from "../services/sessions/archived";
import { sessionSnapshot } from "../services/sessions/snapshot";
import { listTeamRuns } from "../services/sessions/team-run-projection";
import { deepMerge } from "../settings-store";
import { agentConfigRoutes, sessionAgentConfigRoutes } from "./agent-config";
import { automationRoutes, projectAutomationRoutes } from "./automations";
import { browserRoutes, sessionBrowserRoutes } from "./browser";
import { checklistRoutes } from "./checklists";
import { executionRoutes } from "./execution";
import { factoryRoutes, projectFactoryRoutes } from "./factory";
import { githubRoutes, projectGithubRoutes, prRoutes, sessionGithubRoutes } from "./github";
import { imageRoutes } from "./images";
import { inboxRoutes } from "./inbox";
import { authRoutes, type NetworkRouteContext, networkRoutes } from "./network";
import { conflictRoutes, orchestrationRoutes } from "./orchestration";
import { projectRoutes } from "./projects";
import { remoteImageRoutes } from "./remote-image";
import { searchRoutes } from "./search";
import { sessionFileRoutes } from "./session-files";
import { sessionRoutes } from "./sessions";
import { artifactRoutes, fileRoutes, providerRoutes, secretRoutes, setupRoutes } from "./system";
import { updateRoutes } from "./updates";
import { usageRoutes } from "./usage";
import { errorResponse, queryOf } from "./validate";
import { speechRoutes, voiceRoutes } from "./voice";
import { utilityRoutes, workbenchRoutes } from "./workbench";

export interface ApiContext {
  services: AppServices;
  /** The home runner's connection and every runner (`RunnerHub.status`). */
  runnerStatus: () => Pick<Snapshot, "runner" | "runners">;
  startedAt: number;
  /** Stop the server (and optionally the runner) after the response is sent. */
  shutdown: (opts: { stopRunner: boolean }) => void;
  /** Network access (§15.1). */
  network: NetworkRouteContext;
  log?: (message: string) => void;
}

/**
 * HTTP API mounted at `/api`. Routes are chained so `AppType` carries their types for the
 * Hono RPC client used by the web app. Request and response shapes live in
 * `@codeden/contracts` (`api.ts`).
 */
export function createApi(ctx: ApiContext) {
  const s = ctx.services;
  return (
    new Hono()
      .onError((error, c) => errorResponse(error, c, ctx.log))
      .get("/health", (c) => {
        const body: HealthResponse = {
          ok: true,
          name: "codeden",
          version: CODEDEN_VERSION,
          uptimeSec: (Date.now() - ctx.startedAt) / 1000,
        };
        return c.json(body);
      })
      .get("/snapshot", queryOf(SnapshotQuery), (c) =>
        c.json(buildSnapshot(ctx, c.req.valid("query").capabilities?.split(",") ?? [])),
      )
      .get("/activity", (c) => c.json(buildActivity(s)))
      // A session's transcript: whole, or its latest root turns a page at a time (`?turns=`).
      .get("/sessions/:id/snapshot", queryOf(SessionSnapshotQuery), (c) =>
        c.json(sessionSnapshot(s, c.req.param("id"), c.req.valid("query"))),
      )
      .route("/projects", projectRoutes(s))
      .get("/tech-debt", (c) => c.json(s.techDebt.summaries(s.projects.list())))
      .route("/execution", executionRoutes(s))
      .route("/projects", projectGithubRoutes(s))
      .route("/projects", projectFactoryRoutes(s))
      .route("/factory", factoryRoutes(s))
      .route("/prs", prRoutes(s))
      .route("/github", githubRoutes(s))
      .route("/sessions", sessionGithubRoutes(s))
      .route("/sessions", sessionRoutes(s, ctx.network.token))
      .route("/sessions", workbenchRoutes(s))
      .route("/sessions", sessionBrowserRoutes(s))
      .route("/browser", browserRoutes(s))
      .route("/images", imageRoutes(s))
      .route("/agent-config", agentConfigRoutes(s))
      .route("/voice", voiceRoutes(s))
      .route("/", speechRoutes(s))
      .route("/sessions", sessionAgentConfigRoutes(s))
      .route("/sessions", sessionFileRoutes(s))
      .route("/utility", utilityRoutes(s))
      .route("/inbox", inboxRoutes(s))
      .route("/checklists", checklistRoutes(s))
      .route("/orchestration", orchestrationRoutes(s))
      .route("/conflicts", conflictRoutes(s))
      .route("/automations", automationRoutes(s))
      .route("/projects", projectAutomationRoutes(s))
      .route("/usage", usageRoutes(s))
      .route("/search", searchRoutes(s))
      .route("/setup", setupRoutes(s))
      .route("/providers", providerRoutes(s))
      .route("/updates", updateRoutes(s))
      .route("/artifacts", artifactRoutes(s))
      .route("/remote-image", remoteImageRoutes())
      .route("/secrets", secretRoutes(s))
      .route("/network", networkRoutes(ctx.network))
      .route("/auth", authRoutes(ctx.network))
      .route("/", fileRoutes(s))
      .get("/settings/team", (c) => {
        const sessionId = c.req.query("sessionId");
        const row = sessionId ? s.sessionRepo.find(sessionId) : undefined;
        if (sessionId && !row) throw notFound("Session not found", "session_not_found");
        const projectId = row ? row.session.projectId : c.req.query("projectId");
        const resolved = resolveTeam({
          defaults: defaultTeam(s.settings.get()),
          project: projectId ? s.projectTeam(projectId, row?.startMeta?.teamId) : [],
          approved: row?.startMeta?.runTeam,
          session: row?.startMeta?.ownTeamPins ? sessionTeamMember(row.session) : null,
        });
        return c.json(
          TeamDiagnostics.parse({
            ...resolved,
            overrides:
              projectId || row
                ? {}
                : countTeamOverrides(s.projects.list().map(({ id }) => s.projectTeam(id))),
          }),
        );
      })
      .get("/settings", (c) => c.json(s.settings.get()))
      .patch("/settings", async (c) => {
        const patch = (await c.req.json().catch(() => undefined)) as SettingsPatch | undefined;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          throw badRequest("Expected a JSON object");
        }
        const autonomy = patch.autonomy;
        if (
          isRemoteRequest(c) &&
          autonomy !== undefined &&
          (autonomy === null ||
            typeof autonomy !== "object" ||
            Array.isArray(autonomy) ||
            Object.keys(autonomy).some((key) => key !== "default"))
        ) {
          throw forbidden("Changing role autonomy floors requires the local install token");
        }
        const { teamReviewLimits: reviewPatch, ...settingsPatch } = patch;
        const before = s.settings.get();
        if (reviewPatch !== undefined) {
          if (isRemoteRequest(c)) {
            throw forbidden("Changing Team review limits requires the local install token");
          }
          if (Object.keys(settingsPatch).length) {
            throw badRequest(
              "Save Team review limits separately from other settings",
              "invalid_settings",
            );
          }
          const oldValue = before.teamReviewLimits;
          const reviewed = TeamReviewLimitSettings.safeParse(
            reviewPatch && deepMerge(oldValue, reviewPatch),
          );
          if (!reviewed.success) {
            throw badRequest(String(reviewed.error), "invalid_settings");
          }
          const newValue = reviewed.data;
          const settings = { ...before, teamReviewLimits: newValue };
          s.store.append([
            {
              type: "team_review_limits.updated",
              sessionId: null,
              payload: { actor: "owner", oldValue, newValue },
            },
            { type: "settings.updated", sessionId: null, payload: { settings } },
          ]);
          return c.json(settings);
        }
        let settings: ReturnType<typeof s.settings.update>;
        try {
          settings = s.settings.update(settingsPatch);
        } catch (error) {
          return c.json({ error: { code: "invalid_settings", message: String(error) } }, 400);
        }
        s.store.append([{ type: "settings.updated", sessionId: null, payload: { settings } }]);
        if (patch.imageGeneration) s.images.invalidate();
        // A role moved to another provider gets a fresh session there (§8.1). Stopping the old
        // one can take the runner a while, so the response doesn't wait for it; failures are
        // logged by the role sessions.
        if (patch.providers || patch.teamSetup) {
          void s.orchestration.roles.applyProviderSettings(
            patch.providers ? before.providers : undefined,
          );
        }
        return c.json(settings);
      })
      .post("/shutdown", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { stopRunner?: boolean };
        ctx.shutdown({ stopRunner: body.stopRunner === true });
        return c.json({ ok: true as const });
      })
  );
}

export type ApiRoutes = ReturnType<typeof createApi>;

function buildSnapshot(ctx: ApiContext, capabilities: readonly string[]): Snapshot {
  const s = ctx.services;
  // Read the head first: anything appended later arrives through the WebSocket.
  const seq = s.store.headSeq();
  return {
    seq,
    serverVersion: CODEDEN_VERSION,
    generatedAt: new Date().toISOString(),
    settings: s.settings.get(),
    projects: s.projects.list(),
    checklists: s.checklist.list(),
    teamRuns: listTeamRuns(s.db),
    sessions: snapshotSessions(s.db),
    archivedSessionCounts: archivedSessionCounts(s.db),
    inbox: s.inbox
      .list({ status: "open" })
      .filter(({ kind }) => inboxKindVisible(kind, capabilities)),
    automations: s.db.select().from(automations).all().map(rowToAutomation),
    scheduled: s.orchestration.automation.listScheduledRuns(null, 20),
    roleSessions: s.orchestration.roles.refs(),
    ...ctx.runnerStatus(),
  };
}

/** Running and waiting sessions and open inbox items, for the desktop tray and badge (§17). */
function buildActivity(s: AppServices): ActivitySummary {
  const active = s.db
    .select({ status: sessions.status })
    .from(sessions)
    .where(inArray(sessions.status, ["starting", "running", "waiting"]))
    .all() as Array<{ status: Session["status"] }>;
  const open = s.db
    .select({ status: inboxItems.status })
    .from(inboxItems)
    .where(eq(inboxItems.status, "open"))
    .all() as Array<{ status: InboxItem["status"] }>;
  return summarizeActivity(active, open);
}
