/**
 * Data-layer micro-benchmark (Node / V8, no rendering).
 * Measures, for growing world sizes:
 *   - full-world resolution pass: cached vs uncached reference frames
 *   - camera frustum query: spatial index vs naive full scan (uncached / cached resolution)
 *   - collision broadphase query: index vs naive
 * Every number printed is a direct measurement on the machine running the script.
 * Run: npm run bench:node
 */
import { buildWorld, DEFAULT_WORLD } from '../src/world/WorldGenerator';
import { SpatialIndex } from '../src/spatial/SpatialIndex';
import { Discovery } from '../src/spatial/Discovery';
import { ConvexVolume } from '../src/spatial/Frustum';
import { Flag } from '../src/world/types';
import { IntList } from '../src/util/math';
import { mulberry32 } from '../src/util/rng';

function timeIt(fn: () => void, iterations: number): { mean: number; min: number } {
  for (let i = 0; i < 3; i++) fn(); // warm-up / JIT
  const t: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return { mean: t.reduce((a, b) => a + b, 0) / t.length, min: t[0] };
}

const rows: string[] = [];
const fmt = (v: number) => v.toFixed(3).padStart(9);
console.log(`Node ${(globalThis as unknown as { process: { version: string } }).process.version} — data-layer benchmark (ms per operation, mean of N runs)\n`);
console.log('entities | resolve all (cached) | resolve all (uncached) | frustum idx | frustum naive (cached tf) | frustum naive (uncached tf) | sphere idx | sphere naive | results');
for (const extra of [0, 20000, 60000, 120000]) {
  const w = buildWorld({ ...DEFAULT_WORLD, stress: { extraTrees: extra, tallCasters: 0, extraLights: 0 } });
  const half = w.config.size / 2;
  const index = new SpatialIndex(-half - 32, -half - 32, w.config.size + 64, 6);
  const disc = new Discovery(w.db, w.frames, index);
  disc.rebuild();
  const fs = w.frames;
  const bounds = new Float64Array(4);
  const resolveAll = () => { for (let e = 0; e < w.db.count; e++) fs.bounds(e, bounds, 0); };
  fs.caching = true; fs.invalidateAll(); resolveAll();
  const rc = timeIt(() => { w.db.mutationStamp++; resolveAll(); }, 10); // stamp bump => version checks, no recompute
  fs.caching = false;
  const ru = timeIt(resolveAll, 5);
  fs.caching = true; fs.invalidateAll(); resolveAll();
  // camera frusta along random trail positions
  const r = mulberry32(3);
  const vols: ConvexVolume[] = [];
  for (let i = 0; i < 16; i++) {
    const s = r() * w.trailCurve.length;
    const t = [0, 0, 0, 0];
    w.trailCurve.sample(s, t);
    const yaw = r() * Math.PI * 2;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    vols.push(new ConvexVolume().setFromPerspective(t[0], t[3] + 3, t[1], fx, 0, fz, 0, 1, 0, -fz, 0, fx, 1.05, 1.78, 0.25, 340));
  }
  const out = new IntList(8192);
  let k = 0, results = 0;
  const fIdx = timeIt(() => { out.clear(); disc.useIndex = true; disc.frustum(vols[k++ % 16], Flag.Visual, out); results = out.length; }, 32);
  const fNaiveC = timeIt(() => { out.clear(); disc.useIndex = false; w.db.mutationStamp++; disc.frustum(vols[k++ % 16], Flag.Visual, out); }, 16);
  fs.caching = false;
  const fNaiveU = timeIt(() => { out.clear(); disc.useIndex = false; disc.frustum(vols[k++ % 16], Flag.Visual, out); }, 6);
  fs.caching = true;
  const sIdx = timeIt(() => { out.clear(); disc.useIndex = true; const v = vols[k++ % 16]; disc.sphere(v.corners[0], v.corners[1], v.corners[2], 8, Flag.Collider, out); }, 64);
  const sNaive = timeIt(() => { out.clear(); disc.useIndex = false; w.db.mutationStamp++; const v = vols[k++ % 16]; disc.sphere(v.corners[0], v.corners[1], v.corners[2], 8, Flag.Collider, out); }, 16);
  const line = `${String(w.db.count).padStart(8)} | ${fmt(rc.mean)}            | ${fmt(ru.mean)}              | ${fmt(fIdx.mean)} | ${fmt(fNaiveC.mean)}               | ${fmt(fNaiveU.mean)}                 | ${fmt(sIdx.mean)} | ${fmt(sNaive.mean)}  | ${results}`;
  console.log(line);
  rows.push(line);
}
console.log('\nNotes: "cached tf" = cached reference-frame transforms (version checks only); "uncached tf" = full parent-chain recomputation incl. terrain height evaluation for grounded entities.');
