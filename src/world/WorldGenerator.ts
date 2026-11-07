/**
 * Procedural authoring of the forest world *as data*.
 *
 * Produces entities, relationships, frames and descriptors. No geometry is
 * created here: trees are an archetype id + a local reference in a region frame.
 */
import { WorldDatabase } from './WorldDatabase';
import { FrameSystem } from './FrameSystem';
import { TerrainField } from './TerrainField';
import { Curve, CurveProjection } from './Curve';
import { ColliderShape, Family, Flag, FrameMode, Kind, Rel } from './types';
import { mulberry32, hash2, Rng } from '../util/rng';

export interface StressConfig {
  /** Extra trees scattered anywhere (mostly outside the camera's typical view). */
  extraTrees: number;
  /** Very tall shadow casters placed in bands beside the trail. */
  tallCasters: number;
  /** Extra light emitters scattered in the forest. */
  extraLights: number;
}

export interface WorldConfig {
  seed: number;
  size: number;
  regionSize: number;
  /** Multiplier on all vegetation/rock densities. */
  density: number;
  stress: StressConfig;
}

export const DEFAULT_WORLD: WorldConfig = {
  seed: 1337,
  size: 768,
  regionSize: 64,
  density: 1,
  stress: { extraTrees: 0, tallCasters: 0, extraLights: 0 },
};

export interface Archetypes {
  pine: number[];
  oak: number[];
  birch: number[];
  rock: number[];
  bush: number[];
  fern: number[];
  lantern: number;
  pillar: number;
}

export interface BuiltWorld {
  config: WorldConfig;
  db: WorldDatabase;
  terrain: TerrainField;
  frames: FrameSystem;
  root: number;
  forest: number;
  trail: number;
  stream: number;
  trailCurve: Curve;
  streamCurve: Curve;
  regions: Int32Array;
  regionDim: number;
  terrainPatches: number[];
  waterPatches: number[];
  bridges: number[];
  lanterns: number[];
  player: number;
  archetypes: Archetypes;
  buildMs: number;
  counts: Record<string, number>;
}

/** Trail control points: a winding closed loop through the forest. */
function trailPoints(rng: Rng, half: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = half * (0.52 + 0.2 * Math.sin(a * 3 + 0.7) + 0.12 * (rng() - 0.5));
    pts.push([Math.cos(a) * r, Math.sin(a) * r * 0.92]);
  }
  return pts;
}

/** Stream: meanders across the world, crossing the trail loop. */
function streamPoints(rng: Rng, half: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = -half * 1.05 + t * half * 2.1;
    const z = half * (0.25 * Math.sin(t * 7.1 + 0.4) + 0.08 * (rng() - 0.5)) - half * 0.1;
    pts.push([x, z]);
  }
  return pts;
}

export function buildWorld(config: WorldConfig): BuiltWorld {
  const t0 = performance.now();
  const rng = mulberry32(config.seed);
  const db = new WorldDatabase(32768);
  const half = config.size / 2;
  const terrain = new TerrainField(config.seed, config.size);
  const frames = new FrameSystem(db);
  frames.terrain = terrain;

  // ---------------------------------------------------------------- descriptors
  const M = {
    bark: db.addMaterial({ name: 'bark', kind: 'bark', roughness: 0.95, metalness: 0, wind: 0.05, emissive: 0 }),
    needles: db.addMaterial({ name: 'needles', kind: 'foliage', roughness: 0.85, metalness: 0, wind: 0.6, emissive: 0 }),
    leaves: db.addMaterial({ name: 'leaves', kind: 'foliage', roughness: 0.8, metalness: 0, wind: 0.8, emissive: 0 }),
    rock: db.addMaterial({ name: 'rock', kind: 'rock', roughness: 0.92, metalness: 0, wind: 0, emissive: 0 }),
    terrain: db.addMaterial({ name: 'terrain', kind: 'terrain', roughness: 1, metalness: 0, wind: 0, emissive: 0 }),
    wood: db.addMaterial({ name: 'planks', kind: 'wood', roughness: 0.85, metalness: 0, wind: 0, emissive: 0 }),
    water: db.addMaterial({ name: 'water', kind: 'water', roughness: 0.08, metalness: 0, wind: 0, emissive: 0 }),
    lamp: db.addMaterial({ name: 'lantern', kind: 'lamp', roughness: 0.6, metalness: 0.2, wind: 0, emissive: 1 }),
    generic: db.addMaterial({ name: 'stress', kind: 'generic', roughness: 0.9, metalness: 0, wind: 0, emissive: 0 }),
  };
  const P = {
    pine: db.addPhysical({ shape: ColliderShape.Cylinder, dims: [0.34, 9], surface: 'litter', friction: 1 }),
    oak: db.addPhysical({ shape: ColliderShape.Cylinder, dims: [0.48, 4.5], surface: 'litter', friction: 1 }),
    birch: db.addPhysical({ shape: ColliderShape.Cylinder, dims: [0.22, 9], surface: 'litter', friction: 1 }),
    rock: db.addPhysical({ shape: ColliderShape.Sphere, dims: [0.9, 0.25], surface: 'rock', friction: 0.9 }),
    lantern: db.addPhysical({ shape: ColliderShape.Cylinder, dims: [0.12, 2.2], surface: 'wood', friction: 1 }),
    pillar: db.addPhysical({ shape: ColliderShape.Cylinder, dims: [0.6, 20], surface: 'rock', friction: 1 }),
  };
  const A = {
    stream: db.addAcoustic({ sound: 'stream', gain: 0.55, radius: 34 }),
    bird: db.addAcoustic({ sound: 'bird', gain: 0.35, radius: 42 }),
  };
  const Lt = {
    lantern: db.addLight({ color: [1.0, 0.72, 0.38], intensity: 6, range: 14, nightOnly: true }),
    wisp: db.addLight({ color: [0.45, 0.85, 1.0], intensity: 4, range: 11, nightOnly: true }),
  };

  // archetypes (shared procedural definitions)
  const treeLod = [45 * 45, 115 * 115];
  const mk = (family: Family, variants: number, lodCount: number, lodDist2: number[], maxDraw: number, material: number) => {
    const ids: number[] = [];
    for (let v = 0; v < variants; v++) {
      ids.push(db.addDef({ family, variant: v, seed: hash2(config.seed, family * 100 + v), lodCount, lodDist2, maxDrawDist: maxDraw, params: [], shared: true, material }));
    }
    return ids;
  };
  const archetypes: Archetypes = {
    pine: mk(Family.Pine, 5, 3, treeLod, 330, M.needles),
    oak: mk(Family.Oak, 3, 3, treeLod, 330, M.leaves),
    birch: mk(Family.Birch, 3, 3, treeLod, 330, M.leaves),
    rock: mk(Family.Rock, 6, 3, [28 * 28, 75 * 75], 210, M.rock),
    bush: mk(Family.Bush, 4, 2, [38 * 38], 130, M.leaves),
    fern: mk(Family.Fern, 3, 1, [], 52, M.leaves),
    lantern: mk(Family.Lantern, 1, 2, [40 * 40], 170, M.lamp)[0],
    pillar: mk(Family.StressPillar, 1, 2, [80 * 80], 330, M.generic)[0],
  };

  // ---------------------------------------------------------------- frames
  const root = db.create({ kind: Kind.Root, parent: -1, flags: Flag.Frame, name: 'World' });
  const forest = db.create({ kind: Kind.Forest, parent: root, flags: Flag.Frame, name: 'Forest' });
  const trailCurve = new Curve(trailPoints(rng, half), true, 1, terrain.trailHalfWidth);
  const streamCurve = new Curve(streamPoints(rng, half), false, 1, terrain.streamHalfWidth);
  const trail = db.create({ kind: Kind.Trail, parent: forest, flags: Flag.Frame, name: 'Trail' });
  const stream = db.create({ kind: Kind.Stream, parent: forest, flags: Flag.Frame, name: 'Stream' });
  db.curves.set(trail, trailCurve);
  db.curves.set(stream, streamCurve);
  db.relate(trail, Rel.PartOf, forest);
  db.relate(stream, Rel.PartOf, forest);
  frames.refreshCurves();
  // terrain carving uses world-space copies of the curves (forest/trail frames are at the origin here)
  terrain.attachCurves(trailCurve, streamCurve);

  // regions: a grid of local reference frames, each also a terrain patch owner
  const rs = config.regionSize;
  const dim = Math.round(config.size / rs);
  const regions = new Int32Array(dim * dim);
  const terrainPatches: number[] = [];
  const waterPatches: number[] = [];
  const proj: CurveProjection = { s: 0, lateral: 0, dist: 0, seg: 0 };
  for (let iz = 0; iz < dim; iz++) {
    for (let ix = 0; ix < dim; ix++) {
      const cx = -half + (ix + 0.5) * rs;
      const cz = -half + (iz + 0.5) * rs;
      const r = db.create({ kind: Kind.Region, parent: forest, x: cx, y: 0, z: cz, flags: Flag.Frame, name: `Region ${ix},${iz}` });
      regions[iz * dim + ix] = r;
      db.relate(r, Rel.PartOf, forest);
      // patch bounds: sample heights coarsely
      let minH = Infinity, maxH = -Infinity;
      for (let sz = 0; sz <= 4; sz++) for (let sx = 0; sx <= 4; sx++) {
        const h = terrain.height(cx - rs / 2 + (sx / 4) * rs, cz - rs / 2 + (sz / 4) * rs);
        minH = Math.min(minH, h); maxH = Math.max(maxH, h);
      }
      minH -= 3; maxH += 3;
      const patchDef = db.addDef({ family: Family.TerrainPatch, variant: 0, seed: hash2(config.seed, 9000 + r), lodCount: 3, lodDist2: [110 * 110, 230 * 230], maxDrawDist: 2000, params: [cx, cz, rs, ix, iz], shared: false, material: M.terrain });
      const ext = (maxH - minH) / 2;
      const patch = db.create({
        kind: Kind.TerrainPatch, parent: r, x: 0, y: 0, z: 0,
        flags: Flag.Visual | Flag.Terrain | Flag.ReceivesShadow, def: patchDef,
        radius: Math.sqrt((rs / 2) * (rs / 2) * 2 + ext * ext), centerY: (minH + maxH) / 2,
      });
      terrainPatches.push(patch);
      db.relate(patch, Rel.PartOf, r);
      // water patch if the stream passes through
      let hasWater = false;
      for (let sz = 0; sz <= 8 && !hasWater; sz++) for (let sx = 0; sx <= 8; sx++) {
        streamCurve.nearest(cx - rs / 2 + (sx / 8) * rs, cz - rs / 2 + (sz / 8) * rs, proj);
        if (proj.dist < rs / 8 + 3) { hasWater = true; break; }
      }
      if (hasWater) {
        const wDef = db.addDef({ family: Family.WaterPatch, variant: 0, seed: 0, lodCount: 1, lodDist2: [], maxDrawDist: 600, params: [cx, cz, rs], shared: false, material: M.water });
        const w = db.create({
          kind: Kind.WaterPatch, parent: r, flags: Flag.Visual | Flag.Water | Flag.ReceivesShadow, def: wDef,
          radius: (rs / 2) * 1.5, centerY: (minH + maxH) / 2,
        });
        waterPatches.push(w);
        db.relate(w, Rel.PartOf, stream);
      }
    }
  }
  const regionAt = (x: number, z: number) => {
    const ix = Math.max(0, Math.min(dim - 1, Math.floor((x + half) / rs)));
    const iz = Math.max(0, Math.min(dim - 1, Math.floor((z + half) / rs)));
    return { r: regions[iz * dim + ix], cx: -half + (ix + 0.5) * rs, cz: -half + (iz + 0.5) * rs };
  };

  // ---------------------------------------------------------------- bridges where trail crosses stream
  const bridges: number[] = [];
  const crossings: number[] = [];
  {
    let prevSide = 0;
    for (let i = 0; i < trailCurve.n; i++) {
      streamCurve.nearest(trailCurve.px[i], trailCurve.pz[i], proj);
      if (proj.dist === Infinity) { prevSide = 0; continue; }
      const side = Math.sign(proj.lateral);
      if (prevSide !== 0 && side !== prevSide && proj.dist < 3) crossings.push(i * trailCurve.spacing);
      prevSide = side;
    }
  }
  for (const s of crossings) {
    const seg = trailCurve.segmentAt(s);
    // crossing angle: compare trail direction with stream direction
    const x = trailCurve.px[seg], z = trailCurve.pz[seg];
    streamCurve.nearest(x, z, proj);
    const sseg = proj.seg >= 0 ? proj.seg : 0;
    const dot = Math.abs(trailCurve.dx[seg] * streamCurve.dx[sseg] + trailCurve.dz[seg] * streamCurve.dz[sseg]);
    const sinA = Math.sqrt(Math.max(0.05, 1 - dot * dot));
    const halfLen = Math.min(26, Math.max(8, (terrain.streamHalfWidth + terrain.streamValley + 1.5) / sinA));
    const bDef = db.addDef({ family: Family.Bridge, variant: 0, seed: hash2(config.seed, Math.round(s)), lodCount: 2, lodDist2: [90 * 90], maxDrawDist: 420, params: [halfLen, 1.7], shared: false, material: M.wood });
    const bPhys = db.addPhysical({ shape: ColliderShape.BridgeDeck, dims: [halfLen, 1.7, 0.25, 1.1], surface: 'wood', friction: 1 });
    const b = db.create({
      kind: Kind.Bridge, parent: trail, mode: FrameMode.Curve, x: s, y: 0.32, z: 0,
      flags: Flag.Visual | Flag.Collider | Flag.CastsShadow, def: bDef, physical: bPhys,
      radius: halfLen + 1, centerY: -0.5, name: `Bridge @ s=${s.toFixed(0)}m`,
    });
    db.relate(b, Rel.On, trail, s);
    db.relate(b, Rel.Spans, stream);
    bridges.push(b);
  }
  const nearBridge = (x: number, z: number, margin: number) => {
    for (const b of bridges) {
      const o = frames.resolve(b);
      const W = frames.world;
      const dx = x - W[o], dz = z - W[o + 2];
      const r = db.defs[db.def[b]].params[0] + margin;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };

  // ---------------------------------------------------------------- lanterns along the trail (curve-relative)
  const lanterns: number[] = [];
  for (let s = 20, k = 0; s < trailCurve.length - 10; s += 42, k++) {
    const side = k % 2 === 0 ? 1 : -1;
    const lat = side * (terrain.trailHalfWidth + 1.1);
    const tmp = [0, 0, 0, 0];
    trailCurve.sample(s, tmp);
    const wx = tmp[0] + Math.cos(tmp[2]) * lat, wz = tmp[1] - Math.sin(tmp[2]) * lat;
    if (nearBridge(wx, wz, 2) || terrain.streamDistance(wx, wz) < 6) continue;
    const e = db.create({
      kind: Kind.Lantern, parent: trail, mode: FrameMode.Curve, x: s, y: terrain.height(wx, wz) - trailCurve.profileAt(s), z: lat,
      yaw: side > 0 ? Math.PI : 0,
      flags: Flag.Visual | Flag.Collider | Flag.CastsShadow | Flag.EmitsLight, def: archetypes.lantern, physical: P.lantern, light: Lt.lantern,
      radius: 1.6, centerY: 1.3,
    });
    db.relate(e, Rel.On, trail, s);
    db.relate(e, Rel.Illuminates, trail, s);
    lanterns.push(e);
  }

  // ---------------------------------------------------------------- vegetation & rocks (grounded in region frames)
  const dens = config.density;
  const treeIds: number[] = [];
  const place = (
    kind: Kind, cell: number, accept: (x: number, z: number, r: Rng) => number | null,
    make: (x: number, z: number, choice: number, r: Rng) => void,
  ) => {
    const c = cell / Math.sqrt(dens);
    const n = Math.ceil(config.size / c);
    for (let gz = 0; gz < n; gz++) {
      for (let gx = 0; gx < n; gx++) {
        const r = mulberry32(hash2(config.seed * 31 + kind, gz * 4099 + gx));
        const x = -half + (gx + r()) * c;
        const z = -half + (gz + r()) * c;
        if (Math.abs(x) > half - 3 || Math.abs(z) > half - 3) continue;
        const choice = accept(x, z, r);
        if (choice === null) continue;
        make(x, z, choice, r);
      }
    }
  };
  const groundedChild = (x: number, z: number) => regionAt(x, z);

  // Trees
  place(Kind.Tree, 6.6, (x, z, r) => {
    const td = terrain.trailDistance(x, z);
    if (td < terrain.trailHalfWidth + 2.0) return null;
    if (terrain.streamDistance(x, z) < terrain.streamHalfWidth + 2.6) return null;
    if (nearBridge(x, z, 3)) return null;
    const d = terrain.densityNoise(x, z);
    let p = 0.62 + 0.55 * d;
    if (d < -0.38) p = 0.03; // clearings / meadows
    if (td < 9) p *= 0.8;
    if (r() > p) return null;
    const h = terrain.baseHeight(x, z);
    const sd = terrain.streamDistance(x, z);
    const u = r();
    if (sd < 22 && u < 0.55) return 2; // birch near water
    if (h > 10 || u < 0.58) return 0; // pine
    return u < 0.82 ? 1 : 2;
  }, (x, z, species, r) => {
    const reg = groundedChild(x, z);
    const list = species === 0 ? archetypes.pine : species === 1 ? archetypes.oak : archetypes.birch;
    const def = list[Math.floor(r() * list.length)];
    const scale = 0.72 + r() * 0.62;
    const height = species === 0 ? 14 : species === 1 ? 10.5 : 12;
    const e = db.create({
      kind: Kind.Tree, parent: reg.r, mode: FrameMode.Grounded, x: x - reg.cx, y: -0.15, z: z - reg.cz, yaw: r() * Math.PI * 2, scale,
      flags: Flag.Visual | Flag.Collider | Flag.CastsShadow, def,
      physical: species === 0 ? P.pine : species === 1 ? P.oak : P.birch,
      radius: height * 0.56, centerY: height * 0.5,
    });
    treeIds.push(e);
  });

  // Rocks
  place(Kind.Rock, 17, (x, z, r) => {
    const td = terrain.trailDistance(x, z);
    if (td < terrain.trailHalfWidth + 0.8) return null;
    if (nearBridge(x, z, 1)) return null;
    const sd = terrain.streamDistance(x, z);
    let p = 0.32 + 0.3 * terrain.detail(x * 0.7, z * 0.7);
    if (sd < 14) p += 0.35;
    if (sd < terrain.streamHalfWidth) p = 0.25;
    return r() < p ? 0 : null;
  }, (x, z, _c, r) => {
    const reg = groundedChild(x, z);
    const scale = 0.45 + Math.pow(r(), 2.2) * 2.3;
    const sx = 0.8 + r() * 0.6, sy = 0.55 + r() * 0.5, sz = 0.8 + r() * 0.6;
    db.create({
      kind: Kind.Rock, parent: reg.r, mode: FrameMode.Grounded, x: x - reg.cx, y: -0.25 * scale * sy, z: z - reg.cz, yaw: r() * 6.28, scale,
      shape: [sx, sy, sz],
      flags: Flag.Visual | Flag.Collider | Flag.CastsShadow, def: archetypes.rock[Math.floor(r() * archetypes.rock.length)],
      physical: P.rock, radius: 1.1 * Math.max(sx, sy, sz), centerY: 0.2,
    });
  });

  // Bushes
  place(Kind.Bush, 9.5, (x, z, r) => {
    const td = terrain.trailDistance(x, z);
    if (td < terrain.trailHalfWidth + 0.6) return null;
    if (terrain.streamDistance(x, z) < terrain.streamHalfWidth + 0.8) return null;
    if (nearBridge(x, z, 0.5)) return null;
    let p = 0.35 + 0.35 * terrain.densityNoise(x + 40, z - 40);
    if (td < 7) p += 0.35;
    return r() < p ? 0 : null;
  }, (x, z, _c, r) => {
    const reg = groundedChild(x, z);
    const scale = 0.6 + r() * 0.9;
    db.create({
      kind: Kind.Bush, parent: reg.r, mode: FrameMode.Grounded, x: x - reg.cx, y: -0.1, z: z - reg.cz, yaw: r() * 6.28, scale,
      flags: Flag.Visual | Flag.CastsShadow, def: archetypes.bush[Math.floor(r() * archetypes.bush.length)],
      radius: 1.5, centerY: 0.7,
    });
  });

  // Ferns: dense along the trail edges, sparse elsewhere
  place(Kind.Fern, 6.2, (x, z, r) => {
    const td = terrain.trailDistance(x, z);
    if (td < terrain.trailHalfWidth + 0.35) return null;
    if (terrain.streamDistance(x, z) < terrain.streamHalfWidth + 0.4) return null;
    if (nearBridge(x, z, 0)) return null;
    let p = 0.18;
    if (td < 8) p = 0.9;
    return r() < p ? 0 : null;
  }, (x, z, _c, r) => {
    const reg = groundedChild(x, z);
    db.create({
      kind: Kind.Fern, parent: reg.r, mode: FrameMode.Grounded, x: x - reg.cx, y: -0.05, z: z - reg.cz, yaw: r() * 6.28, scale: 0.7 + r() * 0.7,
      flags: Flag.Visual, def: archetypes.fern[Math.floor(r() * archetypes.fern.length)],
      radius: 0.9, centerY: 0.35,
    });
  });

  // Birds perched on trees (positioned relative to the tree's own frame)
  const birdRng = mulberry32(config.seed ^ 0xb1ad);
  const birdCount = Math.min(70, Math.floor(treeIds.length / 120));
  for (let i = 0; i < birdCount; i++) {
    const tree = treeIds[Math.floor(birdRng() * treeIds.length)];
    const e = db.create({ kind: Kind.Bird, parent: tree, x: 0, y: 9, z: 0, flags: Flag.EmitsSound, acoustic: A.bird, radius: 0.3 });
    db.relate(e, Rel.PerchedOn, tree);
    db.state[e * 4] = birdRng() * 10; // call phase
  }

  // Stream audio emitters along the stream (curve-relative)
  for (let s = 8; s < streamCurve.length; s += 22) {
    const e = db.create({ kind: Kind.AudioEmitter, parent: stream, mode: FrameMode.Curve, x: s, y: 0.6, z: 0, flags: Flag.EmitsSound, acoustic: A.stream, radius: 0.5 });
    db.relate(e, Rel.EmittedBy, stream, s);
  }

  // ---------------------------------------------------------------- stress content (Test D)
  const st = config.stress;
  if (st.extraTrees > 0) {
    const r = mulberry32(config.seed ^ 0x5a5a);
    let made = 0, guard = 0;
    while (made < st.extraTrees && guard++ < st.extraTrees * 4) {
      const x = (r() * 2 - 1) * (half - 4), z = (r() * 2 - 1) * (half - 4);
      if (terrain.trailDistance(x, z) < 4 || terrain.streamDistance(x, z) < 4) continue;
      const reg = regionAt(x, z);
      const list = r() < 0.6 ? archetypes.pine : archetypes.oak;
      const scale = 0.7 + r() * 0.6;
      db.create({
        kind: Kind.StressObject, parent: reg.r, mode: FrameMode.Grounded, x: x - reg.cx, y: -0.15, z: z - reg.cz, yaw: r() * 6.28, scale,
        flags: Flag.Visual | Flag.Collider | Flag.CastsShadow, def: list[Math.floor(r() * list.length)], physical: P.pine,
        radius: 14 * 0.56, centerY: 7,
      });
      made++;
    }
  }
  if (st.tallCasters > 0) {
    const r = mulberry32(config.seed ^ 0x7c7c);
    for (let i = 0; i < st.tallCasters; i++) {
      const s = r() * trailCurve.length;
      const tmp = [0, 0, 0, 0];
      trailCurve.sample(s, tmp);
      const lat = (r() < 0.5 ? -1 : 1) * (14 + r() * 26);
      const x = tmp[0] + Math.cos(tmp[2]) * lat, z = tmp[1] - Math.sin(tmp[2]) * lat;
      if (Math.abs(x) > half - 4 || Math.abs(z) > half - 4) continue;
      const reg = regionAt(x, z);
      db.create({
        kind: Kind.StressObject, parent: reg.r, mode: FrameMode.Grounded, x: x - reg.cx, y: -0.3, z: z - reg.cz, yaw: r() * 6.28, scale: 1,
        shape: [1, 1.2 + r() * 0.8, 1],
        flags: Flag.Visual | Flag.Collider | Flag.CastsShadow, def: archetypes.pillar, physical: P.pillar,
        radius: 22, centerY: 18,
      });
    }
  }
  if (st.extraLights > 0) {
    const r = mulberry32(config.seed ^ 0x11ee);
    for (let i = 0; i < st.extraLights; i++) {
      const x = (r() * 2 - 1) * (half - 8), z = (r() * 2 - 1) * (half - 8);
      const reg = regionAt(x, z);
      db.create({
        kind: Kind.StressObject, parent: reg.r, mode: FrameMode.Grounded, x: x - reg.cx, y: 1.4, z: z - reg.cz,
        flags: Flag.EmitsLight, light: Lt.wisp, radius: 0.4,
      });
    }
  }

  // ---------------------------------------------------------------- player (trail-relative)
  const player = db.create({
    kind: Kind.Player, parent: trail, mode: FrameMode.Curve, x: 6, y: 0, z: 0,
    flags: Flag.Dynamic | Flag.Collider | Flag.CastsShadow | Flag.Visual, radius: 1, centerY: 0.9, name: 'Player',
  });
  db.relate(player, Rel.On, trail, 6);

  const buildMs = performance.now() - t0;
  return {
    config, db, terrain, frames, root, forest, trail, stream, trailCurve, streamCurve, regions, regionDim: dim,
    terrainPatches, waterPatches, bridges, lanterns, player, archetypes, buildMs, counts: db.countByKind(),
  };
}
