/**
 * CAMERA VISIBILITY — independent evaluation system.
 *
 * Input: an Observation (frustum + LOD parameters).
 * Output: the set of entities whose *visual* representation is relevant, with a
 * chosen level of detail. It does not touch geometry or the renderer.
 */
import { Observation } from './Observation';
import { Discovery } from '../spatial/Discovery';
import { QueryCache, cacheKey } from '../spatial/QueryCache';
import { WorldDatabase } from '../world/WorldDatabase';
import { Flag } from '../world/types';
import { IntList } from '../util/math';
import { profiler, Scope, counters } from '../diagnostics/Profiler';

export class VisibilitySystem {
  readonly visible = new IntList(4096);
  lod = new Uint8Array(4096);
  dist2 = new Float32Array(4096);
  /** Per-entity: frame number at which it was last visible. */
  visStamp = new Uint32Array(0);
  private candidates = new IntList(8192);
  /** True when this frame's candidate set came from the query cache. */
  fromCache = false;
  culledByDistance = 0;
  candidateCount = 0;
  /**
   * Results keyed by the exact observation can only hit when the camera is still.
   * Storing them every frame while moving costs a copy per frame for nothing
   * (measured in the ablation suite), so results are stored only once the
   * observation repeats (stillness detected).
   */
  private lastHash = -1;

  evaluate(obs: Observation, discovery: Discovery, qcache: QueryCache, db: WorldDatabase): void {
    profiler.begin(Scope.Visibility);
    if (this.visStamp.length < db.capacity) this.visStamp = new Uint32Array(db.capacity);
    let list: IntList | null = null;
    const key = cacheKey(obs.hash, 0x56495331, Math.round(obs.lodScale * 100), 0);
    profiler.begin(Scope.CacheLookup);
    list = qcache.lookup(key, discovery.index, db.structureVersion);
    profiler.end(Scope.CacheLookup);
    this.fromCache = list !== null;
    if (!list) {
      this.candidates.clear();
      discovery.frustum(obs.volume, Flag.Visual, this.candidates);
      list = this.candidates;
      if (obs.hash === this.lastHash) qcache.store(key, list, discovery.lastMask, discovery.index, db.structureVersion);
    }
    this.lastHash = obs.hash;
    if (this.fromCache) counters.qcacheHits++; else counters.qcacheMisses++;
    this.candidateCount = list.length;
    // refine: distance culling and LOD selection
    const out = this.visible;
    out.clear();
    if (this.lod.length < list.length) {
      this.lod = new Uint8Array(list.length * 2);
      this.dist2 = new Float32Array(list.length * 2);
    }
    const B = discovery.boundsOf(0);
    const defs = db.defs;
    const ls = obs.lodScale, ls2 = ls * ls;
    const px = obs.px, py = obs.py, pz = obs.pz;
    const frame = obs.frame;
    let culled = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list.data[i];
      const di = db.def[e];
      if (di < 0) continue;
      const def = defs[di];
      const o = e * 4;
      let d2: number;
      if ((db.flags[e] & Flag.Terrain) !== 0) {
        // distance to the patch square (xz) for terrain LOD
        const h = def.params[2] * 0.5;
        const dx = Math.max(Math.abs(B[o] - px) - h, 0), dz = Math.max(Math.abs(B[o + 2] - pz) - h, 0);
        d2 = dx * dx + dz * dz;
      } else {
        const dx = B[o] - px, dy = B[o + 1] - py, dz = B[o + 2] - pz;
        d2 = dx * dx + dy * dy + dz * dz;
      }
      const md = def.maxDrawDist * ls;
      if (d2 > md * md) { culled++; continue; }
      let lod = 0;
      const ld = def.lodDist2;
      while (lod < def.lodCount - 1 && d2 > ld[lod] * ls2) lod++;
      const k = out.length;
      out.push(e);
      this.lod[k] = lod;
      this.dist2[k] = d2;
      this.visStamp[e] = frame;
    }
    this.culledByDistance = culled;
    counters.visible = out.length;
    profiler.end(Scope.Visibility);
  }
}
