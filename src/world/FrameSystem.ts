/**
 * RELATIONAL SPATIAL SYSTEM — reference-frame resolution.
 *
 * World transforms are *derived* data. They are computed on request by walking
 * the parent chain (World → Forest → Region → Tree, or World → Forest → Trail → Player)
 * and interpreting each local reference according to its FrameMode.
 *
 * Caching (toggleable for benchmarks):
 *   - Each resolved transform records the version of its parent's resolved
 *     transform, its own local version and (for grounded/curve modes) the terrain
 *     version it was computed against. A cached transform is reused while all of
 *     those match, so unchanged branches of the hierarchy are never recomputed.
 *   - A per-mutation memo stamp short-circuits repeated requests for the same
 *     entity until anything in the world moves.
 * With caching disabled every request recomputes the entire chain (Test B).
 */
import { WorldDatabase, LOCAL_STRIDE } from './WorldDatabase';
import { FrameMode } from './types';
import { TerrainField } from './TerrainField';
import { Curve, CurveProjection } from './Curve';
import { quatMul, quatRotate, quatRotateInv, yawFromQuat } from '../util/math';

export const W_STRIDE = 8; // px, py, pz, qx, qy, qz, qw, s

export interface ResolveStats {
  calls: number;
  hits: number;
  recomputes: number;
  chainSteps: number;
}

export class FrameSystem {
  readonly db: WorldDatabase;
  terrain: TerrainField | null = null;
  caching = true;
  /** Resolved world transforms (derived cache). */
  world: Float64Array;
  worldVersion: Uint32Array;
  private cParentVer: Uint32Array;
  private cLocalVer: Uint32Array;
  private cTerrainVer: Uint32Array;
  private memo: Uint32Array;
  private valid: Uint8Array;
  private capacity: number;
  private versionCounter = 1;
  private curveOf: Array<Curve | undefined> = [];
  stats: ResolveStats = { calls: 0, hits: 0, recomputes: 0, chainSteps: 0 };
  private tmp = new Float64Array(8);
  private q = new Float64Array(4);
  private proj: CurveProjection = { s: 0, lateral: 0, dist: 0, seg: 0 };

  constructor(db: WorldDatabase) {
    this.db = db;
    this.capacity = 0;
    this.world = new Float64Array(0);
    this.worldVersion = new Uint32Array(0);
    this.cParentVer = new Uint32Array(0);
    this.cLocalVer = new Uint32Array(0);
    this.cTerrainVer = new Uint32Array(0);
    this.memo = new Uint32Array(0);
    this.valid = new Uint8Array(0);
    this.ensureCapacity();
  }

  ensureCapacity(): void {
    const need = this.db.capacity;
    if (need <= this.capacity) return;
    const g = <T extends Uint32Array | Uint8Array>(a: T, C: new (n: number) => T): T => { const n = new C(need); n.set(a); return n; };
    const w = new Float64Array(need * W_STRIDE); w.set(this.world); this.world = w;
    this.worldVersion = g(this.worldVersion, Uint32Array);
    this.cParentVer = g(this.cParentVer, Uint32Array);
    this.cLocalVer = g(this.cLocalVer, Uint32Array);
    this.cTerrainVer = g(this.cTerrainVer, Uint32Array);
    this.memo = g(this.memo, Uint32Array);
    this.valid = g(this.valid, Uint8Array);
    this.capacity = need;
  }

  /** Invalidate every cached transform (e.g. after world rebuild or cache mode switch). */
  invalidateAll(): void {
    this.valid.fill(0);
    this.memo.fill(0);
  }

  refreshCurves(): void {
    this.curveOf = [];
    for (const [e, c] of this.db.curves) this.curveOf[e] = c;
  }

  resetStats(): void {
    const s = this.stats;
    s.calls = 0; s.hits = 0; s.recomputes = 0; s.chainSteps = 0;
  }

  /** Resolve an entity's world transform. Returns the offset into `world`. */
  resolve(e: number): number {
    if (e >= this.capacity) this.ensureCapacity();
    this.stats.calls++;
    if (this.caching) {
      const before = this.stats.recomputes;
      this.resolveCached(e);
      if (this.stats.recomputes === before) this.stats.hits++;
    } else {
      this.resolveUncached(e);
    }
    return e * W_STRIDE;
  }

  private resolveCached(e: number): void {
    const db = this.db;
    this.stats.chainSteps++;
    if (this.memo[e] === db.mutationStamp && this.valid[e]) return;
    const p = db.parent[e];
    let pv = 0;
    if (p >= 0) {
      this.resolveCached(p);
      pv = this.worldVersion[p];
    }
    const mode = db.mode[e];
    const tv = this.terrain ? this.terrain.version : 0;
    if (
      this.valid[e] === 1 &&
      this.cParentVer[e] === pv &&
      this.cLocalVer[e] === db.localVersion[e] &&
      (mode === FrameMode.Local || this.cTerrainVer[e] === tv)
    ) {
      this.memo[e] = db.mutationStamp;
      return;
    }
    this.compute(e, p);
    this.cParentVer[e] = pv;
    this.cLocalVer[e] = db.localVersion[e];
    this.cTerrainVer[e] = tv;
    this.worldVersion[e] = ++this.versionCounter;
    this.valid[e] = 1;
    this.memo[e] = db.mutationStamp;
  }

  private resolveUncached(e: number): void {
    this.stats.chainSteps++;
    const p = this.db.parent[e];
    if (p >= 0) this.resolveUncached(p);
    this.compute(e, p);
    this.worldVersion[e] = ++this.versionCounter;
    this.valid[e] = 1;
  }

  /** Compose parent world transform with the entity's local reference. */
  private compute(e: number, p: number): void {
    this.stats.recomputes++;
    const db = this.db;
    const L = db.local;
    const W = this.world;
    const lo = e * LOCAL_STRIDE;
    const wo = e * W_STRIDE;
    let ppx = 0, ppy = 0, ppz = 0, ps = 1;
    let pqo = -1;
    if (p >= 0) {
      const po = p * W_STRIDE;
      ppx = W[po]; ppy = W[po + 1]; ppz = W[po + 2]; ps = W[po + 7];
      pqo = po + 3;
    }
    const mode = db.mode[e];
    const tmp = this.tmp;
    let lx = L[lo], ly = L[lo + 1], lz = L[lo + 2];
    let extraYaw = 0;
    if (mode === FrameMode.Curve) {
      const curve = this.curveOf[p];
      if (curve) {
        curve.sample(lx, tmp); // tmp: x, z, heading, profile
        const h = tmp[2];
        const rx = Math.cos(h), rz = -Math.sin(h);
        const lat = lz;
        lx = tmp[0] + rx * lat;
        lz = tmp[1] + rz * lat;
        ly = tmp[3] + ly;
        extraYaw = h;
      }
    }
    const groundY = mode === FrameMode.Grounded ? ly : 0;
    if (mode === FrameMode.Grounded) ly = 0;
    // position = parentPos + parentQ * (parentScale * local)
    if (pqo >= 0) {
      quatRotate(W, pqo, lx * ps, ly * ps, lz * ps, tmp, 4);
      W[wo] = ppx + tmp[4];
      W[wo + 1] = ppy + tmp[5];
      W[wo + 2] = ppz + tmp[6];
    } else {
      W[wo] = lx; W[wo + 1] = ly; W[wo + 2] = lz;
    }
    if (mode === FrameMode.Grounded && this.terrain) {
      W[wo + 1] = this.terrain.height(W[wo], W[wo + 2]) + groundY;
    }
    // orientation = parentQ * curveYaw * localQ
    const q = this.q;
    if (extraYaw !== 0) {
      const hh = extraYaw * 0.5;
      q[0] = 0; q[1] = Math.sin(hh); q[2] = 0; q[3] = Math.cos(hh);
      quatMul(q, 0, L, lo + 3, q, 0);
    } else {
      q[0] = L[lo + 3]; q[1] = L[lo + 4]; q[2] = L[lo + 5]; q[3] = L[lo + 6];
    }
    if (pqo >= 0) quatMul(W, pqo, q, 0, W, wo + 3);
    else { W[wo + 3] = q[0]; W[wo + 4] = q[1]; W[wo + 5] = q[2]; W[wo + 6] = q[3]; }
    W[wo + 7] = ps * L[lo + 7];
  }

  // ------------------------------------------------------------------ convenience
  worldYaw(e: number): number {
    const o = this.resolve(e);
    return yawFromQuat(this.world, o + 3);
  }

  /** World-space bounding sphere: writes cx, cy, cz, r into out at offset. */
  bounds(e: number, out: Float32Array | Float64Array, oo: number): void {
    const o = this.resolve(e);
    const W = this.world;
    const s = W[o + 7];
    out[oo] = W[o];
    out[oo + 1] = W[o + 1] + this.db.centerY[e] * s;
    out[oo + 2] = W[o + 2];
    out[oo + 3] = this.db.radius[e] * s;
  }

  /**
   * Reference change: re-express a world pose (position + yaw) in a new parent frame
   * and mode, then re-link the entity. The world pose is preserved.
   */
  reexpress(e: number, newParent: number, mode: FrameMode, wx: number, wy: number, wz: number, wyaw: number, hintS = -1): void {
    const db = this.db;
    let px = 0, py = 0, pz = 0, ps = 1;
    let pyaw = 0;
    let po = -1;
    if (newParent >= 0) {
      po = this.resolve(newParent);
      const W = this.world;
      px = W[po]; py = W[po + 1]; pz = W[po + 2]; ps = W[po + 7];
      pyaw = yawFromQuat(W, po + 3);
    }
    // world -> parent space
    const tmp = this.tmp;
    if (po >= 0) {
      quatRotateInv(this.world, po + 3, wx - px, wy - py, wz - pz, tmp, 0);
      tmp[0] /= ps; tmp[1] /= ps; tmp[2] /= ps;
    } else {
      tmp[0] = wx; tmp[1] = wy; tmp[2] = wz;
    }
    let lx = tmp[0], ly = tmp[1], lz = tmp[2];
    let lyaw = wyaw - pyaw;
    if (mode === FrameMode.Curve) {
      const curve = this.curveOf[newParent] ?? db.curves.get(newParent);
      if (curve) {
        const pr = hintS >= 0 ? curve.projectNear(lx, lz, hintS, 12, this.proj) : curve.projectBrute(lx, lz, this.proj);
        const s = pr.s;
        const prof = curve.profileAt(s);
        const heading = curve.heading[pr.seg];
        lx = s;
        lz = pr.lateral;
        ly = ly - prof;
        lyaw -= heading;
      }
    } else if (mode === FrameMode.Grounded && this.terrain) {
      ly = wy - this.terrain.height(wx, wz);
    }
    const lo = e * LOCAL_STRIDE;
    const L = db.local;
    L[lo] = lx; L[lo + 1] = ly; L[lo + 2] = lz;
    const h = lyaw * 0.5;
    L[lo + 3] = 0; L[lo + 4] = Math.sin(h); L[lo + 5] = 0; L[lo + 6] = Math.cos(h);
    if (db.parent[e] !== newParent || db.mode[e] !== mode) db.reparent(e, newParent, mode);
    else db.touch(e);
  }

  /** Bytes held by the resolved-transform cache. */
  cacheBytes(): number {
    return this.world.byteLength + this.worldVersion.byteLength + this.cParentVer.byteLength + this.cLocalVer.byteLength +
      this.cTerrainVer.byteLength + this.memo.byteLength + this.valid.byteLength;
  }
}
