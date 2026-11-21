import type { EventEnvelope, Session, Snapshot } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { MockWorld } from "@/lib/api/mock/world";
import { applyDomainEvent } from "@/lib/snapshot-reducer";

const ARCHIVED_AT = "2026-11-08T08:00:00.000Z";

function event(snap: Snapshot, session: Session, type = "session.updated"): EventEnvelope {
  return {
    seq: snap.seq + 1,
    ts: new Date().toISOString(),
    sessionId: session.id,
    type,
    payload: { session },
  } as EventEnvelope;
}

/** The mock snapshot, and an active agent session of a project in it. */
function setup() {
  const snap = new MockWorld().snapshot;
  const live = snap.sessions.find((s) => s.role === "agent" && s.projectId && !s.archivedAt);
  if (!live?.projectId) throw new Error("fixture has no active agent session");
  return { snap, live, projectId: live.projectId };
}

describe("applyDomainEvent: sessions (#323)", () => {
  it("keeps a session it just archived and counts it", () => {
    const { snap, live, projectId } = setup();
    const before = snap.archivedSessionCounts[projectId] ?? 0;

    const next = applyDomainEvent(snap, event(snap, { ...live, archivedAt: ARCHIVED_AT }));

    expect(next.sessions.find((s) => s.id === live.id)?.archivedAt).toBe(ARCHIVED_AT);
    expect(next.archivedSessionCounts[projectId]).toBe(before + 1);
    // Unarchiving it again takes it off the count.
    const back = applyDomainEvent(next, event(next, { ...live, archivedAt: null }));
    expect(back.archivedSessionCounts[projectId] ?? 0).toBe(before);
  });

  it("leaves out updates to an older archived session it doesn't carry", () => {
    const { snap, live, projectId } = setup();
    const without = {
      ...snap,
      sessions: snap.sessions.filter((s) => s.id !== live.id),
      archivedSessionCounts: { ...snap.archivedSessionCounts, [projectId]: 7 },
    };
    const archived = { ...live, archivedAt: ARCHIVED_AT, title: "Still archived" };

    const next = applyDomainEvent(without, event(without, archived));

    expect(next.seq).toBe(without.seq + 1);
    // Nothing changed, so nothing was copied either.
    expect(next.sessions).toBe(without.sessions);
    expect(next.archivedSessionCounts).toBe(without.archivedSessionCounts);
  });

  it("brings an older archived session back when it is unarchived", () => {
    const { snap, live, projectId } = setup();
    const without = {
      ...snap,
      sessions: snap.sessions.filter((s) => s.id !== live.id),
      archivedSessionCounts: { ...snap.archivedSessionCounts, [projectId]: 1 },
    };

    const next = applyDomainEvent(without, event(without, { ...live, archivedAt: null }));

    expect(next.sessions.at(-1)?.id).toBe(live.id);
    expect(next.archivedSessionCounts[projectId]).toBeUndefined();
  });

  it("adds and counts new sessions, archived or not", () => {
    const { snap, live, projectId } = setup();
    const before = snap.archivedSessionCounts[projectId] ?? 0;
    const fresh = { ...live, id: "s-new" };
    const created = applyDomainEvent(snap, event(snap, fresh, "session.created"));
    expect(created.sessions.at(-1)?.id).toBe("s-new");
    expect(created.archivedSessionCounts[projectId] ?? 0).toBe(before);

    const imported = { ...live, id: "s-imported", archivedAt: ARCHIVED_AT };
    const next = applyDomainEvent(created, event(created, imported, "session.created"));
    expect(next.sessions.at(-1)?.id).toBe("s-imported");
    expect(next.archivedSessionCounts[projectId]).toBe(before + 1);
  });

  it.each(["pm", "orchestrator"] as const)(
    "moves the current %s ref and keeps its archive",
    (role) => {
      const { snap, live, projectId } = setup();
      const old = { ...live, id: "s-old-role", role, projectId: role === "pm" ? projectId : null };
      const fresh = { ...old, id: "s-new-role" };
      const created = applyDomainEvent(snap, event(snap, old, "session.created"));
      const archived = applyDomainEvent(
        created,
        event(created, { ...old, archivedAt: ARCHIVED_AT }),
      );
      const rotated = applyDomainEvent(archived, event(archived, fresh, "session.created"));

      expect(rotated.sessions.find((s) => s.id === old.id)?.archivedAt).toBe(ARCHIVED_AT);
      expect(rotated.archivedSessionCounts[projectId] ?? 0).toBe(
        (snap.archivedSessionCounts[projectId] ?? 0) + (role === "pm" ? 1 : 0),
      );
      expect(
        role === "pm" ? rotated.roleSessions?.pms[projectId] : rotated.roleSessions?.orchestrator,
      ).toBe(fresh.id);
    },
  );
});
