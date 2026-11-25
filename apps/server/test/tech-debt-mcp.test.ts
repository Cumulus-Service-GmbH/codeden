import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ToolError } from "../src/mcp/define";
import { allTools } from "../src/mcp/tools";
import { startServer } from "../src/server";
import { removeTree } from "./support/remove-tree";

it.each([
  ["record_tech_debt", { location: "src/file.ts:2", text: "Reuse the helper.", receipt: "r1" }],
  ["import_tech_debt", { issue: "owner/repo#246" }],
] as const)("limits %s to the PM's own project or the orchestrator", async (name, args) => {
  const tool = allTools.find((entry) => entry.name === name);
  expect(tool?.roles).toEqual(["pm", "orchestrator"]);
  if (!tool) throw new Error(`Missing ${name}`);
  expect(tool.scope).toBe("global");
  const get = vi.fn();
  const context = {
    role: "pm",
    projectId: "own",
    sessionId: "pm-session",
    caller: "mcp",
    signal: new AbortController().signal,
    services: { projects: { get } },
  } as unknown as Parameters<typeof tool.handler>[1];
  await expect(
    tool.handler(tool.input.parse({ ...args, projectId: "other" }), context),
  ).rejects.toThrow(ToolError);
  expect(get).not.toHaveBeenCalled();
});

it("exposes the resolver from the running server to PMs and the orchestrator only", async () => {
  const home = mkdtempSync(join(tmpdir(), "codeden-debt-mcp-"));
  const token = randomUUID();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({
      port: 0,
      dataDir: home,
      userHome: home,
      token,
      runner: false,
      secrets: "memory",
      checkSetupOnStart: false,
    });
    const { tools } = server.services;
    const name = "resolve_tech_debt";
    expect(tools.list("pm").find((tool) => tool.name === name)?.inputSchema.type).toBe("object");
    expect(tools.list("orchestrator").some((tool) => tool.name === name)).toBe(true);
    expect(tools.list("agent").some((tool) => tool.name === name)).toBe(false);
    const caller = {
      role: "pm",
      projectId: "own",
      sessionId: "pm",
      caller: "mcp",
      signal: new AbortController().signal,
    } as const;
    const result = await tools.call(
      name,
      {
        projectId: "foreign",
        ids: ["a"],
        status: "fixed",
        reason: "Done.",
        receipt: "proof",
      },
      caller,
    );
    expect(result).toMatchObject({ isError: true, text: "Give an accessible project id" });
  } finally {
    await server?.close();
    await removeTree(home);
  }
});
