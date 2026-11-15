import {
  type BufferGeometry,
  CanvasTexture,
  Color,
  InstancedMesh,
  type Material,
  Matrix4,
  MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  type Object3D,
  SRGBColorSpace,
  Vector3,
} from "three";
import type { Rgb } from "@/lib/oklch";

/**
 * Small Three.js helpers for Floor mode (#420): a kit that remembers every geometry, material
 * and texture it made so a rebuild or unmount frees them all, colours from sRGB triples, and
 * instanced meshes from lists of matrices (repeated furniture and crew parts are one draw call
 * each, however many there are).
 */

interface Disposable {
  dispose(): void;
}

export class Kit {
  private readonly owned = new Set<Disposable>();

  /** Keeps `thing` to dispose of later, and returns it. */
  own<T extends Disposable>(thing: T): T {
    this.owned.add(thing);
    return thing;
  }

  /** A matte material in this colour (white when it takes per-instance colours). */
  matte(rgb: Rgb | null, params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ roughness: 0.75, metalness: 0, ...params });
    if (rgb) m.color = colour(rgb);
    return this.own(m);
  }

  /** A texture from a canvas, in sRGB. */
  canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
    const t = this.own(new CanvasTexture(canvas));
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  /**
   * One mesh drawing `geometry` at every matrix, with a colour each when given. Empty lists give
   * null, so nothing is drawn.
   */
  instanced(
    geometry: BufferGeometry,
    material: Material,
    matrices: readonly Matrix4[],
    colours?: readonly Rgb[],
    shadows: { cast?: boolean; receive?: boolean } = { cast: true, receive: true },
  ): InstancedMesh | null {
    if (matrices.length === 0) return null;
    const mesh = this.own(new InstancedMesh(geometry, material, matrices.length));
    matrices.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
    });
    if (colours) {
      const c = new Color();
      colours.forEach((rgb, i) => {
        mesh.setColorAt(i, setColour(c, rgb));
      });
    }
    mesh.castShadow = shadows.cast ?? false;
    mesh.receiveShadow = shadows.receive ?? false;
    mesh.computeBoundingSphere();
    return mesh;
  }

  /** Frees everything the kit made. */
  dispose(): void {
    for (const thing of this.owned) thing.dispose();
    this.owned.clear();
  }
}

/** Frees what `kit` made and takes `group`'s children off the scene. */
export function clear(group: Object3D, kit: Kit): void {
  group.clear();
  kit.dispose();
}

/** A Three.js colour from a gamma-encoded sRGB triple. */
export function colour(rgb: Rgb): Color {
  return setColour(new Color(), rgb);
}

export function setColour(c: Color, [r, g, b]: Rgb): Color {
  return c.setRGB(r, g, b, SRGBColorSpace);
}

/** A translation, with an optional turn around y and a scale. */
export function at(
  x: number,
  y: number,
  z: number,
  turnY = 0,
  scale?: [number, number, number],
): Matrix4 {
  const m = new Matrix4().makeRotationY(turnY);
  if (scale) m.scale(new Vector3(...scale));
  m.setPosition(x, y, z);
  return m;
}

/** A canvas of this size, for drawing a texture on. */
export function canvasOf(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return canvas;
}
