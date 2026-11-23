import {
  type DecisionCard,
  type ItemOf,
  type OwnerOnlyCategory,
  type PendingApproval,
  parseCardToken,
} from "@codeden/contracts";
import { isDelegablePlan } from "./decision-approvals";

type ToolContext = Pick<ItemOf<"approval_request">, "url" | "singleUse" | "hookAsk">;
type Entry = Pick<PendingApproval, "kind"> &
  Partial<
    Pick<
      PendingApproval,
      "action" | "command" | "hookReason" | "reason" | "toolInput" | "toolName" | "steps"
    >
  > &
  ToolContext & { requestedBy?: DecisionCard["requestedBy"] };
type Classification = { delegable: true } | { delegable: false; ownerOnly: OwnerOnlyCategory };

function ownerOnly(category: OwnerOnlyCategory = "unclassified"): Classification {
  return { delegable: false, ownerOnly: category };
}

function sensitiveText(text: string): OwnerOnlyCategory | undefined {
  if (/\b(?:dbops|sqlcmd|bcp|osql|invoke-sqlcmd|mssql-cli|sqlpackage)\b/i.test(text)) {
    return "prd_db";
  }
  if (/(?:keyvault|secret|credential|password|token|\.env\b|\bsecurity\s+find-)/i.test(text)) {
    return "secrets";
  }
  if (/\b(?:eas\s+submit|fastlane|altool|notarytool|testflight|play\s+console)\b/i.test(text)) {
    return "store_submission";
  }
  if (/\b(?:stripe|paypal|checkout|purchase|invoice|payment)\b/i.test(text)) {
    return "spending";
  }
  if (
    /\b(?:azd|azcmagent|terraform|pulumi|bicep)\b/i.test(text) ||
    /\baz\b[^\n;&|]*\b(?:create|azcmagent|deployment)\b/i.test(text)
  ) {
    return "new_azure_resource";
  }
  if (/\b(?:az|gh\s+release|npm\s+publish|deploy|kubectl|helm)\b/i.test(text)) {
    return "prd_write";
  }
  return undefined;
}

function ownerScope(scope: string): OwnerOnlyCategory | undefined {
  if (scope.startsWith("resource:") || scope === "az-connectedmachine-run-command-create") {
    return "new_azure_resource";
  }
  if (/^(?:prd-db-migration|db-migration|dbops-lan)$/.test(scope)) return "prd_db";
  if (/^(?:prd-|webchat-|job-|acr-build)/.test(scope) || scope === "dbops-migration-image") {
    return "prd_write";
  }
  if (scope === "secrets" || scope === "spending") return scope;
  if (scope === "store-submission") return "store_submission";
  return undefined;
}

function delegableScope(scope: string): boolean {
  return (
    /^(?:db-read|db-migration|dbops-lan|az-ssh-arc)$/.test(scope) ||
    /^az-connectedmachine-run-command-(?!create$)[a-z][a-z-]*$/.test(scope)
  );
}

export function classifyApproval(entry: Entry): Classification {
  if (entry.kind === "plan_card") {
    return isDelegablePlan(entry.requestedBy, entry.steps) ? { delegable: true } : ownerOnly();
  }
  if (
    entry.kind !== "tool_approval" ||
    entry.url !== undefined ||
    entry.singleUse ||
    entry.toolName?.toLowerCase().startsWith("mcp__claude-in-chrome") ||
    entry.reason?.includes("Claude in Chrome uses your browser")
  ) {
    return ownerOnly();
  }

  const token = parseCardToken(entry.hookReason);
  if (entry.action === "secrets") return ownerOnly("secrets");
  const cleanAction =
    entry.action === "file_change" ||
    entry.action === "outside_worktree" ||
    entry.action === "plan";
  // A recognized delegable guard token covers the exact command the guard classified.
  if (
    token?.cls === "delegable" &&
    delegableScope(token.scope) &&
    (cleanAction || entry.action === "command")
  ) {
    return { delegable: true };
  }

  const text = `${entry.command ?? ""}\n${JSON.stringify(entry.toolInput ?? null)}`;
  const category = (token?.cls === "owner-only" && ownerScope(token.scope)) || sensitiveText(text);
  if (category) return ownerOnly(category);
  if (
    !cleanAction ||
    entry.hookReason !== undefined ||
    entry.hookAsk ||
    text.includes("[codeden-card") ||
    entry.reason?.includes("[codeden-card") ||
    entry.reason?.includes("A hook asked for approval")
  ) {
    return ownerOnly();
  }
  return { delegable: true };
}
