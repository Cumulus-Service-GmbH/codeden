import { realpathSync } from "node:fs";
import { sessionApprovalBlockReason, type UserQuestion } from "@codeden/contracts";
import { guardedReadCommand } from "../policy/delegated-read";
import type { RiskAssessment } from "../policy/risk";
import { shorten } from "../util/text";
import {
  type ApprovalContext,
  type ApprovalItem,
  approvedByPolicy,
  decisionOf,
} from "./approval-context";
import { handleElicitation } from "./elicitation";
import { commandRisk, levelAllows, patchRisk, permissionsRisk } from "./policy";
import type { ServerRequest } from "./protocol";
import type {
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  ToolRequestUserInputResponse,
} from "./protocol/v2";
import { CodexRpcError } from "./rpc";

/** The item with the classifier's verdict, for the user to decide. */
function withRisk(item: ApprovalItem, risk: RiskAssessment): ApprovalItem {
  if (!risk.risky) return item;
  return {
    ...item,
    action: item.action === "network" ? item.action : risk.action,
    reason: item.reason ?? risk.reason,
  };
}

/**
 * Local app-server requests render the execution argv as shell-quoted words.
 * Recognize only a fixed non-login shell and a single literal script argument.
 * The read verifier still checks the script itself.
 */
function readCommand(command: string | null | undefined): string | undefined {
  if (!command) return;
  const wrapped = /^(?:\/bin\/sh -c|\/bin\/zsh -fc) '([^'\r\n]*)'$/.exec(command);
  return wrapped?.[1] ?? command;
}

/** Handle an app-server -> client request. Resolves with the JSON-RPC result. */
export async function handleServerRequest(
  req: ServerRequest,
  ac: ApprovalContext,
): Promise<unknown> {
  switch (req.method) {
    case "item/commandExecution/requestApproval": {
      const p = req.params as typeof req.params & {
        additionalPermissions?: unknown;
        availableDecisions?: unknown;
      };
      const rawCommand = typeof p.command === "string" ? p.command : undefined;
      const canAccept =
        p.availableDecisions == null ||
        (Array.isArray(p.availableDecisions) && p.availableDecisions.includes("accept"));
      const command = p.commandActions?.length
        ? p.commandActions.map((a) => a.command).join(" && ")
        : (rawCommand ?? "");
      const assess = () =>
        commandRisk(
          [rawCommand ?? "", ...(p.commandActions ?? []).map((a) => a.command)],
          ac.risk,
          { cwd: p.cwd, stdin: p.kind === "writeStdin" },
        );
      const risk = assess();
      const policyContextAllows =
        (p.environmentId == null || p.environmentId === "local") &&
        (p.kind === undefined || p.kind === "command" || p.kind === "writeStdin") &&
        !p.reason?.includes("[codeden-card") &&
        !p.reason?.includes("A hook asked for approval") &&
        p.networkApprovalContext == null &&
        (p.proposedNetworkPolicyAmendments == null ||
          (Array.isArray(p.proposedNetworkPolicyAmendments) &&
            p.proposedNetworkPolicyAmendments.length === 0)) &&
        p.proposedExecpolicyAmendment == null &&
        p.additionalPermissions == null;
      const policyCanAccept =
        policyContextAllows && canAccept && (p.command == null || rawCommand !== undefined);
      const item: ApprovalItem = {
        id: `approval-${p.approvalId ?? p.itemId}`,
        kind: "approval_request",
        status: "in_progress",
        requestId: p.approvalId ?? p.itemId,
        action: p.networkApprovalContext ? "network" : "command",
        title: command ? `Run \`${shorten(command, 100)}\`` : "Run a command",
        ...(p.reason ? { reason: p.reason } : {}),
        ...(command ? { command } : {}),
        ...(p.cwd ? { cwd: p.cwd } : {}),
        toolName: "shell",
        toolCallItemId: p.itemId,
        options: ["allow_once", "deny"],
      };
      if (policyCanAccept && approvedByPolicy(ac, p, item, risk)) return { decision: "accept" };
      // The parsed actions are for display. Delegate only the exact command supplied
      // by a normal local execution request, without extra permission context.
      const exact = readCommand(rawCommand);
      const candidate =
        !risk.risky &&
        exact &&
        p.cwd &&
        (p.environmentId === null || p.environmentId === "local") &&
        p.approvalId == null &&
        (p.kind === undefined || p.kind === "command") &&
        !p.reason &&
        policyCanAccept &&
        (!p.commandActions?.length ||
          (p.commandActions.length === 1 && p.commandActions[0]?.command === exact))
          ? { ...item, command: exact, toolInput: { command: exact } }
          : undefined;
      const verified = () =>
        candidate ? guardedReadCommand(candidate, p.cwd ?? undefined, ac.risk.cwd) : undefined;
      const verifiedItem = candidate && verified() ? candidate : undefined;
      const standingItem: ApprovalItem | undefined = verifiedItem && {
        ...verifiedItem,
        options: ["allow_once", "allow_session", "deny"],
      };
      const grants = ac.sessionReadApprovals;
      const sessionKey = () => {
        if (
          !grants ||
          !standingItem ||
          !p.cwd ||
          !rawCommand ||
          ac.autonomy?.() === "read_only" ||
          sessionApprovalBlockReason(standingItem) ||
          !verified()
        )
          return;
        try {
          return JSON.stringify([realpathSync(p.cwd), rawCommand]);
        } catch {
          return;
        }
      };
      const offeredKey = sessionKey();
      if (offeredKey && standingItem && grants?.has(offeredKey)) {
        ac.broker.record(ac.ctx(p.threadId, p.turnId), {
          ...standingItem,
          status: "completed",
          decision: "allow_session",
          decidedBy: "policy",
        });
        return { decision: "accept" };
      }
      const response = await ac.broker.request(
        ac.ctx(p.threadId, p.turnId),
        (offeredKey ? standingItem : verifiedItem) ?? withRisk(item, risk),
        undefined,
        {
          canAutoApprove: (level) => policyCanAccept && levelAllows(level, assess()),
          ...(offeredKey ? { allowSession: true } : {}),
          normalize: (answer) =>
            answer.kind === "approval" &&
            answer.decision === "allow_session" &&
            (answer.decidedBy === undefined || answer.decidedBy === "user") &&
            (!offeredKey || sessionKey() !== offeredKey)
              ? { ...answer, decision: "allow_once" }
              : answer,
          problem: (answer) => {
            if (answer.kind !== "approval") return;
            if (
              (answer.decision === "allow_session" &&
                answer.decidedBy !== undefined &&
                answer.decidedBy !== "user") ||
              (answer.decidedBy === "orchestrator" && (!verifiedItem || !verified()))
            )
              return "This approval requires the owner.";
          },
        },
      );
      if (response.kind === "approval" && response.decision === "allow_session" && offeredKey) {
        grants?.add(offeredKey);
        return { decision: "accept" };
      }
      const map: Record<string, CommandExecutionApprovalDecision> = {
        allow_once: "accept",
        deny: "decline",
        cancel: "cancel",
      };
      // Codex attributes decline to the user and cancel interrupts the turn.
      // Fail only the command request when someone else refused it.
      if (
        response.kind === "approval" &&
        response.decision === "deny" &&
        response.decidedBy !== undefined &&
        response.decidedBy !== "user"
      ) {
        throw new CodexRpcError(-32000, `Command approval was refused by ${response.decidedBy}`);
      }
      return { decision: map[decisionOf(response)] ?? "cancel" };
    }
    case "item/fileChange/requestApproval": {
      const p = req.params;
      const paths = ac.filePaths(p.itemId) ?? [];
      const item: ApprovalItem = {
        id: `approval-${p.itemId}`,
        kind: "approval_request",
        status: "in_progress",
        requestId: p.itemId,
        action: p.grantRoot ? "outside_worktree" : "file_change",
        title:
          paths.length === 1
            ? `Edit ${paths[0]}`
            : paths.length
              ? `Edit ${paths.length} files`
              : "Apply a patch",
        ...(p.reason ? { reason: p.reason } : {}),
        ...(paths.length ? { paths } : {}),
        toolName: "apply_patch",
        toolCallItemId: p.itemId,
        options: ["allow_once", "allow_session", "deny"],
      };
      const risk = patchRisk(paths, p.grantRoot, ac.risk);
      if (approvedByPolicy(ac, p, item, risk)) return { decision: "accept" };
      const response = await ac.broker.request(ac.ctx(p.threadId, p.turnId), item, undefined, {
        canAutoApprove: (level) =>
          levelAllows(level, patchRisk(ac.filePaths(p.itemId) ?? [], p.grantRoot, ac.risk)),
      });
      const map: Record<string, FileChangeApprovalDecision> = {
        allow_once: "accept",
        allow_session: "acceptForSession",
        deny: "decline",
        cancel: "cancel",
      };
      return { decision: map[decisionOf(response)] ?? "cancel" };
    }
    case "item/permissions/requestApproval": {
      const p = req.params;
      const item: ApprovalItem = {
        id: `approval-${p.itemId}`,
        kind: "approval_request",
        status: "in_progress",
        requestId: p.itemId,
        action: p.permissions.network ? "network" : "outside_worktree",
        title: "Grant additional permissions",
        ...(p.reason ? { reason: p.reason } : {}),
        cwd: p.cwd,
        toolInput: JSON.parse(JSON.stringify(p.permissions)),
        options: ["allow_once", "allow_session", "deny"],
      };
      const granted = {
        ...(p.permissions.network ? { network: p.permissions.network } : {}),
        ...(p.permissions.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}),
      };
      // Granted for this turn only, so the next request is judged again.
      const risk = permissionsRisk(p.permissions, ac.risk);
      const response = await ac.broker.request(ac.ctx(p.threadId, p.turnId), withRisk(item, risk));
      const decision = decisionOf(response);
      if (decision === "allow_once" || decision === "allow_session") {
        return { permissions: granted, scope: decision === "allow_session" ? "session" : "turn" };
      }
      return { permissions: {}, scope: "turn" };
    }
    case "item/tool/requestUserInput": {
      const p = req.params;
      const questions: UserQuestion[] = p.questions.map((q) => ({
        id: q.id,
        header: q.header,
        question: q.question,
        options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
        multiSelect: false,
        allowFreeText: q.isOther || !q.options?.length,
      }));
      const response = await ac.broker.request(ac.ctx(p.threadId, p.turnId), {
        id: `question-${p.itemId}`,
        kind: "user_question",
        status: "in_progress",
        requestId: p.itemId,
        questions,
      });
      const answers: ToolRequestUserInputResponse["answers"] = {};
      if (response.kind === "answer") {
        for (const [id, values] of Object.entries(response.answers))
          answers[id] = { answers: values };
      }
      return { answers };
    }
    case "mcpServer/elicitation/request":
      return handleElicitation(req.params, ac);
    case "execCommandApproval":
    case "applyPatchApproval":
      // Legacy v1 approvals; v2 clients never receive them, but never leave the agent hanging.
      return { decision: { denied: { rejection: "Unsupported approval request" } } };
    default:
      throw new CodexRpcError(-32601, `CodeDen does not handle ${req.method}`);
  }
}
