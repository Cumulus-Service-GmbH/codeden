import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalAction, AutonomyLevel } from "@codeden/contracts";
import { asksAtEveryLevel, touchesCodeden } from "../policy/assessment";
import { guardedReadCommand } from "../policy/delegated-read";
import { isInNotes } from "../policy/paths";
import { readOnlyCommandDenial } from "../policy/read-only";
import type { RiskContext } from "../policy/risk";
import { str, toJson } from "../util/text";
import {
  assessClaudeTool,
  COMMAND_TOOLS,
  defaultApprovalAction,
  EDIT_TOOLS,
  editPath,
  PLAN_TOOL,
  QUESTION_TOOL,
} from "./tools";

const FINISH_PLAN = "Finish the plan and present it with ExitPlanMode; once the user approves it";
const CHROME_PREFIX = "mcp__claude-in-chrome__";
const CHROME_OBSERVATION_TOOLS = new Set([
  "tabs_context_mcp",
  "read_page",
  "find",
  "get_page_text",
  "read_console_messages",
  "read_network_requests",
]);

/** The decision for one tool call. */
export type Gate =
  | { ask: false; command?: string }
  | {
      ask: true;
      action: ApprovalAction;
      reason: string;
      singleUse?: true;
      rememberedCommand?: string;
    };

/**
 * Native permission mode per autonomy level (§11.2):
 * - read_only  -> `default`; edits and writing commands are denied by the PreToolUse hook
 *                 (`ClaudePolicy.denial`), so they never reach a prompt
 * - supervised -> `default`, and every edit/command is forced to ask via a PreToolUse hook
 * - auto       -> `acceptEdits`, plus the risky-action classifier
 * - full       -> `bypassPermissions`, asking only for writes outside the worktree (the OS
 *                 temp directory counts as inside, except for secrets files there)
 * Plan mode overrides all of them with `plan`. CodeDen's own credential files ask at every
 * level and are refused for read-only sessions (`../policy/codeden-home`).
 */
export function permissionModeFor(autonomy: AutonomyLevel, planMode: boolean): PermissionMode {
  if (planMode) return "plan";
  if (autonomy === "read_only" || autonomy === "supervised") return "default";
  if (autonomy === "auto") return "acceptEdits";
  return "bypassPermissions";
}

/**
 * CodeDen's approval policy for Claude tool calls. `gate()` runs in a PreToolUse hook (so it
 * sees every call, including ones Claude would auto-allow) and again in `canUseTool`.
 * Hook `ask` decisions route the call to `canUseTool` in every permission mode.
 */
export class ClaudePolicy {
  private readonly sessionAllow = new Set<string>();
  /** Plan mode: edits outside Claude's notes and writing commands are refused. */
  private planning = false;

  constructor(
    private autonomy: AutonomyLevel,
    private readonly ctx: RiskContext,
    /** Read-only sessions (orchestrator, PMs): edits and writing commands are denied. */
    private readonly readOnly = false,
    /** CodeDen's own MCP servers (trusted): the only ones a read-only session may call. */
    private readonly codedenMcpServers: readonly string[] = [],
  ) {}

  get level(): AutonomyLevel {
    return this.autonomy;
  }

  /**
   * True while edits and writing commands are refused: a read-only role (orchestrator, PMs),
   * or the `read_only` permission level, which can change live with `setAutonomy`.
   */
  get isReadOnly(): boolean {
    return this.readOnly || this.autonomy === "read_only";
  }

  /** Switch the level; the next `gate()` uses it. `allow_session` decisions are kept. */
  setAutonomy(level: AutonomyLevel): void {
    this.autonomy = level;
  }

  /**
   * Plan mode on or off. Claude's `plan` mode hands file edits to `canUseTool`, which Auto and
   * Full would approve, so CodeDen refuses them itself while the agent plans.
   */
  setPlanning(on: boolean): void {
    this.planning = on;
  }

  /**
   * Why a call is refused outright (read-only sessions, plan mode), or undefined. `dir` is the
   * shell's current directory, as for `gate`.
   */
  denial(toolName: string, input: Record<string, unknown>, dir?: string): string | undefined {
    if (toolName.startsWith(CHROME_PREFIX)) {
      const name = toolName.slice(CHROME_PREFIX.length);
      const url = str(input, "url");
      if (
        !CHROME_OBSERVATION_TOOLS.has(name) &&
        !(name === "navigate" && url && /^https?:\/\//i.test(url)) &&
        !(name === "computer" && input.action === "screenshot")
      ) {
        return "Claude in Chrome cannot enter input when CodeDen cannot verify the target field.";
      }
    }
    // Read-only roles call no MCP tool but CodeDen's own, whatever server offers it.
    if (this.readOnly && toolName.startsWith("mcp__")) {
      const server = toolName.slice("mcp__".length).split("__")[0] ?? "";
      if (!this.codedenMcpServers.includes(server)) {
        return "This session is read-only: it can use CodeDen's own tools only, not other MCP servers' tools.";
      }
    }
    if (this.isReadOnly && touchesCodeden(this.assess(toolName, input, dir))) {
      return this.readOnly
        ? "This session is read-only: CodeDen's own home and credential files are off limits. Act through CodeDen tools instead."
        : "This session has read-only permissions: CodeDen's own home and credential files are off limits. Report what you found instead.";
    }
    // A planning agent writes its plan into Claude's notes folders, at every level (the
    // `read_only` level included). Read-only roles (orchestrator, PMs) never plan.
    if (this.planning && !this.readOnly && this.isNotesEdit(toolName, input)) return undefined;
    if (!this.isReadOnly) return this.planning ? this.planDenial(toolName, input) : undefined;
    if (EDIT_TOOLS.has(toolName)) {
      return this.readOnly
        ? "This session is read-only: it cannot edit files. Act through CodeDen tools instead."
        : "This session has read-only permissions: it cannot edit files, commit or push. Report what you found instead.";
    }
    if (COMMAND_TOOLS.has(toolName)) {
      // Agent sessions at `read_only` may run the project's checks; read-only roles may not.
      const reason = readOnlyCommandDenial(str(input, "command") ?? "", {
        allowChecks: !this.readOnly,
      });
      return reason ? `This session is read-only: ${reason}.` : undefined;
    }
    return undefined;
  }

  /**
   * Plan mode refusals at every level: edits (the plan file in Claude's notes folders was let
   * through by `denial`) and shell commands outside the read-only allowlist (checks may run).
   */
  private planDenial(toolName: string, input: Record<string, unknown>): string | undefined {
    if (EDIT_TOOLS.has(toolName)) {
      return `Plan mode: don't edit files yet. ${FINISH_PLAN}, you can implement it.`;
    }
    if (COMMAND_TOOLS.has(toolName)) {
      const reason = readOnlyCommandDenial(str(input, "command") ?? "", { allowChecks: true });
      return reason ? `Plan mode: ${reason}. ${FINISH_PLAN}, you can run it.` : undefined;
    }
    return undefined;
  }

  /** An edit tool writing inside Claude's notes folders (its plans folder, auto-memory). */
  private isNotesEdit(toolName: string, input: Record<string, unknown>): boolean {
    if (!EDIT_TOOLS.has(toolName)) return false;
    const target = editPath(input);
    return target !== "" && isInNotes(target, this.ctx);
  }

  /**
   * Decide one tool call. `dir` is the shell's current directory as Claude reports it (an
   * earlier `cd` persists between Bash calls); relative paths resolve from it.
   */
  gate(toolName: string, input: Record<string, unknown>, dir?: string): Gate {
    if (toolName.startsWith(CHROME_PREFIX)) {
      return {
        ask: true,
        action: "tool",
        reason: "Claude in Chrome uses your browser",
        singleUse: true,
      };
    }
    if (toolName === QUESTION_TOOL) {
      return { ask: true, action: "other", reason: "The agent is asking a question" };
    }
    if (toolName === PLAN_TOOL) {
      return { ask: true, action: "plan", reason: "The agent finished planning" };
    }
    const risk = this.assess(toolName, input, dir);
    if (!risk.risky && this.sessionAllow.has(this.readKey(toolName, input, dir))) {
      const tool = {
        action: "command" as const,
        toolName,
        command: str(input, "command"),
        toolInput: toJson(input),
      };
      const command = guardedReadCommand(tool, dir ?? this.ctx.cwd, this.ctx.cwd);
      if (command) {
        return {
          ask: true,
          action: "command",
          reason: "Checking remembered read approval",
          rememberedCommand: command,
        };
      }
    }
    if (this.autonomy === "supervised") {
      if (risk.risky) return { ask: true, action: risk.action, reason: risk.reason };
      if (COMMAND_TOOLS.has(toolName) || EDIT_TOOLS.has(toolName)) {
        return {
          ask: true,
          action: defaultApprovalAction(toolName),
          reason: "Supervised mode: every edit and command needs approval",
        };
      }
      return { ask: false };
    }
    if (!risk.risky) return { ask: false };
    if (this.autonomy === "full" && risk.action !== "outside_worktree" && !asksAtEveryLevel(risk)) {
      return { ask: false };
    }
    return { ask: true, action: risk.action, reason: risk.reason };
  }

  private assess(toolName: string, input: Record<string, unknown>, dir?: string) {
    return assessClaudeTool(toolName, input, dir ? { ...this.ctx, dir } : this.ctx);
  }

  /**
   * Whether a `canUseTool` call (Claude's own permission prompt) needs the user. In supervised
   * mode everything Claude asks about goes to the user; otherwise only gated calls do.
   */
  needsUser(toolName: string, input: Record<string, unknown>, dir?: string): Gate {
    const gate = this.gate(toolName, input, dir);
    if (gate.ask && gate.rememberedCommand) return { ask: false, command: gate.rememberedCommand };
    if (gate.ask || this.autonomy !== "supervised") return gate;
    return {
      ask: true,
      action: defaultApprovalAction(toolName),
      reason: "Claude asked for permission",
    };
  }

  /** Remember a read grant only for its exact input and working directory. */
  allowForSession(toolName: string, input: Record<string, unknown>, dir?: string): void {
    this.sessionAllow.add(this.readKey(toolName, input, dir));
  }

  /** The exact call, in the directory its relative paths resolve from. */
  private readKey(toolName: string, input: Record<string, unknown>, dir?: string): string {
    return `${toolName}\n${dir ?? this.ctx.cwd}\n${JSON.stringify(input)}`;
  }
}
