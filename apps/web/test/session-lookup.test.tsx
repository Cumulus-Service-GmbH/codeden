import type { EventEnvelope, Session } from "@codeden/contracts";
import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockClient } from "@/lib/api/mock";
import { syncSessionQueries } from "@/lib/archived-sessions";
import { useSessionLookup } from "@/lib/queries";
import { renderWithClient } from "./utils";

/**
 * The snapshot carries only the recently archived sessions (#323): an older one opened from a
 * link, a search hit or a factory item is fetched by id, and live events keep that copy current.
 */

const ARCHIVED_AT = "2026-10-01T08:00:00.000Z";

function Probe({ id }: { id: string }) {
  const { session, loading } = useSessionLookup(id);
  return <p>{loading ? "loading" : session ? (session.title ?? session.purpose) : "missing"}</p>;
}

async function clientWithout(id: string) {
  const client = createMockClient();
  const snap = await client.getSnapshot();
  const target = snap.sessions.find((s) => s.id === id) as Session;
  vi.spyOn(client, "getSnapshot").mockResolvedValue({
    ...snap,
    sessions: snap.sessions.filter((s) => s.id !== id),
  });
  const archived = { ...target, title: "Old work", archivedAt: ARCHIVED_AT };
  const detail = vi.spyOn(client, "getSessionDetail").mockResolvedValue({
    session: archived,
    usage: null,
    followups: null,
    startMeta: null,
    queuedMessages: 0,
  });
  return { client, archived, detail };
}

describe("looking up a session (#323)", () => {
  it("fetches an archived session the snapshot doesn't carry, and follows live updates", async () => {
    const { client, archived, detail } = await clientWithout("s-deps");
    const { queryClient } = renderWithClient(<Probe id="s-deps" />, client);

    expect(await screen.findByText("Old work")).toBeTruthy();
    expect(detail).toHaveBeenCalledWith("s-deps");

    const env = {
      seq: 99_999,
      ts: new Date().toISOString(),
      sessionId: "s-deps",
      type: "session.updated",
      payload: { session: { ...archived, title: "Renamed while archived" } },
    } as EventEnvelope;
    act(() => syncSessionQueries(queryClient, env));
    expect(await screen.findByText("Renamed while archived")).toBeTruthy();
  });

  it("reads a session the snapshot carries without fetching it", async () => {
    const client = createMockClient();
    const detail = vi.spyOn(client, "getSessionDetail");
    const snap = await client.getSnapshot();
    const session = snap.sessions.find((s) => s.id === "s-deps") as Session;
    renderWithClient(<Probe id="s-deps" />, client);

    expect(await screen.findByText(session.title ?? session.purpose)).toBeTruthy();
    expect(detail).not.toHaveBeenCalled();
  });
});
