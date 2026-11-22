import type { Session } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { McpTokenStore } from "../src/mcp/tokens";
import { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";

describe("MCP tokens of an archived conversation", () => {
  it("are refused for a role even when revoking them failed, and kept for an agent", () => {
    const database = openDatabase(":memory:");
    try {
      const store = new EventStore(database.db);
      const repo = new SessionRepo(database.db, store);
      const tokens = new McpTokenStore(database.db);
      const pm: Session = { ...sampleSession, id: "pm1", role: "pm", projectId: "p1" };
      const agent: Session = { ...sampleSession, id: "a1" };
      for (const session of [pm, agent]) {
        store.append([{ type: "session.created", sessionId: session.id, payload: { session } }]);
      }
      const pmToken = tokens.mint({ role: "pm", sessionId: "pm1", projectId: "p1" });
      const agentToken = tokens.mint({ role: "agent", sessionId: "a1", projectId: null });
      expect(tokens.verify(pmToken)).toMatchObject({ role: "pm", sessionId: "pm1" });

      // Archived without revoking (as when the revocation failed): no token is revoked here.
      const now = new Date().toISOString();
      for (const id of ["pm1", "a1"]) repo.update(id, (s) => ({ ...s, archivedAt: now }));

      expect(tokens.verify(pmToken)).toBeUndefined();
      expect(tokens.verify(agentToken)).toMatchObject({ role: "agent", sessionId: "a1" });
    } finally {
      database.close();
    }
  });
});
