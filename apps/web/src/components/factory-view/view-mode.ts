import { useState } from "react";
import { useRoomy } from "./hooks";

const MODE_KEY = "codeden.factoryView.mode";

/** How the Factory view shows the pipeline: the board, or the 3D factory floor. */
export type ViewModeId = "board" | "floor";

export interface ViewMode {
  /** Floor is offered: tablets and up. On phones the view always shows the board. */
  available: boolean;
  /** What the view shows. */
  mode: ViewModeId;
  set: (mode: ViewModeId) => void;
}

/**
 * The stored mode: `board` or `floor`. The retired pixel mode (`pixel`) opens Floor, which
 * replaced it; anything else, or nothing, is the board.
 */
export function storedViewMode(value: string | null): ViewModeId {
  if (value === "floor" || value === "pixel") return "floor";
  return "board";
}

/**
 * The Factory view's mode (#209, #420, #476): the board by default, remembered per browser.
 * Floor is hidden below 640 px, where a scene leaves workers too small to tap.
 */
export function useViewMode(): ViewMode {
  const available = useRoomy();
  const [mode, setMode] = useState(() => storedViewMode(localStorage.getItem(MODE_KEY)));
  return {
    available,
    mode: available ? mode : "board",
    set: (next) => {
      localStorage.setItem(MODE_KEY, next);
      setMode(next);
    },
  };
}
