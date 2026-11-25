import { type AgentEvent, isShellCall, type RunnerCommandOf } from "@codeden/contracts";

type Call = Omit<NonNullable<RunnerCommandOf<"session.steer">["interrupt"]>, "rootTurnId">;

/** Allow only simple, known waits. Scripts, compound commands and unknown programs may write. */
export function canInterruptShell(command: string): boolean {
  return /^sleep[ \t]+[0-9]+(?:\.[0-9]+)?[smhd]?[ \t]*$/.test(command);
}

function callKey({ threadId, turnId, itemId }: Call): string {
  return JSON.stringify([threadId, turnId, itemId]);
}

export class ActiveTools {
  private readonly tools = new Map<string, { call: Call; shell: boolean; command?: string }>();

  track(event: AgentEvent): void {
    if (
      event.type === "item.started" &&
      event.item.kind === "tool_call" &&
      event.item.status === "in_progress"
    ) {
      const { threadId, turnId, item } = event;
      const call = { threadId, turnId, itemId: item.id };
      this.tools.set(callKey(call), {
        call,
        shell: isShellCall(item),
        command: item.toolKind === "command" ? item.command : undefined,
      });
    } else if (event.type === "item.completed") {
      const { threadId, turnId, item } = event;
      this.tools.delete(callKey({ threadId, turnId, itemId: item.id }));
    } else if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.interrupted"
    ) {
      for (const [key, { call }] of this.tools) {
        if (call.threadId === event.threadId && call.turnId === event.turnId)
          this.tools.delete(key);
      }
    }
  }

  clear(): void {
    this.tools.clear();
  }

  shell(): Call | undefined {
    return [...this.tools.values()].find((tool) => tool.shell)?.call;
  }

  canInterrupt(call: Call): boolean {
    const target = this.tools.get(callKey(call));
    return (
      this.tools.size === 1 && target?.command !== undefined && canInterruptShell(target.command)
    );
  }
}
