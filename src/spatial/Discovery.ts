/**
 * Spatial discovery facade used by every evaluation system.
 *
 * Two interchangeable strategies:
 *   - indexed: hierarchical loose quadtree (bounds captured when entities are indexed,
 *     kept current by dependency-driven re-indexing when frames move)
 *   - naive: full scan over every entity. Each query first runs a *resolution pass*
 *     (reference-frame resolution of every candidate's bounds, timed as "Reference
 *     resolution") followed by a *scan pass* (timed as "Spatial lookup").
 *
 * The naive path exists to measure what the index actually saves.
 */
import { WorldDatabase } from '../world/WorldDatabase';
import { FrameSystem } from '../world/FrameSystem';
import { Flag } from '../world/types';
import { SpatialIndex } from './SpatialIndex';
import { ConvexVolume } from './Frustum';
import { IntList } from '../util/math';
import { profiler, Scope, counters } from '../diagnostics/Profiler';

export const INDEXABLE = Flag.Visual | Flag.Collider | Flag.CastsShadow | Flag.EmitsLight | Flag.EmitsSound | Flag.Terrain | Flag.Water;

export class Discovery {
  db: WorldDatabase;
  frames: FrameSystem;
  index: SpatialIndex;
  useIndex = true;
  private scanBounds = new Float32Array(0);
  private dirty = new IntList(256);
  private dirtyMark = new Uint8Array(0);
  /** Count of entities re-indexed due to dependency invalidation (lifetime). */
  reindexed = 0;

  constructor(db: WorldDatabase, frames: FrameSystem, index: SpatialIndex) {
    this.db = db;
    this.frames = frames;
    this.index = index;
    db.onMove((e) => this.onMove(e));
  }

  private onMove(e: number): void {
    const db = this.db;
    if ((db.flags[e] & Flag.Dynamic) !== 0) return;
    this.markDirty(e);
    if ((db.flags[e] & Flag.Frame) !== 0) db.forEachDescendant(e, (c) => this.markDirty(c));
  }

  private markDirty(e: number): void {
    if (this.dirtyMark.length < this.db.capacity) {
      const n = new Uint8Array(this.db.capacity); n.set(this.dirtyMark); this.dirtyMark = n;
    }
    if (this.dirtyMark[e]) return;
    this.dirtyMark[e] = 1;
    this.dirty.push(e);
  }

  /** Build the index from scratch (all static, indexable entities). */
  rebuild(): void {
    const db = this.db;
    this.index.clear();
    const tmp = new Float64Array(4);
    for (let e = 0; e < db.count; e++) {
      const f = db.flags[e];
      if ((f & INDEXABLE) === 0 || (f & Flag.Dynamic) !== 0) continue;
      this.frames.bounds(e, tmp, 0);
      this.index.insert(e, tmp[0], tmp[1], tmp[2], tmp[3], f);
    }
    this.dirty.clear();
    this.dirtyMark.fill(0);
  }

  /** Apply pending dependency invalidations (entities whose frames moved). */
  sync(): number {
    const n = this.dirty.length;
    if (n === 0) return 0;
    profiler.begin(Scope.Sync);
    const db = this.db;
    const b = this.tmpB;
    for (let i = 0; i < n; i++) {
      const e = this.dirty.data[i];
      this.dirtyMark[e] = 0;
      const f = db.flags[e];
      if ((f & INDEXABLE) === 0) continue;
      profiler.begin(Scope.Resolve);
      this.frames.bounds(e, b, 0);
      profiler.end(Scope.Resolve);
      this.index.insert(e, b[0], b[1], b[2], b[3], f);
      this.reindexed++;
    }
    this.dirty.clear();
    profiler.end(Scope.Sync);
    return n;
  }
  private tmpB = new Float64Array(4);

  // ------------------------------------------------------------------ naive path
  private ensureScan(): void {
    if (this.scanBounds.length < this.db.count * 4) this.scanBounds = new Float32Array(this.db.capacity * 4);
  }

  /** Resolution pass: resolve bounds of every entity matching the filter. */
  private resolvePass(filter: number): void {
    this.ensureScan();
    profiler.begin(Scope.Resolve);
    const db = this.db, B = this.scanBounds, fs = this.frames;
    const F = db.flags;
    for (let e = 0; e < db.count; e++) {
      const f = F[e];
      if ((f & filter) === 0 || (f & Flag.Dynamic) !== 0) continue;
      fs.bounds(e, B, e * 4);
    }
    profiler.end(Scope.Resolve);
  }

  // ------------------------------------------------------------------ queries
  frustum(vol: ConvexVolume, filter: number, out: IntList): void {
    counters.queries++;
    if (this.useIndex) {
      this.index.recordTag = filter;
      profiler.begin(Scope.Spatial);
      this.index.queryFrustum(vol, filter, out);
      profiler.end(Scope.Spatial);
      return;
    }
    this.resolvePass(filter);
    profiler.begin(Scope.Spatial);
    const db = this.db, B = this.scanBounds, F = db.flags;
    let tested = 0;
    for (let e = 0; e < db.count; e++) {
      const f = F[e];
      if ((f & filter) === 0 || (f & Flag.Dynamic) !== 0) continue;
      tested++;
      const o = e * 4;
      if (vol.sphere(B[o], B[o + 1], B[o + 2], B[o + 3]) !== 0) out.push(e);
    }
    counters.queryTests += tested;
    profiler.end(Scope.Spatial);
  }

  sphere(cx: number, cy: number, cz: number, r: number, filter: number, out: IntList): void {
    counters.queries++;
    if (this.useIndex) {
      this.index.recordTag = filter;
      profiler.begin(Scope.Spatial);
      this.index.querySphere(cx, cy, cz, r, filter, out);
      profiler.end(Scope.Spatial);
      return;
    }
    this.resolvePass(filter);
    profiler.begin(Scope.Spatial);
    const db = this.db, B = this.scanBounds, F = db.flags;
    let tested = 0;
    for (let e = 0; e < db.count; e++) {
      const f = F[e];
      if ((f & filter) === 0 || (f & Flag.Dynamic) !== 0) continue;
      tested++;
      const o = e * 4;
      const dx = B[o] - cx, dy = B[o + 1] - cy, dz = B[o + 2] - cz, rr = B[o + 3] + r;
      if (dx * dx + dy * dy + dz * dz <= rr * rr) out.push(e);
    }
    counters.queryTests += tested;
    profiler.end(Scope.Spatial);
  }

  aabb(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, filter: number, out: IntList): void {
    counters.queries++;
    if (this.useIndex) {
      this.index.recordTag = filter;
      profiler.begin(Scope.Spatial);
      this.index.queryAABB(minX, minY, minZ, maxX, maxY, maxZ, filter, out);
      profiler.end(Scope.Spatial);
      return;
    }
    this.resolvePass(filter);
    profiler.begin(Scope.Spatial);
    const db = this.db, B = this.scanBounds, F = db.flags;
    let tested = 0;
    for (let e = 0; e < db.count; e++) {
      const f = F[e];
      if ((f & filter) === 0 || (f & Flag.Dynamic) !== 0) continue;
      tested++;
      const o = e * 4;
      const x = B[o], y = B[o + 1], z = B[o + 2], r = B[o + 3];
      if (x + r >= minX && x - r <= maxX && y + r >= minY && y - r <= maxY && z + r >= minZ && z - r <= maxZ) out.push(e);
    }
    counters.queryTests += tested;
    profiler.end(Scope.Spatial);
  }

  /**
   * Bounds of an entity for refinement tests. Indexed path reads the index's copy
   * (captured at index time); naive path reads the scan buffer filled by the last
   * resolution pass. Both are valid immediately after a query.
   */
  boundsOf(e: number): Float32Array {
    return this.useIndex ? this.index.entBounds : this.scanBounds;
  }

  /** Last query's touched-quadrant mask (0 = depends on everything). */
  get lastMask(): number {
    return this.useIndex ? this.index.lastQuadMask : 0;
  }
}
