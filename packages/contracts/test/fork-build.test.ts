import { FORK_BUILD, hasSubscriptionLogin, reportsApiKeyLogin } from "@codeden/contracts";
import { expect, it } from "vitest";

it("round-trips the fork build marker", () => {
  expect(JSON.parse(JSON.stringify({ forkBuild: FORK_BUILD }))).toEqual({ forkBuild: true });
});

it("requires an explicit subscription login for automatic switches", () => {
  expect(hasSubscriptionLogin("codex", "chatgpt")).toBe(true);
  expect(hasSubscriptionLogin("codex", "api-key")).toBe(false);
  expect(hasSubscriptionLogin("cursor", "cursor_key")).toBe(false);
  expect(hasSubscriptionLogin("opencode", "oauth")).toBe(false);
  expect(reportsApiKeyLogin("oauth, api key")).toBe(true);
});
