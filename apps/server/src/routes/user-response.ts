import type { RuntimeResponse } from "@codeden/contracts";

/**
 * An answer from one of the user's own routes (`/api/sessions/:id/respond`, an inbox resolve):
 * its approval is the user's, whatever the body claims. Only these routes stamp it, so a
 * one-time user approval (Claude in Chrome) can tell the user from the PM, the factory or policy.
 */
export function asUserResponse(response: RuntimeResponse): RuntimeResponse {
  return response.kind === "approval" ? { ...response, decidedBy: "user" } : response;
}
