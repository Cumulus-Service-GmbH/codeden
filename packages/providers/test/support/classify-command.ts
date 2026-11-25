import { expect } from "vitest";
import { ClaudePolicy } from "../../src/claude/permissions";
import { guardedReadCommand } from "../../src/policy/delegated-read";
import { classifyCommand, type RiskContext } from "../../src/policy/risk";

/** Run the upstream classifier fixtures through Claude's approval path as well. */
export function classifyCommandAndCheckApproval(command: string, ctx: RiskContext) {
  const risk = classifyCommand(command, ctx);
  if (risk.risky) {
    const tool = ctx.shell === "powershell" ? "PowerShell" : "Bash";
    const input = { command };
    const policy = new ClaudePolicy("supervised", ctx);
    policy.allowForSession(tool, input);
    expect(policy.needsUser(tool, input), command).toMatchObject({ ask: true });
    const approval = { action: "command" as const, toolName: tool, command, toolInput: input };
    expect(guardedReadCommand(approval, ctx.dir ?? ctx.cwd, ctx.cwd), command).toBeUndefined();
    const shell = tool === "PowerShell" ? "powershell" : "posix";
    if (classifyCommand(command, { ...ctx, shell }).risky) {
      policy.setAutonomy("auto");
      expect(policy.needsUser(tool, input), command).toMatchObject({ ask: true });
    }
  }
  return risk;
}
