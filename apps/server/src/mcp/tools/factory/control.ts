import {
  type FactoryControlAction,
  FactoryControlRequest,
  type FactoryStatus,
  isFactoryMode,
  loopControlLine,
} from "@codeden/contracts";
import type { AppServices } from "../../../services/container";
import { runState } from "../../../services/factory/status";
import {
  defineTool,
  type ServerToolContext,
  type ToolAvailabilityContext,
  ToolError,
} from "../../define";
import { asTool, inFactoryProject } from "./shared";

export function controlAvailable(services: AppServices, caller?: ToolAvailabilityContext): boolean {
  return !caller || caller.projectId === null || inFactoryProject(services, caller);
}

export function controlTarget(ctx: ServerToolContext<"global">, projectId?: string): string {
  if (ctx.role === "orchestrator") {
    if (!projectId) {
      throw new ToolError("Pass projectId: the orchestrator controls any project's factory loop");
    }
  } else if (ctx.role === "pm") {
    if (!ctx.projectId || (projectId !== undefined && projectId !== ctx.projectId)) {
      throw new ToolError("A PM controls only its own project's factory loop");
    }
    projectId = ctx.projectId;
  } else {
    throw new ToolError(
      "Only the orchestrator and project manager sessions control the factory loop",
    );
  }
  if (!isFactoryMode(ctx.services.projects.get(projectId).autonomyMode)) {
    throw new ToolError("The project must be in a factory mode");
  }
  return projectId;
}

export function controlStatus(status: FactoryStatus) {
  return {
    state: runState({ ...status, drain: status.drain !== null }),
    lastControl: status.lastControl,
    halt: status.halt,
    line: loopControlLine(status.lastControl),
  };
}

function controlTool(action: FactoryControlAction, description: string) {
  return defineTool({
    name: `factory_${action}`,
    description: `${description} The reason is required and recorded in the inbox. Use these tools for factory loop controls. Never edit settings or call the API by hand. The orchestrator must pass projectId and can target any factory project.`,
    roles: action === "pause" ? ["orchestrator", "pm"] : ["orchestrator"],
    scope: "global",
    alwaysLoad: true,
    isAvailable: controlAvailable,
    input: FactoryControlRequest,
    handler: (input, ctx) =>
      asTool(async () => {
        if (action !== "pause" && ctx.role !== "orchestrator") {
          throw new ToolError(
            "Only the orchestrator (or the user, in the factory view) can resume, stop or kill the factory loop. A project manager can pause its own project with factory_pause.",
          );
        }
        const projectId = controlTarget(ctx, input.projectId);
        const { factory } = ctx.services;
        const control = {
          by: ctx.role === "orchestrator" ? "orchestrator" : "pm",
          sessionId: ctx.sessionId,
          reason: input.reason,
        } as const;
        let changed = false;
        if (action === "resume") {
          changed = (await factory.resumeControlled(projectId, control)).changed;
        } else {
          const result = await factory.setKillSwitch(projectId, true, {
            mode: action === "pause" ? "drain" : "now",
            control,
          });
          changed = result.changed ?? false;
        }
        const status = await factory.status(projectId);
        return {
          projectId,
          changed,
          control: controlStatus(status),
        };
      }),
  });
}

export const factoryPause = controlTool(
  "pause",
  "Pause the factory after its work in flight finishes. A PM can pause only its own project.",
);
export const factoryResume = controlTool(
  "resume",
  "The orchestrator can resume a paused or stopped factory, or cancel its drain, unless a built-in halt still blocks it.",
);
export const factoryStop = controlTool(
  "stop",
  "The orchestrator can stop the factory and its sessions immediately.",
);
