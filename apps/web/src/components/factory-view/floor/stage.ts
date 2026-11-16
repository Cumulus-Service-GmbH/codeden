import {
  BoxGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  PCFShadowMap,
  Scene as ThreeScene,
  Vector3,
  WebGLRenderer,
} from "three";
import { floorSeats, WALL_H, type WorkshopLayout } from "../scene/layout";
import type { Scene } from "../scene/scene-model";
import { sceneEvents } from "../scene/transitions";
import { CameraRig } from "./camera";
import { Crew } from "./crew";
import { HEAD_Y } from "./crew-geometry";
import type { FigureStatus } from "./figure-look";
import type { FigureFrame } from "./frames";
import { bindInput } from "./input";
import { clear, colour, Kit } from "./kit";
import { FloorMotion } from "./motion";
import type { FloorPalette } from "./palette";
import { BAY_CRATE, bayCrateSpots, buildProps, occupiedSeats, propsKey } from "./props";
import { pickBox, pickFigure, rayAt, type ScreenPoint, screenAnchor } from "./screen";
import { seatFrames } from "./seat-frames";
import { buildWorkshop } from "./workshop";

/**
 * Floor mode's stage (#420, #476): one WebGL renderer, the hall, the crew and the live props, lit
 * by a hemisphere light and a sun from the upper left front with soft shadows. It draws
 * continuously only while something animates: at most 30 frames a second for the crew's idle
 * loops, every display frame while the camera moves, and on demand once nothing does (reduced
 * motion, a stopped factory, an empty floor). Never while the tab is hidden or the canvas is off
 * screen. The pixel ratio is capped at 2. Throws when WebGL can't start; calls `onLost` when the
 * context is lost and doesn't come back.
 */

export interface StageContent {
  layout: WorkshopLayout;
  scene: Scene;
  palette: FloorPalette;
}

/** A figure (or a repair bay crate, `bay:<kind>`) on screen this frame, for the DOM layer. */
export interface ScreenFigure {
  key: string;
  /** The figure's status; null for a crate. */
  status: FigureStatus | null;
  /** Its feet, and the top of its head. */
  foot: ScreenPoint;
  head: ScreenPoint;
}

export interface StageEvents {
  /** WebGL's context was lost and didn't come back. */
  onLost: () => void;
  /** The pointer is over this figure now (null: none), at this canvas point. */
  onHover: (key: string | null, at: { x: number; y: number } | null) => void;
  /** A tap or click on a figure, or on the empty floor (null). */
  onTap: (key: string | null) => void;
  /** After each frame: where every figure is on screen, and the zoom in pixels per unit. */
  onFrame: (figures: readonly ScreenFigure[], pxPerUnit: number) => void;
}

const MAX_DPR = 2;
const SHADOW_MAP = 1024;
/** How long a lost context may take to come back before the view gives up on it. */
const RESTORE_MS = 3000;
/** Toward the sun: from the upper left front, as the camera sees the hall. */
const SUN = new Vector3(-0.2, 1.5, 1).normalize();
/** Idle loops draw at most this often. */
export const IDLE_FPS = 30;
/** The hall's lights while the factory is stopped. */
const STOPPED_LIGHT = 0.4;

export class FloorStage {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new ThreeScene();
  private readonly rig = new CameraRig();
  private readonly hemi = new HemisphereLight(0xffffff, 0xffffff, 1);
  private readonly sun = new DirectionalLight(0xffffff, 1);
  private readonly hall = new Group();
  private readonly props = new Group();
  private readonly crew = new Crew();
  private hallKit = new Kit();
  private propsKit = new Kit();
  private readonly shared = new Kit();
  private readonly unit = this.shared.own(new BoxGeometry(1, 1, 1));
  private keys = { hall: "", bounds: "", props: "" };
  private content: StageContent | null = null;
  private frames: FigureFrame[] = [];
  private readonly motion = new FloorMotion();
  private prevScene: Scene | null = null;
  /** Crates on their way out when the props were last built. */
  private shipping = 0;
  private selected: string | null = null;
  private reducedMotion = false;
  private coarse = false;
  private raf = 0;
  private timer = 0;
  private last = 0;
  private lastDrawn = 0;
  private dirty = true;
  private onScreen = true;
  private lostTimer = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly unbind: () => void;
  private readonly resize: ResizeObserver;
  private readonly intersect: IntersectionObserver | null;
  private viewport = { width: 1, height: 1 };
  /** Frames drawn, for the dev stats overlay. */
  drawn = 0;

  /**
   * Draws into a canvas of its own inside `host` (decorative: hidden from assistive tech), so
   * handing its context back on dispose never touches the next stage's.
   */
  constructor(
    private readonly host: HTMLElement,
    private readonly events: StageEvents,
  ) {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.className = "absolute inset-0 block size-full touch-none select-none";
    canvas.dataset.testid = "factory-view-floor-canvas";
    this.canvas = canvas;
    try {
      this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (e) {
      throw e instanceof Error ? e : new Error("WebGL is not available");
    }
    host.prepend(canvas);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    // Soft: PCF with a blur radius (three folded its soft variant into this one).
    this.renderer.shadowMap.type = PCFShadowMap;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sun.shadow.radius = 4;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.hall, this.props, this.crew.group);

    canvas.addEventListener("webglcontextlost", this.lost);
    canvas.addEventListener("webglcontextrestored", this.restored);
    document.addEventListener("visibilitychange", this.visibility);
    this.unbind = bindInput(canvas, this.rig, {
      moved: this.invalidate,
      fit: () => this.fit(true),
      hover: (at) => this.events.onHover(at ? this.pick(at.x, at.y) : null, at),
      tap: (at) => this.events.onTap(this.pick(at.x, at.y)),
    });
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(host);
    this.intersect =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            this.onScreen = entries.some((e) => e.isIntersecting);
            this.schedule();
          });
    this.intersect?.observe(canvas);
    this.measure();
  }

  set reduced(on: boolean) {
    this.reducedMotion = on;
    this.rig.reduced = on;
    this.invalidate();
  }

  /** Touch screens: bigger pick boxes. */
  set coarsePointer(on: boolean) {
    this.coarse = on;
  }

  /** Keeps the fit clear of `px` CSS pixels on the left (the open roster), and refits. */
  setInset(px: number): void {
    if (this.rig.insetPx === px) return;
    this.rig.insetPx = px;
    if (this.keys.bounds) this.fit(true);
  }

  /** Shows `content`, rebuilding only what changed. */
  update(content: StageContent): void {
    const { layout, scene, palette } = content;
    this.content = content;
    const hallKey = JSON.stringify([
      layout.bounds,
      layout.zones,
      floorSeats(layout).length,
      palette,
    ]);
    if (hallKey !== this.keys.hall) {
      this.keys.hall = hallKey;
      clear(this.hall, this.hallKit);
      this.hallKit = new Kit();
      this.hall.add(buildWorkshop(layout, palette, this.hallKit));
      this.crew.setPalette(palette);
      const bounds = JSON.stringify(layout.bounds);
      if (bounds !== this.keys.bounds) {
        // The first layout jumps into view; growing eases out to the new fit.
        const grew = this.keys.bounds !== "";
        this.keys.bounds = bounds;
        this.rig.setScene(layout.bounds, WALL_H);
        this.rig.fit(grew);
      }
    }
    this.light(layout, palette, scene.stopped);

    // The moments between the last scene and this one: none on the first, none with reduced
    // motion or while the factory is stopped (everyone stands still at their post).
    const t = this.clock();
    if (this.reducedMotion || scene.stopped) this.motion.reset();
    else this.motion.play(scene, layout, sceneEvents(this.prevScene, scene), t);
    this.prevScene = scene;
    this.rebuildProps(t);
    if (this.selected && !scene.agents.some((a) => a.key === this.selected)) this.selected = null;
    this.invalidate();
  }

  /** The live props, when what they show changed. The dock's count waits for crates to leave. */
  private rebuildProps(t: number): void {
    const c = this.content;
    if (!c) return;
    const { layout, palette } = c;
    const inFlight = this.motion.shipsInFlight(t);
    this.shipping = inFlight;
    const scene = { ...c.scene, shipped: Math.max(0, c.scene.shipped - inFlight) };
    const occupied = occupiedSeats(scene);
    const props = propsKey(scene, layout, palette, occupied);
    if (props === this.keys.props) return;
    this.keys.props = props;
    clear(this.props, this.propsKit);
    this.propsKit = new Kit();
    this.props.add(buildProps(scene, layout, palette, this.propsKit, this.unit, occupied));
  }

  /** Selects an agent (null: none); it hops, gets a ring, and the camera flies to it. */
  select(key: string | null): void {
    this.selected = key;
    if (key) {
      const t = this.clock();
      this.crew.select(key, t);
      const at = this.crew.anchor(key) ?? this.seatOf(key);
      if (at) this.rig.flyTo({ x: at.x, y: at.y + 0.35, z: at.z });
    }
    this.invalidate();
  }

  /** Brings a figure into view when it's off screen (keyboard focus moved to it). */
  reveal(key: string): void {
    const s = this.screenOf(key);
    const at = this.crew.anchor(key);
    if (!s || !at || (s.foot.inView && s.head.inView)) return;
    this.rig.flyTo({ x: at.x, y: at.y + 0.35, z: at.z });
    this.invalidate();
  }

  /** Frames the whole Workshop again. */
  fit(animate: boolean): void {
    this.rig.fit(animate);
    this.invalidate();
  }

  /** Where a figure is on screen now, if it's on the floor. */
  screenOf(key: string): { foot: ScreenPoint; head: ScreenPoint } | null {
    const at = this.crew.anchor(key);
    if (!at) return null;
    return {
      foot: screenAnchor(this.rig.camera, this.viewport, at),
      head: screenAnchor(this.rig.camera, this.viewport, { x: at.x, y: at.y + HEAD_Y, z: at.z }),
    };
  }

  /** Draw calls and triangles of the last frame (the dev stats overlay). */
  stats(): { calls: number; triangles: number } {
    const r = this.renderer.info.render;
    return { calls: r.calls, triangles: r.triangles };
  }

  /** The repair bay's crates, as targets keyed `bay:<kind>`. */
  private crates(): { key: string; x: number; y: number; z: number }[] {
    const c = this.content;
    if (!c) return [];
    const spots = bayCrateSpots(c.layout, c.scene.bay.length);
    return c.scene.bay.slice(0, spots.length).map((crate, i) => {
      const at = spots[i] as { x: number; z: number };
      return { key: `bay:${crate.kind}`, x: at.x, y: 0, z: at.z };
    });
  }

  /** The figure under a canvas point, else the repair bay crate, if any. */
  private pick(x: number, y: number): string | null {
    const ray = rayAt(this.rig.camera, this.viewport, x, y);
    const targets = this.frames
      .filter((f) => !f.ghost)
      .map((f) => {
        const at = this.crew.anchor(f.key) ?? f;
        return { key: f.key, x: at.x, y: at.y, z: at.z };
      });
    const figure = pickFigure(ray, targets, pickBox(this.coarse));
    if (figure) return figure;
    const half = Math.max(BAY_CRATE.w / 2, pickBox(this.coarse).half);
    return pickFigure(ray, this.crates(), { half, height: BAY_CRATE.h + 0.05 });
  }

  private seatOf(key: string) {
    return this.frames.find((f) => f.key === key);
  }

  private clock(): number {
    return performance.now() / 1000;
  }

  /** Asks for a frame now (the data, camera, size or theme changed). */
  readonly invalidate = (): void => {
    this.dirty = true;
    this.schedule();
  };

  private canDraw(): boolean {
    return this.onScreen && document.visibilityState === "visible" && !this.lostTimer;
  }

  /** Whether the crew's loops, a walk or a moment want frames. */
  private animating(): boolean {
    const scene = this.content?.scene;
    return (
      this.motion.busy(this.clock()) ||
      this.crew.animating(this.frames, {
        t: 0,
        reduced: this.reducedMotion,
        still: scene?.stopped ?? false,
        selected: null,
        crates: [],
      })
    );
  }

  /** The next frame: now when something changed or the camera moves, else at the idle rate. */
  private schedule(): void {
    if (this.raf || !this.canDraw()) return;
    if (this.dirty || this.rig.moving) {
      window.clearTimeout(this.timer);
      this.timer = 0;
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    if (this.timer || !this.animating()) return;
    const wait = Math.max(0, 1000 / IDLE_FPS - (performance.now() - this.lastDrawn) - 4);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (!this.raf && this.canDraw()) this.raf = requestAnimationFrame(this.frame);
    }, wait);
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    this.rig.step(dt);
    this.draw();
    this.dirty = false;
    this.lastDrawn = performance.now();
    if (!this.rig.moving && !this.animating()) this.last = 0;
    this.schedule();
  };

  private draw(): void {
    const c = this.content;
    const t = this.clock();
    if (c) {
      const still = this.reducedMotion || c.scene.stopped;
      this.frames = still
        ? seatFrames(c.scene, c.layout)
        : this.motion.frames(c.scene, c.layout, t);
      this.crew.draw(this.frames, {
        t,
        reduced: this.reducedMotion,
        still: c.scene.stopped,
        selected: this.selected,
        crates: this.motion.crates(t),
      });
      if (this.motion.shipsInFlight(t) !== this.shipping) this.rebuildProps(t);
    }
    this.renderer.render(this.scene, this.rig.camera);
    this.drawn += 1;
    const figures: ScreenFigure[] = [];
    for (const f of this.frames) {
      if (f.ghost) continue;
      const s = this.screenOf(f.key);
      if (s) figures.push({ key: f.key, status: f.status, ...s });
    }
    for (const crate of this.crates()) {
      const foot = screenAnchor(this.rig.camera, this.viewport, crate);
      const head = screenAnchor(this.rig.camera, this.viewport, { ...crate, y: BAY_CRATE.h });
      figures.push({ key: crate.key, status: null, foot, head });
    }
    this.events.onFrame(figures, this.rig.pxPerUnit());
  }

  private measure(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.viewport = { width: w, height: h };
    this.renderer.setPixelRatio(Math.min(MAX_DPR, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.rig.setViewport(w, h);
    if (this.keys.bounds) this.rig.fit(false);
    this.invalidate();
  }

  private light(layout: WorkshopLayout, p: FloorPalette, stopped: boolean): void {
    const dim = stopped ? STOPPED_LIGHT : 1;
    this.hemi.color = colour(p.sky);
    this.hemi.groundColor = colour(p.floor);
    this.hemi.intensity = p.light.hemi * dim;
    this.sun.color = colour(p.sky);
    this.sun.intensity = p.light.sun * dim;
    // Aim the sun at the hall's centre and fit its shadow camera around the hall.
    const { x0, x1, z0, z1 } = layout.bounds;
    const centre = new Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
    this.sun.position.copy(centre).addScaledVector(SUN, 40);
    this.sun.target.position.copy(centre);
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    cam.position.copy(this.sun.position);
    cam.lookAt(centre);
    cam.updateMatrixWorld();
    const view = cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const box = {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    };
    const v = new Vector3();
    for (const x of [x0 - 0.2, x1 + 0.2])
      for (const y of [0, WALL_H + 0.3])
        for (const z of [z0 - 0.2, z1 + 0.2]) {
          v.set(x, y, z).applyMatrix4(view);
          box.minX = Math.min(box.minX, v.x);
          box.maxX = Math.max(box.maxX, v.x);
          box.minY = Math.min(box.minY, v.y);
          box.maxY = Math.max(box.maxY, v.y);
          box.minZ = Math.min(box.minZ, v.z);
          box.maxZ = Math.max(box.maxZ, v.z);
        }
    cam.left = box.minX;
    cam.right = box.maxX;
    cam.bottom = box.minY;
    cam.top = box.maxY;
    cam.near = Math.max(0.1, -box.maxZ - 1);
    cam.far = -box.minZ + 1;
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  private readonly visibility = (): void => {
    this.schedule();
  };

  private readonly lost = (e: Event): void => {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.lostTimer);
    this.lostTimer = window.setTimeout(() => this.events.onLost(), RESTORE_MS);
  };

  private readonly restored = (): void => {
    window.clearTimeout(this.lostTimer);
    this.lostTimer = 0;
    this.invalidate();
  };

  /** Frees the GPU resources and the context, and unhooks everything. */
  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.lostTimer);
    this.unbind();
    this.resize.disconnect();
    this.intersect?.disconnect();
    document.removeEventListener("visibilitychange", this.visibility);
    this.canvas.removeEventListener("webglcontextlost", this.lost);
    this.canvas.removeEventListener("webglcontextrestored", this.restored);
    clear(this.hall, this.hallKit);
    clear(this.props, this.propsKit);
    this.crew.dispose();
    this.shared.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.renderer.dispose();
    // Hand the context back now (browsers allow only a few at once), and drop the canvas.
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
