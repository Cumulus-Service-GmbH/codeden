import { act, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { create } from "zustand";
import { useChecklistOverlay } from "@/components/checklist/checklist-overlay";
import { ChecklistSidebar } from "@/components/checklist/checklist-sidebar";
import { useLayoutStore } from "@/stores/layout";
import { renderWithClient } from "./utils";

type Mode = "full" | "rail" | "none";
const useMode = create<{ mode: Mode }>()(() => ({ mode: "rail" }));
// The shell passes the mode the window width allows; a resize changes only that.
function Shell() {
  return createElement(ChecklistSidebar, { mode: useMode((s) => s.mode) });
}
const resize = (mode: Mode) => act(() => useMode.setState({ mode }));

describe("the pinned checklist's overlay on a narrow window", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      checklistOpen: true,
      checklistPinned: true,
      checklistCollapsed: false,
    });
    useChecklistOverlay.setState({ overlayOnly: false, sheet: false });
  });

  it("stays open while the window crosses between the rail and no rail", () => {
    useMode.setState({ mode: "rail" });
    renderWithClient(createElement(Shell));
    fireEvent.click(screen.getAllByRole("button", { name: "Expand checklist" })[0] as HTMLElement);
    expect(screen.getByTestId("checklist-sheet")).toBeTruthy();
    resize("none");
    expect(screen.getByTestId("checklist-sheet")).toBeTruthy();
    expect(useChecklistOverlay.getState()).toMatchObject({ overlayOnly: true, sheet: true });
    resize("rail");
    expect(screen.getByTestId("checklist-sheet")).toBeTruthy();
    expect(screen.getByTestId("checklist-rail")).toBeTruthy();
  });

  it("closes only when the owner closes it, or once the full column fits", () => {
    useMode.setState({ mode: "none" });
    renderWithClient(createElement(Shell));
    act(() => useChecklistOverlay.getState().setSheet(true));
    expect(screen.getByTestId("checklist-sheet")).toBeTruthy();
    resize("rail");
    // The first Escape closes the tooltip of the button the sheet focused, the second the sheet.
    for (const _ of [1, 2]) fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(useChecklistOverlay.getState().sheet).toBe(false);
    expect(screen.queryByTestId("checklist-sheet")).toBeNull();
    expect(screen.getByTestId("checklist-rail")).toBeTruthy();
    act(() => useChecklistOverlay.getState().setSheet(true));
    resize("full");
    expect(useChecklistOverlay.getState().sheet).toBe(false);
    expect(screen.getByTestId("checklist-sidebar")).toBeTruthy();
  });

  it("stays open when the owner pins the open sheet on a window too narrow for the rail", () => {
    useLayoutStore.setState({ checklistPinned: false });
    useMode.setState({ mode: "none" });
    renderWithClient(createElement(Shell));
    expect(screen.getByTestId("checklist-sheet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pin to the side" }));
    expect(useLayoutStore.getState().checklistPinned).toBe(true);
    expect(useChecklistOverlay.getState()).toMatchObject({ overlayOnly: true, sheet: true });
    expect(screen.getByTestId("checklist-sheet")).toBeTruthy();
  });

  it("keeps the overlay closed after pinning at full width and resizing to the rail", () => {
    useLayoutStore.setState({ checklistPinned: false });
    useMode.setState({ mode: "full" });
    renderWithClient(createElement(Shell));
    fireEvent.click(screen.getByRole("button", { name: "Pin to the side" }));
    expect(screen.getByTestId("checklist-sidebar")).toBeTruthy();
    resize("rail");
    expect(useChecklistOverlay.getState().sheet).toBe(false);
    expect(screen.queryByTestId("checklist-sheet")).toBeNull();
    expect(screen.getByTestId("checklist-rail")).toBeTruthy();
  });
});
