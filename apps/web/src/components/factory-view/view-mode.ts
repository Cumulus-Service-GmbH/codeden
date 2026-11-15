import { useState } from "react";
import { useRoomy } from "./hooks";

const MODE_KEY = "codeden.factoryView.mode";

/** How the Factory view shows the pipeline: the board, the 3D factory floor or the pixel scene. */
export type ViewModeId = "board" | "floor" | "pixel";

const MODES: readonly ViewModeId[] = ["board", "floor", "pixel"];

export interface ViewMode {
  /** Floor and Pixel are offered: tablets and up. On phones the view always shows the board. */
  available: boolean;
  /** What the view shows. */
  mode: ViewModeId;
  set: (mode: ViewModeId) => void;
}

/** The stored mode: `board`, `floor` or `pixel` (an older `pixel` keeps working); else board. */
export function storedViewMode(value: string | null): ViewModeId {
  return MODES.find((m) => m === value) ?? "board";
}

/**
 * The Factory view's mode (#209, #420): the board by default, remembered per browser. Floor and
 * Pixel are hidden below 640 px, where a scene leaves workers too small to tap.
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
