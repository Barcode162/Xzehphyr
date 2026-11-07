/**
 * Procedural geometry generators. Pure functions of (procedural definition, LOD).
 * They read the terrain *field* where needed (terrain patches, water, grass) but
 * never any renderer state.
 */
import { MeshBuilder, GeometryData } from './MeshBuilder';
import { Family, ProceduralDef } from '../world/types';
import { mulberry32, Rng } from '../util/rng';
import { Simplex2 } from '../util/noise';
import { TerrainField, TerrainSample } from '../world/TerrainField';
import { Curve } from '../world/Curve';
import { composeYawMatrix, smoothstep, lerp } from '../util/math';

type C3 = [number, number, number];
const mix3 = (a: C3, b: C3, t: number): C3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mul3 = (a: C3, k: number): C3 => [a[0] * k, a[1] * k, a[2] * k];

export function generateArchetype(def: ProceduralDef, lod: number): GeometryData {
  switch (def.family) {
    case Family.Pine: return pine(def, lod);
    case Family.Oak: return oak(def, lod);
    case Family.Birch: return birch(def, lod);
    case Family.Rock: return rock(def, lod);
    case Family.Bush: return bush(def, lod);
    case Family.Fern: return fern(def);
    case Family.Lantern: return lantern(lod);
    case Family.Bridge: return bridge(def, lod);
    case Family.StressPillar: return pillar(lod);
    default: return new MeshBuilder().build();
  }
}

// ---------------------------------------------------------------------------- trees
function pine(def: ProceduralDef, lod: number): GeometryData {
  const r = mulberry32(def.seed);
  const b = new MeshBuilder();
  const H = 12.5 + r() * 3;
  const tiers = lod === 0 ? 7 : lod === 1 ? 4 : 2;
  const seg = lod === 0 ? 11 : lod === 1 ? 7 : 5;
  const trunkSeg = lod === 0 ? 7 : lod === 1 ? 5 : 4;
  const bark: C3 = [0.27, 0.18, 0.12];
  b.cylinder(0, 0, -0.4, H * 0.9, 0.34, 0.07, trunkSeg, mul3(bark, 0.8), bark);
  const tint = r() * 0.12 - 0.06;
  const baseCol: C3 = [0.07 + tint * 0.3, 0.2 + tint, 0.1];
  const tipCol: C3 = [0.2 + tint * 0.4, 0.38 + tint, 0.17];
  const jags: number[] = [];
  for (let t = 0; t < tiers; t++) {
    jags.length = 0;
    for (let i = 0; i < seg; i++) jags.push(0.78 + r() * 0.32);
    const f = t / tiers;
    const yBase = H * (0.2 + 0.68 * f);
    const height = H * (lod === 2 ? 0.55 - 0.15 * f : 0.3 - 0.12 * f);
    const radius = (3.3 * Math.pow(1 - f, 0.85) + 0.5) * (lod === 2 ? 1.05 : 1);
    const shade = 0.85 + 0.3 * f;
    b.cone(r() * 0.15, r() * 0.15, yBase, height, radius, seg, (i) => jags[i], mul3(baseCol, shade), mul3(tipCol, shade), 0.35);
  }
  return b.build();
}

function foliageColor(base: C3, noise: Simplex2, varK: number) {
  return (x: number, y: number, z: number, _nx: number, ny: number): C3 => {
    const n = noise.noise3(x * 0.5, y * 0.5, z * 0.5);
    const k = 0.78 + 0.28 * Math.max(0, ny) + n * varK;
    return mul3(base, k);
  };
}

function oak(def: ProceduralDef, lod: number): GeometryData {
  const r = mulberry32(def.seed);
  const noise = new Simplex2(def.seed);
  const b = new MeshBuilder();
  const bark: C3 = [0.25, 0.19, 0.13];
  const tSeg = lod === 0 ? 7 : lod === 1 ? 5 : 4;
  b.cylinder(0, 0, -0.4, 4.6, 0.5, 0.3, tSeg, mul3(bark, 0.8), bark);
  if (lod === 0) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + r();
      b.cylinder(0, 0, 3.8, 6.4, 0.22, 0.1, 5, bark, bark, false, Math.cos(a) * 1.8, Math.sin(a) * 1.8);
    }
  }
  const leaf: C3 = [0.2 + r() * 0.06, 0.36 + r() * 0.08, 0.13];
  const blobs = lod === 0 ? 6 : lod === 1 ? 3 : 1;
  const detail = lod === 2 ? 0 : 1;
  const disp = (x: number, y: number, z: number) => 1 + 0.22 * noise.noise3(x * 1.7, y * 1.7, z * 1.7);
  if (blobs === 1) {
    b.blob(0, 7.4, 0, 4.4, 3.4, 4.4, detail, disp, foliageColor(leaf, noise, 0.15));
  } else {
    for (let i = 0; i < blobs; i++) {
      const a = (i / blobs) * Math.PI * 2 + r() * 0.5;
      const rad = i === 0 ? 0 : 2.2 + r() * 0.6;
      const cx = i === 0 ? 0 : Math.cos(a) * rad, cz = i === 0 ? 0 : Math.sin(a) * rad;
      const cy = i === 0 ? 8.2 : 6.6 + r() * 1.4;
      const s = i === 0 ? 3.2 : 2.3 + r() * 0.7;
      b.blob(cx, cy, cz, s, s * 0.8, s, detail, disp, foliageColor(leaf, noise, 0.15));
    }
  }
  return b.build();
}

function birch(def: ProceduralDef, lod: number): GeometryData {
  const r = mulberry32(def.seed);
  const noise = new Simplex2(def.seed + 1);
  const b = new MeshBuilder();
  const H = 11 + r() * 2;
  const white: C3 = [0.86, 0.84, 0.78];
  const dark: C3 = [0.2, 0.18, 0.16];
  const seg = lod === 0 ? 6 : 4;
  if (lod === 0) {
    const bands = 8;
    for (let i = 0; i < bands; i++) {
      const y0 = -0.3 + (i / bands) * H * 0.85, y1 = -0.3 + ((i + 1) / bands) * H * 0.85;
      const r0 = 0.24 - 0.16 * (i / bands), r1 = 0.24 - 0.16 * ((i + 1) / bands);
      const c = i % 3 === 1 ? mix3(white, dark, 0.55) : white;
      b.cylinder(0, 0, y0, y1, r0, r1, seg, c, i % 3 === 0 ? mix3(white, dark, 0.25) : white);
    }
  } else {
    b.cylinder(0, 0, -0.3, H * 0.85, 0.24, 0.08, seg, white, mix3(white, dark, 0.2));
  }
  const leaf: C3 = [0.38 + r() * 0.08, 0.5 + r() * 0.08, 0.18];
  const blobs = lod === 0 ? 5 : lod === 1 ? 2 : 1;
  const detail = lod === 2 ? 0 : 1;
  const disp = (x: number, y: number, z: number) => 1 + 0.25 * noise.noise3(x * 2, y * 2, z * 2);
  for (let i = 0; i < blobs; i++) {
    const f = blobs === 1 ? 0.5 : i / (blobs - 1);
    const a = r() * Math.PI * 2;
    const off = blobs === 1 ? 0 : 0.9 + r() * 0.4;
    const s = blobs === 1 ? 2.4 : 1.5 + r() * 0.5;
    b.blob(Math.cos(a) * off, H * (0.55 + 0.32 * f), Math.sin(a) * off, s, s * (blobs === 1 ? 1.9 : 1.3), s, detail, disp, foliageColor(leaf, noise, 0.18));
  }
  return b.build();
}

// ---------------------------------------------------------------------------- rocks, shrubs
function rock(def: ProceduralDef, lod: number): GeometryData {
  const noise = new Simplex2(def.seed);
  const b = new MeshBuilder();
  const detail = lod === 0 ? 2 : lod === 1 ? 1 : 0;
  const base: C3 = [0.43, 0.42, 0.4];
  const moss: C3 = [0.28, 0.36, 0.16];
  b.blob(0, 0.35, 0, 1, 0.85, 1, detail,
    (x, y, z) => 1 + 0.28 * noise.noise3(x * 1.3, y * 1.3, z * 1.3) + 0.08 * noise.noise3(x * 4, y * 4, z * 4),
    (x, y, z, _nx, ny) => {
      const n = noise.noise3(x * 3, y * 3, z * 3);
      const m = smoothstep(0.45, 0.85, ny) * (0.6 + 0.4 * n);
      return mul3(mix3(base, moss, m), 0.85 + 0.25 * n);
    }, true, 0.35);
  return b.build();
}

function bush(def: ProceduralDef, lod: number): GeometryData {
  const r = mulberry32(def.seed);
  const noise = new Simplex2(def.seed);
  const b = new MeshBuilder();
  const leaf: C3 = [0.17 + r() * 0.08, 0.32 + r() * 0.1, 0.12];
  const n = lod === 0 ? 4 : 2;
  const detail = lod === 0 ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r();
    const off = i === 0 ? 0 : 0.5 + r() * 0.3;
    const s = 0.6 + r() * 0.35;
    b.blob(Math.cos(a) * off, 0.5 + r() * 0.3, Math.sin(a) * off, s, s * 0.8, s, detail,
      (x, y, z) => 1 + 0.25 * noise.noise3(x * 2.2, y * 2.2, z * 2.2), foliageColor(leaf, noise, 0.2), true, 0.5);
  }
  return b.build();
}

function fern(def: ProceduralDef): GeometryData {
  const r = mulberry32(def.seed);
  const b = new MeshBuilder();
  const fronds = 7;
  const c0: C3 = [0.13, 0.3, 0.1];
  const c1: C3 = [0.32 + r() * 0.08, 0.55 + r() * 0.1, 0.2];
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + r() * 0.4;
    const ca = Math.cos(a), sa = Math.sin(a);
    const len = 0.9 + r() * 0.5;
    const w = 0.18;
    const segs = 3;
    let px = 0, py = 0.05, pz = 0;
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs, t1 = (s + 1) / segs;
      const rise1 = Math.sin(t1 * 2.2) * 0.65;
      const nx = ca * len * t1, nz = sa * len * t1, ny = 0.05 + rise1 * len;
      const w0 = w * (1 - t0 * 0.7), w1 = w * (1 - t1 * 0.85);
      const pxw = -sa, pzw = ca;
      b.quadDouble(
        px - pxw * w0, py, pz - pzw * w0,
        px + pxw * w0, py, pz + pzw * w0,
        nx + pxw * w1, ny, nz + pzw * w1,
        nx - pxw * w1, ny, nz - pzw * w1,
        0, 1, 0, mix3(c0, c1, t0), mix3(c0, c1, t1),
      );
      px = nx; py = ny; pz = nz;
    }
  }
  return b.build();
}

function lantern(lod: number): GeometryData {
  const b = new MeshBuilder();
  const wood: C3 = [0.3, 0.21, 0.13];
  const metal: C3 = [0.12, 0.12, 0.13];
  b.beginGroup(0);
  b.box(0, 1.1, 0, 0.07, 1.1, 0.07, wood);
  if (lod === 0) {
    b.box(0, 2.15, 0.22, 0.04, 0.04, 0.26, wood);
    b.box(0, 1.92, 0.44, 0.13, 0.025, 0.13, metal);
    b.box(0, 1.6, 0.44, 0.13, 0.02, 0.13, metal);
  }
  b.beginGroup(1);
  b.box(0, 1.76, lod === 0 ? 0.44 : 0.1, 0.09, 0.14, 0.09, [1.0, 0.85, 0.55], 0, 1, 1);
  return b.build();
}

function pillar(lod: number): GeometryData {
  const b = new MeshBuilder();
  const c: C3 = [0.46, 0.44, 0.42];
  const seg = lod === 0 ? 8 : 5;
  b.cylinder(0, 0, -1, 30, 0.9, 0.55, seg, mul3(c, 0.7), c, true);
  return b.build();
}

function bridge(def: ProceduralDef, lod: number): GeometryData {
  const r = mulberry32(def.seed);
  const b = new MeshBuilder();
  const halfLen = def.params[0];
  const halfW = def.params[1];
  const plankCol: C3 = [0.42, 0.3, 0.19];
  const beamCol: C3 = [0.3, 0.21, 0.13];
  if (lod === 0) {
    const plankW = 0.32;
    const n = Math.floor((halfLen * 2) / (plankW + 0.04));
    for (let i = 0; i < n; i++) {
      const z = -halfLen + (i + 0.5) * (halfLen * 2 / n);
      const k = 0.85 + r() * 0.3;
      b.box((r() - 0.5) * 0.06, -0.06 + (r() - 0.5) * 0.03, z, halfW, 0.06, plankW / 2, mul3(plankCol, k), (r() - 0.5) * 0.03);
    }
  } else {
    b.box(0, -0.06, 0, halfW, 0.06, halfLen, plankCol);
  }
  // stringers
  for (const sx of [-1, 1]) b.box(sx * (halfW - 0.15), -0.3, 0, 0.12, 0.18, halfLen, beamCol);
  // posts and rails
  const postSpacing = 3;
  const posts = Math.floor((halfLen * 2) / postSpacing) + 1;
  for (const sx of [-1, 1]) {
    for (let i = 0; i < posts; i++) {
      const z = -halfLen + (i / (posts - 1)) * halfLen * 2;
      b.box(sx * (halfW + 0.05), 0.45, z, 0.07, 0.6, 0.07, beamCol);
      if (lod === 0) b.box(sx * (halfW + 0.05), -1.6, z, 0.09, 1.5, 0.09, mul3(beamCol, 0.8));
    }
    b.box(sx * (halfW + 0.05), 1.05, 0, 0.05, 0.05, halfLen, plankCol);
    if (lod === 0) b.box(sx * (halfW + 0.05), 0.55, 0, 0.035, 0.035, halfLen, plankCol);
  }
  return b.build();
}

// ---------------------------------------------------------------------------- terrain
const tSample: TerrainSample = { height: 0, trail: 0, stream: 0, slope: 0, wet: 0 };

export const TERRAIN_RES = [48, 24, 12];

/** Terrain patch geometry in region-local coordinates (x,z relative to region center; y absolute). */
export function terrainPatch(terrain: TerrainField, def: ProceduralDef, lod: number): GeometryData {
  const [cx, cz, size] = def.params;
  const res = TERRAIN_RES[lod];
  const step = size / res;
  const W = res + 3; // with 1-vertex border on each side
  const H = new Float32Array(W * W);
  const trailW = new Float32Array(W * W);
  const wetW = new Float32Array(W * W);
  const x0 = cx - size / 2 - step, z0 = cz - size / 2 - step;
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const s = terrain.sample(x0 + i * step, z0 + j * step, tSample);
    const k = j * W + i;
    H[k] = s.height;
    trailW[k] = s.trail;
    wetW[k] = Math.max(s.wet, s.stream);
  }
  const b = new MeshBuilder();
  const grass: C3 = [0.29, 0.42, 0.15];
  const grassDry: C3 = [0.42, 0.45, 0.2];
  const litter: C3 = [0.27, 0.25, 0.14];
  const dirt: C3 = [0.47, 0.36, 0.24];
  const wet: C3 = [0.24, 0.24, 0.17];
  const rockC: C3 = [0.43, 0.42, 0.39];
  const n = res + 1;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = (j + 1) * W + (i + 1);
    const x = x0 + (i + 1) * step, z = z0 + (j + 1) * step;
    const hx = H[k + 1] - H[k - 1], hz = H[k + W] - H[k - W];
    let nx = -hx, ny = 2 * step, nz = -hz;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= l; ny /= l; nz /= l;
    const d = terrain.detail(x, z);
    const dn = terrain.densityNoise(x, z);
    let c = mix3(grass, grassDry, smoothstep(-0.4, 0.6, d));
    c = mix3(c, litter, smoothstep(-0.25, 0.35, dn) * 0.65);
    c = mix3(c, rockC, smoothstep(0.72, 0.55, ny));
    c = mix3(c, wet, wetW[k]);
    c = mix3(c, dirt, trailW[k]);
    c = mul3(c, 0.92 + 0.12 * terrain.detail(x * 3.1, z * 3.1));
    b.vertex(x - cx, H[k], z - cz, nx, ny, nz, c[0], c[1], c[2]);
  }
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const a = j * n + i, bb = a + 1, c = a + n, d = c + 1;
    // alternate diagonal for less directional artifacts
    if ((i + j) & 1) { b.tri(a, c, bb); b.tri(bb, c, d); } else { b.tri(a, c, d); b.tri(a, d, bb); }
  }
  // skirts hide cracks between LODs
  const skirt = 2.5 + lod * 2;
  const edge = (idx: (t: number) => number) => {
    const start = b.vertexCount;
    for (let t = 0; t < n; t++) {
      const v = idx(t);
      const p = b.pos, q = b.col;
      b.vertex(p[v * 3], p[v * 3 + 1] - skirt, p[v * 3 + 2], b.nor[v * 3], b.nor[v * 3 + 1], b.nor[v * 3 + 2], q[v * 3] * 0.8, q[v * 3 + 1] * 0.8, q[v * 3 + 2] * 0.8);
    }
    for (let t = 0; t < res; t++) {
      const a = idx(t), c = idx(t + 1), s0 = start + t, s1 = start + t + 1;
      b.tri(a, s0, c); b.tri(c, s0, s1);
      b.tri(a, c, s0); b.tri(c, s1, s0);
    }
  };
  edge((t) => t);
  edge((t) => res * n + t);
  edge((t) => t * n);
  edge((t) => t * n + res);
  return b.build();
}

/** Stream water surface within a region (region-local x/z, absolute y). */
export function waterPatch(stream: Curve, terrain: TerrainField, def: ProceduralDef): GeometryData {
  const [cx, cz, size] = def.params;
  const b = new MeshBuilder();
  const minX = cx - size / 2 - 1, maxX = cx + size / 2 + 1, minZ = cz - size / 2 - 1, maxZ = cz + size / 2 + 1;
  const hw = terrain.streamHalfWidth + 0.5;
  const deep: C3 = [0.1, 0.24, 0.27];
  const shallow: C3 = [0.22, 0.4, 0.38];
  let prev = -1;
  for (let i = 0; i < stream.n; i++) {
    const x = stream.px[i], z = stream.pz[i];
    if (x < minX || x > maxX || z < minZ || z > maxZ) { prev = -1; continue; }
    const seg = Math.min(i, stream.segmentCount - 1);
    const h = stream.heading[seg];
    const rx = Math.cos(h), rz = -Math.sin(h);
    const y = stream.profile[i] + 0.55;
    const base = b.vertexCount;
    b.vertex(x - rx * hw - cx, y, z - rz * hw - cz, 0, 1, 0, shallow[0], shallow[1], shallow[2]);
    b.vertex(x - cx, y, z - cz, 0, 1, 0, deep[0], deep[1], deep[2]);
    b.vertex(x + rx * hw - cx, y, z + rz * hw - cz, 0, 1, 0, shallow[0], shallow[1], shallow[2]);
    if (prev >= 0) {
      b.tri(prev, base, prev + 1); b.tri(prev + 1, base, base + 1);
      b.tri(prev + 1, base + 1, prev + 2); b.tri(prev + 2, base + 1, base + 2);
    }
    prev = base;
  }
  return b.build();
}

/** Single grass clump archetype (several tapered blades). */
export function grassClump(): GeometryData {
  const r = mulberry32(77);
  const b = new MeshBuilder();
  const blades = 6;
  for (let i = 0; i < blades; i++) {
    const a = r() * Math.PI * 2;
    const ox = Math.cos(a) * 0.12 * r(), oz = Math.sin(a) * 0.12 * r();
    const h = 0.32 + r() * 0.3;
    const w = 0.035;
    const lean = 0.12 + r() * 0.12;
    const dirA = r() * Math.PI * 2;
    const lx = Math.cos(dirA) * lean, lz = Math.sin(dirA) * lean;
    const px = -Math.sin(dirA) * w, pz = Math.cos(dirA) * w;
    const c0: C3 = [0.17, 0.3, 0.09];
    const c1: C3 = [0.43, 0.58, 0.22];
    const cm = mix3(c0, c1, 0.55);
    const v0 = b.vertex(ox - px, 0, oz - pz, 0, 1, 0, c0[0], c0[1], c0[2]);
    const v1 = b.vertex(ox + px, 0, oz + pz, 0, 1, 0, c0[0], c0[1], c0[2]);
    const v2 = b.vertex(ox + lx * 0.4 + px * 0.7, h * 0.55, oz + lz * 0.4 + pz * 0.7, 0, 1, 0, cm[0], cm[1], cm[2]);
    const v3 = b.vertex(ox + lx * 0.4 - px * 0.7, h * 0.55, oz + lz * 0.4 - pz * 0.7, 0, 1, 0, cm[0], cm[1], cm[2]);
    const v4 = b.vertex(ox + lx, h, oz + lz, 0, 1, 0, c1[0], c1[1], c1[2]);
    b.tri(v0, v1, v2); b.tri(v0, v2, v3); b.tri(v3, v2, v4);
  }
  return b.build();
}

export const GRASS_CELL = 8;

/**
 * Grass instance payload for a terrain patch: clump matrices (region-local) grouped
 * into GRASS_CELL x GRASS_CELL cells so presentation can cull per cell.
 * instances: 16 floats per clump. cellStart/cellCount describe the grouping.
 */
export interface GrassPayload {
  matrices: Float32Array;
  count: number;
  cellStart: Int32Array;
  cellCount: Int32Array;
  cellCenter: Float32Array; // x, y, z per cell (region-local x/z, absolute y)
  cellsPerSide: number;
  bytes: number;
}

export function grassPatch(terrain: TerrainField, def: ProceduralDef, density: number): GrassPayload {
  const [cx, cz, size] = def.params;
  const r: Rng = mulberry32(def.seed ^ 0x6a55);
  const cps = Math.ceil(size / GRASS_CELL);
  const cellStart = new Int32Array(cps * cps);
  const cellCount = new Int32Array(cps * cps);
  const cellCenter = new Float32Array(cps * cps * 3);
  const mats: number[] = [];
  const tmp = new Float32Array(16);
  let count = 0;
  for (let cj = 0; cj < cps; cj++) for (let ci = 0; ci < cps; ci++) {
    const c = cj * cps + ci;
    cellStart[c] = count;
    const ccx = cx - size / 2 + (ci + 0.5) * GRASS_CELL, ccz = cz - size / 2 + (cj + 0.5) * GRASS_CELL;
    cellCenter[c * 3] = ccx - cx;
    cellCenter[c * 3 + 1] = terrain.height(ccx, ccz);
    cellCenter[c * 3 + 2] = ccz - cz;
    const meadow = smoothstep(-0.1, -0.45, terrain.densityNoise(ccx, ccz));
    const target = Math.round(GRASS_CELL * GRASS_CELL * density * (0.45 + 1.1 * meadow));
    for (let k = 0; k < target; k++) {
      const x = ccx + (r() - 0.5) * GRASS_CELL, z = ccz + (r() - 0.5) * GRASS_CELL;
      const td = terrain.trailDistance(x, z);
      if (td < terrain.trailHalfWidth + 0.15) continue;
      if (td < terrain.trailHalfWidth + 0.9 && r() < 0.6) continue;
      if (terrain.streamDistance(x, z) < terrain.streamHalfWidth + 0.8) continue;
      const y = terrain.height(x, z);
      const s = 0.7 + r() * 0.7;
      composeYawMatrix(tmp, 0, x - cx, y - 0.02, z - cz, r() * 6.283, s, s * (0.8 + r() * 0.5), s);
      for (let q = 0; q < 16; q++) mats.push(tmp[q]);
      count++;
    }
    cellCount[c] = count - cellStart[c];
  }
  const matrices = new Float32Array(mats);
  return {
    matrices, count, cellStart, cellCount, cellCenter, cellsPerSide: cps,
    bytes: matrices.byteLength + cellStart.byteLength + cellCount.byteLength + cellCenter.byteLength,
  };
}
