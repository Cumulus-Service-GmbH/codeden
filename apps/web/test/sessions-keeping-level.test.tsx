import type { Session, Snapshot } from "@codeden/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SessionsKeepingLevel } from "@/components/project/sessions-keeping-level";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { snapshotKey, useSnapshotData } from "@/lib/queries";
import { renderWithClient } from "./utils";

const projectId = "p-storefront";
const session = makeSession({
  id: "s-raise",
  role: "agent",
  status: "idle",
  provider: "fake",
  purpose: "Raise me",
  workKey: "request:raise-me",
  projectId,
  autonomy: "supervised",
});

function Settings() {
  const level = useSnapshotData(
    (s) => s.projects.find((p) => p.id === projectId)?.autonomy ?? s.settings.autonomy.default,
    "full",
  );
  return <SessionsKeepingLevel projectId={projectId} level={level} />;
}

async function setup(autonomy: "full" | "supervised" = "full", from = session) {
  const client = createMockClient();
  const initial = await client.getSnapshot();
  const snapshot: Snapshot = {
    ...initial,
    projects: initial.projects.map((p) => (p.id === projectId ? { ...p, autonomy } : p)),
    sessions: [from],
  };
  vi.spyOn(client, "getSnapshot").mockResolvedValue(snapshot);
  const updateSession = vi.spyOn(client, "updateSession").mockResolvedValue(session);
  const { queryClient } = renderWithClient(<Settings />, client, { withRouter: true });
  const start = await screen.findByTestId("apply-level");
  return {
    start,
    updateSession,
    updateSnapshot: (update: (s: Snapshot) => Snapshot) =>
      queryClient.setQueryData(snapshotKey, update(snapshot)),
  };
}

const sessionWith = (change: Partial<Session>) => (snapshot: Snapshot) => ({
  ...snapshot,
  sessions: [{ ...session, ...change }],
});

it.each([
  {
    change: "project level",
    update: (s: Snapshot): Snapshot => ({
      ...s,
      projects: s.projects.map((p) => (p.id === projectId ? { ...p, autonomy: "auto" } : p)),
    }),
  },
  { change: "session level", update: sessionWith({ autonomy: "read_only" }) },
  { change: "eligible sessions", update: sessionWith({ status: "completed" }) },
])("rejects an open confirmation after the $change changes", async ({ update }) => {
  const { start, updateSession, updateSnapshot } = await setup();
  fireEvent.click(start);
  const apply = await screen.findByRole("button", { name: "Apply to 1 session" });
  await act(async () => {
    updateSnapshot(update);
    fireEvent.click(apply);
  });
  expect(updateSession).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("accepts the same proposal after an unrelated session update", async () => {
  const { start, updateSession, updateSnapshot } = await setup();
  fireEvent.click(start);
  const apply = await screen.findByRole("button", { name: "Apply to 1 session" });
  await act(async () => {
    updateSnapshot(sessionWith({ progress: { text: "Still working", at: session.updatedAt } }));
    fireEvent.click(apply);
  });
  await waitFor(() =>
    expect(updateSession).toHaveBeenCalledExactlyOnceWith(session.id, {
      autonomy: "full",
    }),
  );
});

it("rejects a lowering proposal that became a raise before the click", async () => {
  const { start, updateSession, updateSnapshot } = await setup("supervised", {
    ...session,
    autonomy: "full",
  });
  await act(async () => {
    updateSnapshot(sessionWith({ autonomy: "read_only" }));
    fireEvent.click(start);
  });
  expect(updateSession).not.toHaveBeenCalled();

  await waitFor(() =>
    expect(screen.getByTestId("sessions-keeping-level").textContent).toContain("(Read-only)"),
  );
  fireEvent.click(start);
  const apply = await screen.findByRole("button", { name: "Apply to 1 session" });
  fireEvent.click(apply);
  await waitFor(() =>
    expect(updateSession).toHaveBeenCalledExactlyOnceWith(session.id, {
      autonomy: "supervised",
    }),
  );
});
