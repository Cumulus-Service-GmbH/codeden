import type { ProjectChecklist } from "@codeden/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChecklistSidebar } from "@/components/checklist/checklist-sidebar";
import { ChecklistToggle } from "@/components/checklist/checklist-toggle";
import { createMockClient } from "@/lib/api/mock";
import { startRealtime } from "@/lib/realtime";
import { useLayoutStore } from "@/stores/layout";
import { sampleProject } from "../../../packages/contracts/test/fixtures";
import { snapshot } from "./attention-fixtures";
import { renderWithClient } from "./utils";

it("updates the open checklist and aggregate badge for all checklist event sources", async () => {
  const at = "2026-11-22T10:00:00.000Z";
  const updatedAt = "2026-11-22T10:01:00.000Z";
  const item = { id: "linked", text: "Work", status: "todo", updatedAt: at } as const;
  const checklist: ProjectChecklist = {
    projectId: sampleProject.id,
    items: [item],
    changes: [],
    updatedAt: at,
  };
  const codeDen = { ...sampleProject, name: "CodeDen" };
  const other = { ...sampleProject, id: "other", name: "Other project" };
  const initial = {
    ...snapshot(1, []),
    projects: [codeDen, other],
    checklists: [
      checklist,
      {
        ...checklist,
        projectId: other.id,
        items: [{ ...item, text: "Other work", status: "done" as const }],
      },
    ],
  };
  const client = createMockClient();
  const getSnapshot = vi.spyOn(client, "getSnapshot").mockResolvedValue(initial);
  const subscribe = vi.spyOn(client, "subscribe").mockImplementation(() => () => {});
  const { checklistOpen, checklistPinned, checklistCollapsed } = useLayoutStore.getState();
  useLayoutStore.setState({
    checklistOpen: true,
    checklistPinned: true,
    checklistCollapsed: false,
  });

  const { queryClient, unmount } = renderWithClient(
    <>
      <ChecklistToggle />
      <ChecklistSidebar />
    </>,
    client,
  );
  const stop = startRealtime(client, queryClient);
  try {
    const sidebar = within(screen.getByTestId("checklist-sidebar"));
    expect(await sidebar.findByRole("img", { name: "not started" })).toBeTruthy();
    await waitFor(() => expect(subscribe).toHaveBeenCalledWith(initial.seq, expect.any(Function)));
    expect(getSnapshot).toHaveBeenCalledOnce();
    const push = subscribe.mock.calls[0]?.[1];
    if (!push) throw new Error("Expected a live subscription");

    const badge = within(screen.getByTestId("checklist-toggle"));
    expect(badge.getByText("All projects 50%")).toBeTruthy();
    fireEvent.focus(screen.getByTestId("checklist-toggle"));
    const tooltip = within(await screen.findByRole("tooltip"));
    expect(tooltip.getByText("CodeDen 0/1")).toBeTruthy();
    expect(tooltip.getByText("Other project 1/1")).toBeTruthy();

    const updates = [
      { source: "orchestrator", status: "done", label: "done", percent: 100 },
      { source: "PM", status: "doing", label: "in progress", percent: 50 },
      { source: "auto-link", status: "done", label: "done", percent: 100 },
      { source: "owner", status: "todo", label: "not started", percent: 50 },
    ] as const;
    for (const [index, { source, status, label, percent }] of updates.entries()) {
      act(() => {
        push({
          type: "events",
          events: [
            {
              seq: initial.seq + 1 + index,
              sessionId: null,
              ts: updatedAt,
              type: "checklist.updated",
              payload: {
                checklist: {
                  ...checklist,
                  items: [{ ...item, text: `Updated by ${source}`, status, updatedAt }],
                  updatedAt,
                },
              },
            },
          ],
        });
      });
      const row = (await sidebar.findByText(`Updated by ${source}`)).closest("li");
      if (!row) throw new Error("Expected a checklist row");
      expect(within(row).getByRole("img", { name: label })).toBeTruthy();
      expect(badge.getByText(`All projects ${percent}%`)).toBeTruthy();
      expect(tooltip.getByText(`CodeDen ${status === "done" ? 1 : 0}/1`)).toBeTruthy();
    }
    expect(getSnapshot).toHaveBeenCalledOnce();
  } finally {
    stop();
    unmount();
    useLayoutStore.setState({ checklistOpen, checklistPinned, checklistCollapsed });
  }
});

it("refreshes the checklist and badge from the snapshot when Refresh is clicked", async () => {
  const at = "2026-11-22T10:00:00.000Z";
  const item = { id: "linked", text: "Work", status: "todo", updatedAt: at } as const;
  const checklist = { projectId: sampleProject.id, items: [item], changes: [], updatedAt: at };
  const initial = { ...snapshot(1, []), projects: [sampleProject], checklists: [checklist] };
  const client = createMockClient();
  const getSnapshot = vi
    .spyOn(client, "getSnapshot")
    .mockResolvedValueOnce(initial)
    .mockResolvedValue({
      ...initial,
      seq: 2,
      checklists: [{ ...checklist, items: [{ ...item, status: "done" }] }],
    });
  const { checklistOpen, checklistPinned, checklistCollapsed } = useLayoutStore.getState();
  useLayoutStore.setState({
    checklistOpen: true,
    checklistPinned: true,
    checklistCollapsed: false,
  });
  const { unmount } = renderWithClient(
    <>
      <ChecklistToggle />
      <ChecklistSidebar />
    </>,
    client,
  );
  try {
    expect(await screen.findByText("All projects 0%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("All projects 100%")).toBeTruthy();
    expect(screen.getByRole("img", { name: "done" })).toBeTruthy();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  } finally {
    unmount();
    useLayoutStore.setState({ checklistOpen, checklistPinned, checklistCollapsed });
  }
});
