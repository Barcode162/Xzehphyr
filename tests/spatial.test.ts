import { describe, it, expect } from 'vitest';
import { SpatialIndex } from '../src/spatial/SpatialIndex';
import { ConvexVolume } from '../src/spatial/Frustum';
import { QueryCache } from '../src/spatial/QueryCache';
import { Discovery } from '../src/spatial/Discovery';
import { IntList } from '../src/util/math';
import { mulberry32 } from '../src/util/rng';
import { WorldDatabase } from '../src/world/WorldDatabase';
import { FrameSystem } from '../src/world/FrameSystem';
import { Flag, Kind } from '../src/world/types';

function randomWorld(n: number, seed = 1) {
  const r = mulberry32(seed);
  const db = new WorldDatabase(n + 8);
  const fs = new FrameSystem(db);
  const root = db.create({ kind: Kind.Root, parent: -1, flags: Flag.Frame });
  const regionA = db.create({ kind: Kind.Region, parent: root, x: -100, flags: Flag.Frame });
  const regionB = db.create({ kind: Kind.Region, parent: root, x: 150, z: 80, flags: Flag.Frame });
  for (let i = 0; i < n; i++) {
    const flags = (r() < 0.8 ? Flag.Visual : 0) | (r() < 0.5 ? Flag.Collider : 0) | (r() < 0.05 ? Flag.EmitsLight : 0) | Flag.CastsShadow;
    db.create({ kind: Kind.Tree, parent: r() < 0.5 ? regionA : regionB, x: (r() * 2 - 1) * 300, y: r() * 20, z: (r() * 2 - 1) * 300, radius: 0.2 + r() * (r() < 0.02 ? 60 : 6), flags });
  }
  const index = new SpatialIndex(-512, -512, 1024, 6);
  const discovery = new Discovery(db, fs, index);
  discovery.rebuild();
  return { db, fs, index, discovery, regionA, regionB };
}

const sorted = (l: IntList) => Array.from(l.data.subarray(0, l.length)).sort((a, b) => a - b);

describe('spatial discovery', () => {
  it('indexed queries return exactly the naive full-scan results', () => {
    const { discovery } = randomWorld(4000);
    const vol = new ConvexVolume();
    const r = mulberry32(7);
    for (let t = 0; t < 40; t++) {
      const px = (r() * 2 - 1) * 250, pz = (r() * 2 - 1) * 250, yaw = r() * Math.PI * 2;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      vol.setFromPerspective(px, 10, pz, fx, -0.1, fz, 0, 1, 0, -fz, 0, fx, 1.0, 1.6, 0.25, 50 + r() * 250);
      for (const filter of [Flag.Visual, Flag.Collider, Flag.EmitsLight, Flag.CastsShadow]) {
        const a = new IntList(), b = new IntList();
        discovery.useIndex = true; discovery.frustum(vol, filter, a);
        discovery.useIndex = false; discovery.frustum(vol, filter, b);
        expect(sorted(a)).toEqual(sorted(b));
        const sa = new IntList(), sb = new IntList();
        discovery.useIndex = true; discovery.sphere(px, 5, pz, 40, filter, sa);
        discovery.useIndex = false; discovery.sphere(px, 5, pz, 40, filter, sb);
        expect(sorted(sa)).toEqual(sorted(sb));
        const aa = new IntList(), ab = new IntList();
        discovery.useIndex = true; discovery.aabb(px - 30, -5, pz - 10, px + 30, 8, pz + 40, filter, aa);
        discovery.useIndex = false; discovery.aabb(px - 30, -5, pz - 10, px + 30, 8, pz + 40, filter, ab);
        expect(sorted(aa)).toEqual(sorted(ab));
      }
    }
  });

  it('the index tests far fewer objects than a full scan', () => {
    const { discovery, index, db } = randomWorld(20000, 3);
    const out = new IntList();
    index.resetStats();
    discovery.useIndex = true;
    discovery.sphere(0, 5, 0, 25, Flag.Collider, out);
    expect(index.stats.objectsTested).toBeLessThan(db.count / 10);
  });

  it('dependency-driven invalidation re-indexes descendants of a moved frame', () => {
    const { db, discovery, index, regionA } = randomWorld(500, 5);
    const before = new IntList();
    discovery.sphere(-100, 5, 0, 400, Flag.Visual, before);
    const qv = Array.from(index.quadVersion);
    db.setLocal(regionA, -100 + 200, 0, 0);
    const n = discovery.sync();
    expect(n).toBeGreaterThan(100);
    expect(Array.from(index.quadVersion)).not.toEqual(qv);
    // indexed and naive results still agree after the move
    const vol = new ConvexVolume().setFromPerspective(50, 10, -250, 0, 0, 1, 0, 1, 0, -1, 0, 0, 1.2, 1.5, 0.3, 500);
    const a = new IntList(), b = new IntList();
    discovery.useIndex = true; discovery.frustum(vol, Flag.Visual, a);
    discovery.useIndex = false; discovery.frustum(vol, Flag.Visual, b);
    expect(sorted(a)).toEqual(sorted(b));
  });

  it('query cache hits until a touched quadrant changes', () => {
    const { db, discovery, index, regionB } = randomWorld(1000, 9);
    const qc = new QueryCache(8);
    const res = new IntList();
    discovery.useIndex = true;
    discovery.sphere(-150, 5, -100, 30, Flag.Visual, res); // far from regionB children? (they spread widely)
    qc.store(42, res, discovery.lastMask, index, 0);
    expect(qc.lookup(42, index, 0)).not.toBeNull();
    expect(qc.lookup(42, index, 1)).toBeNull(); // extra dependency changed
    qc.store(42, res, discovery.lastMask, index, 0);
    db.setLocal(regionB, 150, 0, 90);
    discovery.sync();
    // regionB children are spread over the whole world, so the touched quadrant almost surely changed
    expect(qc.lookup(42, index, 0)).toBeNull();
    expect(qc.stats.invalidations).toBeGreaterThan(0);
  });

  it('convex volume sphere/aabb/capsule classification', () => {
    const v = new ConvexVolume().setFromPerspective(0, 0, 0, 0, 0, -1, 0, 1, 0, 1, 0, 0, Math.PI / 2, 1, 0.1, 100);
    expect(v.sphere(0, 0, -50, 1)).toBe(2);
    expect(v.sphere(0, 0, 50, 1)).toBe(0);
    expect(v.sphere(0, 0, -100, 2)).toBe(1);
    expect(v.aabb(-1, -1, -11, 1, 1, -9)).toBe(2);
    expect(v.aabb(200, -1, -11, 210, 1, -9)).toBe(0);
    // a capsule that starts behind the camera and sweeps into view intersects
    expect(v.capsule(0, 0, 20, 0, 0, -20, 0.5)).toBe(true);
    expect(v.capsule(0, 0, 20, 0, 0, 10, 0.5)).toBe(false);
  });
});
