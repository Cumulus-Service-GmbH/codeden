import { type Project, TechDebtView } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerToolContext } from "../src/mcp/define";
import { type ToolCaller, ToolRegistry } from "../src/mcp/registry";
import { importTechDebt, listTechDebt, recordTechDebt } from "../src/mcp/tools/tech-debt";
import { projectRoutes } from "../src/routes/projects";
import { techDebtIssuePort } from "../src/services/tech-debt/issue";
import { TechDebtService } from "../src/services/tech-debt/service";
import { startTechDebtFix } from "../src/services/tech-debt/start";
import { createGithubEnv } from "./support/github-env";

const issue = "owner/repo#246";
const date = "2026-11-23T00:00:00.000Z";
const low =
  "- [ ] LOW `src/build.ts:12` — Use the shared helper. | Receipt: review-1 | Date: 2026-11-23 | PR: #42";
const medium = "- [ ] MEDIUM `src/build.ts:20` — Reproduce the failure.";

function pmContext(project: Project, techDebt: TechDebtService): ServerToolContext<"global"> {
  return {
    role: "pm",
    projectId: project.id,
    sessionId: "pm",
    caller: "mcp",
    signal: new AbortController().signal,
    services: {
      techDebt,
      projects: { get: () => project },
    } as unknown as ServerToolContext<"global">["services"],
  };
}

describe("project tech debt", () => {
  const envs: ReturnType<typeof createGithubEnv>[] = [];
  afterEach(async () => {
    for (const env of envs.splice(0)) await env.close();
  });

  function setup() {
    const env = createGithubEnv();
    envs.push(env);
    let body = `## Review\r\n${low}\r\n${medium}\r\n`;
    const read = vi.fn(async () => ({ body, date }));
    const write = vi.fn(async (_issue: string, next: string) => {
      body = next;
    });
    const start = vi.fn(async () => "fix-session");
    const service = new TechDebtService(env.db.db, env.store, { read, write }, start);
    return {
      env,
      service,
      project: env.githubProject,
      local: env.localProject,
      read,
      write,
      start,
    };
  }

  it("imports LOW findings once on concurrent first loads and syncs only their ticks", async () => {
    const { service, project, read, write } = setup();
    await service.act(project, { action: "configure", issue });
    const [a, b] = await Promise.all([service.list(project), service.list(project)]);
    expect(a).toEqual(b);
    expect(read).toHaveBeenCalledExactlyOnceWith(issue);
    expect(a.findings).toMatchObject([
      {
        location: "src/build.ts:12",
        text: "Use the shared helper.",
        receipt: "review-1",
        date,
        pr: "#42",
        status: "open",
      },
    ]);
    const id = a.findings[0]?.id ?? "";
    await expect(service.act(project, { action: "dismiss", id, reason: " " })).rejects.toThrow();
    await service.act(project, {
      action: "dismiss",
      id,
      reason: "Superseded by the shared implementation.",
    });
    expect(write).toHaveBeenCalledExactlyOnceWith(
      issue,
      `## Review\r\n${low.replace("[ ]", "[x]")}\r\n${medium}\r\n`,
    );
    expect((await service.list(project)).findings[0]).toMatchObject({
      status: "dismissed",
      reason: "Superseded by the shared implementation.",
    });
  });

  it("keeps local findings project-scoped and starts a normal fix before changing status", async () => {
    const { service, local, project, read, write, start } = setup();
    const finding = {
      location: "src/local.ts:5",
      text: "Document the invariant.",
      receipt: "local-review",
      date,
      pr: null,
    };
    const added = await service.act(local, { action: "record", finding });
    const id = added.findings[0]?.id ?? "";
    await expect(service.act(project, { action: "fix", ids: [id] })).rejects.toThrow();
    start.mockRejectedValueOnce(new Error("runner unavailable"));
    await expect(service.act(local, { action: "fix", ids: [id] })).rejects.toThrow(
      "runner unavailable",
    );
    expect((await service.list(local)).findings[0]?.status).toBe("open");
    const started = await service.act(local, { action: "fix", ids: [id] });
    expect(started.findings[0]).toMatchObject({ status: "in_progress", sessionId: "fix-session" });
    expect(start).toHaveBeenLastCalledWith(local, [expect.objectContaining(finding)]);
    await service.act(local, { action: "fixed", id });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "closes a uniquely identified edited finding, reimport first: %s",
    async (reimportFirst) => {
      const { env, service, project, read, write } = setup();
      await service.act(project, { action: "configure", issue });
      const {
        findings: [original],
      } = await service.list(project);
      if (!original) throw new Error("Expected an imported finding");
      const edited = low.replace("shared helper", "shared build helper");
      const another = low.replace("review-1", "review-2");
      const body = [edited, another].join("\r\n");
      if (reimportFirst) {
        read.mockResolvedValueOnce({ body, date });
        const view = await service.importIssue(project, issue);
        expect(view.findings).toHaveLength(2);
        expect(view.findings[0]).toMatchObject({
          id: original.id,
          text: "Use the shared build helper.",
        });
        const seq = env.store.headSeq();
        read.mockResolvedValueOnce({ body, date });
        expect(await service.importIssue(project, issue)).toEqual(view);
        expect(env.store.headSeq()).toBe(seq);
      }
      read.mockResolvedValueOnce({ body, date });
      const closed = await service.act(project, { action: "fixed", id: original.id });
      expect(closed.findings[0]).toMatchObject({ id: original.id, status: "fixed" });
      expect(write).toHaveBeenCalledExactlyOnceWith(
        issue,
        [edited.replace("[ ]", "[x]"), another].join("\r\n"),
      );
      const reimported = await service.importIssue(project, issue);
      expect(reimported.findings).toHaveLength(2);
      expect(reimported.findings[0]).toMatchObject({ id: original.id, status: "fixed" });
      const seq = env.store.headSeq();
      expect(await service.importIssue(project, issue)).toEqual(reimported);
      expect(env.store.headSeq()).toBe(seq);
    },
  );

  it("refuses to tick an edited finding if multiple lines share its source metadata", async () => {
    const { service, project, read, write } = setup();
    await service.act(project, { action: "configure", issue });
    const {
      findings: [original],
    } = await service.list(project);
    if (!original) throw new Error("Expected an imported finding");
    read.mockResolvedValueOnce({
      body: [
        low.replace("shared helper", "other helper"),
        low.replace("shared helper", "different helper"),
      ].join("\n"),
      date,
    });
    await expect(service.act(project, { action: "fixed", id: original.id })).rejects.toThrow(
      "The tracking issue entry changed or was removed",
    );
    expect(write).not.toHaveBeenCalled();
    expect((await service.list(project)).findings[0]?.status).toBe("open");
  });

  it.each(["started", "queued"] as const)(
    "imports source locations into a scoped %s fix",
    async (status) => {
      const { env, project, read, write } = setup();
      const start = vi
        .fn<Parameters<typeof startTechDebtFix>[0]["start"]>()
        .mockResolvedValue(
          status === "queued"
            ? { status, sessionId: "fix-session", behind: [] }
            : { status, sessionId: "fix-session" },
        );
      const service = new TechDebtService(
        env.db.db,
        env.store,
        { read, write },
        (project, findings) => startTechDebtFix({ start }, project, findings),
      );
      const routes = projectRoutes({
        projects: { get: () => project },
        techDebt: service,
      } as unknown as Parameters<typeof projectRoutes>[0]);
      const path = `/${project.id}/tech-debt`;
      async function act(action: object) {
        return routes.request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
        });
      }
      expect((await act({ action: "configure", issue })).status).toBe(200);
      const locations = ["src/build.ts:12-15", "src/@build.ts:12:5", "src/with spaces.ts:9"];
      read.mockResolvedValueOnce({
        body: locations.map((location) => low.replace("src/build.ts:12", location)).join("\n"),
        date,
      });
      const response = await routes.request(path);
      expect(response.status).toBe(200);
      const view = TechDebtView.parse(await response.json());
      expect(view.findings).toMatchObject(locations.map((location) => ({ location })));
      const fixed = await act({
        action: "fix",
        ids: view.findings.map(({ id }) => id),
      });
      expect(fixed.status).toBe(200);
      expect(TechDebtView.parse(await fixed.json()).findings).toMatchObject(
        locations.map(() => ({ status: "in_progress", sessionId: "fix-session" })),
      );
      expect(start).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          projectId: project.id,
          scope: expect.objectContaining({
            paths: ["src/build.ts", "src/@build.ts", "src/with spaces.ts"],
          }),
          input: expect.objectContaining({ from: "codeden" }),
        }),
      );
    },
  );

  it.each(["failed", "stopped", "idle"] as const)(
    "retries a finding after its fix session goes %s without ticking the issue",
    async (status) => {
      const { env, service, project, start, write } = setup();
      await service.act(project, { action: "configure", issue });
      const { findings } = await service.list(project);
      const id = findings[0]?.id ?? "";
      const fix = { action: "fix" as const, ids: [id] };
      const session = env.addSession({
        id: "fix-session",
        projectId: project.id,
        status: "running",
      });
      await service.act(project, fix);
      await expect(service.act(project, fix)).rejects.toThrow();
      expect(start).toHaveBeenCalledTimes(1);

      env.store.append([
        {
          type: "session.updated",
          sessionId: session.id,
          payload: { session: { ...session, status } },
        },
      ]);
      start.mockResolvedValueOnce("retry-session");
      expect((await service.act(project, fix)).findings[0]).toMatchObject({
        status: "in_progress",
        sessionId: "retry-session",
      });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("lets Fix selected start again after a failed fix run and refuses while either run is active", async () => {
    const { env, service, project, start } = setup();
    await service.act(project, { action: "configure", issue });
    const { findings } = await service.list(project);
    const fix = { action: "fix" as const, ids: [findings[0]?.id ?? ""] };
    const first = env.addSession({ id: "fix-session", projectId: project.id, status: "running" });

    expect((await service.act(project, fix)).findings[0]).toMatchObject({
      status: "in_progress",
      sessionId: first.id,
    });
    await expect(service.act(project, fix)).rejects.toThrow("Select open findings");
    expect(start).toHaveBeenCalledTimes(1);

    env.store.append([
      {
        type: "session.updated",
        sessionId: first.id,
        payload: { session: { ...first, status: "failed" } },
      },
    ]);
    start.mockImplementationOnce(
      async () =>
        env.addSession({ id: "retry-session", projectId: project.id, status: "running" }).id,
    );
    expect((await service.act(project, fix)).findings[0]).toMatchObject({
      status: "in_progress",
      sessionId: "retry-session",
    });
    await expect(service.act(project, fix)).rejects.toThrow("Select open findings");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("syncs a closed local finding to a configured issue without duplicating it on reimport", async () => {
    const { service, project, write } = setup();
    await service.act(project, { action: "configure", issue });
    const recorded = await service.act(project, {
      action: "record",
      finding: { location: "src/local.ts:5", text: "Local.", receipt: null, date, pr: null },
    });
    const id = recorded.findings[0]?.id ?? "";
    await service.act(project, { action: "fixed", id });
    expect(write).toHaveBeenCalledExactlyOnceWith(
      issue,
      expect.stringContaining("- [x] LOW `src/local.ts:5`"),
    );
    expect((await service.list(project)).findings.map((finding) => finding.id)).toEqual([
      id,
      expect.not.stringMatching(id),
    ]);
  });

  it("imports from the configured repository through the fake GitHub client", async () => {
    const { env, project, start } = setup();
    const remote = env.gh.addIssue({ body: low });
    const target = `${env.gh.owner}/${env.gh.repo}#${remote.number}`;
    const service = new TechDebtService(
      env.db.db,
      env.store,
      techDebtIssuePort(env.service.client),
      start,
    );
    await service.act(project, { action: "configure", issue: target });
    const view = await service.list(project);
    expect(view.findings).toMatchObject([
      { source: target, status: "open", text: "Use the shared helper." },
    ]);
  });

  it("limits the PM tool to its own project and lets the orchestrator select a project", async () => {
    const { service, local, project } = setup();
    const tools = new ToolRegistry([listTechDebt], {
      techDebt: service,
      projects: { get: (id: string) => (id === local.id ? local : project) },
    } as never);
    const caller: ToolCaller = {
      role: "pm",
      projectId: local.id,
      sessionId: "pm",
      caller: "mcp",
      signal: new AbortController().signal,
    };
    expect(tools.list("agent")).toEqual([]);
    expect(await tools.call("list_tech_debt", { projectId: project.id }, caller)).toMatchObject({
      isError: true,
    });
    const own = await tools.call("list_tech_debt", {}, caller);
    expect(JSON.parse(own.text)).toMatchObject({ projectId: local.id });
    const selected = await tools.call(
      "list_tech_debt",
      { projectId: project.id },
      { ...caller, role: "orchestrator", projectId: null },
    );
    expect(JSON.parse(selected.text)).toMatchObject({ projectId: project.id });
  });

  it("deduplicates trimmed location and text independently of receipt and date", async () => {
    const { env, service, project } = setup();
    const finding = {
      location: "src/file.ts:2",
      text: "Reuse the helper.",
      receipt: "r1",
      date,
      pr: null,
    };
    const first = await service.act(project, { action: "record", finding });
    const seq = env.store.headSeq();
    const duplicate = await service.act(project, {
      action: "record",
      finding: {
        ...finding,
        location: " src/file.ts:2 ",
        text: " Reuse the helper. ",
        receipt: "r2",
        date: "2026-11-24T00:00:00.000Z",
      },
    });
    expect(first.findings).toHaveLength(1);
    expect(duplicate).toEqual(first);
    expect(env.store.headSeq()).toBe(seq);
  });

  it("retries an MCP issue import without changing the tracking issue or duplicating findings", async () => {
    const { env, service, project, read, write } = setup();
    const target = `${env.gh.owner}/${env.gh.repo}#247`;
    const context = pmContext(project, service);
    await service.act(project, { action: "configure", issue });
    read.mockRejectedValueOnce(new Error("Issue unavailable"));

    await expect(importTechDebt.handler({ issue: target }, context)).resolves.toMatchObject({
      issue,
      imported: false,
      findings: [],
      importError: "Issue unavailable",
      importErrorIssue: target,
    });

    const recovered = await importTechDebt.handler({ issue: target }, context);
    expect(recovered).toMatchObject({
      issue,
      imported: false,
      findings: [
        {
          source: target,
          location: "src/build.ts:12",
          text: "Use the shared helper.",
          receipt: "review-1",
          date,
          pr: "#42",
          status: "open",
        },
      ],
    });
    expect(recovered).not.toHaveProperty("importError");
    expect(recovered).not.toHaveProperty("importErrorIssue");
    expect(await importTechDebt.handler({ issue: target }, context)).toEqual(recovered);
    expect(read.mock.calls).toEqual([[target], [target], [target]]);
    expect(write).not.toHaveBeenCalled();
  });

  it("records the same location and text only once through MCP", async () => {
    const { service, project } = setup();
    const context = pmContext(project, service);
    const finding = { location: "src/file.ts:2", text: "Reuse the helper.", receipt: "r1" };
    const first = await recordTechDebt.handler(recordTechDebt.input.parse(finding), context);
    const retry = recordTechDebt.input.parse({ ...finding, receipt: "r2" });
    expect(await recordTechDebt.handler(retry, context)).toEqual(first);
    expect(first).toMatchObject({ findings: [finding] });
  });

  it("persists import errors, merges explicit imports, and counts only open findings", async () => {
    const { service, project, local, read, write } = setup();
    await service.act(project, {
      action: "record",
      finding: {
        location: "src/build.ts:12",
        text: "Use the shared helper.",
        receipt: null,
        date,
        pr: null,
      },
    });
    read.mockRejectedValueOnce(new Error("Issue unavailable"));
    expect(await service.importIssue(project, issue)).toMatchObject({
      issue: null,
      imported: false,
      importError: "Issue unavailable",
      importErrorIssue: issue,
    });
    expect(service.summaries([project, local])).toEqual([
      { projectId: project.id, open: 1, importError: "Issue unavailable" },
      { projectId: local.id, open: 0 },
    ]);
    const other =
      "- [ ] LOW `src/other.ts:5` — Reuse it. | receipt: r1 | date: 2026-11-23 | pr: #9";
    read.mockResolvedValueOnce({
      body: [low, other, other.replace("[ ]", "[x]").replace(":5", ":6")].join("\n"),
      date,
    });
    const imported = await service.importIssue(project, "Owner/Repo#246");
    expect(imported).toMatchObject({ issue: null, imported: false });
    expect(imported.importError).toBeUndefined();
    expect(imported.importErrorIssue).toBeUndefined();
    expect(imported.findings).toHaveLength(3);
    expect(imported.findings[1]).toMatchObject({
      source: "Owner/Repo#246",
      receipt: "r1",
      date,
      pr: "#9",
    });
    expect(imported.findings[2]?.status).toBe("fixed");
    expect(await service.importIssue(project, "owner/repo#247")).toMatchObject({
      issue: null,
      imported: false,
    });
    expect(service.summaries([project, { ...local, archivedAt: date }])).toEqual([
      { projectId: project.id, open: 2 },
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps a non-tracking import error after importing the tracking issue", async () => {
    const { service, project, read } = setup();
    const failed = "owner/repo#247";
    await service.act(project, { action: "configure", issue });
    read.mockRejectedValueOnce(new Error("Issue unavailable"));
    await service.importIssue(project, failed);

    expect(await service.importIssue(project, "Owner/Repo#246")).toMatchObject({
      issue,
      imported: true,
      importError: "Issue unavailable",
      importErrorIssue: failed,
    });
  });

  it("retries the failed non-tracking issue from list after the tracking issue is imported", async () => {
    const { service, project, read } = setup();
    const failed = "owner/repo#247";
    await service.act(project, { action: "configure", issue });
    await service.list(project);
    read.mockRejectedValueOnce(new Error("Issue unavailable"));
    await service.importIssue(project, failed);

    const view = await service.list(project);
    expect(read.mock.calls).toEqual([[issue], [failed], [failed]]);
    expect(view).toMatchObject({ issue, imported: true });
    expect(view.importError).toBeUndefined();
    expect(view.importErrorIssue).toBeUndefined();
  });

  it("clears an import error when configure moves the tracking issue away from its source", async () => {
    const { service, project, read } = setup();
    const failed = "Owner/Repo#246";
    await service.act(project, { action: "configure", issue });
    read.mockRejectedValueOnce(new Error("Issue unavailable"));
    await service.importIssue(project, failed);

    expect(
      await service.act(project, { action: "configure", issue: "OWNER/REPO#246" }),
    ).toMatchObject({
      importError: "Issue unavailable",
      importErrorIssue: failed,
    });
    const view = await service.act(project, { action: "configure", issue: "owner/repo#247" });
    expect(view.importError).toBeUndefined();
    expect(view.importErrorIssue).toBeUndefined();
  });

  it("refuses a PM import from another repository before reading GitHub", async () => {
    const { service, project, read } = setup();
    await expect(
      service.importIssue(project, "another/private#246", { restrictToProject: true }),
    ).rejects.toThrow("Use an issue from this project's repository or its tracking issue");
    expect(read).not.toHaveBeenCalled();
    await service.act(project, { action: "configure", issue });
    expect(await service.importIssue(project, issue, { restrictToProject: true })).toMatchObject({
      issue,
      imported: true,
    });
  });

  it("retains local records during an import failure and retries the import", async () => {
    const { service, project, read } = setup();
    await service.act(project, {
      action: "record",
      finding: { location: "src/local.ts:5", text: "Local.", receipt: null, date, pr: null },
    });
    await service.act(project, { action: "configure", issue });
    read.mockRejectedValueOnce(new Error("Issue unavailable"));
    expect(await service.list(project)).toMatchObject({
      imported: false,
      importError: "Issue unavailable",
      findings: [{ text: "Local." }],
    });
    expect((await service.list(project)).findings).toHaveLength(2);
  });
});
