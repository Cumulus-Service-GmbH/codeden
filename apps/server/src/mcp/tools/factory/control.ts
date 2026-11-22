import {
  type FactoryControlAction,
  FactoryControlRequest,
  type FactoryRunState,
  type FactoryStatus,
  isFactoryMode,
  loopControlLine,
} from "@codeden/contracts";
import type { AppServices } from "../../../services/container";
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

function runState(status: FactoryStatus): FactoryRunState {
  if (status.globalKillSwitch) return "stopped";
  if (status.killSwitch) return status.lastControl?.action === "pause" ? "paused" : "stopped";
  if (status.drain) return "draining";
  return status.loopState === "paused" ? "paused" : "running";
}

export function controlStatus(status: FactoryStatus) {
  return {
    state: runState(status),
    lastControl: status.lastControl,
    line: loopControlLine(status.lastControl),
  };
}

function controlTool(action: FactoryControlAction, description: string) {
  return defineTool({
    name: `factory_${action}`,
    description: `${description} The reason is required and shown to the user. Use these tools for every factory pause, resume and stop. Never edit settings or call the API by hand. A PM controls only its own project. The orchestrator must pass projectId and can control any factory project.`,
    roles: ["orchestrator", "pm"],
    scope: "global",
    alwaysLoad: true,
    isAvailable: controlAvailable,
    input: FactoryControlRequest,
    handler: (input, ctx) =>
      asTool(async () => {
        const projectId = controlTarget(ctx, input.projectId);
        const { factory, projects, settings } = ctx.services;
        const control = {
          by: ctx.role === "orchestrator" ? "orchestrator" : "pm",
          sessionId: ctx.sessionId,
          reason: input.reason,
        } as const;
        let changed = false;
        if (action === "resume") {
          if (settings.get().factory.killSwitch) {
            throw new ToolError("The global kill switch is on. Only the user can release it.");
          }
          if (projects.get(projectId).killSwitch) {
            changed = (await factory.setKillSwitch(projectId, false, { control })).changed ?? false;
          }
          const loop = await factory.resume(projectId, control);
          changed = changed || (loop.changed ?? false);
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
  "Pause the factory after its work in flight finishes.",
);
export const factoryResume = controlTool(
  "resume",
  "Resume a paused or stopped factory, or cancel its drain.",
);
export const factoryStop = controlTool("stop", "Stop the factory and its sessions immediately.");
