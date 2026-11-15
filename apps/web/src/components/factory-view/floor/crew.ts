import {
  type BufferGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  type Material,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { providerHue, providerTone, type Tone } from "@/components/common/provider-logos";
import { oklchToSrgb, type Rgb } from "@/lib/oklch";
import type { AgentRole, SceneAgent } from "../scene/agents";
import type { LayoutSeat } from "../scene/layout";
import { colour, Kit } from "./kit";
import type { FloorPalette } from "./palette";
import { badgeCanvas, shadowCanvas } from "./textures";

/**
 * Floor mode's crew (#420): every agent is the same small figure, a soft upside-down droplet on
 * two feet with a light on its tip, built from primitives (no model files). Agents differ by body
 * tone (their provider), accessory (their role) and a little seeded variation in size, shade and
 * head tilt, so each stays recognisable. Each part is one instanced mesh with a colour per figure,
 * so the crew costs the same few draw calls however many agents there are. Still in this part:
 * status poses and animation come later. Origin on the floor between the feet; +z is the front.
 */

export interface Figure {
  agent: SceneAgent;
  seat: LayoutSeat;
}

/** The body's profile: (radius, height), widest in the lower third. */
const PROFILE: [number, number][] = [
  [0, 0.06],
  [0.15, 0.07],
  [0.21, 0.13],
  [0.22, 0.2],
  [0.2, 0.3],
  [0.16, 0.4],
  [0.1, 0.5],
  [0.04, 0.58],
  [0, 0.6],
];
const DEPTH = 0.9;
/** Agents without a session yet: a neutral clay. */
const NO_PROVIDER: Tone = { l: 0.76, c: 0.01, h: 260 };

/** The body's radius at height y, from the profile. */
function radiusAt(y: number): number {
  for (let i = 1; i < PROFILE.length; i++) {
    const [r0, y0] = PROFILE[i - 1] as [number, number];
    const [r1, y1] = PROFILE[i] as [number, number];
    if (y <= y1) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  }
  return 0;
}

/** Where the front surface is at (x, y), for the face and badge. */
const frontZ = (x: number, y: number) => Math.sqrt(Math.max(0, radiusAt(y) ** 2 - x * x)) * DEPTH;

/** Moves a fresh geometry into place and returns it. */
function placed(
  g: BufferGeometry,
  x: number,
  y: number,
  z: number,
  rot?: [number, number, number],
  scale?: [number, number, number],
) {
  if (scale) g.scale(...scale);
  if (rot) {
    g.rotateX(rot[0]);
    g.rotateY(rot[1]);
    g.rotateZ(rot[2]);
  }
  g.translate(x, y, z);
  return g;
}

/** A thin rod from one point to another. */
function rod(from: [number, number, number], to: [number, number, number], r: number) {
  const a = new Vector3(...from);
  const b = new Vector3(...to);
  const dir = b.clone().sub(a);
  const g = new CylinderGeometry(r, r, dir.length(), 6);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize()));
  const mid = a.add(b).multiplyScalar(0.5);
  return g.translate(mid.x, mid.y, mid.z);
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  // Some primitives come without an index; give every part one so they merge.
  const indexed = parts.map((g) => {
    if (g.index) return g;
    const count = g.getAttribute("position").count;
    g.setIndex(Array.from({ length: count }, (_, i) => i));
    return g;
  });
  const out = mergeGeometries(indexed) as BufferGeometry;
  for (const g of indexed) g.dispose();
  return out;
}

/** The figure's parts, each one geometry. */
function crewGeometry() {
  const eyeZ = frontZ(0.07, 0.4) - 0.006;
  const mouthZ = frontZ(0, 0.345) - 0.004;
  const body = new LatheGeometry(
    PROFILE.map(([r, y]) => new Vector2(r, y)),
    24,
  ).scale(1, 1, DEPTH);
  const smile = Math.PI * 0.7;
  return {
    body: merged([body, placed(new CylinderGeometry(0.012, 0.012, 0.05, 8), 0, 0.625, 0)]),
    tip: placed(new SphereGeometry(0.045, 16, 12), 0, 0.68, 0),
    feet: merged(
      [-0.1, 0.1].map((x) =>
        placed(new SphereGeometry(0.07, 12, 8), x, 0.035, 0.04, undefined, [1, 0.5, 1.4]),
      ),
    ),
    hands: merged(
      [-0.215, 0.215].map((x) => placed(new SphereGeometry(0.05, 12, 8), x, 0.22, 0.03)),
    ),
    face: merged([
      ...[-0.07, 0.07].map((x) =>
        placed(new SphereGeometry(0.03, 12, 8), x, 0.4, eyeZ, undefined, [1, 1, 0.45]),
      ),
      // A small smile: the lower part of a ring.
      placed(new TorusGeometry(0.03, 0.007, 6, 14, smile), 0, 0.37, mouthZ, [
        0,
        0,
        -Math.PI / 2 - smile / 2,
      ]),
    ]),
    catchlights: merged(
      [-0.07, 0.07].map((x) =>
        placed(new SphereGeometry(0.009, 8, 6), x - 0.01, 0.412, eyeZ + 0.011),
      ),
    ),
    rim: placed(new CylinderGeometry(0.078, 0.078, 0.008, 24), 0, 0.17, frontZ(0, 0.17) - 0.002, [
      Math.PI / 2,
      0,
      0,
    ]),
    badge: placed(new CircleGeometry(0.07, 24), 0, 0.17, frontZ(0, 0.17) + 0.0025),
    shadow: placed(new CircleGeometry(0.24, 24), 0, 0.004, 0.02, [-Math.PI / 2, 0, 0]),
    // Builder: a knotted neckerchief.
    neckerchief: merged([
      placed(new TorusGeometry(0.17, 0.03, 8, 24), 0, 0.33, 0, [Math.PI / 2, 0, 0], [1, DEPTH, 1]),
      ...[-1, 1].map((side) =>
        placed(new ConeGeometry(0.03, 0.09, 8), side * 0.035, 0.27, frontZ(0, 0.3) + 0.025, [
          Math.PI + 0.3,
          0,
          side * 0.4,
        ]),
      ),
    ]),
    // Reviewer: round glasses.
    glasses: merged([
      ...[-0.07, 0.07].map((x) =>
        placed(new TorusGeometry(0.04, 0.006, 6, 20), x, 0.4, eyeZ + 0.01),
      ),
      placed(new CylinderGeometry(0.005, 0.005, 0.06, 6), 0, 0.405, eyeZ + 0.016, [
        0,
        0,
        Math.PI / 2,
      ]),
    ]),
    // Rebaser and integrator: a collar, and a wrench in one hand.
    collar: placed(
      new TorusGeometry(0.19, 0.02, 8, 24),
      0,
      0.29,
      0,
      [Math.PI / 2, 0, 0],
      [1, DEPTH, 1],
    ),
    wrench: merged([
      placed(new CylinderGeometry(0.012, 0.012, 0.15, 8), 0.235, 0.29, 0.06),
      placed(new TorusGeometry(0.028, 0.011, 6, 12, Math.PI * 1.5), 0.235, 0.385, 0.06, [
        0,
        0,
        -Math.PI * 0.25,
      ]),
    ]),
    // PM: a headset over the dome, below the stem, with a mic boom.
    headset: merged([
      placed(new TorusGeometry(0.125, 0.012, 6, 20, Math.PI), 0, 0.47, 0),
      ...[-0.125, 0.125].map((x) => placed(new SphereGeometry(0.035, 10, 8), x, 0.46, 0)),
    ]),
    mic: merged([
      rod([-0.13, 0.44, 0.03], [-0.05, 0.355, frontZ(-0.05, 0.355) + 0.01], 0.006),
      placed(new SphereGeometry(0.016, 8, 6), -0.05, 0.355, frontZ(-0.05, 0.355) + 0.01),
    ]),
  };
}

type Part = keyof ReturnType<typeof crewGeometry>;

/** A repeatable random number in 0..1 per seed and channel. */
function seeded(seed: string, channel: number): number {
  let h = 2166136261 ^ channel;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const toneRgb = (t: Tone, dl = 0): Rgb => oklchToSrgb(Math.min(1, Math.max(0, t.l + dl)), t.c, t.h);

const ACCESSORIES: Partial<
  Record<AgentRole, { part: Part; colour: "accent" | "steel" | "ink" }[]>
> = {
  builder: [{ part: "neckerchief", colour: "accent" }],
  reviewer: [{ part: "glasses", colour: "accent" }],
  rebaser: [
    { part: "collar", colour: "accent" },
    { part: "wrench", colour: "steel" },
  ],
  integrator: [
    { part: "collar", colour: "accent" },
    { part: "wrench", colour: "steel" },
  ],
  pm: [
    { part: "headset", colour: "accent" },
    { part: "mic", colour: "ink" },
  ],
};

/** The crew on the floor, rebuilt when who stands where changes. */
export class Crew {
  readonly group = new Group();
  private readonly kit = new Kit();
  private frame = new Kit();
  private readonly geo = crewGeometry();
  private readonly clay: MeshStandardMaterial;
  private readonly shadow: MeshBasicMaterial;
  private readonly catchlight: MeshBasicMaterial;
  private tipMaterial: MeshStandardMaterial | null = null;
  private readonly badges = new Map<string, Material>();

  constructor() {
    for (const g of Object.values(this.geo)) this.kit.own(g);
    this.clay = this.kit.matte(null);
    this.catchlight = this.kit.own(new MeshBasicMaterial({ color: 0xffffff }));
    this.shadow = this.kit.own(
      new MeshBasicMaterial({
        color: 0x000000,
        map: this.kit.canvasTexture(shadowCanvas()),
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
  }

  /** Puts `figures` on the floor in `p`'s colours. */
  update(figures: readonly Figure[], p: FloorPalette): void {
    this.group.clear();
    this.frame.dispose();
    this.frame = new Kit();
    const tip = this.tip(p);
    const upper: Matrix4[] = [];
    const lower: Matrix4[] = [];
    const tones: Rgb[] = [];
    const feet: Rgb[] = [];
    const accents: Rgb[] = [];
    for (const { agent, seat } of figures) {
      const s = 0.96 + seeded(agent.seed, 1) * 0.08;
      const tilt = ((seeded(agent.seed, 2) - 0.5) * 8 * Math.PI) / 180;
      const dl = (seeded(agent.seed, 3) - 0.5) * 0.08;
      const base = new Matrix4().makeTranslation(seat.stand.x, seat.floorY, seat.stand.z);
      const size = new Matrix4().makeScale(s, s, s);
      lower.push(base.clone().multiply(size));
      upper.push(base.clone().multiply(new Matrix4().makeRotationZ(tilt)).multiply(size));
      const tone = agent.providerId ? providerTone(agent.providerId) : NO_PROVIDER;
      tones.push(toneRgb(tone, dl));
      feet.push(toneRgb(tone, dl - 0.12));
      accents.push(p.accent[agent.role]);
    }
    const ink = figures.map(() => p.ink);
    const put = (
      part: Part,
      material: Material,
      matrices: Matrix4[],
      colours?: Rgb[],
      cast = true,
    ) => {
      const mesh = this.frame.instanced(this.geo[part], material, matrices, colours, {
        cast,
        receive: false,
      });
      if (mesh) this.group.add(mesh);
    };
    put("shadow", this.shadow, lower, undefined, false);
    put("feet", this.clay, lower, feet);
    put("body", this.clay, upper, tones);
    put("hands", this.clay, upper, tones);
    put("tip", tip, upper, undefined, false);
    put("face", this.clay, upper, ink, false);
    put("catchlights", this.catchlight, upper, undefined, false);
    put("rim", this.clay, upper, accents, false);

    // Badges: one mesh per provider, each with its mark.
    const byBadge = new Map<string, Matrix4[]>();
    figures.forEach(({ agent }, i) => {
      const key = agent.providerId ?? "";
      byBadge.set(key, [...(byBadge.get(key) ?? []), upper[i] as Matrix4]);
    });
    for (const [key, matrices] of byBadge) {
      const name = figures.find((f) => (f.agent.providerId ?? "") === key)?.agent.provider ?? null;
      put("badge", this.badge(key, name), matrices, undefined, false);
    }

    // Role accessories.
    const steel = figures.map(() => p.steel);
    for (const [role, parts] of Object.entries(ACCESSORIES) as [
      AgentRole,
      NonNullable<(typeof ACCESSORIES)[AgentRole]>,
    ][]) {
      const idx = figures.flatMap((f, i) => (f.agent.role === role ? [i] : []));
      if (idx.length === 0) continue;
      for (const { part, colour: c } of parts) {
        const colours = c === "accent" ? accents : c === "steel" ? steel : ink;
        put(
          part,
          this.clay,
          idx.map((i) => upper[i] as Matrix4),
          idx.map((i) => colours[i] as Rgb),
        );
      }
    }
  }

  private tip(p: FloorPalette): MeshStandardMaterial {
    if (!this.tipMaterial) this.tipMaterial = this.kit.matte(p.tip, { roughness: 0.4 });
    this.tipMaterial.color = colour(p.tip);
    this.tipMaterial.emissive = colour(p.tip);
    this.tipMaterial.emissiveIntensity = 0.3;
    return this.tipMaterial;
  }

  private badge(providerId: string, name: string | null): Material {
    const cached = this.badges.get(providerId);
    if (cached) return cached;
    const map = this.kit.canvasTexture(
      badgeCanvas(providerId || null, name, providerHue(providerId)),
    );
    const material = this.kit.own(new MeshStandardMaterial({ map, roughness: 0.55 }));
    this.badges.set(providerId, material);
    return material;
  }

  dispose(): void {
    this.group.clear();
    this.frame.dispose();
    this.kit.dispose();
    this.badges.clear();
  }
}
