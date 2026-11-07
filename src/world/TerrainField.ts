/**
 * TERRAIN FIELD — a procedural definition of the ground, not a mesh.
 *
 * Height, normal and surface type are analytic functions of (x, z). Different
 * systems consume it independently:
 *   - the geometry evaluator samples it into chunk meshes, only when a chunk is requested
 *   - physics queries height/normal directly (no collision mesh exists)
 *   - the frame system resolves "grounded" entities against it
 *   - the audio system queries the surface type under the listener's feet
 */
import { Simplex2 } from '../util/noise';
import { smoothstep, lerp } from '../util/math';
import { Curve, CurveProjection } from './Curve';
import { SurfaceType } from './types';

export interface TerrainSample {
  height: number;
  trail: number; // 0..1 trail weight
  stream: number; // 0..1 stream bed weight
  slope: number;
  wet: number;
}

export class TerrainField {
  version = 1;
  readonly half: number;
  private n1: Simplex2;
  private n2: Simplex2;
  private n3: Simplex2;
  trail: Curve | null = null;
  stream: Curve | null = null;
  trailHalfWidth = 1.7;
  trailShoulder = 5.5;
  streamHalfWidth = 2.4;
  streamValley = 8;
  /** Height evaluation counter (diagnostics: how often the analytic field is sampled). */
  evalCount = 0;
  private proj: CurveProjection = { s: 0, lateral: 0, dist: 0, seg: 0 };
  private proj2: CurveProjection = { s: 0, lateral: 0, dist: 0, seg: 0 };
  /** Lowest possible height (bounds hint for shadow extrusion). */
  minHeight = -40;
  maxHeight = 80;

  constructor(seed: number, size: number) {
    this.half = size / 2;
    this.n1 = new Simplex2(seed * 7 + 1);
    this.n2 = new Simplex2(seed * 13 + 2);
    this.n3 = new Simplex2(seed * 31 + 3);
  }

  baseHeight(x: number, z: number): number {
    const n1 = this.n1, n2 = this.n2;
    let h = 20 * n1.fbm(x / 280, z / 280, 3) + 5 * n2.fbm(x / 70 + 17.3, z / 70 - 9.1, 3) + 0.7 * n1.noise(x / 11, z / 11);
    const d = Math.max(Math.abs(x), Math.abs(z)) / this.half;
    h += 38 * smoothstep(0.78, 1.0, d) * (0.7 + 0.3 * n2.noise(x / 40, z / 40));
    return h;
  }

  /** Attach world-space carving curves and derive their height profiles from the base field. */
  attachCurves(trail: Curve, stream: Curve | null): void {
    this.trail = trail;
    this.stream = stream;
    trail.halfWidth = this.trailHalfWidth;
    // trail profile = heavily smoothed base height so the trail is runnable
    const raw = new Float32Array(trail.n);
    for (let i = 0; i < trail.n; i++) raw[i] = this.baseHeight(trail.px[i], trail.pz[i]);
    trail.profile = smoothProfile(raw, trail.closed, Math.round(18 / trail.spacing), 3);
    trail.buildAccel(this.trailHalfWidth + this.trailShoulder + 14, 16);
    if (stream) {
      stream.halfWidth = this.streamHalfWidth;
      const rawS = new Float32Array(stream.n);
      for (let i = 0; i < stream.n; i++) rawS[i] = this.baseHeight(stream.px[i], stream.pz[i]);
      const sm = smoothProfile(rawS, stream.closed, Math.round(30 / stream.spacing), 3);
      // keep the bed at least 3m below the trail profile wherever the trail is close
      for (let i = 0; i < stream.n; i++) {
        let bed = sm[i] - 2.8;
        trail.nearest(stream.px[i], stream.pz[i], this.proj);
        if (this.proj.dist < 30) bed = Math.min(bed, trail.profileAt(this.proj.s) - 3.4);
        sm[i] = bed;
      }
      stream.profile = smoothProfile(sm, stream.closed, Math.round(10 / stream.spacing), 2);
      stream.buildAccel(this.streamHalfWidth + this.streamValley + 12, 16);
    }
    this.version++;
  }

  height(x: number, z: number): number {
    this.evalCount++;
    let h = this.baseHeight(x, z);
    const trail = this.trail;
    if (trail) {
      const p = trail.nearest(x, z, this.proj);
      if (p.dist < this.trailHalfWidth + this.trailShoulder) {
        const w = 1 - smoothstep(this.trailHalfWidth, this.trailHalfWidth + this.trailShoulder, p.dist);
        const groove = 0.12 * (1 - smoothstep(0, this.trailHalfWidth, p.dist));
        h = lerp(h, trail.profileAt(p.s) - groove, w);
      }
    }
    const stream = this.stream;
    if (stream) {
      const p = stream.nearest(x, z, this.proj2);
      const outer = this.streamHalfWidth + this.streamValley;
      if (p.dist < outer) {
        const bed = stream.profileAt(p.s);
        const r = p.dist / this.streamHalfWidth;
        const channel = bed + (r < 1 ? r * r * 0.7 : 0.7 + (p.dist - this.streamHalfWidth) * 0.55);
        const v = 1 - smoothstep(this.streamHalfWidth * 0.8, outer, p.dist);
        h = Math.min(h, lerp(h, channel, v));
      }
    }
    return h;
  }

  /** Water surface height if (x,z) is inside a stream channel, else -Infinity. */
  waterLevel(x: number, z: number): number {
    if (!this.stream) return -Infinity;
    const p = this.stream.nearest(x, z, this.proj2);
    if (p.dist < this.streamHalfWidth + 0.6) return this.stream.profileAt(p.s) + 0.55;
    return -Infinity;
  }

  normal(x: number, z: number, out: Float64Array | number[]): void {
    const e = 0.5;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    const nx = -hx, ny = 2 * e, nz = -hz;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
  }

  /** Full sample used for terrain coloring (trail/stream weights). */
  sample(x: number, z: number, out: TerrainSample): TerrainSample {
    out.height = this.height(x, z);
    out.trail = 0;
    out.stream = 0;
    out.wet = 0;
    if (this.trail) {
      const p = this.trail.nearest(x, z, this.proj);
      if (p.dist < this.trailHalfWidth + 1.5) out.trail = 1 - smoothstep(this.trailHalfWidth - 0.6, this.trailHalfWidth + 1.2, p.dist);
    }
    if (this.stream) {
      const p = this.stream.nearest(x, z, this.proj2);
      if (p.dist < this.streamHalfWidth + 4) {
        out.stream = 1 - smoothstep(this.streamHalfWidth, this.streamHalfWidth + 2.5, p.dist);
        out.wet = 1 - smoothstep(this.streamHalfWidth + 0.5, this.streamHalfWidth + 4, p.dist);
      }
    }
    out.slope = 0;
    return out;
  }

  /** Local detail noise used for coloring and vegetation density. */
  detail(x: number, z: number): number {
    return this.n3.noise(x / 23, z / 23);
  }
  densityNoise(x: number, z: number): number {
    return 0.6 * this.n3.fbm(x / 120 + 5, z / 120 - 7, 2) + 0.4 * this.n2.noise(x / 35, z / 35);
  }

  trailDistance(x: number, z: number): number {
    return this.trail ? this.trail.nearest(x, z, this.proj).dist : Infinity;
  }
  streamDistance(x: number, z: number): number {
    return this.stream ? this.stream.nearest(x, z, this.proj2).dist : Infinity;
  }

  surfaceAt(x: number, z: number, y: number): SurfaceType {
    if (y < this.waterLevel(x, z)) return 'water';
    const td = this.trailDistance(x, z);
    if (td < this.trailHalfWidth + 0.3) return 'dirt';
    const d = this.detail(x, z);
    return d > 0.35 ? 'litter' : 'grass';
  }
}

/** Iterated box filter (approximate gaussian) over a 1D profile. */
export function smoothProfile(src: Float32Array, closed: boolean, radius: number, iterations: number): Float32Array {
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  const n = src.length;
  radius = Math.max(1, radius);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let k = -radius; k <= radius; k++) {
        let j = i + k;
        if (closed) j = ((j % n) + n) % n;
        else if (j < 0 || j >= n) continue;
        sum += a[j];
        cnt++;
      }
      b[i] = sum / cnt;
    }
    const t = a; a = b; b = t;
  }
  return a;
}
