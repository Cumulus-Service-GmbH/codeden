import { describe, expect, it } from "vitest";
import { storedViewMode } from "@/components/factory-view/view-mode";

/** Issue #420: the Factory view remembers Board, Floor or Pixel; an older stored `pixel` still works. */
describe("the Factory view's stored mode", () => {
  it("reads board, floor and pixel, and anything else as the board", () => {
    expect(storedViewMode("board")).toBe("board");
    expect(storedViewMode("floor")).toBe("floor");
    expect(storedViewMode("pixel")).toBe("pixel");
    expect(storedViewMode(null)).toBe("board");
    expect(storedViewMode("3d")).toBe("board");
  });
});
