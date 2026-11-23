import { expect, it, vi } from "vitest";
import { ToolError } from "../src/mcp/define";
import { allTools } from "../src/mcp/tools";

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
