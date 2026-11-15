import type { CameraRig } from "./camera";

/**
 * Floor mode's pointer input (#420): drag to pan, the wheel or a two-finger pinch to zoom around
 * the pointer, a double-click to fit the hall again. Returns the function that unbinds it.
 */
export function bindInput(
  canvas: HTMLCanvasElement,
  rig: CameraRig,
  moved: () => void,
  fit: () => void,
): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; x: number; y: number } | null = null;

  const centreOffset = (clientX: number, clientY: number) => {
    const r = canvas.getBoundingClientRect();
    return { ox: clientX - r.left - r.width / 2, oy: clientY - r.top - r.height / 2 };
  };
  const twoFinger = () => {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return null;
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch = pointers.size === 2 ? twoFinger() : null;
    canvas.style.cursor = "grabbing";
  };
  const move = (e: PointerEvent) => {
    const was = pointers.get(e.pointerId);
    if (!was) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      rig.pan(e.clientX - was.x, e.clientY - was.y);
      moved();
      return;
    }
    const now = twoFinger();
    if (!now || !pinch) return;
    const { ox, oy } = centreOffset(now.x, now.y);
    rig.pan(now.x - pinch.x, now.y - pinch.y);
    if (pinch.distance > 0) rig.zoomAt(now.distance / pinch.distance, ox, oy);
    pinch = now;
    moved();
  };
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinch = pointers.size === 2 ? twoFinger() : null;
    if (pointers.size === 0) canvas.style.cursor = "grab";
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    // A trackpad pinch arrives as a wheel with Ctrl held, in smaller steps.
    const factor = Math.exp(-e.deltaY * lines * (e.ctrlKey ? 0.01 : 0.0015));
    const { ox, oy } = centreOffset(e.clientX, e.clientY);
    rig.zoomAt(factor, ox, oy);
    moved();
  };
  const double = (e: MouseEvent) => {
    e.preventDefault();
    fit();
  };

  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("dblclick", double);
  return () => {
    canvas.removeEventListener("pointerdown", down);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", up);
    canvas.removeEventListener("wheel", wheel);
    canvas.removeEventListener("dblclick", double);
  };
}
