/**
 * SHADOW CONTRIBUTION — independent evaluation system.
 *
 * Something outside the camera view can still matter: a tree behind the camera
 * (towards the sun) can cast a shadow into the view. This system discovers
 * shadow casters whose shadow volume intersects the *receiver region* (the view
 * frustum truncated at the shadow distance), independent of camera visibility.
 *
 * Method:
 *   1. receiver region R = view frustum truncated at shadowDistance
 *   2. candidate region = XZ bounds of R, extended towards the sun by the maximum
 *      horizontal shadow reach (caster height / tan(sun elevation))
 *   3. per candidate: test the capsule swept from its bounding sphere along the
 *      light direction against R (conservative but tight)
 * Output: shadow-only contributors (casting into view but not visible themselves).
 */
import { Observation } from './Observation';
import { Discovery } from '../spatial/Discovery';
import { QueryCache, cacheKey } from '../spatial/QueryCache';
import { ConvexVolume } from '../spatial/Frustum';
import { WorldDatabase } from '../world/WorldDatabase';
import { Flag } from '../world/types';
import { IntList } from '../util/math';
import { VisibilitySystem } from './VisibilitySystem';
import { profiler, Scope, counters } from '../diagnostics/Profiler';

export class ShadowSystem {
  shadowDistance = 85;
  maxCasterHeight = 36;
  maxReach = 140;
  readonly receiver = new ConvexVolume();
  readonly shadowOnly = new IntList(1024);
  lod = new Uint8Array(1024);
  private candidates = new IntList(4096);
  /** Candidate region (minX, minZ, maxX, maxZ) for debug display. */
  readonly region = new Float64Array(6);
  candidateCount = 0;
  visibleCasters = 0;
  rejected = 0;
  /** Debug: capsule segments of shadow-only contributors (ax, ay, az, bx, by, bz). */
  capsules = new Float32Array(0);
  fromCache = false;

  evaluate(
    obs: Observation, sunX: number, sunY: number, sunZ: number, sunVersion: number,
    discovery: Discovery, qcache: QueryCache, db: WorldDatabase, vis: VisibilitySystem, collectDebug: boolean,
  ): void {
    profiler.begin(Scope.Shadow);
    obs.truncated(this.receiver, Math.min(this.shadowDistance, obs.far));
    const R = this.region;
    this.receiver.xzBounds(R);
    const elev = Math.max(0.12, sunY);
    const horiz = Math.sqrt(sunX * sunX + sunZ * sunZ) || 1;
    const reach = Math.min(this.maxReach, (this.maxCasterHeight * Math.sqrt(1 - elev * elev)) / elev);
    const ex = (sunX / horiz) * reach, ez = (sunZ / horiz) * reach;
    let minX = R[0], minZ = R[1], maxX = R[2], maxZ = R[3];
    if (ex < 0) minX += ex; else maxX += ex;
    if (ez < 0) minZ += ez; else maxZ += ez;
    R[0] = minX; R[1] = minZ; R[2] = maxX; R[3] = maxZ;

    const key = cacheKey(obs.hash, sunVersion, 0x53484457, Math.round(this.shadowDistance));
    profiler.begin(Scope.CacheLookup);
    let list = qcache.lookup(key, discovery.index, db.structureVersion);
    profiler.end(Scope.CacheLookup);
    this.fromCache = list !== null;
    if (!list) {
      this.candidates.clear();
      discovery.aabb(minX, -1e4, minZ, maxX, 1e4, maxZ, Flag.CastsShadow, this.candidates);
      list = this.candidates;
      qcache.store(key, list, discovery.lastMask, discovery.index, db.structureVersion);
    }
    if (this.fromCache) counters.qcacheHits++; else counters.qcacheMisses++;
    this.candidateCount = list.length;

    const out = this.shadowOnly;
    out.clear();
    if (this.lod.length < list.length) this.lod = new Uint8Array(list.length * 2);
    if (collectDebug && this.capsules.length < list.length * 6) this.capsules = new Float32Array(list.length * 6 + 64);
    const B = discovery.boundsOf(0);
    const frame = obs.frame;
    const stamp = vis.visStamp;
    const defs = db.defs;
    let visibleCasters = 0, rejected = 0;
    const px = obs.px, py = obs.py, pz = obs.pz;
    const lx = -sunX, ly = -sunY, lz = -sunZ; // light travel direction
    for (let i = 0; i < list.length; i++) {
      const e = list.data[i];
      if (stamp[e] === frame) { visibleCasters++; continue; }
      const o = e * 4;
      const cx = B[o], cy = B[o + 1], cz = B[o + 2], r = B[o + 3];
      const L = (2 * r + 10) / elev;
      const bx = cx + lx * L, by = cy + ly * L, bz = cz + lz * L;
      if (!this.receiver.capsule(cx, cy, cz, bx, by, bz, r)) { rejected++; continue; }
      const di = db.def[e];
      if (di < 0) continue;
      const def = defs[di];
      const dx = cx - px, dy = cy - py, dz = cz - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      let lod = 0;
      while (lod < def.lodCount - 1 && d2 > def.lodDist2[lod]) lod++;
      if (def.lodCount > 1 && lod === 0) lod = 1; // silhouettes are enough for shadow-only casters
      const k = out.length;
      out.push(e);
      this.lod[k] = lod;
      if (collectDebug) {
        const c = this.capsules;
        c[k * 6] = cx; c[k * 6 + 1] = cy; c[k * 6 + 2] = cz;
        c[k * 6 + 3] = bx; c[k * 6 + 4] = by; c[k * 6 + 5] = bz;
      }
    }
    this.visibleCasters = visibleCasters;
    this.rejected = rejected;
    counters.shadowOnly = out.length;
    counters.shadowCasters = out.length + visibleCasters;
    profiler.end(Scope.Shadow);
  }
}
