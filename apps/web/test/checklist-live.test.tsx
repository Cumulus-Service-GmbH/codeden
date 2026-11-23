import type { ProjectChecklist } from "@codeden/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChecklistSidebar } from "@/components/checklist/checklist-sidebar";
import { createMockClient } from "@/lib/api/mock";
import { startRealtime } from "@/lib/realtime";
import { useLayoutStore } from "@/stores/layout";
import { sampleProject } from "../../../packages/contracts/test/fixtures";
import { snapshot } from "./attention-fixtures";
import { renderWithClient } from "./utils";

it("renders the live checklist item status without refetching the snapshot", async () => {
  const at = "2026-11-22T10:00:00.000Z";
  const updatedAt = "2026-11-22T10:01:00.000Z";
  const item = { id: "linked", text: "Work", status: "todo", updatedAt: at } as const;
  const checklist: ProjectChecklist = {
    projectId: sampleProject.id,
    items: [item],
    changes: [],
    updatedAt: at,
  };
  const initial = { ...snapshot(1, []), projects: [sampleProject], checklists: [checklist] };
  const client = createMockClient();
  const getSnapshot = vi.spyOn(client, "getSnapshot").mockResolvedValue(initial);
  const subscribe = vi.spyOn(client, "subscribe").mockImplementation(() => () => {});
  const { checklistOpen, checklistPinned, checklistCollapsed } = useLayoutStore.getState();
  useLayoutStore.setState({
    checklistOpen: true,
    checklistPinned: true,
    checklistCollapsed: false,
  });

  const { queryClient, unmount } = renderWithClient(<ChecklistSidebar />, client);
  const stop = startRealtime(client, queryClient);
  try {
    const sidebar = within(screen.getByTestId("checklist-sidebar"));
    expect(await sidebar.findByRole("img", { name: "not started" })).toBeTruthy();
    await waitFor(() => expect(subscribe).toHaveBeenCalledWith(initial.seq, expect.any(Function)));
    expect(getSnapshot).toHaveBeenCalledOnce();
    const push = subscribe.mock.calls[0]?.[1];
    if (!push) throw new Error("Expected a live subscription");

    act(() => {
      push({
        type: "events",
        events: [
          {
            seq: initial.seq + 1,
            sessionId: null,
            ts: updatedAt,
            type: "checklist.updated",
            payload: {
              checklist: {
                ...checklist,
                items: [{ ...item, status: "doing", updatedAt }],
                updatedAt,
              },
            },
          },
        ],
      });
    });

    expect(await sidebar.findByRole("img", { name: "in progress" })).toBeTruthy();
    expect(sidebar.queryByRole("img", { name: "not started" })).toBeNull();
    expect(getSnapshot).toHaveBeenCalledOnce();
  } finally {
    stop();
    unmount();
    useLayoutStore.setState({ checklistOpen, checklistPinned, checklistCollapsed });
  }
});
