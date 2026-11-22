import type { Session } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { RoleSessions } from "../src/services/orchestration/role-sessions";
import type { ProjectService } from "../src/services/projects/project-service";
import type { SessionService } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";

describe("Start fresh at the session limit", () => {
  it("returns the replacement that waits for a free slot instead of failing", async () => {
    const database = openDatabase(":memory:");
    try {
      const store = new EventStore(database.db);
      const previous: Session = {
        ...sampleSession,
        id: "o1",
        role: "orchestrator",
        status: "idle",
      };
      const replacement: Session = { ...previous, id: "o2", status: "queued" };
      store.append([{ type: "session.created", sessionId: "o1", payload: { session: previous } }]);
      const start = vi.fn(async () => ({ status: "queued" as const, sessionId: "o2", behind: [] }));
      const detail = (id: string) => ({ session: id === "o1" ? previous : replacement });
      const roles = new RoleSessions({
        db: database.db,
        sessions: { start, detail } as unknown as SessionService,
        projects: {} as ProjectService,
      });
      await expect(roles.startFresh("o1")).resolves.toMatchObject({ id: "o2", status: "queued" });
      expect(start).toHaveBeenCalledWith(expect.anything(), { replacesRoleId: "o1" });
    } finally {
      database.close();
    }
  });
});
