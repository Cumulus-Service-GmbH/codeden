/** Identifies builds that carry the fork's subscription and permissions guarantees. */
export const FORK_BUILD = true;

export const SUBSCRIPTION_ONLY = "This fork only allows subscriptions. API keys are disabled.";

const SUBSCRIPTION_LOGINS: Readonly<Record<string, string>> = {
  claude: "claude.ai",
  codex: "chatgpt",
  cursor: "cursor",
  gemini: "oauth-personal",
};

/** Require a recognized subscription login before an automatic provider switch. */
export function hasSubscriptionLogin(provider: string, method: string | null): boolean {
  return method !== null && SUBSCRIPTION_LOGINS[provider] === method.toLowerCase();
}

export function reportsApiKeyLogin(method: string | null | undefined): boolean {
  return /api[\s_-]?key|cursor_key|console|bedrock|vertex|environment/i.test(method ?? "");
}
