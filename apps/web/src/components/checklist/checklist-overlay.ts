import { create } from "zustand";

/**
 * A pinned checklist on a narrow window shows as its rail, or on one too narrow for even the
 * rail renders nothing inline; the rail's expand, or then the toggle, opens it as an overlay.
 * `overlayOnly` says the shell is in the no-rail state, `sheet` whether the overlay is showing.
 * Both narrow states share `sheet`, so an open overlay stays open while the window crosses
 * between them. Not persisted: it follows the window.
 */
interface ChecklistOverlayState {
  overlayOnly: boolean;
  sheet: boolean;
  /** `narrow` is true in either narrow state; leaving them drops the overlay. */
  setNarrow: (narrow: boolean, overlayOnly: boolean) => void;
  setSheet: (sheet: boolean) => void;
}

export const useChecklistOverlay = create<ChecklistOverlayState>()((set) => ({
  overlayOnly: false,
  sheet: false,
  setNarrow: (narrow, overlayOnly) => set(narrow ? { overlayOnly } : { overlayOnly, sheet: false }),
  setSheet: (sheet) => set({ sheet }),
}));
