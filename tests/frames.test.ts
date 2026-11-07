import { describe, it, expect } from 'vitest';
import { WorldDatabase } from '../src/world/WorldDatabase';
import { FrameSystem } from '../src/world/FrameSystem';
import { TerrainField } from '../src/world/TerrainField';
import { Curve } from '../src/world/Curve';
import { FrameMode, Kind, Flag } from '../src/world/types';

class FlatTerrain extends TerrainField {
  constructor(private h = 2) { super(1, 512); }
  override height(x: number, z: number): number { return this.h + 0.01 * x - 0.02 * z; }
}

function setup(caching = true) {
  const db = new WorldDatabase(64);
  const fs = new FrameSystem(db);
  fs.caching = caching;
  fs.terrain = new FlatTerrain();
  const root = db.create({ kind: Kind.Root, parent: -1, flags: Flag.Frame });
  const forest = db.create({ kind: Kind.Forest, parent: root, x: 100, y: 0, z: -50, yaw: Math.PI / 2, scale: 2, flags: Flag.Frame });
  const region = db.create({ kind: Kind.Region, parent: forest, x: 10, y: 0, z: 0, flags: Flag.Frame });
  const tree = db.create({ kind: Kind.Tree, parent: region, mode: FrameMode.Grounded, x: 3, y: 0, z: 4, yaw: 0.3 });
  return { db, fs, root, forest, region, tree };
}

describe('reference frames', () => {
  it('composes parent rotation, scale and translation', () => {
    const { fs, region } = setup();
    const o = fs.resolve(region);
    // forest rotated +90° about Y and scaled 2: local (10,0,0) -> world offset (0,0,-20)
    expect(fs.world[o]).toBeCloseTo(100, 9);
    expect(fs.world[o + 2]).toBeCloseTo(-70, 9);
    expect(fs.world[o + 7]).toBeCloseTo(2, 9);
  });

  it('grounded entities take their height from the terrain field', () => {
    const { fs, tree, db } = setup();
    const o = fs.resolve(tree);
    const x = fs.world[o], z = fs.world[o + 2];
    expect(fs.world[o + 1]).toBeCloseTo(fs.terrain!.height(x, z), 9);
    void db;
  });

  it('reuses cached transforms and recomputes only invalidated branches', () => {
    const { db, fs, tree, forest } = setup(true);
    fs.resolve(tree);
    fs.resetStats();
    fs.resolve(tree);
    expect(fs.stats.recomputes).toBe(0);
    expect(fs.stats.hits).toBe(1);
    // moving the forest frame invalidates the whole chain below it
    db.setLocal(forest, 120, 0, -50);
    fs.resetStats();
    const o = fs.resolve(tree);
    expect(fs.stats.recomputes).toBe(3); // forest, region, tree
    expect(fs.world[o]).toBeGreaterThan(110);
  });

  it('uncached resolution recomputes the full chain every time but matches cached results', () => {
    const a = setup(true), b = setup(false);
    const oa = a.fs.resolve(a.tree), ob = b.fs.resolve(b.tree);
    for (let i = 0; i < 8; i++) expect(b.fs.world[ob + i]).toBeCloseTo(a.fs.world[oa + i], 12);
    b.fs.resetStats();
    b.fs.resolve(b.tree);
    expect(b.fs.stats.recomputes).toBe(4); // root, forest, region, tree
  });

  it('reference change preserves the world pose (Local, Grounded)', () => {
    const { db, fs, tree, region, root } = setup();
    const o = fs.resolve(tree);
    const wx = fs.world[o], wy = fs.world[o + 1] + 1.5, wz = fs.world[o + 2];
    const yaw = fs.worldYaw(tree);
    fs.reexpress(tree, root, FrameMode.Local, wx, wy, wz, yaw);
    expect(db.parent[tree]).toBe(root);
    const o2 = fs.resolve(tree);
    expect(fs.world[o2]).toBeCloseTo(wx, 9);
    expect(fs.world[o2 + 1]).toBeCloseTo(wy, 9);
    expect(fs.world[o2 + 2]).toBeCloseTo(wz, 9);
    expect(fs.worldYaw(tree)).toBeCloseTo(yaw, 9);
    fs.reexpress(tree, region, FrameMode.Grounded, wx, wy, wz, yaw);
    const o3 = fs.resolve(tree);
    expect(fs.world[o3 + 1]).toBeCloseTo(wy, 9);
    expect(db.local[tree * 8 + 1]).toBeCloseTo(1.5, 9); // stored as height above ground
  });

  it('curve-relative positions round-trip through world space', () => {
    const db = new WorldDatabase(16);
    const fs = new FrameSystem(db);
    const root = db.create({ kind: Kind.Root, parent: -1, flags: Flag.Frame });
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; pts.push([Math.cos(a) * 80, Math.sin(a) * 60]); }
    const curve = new Curve(pts, true, 1);
    for (let i = 0; i < curve.n; i++) curve.profile[i] = Math.sin(i * 0.05) * 3;
    const trail = db.create({ kind: Kind.Trail, parent: root, x: 5, z: -3, flags: Flag.Frame });
    db.curves.set(trail, curve);
    fs.refreshCurves();
    const p = db.create({ kind: Kind.Player, parent: trail, mode: FrameMode.Curve, x: 123.4, y: 0.5, z: 0.8, flags: Flag.Dynamic });
    const o = fs.resolve(p);
    const wx = fs.world[o], wy = fs.world[o + 1], wz = fs.world[o + 2], yaw = fs.worldYaw(p);
    // re-express in the same curve frame (projection) and compare
    fs.reexpress(p, trail, FrameMode.Curve, wx, wy, wz, yaw, 123.4);
    expect(db.local[p * 8]).toBeCloseTo(123.4, 4);
    expect(db.local[p * 8 + 2]).toBeCloseTo(0.8, 4);
    const o2 = fs.resolve(p);
    expect(Math.hypot(fs.world[o2] - wx, fs.world[o2 + 2] - wz)).toBeLessThan(1e-6);
    expect(fs.world[o2 + 1]).toBeCloseTo(wy, 6);
    // and from a different frame: world -> curve -> world stays within 2 cm
    fs.reexpress(p, root, FrameMode.Local, wx, wy, wz, yaw);
    fs.reexpress(p, trail, FrameMode.Curve, wx, wy, wz, yaw);
    const o3 = fs.resolve(p);
    expect(Math.hypot(fs.world[o3] - wx, fs.world[o3 + 2] - wz)).toBeLessThan(0.02);
  });

  it('curve acceleration grid agrees with brute-force projection', () => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; pts.push([Math.cos(a) * 120 + Math.sin(a * 3) * 20, Math.sin(a) * 90]); }
    const c = new Curve(pts, true, 1);
    c.buildAccel(20, 16);
    const a = { s: 0, lateral: 0, dist: 0, seg: 0 }, b = { s: 0, lateral: 0, dist: 0, seg: 0 };
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const x = (Math.random() * 2 - 1) * 160, z = (Math.random() * 2 - 1) * 130;
      c.nearest(x, z, a);
      c.projectBrute(x, z, b);
      if (b.dist < 20) { expect(a.dist).toBeCloseTo(b.dist, 9); checked++; }
      else expect(a.dist === Infinity || a.dist >= b.dist - 1e-9).toBe(true);
    }
    expect(checked).toBeGreaterThan(10);
  });
});
