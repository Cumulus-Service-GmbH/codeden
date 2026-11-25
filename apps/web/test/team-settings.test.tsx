import type { Snapshot } from "@codeden/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { TeamSettings } from "@/components/settings/team-settings";
import { createMockClient } from "@/lib/api/mock";
import { snapshotKey } from "@/lib/queries";
import { startRealtime } from "@/lib/realtime";
import { renderWithClient } from "./utils";

it("keeps focus and save feedback when the saved Default Team arrives", async () => {
  const client = createMockClient();
  const { queryClient } = renderWithClient(<TeamSettings />, client);
  const stop = startRealtime(client, queryClient);
  try {
    const summary = await screen.findByLabelText<HTMLInputElement>(
      "Result summaries for the project manager",
    );
    act(() => summary.focus());
    fireEvent.change(summary, { target: { value: "1024" } });
    fireEvent.click(screen.getByRole("button", { name: "Save setup" }));

    await waitFor(() => {
      expect(
        queryClient.getQueryData<Snapshot>(snapshotKey)?.settings.teamSetup.resultSummaryBytes,
      ).toBe(1024);
    });
    expect(await screen.findByText("Saved", { selector: '[role="status"]' })).toBeTruthy();
    expect(screen.getByLabelText("Result summaries for the project manager")).toBe(summary);
    expect(document.activeElement).toBe(summary);
  } finally {
    stop();
  }
});

it("retains an unsaved summary limit when another Default Team setting changes", async () => {
  const client = createMockClient();
  const { queryClient } = renderWithClient(<TeamSettings />, client);
  const stop = startRealtime(client, queryClient);
  try {
    const summary = await screen.findByLabelText<HTMLInputElement>(
      "Result summaries for the project manager",
    );
    act(() => summary.focus());
    fireEvent.change(summary, { target: { value: "2048" } });
    act(() => summary.blur());
    const remembered = !(await client.getSnapshot()).settings.teamSetup.remembered;
    await act(() => client.updateSettings({ teamSetup: { remembered } }));

    await waitFor(() => {
      expect(queryClient.getQueryData<Snapshot>(snapshotKey)?.settings.teamSetup.remembered).toBe(
        remembered,
      );
    });
    expect(summary.value).toBe("2048");
    fireEvent.click(screen.getByRole("button", { name: "Save setup" }));
    await waitFor(() => {
      expect(
        queryClient.getQueryData<Snapshot>(snapshotKey)?.settings.teamSetup.resultSummaryBytes,
      ).toBe(2048);
    });

    await act(() => client.updateSettings({ teamSetup: { resultSummaryBytes: 4096 } }));
    await waitFor(() => expect(summary.value).toBe("4096"));
  } finally {
    stop();
  }
});
