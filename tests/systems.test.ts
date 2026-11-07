import { describe, it, expect } from 'vitest';
import { WorldDatabase } from '../src/world/WorldDatabase';
import { FrameSystem } from '../src/world/FrameSystem';
import { TerrainField } from '../src/world/TerrainField';
import { Curve } from '../src/world/Curve';
import { ColliderShape, Family, Flag, FrameMode, Kind } from '../src/world/types';
import { SpatialIndex } from '../src/spatial/SpatialIndex';
import { Discovery } from '../src/spatial/Discovery';
import { QueryCache } from '../src/spatial/QueryCache';
import { PhysicsSystem, CharacterBody, MoveIntent } from '../src/systems/PhysicsSystem';
import { VisibilitySystem } from '../src/systems/VisibilitySystem';
import { ShadowSystem } from '../src/systems/ShadowSystem';
import { Observation } from '../src/systems/Observation';
import { generateArchetype, terrainPatch, grassClump } from '../src/geometry/Generators';
import { GeometryStore } from '../src/geometry/GeometryStore';
import { MeshBuilder, icosphere } from '../src/geometry/MeshBuilder';
import { summarize, onePercentLow } from '../src/diagnostics/FrameStats';
import { makeScript } from '../src/bench/Benchmark';

class FlatTerrain extends TerrainField {
  constructor() { super(1, 512); }
  override height(): number { return 0; }
  override waterLevel(): number { return -Infinity; }
}

function physicsWorld() {
  const db = new WorldDatabase(64);
  const fs = new FrameSystem(db);
  const terrain = new FlatTerrain();
  fs.terrain = terrain;
  const root = db.create({ kind: Kind.Root, parent: -1, flags: Flag.Frame });
  const trail = db.create({ kind: Kind.Trail, parent: root, flags: Flag.Frame });
  const curve = new Curve([[-200, 0], [0, 0.01], [200, 0]], false, 1);
  curve.buildAccel(20);
  db.curves.set(trail, curve);
  terrain.trail = null;
  fs.refreshCurves();
  const trunk = db.addPhysical({ shape: ColliderShape.Cylinder, dims: [0.5, 10], surface: 'litter', friction: 1 });
  const tree = db.create({ kind: Kind.Tree, parent: root, mode: FrameMode.Grounded, x: 5, z: 0, flags: Flag.Collider | Flag.Visual | Flag.CastsShadow, physical: trunk, radius: 6, centerY: 5 });
  const player = db.create({ kind: Kind.Player, parent: root, x: 0, y: 0, z: 0, flags: Flag.Dynamic });
  const index = new SpatialIndex(-256, -256, 512, 6);
  const discovery = new Discovery(db, fs, index);
  discovery.rebuild();
  const physics = new PhysicsSystem(db, fs, terrain, discovery, new QueryCache(), trail, () => root, 256);
  return { db, fs, physics, tree, player, discovery, index };
}

describe('physics (own analytic representation)', () => {
  it('stands on the analytic terrain and is blocked by a trunk cylinder', () => {
    const { physics, player } = physicsWorld();
    const body = new CharacterBody();
    physics.readBody(player, body);
    body.y = 0.5;
    const intent: MoveIntent = { dirX: 1, dirZ: 0, magnitude: 1, sprint: false, jump: false };
    for (let i = 0; i < 240; i++) physics.step(body, intent, 1 / 60);
    expect(body.grounded).toBe(true);
    expect(body.y).toBeCloseTo(0, 6);
    // trunk at x=5, radius 0.5 + body radius 0.38
    expect(body.x).toBeLessThanOrEqual(5 - 0.5 - 0.38 + 1e-6);
    expect(physics.contactCount).toBeGreaterThan(0);
  });

  it('jumps and lands', () => {
    const { physics, player } = physicsWorld();
    const body = new CharacterBody();
    physics.readBody(player, body);
    const idle: MoveIntent = { dirX: 0, dirZ: 0, magnitude: 0, sprint: false, jump: false };
    physics.step(body, idle, 1 / 60);
    physics.step(body, { ...idle, jump: true }, 1 / 60);
    let maxY = 0;
    for (let i = 0; i < 120; i++) { physics.step(body, idle, 1 / 60); maxY = Math.max(maxY, body.y); }
    expect(maxY).toBeGreaterThan(1);
    expect(body.grounded).toBe(true);
  });

  it('a zero time step is ignored (no NaN state)', () => {
    const { physics, player } = physicsWorld();
    const body = new CharacterBody();
    physics.readBody(player, body);
    physics.step(body, { dirX: 1, dirZ: 0, magnitude: 1, sprint: false, jump: false }, 0);
    expect(Number.isFinite(body.speed)).toBe(true);
  });
});

describe('shadow contributors', () => {
  it('finds an off-screen caster toward the sun but not one away from it', () => {
    const db = new WorldDatabase(32);
    const fs = new FrameSystem(db);
    fs.terrain = new FlatTerrain();
    const root = db.create({ kind: Kind.Root, parent: -1, flags: Flag.Frame });
    const def = db.addDef({ family: Family.Pine, variant: 0, seed: 1, lodCount: 3, lodDist2: [45 * 45, 115 * 115], maxDrawDist: 330, params: [], shared: true, material: 0 });
    // camera at origin looking -Z; sun from +X, low elevation
    const towardSun = db.create({ kind: Kind.Tree, parent: root, mode: FrameMode.Grounded, x: 22, z: -15, flags: Flag.Visual | Flag.CastsShadow, def, radius: 8, centerY: 7 });
    const awayFromSun = db.create({ kind: Kind.Tree, parent: root, mode: FrameMode.Grounded, x: -60, z: -15, flags: Flag.Visual | Flag.CastsShadow, def, radius: 8, centerY: 7 });
    const index = new SpatialIndex(-256, -256, 512, 6);
    const discovery = new Discovery(db, fs, index);
    discovery.rebuild();
    const obs = new Observation();
    obs.frame = 1;
    obs.setFromLook(0, 1.7, 0, 0, 1.7, -10, 0.5, 1, 0.25, 300);
    const vis = new VisibilitySystem();
    const qc = new QueryCache();
    vis.evaluate(obs, discovery, qc, db);
    expect(Array.from(vis.visible.data.subarray(0, vis.visible.length))).not.toContain(towardSun);
    const sh = new ShadowSystem();
    const s = Math.hypot(1, 0.35);
    sh.evaluate(obs, 1 / s, 0.35 / s, 0, 1, discovery, qc, db, vis, false);
    const list = Array.from(sh.shadowOnly.data.subarray(0, sh.shadowOnly.length));
    expect(list).toContain(towardSun);
    expect(list).not.toContain(awayFromSun);
  });
});

describe('geometry evaluation', () => {
  it('produces valid indexed meshes for every family and LOD', () => {
    const fams = [Family.Pine, Family.Oak, Family.Birch, Family.Rock, Family.Bush, Family.Fern, Family.Lantern, Family.Bridge, Family.StressPillar];
    for (const f of fams) {
      for (let lod = 0; lod < 3; lod++) {
        const g = generateArchetype({ id: 0, family: f, variant: 0, seed: 123, lodCount: 3, lodDist2: [], maxDrawDist: 100, params: [10, 1.7], shared: true, material: 0 }, lod);
        expect(g.vertexCount).toBeGreaterThan(0);
        let maxIdx = 0;
        for (let i = 0; i < g.index.length; i++) maxIdx = Math.max(maxIdx, g.index[i]);
        expect(maxIdx).toBeLessThan(g.vertexCount);
        expect(g.bytes).toBe(g.positions.byteLength + g.normals.byteLength + g.colors.byteLength + g.index.byteLength);
        for (let i = 0; i < g.normals.length; i += 3) {
          const l = Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]);
          expect(l).toBeGreaterThan(0.98);
          expect(l).toBeLessThan(1.02);
        }
      }
    }
    expect(grassClump().triangleCount).toBe(18);
  });

  it('coarser LODs have fewer triangles', () => {
    for (const f of [Family.Pine, Family.Oak, Family.Birch, Family.Rock]) {
      const t = [0, 1, 2].map((lod) => generateArchetype({ id: 0, family: f, variant: 1, seed: 9, lodCount: 3, lodDist2: [], maxDrawDist: 100, params: [], shared: true, material: 0 }, lod).triangleCount);
      expect(t[0]).toBeGreaterThan(t[1]);
      expect(t[1]).toBeGreaterThan(t[2]);
    }
  });

  it('icosphere faces wind outward', () => {
    const { verts, faces } = icosphere(1);
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
      const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
      const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const cx = verts[a] + verts[b] + verts[c], cy = verts[a + 1] + verts[b + 1] + verts[c + 1], cz = verts[a + 2] + verts[b + 2] + verts[c + 2];
      expect(nx * cx + ny * cy + nz * cz).toBeGreaterThan(0);
    }
  });

  it('terrain patches sample the analytic field exactly at vertices', () => {
    const t = new FlatTerrain();
    const g = terrainPatch(t, { id: 0, family: Family.TerrainPatch, variant: 0, seed: 1, lodCount: 3, lodDist2: [], maxDrawDist: 1000, params: [32, 32, 64], shared: false, material: 0 }, 1);
    expect(g.positions[1]).toBeCloseTo(0, 6);
  });

  it('cache retains under budget (LRU) and keep-while-observed disposes unobserved entries', () => {
    let generated = 0;
    const gen = () => { generated++; const b = new MeshBuilder(); b.vertex(0, 0, 0, 0, 1, 0, 1, 1, 1); b.vertex(1, 0, 0, 0, 1, 0, 1, 1, 1); b.vertex(0, 0, 1, 0, 1, 0, 1, 1, 1); b.tri(0, 1, 2); return { geometry: b.build() }; };
    const store = new GeometryStore(gen);
    store.retain = true;
    store.beginFrame(1);
    store.request(4, 0); store.request(8, 0);
    store.process(100); store.endFrame();
    expect(store.entries.size).toBe(2);
    store.beginFrame(2);
    expect(store.request(4, 0)).not.toBeNull();
    store.endFrame();
    expect(store.entries.size).toBe(2); // retained
    const oneEntry = store.peek(4)!.bytes;
    store.budgetBytes = oneEntry; // force eviction of the least recently used
    store.beginFrame(3);
    store.request(4, 0);
    store.endFrame();
    expect(store.peek(8)).toBeUndefined();
    expect(store.evictedTotal).toBe(1);
    // retain = false: anything not requested this frame is disposed
    store.retain = false;
    store.budgetBytes = 1e9;
    store.beginFrame(4);
    store.endFrame();
    expect(store.entries.size).toBe(0);
    expect(generated).toBe(2);
  });
});

describe('statistics', () => {
  it('summary and 1% low', () => {
    const v = Array.from({ length: 1000 }, (_, i) => (i < 10 ? 50 : 16.667));
    const s = summarize(v);
    expect(s.max).toBe(50);
    expect(s.median).toBeCloseTo(16.667, 3);
    expect(onePercentLow(v)).toBeCloseTo(20, 6);
    expect(Number.isNaN(onePercentLow(v.slice(0, 50)))).toBe(true);
  });

  it('benchmark camera scripts are deterministic (frame-indexed, not time-based)', () => {
    const a = makeScript('trail-run', 40, 600), b = makeScript('trail-run', 40, 600);
    for (let f = 100; f < 200; f++) {
      const pa = a(f, Math.random()), pb = b(f + 1000, 0);
      expect(pa).toEqual(pb);
    }
  });
});
