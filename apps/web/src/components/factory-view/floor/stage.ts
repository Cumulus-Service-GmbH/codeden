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
import { floorSeats, seatAt, WALL_H, type WorkshopLayout } from "../scene/layout";
import type { Scene } from "../scene/scene-model";
import { CameraRig } from "./camera";
import { Crew, type Figure } from "./crew";
import { bindInput } from "./input";
import { clear, colour, Kit } from "./kit";
import type { FloorPalette } from "./palette";
import { buildProps, occupiedSeats, propsKey } from "./props";
import { buildWorkshop } from "./workshop";

/**
 * Floor mode's stage (#420): one WebGL renderer, the hall, the crew and the live props, lit by a
 * hemisphere light and a sun from the upper left front with soft shadows. It renders only when
 * something changed (the data, the camera, the size or the theme) and never while the tab is
 * hidden or the canvas is off screen. The pixel ratio is capped at 2. Throws when WebGL can't
 * start; calls `onLost` when the context is lost and doesn't come back.
 */

export interface StageContent {
  layout: WorkshopLayout;
  scene: Scene;
  palette: FloorPalette;
}

const MAX_DPR = 2;
const SHADOW_MAP = 1024;
/** How long a lost context may take to come back before the view gives up on it. */
const RESTORE_MS = 3000;
/** Toward the sun: from the upper left front, as the camera sees the hall. */
const SUN = new Vector3(-0.2, 1.5, 1).normalize();

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
  private keys = { hall: "", bounds: "", props: "", crew: "" };
  private raf = 0;
  private last = 0;
  private dirty = true;
  private onScreen = true;
  private lostTimer = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly unbind: () => void;
  private readonly resize: ResizeObserver;
  private readonly intersect: IntersectionObserver | null;

  /**
   * Draws into a canvas of its own inside `host` (decorative: hidden from assistive tech), so
   * handing its context back on dispose never touches the next stage's.
   */
  constructor(
    private readonly host: HTMLElement,
    private readonly onLost: () => void,
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
    this.unbind = bindInput(canvas, this.rig, this.invalidate, () => this.fit(true));
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(host);
    this.intersect =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            this.onScreen = entries.some((e) => e.isIntersecting);
            if (this.onScreen && this.dirty) this.invalidate();
          });
    this.intersect?.observe(canvas);
    this.measure();
  }

  set reduced(on: boolean) {
    this.rig.reduced = on;
  }

  /** Keeps the fit clear of `px` CSS pixels on the left (the open roster), and refits. */
  setInset(px: number): void {
    if (this.rig.insetPx === px) return;
    this.rig.insetPx = px;
    if (this.keys.bounds) this.fit(true);
  }

  /** Shows `content`, rebuilding only what changed. */
  update({ layout, scene, palette }: StageContent): void {
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
      this.light(layout, palette);
      const bounds = JSON.stringify(layout.bounds);
      if (bounds !== this.keys.bounds) {
        // The first layout jumps into view; growing eases out to the new fit.
        const grew = this.keys.bounds !== "";
        this.keys.bounds = bounds;
        this.rig.setScene(layout.bounds, WALL_H);
        this.rig.fit(grew);
      }
    }

    const figures: Figure[] = [];
    for (const agent of scene.agents) {
      const at = scene.seating.seats.get(agent.key);
      const seat = at ? seatAt(layout, at.station, at.tile) : undefined;
      if (seat && !seat.offFloor) figures.push({ agent, seat });
    }
    const crewKey = JSON.stringify([
      figures.map((f) => [
        f.agent.key,
        f.agent.role,
        f.agent.providerId,
        f.agent.provider,
        f.agent.seed,
        f.seat.tile,
      ]),
      palette,
    ]);
    if (crewKey !== this.keys.crew) {
      this.keys.crew = crewKey;
      this.crew.update(figures, palette);
    }

    const occupied = occupiedSeats(scene);
    const props = propsKey(scene, layout, palette, occupied);
    if (props !== this.keys.props) {
      this.keys.props = props;
      clear(this.props, this.propsKit);
      this.propsKit = new Kit();
      this.props.add(buildProps(scene, layout, palette, this.propsKit, this.unit, occupied));
    }
    this.invalidate();
  }

  /** Frames the whole Workshop again. */
  fit(animate: boolean): void {
    this.rig.fit(animate);
    this.invalidate();
  }

  /** Asks for a frame, when one can be shown. */
  readonly invalidate = (): void => {
    this.dirty = true;
    if (this.raf || !this.onScreen || document.visibilityState !== "visible" || this.lostTimer)
      return;
    this.raf = requestAnimationFrame(this.frame);
  };

  private readonly frame = (t: number): void => {
    this.raf = 0;
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 1 / 60;
    this.last = t;
    const moving = this.rig.step(dt);
    this.renderer.render(this.scene, this.rig.camera);
    this.dirty = false;
    if (moving) this.invalidate();
    else this.last = 0;
  };

  private measure(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setPixelRatio(Math.min(MAX_DPR, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.rig.setViewport(w, h);
    if (this.keys.bounds) this.rig.fit(false);
    this.invalidate();
  }

  private light(layout: WorkshopLayout, p: FloorPalette): void {
    this.hemi.color = colour(p.sky);
    this.hemi.groundColor = colour(p.floor);
    this.hemi.intensity = p.light.hemi;
    this.sun.color = colour(p.sky);
    this.sun.intensity = p.light.sun;
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
    if (document.visibilityState === "visible" && this.dirty) this.invalidate();
  };

  private readonly lost = (e: Event): void => {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.lostTimer);
    this.lostTimer = window.setTimeout(() => this.onLost(), RESTORE_MS);
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
